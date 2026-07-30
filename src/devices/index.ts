// Assembles the AGI Command subsystem.
//
// One place builds the services and one place decides whether the feature is on,
// so every caller — chat, REST, gateway — sees the same wiring. When
// AGI_COMMAND_ENABLED is false this still constructs cleanly; the routes simply
// report the feature as unavailable and ordinary AGI-v1 chat is untouched.

import { isDeviceStorage, type DeviceStorage, type Storage } from '../storage/index.js';
import { logger } from '../logger.js';
import { deviceSettings, type DeviceSettings } from '../config.js';
import { createDeviceService, type DeviceService } from './deviceService.js';
import { createCommandService, type CommandService } from './commandService.js';
import { createWorkflowService, type WorkflowService } from './workflowService.js';
import {
  createHttpGatewayClient,
  createNullGatewayClient,
  type GatewayClient,
} from './gatewayClient.js';

export interface AgiCommand {
  enabled: boolean;
  settings: DeviceSettings;
  devices: DeviceService;
  commands: CommandService;
  workflows: WorkflowService;
  gateway: GatewayClient;
  /** Run the timeout/expiry sweep once. Called by the background timer. */
  sweep(): void;
  startSweeper(): () => void;
}

export interface CreateAgiCommandOptions {
  settings?: DeviceSettings;
  /** Keys pairing-code hashes. Defaults to the app's JWT secret. */
  serverSecret: string;
  /** Injected in tests and when the gateway is deliberately absent. */
  gateway?: GatewayClient;
}

/**
 * Accepts any Storage so the caller does not have to care which backend is in
 * use. Device control needs the SQLite repositories, so on the Postgres path the
 * subsystem reports itself disabled and the routes say so — rather than failing
 * later with a missing-repository error.
 */
export function createAgiCommand(
  storage: Storage,
  options: CreateAgiCommandOptions,
): AgiCommand {
  if (!isDeviceStorage(storage)) {
    const settings = { ...(options.settings ?? deviceSettings), enabled: false };
    if ((options.settings ?? deviceSettings).enabled) {
      logger.warn(
        { storage: storage.kind },
        'AGI_COMMAND_ENABLED is true but device control needs the SQLite backend — leaving it off',
      );
    }
    return createDisabledAgiCommand(settings);
  }
  return createEnabledAgiCommand(storage, options);
}

/** A subsystem that is switched off but still safe to call into. */
function createDisabledAgiCommand(settings: DeviceSettings): AgiCommand {
  const gateway = createNullGatewayClient();
  return {
    enabled: false,
    settings,
    // These are never reachable: every route is behind requireFeature, and the
    // chat path checks `agi.enabled` before touching them.
    get devices(): DeviceService {
      throw new Error('AGI Command is unavailable on this storage backend');
    },
    get commands(): CommandService {
      throw new Error('AGI Command is unavailable on this storage backend');
    },
    get workflows(): WorkflowService {
      throw new Error('AGI Command is unavailable on this storage backend');
    },
    gateway,
    sweep: () => {},
    startSweeper: () => () => {},
  };
}

function createEnabledAgiCommand(
  storage: DeviceStorage,
  options: CreateAgiCommandOptions,
): AgiCommand {
  const settings = options.settings ?? deviceSettings;
  const gateway =
    options.gateway ??
    (settings.enabled && settings.gatewayUrl
      ? createHttpGatewayClient(settings)
      : createNullGatewayClient());

  const devices = createDeviceService(storage, settings, options.serverSecret);
  const commands = createCommandService(storage, settings, gateway);
  const workflows = createWorkflowService(storage, settings, commands);

  const sweep = () => {
    try {
      commands.sweepTimeouts();
      commands.sweepExpired();
    } catch (err) {
      logger.warn({ err }, 'device command sweep failed');
    }
  };

  return {
    enabled: settings.enabled,
    settings,
    devices,
    commands,
    workflows,
    gateway,
    sweep,
    startSweeper(): () => void {
      // Half the command timeout, so a timed-out execution is noticed promptly
      // without spinning.
      const interval = Math.max(2000, Math.floor(settings.commandTimeoutMs / 2));
      const timer = setInterval(sweep, interval);
      timer.unref();

      // Event retention is a daily concern, not a per-tick one.
      const pruneTimer = setInterval(
        () => {
          try {
            storage.deviceEvents.pruneOlderThan(settings.eventRetentionDays);
            storage.pairings.pruneExpired();
          } catch (err) {
            logger.warn({ err }, 'device event prune failed');
          }
        },
        60 * 60 * 1000,
      );
      pruneTimer.unref();

      return () => {
        clearInterval(timer);
        clearInterval(pruneTimer);
      };
    },
  };
}

export type { DeviceService, CommandService, WorkflowService, GatewayClient };
