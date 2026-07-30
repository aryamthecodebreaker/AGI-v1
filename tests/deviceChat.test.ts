// Chat integration.
//
// The two things that must both hold:
//   1. Device requests are answered from real device state.
//   2. Ordinary conversation is completely unaffected — same path, same cost,
//      no extra model calls, and nothing device-shaped in the reply.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from './helpers/deviceHarness.js';
import { handleDeviceTurn } from '../src/brain/deviceTurn.js';
import { triageMessage } from '../src/devices/planner.js';
import type { ChatMessage, LlmBackend } from '../src/llm/types.js';

/** Records prompts and replays a scripted plan. */
function stubLlm(responses: string[]): LlmBackend & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  let index = 0;
  return {
    name: 'stub',
    calls,
    async ready() {},
    async *generate() {
      yield '';
    },
    async generateOnce(messages) {
      calls.push(messages);
      return responses[index++] ?? '{"kind":"chat"}';
    },
  };
}

describe('AGI Command — chat integration', () => {
  let h: Harness;
  let userId: string;
  let conversationId: string;
  let phoneOne: string;
  let phoneTwo: string;
  let laptop: string;

  beforeEach(() => {
    h = createHarness();
    userId = h.createUser().id;
    conversationId = h.storage.conversations.create(userId, 'chat').id;
    phoneOne = h.addDevice(userId, 'Phone One', { deviceType: 'android_phone' }).id;
    phoneTwo = h.addDevice(userId, 'Phone Two', { deviceType: 'android_phone' }).id;
    laptop = h.addDevice(userId, 'Laptop', { deviceType: 'windows' }).id;
  });
  afterEach(() => h.cleanup());

  const turn = (content: string, llm: LlmBackend, messageId = `m_${Math.random()}`) =>
    handleDeviceTurn({
      agi: h.agi,
      storage: h.storage,
      llm,
      userId,
      conversationId,
      messageId,
      content,
    });

  it('leaves ordinary conversation alone and never calls the planner', async () => {
    const llm = stubLlm([]);
    for (const message of [
      'hello there',
      'what did I tell you about my sister?',
      'thanks, that was helpful',
      'can you explain recursion?',
    ]) {
      const result = await turn(message, llm);
      expect(result.handled).toBe(false);
    }
    // The gate never let a single one through to the model.
    expect(llm.calls).toHaveLength(0);
  });

  it('answers "how many devices" from the registry, not from the model', async () => {
    const llm = stubLlm(['{"kind":"device_query","query":"count"}']);
    const result = await turn('how many devices are connected?', llm);

    expect(result.handled).toBe(true);
    expect(result.text).toMatch(/3 devices paired, 3 online/);
    expect(result.text).toMatch(/Laptop|Phone One|Phone Two/);
  });

  it('answers "which devices are online" with the real split', async () => {
    h.storage.devices.markDisconnected(phoneTwo);
    const llm = stubLlm(['{"kind":"device_query","query":"online"}']);
    const result = await turn('which devices are online?', llm);

    // Listed primary-first, then by name — Phone One was paired first so it is
    // the primary device.
    expect(result.text).toMatch(/Online: Phone One and Laptop/);
    expect(result.text).toMatch(/Offline: Phone Two/);
  });

  it('runs a device command and describes what really happened', async () => {
    const llm = stubLlm([
      '{"kind":"device_command","action":"app.open","parameters":{"appId":"youtube"},"target":{"includeGroups":["phones"]}}',
    ]);
    const promise = turn('open youtube on all my phones', llm);

    // Answer as the devices would, once the dispatches have landed.
    await vi.waitFor(() => expect(h.dispatches).toHaveLength(2));
    h.completeLatest(phoneOne);
    h.completeLatest(phoneTwo);

    const result = await promise;
    expect(result.handled).toBe(true);
    expect(result.text).toMatch(/Done on Phone One and Phone Two/);
    expect(result.meta?.status).toBe('succeeded');
  });

  it('treats a follow-up as a correction and does not repeat what already ran', async () => {
    const first = stubLlm([
      '{"kind":"device_command","action":"app.open","parameters":{"appId":"youtube"},"target":{"includeDeviceNames":["Laptop"]}}',
    ]);
    const firstTurn = turn('open youtube', first, 'm_1');
    await vi.waitFor(() => expect(h.dispatches).toHaveLength(1));
    h.completeLatest(laptop);
    await firstTurn;

    const second = stubLlm([
      '{"kind":"correction","target":{"includeGroups":["phones"],"excludeDeviceNames":["Laptop"]}}',
    ]);
    const secondTurn = turn('not on the laptop. only on the phones.', second, 'm_2');
    await vi.waitFor(() => expect(h.dispatches).toHaveLength(3));
    h.completeLatest(phoneOne);
    h.completeLatest(phoneTwo);
    const result = await secondTurn;

    // It says what had already happened, then what it did now.
    expect(result.text).toMatch(/had already run on Laptop/i);
    expect(result.text).toMatch(/Done on Phone One and Phone Two/);
    expect(result.meta?.agiCommand).toBe('correction');
  });

  it('answers "which device failed" from the last command', async () => {
    const llm = stubLlm([
      '{"kind":"device_command","action":"app.open","parameters":{"appId":"youtube"},"target":{"includeGroups":["phones"]}}',
    ]);
    const first = turn('open youtube on my phones', llm, 'm_1');
    await vi.waitFor(() => expect(h.dispatches).toHaveLength(2));
    h.completeLatest(phoneOne);
    h.failLatest(phoneTwo, 'failed', 'the app is not installed');
    await first;

    const query = stubLlm(['{"kind":"device_query","query":"failed"}']);
    const result = await turn('which device failed?', query, 'm_2');
    expect(result.text).toMatch(/Phone Two/);
    expect(result.text).toMatch(/the app is not installed/);
  });

  it('handles yes and no to a confirmation without calling the model', async () => {
    for (const name of ['Extra One', 'Extra Two']) h.addDevice(userId, name);
    const llm = stubLlm([
      '{"kind":"device_command","action":"volume.mute","parameters":{},"target":{"includeGroups":["all"]}}',
    ]);
    const asked = await turn('mute every device', llm, 'm_1');
    expect(asked.meta?.agiCommand).toBe('confirmation_required');
    expect(h.dispatches).toHaveLength(0);

    // "yes" is resolved deterministically — no planner call.
    const yes = stubLlm([]);
    const confirmedTurn = turn('yes', yes, 'm_2');
    await vi.waitFor(() => expect(h.dispatches.length).toBeGreaterThan(0));
    for (const record of [...h.dispatches]) h.completeLatest(record.deviceId);
    const confirmed = await confirmedTurn;

    expect(yes.calls).toHaveLength(0);
    expect(confirmed.handled).toBe(true);
    expect(confirmed.text).toMatch(/Done on/);
  });

  it('declining a confirmation runs nothing', async () => {
    for (const name of ['Extra One', 'Extra Two']) h.addDevice(userId, name);
    const llm = stubLlm([
      '{"kind":"device_command","action":"volume.mute","parameters":{},"target":{"includeGroups":["all"]}}',
    ]);
    await turn('mute every device', llm, 'm_1');

    const no = stubLlm([]);
    const result = await turn('no', no, 'm_2');
    expect(result.text).toMatch(/did not run it/i);
    expect(h.dispatches).toHaveLength(0);
  });

  it('says plainly what it will not do instead of pretending to try', async () => {
    const llm = stubLlm([]);
    const result = await turn('unlock my phone and bypass the pin', llm);

    expect(result.handled).toBe(true);
    expect(result.text).toMatch(/cannot unlock/i);
    expect(result.text).toMatch(/operating system/i);
    // No plan, no command, nothing attempted.
    expect(llm.calls).toHaveLength(0);
    expect(h.storage.commands.listByUser(userId)).toHaveLength(0);
  });

  it('refuses shell execution requests in plain language', async () => {
    const llm = stubLlm([]);
    const result = await turn('run a shell command on my laptop', llm);
    expect(result.text).toMatch(/cannot run arbitrary shell commands/i);
    expect(h.storage.commands.listByUser(userId)).toHaveLength(0);
  });

  it('falls back to chat when the planner returns unusable output', async () => {
    for (const bad of ['not json at all', '{"kind":"nonsense"}', '{"kind":"device_command"}']) {
      const llm = stubLlm([bad]);
      const result = await turn('open youtube on my phones', llm);
      expect(result.handled).toBe(false);
      expect(h.storage.commands.listByUser(userId)).toHaveLength(0);
    }
  });

  it('refuses a planner-invented capability', async () => {
    const llm = stubLlm([
      '{"kind":"device_command","action":"shell.exec","parameters":{},"target":{"includeGroups":["phones"]}}',
    ]);
    const result = await turn('open youtube on my phones', llm);
    expect(result.handled).toBe(false);
    expect(h.storage.commands.listByUser(userId)).toHaveLength(0);
  });

  it('asks one clarifying question rather than guessing', async () => {
    const llm = stubLlm([
      '{"kind":"device_command","action":"app.open","parameters":{"appId":"youtube"},"target":{"includeDeviceNames":["Phone"]}}',
    ]);
    const result = await turn('open youtube on the phone', llm);
    expect(result.text).toMatch(/Phone One or Phone Two/);
    expect(h.dispatches).toHaveLength(0);
  });

  it('does nothing at all when the feature is disabled', async () => {
    const disabled = createHarness({ enabled: false });
    try {
      const user = disabled.createUser();
      const conversation = disabled.storage.conversations.create(user.id, 'chat');
      const llm = stubLlm(['{"kind":"device_query","query":"count"}']);
      const result = await handleDeviceTurn({
        agi: disabled.agi,
        storage: disabled.storage,
        llm,
        userId: user.id,
        conversationId: conversation.id,
        messageId: 'm_1',
        content: 'how many devices are connected?',
      });
      expect(result.handled).toBe(false);
      expect(llm.calls).toHaveLength(0);
    } finally {
      disabled.cleanup();
    }
  });

  it('does not store command outcomes as long-term personal memory', async () => {
    const llm = stubLlm([
      '{"kind":"device_command","action":"app.open","parameters":{"appId":"youtube"},"target":{"includeDeviceNames":["Phone One"]}}',
    ]);
    const promise = turn('open youtube on phone one', llm);
    await vi.waitFor(() => expect(h.dispatches).toHaveLength(1));
    h.completeLatest(phoneOne);
    await promise;

    // Command history lives in its own tables, where it is allowed to go stale.
    const factCount = h.storage.db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND kind = ?')
      .get(userId, 'fact') as { n: number };
    expect(factCount.n).toBe(0);
    expect(h.storage.commands.listByUser(userId)).toHaveLength(1);
  });
});

describe('AGI Command — triage gate', () => {
  const context = {
    devices: [
      { name: 'Phone One', type: 'android_phone', online: true, isPrimary: false },
      { name: 'Laptop', type: 'windows', online: true, isPrimary: true },
    ],
    groups: ['phones', 'computers', 'all'],
    workflows: ['Study Mode'],
    lastCommand: null,
    hasPendingConfirmation: false,
  };

  it('skips plainly conversational turns', () => {
    for (const message of [
      'hello',
      'how are you today?',
      'what is my sister called?',
      'remind me what we discussed yesterday',
      'write me a haiku',
    ]) {
      expect(triageMessage(message, context).decision).toBe('skip');
    }
  });

  it('plans when a device or group is named', () => {
    for (const message of [
      'open youtube on phone one',
      'mute all my phones',
      'how many devices are connected?',
      'start study mode',
    ]) {
      expect(triageMessage(message, context).decision).toBe('plan');
    }
  });

  it('resolves yes and no immediately when a confirmation is open', () => {
    const pending = { ...context, hasPendingConfirmation: true };
    const yes = triageMessage('yes', pending);
    expect(yes.decision).toBe('immediate');
    expect(yes.decision === 'immediate' && yes.plan.confirm).toBe(true);

    const no = triageMessage('no, don\'t', pending);
    expect(no.decision === 'immediate' && no.plan.confirm).toBe(false);
  });

  it('only treats a bare correction as one when there is something to correct', () => {
    // No device named, no imperative — meaningless without a previous command.
    expect(triageMessage('not that one, the other', context).decision).toBe('skip');

    const withHistory = {
      ...context,
      lastCommand: {
        capability: 'app.open',
        requestText: 'open youtube',
        targets: ['Laptop'],
        failedTargets: [],
        status: 'succeeded',
      },
    };
    expect(triageMessage('not that one, the other', withHistory).decision).toBe('plan');
  });

  it('names a device, so it plans even with no history', () => {
    // Naming a device is itself enough of a signal; the planner decides the rest.
    expect(triageMessage('not on the laptop', context).decision).toBe('plan');
  });
});
