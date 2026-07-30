// Credential storage for TypeScript device agents.
//
// The credential is the device's identity, so it is written to a file the owning
// user can read and nobody else can (0600). On Windows, POSIX modes are advisory,
// so the file lives under the user's own profile directory where the default ACL
// already restricts it.
//
// The credential is never logged, and only ever appears in the agent.hello frame.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface StoredCredential {
  credential: string;
  deviceId: string;
  deviceName: string;
  gatewayUrl: string;
  pairedAt: number;
}

export function defaultCredentialPath(agentName: string): string {
  // Under the user profile on every platform, so file permissions inherit from
  // the account rather than a world-readable temp directory.
  const base =
    process.env.AGI_AGENT_HOME ??
    path.join(os.homedir(), '.agi-command');
  return path.join(base, `${agentName}.json`);
}

export function loadCredential(file: string): StoredCredential | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as StoredCredential;
    if (!parsed.credential || !parsed.deviceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCredential(file: string, value: StoredCredential): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Write with restrictive permissions from the start rather than fixing them up
  // after the secret is already on disk.
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows: no POSIX modes. The profile directory ACL is the protection.
  }
}

export function clearCredential(file: string): void {
  try {
    fs.rmSync(file);
  } catch {
    /* already gone */
  }
}
