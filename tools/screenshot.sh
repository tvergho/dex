#!/bin/bash
#
# screenshot.sh - Capture terminal screenshots of dex commands
#
# Uses vhs (https://github.com/charmbracelet/vhs) to run dex commands
# in a virtual terminal and capture PNG screenshots.
#
# INSTALLATION:
#   brew install vhs
#
# USAGE:
#   ./tools/screenshot.sh <command> [options]
#
# OPTIONS:
#   -o, --output <path>    Output PNG path (default: /tmp/dex-screenshot.png)
#   -k, --keys <keys>      Key sequence to send after initial load (e.g., "enter,enter,j,j")
#   -w, --wait <seconds>   Initial wait time in seconds (default: 7)
#   -W, --width <pixels>   Terminal width (default: 1200)
#   -H, --height <pixels>  Terminal height (default: 800)
#   --no-open              Don't open the screenshot after capture
#
# KEY SEQUENCE:
#   Comma-separated list of keys to press after the command loads.
#   Supported keys: enter, esc, up, down, left, right, tab, space, j, k, g, G, q, or any single char
#   Each key press is followed by a short delay.
#
# EXAMPLES:
#   # Screenshot list view (default)
#   ./tools/screenshot.sh "list"
#
#   # Screenshot search results
#   ./tools/screenshot.sh "search api"
#
#   # Screenshot matches view (press Enter to expand first result)
#   ./tools/screenshot.sh "search api" -k enter
#
#   # Screenshot conversation view (Enter twice to get to conversation)
#   ./tools/screenshot.sh "search api" -k enter,enter
#
#   # Screenshot with navigation (go to matches, scroll down twice)
#   ./tools/screenshot.sh "search api" -k enter,j,j
#
#   # Custom output path
#   ./tools/screenshot.sh "search api" -o /tmp/api-search.png -k enter

set -e

# Configuration defaults
DEX_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_OUTPUT="/tmp/dex-screenshot.png"
WAIT_TIME=15
KEY_WAIT="4s"
WIDTH=1200
HEIGHT=800
FONT_SIZE=14
OPEN_AFTER=true

# Parse arguments
COMMAND=""
OUTPUT="$DEFAULT_OUTPUT"
KEYS=""

while [[ $# -gt 0 ]]; do
    case $1 in
        -o|--output)
            OUTPUT="$2"
            shift 2
            ;;
        -k|--keys)
            KEYS="$2"
            shift 2
            ;;
        -w|--wait)
            WAIT_TIME="$2"
            shift 2
            ;;
        -W|--width)
            WIDTH="$2"
            shift 2
            ;;
        -H|--height)
            HEIGHT="$2"
            shift 2
            ;;
        --no-open)
            OPEN_AFTER=false
            shift
            ;;
        -h|--help)
            head -45 "$0" | tail -43
            exit 0
            ;;
        *)
            if [ -z "$COMMAND" ]; then
                COMMAND="$1"
            else
                echo "Unknown option: $1"
                exit 1
            fi
            shift
            ;;
    esac
done

# Empty command is allowed - runs unified view
# if [ -z "$COMMAND" ]; then
#     echo "Usage: $0 <command> [options]"
#     exit 1
# fi

# Check for vhs
if ! command -v vhs &> /dev/null; then
    echo "Error: vhs is not installed"
    echo "Install with: brew install vhs"
    exit 1
fi

# Remove existing output file to prevent vhs errors
if [ -f "$OUTPUT" ]; then
    rm -f "$OUTPUT"
fi

# Clean up any stale temp files from previous runs (use find to avoid zsh glob errors)
find /tmp -maxdepth 1 -name "dex-tape-*.tape" -delete 2>/dev/null || true
find /tmp -maxdepth 1 -name "dex-gif-*.gif" -delete 2>/dev/null || true

# Create temporary tape file with unique suffix
TAPE=$(mktemp /tmp/dex-tape-XXXXXX.tape) || {
    # Fallback if mktemp fails
    TAPE="/tmp/dex-tape-$$.tape"
    touch "$TAPE"
}
GIF_OUTPUT=$(mktemp /tmp/dex-gif-XXXXXX.gif) || {
    GIF_OUTPUT="/tmp/dex-gif-$$.gif"
    touch "$GIF_OUTPUT"
}

cleanup() {
    rm -f "$TAPE" "$GIF_OUTPUT"
}
trap cleanup EXIT

# Build the tape file
cat > "$TAPE" << EOF
Output "$GIF_OUTPUT"
Set Width $WIDTH
Set Height $HEIGHT
Set FontSize $FONT_SIZE

Type "cd $DEX_DIR && bun run dev $COMMAND"
Enter
Sleep ${WAIT_TIME}s
EOF

# Add key sequence if provided
if [ -n "$KEYS" ]; then
    IFS=',' read -ra KEY_ARRAY <<< "$KEYS"
    for key in "${KEY_ARRAY[@]}"; do
        key=$(echo "$key" | xargs)  # trim whitespace
        case $key in
            enter|Enter|ENTER)
                echo "Enter" >> "$TAPE"
                ;;
            esc|Esc|ESC|escape)
                echo "Escape" >> "$TAPE"
                ;;
            up|Up|UP)
                echo "Up" >> "$TAPE"
                ;;
            down|Down|DOWN)
                echo "Down" >> "$TAPE"
                ;;
            left|Left|LEFT)
                echo "Left" >> "$TAPE"
                ;;
            right|Right|RIGHT)
                echo "Right" >> "$TAPE"
                ;;
            tab|Tab|TAB)
                echo "Tab" >> "$TAPE"
                ;;
            space|Space|SPACE)
                echo "Space" >> "$TAPE"
                ;;
            backspace|Backspace|BACKSPACE)
                echo "Backspace" >> "$TAPE"
                ;;
            *)
                # Single character - use Type
                echo "Type \"$key\"" >> "$TAPE"
                ;;
        esac
        echo "Sleep $KEY_WAIT" >> "$TAPE"
    done
fi

# Add screenshot and quit
cat >> "$TAPE" << EOF
Sleep 1s
Screenshot "$OUTPUT"
Type "q"
Sleep 500ms
EOF

echo "Capturing: bun run dev $COMMAND"
[ -n "$KEYS" ] && echo "Keys: $KEYS"
echo "Output: $OUTPUT"
echo ""

# Run vhs with retry logic for failed captures
MAX_RETRIES=3
for attempt in $(seq 1 $MAX_RETRIES); do
    vhs "$TAPE" 2>&1 | grep -v "^Host your GIF" || true
    
    # Check if screenshot exists and is large enough (> 50KB indicates content rendered)
    if [ -f "$OUTPUT" ]; then
        FILE_SIZE=$(stat -f%z "$OUTPUT" 2>/dev/null || stat -c%s "$OUTPUT" 2>/dev/null || echo "0")
        if [ "$FILE_SIZE" -gt 50000 ]; then
            break  # Success
        else
            echo "Retry $attempt/$MAX_RETRIES: Screenshot too small (${FILE_SIZE} bytes), content may not have rendered"
            rm -f "$OUTPUT"
        fi
    fi
    
    if [ "$attempt" -lt "$MAX_RETRIES" ]; then
        sleep 1
    fi
done

if [ -f "$OUTPUT" ]; then
    FILE_SIZE=$(stat -f%z "$OUTPUT" 2>/dev/null || stat -c%s "$OUTPUT" 2>/dev/null || echo "0")
    echo ""
    echo "Screenshot saved: $OUTPUT (${FILE_SIZE} bytes)"

    # Open in Preview on macOS
    if [ "$OPEN_AFTER" = true ] && [ "$(uname)" = "Darwin" ]; then
        open "$OUTPUT" 2>/dev/null || true
    fi
else
    echo "Error: Failed to create screenshot after $MAX_RETRIES attempts"
    exit 1
fi
