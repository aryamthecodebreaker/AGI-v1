// screen.read is the most invasive capability in the registry: it can see
// anything on a shared screen. These tests pin the properties that make it
// acceptable, so a later change cannot quietly weaken them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/deviceHarness.js';
import { getCapability, isProhibitedCapability } from '../src/devices/capabilities.js';
import { evaluatePolicy } from '../src/devices/policy.js';
import { deviceEvents } from '../src/devices/events.js';

describe('AGI Command — screen.read', () => {
  let h: Harness;
  let userId: string;
  let cleanupSubscription: (() => void) | null = null;

  beforeEach(() => {
    h = createHarness();
    userId = h.createUser().id;
  });
  afterEach(() => {
    cleanupSubscription?.();
    cleanupSubscription = null;
    h.cleanup();
  });

  it('is browser-only, because that is where consent is enforced by the OS', () => {
    const capability = getCapability('screen.read')!;
    expect(capability.platforms).toEqual(['browser']);
    // A silent OS-level screenshot remains prohibited outright.
    expect(isProhibitedCapability('screen.capture')).toBe(true);
    expect(isProhibitedCapability('screen.record')).toBe(true);
  });

  it('is high risk and always asks first', () => {
    const capability = getCapability('screen.read')!;
    expect(capability.risk).toBe('high');
    expect(capability.requiresConfirmation).toBe(true);

    const decision = evaluatePolicy({
      capability,
      targetCount: 1,
      queueIfOffline: false,
    });
    expect(decision.decision).toBe('require_confirmation');
  });

  it('cannot be waved through by a pre-confirmed workflow run', () => {
    const capability = getCapability('screen.read')!;
    // preConfirmed suppresses escalation-driven prompts, but must never
    // suppress a capability that always asks.
    const decision = evaluatePolicy({
      capability,
      targetCount: 1,
      queueIfOffline: false,
      preConfirmed: true,
    });
    expect(decision.decision).toBe('require_confirmation');
  });

  it('is not retried automatically, since a retry means another capture', () => {
    const capability = getCapability('screen.read')!;
    expect(capability.retrySafe).toBe(false);
    expect(capability.queueable).toBe(false);
  });

  it('refuses to run on a non-browser device', async () => {
    const phone = h.addDevice(userId, 'Phone One', { deviceType: 'android_phone' });
    const result = await h.agi.commands.create({
      userId,
      requestText: 'what is on my screen',
      capability: 'screen.read',
      parameters: { question: 'what is on this screen?' },
      target: { includeDeviceIds: [phone.id] },
    });
    if (result.kind !== 'created') throw new Error('expected created');
    expect(result.executions[0]!.state).toBe('unsupported');
    // Nothing was sent anywhere.
    expect(h.dispatches).toHaveLength(0);
  });

  it('holds the command until the user confirms, then dispatches', async () => {
    const browser = h.addDevice(userId, 'This browser', {
      deviceType: 'browser',
      capabilities: ['screen.read'],
    });

    // Stand in for an open browser SSE stream: without a listener the device
    // counts as unreachable, exactly as a closed tab would.
    const dispatched: { capability: string; deviceId: string }[] = [];
    const unsubscribe = deviceEvents.subscribe(userId, (event) => {
      if (event.kind === 'browser.dispatch') {
        dispatched.push({ capability: event.capability, deviceId: event.deviceId });
      }
    });
    cleanupSubscription = unsubscribe;

    const result = await h.agi.commands.create({
      userId,
      requestText: 'what is on my screen',
      capability: 'screen.read',
      parameters: { question: 'what is on this screen?' },
      target: { includeDeviceIds: [browser.id] },
    });
    if (result.kind !== 'created') throw new Error('expected created');

    expect(result.confirmation).not.toBeNull();
    expect(result.command.status).toBe('awaiting_confirmation');
    expect(dispatched).toHaveLength(0);

    await h.agi.commands.confirm(userId, result.command.id, 'confirmed');

    // A browser device is dispatched over the user's SSE stream, not through
    // the gateway — handing page JavaScript a device credential is exactly what
    // that design avoids.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.capability).toBe('screen.read');
    expect(dispatched[0]!.deviceId).toBe(browser.id);
  });

  it('runs nothing if the user declines', async () => {
    const browser = h.addDevice(userId, 'This browser', {
      deviceType: 'browser',
      capabilities: ['screen.read'],
    });
    const result = await h.agi.commands.create({
      userId,
      requestText: 'what is on my screen',
      capability: 'screen.read',
      parameters: {},
      target: { includeDeviceIds: [browser.id] },
    });
    if (result.kind !== 'created') throw new Error('expected created');

    await h.agi.commands.confirm(userId, result.command.id, 'rejected');
    expect(h.dispatches).toHaveLength(0);
    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.command.status).toBe('rejected');
  });

  it('rejects a question that is not a short string', async () => {
    const browser = h.addDevice(userId, 'This browser', {
      deviceType: 'browser',
      capabilities: ['screen.read'],
    });
    const result = await h.agi.commands.create({
      userId,
      requestText: 'x',
      capability: 'screen.read',
      parameters: { question: 'q'.repeat(5000) },
      target: { includeDeviceIds: [browser.id] },
    });
    expect(result.kind).toBe('invalid');
  });
});
