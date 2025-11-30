/**
 * Cross-platform clipboard utility
 */

import { spawn } from 'child_process';

/**
 * Copy text to the system clipboard
 * Uses native commands: pbcopy (macOS), xclip/xsel (Linux), clip.exe (Windows)
 */
export async function copyToClipboard(text: string): Promise<void> {
  const platform = process.platform;

  let command: string;
  let args: string[];

  if (platform === 'darwin') {
    command = 'pbcopy';
    args = [];
  } else if (platform === 'win32') {
    command = 'clip';
    args = [];
  } else {
    // Linux - try xclip first, then xsel
    command = 'xclip';
    args = ['-selection', 'clipboard'];
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      // On Linux, if xclip fails, try xsel
      if (platform === 'linux' && command === 'xclip') {
        const xsel = spawn('xsel', ['--clipboard', '--input'], {
          stdio: ['pipe', 'ignore', 'pipe'],
        });

        xsel.on('error', () => {
          reject(new Error('Clipboard not available. Install xclip or xsel.'));
        });

        xsel.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error('Failed to copy to clipboard'));
          }
        });

        xsel.stdin?.write(text);
        xsel.stdin?.end();
        return;
      }

      reject(new Error(`Clipboard command not found: ${command}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Clipboard failed: ${stderr || 'Unknown error'}`));
      }
    });

    proc.stdin?.write(text);
    proc.stdin?.end();
  });
}
