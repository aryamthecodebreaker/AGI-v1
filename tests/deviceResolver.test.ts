// Target resolution.
//
// The resolver is what keeps the app authoritative about which devices exist. It
// must never invent a device, never silently pick one when a reference is
// ambiguous, and must report offline and incapable devices rather than dropping
// them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/deviceHarness.js';
import {
  clarificationQuestion,
  needsClarification,
  resolveTargets,
} from '../src/devices/resolver.js';
import { getCapability } from '../src/devices/capabilities.js';

describe('AGI Command — target resolver', () => {
  let h: Harness;
  let userId: string;
  let phoneOne: string;
  let phoneTwo: string;
  let laptop: string;
  let tablet: string;

  const resolve = (expression: Parameters<typeof resolveTargets>[1]['expression'], capability?: string, context?: Parameters<typeof resolveTargets>[1]['context']) =>
    resolveTargets(h.storage, {
      userId,
      expression,
      capability: capability ? getCapability(capability) : null,
      context,
      offlineAfterMs: h.settings.offlineAfterMs,
    });

  const names = (devices: { name: string }[]) => devices.map((d) => d.name).sort();

  beforeEach(() => {
    h = createHarness();
    const user = h.createUser();
    userId = user.id;
    phoneOne = h.addDevice(userId, 'Phone One', { deviceType: 'android_phone' }).id;
    phoneTwo = h.addDevice(userId, 'Phone Two', { deviceType: 'android_phone' }).id;
    laptop = h.addDevice(userId, 'Laptop', { deviceType: 'windows' }).id;
    tablet = h.addDevice(userId, 'Tablet', {
      deviceType: 'android_tablet',
      online: false,
    }).id;
    h.agi.devices.setPrimary(userId, laptop);
  });
  afterEach(() => h.cleanup());

  it('resolves a single device by name', () => {
    const resolved = resolve({ includeDeviceNames: ['Phone One'] });
    expect(names(resolved.matched)).toEqual(['Phone One']);
  });

  it('matches a name case-insensitively and by partial reference', () => {
    expect(names(resolve({ includeDeviceNames: ['phone one'] }).matched)).toEqual(['Phone One']);
    // "laptop" is contained in exactly one device name.
    expect(names(resolve({ includeDeviceNames: ['laptop'] }).matched)).toEqual(['Laptop']);
  });

  it('reports ambiguity instead of guessing', () => {
    const resolved = resolve({ includeDeviceNames: ['Phone'] });
    expect(resolved.matched).toHaveLength(0);
    expect(resolved.ambiguous).toHaveLength(1);
    expect(names(resolved.ambiguous[0]!.candidates)).toEqual(['Phone One', 'Phone Two']);
    expect(needsClarification(resolved)).toBe(true);
    expect(clarificationQuestion(resolved)).toMatch(/Phone One or Phone Two/);
  });

  it('resolves derived groups from device type', () => {
    expect(names(resolve({ includeGroups: ['phones'] }).matched)).toEqual([
      'Phone One',
      'Phone Two',
    ]);
    expect(names(resolve({ includeGroups: ['computers'] }).matched)).toEqual(['Laptop']);
    // The tablet is offline, so it is reported separately rather than matched.
    const all = resolve({ includeGroups: ['all'] });
    expect(names(all.matched)).toEqual(['Laptop', 'Phone One', 'Phone Two']);
    expect(names(all.offline)).toEqual(['Tablet']);
  });

  it('resolves user-created groups and prefers them over derived ones', () => {
    h.storage.deviceGroups.create({
      userId,
      name: 'Study Devices',
      deviceIds: [laptop, tablet],
    });
    expect(names(resolve({ includeGroups: ['study devices'] }).matched)).toEqual(['Laptop']);

    // A custom group named like a derived one wins.
    h.storage.deviceGroups.create({ userId, name: 'Phones', deviceIds: [phoneOne] });
    expect(names(resolve({ includeGroups: ['phones'] }).matched)).toEqual(['Phone One']);
  });

  it('applies exclusions', () => {
    const resolved = resolve({
      includeGroups: ['all'],
      excludeDeviceNames: ['Laptop'],
    });
    expect(names(resolved.matched)).toEqual(['Phone One', 'Phone Two']);
    expect(names(resolved.excluded)).toEqual(['Laptop']);
  });

  it('excludes a whole group', () => {
    const resolved = resolve({ includeGroups: ['all'], excludeGroups: ['phones'] });
    expect(names(resolved.matched)).toEqual(['Laptop']);
  });

  it('resolves the primary device and "this device"', () => {
    expect(names(resolve({ primaryOnly: true }).matched)).toEqual(['Laptop']);
    expect(
      names(resolve({ thisDevice: true }, undefined, { thisDeviceId: phoneTwo }).matched),
    ).toEqual(['Phone Two']);
    // With no browser device registered, "this device" matches nothing.
    const orphan = resolve({ thisDevice: true }, undefined, { thisDeviceId: null });
    expect(orphan.matched).toHaveLength(0);
    expect(orphan.unmatched).toContain('this device');
  });

  it('resolves "the same devices as before" and "only what failed"', () => {
    const same = resolve({ sameAsPrevious: true }, undefined, {
      previousDeviceIds: [phoneOne, laptop],
    });
    expect(names(same.matched)).toEqual(['Laptop', 'Phone One']);

    const failed = resolve({ failedOnly: true }, undefined, {
      failedDeviceIds: [phoneTwo],
    });
    expect(names(failed.matched)).toEqual(['Phone Two']);
  });

  it('restricts to online devices when asked', () => {
    const resolved = resolve({ includeGroups: ['all'], onlineOnly: true });
    expect(names(resolved.matched)).toEqual(['Laptop', 'Phone One', 'Phone Two']);
    expect(resolved.offline).toHaveLength(0);
  });

  it('separates devices that cannot run the capability', () => {
    // A browser cannot open an app.
    const browser = h.addDevice(userId, 'Browser', { deviceType: 'browser' });
    const resolved = resolve({ includeDeviceIds: [browser.id, phoneOne] }, 'app.open');
    expect(names(resolved.matched)).toEqual(['Phone One']);
    expect(resolved.unsupported).toHaveLength(1);
    expect(resolved.unsupported[0]!.reason).toMatch(/not available on a browser/i);
  });

  it('treats a capability the device never advertised as unsupported', () => {
    const limited = h.addDevice(userId, 'Limited', { capabilities: ['device.ping'] });
    const resolved = resolve({ includeDeviceIds: [limited.id] }, 'app.open');
    expect(resolved.matched).toHaveLength(0);
    expect(resolved.unsupported[0]!.reason).toMatch(/does not report support/i);
  });

  it('treats a capability the user disabled as unsupported, with that reason', () => {
    h.agi.devices.setCapabilityEnabled(userId, phoneOne, 'app.open', false);
    const resolved = resolve({ includeDeviceIds: [phoneOne] }, 'app.open');
    expect(resolved.matched).toHaveLength(0);
    expect(resolved.unsupported[0]!.reason).toMatch(/switched off/i);
  });

  it('never reaches another account\'s devices', () => {
    const other = h.createUser('other');
    const otherDevice = h.addDevice(other.id, 'Not Yours');
    const resolved = resolve({ includeDeviceIds: [otherDevice.id] });
    expect(resolved.matched).toHaveLength(0);
    expect(resolved.unmatched).toContain(otherDevice.id);
  });

  it('reports an unknown reference rather than matching something close', () => {
    const resolved = resolve({ includeDeviceNames: ['Fridge'] });
    expect(resolved.matched).toHaveLength(0);
    expect(resolved.unmatched).toContain('Fridge');
    expect(needsClarification(resolved)).toBe(true);
  });

  it('excludes a revoked device from every resolution', () => {
    h.agi.devices.revoke(userId, phoneTwo);
    expect(names(resolve({ includeGroups: ['phones'] }).matched)).toEqual(['Phone One']);
    expect(resolve({ includeDeviceIds: [phoneTwo] }).matched).toHaveLength(0);
  });
});
