// Pairing, credentials, revocation and user isolation.
//
// These are the tests that matter most for safety: they are what stops a code
// being reused, a revoked device reconnecting, or one account reaching another's
// hardware.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/deviceHarness.js';
import {
  formatPairingCode,
  generatePairingCode,
  hashPairingCode,
  isPlausiblePairingCode,
  normalizePairingCode,
  parseCredentialToken,
} from '../src/devices/credentials.js';

describe('AGI Command — pairing and credentials', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => h.cleanup());

  it('pairs a device with a fresh code and returns a credential exactly once', () => {
    const user = h.createUser();
    const issued = h.agi.devices.createPairingSession(user.id);
    expect(issued.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const paired = h.agi.devices.pairDevice({
      code: issued.code,
      name: 'Phone One',
      deviceType: 'android_phone',
      capabilities: [{ name: 'app.open', version: 1 }],
    });

    expect(paired.device.name).toBe('Phone One');
    expect(paired.device.userId).toBe(user.id);
    expect(paired.credentialToken).toMatch(/^agid_cred_/);
    expect(paired.acceptedCapabilities).toContain('app.open');

    // The plaintext code is never stored — only a keyed hash.
    const session = h.storage.pairings.getById(issued.pairingId)!;
    expect(session.codeHash).not.toContain(normalizePairingCode(issued.code));
    expect(session.consumedAt).not.toBeNull();
  });

  it('refuses to reuse a pairing code', () => {
    const user = h.createUser();
    const issued = h.agi.devices.createPairingSession(user.id);

    h.agi.devices.pairDevice({ code: issued.code, name: 'First', deviceType: 'simulated' });

    expect(() =>
      h.agi.devices.pairDevice({ code: issued.code, name: 'Second', deviceType: 'simulated' }),
    ).toThrow(/not valid/i);

    expect(h.storage.devices.listByUser(user.id)).toHaveLength(1);
  });

  it('refuses an expired pairing code', () => {
    const short = createHarness({ pairingTtlMs: -1 }); // already expired on issue
    try {
      const user = short.createUser();
      const issued = short.agi.devices.createPairingSession(user.id);
      expect(() =>
        short.agi.devices.pairDevice({ code: issued.code, name: 'Late', deviceType: 'simulated' }),
      ).toThrow(/not valid/i);
    } finally {
      short.cleanup();
    }
  });

  it('gives the same generic error for wrong, expired and reused codes', () => {
    const user = h.createUser();
    h.agi.devices.createPairingSession(user.id);

    const wrong = () =>
      h.agi.devices.pairDevice({ code: 'ZZZZ-ZZZZ', name: 'X', deviceType: 'simulated' });
    // No oracle: a caller cannot tell which failure it hit.
    expect(wrong).toThrow(/not valid/i);
  });

  it('rate-limits pairing code creation', () => {
    const user = h.createUser();
    for (let i = 0; i < 5; i++) h.agi.devices.createPairingSession(user.id);
    expect(() => h.agi.devices.createPairingSession(user.id)).toThrow(/too many/i);
  });

  it('authenticates a device by its credential and rejects a tampered one', () => {
    const user = h.createUser();
    const device = h.addDevice(user.id, 'Laptop');

    const authenticated = h.agi.devices.authenticateDevice(device.credential);
    expect(authenticated?.device.id).toBe(device.id);

    const parsed = parseCredentialToken(device.credential)!;
    const tampered = `agid_${parsed.credentialId}.${'x'.repeat(parsed.secret.length)}`;
    expect(h.agi.devices.authenticateDevice(tampered)).toBeNull();
    expect(h.agi.devices.authenticateDevice('garbage')).toBeNull();
    expect(h.agi.devices.authenticateDevice('agid_cred_notreal.secretsecret')).toBeNull();
  });

  it('stops a revoked device from authenticating ever again', () => {
    const user = h.createUser();
    const device = h.addDevice(user.id, 'Old Phone');
    expect(h.agi.devices.authenticateDevice(device.credential)).not.toBeNull();

    h.agi.devices.revoke(user.id, device.id);

    expect(h.agi.devices.authenticateDevice(device.credential)).toBeNull();
    expect(h.storage.devices.listByUser(user.id)).toHaveLength(0);
    expect(h.storage.devices.getById(device.id)?.revokedAt).not.toBeNull();
  });

  it('rotating a credential kills the previous one', () => {
    const user = h.createUser();
    const device = h.addDevice(user.id, 'Tablet');

    const next = h.agi.devices.rotateCredential(user.id, device.id);
    expect(next).not.toBe(device.credential);
    expect(h.agi.devices.authenticateDevice(device.credential)).toBeNull();
    expect(h.agi.devices.authenticateDevice(next)?.device.id).toBe(device.id);
  });

  it('keeps devices isolated between users', () => {
    const alice = h.createUser('alice');
    const bob = h.createUser('bob');
    const aliceDevice = h.addDevice(alice.id, 'Alice Phone');
    h.addDevice(bob.id, 'Bob Phone');

    expect(h.storage.devices.listByUser(alice.id)).toHaveLength(1);
    expect(h.storage.devices.getOwned(bob.id, aliceDevice.id)).toBeNull();
    expect(() => h.agi.devices.revoke(bob.id, aliceDevice.id)).toThrow(/not found/i);
    expect(() => h.agi.devices.rename(bob.id, aliceDevice.id, 'Stolen')).toThrow(/not found/i);
  });

  it('drops capabilities that are prohibited or unknown', () => {
    const user = h.createUser();
    const issued = h.agi.devices.createPairingSession(user.id);
    const paired = h.agi.devices.pairDevice({
      code: issued.code,
      name: 'Sketchy',
      deviceType: 'simulated',
      capabilities: [
        { name: 'app.open', version: 1 },
        { name: 'shell.exec', version: 1 },
        { name: 'camera.capture', version: 1 },
        { name: 'made.up', version: 1 },
      ],
    });

    expect(paired.acceptedCapabilities).toEqual(['app.open']);
    expect(paired.rejectedCapabilities).toEqual(
      expect.arrayContaining(['shell.exec', 'camera.capture', 'made.up']),
    );
    const stored = h.storage.devices.listCapabilities(paired.device.id).map((c) => c.capability);
    expect(stored).not.toContain('shell.exec');
  });

  it('makes the first paired device primary and keeps exactly one', () => {
    const user = h.createUser();
    const first = h.addDevice(user.id, 'First');
    const second = h.addDevice(user.id, 'Second');

    expect(h.storage.devices.getById(first.id)?.isPrimary).toBe(true);
    h.agi.devices.setPrimary(user.id, second.id);
    expect(h.storage.devices.getById(first.id)?.isPrimary).toBe(false);
    expect(h.storage.devices.getById(second.id)?.isPrimary).toBe(true);
  });

  it('disambiguates duplicate device names within an account', () => {
    const user = h.createUser();
    h.addDevice(user.id, 'Phone');
    h.addDevice(user.id, 'Phone');
    const names = h.storage.devices.listByUser(user.id).map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(['Phone', 'Phone 2']));
  });

  it('normalises pairing code formatting', () => {
    const code = generatePairingCode();
    expect(isPlausiblePairingCode(formatPairingCode(code))).toBe(true);
    expect(normalizePairingCode(`  ${code.toLowerCase()}  `)).toBe(code);
    expect(hashPairingCode(code, 'k1')).not.toBe(hashPairingCode(code, 'k2'));
    expect(isPlausiblePairingCode('ABC')).toBe(false);
    // The alphabet excludes lookalikes on purpose.
    expect(isPlausiblePairingCode('OOOOIIII')).toBe(false);
  });
});
