// Embedded gateway: run the agent hub inside the app process, on the app's own
// HTTP server and port.
//
// The standalone gateway exists because a serverless web tier cannot hold a
// socket open. On a host that already runs one long-lived container — Docker,
// Fly, Railway, Hugging Face Spaces — or on a developer's laptop, that
// separation costs a second process and an HTTP hop and buys nothing.
//
// In this mode:
//   * agents connect to wss://<the app>/agent, no extra port to expose;
//   * dispatch is a direct in-process call, so there is no internal HTTP API
//     and therefore no shared secret to configure or leak;
//   * the app talks to the hub through the same GatewayClient interface, so
//     nothing downstream knows or cares which mode is running.

import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { logger } from '../logger.js';
import type { DeviceSettings } from '../config.js';
import type { DeviceStorage } from '../storage/index.js';
import type { GatewayClient } from '../devices/gatewayClient.js';
import type { CommandDispatch } from '../devices/protocol.js';
import type { DeviceService } from '../devices/deviceService.js';
import type { CommandService } from '../devices/commandService.js';
import { createAgentHub, type AgentHub } from './hub.js';
import type { AppClient } from './appClient.js';

/**
 * An AppClient that calls the services directly instead of going over HTTP.
 * Same contract the standalone gateway uses, minus the network.
 */
function createInProcessAppClient(
  storage: DeviceStorage,
  devices: DeviceService,
  commands: CommandService,
  settings: DeviceSettings,
): AppClient {
  return {
    async authenticate(input) {
      const authenticated = devices.authenticateDevice(input.credential);
      if (!authenticated) {
        // Deliberately no detail: unknown, revoked and wrong-secret look alike.
        logger.warn({ device: input.device?.name }, 'device credential rejected');
        return null;
      }
      const { device } = authenticated;
      const { acceptedCapabilities } = devices.markConnected(device, {
        agentVersion: input.device?.agentVersion,
        protocolVersion: input.protocolVersion,
        capabilities: input.capabilities,
      });

      // Anything queued while the device was away goes out now. Not awaited:
      // the handshake response should not wait on dispatch.
      void commands.flushQueuedForDevice(device.id).catch((err) => {
        logger.warn({ err, deviceId: device.id }, 'queued command flush failed');
      });

      return {
        deviceId: device.id,
        userId: device.userId,
        deviceName: device.name,
        heartbeatIntervalMs: settings.heartbeatIntervalMs,
        acceptedCapabilities,
      };
    },

    async disconnected(deviceId) {
      devices.markDisconnected(deviceId);
    },

    async heartbeat(deviceId) {
      devices.heartbeat(deviceId);
    },

    async capabilities(deviceId, capabilities) {
      // The gateway has already authenticated this device, so an id lookup is
      // the right level here — there is no user in scope to check against.
      const device = storage.devices.getById(deviceId);
      if (!device) {
        logger.debug({ deviceId }, 'capability update for unknown device');
        return;
      }
      devices.updateAdvertisedCapabilities(device, capabilities);
    },

    async result(input) {
      const outcome = commands.ingestResult({
        deviceId: input.deviceId,
        commandId: input.commandId,
        executionId: input.executionId,
        type: input.type,
        result: input.result,
        failure: input.failure
          ? {
              code: input.failure.code as
                | 'unsupported'
                | 'rejected'
                | 'failed'
                | 'duplicate'
                | 'invalid_parameters',
              message: input.failure.message,
            }
          : undefined,
        progressMessage: input.progressMessage,
      });
      if (!outcome.accepted) {
        // Late or mismatched results are dropped, not applied.
        logger.debug({ reason: outcome.reason }, 'device result not applied');
      }
    },
  };
}

export interface EmbeddedGateway {
  client: GatewayClient;
  hub: AgentHub;
  close(): Promise<void>;
}

/**
 * Attach the hub to an existing Fastify server and return a GatewayClient that
 * dispatches to it directly.
 */
export function attachEmbeddedGateway(input: {
  app: FastifyInstance;
  storage: DeviceStorage;
  devices: DeviceService;
  commands: CommandService;
  settings: DeviceSettings;
}): EmbeddedGateway {
  const hub = createAgentHub({
    appClient: createInProcessAppClient(
      input.storage,
      input.devices,
      input.commands,
      input.settings,
    ),
    heartbeatIntervalMs: input.settings.heartbeatIntervalMs,
    offlineAfterMs: input.settings.offlineAfterMs,
    logger: {
      info: (data, message) => logger.info(data, message),
      warn: (data, message) => logger.warn(data, message),
    },
  });

  input.app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    hub.handleUpgrade(request, socket, head);
  });

  const client: GatewayClient = {
    configured: () => true,
    async dispatch(deviceId: string, envelope: CommandDispatch) {
      return hub.dispatch(deviceId, envelope as unknown as Record<string, unknown>);
    },
    async cancel(deviceId, commandId, executionId) {
      return hub.cancel(deviceId, commandId, executionId);
    },
    async health() {
      const health = hub.health();
      return { ok: true, connections: health.connections, uptimeMs: health.uptimeMs };
    },
    async connectedDeviceIds() {
      return hub.connectedDeviceIds();
    },
  };

  logger.info({ path: '/agent' }, 'device gateway running in-process');
  return { client, hub, close: () => hub.close() };
}
