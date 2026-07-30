// The gateway's client for the main app.
//
// The gateway holds sockets; the app holds the database and every decision. So
// the gateway asks the app "is this credential valid?" and tells it "this device
// said X" — it never reasons about users, commands or policy itself.

import type { CapabilityAdvert } from '../devices/protocol.js';

export interface AuthenticatedDeviceInfo {
  deviceId: string;
  userId: string;
  deviceName: string;
  heartbeatIntervalMs: number;
  acceptedCapabilities: string[];
}

export interface AppClient {
  authenticate(input: {
    credential: string;
    device: {
      name?: string;
      deviceType?: string;
      platform?: string;
      platformVersion?: string;
      agentVersion?: string;
    };
    capabilities: CapabilityAdvert[];
    protocolVersion: string;
  }): Promise<AuthenticatedDeviceInfo | null>;

  disconnected(deviceId: string): Promise<void>;
  heartbeat(deviceId: string): Promise<void>;
  capabilities(deviceId: string, capabilities: CapabilityAdvert[]): Promise<void>;
  result(input: {
    deviceId: string;
    commandId: string;
    executionId: string;
    type: 'acknowledged' | 'progress' | 'completed' | 'failed';
    result?: Record<string, unknown>;
    failure?: { code: string; message?: string };
    progressMessage?: string;
  }): Promise<void>;
}

const TIMEOUT_MS = 5000;

export function createAppClient(appUrl: string, internalSecret: string): AppClient {
  async function post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${appUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agi-gateway-secret': internalSecret,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  return {
    async authenticate(input) {
      return post<AuthenticatedDeviceInfo>('/internal/gateway/authenticate', input);
    },
    async disconnected(deviceId) {
      await post('/internal/gateway/disconnected', { deviceId });
    },
    async heartbeat(deviceId) {
      await post('/internal/gateway/heartbeat', { deviceId });
    },
    async capabilities(deviceId, capabilities) {
      await post('/internal/gateway/capabilities', { deviceId, capabilities });
    },
    async result(input) {
      await post('/internal/gateway/result', input);
    },
  };
}
