// The command lifecycle: creation, concurrent dispatch, partial success,
// timeouts, cancellation, retry, corrections, confirmation and idempotency.
//
// The recurring assertion here is the honesty rule: an execution only reaches
// "succeeded" because a device said so, and a command with a mix of outcomes
// reports that mix rather than rounding it to success or failure.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/deviceHarness.js';
import { narrateCommandOutcome } from '../src/devices/narrate.js';
import { rollupCommandStatus } from '../src/devices/status.js';

describe('AGI Command — command lifecycle', () => {
  let h: Harness;
  let userId: string;
  let phoneOne: string;
  let phoneTwo: string;
  let laptop: string;

  beforeEach(() => {
    h = createHarness();
    userId = h.createUser().id;
    phoneOne = h.addDevice(userId, 'Phone One', { deviceType: 'android_phone' }).id;
    phoneTwo = h.addDevice(userId, 'Phone Two', { deviceType: 'android_phone' }).id;
    laptop = h.addDevice(userId, 'Laptop', { deviceType: 'windows' }).id;
  });
  afterEach(() => h.cleanup());

  const openYoutube = (target: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    h.agi.commands.create({
      userId,
      requestText: 'open youtube on all my phones',
      capability: 'app.open',
      parameters: { appId: 'youtube' },
      target,
      ...extra,
    });

  it('dispatches concurrently to every online target', async () => {
    const result = await openYoutube({ includeGroups: ['phones'] });
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;

    // Both phones received it; the laptop was not targeted.
    expect(h.dispatches.map((d) => d.deviceId).sort()).toEqual([phoneOne, phoneTwo].sort());

    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.executions).toHaveLength(2);
    // Nothing is "succeeded" yet — no device has reported.
    expect(view.executions.every((e) => e.state === 'dispatched')).toBe(true);
    expect(view.command.status).toBe('in_progress');
  });

  it('reports success only after the devices report it', async () => {
    const result = await openYoutube({ includeGroups: ['phones'] });
    if (result.kind !== 'created') throw new Error('expected created');

    h.completeLatest(phoneOne, { launched: true });
    expect(h.agi.commands.view(userId, result.command.id)!.command.status).toBe('in_progress');

    h.completeLatest(phoneTwo, { launched: true });
    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.command.status).toBe('succeeded');
    expect(narrateCommandOutcome(view)).toMatch(/Done on Phone One and Phone Two/);
  });

  it('represents partial success accurately', async () => {
    const tablet = h.addDevice(userId, 'Tablet', {
      deviceType: 'android_tablet',
      online: false,
    }).id;

    const result = await h.agi.commands.create({
      userId,
      requestText: 'open youtube everywhere',
      capability: 'app.open',
      parameters: { appId: 'youtube' },
      target: { includeGroups: ['all'] },
    });
    if (result.kind !== 'created') throw new Error('expected created');

    h.completeLatest(phoneOne);
    h.completeLatest(phoneTwo);
    h.failLatest(laptop, 'rejected', 'app launching is disabled');

    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.command.status).toBe('partially_succeeded');

    const byDevice = Object.fromEntries(view.executions.map((e) => [e.deviceId, e.state]));
    expect(byDevice[phoneOne]).toBe('succeeded');
    expect(byDevice[phoneTwo]).toBe('succeeded');
    expect(byDevice[laptop]).toBe('rejected');
    expect(byDevice[tablet]).toBe('device_offline');

    const text = narrateCommandOutcome(view);
    expect(text).toMatch(/Done on Phone One and Phone Two/);
    expect(text).toMatch(/Tablet.*offline/i);
    expect(text).toMatch(/app launching is disabled/);
  });

  it('records offline devices immediately instead of hanging', async () => {
    const offline = h.addDevice(userId, 'Sleeping', { online: false }).id;
    const result = await h.agi.commands.create({
      userId,
      requestText: 'ping it',
      capability: 'device.ping',
      parameters: {},
      target: { includeDeviceIds: [offline] },
    });
    if (result.kind !== 'created') throw new Error('expected created');

    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.executions[0]!.state).toBe('device_offline');
    expect(view.command.status).toBe('failed');
    // Nothing was sent anywhere.
    expect(h.dispatches).toHaveLength(0);
  });

  it('queues for an offline device when asked, and flushes on reconnect', async () => {
    const offline = h.addDevice(userId, 'Away', { online: false }).id;
    const result = await h.agi.commands.create({
      userId,
      requestText: 'show this when it comes back',
      capability: 'notification.show',
      parameters: { title: 'Welcome back' },
      target: { includeDeviceIds: [offline] },
      queueIfOffline: true,
    });
    if (result.kind !== 'created') throw new Error('expected created');

    // Queueing is a delayed side effect, so it asks first.
    expect(result.confirmation).not.toBeNull();
    await h.agi.commands.confirm(userId, result.command.id, 'confirmed');

    let view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.executions[0]!.state).toBe('queued');
    expect(view.command.status).toBe('queued');
    expect(h.dispatches).toHaveLength(0);

    h.storage.devices.markConnected(offline);
    await h.agi.commands.flushQueuedForDevice(offline);

    expect(h.dispatches).toHaveLength(1);
    h.completeLatest(offline, { shown: true });
    view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.command.status).toBe('succeeded');
  });

  it('times out an execution the device never answers', async () => {
    const result = await openYoutube({ includeDeviceIds: [phoneOne] });
    if (result.kind !== 'created') throw new Error('expected created');

    // Sweep from a point past the deadline rather than sleeping.
    const swept = h.agi.commands.sweepTimeouts(Date.now() + 60_000);
    expect(swept).toBe(1);

    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.executions[0]!.state).toBe('timed_out');
    expect(view.command.status).toBe('failed');
  });

  it('ignores a result that arrives after the execution finished', async () => {
    const result = await openYoutube({ includeDeviceIds: [phoneOne] });
    if (result.kind !== 'created') throw new Error('expected created');

    h.agi.commands.sweepTimeouts(Date.now() + 60_000);
    const record = h.dispatches[0]!;

    const late = h.agi.commands.ingestResult({
      deviceId: phoneOne,
      commandId: record.envelope.commandId,
      executionId: record.envelope.executionId,
      type: 'completed',
      result: {},
    });
    expect(late.accepted).toBe(false);
    // A timed-out execution is not resurrected by a late success.
    expect(h.agi.commands.view(userId, result.command.id)!.executions[0]!.state).toBe('timed_out');
  });

  it('drops a result for an execution belonging to another device', async () => {
    const result = await openYoutube({ includeDeviceIds: [phoneOne] });
    if (result.kind !== 'created') throw new Error('expected created');
    const record = h.dispatches[0]!;

    const spoofed = h.agi.commands.ingestResult({
      deviceId: phoneTwo,
      commandId: record.envelope.commandId,
      executionId: record.envelope.executionId,
      type: 'completed',
    });
    expect(spoofed.accepted).toBe(false);
    expect(spoofed.reason).toMatch(/different device/i);
  });

  it('cancels what has not run and says what it cannot undo', async () => {
    const result = await openYoutube({ includeGroups: ['phones'] });
    if (result.kind !== 'created') throw new Error('expected created');

    h.completeLatest(phoneOne);
    const outcome = await h.agi.commands.cancel(userId, result.command.id);

    expect(outcome.alreadyCompleted).toBe(1);
    expect(outcome.cancelled).toBe(1);
    expect(h.cancels).toHaveLength(1);

    const view = h.agi.commands.view(userId, result.command.id)!;
    const states = view.executions.map((e) => e.state).sort();
    expect(states).toEqual(['cancelled', 'succeeded']);
    // A command with one success is not simply "cancelled".
    expect(view.command.status).toBe('partially_succeeded');
  });

  it('retries only the devices that did not succeed', async () => {
    const result = await openYoutube({ includeGroups: ['phones'] });
    if (result.kind !== 'created') throw new Error('expected created');

    h.completeLatest(phoneOne);
    h.failLatest(phoneTwo, 'failed', 'could not launch');

    const before = h.dispatches.length;
    const retry = await h.agi.commands.retry(userId, result.command.id);
    expect(retry.kind).toBe('created');
    if (retry.kind !== 'created') return;

    expect(retry.retriedDeviceIds).toEqual([phoneTwo]);
    // Exactly one new dispatch, and not to the device that already succeeded.
    expect(h.dispatches.length).toBe(before + 1);
    expect(h.dispatches[h.dispatches.length - 1]!.deviceId).toBe(phoneTwo);
    expect(retry.command.retryOfCommandId).toBe(result.command.id);
  });

  it('refuses to retry when nothing failed', async () => {
    const result = await openYoutube({ includeDeviceIds: [phoneOne] });
    if (result.kind !== 'created') throw new Error('expected created');
    h.completeLatest(phoneOne);

    const retry = await h.agi.commands.retry(userId, result.command.id);
    expect(retry.kind).toBe('invalid');
  });

  it('applies a correction: keeps the action, changes the targets, skips what already ran', async () => {
    const first = await h.agi.commands.create({
      userId,
      requestText: 'open youtube',
      capability: 'app.open',
      parameters: { appId: 'youtube' },
      target: { includeDeviceIds: [laptop] },
    });
    if (first.kind !== 'created') throw new Error('expected created');
    h.completeLatest(laptop);

    const corrected = await h.agi.commands.correct({
      userId,
      commandId: first.command.id,
      requestText: 'not on the laptop, on the phones',
      target: { includeGroups: ['phones'] },
    });

    expect(corrected.kind).toBe('created');
    if (corrected.kind !== 'created') return;
    expect(corrected.alreadySucceededOn).toEqual(['Laptop']);
    expect(corrected.command.correctsCommandId).toBe(first.command.id);
    expect(corrected.command.capability).toBe('app.open');
    expect(corrected.command.parameters).toEqual({ appId: 'youtube' });

    const targets = corrected.executions.map((e) => e.deviceId).sort();
    expect(targets).toEqual([phoneOne, phoneTwo].sort());
    // The laptop is not touched a second time.
    expect(targets).not.toContain(laptop);
  });

  it('a correction cancels the part of the original that had not run', async () => {
    const first = await openYoutube({ includeGroups: ['phones'] });
    if (first.kind !== 'created') throw new Error('expected created');
    h.completeLatest(phoneOne);

    const corrected = await h.agi.commands.correct({
      userId,
      commandId: first.command.id,
      requestText: 'actually just the laptop',
      target: { includeDeviceIds: [laptop] },
    });
    expect(corrected.cancelledOnOriginal).toBe(1);

    const original = h.agi.commands.view(userId, first.command.id)!;
    const phoneTwoExecution = original.executions.find((e) => e.deviceId === phoneTwo)!;
    expect(phoneTwoExecution.state).toBe('cancelled');
    expect(phoneTwoExecution.detail).toMatch(/superseded/i);
  });

  it('suppresses a duplicate command with the same idempotency key', async () => {
    const key = 'msg:abc123';
    const first = await openYoutube({ includeDeviceIds: [phoneOne] }, { idempotencyKey: key });
    expect(first.kind).toBe('created');

    const second = await openYoutube({ includeDeviceIds: [phoneOne] }, { idempotencyKey: key });
    expect(second.kind).toBe('duplicate');
    // Only one dispatch happened.
    expect(h.dispatches).toHaveLength(1);
  });

  it('asks for confirmation on a wide fan-out and does not send until answered', async () => {
    for (const name of ['Extra One', 'Extra Two']) h.addDevice(userId, name);

    const result = await h.agi.commands.create({
      userId,
      requestText: 'mute everything',
      capability: 'volume.mute',
      parameters: {},
      target: { includeGroups: ['all'] },
    });
    if (result.kind !== 'created') throw new Error('expected created');

    expect(result.confirmation).not.toBeNull();
    expect(result.command.status).toBe('awaiting_confirmation');
    expect(h.dispatches).toHaveLength(0);
    expect(result.executions.every((e) => e.state === 'waiting_for_confirmation')).toBe(true);

    await h.agi.commands.confirm(userId, result.command.id, 'confirmed');
    expect(h.dispatches.length).toBeGreaterThan(0);
  });

  it('a declined confirmation runs nothing', async () => {
    for (const name of ['Extra One', 'Extra Two']) h.addDevice(userId, name);
    const result = await h.agi.commands.create({
      userId,
      requestText: 'mute everything',
      capability: 'volume.mute',
      parameters: {},
      target: { includeGroups: ['all'] },
    });
    if (result.kind !== 'created') throw new Error('expected created');

    await h.agi.commands.confirm(userId, result.command.id, 'rejected');
    expect(h.dispatches).toHaveLength(0);
    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.command.status).toBe('rejected');
    expect(view.executions.every((e) => e.state === 'cancelled')).toBe(true);
  });

  it('a confirmation is single-use', async () => {
    for (const name of ['Extra One', 'Extra Two']) h.addDevice(userId, name);
    const result = await h.agi.commands.create({
      userId,
      requestText: 'mute everything',
      capability: 'volume.mute',
      parameters: {},
      target: { includeGroups: ['all'] },
    });
    if (result.kind !== 'created') throw new Error('expected created');

    const first = await h.agi.commands.confirm(userId, result.command.id, 'confirmed');
    expect(first.ok).toBe(true);
    const second = await h.agi.commands.confirm(userId, result.command.id, 'confirmed');
    expect(second.ok).toBe(false);
  });

  it('rejects invalid parameters before anything is stored', async () => {
    const result = await h.agi.commands.create({
      userId,
      requestText: 'open a path',
      capability: 'app.open',
      // A path, not an app id — exactly what the schema exists to stop.
      parameters: { appId: 'C:\\Windows\\System32\\cmd.exe' },
      target: { includeDeviceIds: [phoneOne] },
    });
    expect(result.kind).toBe('invalid');
    expect(h.storage.commands.listByUser(userId)).toHaveLength(0);
  });

  it('rejects a non-http URL', async () => {
    const result = await h.agi.commands.create({
      userId,
      requestText: 'open a file',
      capability: 'url.open',
      parameters: { url: 'file:///etc/passwd' },
      target: { includeDeviceIds: [phoneOne] },
    });
    expect(result.kind).toBe('invalid');
  });

  it('refuses a capability that is not in the registry', async () => {
    const result = await h.agi.commands.create({
      userId,
      requestText: 'run a shell command',
      capability: 'shell.exec',
      parameters: {},
      target: { includeDeviceIds: [phoneOne] },
    });
    expect(result.kind).toBe('invalid');
    expect((result as { reason: string }).reason).toMatch(/do not have an action/i);
  });

  it('asks for clarification rather than guessing an ambiguous target', async () => {
    const result = await openYoutube({ includeDeviceNames: ['Phone'] });
    expect(result.kind).toBe('clarification_needed');
    expect((result as { question: string }).question).toMatch(/Phone One or Phone Two/);
    expect(h.dispatches).toHaveLength(0);
  });

  it('expires a command that outlived its window without replaying it', async () => {
    const result = await openYoutube({ includeDeviceIds: [phoneOne] });
    if (result.kind !== 'created') throw new Error('expected created');

    h.agi.commands.sweepExpired(Date.now() + 24 * 60 * 60 * 1000);
    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.executions[0]!.state).toMatch(/expired|timed_out/);

    // Flushing after expiry must not send it again.
    const before = h.dispatches.length;
    await h.agi.commands.flushQueuedForDevice(phoneOne);
    expect(h.dispatches.length).toBe(before);
  });

  it('marks a dispatch as offline when the gateway cannot reach the device', async () => {
    h.setDeliverable(false, 'device is not connected');
    const result = await openYoutube({ includeDeviceIds: [phoneOne] });
    if (result.kind !== 'created') throw new Error('expected created');

    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.executions[0]!.state).toBe('device_offline');
  });

  it('distinguishes a gateway outage from an offline device', async () => {
    h.setDeliverable(false, 'gateway unreachable: connect ECONNREFUSED');
    const result = await openYoutube({ includeDeviceIds: [phoneOne] });
    if (result.kind !== 'created') throw new Error('expected created');

    const view = h.agi.commands.view(userId, result.command.id)!;
    expect(view.executions[0]!.state).toBe('failed');
    expect(view.executions[0]!.detail).toMatch(/gateway unreachable/);
  });

  it('rolls a command up from its executions and never guesses', () => {
    expect(rollupCommandStatus([])).toBe('failed');
  });

  it('keeps one user out of another user\'s commands', async () => {
    const other = h.createUser('intruder');
    const result = await openYoutube({ includeDeviceIds: [phoneOne] });
    if (result.kind !== 'created') throw new Error('expected created');

    expect(h.agi.commands.view(other.id, result.command.id)).toBeNull();
    await expect(h.agi.commands.cancel(other.id, result.command.id)).rejects.toThrow();
  });
});
