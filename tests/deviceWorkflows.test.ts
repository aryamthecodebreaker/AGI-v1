// Workflows.
//
// A workflow must not be a back door: it goes through the same capability
// registry, the same validation and the same execution tracking as a one-off
// command. It asks once, up front, showing every step.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from './helpers/deviceHarness.js';
import { narrateWorkflowRun } from '../src/devices/workflowService.js';

describe('AGI Command — workflows', () => {
  let h: Harness;
  let userId: string;
  let phoneOne: string;
  let laptop: string;

  beforeEach(() => {
    h = createHarness();
    userId = h.createUser().id;
    phoneOne = h.addDevice(userId, 'Phone One', { deviceType: 'android_phone' }).id;
    laptop = h.addDevice(userId, 'Laptop', { deviceType: 'windows' }).id;
  });
  afterEach(() => h.cleanup());

  const studyMode = () =>
    h.agi.workflows.create({
      userId,
      name: 'Study Mode',
      description: 'Notes on the laptop, timer on the phone',
      steps: [
        {
          capability: 'app.open',
          parameters: { appId: 'notion' },
          targetExpression: { includeDeviceNames: ['Laptop'] },
        },
        {
          capability: 'notification.show',
          parameters: { title: 'Study timer started' },
          targetExpression: { includeDeviceNames: ['Phone One'] },
        },
      ],
    });

  it('creates and lists a workflow', () => {
    const workflow = studyMode();
    expect(workflow.steps).toHaveLength(2);
    expect(workflow.steps[0]!.position).toBe(0);
    expect(h.agi.workflows.list(userId)).toHaveLength(1);
  });

  it('refuses a workflow step with an unknown or prohibited capability', () => {
    expect(() =>
      h.agi.workflows.create({
        userId,
        name: 'Bad',
        steps: [
          {
            capability: 'shell.exec',
            parameters: {},
            targetExpression: { includeDeviceNames: ['Laptop'] },
          },
        ],
      }),
    ).toThrow(/unknown action/i);

    expect(() =>
      h.agi.workflows.create({
        userId,
        name: 'Also Bad',
        steps: [
          {
            capability: 'made.up',
            parameters: {},
            targetExpression: { includeDeviceNames: ['Laptop'] },
          },
        ],
      }),
    ).toThrow(/unknown action/i);
  });

  it('refuses a step with invalid parameters or no target', () => {
    expect(() =>
      h.agi.workflows.create({
        userId,
        name: 'No Target',
        steps: [{ capability: 'app.open', parameters: { appId: 'notion' } }],
      }),
    ).toThrow(/needs a target/i);

    expect(() =>
      h.agi.workflows.create({
        userId,
        name: 'Bad Params',
        steps: [
          {
            capability: 'app.open',
            parameters: { appId: 'C:\\Windows\\cmd.exe' },
            targetExpression: { includeDeviceNames: ['Laptop'] },
          },
        ],
      }),
    ).toThrow(/appId/i);
  });

  it('asks once before running, and runs nothing until confirmed', async () => {
    const workflow = studyMode();
    const run = await h.agi.workflows.run({ userId, workflowId: workflow.id });

    expect(run.confirmation).toBeDefined();
    expect(run.confirmation!.summary).toMatch(/Study Mode/);
    // Both steps and their targets are described up front.
    expect(run.confirmation!.summary).toMatch(/Laptop/);
    expect(run.confirmation!.summary).toMatch(/Phone One/);
    expect(h.dispatches).toHaveLength(0);
    expect(run.steps).toHaveLength(0);
  });

  it('runs every step once confirmed, and does not ask again per step', async () => {
    const workflow = studyMode();
    const run = await h.agi.workflows.run({ userId, workflowId: workflow.id });

    const promise = h.agi.workflows.confirmRun(userId, run.runId, 'confirmed');
    await vi.waitFor(() => expect(h.dispatches.length).toBeGreaterThan(0));
    h.completeLatest(laptop);
    await vi.waitFor(() => expect(h.dispatches).toHaveLength(2));
    h.completeLatest(phoneOne);

    const outcome = await promise;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.result.steps).toHaveLength(2);
    expect(outcome.result.steps.every((s) => s.status === 'succeeded')).toBe(true);
    // No per-step confirmation was created.
    expect(h.storage.confirmations.listOpenForUser(userId)).toHaveLength(0);
    expect(narrateWorkflowRun(outcome.result)).toMatch(/"Study Mode" finished/);
  });

  it('declining the run executes nothing', async () => {
    const workflow = studyMode();
    const run = await h.agi.workflows.run({ userId, workflowId: workflow.id });
    const outcome = await h.agi.workflows.confirmRun(userId, run.runId, 'rejected');

    expect(outcome.ok).toBe(true);
    expect(h.dispatches).toHaveLength(0);
    expect(h.storage.commands.listByUser(userId)).toHaveLength(0);
  });

  it('a run confirmation is single-use', async () => {
    const workflow = studyMode();
    const run = await h.agi.workflows.run({ userId, workflowId: workflow.id });
    await h.agi.workflows.confirmRun(userId, run.runId, 'rejected');

    const second = await h.agi.workflows.confirmRun(userId, run.runId, 'confirmed');
    expect(second.ok).toBe(false);
  });

  it('a run confirmation stops applying if the workflow changes', async () => {
    const workflow = studyMode();
    const run = await h.agi.workflows.run({ userId, workflowId: workflow.id });

    // Edit the workflow after it was described but before it was confirmed.
    h.agi.workflows.update(userId, workflow.id, {
      steps: [
        {
          capability: 'volume.mute',
          parameters: {},
          targetExpression: { includeGroups: ['all'] },
        },
      ],
    });

    const outcome = await h.agi.workflows.confirmRun(userId, run.runId, 'confirmed');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/changed after I described it/i);
    expect(h.dispatches).toHaveLength(0);
  });

  it('stops on a failing step and reports the rest as skipped', async () => {
    const workflow = h.agi.workflows.create({
      userId,
      name: 'Fragile',
      steps: [
        {
          capability: 'app.open',
          parameters: { appId: 'notion' },
          targetExpression: { includeDeviceNames: ['Laptop'] },
          onFailure: 'stop',
        },
        {
          capability: 'notification.show',
          parameters: { title: 'Never runs' },
          targetExpression: { includeDeviceNames: ['Phone One'] },
        },
      ],
    });

    const run = await h.agi.workflows.run({ userId, workflowId: workflow.id });
    const promise = h.agi.workflows.confirmRun(userId, run.runId, 'confirmed');
    await vi.waitFor(() => expect(h.dispatches.length).toBeGreaterThan(0));
    h.failLatest(laptop, 'failed', 'not installed');

    const outcome = await promise;
    if (!outcome.ok) throw new Error('expected the run to complete');
    expect(outcome.result.stoppedEarly).toBe(true);
    expect(outcome.result.steps[0]!.status).toBe('failed');
    expect(outcome.result.steps[1]!.status).toBe('skipped');
    // The second step never reached a device.
    expect(h.dispatches).toHaveLength(1);
  });

  it('continues past a failing step when told to', async () => {
    const workflow = h.agi.workflows.create({
      userId,
      name: 'Resilient',
      steps: [
        {
          capability: 'app.open',
          parameters: { appId: 'notion' },
          targetExpression: { includeDeviceNames: ['Laptop'] },
          onFailure: 'continue',
        },
        {
          capability: 'notification.show',
          parameters: { title: 'Still runs' },
          targetExpression: { includeDeviceNames: ['Phone One'] },
        },
      ],
    });

    const run = await h.agi.workflows.run({ userId, workflowId: workflow.id });
    const promise = h.agi.workflows.confirmRun(userId, run.runId, 'confirmed');
    await vi.waitFor(() => expect(h.dispatches.length).toBeGreaterThan(0));
    h.failLatest(laptop, 'failed', 'not installed');
    await vi.waitFor(() => expect(h.dispatches).toHaveLength(2));
    h.completeLatest(phoneOne);

    const outcome = await promise;
    if (!outcome.ok) throw new Error('expected the run to complete');
    expect(outcome.result.stoppedEarly).toBe(false);
    expect(outcome.result.steps[1]!.status).toBe('succeeded');
  });

  it('runs parallel steps together', async () => {
    const workflow = h.agi.workflows.create({
      userId,
      name: 'Both At Once',
      steps: [
        {
          capability: 'device.ping',
          parameters: {},
          targetExpression: { includeDeviceNames: ['Laptop'] },
          mode: 'parallel',
        },
        {
          capability: 'device.ping',
          parameters: {},
          targetExpression: { includeDeviceNames: ['Phone One'] },
          mode: 'parallel',
        },
      ],
    });

    const run = await h.agi.workflows.run({ userId, workflowId: workflow.id });
    const promise = h.agi.workflows.confirmRun(userId, run.runId, 'confirmed');

    // Both steps are in flight before either is answered.
    await vi.waitFor(() => expect(h.dispatches).toHaveLength(2));
    h.completeLatest(laptop);
    h.completeLatest(phoneOne);

    const outcome = await promise;
    if (!outcome.ok) throw new Error('expected the run to complete');
    expect(outcome.result.steps.every((s) => s.status === 'succeeded')).toBe(true);
  });

  it('keeps workflows isolated between users', async () => {
    const workflow = studyMode();
    const other = h.createUser('other');

    expect(h.agi.workflows.list(other.id)).toHaveLength(0);
    expect(() => h.agi.workflows.remove(other.id, workflow.id)).toThrow(/not found/i);
    await expect(
      h.agi.workflows.run({ userId: other.id, workflowId: workflow.id }),
    ).rejects.toThrow(/not found/i);
  });

  it('rejects a duplicate workflow name', () => {
    studyMode();
    expect(() => studyMode()).toThrow(/already have a workflow/i);
  });
});
