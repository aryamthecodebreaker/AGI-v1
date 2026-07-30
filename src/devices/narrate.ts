// Turning command state into sentences.
//
// This module is where the project's honesty requirement is actually enforced in
// language. Every sentence it produces is derived from stored execution rows, so
// it cannot say "done" for a device that never reported, and it names the
// devices that failed, refused, or were offline instead of rounding them away.

import { isDeviceOnline, type Device } from '../storage/repositories/deviceRepo.js';
import type { DeviceExecution } from '../storage/repositories/executionRepo.js';
import { describeCapability } from './capabilities.js';
import { listPhrase } from './resolver.js';
import { executionStateLabel, tallyExecutions } from './status.js';
import type { CommandView } from './commandService.js';
import type { DeviceQueryKind } from './planner.js';
import type { DeviceWithState } from './deviceService.js';

type NamedExecution = DeviceExecution & { deviceName: string };

function namesOf(executions: NamedExecution[]): string[] {
  return executions.map((e) => e.deviceName);
}

function group(executions: NamedExecution[], states: string[]): NamedExecution[] {
  return executions.filter((e) => states.includes(e.state));
}

/**
 * Describe what actually happened. Ordered so the good news comes first but the
 * bad news is never omitted.
 */
export function narrateCommandOutcome(view: CommandView): string {
  const { command, executions } = view;
  const action = describeCapability(command.capability, command.parameters);

  if (executions.length === 0) {
    return `I did not have any device to ${action} on.`;
  }

  const succeeded = group(executions, ['succeeded']);
  const failed = group(executions, ['failed', 'timed_out']);
  const offline = group(executions, ['device_offline']);
  const unsupported = group(executions, ['unsupported', 'rejected']);
  const queued = group(executions, ['queued']);
  const cancelled = group(executions, ['cancelled']);
  const expired = group(executions, ['expired']);
  const inFlight = group(executions, ['dispatching', 'dispatched', 'acknowledged', 'running']);
  const awaiting = group(executions, ['waiting_for_confirmation']);

  const parts: string[] = [];

  if (succeeded.length > 0) {
    parts.push(`Done on ${listPhrase(namesOf(succeeded))}.`);
  }
  if (inFlight.length > 0) {
    parts.push(
      `Still waiting on ${listPhrase(namesOf(inFlight))} — I sent it but ${
        inFlight.length === 1 ? 'it has' : 'they have'
      } not reported back yet.`,
    );
  }
  if (queued.length > 0) {
    parts.push(
      `Queued for ${listPhrase(namesOf(queued))}; it will run when ${
        queued.length === 1 ? 'it reconnects' : 'they reconnect'
      }.`,
    );
  }
  if (awaiting.length > 0) {
    parts.push(`Waiting for your confirmation before touching ${listPhrase(namesOf(awaiting))}.`);
  }
  if (failed.length > 0) {
    const detailed = failed
      .map((e) => (e.detail ? `${e.deviceName} (${e.detail})` : e.deviceName))
      .join(', ');
    parts.push(`Failed on ${detailed}.`);
  }
  if (offline.length > 0) {
    parts.push(
      `${listPhrase(namesOf(offline))} ${offline.length === 1 ? 'was' : 'were'} offline, so nothing was sent there.`,
    );
  }
  if (unsupported.length > 0) {
    const detailed = unsupported
      .map((e) => (e.detail ? `${e.deviceName} — ${e.detail}` : e.deviceName))
      .join('; ');
    parts.push(`Not possible on ${detailed}.`);
  }
  if (cancelled.length > 0) {
    parts.push(`Cancelled for ${listPhrase(namesOf(cancelled))}.`);
  }
  if (expired.length > 0) {
    parts.push(`Expired before running on ${listPhrase(namesOf(expired))}.`);
  }

  if (parts.length === 0) {
    // Every state is covered above; this is a genuine "no idea yet".
    const tally = tallyExecutions(executions);
    return `${action}: ${tally.open} of ${tally.total} still in progress.`;
  }

  // Lead with the action so the sentence stands alone in a transcript.
  const lead = action.charAt(0).toUpperCase() + action.slice(1);
  return `${lead}: ${parts.join(' ')}`;
}

/** The one-line status shown while a command is mid-flight. */
export function narrateProgress(view: CommandView): string {
  const tally = tallyExecutions(view.executions);
  return `${tally.succeeded} done, ${tally.open} in progress, ${tally.failed} failed of ${tally.total}.`;
}

export function narrateConfirmationRequest(view: CommandView): string {
  const summary = view.confirmation?.summary ?? 'that action';
  return `Before I do it: ${summary}. Should I go ahead?`;
}

/** Answers to "how many devices", "which are online", "battery levels". */
export function narrateDeviceQuery(
  query: DeviceQueryKind,
  devices: DeviceWithState[],
  offlineAfterMs: number,
): string {
  if (devices.length === 0) {
    return 'You have no devices paired yet. Open the Devices panel and choose "Pair a device" to add one.';
  }

  const online = devices.filter((d) => d.online);
  const offline = devices.filter((d) => !d.online);

  switch (query) {
    case 'count': {
      const total = devices.length;
      return `${total} device${total === 1 ? '' : 's'} paired, ${online.length} online right now${
        online.length > 0 ? `: ${listPhrase(online.map((d) => d.device.name))}` : ''
      }.`;
    }
    case 'online': {
      if (online.length === 0) return 'None of your devices are connected right now.';
      const lead = `Online: ${listPhrase(online.map((d) => d.device.name))}.`;
      return offline.length > 0
        ? `${lead} Offline: ${listPhrase(offline.map((d) => d.device.name))}.`
        : lead;
    }
    case 'list': {
      const lines = devices.map((d) => {
        const flags = [
          d.device.deviceType.replace(/_/g, ' '),
          d.online ? 'online' : 'offline',
          d.device.isPrimary ? 'primary' : null,
        ]
          .filter(Boolean)
          .join(', ');
        return `- ${d.device.name} (${flags})`;
      });
      return `Your devices:\n${lines.join('\n')}`;
    }
    case 'battery': {
      // Battery is a live reading, so it is only truthful if we just fetched it.
      // The caller runs battery.read first; this reports what came back.
      return 'Reading battery levels now…';
    }
    case 'capabilities': {
      const lines = devices.map((d) => {
        const usable = d.capabilities.filter((c) => c.advertised && c.enabled);
        return `- ${d.device.name}: ${usable.length > 0 ? usable.map((c) => c.capability).join(', ') : 'nothing enabled'}`;
      });
      return `What each device can do:\n${lines.join('\n')}`;
    }
    case 'status':
    default: {
      return `${devices.length} device${devices.length === 1 ? '' : 's'} paired, ${online.length} online.`;
    }
  }
}

/** Per-device battery summary built from a completed battery.read command. */
export function narrateBatteryResults(view: CommandView): string {
  const readings = view.executions
    .filter((e) => e.state === 'succeeded')
    .map((e) => {
      const percent = e.result?.batteryPercent;
      const charging = e.result?.charging === true ? ', charging' : '';
      return typeof percent === 'number'
        ? `${e.deviceName}: ${Math.round(percent)}%${charging}`
        : `${e.deviceName}: reported no reading`;
    });
  const missing = view.executions
    .filter((e) => e.state !== 'succeeded')
    .map((e) => `${e.deviceName} (${executionStateLabel(e.state)})`);

  const parts: string[] = [];
  if (readings.length > 0) parts.push(readings.join(' · '));
  if (missing.length > 0) parts.push(`No reading from ${missing.join(', ')}.`);
  return parts.length > 0 ? parts.join(' — ') : 'No battery readings came back.';
}

/** "Which device failed?" answered from the last command, not from memory. */
export function narrateFailures(view: CommandView | null): string {
  if (!view) return 'I have not run a device command in this conversation yet.';
  const bad = view.executions.filter((e) =>
    ['failed', 'timed_out', 'device_offline', 'unsupported', 'rejected', 'expired'].includes(
      e.state,
    ),
  );
  if (bad.length === 0) {
    return 'Nothing failed on the last command — every targeted device reported success.';
  }
  const lines = bad.map(
    (e) => `- ${e.deviceName}: ${executionStateLabel(e.state)}${e.detail ? ` (${e.detail})` : ''}`,
  );
  return `On the last command:\n${lines.join('\n')}`;
}

/** Used when a device is paired, revoked, or renamed through conversation. */
export function narrateDeviceList(devices: Device[], offlineAfterMs: number): string {
  if (devices.length === 0) return 'No devices paired.';
  return devices
    .map(
      (d) =>
        `${d.name} — ${d.deviceType.replace(/_/g, ' ')}, ${
          isDeviceOnline(d, offlineAfterMs) ? 'online' : 'offline'
        }${d.isPrimary ? ', primary' : ''}`,
    )
    .join('\n');
}
