// A simulated device agent.
//
// It speaks the real protocol over a real socket to the real gateway — the only
// thing simulated is what happens at the end of a capability call. That makes it
// useful for two things at once: demonstrating the whole product without a pile
// of physical hardware, and driving the automated tests, which need to provoke
// failures, timeouts and reconnects on demand.
//
// Every failure mode the tests need is a knob here rather than a mock somewhere
// else, so the tests exercise the same code path a real device would.

import {
  RejectedByDevice,
  UnsupportedOnThisDevice,
  createAgent,
  type AgentOptions,
  type CapabilityHandler,
} from '../shared/agent.js';

export interface SimulatedDeviceOptions {
  name: string;
  deviceType?: AgentOptions['deviceType'];
  appUrl: string;
  gatewayUrl: string;
  credentialPath?: string;
  /** Which capabilities to advertise. Defaults to a realistic phone-ish set. */
  capabilities?: string[];
  /** Report `failed` for these. */
  failCapabilities?: string[];
  /** Report `unsupported` for these, even though they are advertised. */
  unsupportedCapabilities?: string[];
  /** Report `rejected` for these (the device refuses). */
  rejectCapabilities?: string[];
  /** Never reply for these, so the server's timeout path is exercised. */
  hangCapabilities?: string[];
  /** Artificial delay before replying, in ms. */
  delayMs?: number;
  batteryPercent?: number;
  volumePercent?: number;
  agentVersion?: string;
  onStateChange?: AgentOptions['onStateChange'];
  onCommand?: AgentOptions['onCommand'];
  log?: AgentOptions['log'];
}

export const DEFAULT_SIMULATED_CAPABILITIES = [
  'device.ping',
  'device.status',
  'battery.read',
  'app.open',
  'url.open',
  'media.play',
  'media.pause',
  'media.next',
  'media.previous',
  'volume.get',
  'volume.set',
  'volume.mute',
  'volume.unmute',
  'screen.wake',
  'notification.show',
];

export function createSimulatedDevice(options: SimulatedDeviceOptions) {
  const state = {
    batteryPercent: options.batteryPercent ?? 74,
    volumePercent: options.volumePercent ?? 40,
    muted: false,
    lastOpenedApp: null as string | null,
    lastOpenedUrl: null as string | null,
    lastNotification: null as string | null,
    screenAwake: false,
  };

  const fail = new Set(options.failCapabilities ?? []);
  const unsupported = new Set(options.unsupportedCapabilities ?? []);
  const reject = new Set(options.rejectCapabilities ?? []);
  const hang = new Set(options.hangCapabilities ?? []);
  const delayMs = options.delayMs ?? 0;

  /**
   * Applies the configured behaviour, then runs the real (simulated) effect.
   * Ordering matters: unsupported/rejected/failed are decided before any state
   * changes, so a failing capability leaves the device untouched.
   */
  function behave(name: string, effect: CapabilityHandler): CapabilityHandler {
    return async (parameters, context) => {
      if (unsupported.has(name)) throw new UnsupportedOnThisDevice(`${name} is switched off here`);
      if (reject.has(name)) throw new RejectedByDevice(`${name} was refused by ${options.name}`);
      if (fail.has(name)) throw new Error(`${name} failed on ${options.name}`);

      if (hang.has(name)) {
        // Wait for the abort that the agent's own timeout will raise, so this
        // looks exactly like a device that stopped answering.
        await new Promise<void>((_resolve, rejectPromise) => {
          context.signal.addEventListener('abort', () =>
            rejectPromise(new Error('the device stopped responding')),
          );
        });
      }

      if (delayMs > 0) {
        await new Promise<void>((resolve, rejectPromise) => {
          const timer = setTimeout(resolve, delayMs);
          context.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            rejectPromise(new Error('cancelled'));
          });
        });
      }

      return effect(parameters, context);
    };
  }

  const allHandlers: Record<string, CapabilityHandler> = {
    'device.ping': async () => ({ roundTripMs: 1 }),
    'device.status': async () => ({
      online: true,
      batteryPercent: state.batteryPercent,
      charging: false,
      network: 'wifi',
      volumePercent: state.volumePercent,
    }),
    'battery.read': async () => ({
      batteryPercent: state.batteryPercent,
      charging: false,
    }),
    'app.open': async (parameters) => {
      state.lastOpenedApp = String(parameters.appId);
      return { launched: true };
    },
    'url.open': async (parameters) => {
      state.lastOpenedUrl = String(parameters.url);
      return { opened: true };
    },
    'media.play': async () => ({ playing: true }),
    'media.pause': async () => ({ playing: false }),
    'media.next': async () => ({ skipped: true }),
    'media.previous': async () => ({ skipped: true }),
    'volume.get': async () => ({ volumePercent: state.volumePercent, muted: state.muted }),
    'volume.set': async (parameters) => {
      state.volumePercent = Number(parameters.percent);
      state.muted = state.volumePercent === 0;
      return { volumePercent: state.volumePercent };
    },
    'volume.mute': async () => {
      state.muted = true;
      return { muted: true };
    },
    'volume.unmute': async () => {
      state.muted = false;
      return { muted: false };
    },
    'screen.wake': async () => {
      state.screenAwake = true;
      return { woken: true };
    },
    'notification.show': async (parameters) => {
      state.lastNotification = String(parameters.title);
      return { shown: true };
    },
  };

  const advertised = options.capabilities ?? DEFAULT_SIMULATED_CAPABILITIES;
  const handlers: Record<string, CapabilityHandler> = {};
  for (const name of advertised) {
    const effect = allHandlers[name];
    if (effect) handlers[name] = behave(name, effect);
  }

  const agent = createAgent({
    name: options.name,
    deviceType: options.deviceType ?? 'simulated',
    platform: 'simulated',
    platformVersion: '1.0',
    agentVersion: options.agentVersion ?? 'sim-1.0.0',
    appUrl: options.appUrl,
    gatewayUrl: options.gatewayUrl,
    credentialPath: options.credentialPath,
    handlers,
    onStateChange: options.onStateChange,
    onCommand: options.onCommand,
    log: options.log,
  });

  return {
    agent,
    /** Inspectable device state, so tests can assert the effect really happened. */
    state,
    setBattery(percent: number): void {
      state.batteryPercent = percent;
    },
    /** Start failing a capability at runtime, to test partial success. */
    setFailing(capability: string, failing: boolean): void {
      if (failing) fail.add(capability);
      else fail.delete(capability);
    },
  };
}

export type SimulatedDevice = ReturnType<typeof createSimulatedDevice>;
