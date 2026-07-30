// The Windows app allowlist.
//
// The server only ever sends a symbolic id like "youtube". This file is the only
// thing that turns an id into something launchable, and it is the reason the
// agent is not a remote shell:
//
//   * The network cannot supply a path, a command, or arguments.
//   * An unknown id is refused, not guessed at.
//   * Executable entries are absolute paths chosen here, launched with
//     shell: false and no arguments.
//
// The user may extend the list on their own machine via
// ~/.agi-command/windows-apps.json. That is a local file the account owner
// writes deliberately — it is not reachable from the network or from a model.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type AppTarget =
  /** Opened with the default browser. */
  | { kind: 'url'; target: string }
  /** Opened via a registered protocol handler, e.g. "spotify:". */
  | { kind: 'protocol'; target: string }
  /** An absolute executable path, launched with no arguments. */
  | { kind: 'exe'; candidates: string[] };

const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';

export const BUILTIN_APPS: Record<string, AppTarget> = {
  youtube: { kind: 'url', target: 'https://www.youtube.com' },
  gmail: { kind: 'url', target: 'https://mail.google.com' },
  github: { kind: 'url', target: 'https://github.com' },
  calendar: { kind: 'url', target: 'https://calendar.google.com' },
  drive: { kind: 'url', target: 'https://drive.google.com' },
  maps: { kind: 'url', target: 'https://maps.google.com' },
  notion: { kind: 'url', target: 'https://www.notion.so' },
  spotify: { kind: 'protocol', target: 'spotify:' },
  settings: { kind: 'protocol', target: 'ms-settings:' },
  calculator: { kind: 'protocol', target: 'calculator:' },
  notepad: { kind: 'exe', candidates: [path.join(systemRoot, 'System32', 'notepad.exe')] },
  vscode: {
    kind: 'exe',
    candidates: [
      path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(programFiles, 'Microsoft VS Code', 'Code.exe'),
      path.join(programFilesX86, 'Microsoft VS Code', 'Code.exe'),
    ],
  },
  chrome: {
    kind: 'exe',
    candidates: [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
  },
  firefox: {
    kind: 'exe',
    candidates: [
      path.join(programFiles, 'Mozilla Firefox', 'firefox.exe'),
      path.join(programFilesX86, 'Mozilla Firefox', 'firefox.exe'),
    ],
  },
};

export function userAllowlistPath(): string {
  return path.join(
    process.env.AGI_AGENT_HOME ?? path.join(os.homedir(), '.agi-command'),
    'windows-apps.json',
  );
}

/**
 * Merge the user's local additions. Entries are validated so a malformed file
 * cannot introduce a shell command: exe entries must be absolute paths ending
 * in .exe, urls must be http(s), protocols must look like a scheme.
 */
export function loadAllowlist(): Record<string, AppTarget> {
  const merged: Record<string, AppTarget> = { ...BUILTIN_APPS };
  const file = userAllowlistPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return merged;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return merged;
  }
  if (typeof parsed !== 'object' || parsed === null) return merged;

  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) continue;
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as { kind?: unknown; target?: unknown; candidates?: unknown };

    if (entry.kind === 'url' && typeof entry.target === 'string') {
      try {
        const url = new URL(entry.target);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          merged[id] = { kind: 'url', target: entry.target };
        }
      } catch {
        /* skip */
      }
    } else if (
      entry.kind === 'protocol' &&
      typeof entry.target === 'string' &&
      /^[a-z][a-z0-9+.-]*:$/i.test(entry.target)
    ) {
      merged[id] = { kind: 'protocol', target: entry.target };
    } else if (entry.kind === 'exe' && Array.isArray(entry.candidates)) {
      const candidates = entry.candidates.filter(
        (c): c is string =>
          typeof c === 'string' &&
          path.isAbsolute(c) &&
          c.toLowerCase().endsWith('.exe') &&
          // No argument smuggling through the path.
          !/["'&|<>^]/.test(c),
      );
      if (candidates.length > 0) merged[id] = { kind: 'exe', candidates };
    }
  }
  return merged;
}

/** First candidate that exists on this machine, or null. */
export function resolveExecutable(target: AppTarget): string | null {
  if (target.kind !== 'exe') return null;
  for (const candidate of target.candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
