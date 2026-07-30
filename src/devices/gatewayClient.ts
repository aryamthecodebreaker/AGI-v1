// The app's client for the long-running device gateway.
//
// The app owns the database and all decisions; the gateway owns the sockets.
// They talk over a small authenticated HTTP API, which is what lets the web app
// stay on a serverless host while persistent connections live elsewhere.
//
// Every method fails soft. If the gateway is unreachable, device control
// degrades to "temporarily unavailable" and ordinary AGI-v1 chat keeps working
// — it never takes the app down with it.

import { logger } from '../logger.js';
import type { CommandDispatch } from './protocol.js';
import type { DeviceSettings } from '../config.js';

export interface DispatchOutcome {
  delivered: boolean;
  reason?: string;
}

export interface GatewayHealth {
  ok: boolean;
  connections?: number;
  uptimeMs?: number;
  error?: string;
}

export interface GatewayClient {
  /** False when no gateway is configured at all. */
  configured(): boolean;
  dispatch(deviceId: string, envelope: CommandDispatch): Promise<DispatchOutcome>;
  cancel(deviceId: string, commandId: string, executionId: string): Promise<DispatchOutcome>;
  health(): Promise<GatewayHealth>;
  /** Device ids the gateway currently holds a live socket for. */
  connectedDeviceIds(): Promise<string[]>;
}

const REQUEST_TIMEOUT_MS = 5000;

export function createHttpGatewayClient(settings: DeviceSettings): GatewayClient {
  // Read the URL at call time, not construction time: the gateway's address can
  // be set after wiring (notably in tests, which bind to an ephemeral port).
  const baseUrl = () => settings.gatewayUrl.replace(/\/+$/, '');

  async function call<T>(
    path: string,
    body: unknown,
    method: 'POST' | 'GET' = 'POST',
  ): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    const base = baseUrl();
    if (!base) return { ok: false, error: 'no gateway configured' };
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          // Shared secret, never exposed to a browser.
          'x-agi-gateway-secret': settings.gatewayInternalSecret,
        },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        return { ok: false, error: `gateway responded ${res.status}` };
      }
      return { ok: true, data: (await res.json()) as T };
    } catch (err) {
      // Includes timeouts and DNS/connection failures.
      return { ok: false, error: (err as Error).message };
    }
  }

  return {
    configured(): boolean {
      return Boolean(baseUrl() && settings.gatewayInternalSecret);
    },

    async dispatch(deviceId, envelope): Promise<DispatchOutcome> {
      const res = await call<DispatchOutcome>('/internal/dispatch', { deviceId, envelope });
      if (!res.ok) {
        logger.warn({ deviceId, error: res.error }, 'gateway dispatch failed');
        return { delivered: false, reason: `gateway unreachable: ${res.error}` };
      }
      return res.data;
    },

    async cancel(deviceId, commandId, executionId): Promise<DispatchOutcome> {
      const res = await call<DispatchOutcome>('/internal/cancel', {
        deviceId,
        commandId,
        executionId,
      });
      if (!res.ok) return { delivered: false, reason: res.error };
      return res.data;
    },

    async health(): Promise<GatewayHealth> {
      if (!baseUrl()) return { ok: false, error: 'no gateway configured' };
      const res = await call<GatewayHealth>('/internal/health', undefined, 'GET');
      if (!res.ok) return { ok: false, error: res.error };
      return { ...res.data, ok: true };
    },

    async connectedDeviceIds(): Promise<string[]> {
      const res = await call<{ deviceIds: string[] }>('/internal/connections', undefined, 'GET');
      if (!res.ok) return [];
      return res.data.deviceIds ?? [];
    },
  };
}

/**
 * A gateway client that reports nothing configured. Used when the feature is
 * off, and as the default in tests that do not exercise dispatch.
 */
export function createNullGatewayClient(): GatewayClient {
  return {
    configured: () => false,
    dispatch: async () => ({ delivered: false, reason: 'device gateway is not configured' }),
    cancel: async () => ({ delivered: false, reason: 'device gateway is not configured' }),
    health: async () => ({ ok: false, error: 'device gateway is not configured' }),
    connectedDeviceIds: async () => [],
  };
}
