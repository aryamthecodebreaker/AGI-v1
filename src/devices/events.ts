// In-process pub/sub used to push device and command changes to browsers over
// SSE.
//
// This is a notification channel, not a source of truth. A browser that missed
// events while disconnected re-reads the durable command state on reconnect, so
// a dropped notification degrades to "the UI updates a moment later" rather
// than "the UI is permanently wrong".
//
// Single-process only. Running several app instances behind a load balancer
// would need a shared broker; see docs/gateway-deployment.md.

import { EventEmitter } from 'node:events';
import type { ExecutionState } from '../storage/repositories/executionRepo.js';
import type { CommandStatus } from '../storage/repositories/commandRepo.js';

export type DeviceStreamEvent =
  | {
      kind: 'device.connected' | 'device.disconnected' | 'device.updated' | 'device.revoked';
      deviceId: string;
      deviceName: string;
      online: boolean;
    }
  | {
      kind: 'command.created' | 'command.updated';
      commandId: string;
      status: CommandStatus;
    }
  | {
      kind: 'execution.updated';
      commandId: string;
      executionId: string;
      deviceId: string;
      deviceName: string;
      state: ExecutionState;
      detail?: string | null;
    }
  | {
      kind: 'confirmation.requested' | 'confirmation.resolved';
      commandId: string;
      confirmationId: string;
      summary?: string;
    }
  /**
   * Dispatch to the browser acting as a device.
   *
   * The browser cannot connect to the gateway, because that would require giving
   * a device credential to JavaScript. Instead it receives its commands over this
   * already-authenticated stream and posts results back to
   * /api/agi-command/browser-result using the session cookie.
   */
  | {
      kind: 'browser.dispatch';
      commandId: string;
      executionId: string;
      deviceId: string;
      capability: string;
      parameters: Record<string, unknown>;
      timeoutMs: number;
      expiresAt: number;
    }
  | {
      kind: 'browser.cancel';
      commandId: string;
      executionId: string;
      deviceId: string;
    };

export type DeviceStreamListener = (event: DeviceStreamEvent) => void;

class DeviceEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open browser tab; the default cap of 10 is too low and
    // its warning is noise, not a leak signal here.
    this.emitter.setMaxListeners(0);
  }

  publish(userId: string, event: DeviceStreamEvent): void {
    this.emitter.emit(userId, event);
  }

  subscribe(userId: string, listener: DeviceStreamListener): () => void {
    this.emitter.on(userId, listener);
    return () => this.emitter.off(userId, listener);
  }

  listenerCount(userId: string): number {
    return this.emitter.listenerCount(userId);
  }
}

export const deviceEvents = new DeviceEventBus();
