// Device credentials and pairing codes.
//
// Two different secrets with two different threat models:
//
//   * A device credential is 32 random bytes — far beyond brute force — so a
//     plain SHA-256 of the secret half is enough, and lookup by credential id
//     keeps verification O(1).
//
//   * A pairing code is short enough for a human to read aloud, so it is
//     low-entropy by design. It is stored as an HMAC keyed with the server
//     secret, which means a stolen database alone cannot be ground down into
//     working codes offline.
//
// Neither value is ever logged. Comparisons are constant-time.

import crypto from 'node:crypto';

const CREDENTIAL_PREFIX = 'agid_';

/** Unambiguous when read aloud or typed: no I, L, O, U, 0 or 1. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hmacHex(input: string, key: string): string {
  return crypto.createHmac('sha256', key).update(input, 'utf8').digest('hex');
}

/** Constant-time hex-digest comparison. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Device credentials
// ---------------------------------------------------------------------------

export interface NewCredentialSecret {
  /** Raw secret half — returned to the device exactly once, never stored. */
  secret: string;
  secretHash: string;
}

export function generateCredentialSecret(): NewCredentialSecret {
  const secret = crypto.randomBytes(32).toString('base64url');
  return { secret, secretHash: sha256Hex(secret) };
}

/** `agid_<credentialId>.<secret>` — the value the agent stores and presents. */
export function formatCredentialToken(credentialId: string, secret: string): string {
  return `${CREDENTIAL_PREFIX}${credentialId}.${secret}`;
}

export interface ParsedCredentialToken {
  credentialId: string;
  secret: string;
}

export function parseCredentialToken(token: string): ParsedCredentialToken | null {
  if (!token.startsWith(CREDENTIAL_PREFIX)) return null;
  const body = token.slice(CREDENTIAL_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot === body.length - 1) return null;
  const credentialId = body.slice(0, dot);
  const secret = body.slice(dot + 1);
  // Guard against a malformed id being used as a lookup key.
  if (!/^cred_[a-z0-9]{8,32}$/.test(credentialId)) return null;
  if (secret.length < 16 || secret.length > 256) return null;
  return { credentialId, secret };
}

export function verifyCredentialSecret(secret: string, storedHash: string): boolean {
  return safeEqualHex(sha256Hex(secret), storedHash);
}

// ---------------------------------------------------------------------------
// Pairing codes
// ---------------------------------------------------------------------------

/** Cryptographically uniform pick from CODE_ALPHABET (no modulo bias). */
export function generatePairingCode(): string {
  let out = '';
  while (out.length < CODE_LENGTH) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

/** Display form: "ABCD-EFGH". Accepted back in any spacing or case. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Normalise user input before hashing so "abcd efgh", "ABCD-EFGH" and
 * "abcdefgh" are the same code.
 */
export function normalizePairingCode(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

export function isPlausiblePairingCode(input: string): boolean {
  const normalized = normalizePairingCode(input);
  if (normalized.length !== CODE_LENGTH) return false;
  return [...normalized].every((ch) => CODE_ALPHABET.includes(ch));
}

/** Keyed hash — see the note at the top of this file. */
export function hashPairingCode(code: string, serverSecret: string): string {
  return hmacHex(normalizePairingCode(code), serverSecret);
}
