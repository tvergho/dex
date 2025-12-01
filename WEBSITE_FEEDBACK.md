# Agentdex Website Feedback

**Note:** The details in this document provide context about what Agentdex actually does. The website does NOT need to include all of these details - pick and choose what's most relevant and useful for visitors. Use this as reference material to ensure accuracy, not as a checklist of everything that must be included.

## Quick Implementation Checklist

**For the coding agent implementing these changes:**

**Required Fixes (must do):**
- [ ] **Hero Section:** Change title from "Registry for Autonomous Agents" to "Search Your AI Coding Conversations"
- [ ] **Hero Description:** Rewrite to explain it's a search engine for conversations, not an agent registry
- [ ] **Terminal Component:** Replace `agentdex init` with `dex sync` → `dex search` workflow
- [ ] **Terminal Colors:** Change pink/emerald to cyan/yellow/green color scheme
- [ ] **Features Section:** Completely rewrite all 6 features (current ones are all wrong)
- [ ] **Navbar:** Remove "Registry" link, update "Documentation" link
- [ ] **Footer:** Change tagline from "package manager" to "local search engine"
- [ ] **Footer Links:** Remove "Registry", "API Reference", "Integrations" (don't exist)
- [ ] **Version Badge:** Update to v0.1.1 (or check package.json for current version or embed the current npm badge or something)
- [ ] **Copy Throughout:** Replace all "registry/package manager" language with "search engine"

**Optional Additions (include if they add value):**
- [ ] **Add Sections:** "How It Works", "Supported Sources", "Use Cases", "Privacy & Security" (pick what's useful)

## Critical Issues to Fix

### 1. **Wrong Product Positioning**
**Current:** Website describes Agentdex as "The Registry for Autonomous Agents" - a package manager for installing AI agents.

**Reality:** Agentdex is a **local search engine for AI coding conversations**. It indexes conversations from Cursor, Claude Code, Codex, and OpenCode into a local database.

**Fix:** Change messaging to:
- "Local search engine for your AI coding conversations"
- "Find that conversation where you debugged that tricky auth issue"
- "Search across all your pair programming sessions"

### 2. **Incorrect Installation Command**
**Current:** Shows `npm install -g agentdex`

**Reality:** While npm install works, the primary development/runtime is Bun. The command is `dex` (not `agentdex`), and the actual package name is `agentdex`.

**Fix:** Keep `npm install -g agentdex` but note it installs the `dex` command globally.

### 3. **Fake Command: `Agentdex init`**
**Current:** Terminal shows `agentdex init` which doesn't exist.

**Reality:** The first command users run is `dex sync` to index conversations. There's no `init` command.

**Fix:** Replace with actual workflow: `npm install -g agentdex` → `dex sync` → `dex search "your query"`

### 4. **Terminal Animation Should Reflect Actual TUI**

The terminal animation should show the actual Agentdex TUI experience. It should display:

1. Installation: `npm install -g agentdex` → success message
2. Sync: `dex sync` → detecting sources → indexing progress → completion
3. Search: `dex search "authentication"` → formatted search results

The search results should show numbered results with:
- Conversation title
- Match count and timestamp
- Source, project path, and token counts
- Snippet with highlighted search terms

This matches the actual TUI output format.

### 5. **Terminal Styling Should Match Actual TUI**

The actual Agentdex TUI uses:
- **Colors:** Cyan for highlights, yellow for sources, green for success, red for errors, gray for metadata
- **Format:** ASCII box drawing characters (`╭─╮│╰─╯`) for the search input box
- **Logo:** ASCII art logo displayed on home screen
- **Typography:** Monospace font with specific color coding

**Fix:** Update terminal component to:
1. Use cyan/yellow/green color scheme instead of pink/emerald
2. Show ASCII box around search input
3. Display results in the actual format (numbered, with colored metadata)
4. Match the actual command prompt style

### 6. **Features Section Needs Complete Rewrite**

**Current features are completely wrong:**
- "Instant Discovery" - wrong (it's search, not discovery)
- "One-Line Install" - partially correct but misleading
- "Framework Agnostic" - wrong (it's not about frameworks)
- "Lightning Fast" - partially correct
- "Secure Sandboxing" - wrong (doesn't exist)
- "Version Control" - wrong (doesn't manage versions)

**Actual Features (pick 4-6 most relevant for website):**
- 🔍 **Full-text search** across all AI conversations
- 🧠 **Semantic search** - finds related content without exact keywords
- 📄 **File path search** - find conversations by file (`--file auth.ts`)
- 🖥️ **Interactive TUI** with vim-style navigation (j/k, Enter, Esc)
- 📁 **Project context** - see which files were discussed
- 🔄 **Incremental sync** - only indexes new conversations
- 📊 **Analytics dashboard** - token usage, activity heatmaps, project stats
- 📤 **Export & backup** - markdown exports and JSON backups
- 🏠 **Fully local** - your data never leaves your machine

**Note:** You don't need to include all of these - choose the 4-6 that best communicate the value proposition.

### 7. **Supported Sources Section**

**Optional:** Add a section showing supported tools (if space allows):
- ✅ Cursor
- ✅ Claude Code  
- ✅ Codex CLI
- ✅ OpenCode

**Note:** This can be a simple list or integrated into the features section - not required as a standalone section.

### 8. **Hero Section Copy**

**Current:** "Discover, install, and manage AI agents directly from your terminal."

**Should be:** "Search across all your AI coding conversations. Find that conversation where you debugged that tricky auth issue, or search across all your pair programming sessions."

### 9. **Terminal Component Specific Improvements**

#### Color Scheme
- Command prompt: cyan (like `$` in actual TUI)
- Success messages: green
- Output/info: gray/white
- Search results: cyan for selected, white for unselected
- Metadata: yellow (sources), cyan (tokens), gray (paths)

Replace pink/emerald colors with cyan/yellow/green to match the actual TUI.

#### Result Formatting
The terminal should show results in the actual format:
- Numbered list (1., 2., etc.)
- Title on first line
- Match count and timestamp on second line
- Source, project path, and token counts on third line
- Snippet with highlighted search terms on fourth line

#### ASCII Art Logo
The home screen shows an ASCII logo displayed in cyan. Use this exact logo in the terminal demo. It's followed by "Search your coding conversations" in gray.

### 10. **Add Actual Usage Examples**

**Optional:** Show 2-3 real commands as examples (not all of these):
- `dex search "authentication middleware"` - Search by content
- `dex search --file auth.ts` - Search by file path
- `dex search "bug" --file auth.ts` - Combined search
- `dex list` - List recent conversations
- `dex stats` - View analytics

**Note:** Include just enough to show what's possible - don't need to show every command.

## Implementation Recommendations

### Terminal Component Refactor

1. **Create a more accurate terminal animation:**
   - Show `dex sync` with progress
   - Show `dex search` with formatted results
   - Use correct color scheme
   - Match actual TUI formatting

2. **Add a "Try it yourself" section** with:
   - Copy-paste commands
   - Expected output
   - Link to GitHub

3. **Show the actual TUI screenshots** or create accurate mockups of:
   - Home screen with search box
   - Search results list
   - Conversation view
   - Stats dashboard

### Content Updates Needed

1. **Hero:** Change from "registry" to "search engine"
2. **Features:** Rewrite all 6 features to match actual capabilities
3. **Terminal demo:** Show actual workflow (`sync` → `search` → results)
4. **Add "How It Works" section** explaining:
   - Sync reads from source apps
   - Data normalized and stored locally
   - Search combines FTS + semantic search
   - Results in interactive TUI

### Visual Design

- Keep the dark theme (matches TUI)
- Use cyan/yellow/green color palette (matches TUI)
- Show monospace terminal output
- Consider adding a "TUI Preview" section with actual screenshots

#### Home Screen Appearance

The actual home screen shows the ASCII logo in cyan, followed by "Search your coding conversations" in gray, then a search box with ASCII box drawing characters (`╭─╮│╰─╯`), with the search query in white and a cyan cursor. Keyboard shortcuts are shown at the bottom in gray with white keys.

## Quick Reference: Actual Agentdex Commands

**Context only - website doesn't need to list all commands:**
- `dex` - Home screen (default)
- `dex sync` - Index conversations
- `dex search "query"` - Search conversations
- `dex search --file path` - Search by file
- `dex list` - List conversations
- `dex show <id>` - View conversation
- `dex stats` - Analytics dashboard
- `dex export` - Export as markdown
- `dex backup` - Full database backup
- `dex import <file>` - Import backup
- `dex config` - Settings
- `dex status` - Embedding progress

**Note:** This is reference material. The website should only show the most relevant commands (probably `dex sync` and `dex search`).

## Complete Website Section-by-Section Guide

### Navbar Component

**Current Issues:**
- Links to "Documentation" and "Registry" (registry doesn't exist)
- Generic branding

**Should Be:**
- Links: Documentation (link to GitHub docs or future docs site), GitHub (already correct)
- Remove "Registry" link
- Consider adding tagline: "Agentdex - Search your coding conversations"

**Purpose:** Agentdex helps developers search through their AI coding assistant conversations (Cursor, Claude Code, Codex, OpenCode) to find past solutions, debugging sessions, and code discussions.

### Hero Section

**Current Problems:**
1. Title: "The Registry for Autonomous Agents" - completely wrong
2. Description: "Discover, install, and manage AI agents" - wrong
3. Badge: "v1.0.0 Public Beta" - check actual version (currently 0.1.1)

**Correct Hero Content:**

**Title Options (pick one):**
- "Search Your AI Coding Conversations"
- "Find That Conversation Where You Fixed That Bug"
- "Your Local Search Engine for AI Pair Programming"

**Subtitle/Description:** Keep it concise - something like "Index conversations from Cursor, Claude Code, Codex, and OpenCode into a local database. Search across all your AI coding sessions to find past solutions, debugging sessions, and code discussions." (Can be shortened for website)

**Key Value Props (pick 2-3 for hero area, not all):**
- 🔍 **Full-text search** across all conversations
- 🧠 **Semantic search** finds related content
- 🏠 **100% local** - your data never leaves your machine
- 🖥️ **Beautiful TUI** with vim-style navigation

**Badge:** Should say "v0.1.1" (or current version from package.json)

**CTA Buttons:**
- Primary: "Get Started" → scrolls to installation
- Secondary: "View on GitHub" (already correct)

### Features Section

**Complete Rewrite Needed - Current Features Are All Wrong**

**Replace with 4-6 actual features (pick what's most compelling):**

1. **Full-Text Search** - Search across all your AI coding conversations instantly. Find conversations by keywords, code snippets, or error messages.

2. **Semantic Search** - Finds related content even without exact keyword matches. Powered by vector embeddings for intelligent discovery.

3. **File Path Search** - Find conversations that discussed specific files. Use `dex search --file auth.ts` to see all conversations about that file.

4. **Beautiful Terminal UI** - Navigate with vim-style keys (j/k, Enter, Esc). Four-level drill-down: results → matches → conversation → message.

5. **Works with All Major Tools** - Indexes conversations from Cursor, Claude Code, Codex CLI, and OpenCode. One search interface for all your AI coding sessions.

6. **100% Local & Private** - All data stays on your machine. No cloud, no telemetry, no network requests (except downloading embedding model once).

**Alternative Feature Ideas (if you want different ones):**

1. **Full-Text + Semantic Search** - Combines BM25 and vector search
2. **File Path Search** - `--file` flag for targeted discovery
3. **Project Context** - See which files were discussed in each conversation
4. **Analytics Dashboard** - Token usage, activity heatmaps, project stats
5. **Export & Backup** - Markdown exports and JSON backups
6. **Incremental Sync** - Only indexes new conversations, fast updates

### Footer Component

**Current Issues:**
- "The package manager for the agentic web" - wrong
- Links to "Registry", "CLI", "Integrations" - some don't exist
- "API Reference" - no API exists

**Should Be:**

**Tagline:** "The local search engine for your AI coding conversations"

**Product Links (keep simple):**
- Documentation (link to GitHub README or future docs)
- GitHub (already correct)
- Remove "Registry" and "Integrations" (don't exist)
- CLI link is optional (can link to GitHub README usage section)

**Resources Links (keep minimal):**
- Documentation (link to GitHub README)
- GitHub (already correct)
- Remove "API Reference" (no API exists)
- "Community" is optional (can link to GitHub Discussions/Issues if you want)

**Legal:**
- Privacy (can link to GitHub or create simple privacy page)
- Terms (can link to GitHub or create simple terms page)

**Social:**
- GitHub (already correct)
- Remove Twitter (or add if you have one)

### Additional Sections to Add

**Note:** These are optional sections - include only if they add value. Don't feel obligated to add all of them.

#### 1. "How It Works" Section (Optional)

**If you add this section**, explain the workflow simply:

**Section title:** "How It Works"

**Step 1: Sync Your Conversations** - Agentdex automatically detects and indexes conversations from Cursor, Claude Code, Codex, and OpenCode. Command: `dex sync`

**Step 2: Search Everything** - Use full-text or semantic search to find conversations. Filter by file path, source, or model. Command: `dex search "authentication"`

**Step 3: Explore Results** - Navigate through results with vim-style keys. Drill down from results → matches → conversation → message. Keys: j/k to navigate, Enter to expand

#### 2. "Supported Sources" Section (Optional)

**If you add this section**, show supported tools (can be simple list or integrated elsewhere):

- **Cursor** - Indexes conversations from Cursor IDE's SQLite database ✅ Supported
- **Claude Code** - Reads JSONL files from Claude Code CLI projects ✅ Supported
- **Codex CLI** - Indexes rollout session files from Codex CLI ✅ Supported
- **OpenCode** - Reads session and message files from OpenCode storage ✅ Supported

#### 3. "Use Cases" Section (Optional)

**If you add this section**, show 2-3 examples of when developers use Agentdex (not all of these):

- **Find Past Solutions** - Remember that conversation where you fixed that auth bug? Find it instantly. Example: `dex search "JWT authentication bug"`

- **Track File Changes** - See all conversations that discussed a specific file. Example: `dex search --file src/components/Button.tsx`

- **Review Token Usage** - Analyze your AI usage patterns with the analytics dashboard. Example: `dex stats`

- **Export Conversations** - Export conversations as markdown for documentation or sharing. Example: `dex export --project myapp`

#### 4. "Privacy & Security" Section (Optional)

**If you add this section**, emphasize the local-first approach (can also be integrated into features):

**Title:** "Your Data, Your Machine"

**Points:**
- All data stored locally in ~/.dex/
- No cloud sync, no telemetry
- No network requests (except initial model download)
- Open source - audit the code yourself

### Terminal Component (Detailed)

**Complete rewrite needed - see earlier sections for details**

Key points:
- Show actual commands: `npm install` → `dex sync` → `dex search`
- Use correct colors: cyan/yellow/green (not pink/emerald)
- Show formatted search results matching actual TUI
- Include ASCII logo and box drawing

### Copy Throughout Site

**Replace these phrases everywhere (this is critical - wrong messaging must be fixed):**

❌ **Wrong:**
- "Registry for Autonomous Agents"
- "Package manager for agents"
- "Install and manage agents"
- "Agent marketplace"
- "Discover agents"

✅ **Correct (use variations of these):**
- "Local search engine for AI coding conversations"
- "Search your coding conversations"
- "Find past AI pair programming sessions"
- "Index and search conversations"
- "Search across all your AI coding tools"

**Note:** The exact phrasing can vary - just ensure it's accurate about what Agentdex does (search engine, not registry/package manager).

### Tone & Messaging

**Target Audience:** Developers who use AI coding assistants (Cursor, Claude Code, etc.)

**Key Messages:**
1. **Problem:** "You have hundreds of AI coding conversations scattered across different tools. Finding that one conversation where you solved a problem is impossible."
2. **Solution:** "Agentdex indexes all your conversations into one searchable database."
3. **Benefit:** "Find past solutions instantly. Never lose context again."

**Tone:** 
- Developer-focused (not marketing-speak)
- Technical but accessible
- Emphasize privacy and local-first
- Show actual commands and examples

## Key Messaging Points

**Use these as guidance for tone and focus (don't need to explicitly state all of them):**

1. **Privacy-first:** Fully local, no cloud, no telemetry
2. **Multi-source:** Works with Cursor, Claude Code, Codex, OpenCode
3. **Powerful search:** Full-text + semantic search
4. **Developer-focused:** Built for developers who use AI coding assistants
5. **Terminal-native:** Beautiful TUI with vim-style navigation
6. **Problem-solving:** Helps you find past solutions and debugging sessions

**Note:** These are themes to weave throughout the site, not a checklist of things that must be explicitly stated.

