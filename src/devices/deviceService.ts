// Device lifecycle: pairing, registration, authentication, revocation.
//
// Everything that mutates the registry goes through here so the ownership
// checks, audit events and credential handling live in one place. Routes do
// HTTP concerns; this does device concerns.
//
// The pairing flow:
//   1. A signed-in user asks for a code. We return the plaintext code ONCE and
//      store only an HMAC of it.
//   2. The device presents the code plus its self-description.
//   3. We atomically consume the code, create the device, and mint a credential
//      that is returned exactly once.
// After that the code is dead and the device authenticates with its credential.

import type { DeviceStorage } from '../storage/index.js';
import type { Device, DeviceType } from '../storage/repositories/deviceRepo.js';
import type { DeviceCredential } from '../storage/repositories/deviceCredentialRepo.js';
import { isDeviceOnline } from '../storage/repositories/deviceRepo.js';
import { logger } from '../logger.js';
import { Errors } from '../util/errors.js';
import { now } from '../util/time.js';
import {
  formatCredentialToken,
  formatPairingCode,
  generateCredentialSecret,
  generatePairingCode,
  hashPairingCode,
  isPlausiblePairingCode,
  parseCredentialToken,
  sha256Hex,
  verifyCredentialSecret,
} from './credentials.js';
import { getCapability, isProhibitedCapability } from './capabilities.js';
import { RateLimiter } from './rateLimit.js';
import { deviceEvents } from './events.js';
import type { DeviceSettings } from '../config.js';
import type { CapabilityAdvert } from './protocol.js';

/** At most 5 codes per user per 10 minutes. */
const pairingCreateLimiter = new RateLimiter(5, 10 * 60 * 1000);
/** At most 10 redemption attempts per source per 10 minutes. */
const pairingAttemptLimiter = new RateLimiter(10, 10 * 60 * 1000);

/** Exposed so tests can start from a clean slate. */
export function resetPairingRateLimits(): void {
  pairingCreateLimiter.reset();
  pairingAttemptLimiter.reset();
}

export interface PairingCodeIssued {
  pairingId: string;
  /** Display form ("ABCD-EFGH"). Returned once, never stored or logged. */
  code: string;
  expiresAt: number;
}

export interface PairDeviceInput {
  code: string;
  name: string;
  deviceType: DeviceType;
  platform?: string;
  platformVersion?: string;
  agentVersion?: string;
  protocolVersion?: string;
  capabilities?: CapabilityAdvert[];
  metadata?: Record<string, unknown>;
  /** Opaque source key for rate limiting (usually the request IP). */
  sourceKey?: string;
}

export interface PairedDevice {
  device: Device;
  /** Full credential token. Returned once — the server keeps only a hash. */
  credentialToken: string;
  acceptedCapabilities: string[];
  rejectedCapabilities: string[];
}

export interface DeviceWithState {
  device: Device;
  online: boolean;
  capabilities: { capability: string; version: number; advertised: boolean; enabled: boolean }[];
  groups: { id: string; name: string; slug: string }[];
}

export interface AuthenticatedDevice {
  device: Device;
  credential: DeviceCredential;
}

export function createDeviceService(
  storage: DeviceStorage,
  settings: DeviceSettings,
  serverSecret: string,
) {
  /**
   * Keep only capabilities we actually know about. An agent advertising
   * something prohibited or unknown does not get it silently accepted — the
   * capability is dropped and the attempt is recorded.
   */
  function filterCapabilities(caps: CapabilityAdvert[] = []): {
    accepted: { capability: string; version: number }[];
    rejected: string[];
  } {
    const accepted: { capability: string; version: number }[] = [];
    const rejected: string[] = [];
    for (const c of caps) {
      if (isProhibitedCapability(c.name) || !getCapability(c.name)) {
        rejected.push(c.name);
        continue;
      }
      accepted.push({ capability: c.name, version: c.version });
    }
    return { accepted, rejected };
  }

  /** Device names are how the user addresses devices, so keep them unique. */
  function uniqueName(userId: string, desired: string): string {
    const base = desired.trim().slice(0, 80) || 'Device';
    if (!storage.devices.getByName(userId, base)) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base} ${i}`;
      if (!storage.devices.getByName(userId, candidate)) return candidate;
    }
    throw Errors.conflict(`Too many devices named like "${base}".`);
  }

  function issueCredential(device: Device): string {
    const { secret, secretHash } = generateCredentialSecret();
    const credential = storage.deviceCredentials.create({
      deviceId: device.id,
      userId: device.userId,
      secretHash,
    });
    return formatCredentialToken(credential.id, secret);
  }

  return {
    // -----------------------------------------------------------------------
    // Pairing
    // -----------------------------------------------------------------------

    createPairingSession(userId: string): PairingCodeIssued {
      if (!pairingCreateLimiter.tryConsume(userId)) {
        const wait = Math.ceil(pairingCreateLimiter.retryAfterMs(userId) / 1000);
        throw Errors.conflict(`Too many pairing codes requested. Try again in ${wait}s.`);
      }
      const code = generatePairingCode();
      const expiresAt = now() + settings.pairingTtlMs;
      const session = storage.pairings.create({
        userId,
        codeHash: hashPairingCode(code, serverSecret),
        expiresAt,
      });
      storage.deviceEvents.record({
        userId,
        kind: 'pairing.created',
        // Deliberately no code, not even a prefix.
        detail: `expires in ${Math.round(settings.pairingTtlMs / 1000)}s`,
      });
      logger.info({ userId, pairingId: session.id }, 'pairing code issued');
      return { pairingId: session.id, code: formatPairingCode(code), expiresAt };
    },

    /**
     * Redeem a pairing code. Every failure path returns the same generic error
     * so a caller cannot tell "wrong code" from "expired" from "already used".
     */
    pairDevice(input: PairDeviceInput): PairedDevice {
      const sourceKey = input.sourceKey ?? 'unknown';
      if (!pairingAttemptLimiter.tryConsume(sourceKey)) {
        throw Errors.conflict('Too many pairing attempts. Try again shortly.');
      }
      const genericFailure = () =>
        Errors.badRequest('That pairing code is not valid. Generate a new one and try again.');

      if (!isPlausiblePairingCode(input.code)) throw genericFailure();

      const session = storage.pairings.getByCodeHash(
        hashPairingCode(input.code, serverSecret),
      );
      if (!session) throw genericFailure();
      if (session.consumedAt !== null) throw genericFailure();
      if (session.expiresAt <= now()) throw genericFailure();

      const { accepted, rejected } = filterCapabilities(input.capabilities);

      const device = storage.devices.create({
        userId: session.userId,
        name: uniqueName(session.userId, input.name),
        deviceType: input.deviceType,
        platform: input.platform,
        platformVersion: input.platformVersion,
        agentVersion: input.agentVersion,
        protocolVersion: input.protocolVersion,
        metadata: input.metadata,
      });

      // Atomic single-use claim. If another request won the race, undo the
      // device we just created rather than leaving an orphan.
      if (!storage.pairings.consume(session.id, device.id)) {
        storage.devices.remove(device.id);
        storage.deviceEvents.record({
          userId: session.userId,
          kind: 'pairing.failed',
          detail: 'code already consumed',
        });
        throw genericFailure();
      }

      if (accepted.length > 0) {
        storage.devices.replaceAdvertisedCapabilities(device.id, accepted);
      }
      // First device paired becomes primary, so "my primary device" resolves.
      if (storage.devices.listByUser(session.userId).length === 1) {
        storage.devices.setPrimary(session.userId, device.id);
      }

      const credentialToken = issueCredential(device);

      storage.deviceEvents.record({
        userId: session.userId,
        deviceId: device.id,
        kind: 'pairing.consumed',
        detail: `${device.name} (${device.deviceType})`,
      });
      storage.deviceEvents.record({
        userId: session.userId,
        deviceId: device.id,
        kind: 'device.registered',
        detail: rejected.length ? `rejected capabilities: ${rejected.join(', ')}` : null,
      });
      if (rejected.length > 0) {
        logger.warn(
          { deviceId: device.id, rejected },
          'device advertised capabilities that are not in the registry — dropped',
        );
      }
      logger.info({ deviceId: device.id, name: device.name }, 'device paired');

      const fresh = storage.devices.getById(device.id) ?? device;
      deviceEvents.publish(session.userId, {
        kind: 'device.updated',
        deviceId: fresh.id,
        deviceName: fresh.name,
        online: false,
      });

      return {
        device: fresh,
        credentialToken,
        acceptedCapabilities: accepted.map((a) => a.capability),
        rejectedCapabilities: rejected,
      };
    },

    // -----------------------------------------------------------------------
    // Authentication (gateway-facing)
    // -----------------------------------------------------------------------

    /**
     * Verify a device credential. Returns null for every failure — unknown,
     * revoked, wrong secret, revoked device — so callers cannot probe which.
     */
    authenticateDevice(token: string): AuthenticatedDevice | null {
      const parsed = parseCredentialToken(token);
      if (!parsed) return null;

      const credential = storage.deviceCredentials.getById(parsed.credentialId);
      if (!credential) {
        // Compare against a throwaway hash so a bad id and a bad secret take a
        // similar amount of work.
        verifyCredentialSecret(parsed.secret, sha256Hex('no-such-credential'));
        return null;
      }
      if (credential.revokedAt !== null) return null;
      if (!verifyCredentialSecret(parsed.secret, credential.secretHash)) return null;

      const device = storage.devices.getById(credential.deviceId);
      if (!device || device.revokedAt !== null) return null;

      storage.deviceCredentials.touch(credential.id);
      return { device, credential };
    },

    // -----------------------------------------------------------------------
    // Connection state (gateway-facing)
    // -----------------------------------------------------------------------

    markConnected(
      device: Device,
      info: { agentVersion?: string; protocolVersion?: string; capabilities?: CapabilityAdvert[] },
    ): { acceptedCapabilities: string[]; rejectedCapabilities: string[] } {
      storage.devices.markConnected(device.id, {
        agentVersion: info.agentVersion,
        protocolVersion: info.protocolVersion,
      });
      const { accepted, rejected } = filterCapabilities(info.capabilities);
      if (info.capabilities) {
        storage.devices.replaceAdvertisedCapabilities(device.id, accepted);
      }
      storage.deviceEvents.record({
        userId: device.userId,
        deviceId: device.id,
        kind: 'device.connected',
        detail: info.agentVersion ? `agent ${info.agentVersion}` : null,
      });
      deviceEvents.publish(device.userId, {
        kind: 'device.connected',
        deviceId: device.id,
        deviceName: device.name,
        online: true,
      });
      // Only capabilities the user has left enabled are actually usable.
      const usable = storage.devices
        .listCapabilities(device.id)
        .filter((c) => c.advertised && c.enabled)
        .map((c) => c.capability);
      return { acceptedCapabilities: usable, rejectedCapabilities: rejected };
    },

    markDisconnected(deviceId: string): void {
      const device = storage.devices.getById(deviceId);
      if (!device) return;
      storage.devices.markDisconnected(deviceId);
      storage.deviceEvents.record({
        userId: device.userId,
        deviceId,
        kind: 'device.disconnected',
      });
      deviceEvents.publish(device.userId, {
        kind: 'device.disconnected',
        deviceId,
        deviceName: device.name,
        online: false,
      });
    },

    heartbeat(deviceId: string): void {
      storage.devices.heartbeat(deviceId);
    },

    updateAdvertisedCapabilities(device: Device, caps: CapabilityAdvert[]): string[] {
      const { accepted, rejected } = filterCapabilities(caps);
      storage.devices.replaceAdvertisedCapabilities(device.id, accepted);
      storage.deviceEvents.record({
        userId: device.userId,
        deviceId: device.id,
        kind: 'device.capabilities_updated',
        detail: `${accepted.length} accepted${rejected.length ? `, ${rejected.length} rejected` : ''}`,
      });
      return rejected;
    },

    // -----------------------------------------------------------------------
    // User-facing management
    // -----------------------------------------------------------------------

    listWithState(userId: string): DeviceWithState[] {
      return storage.devices.listByUser(userId).map((device) => ({
        device,
        online: isDeviceOnline(device, settings.offlineAfterMs),
        capabilities: storage.devices.listCapabilities(device.id).map((c) => ({
          capability: c.capability,
          version: c.version,
          advertised: c.advertised,
          enabled: c.enabled,
        })),
        groups: storage.deviceGroups
          .groupsForDevice(device.id)
          .map((g) => ({ id: g.id, name: g.name, slug: g.slug })),
      }));
    },

    getWithState(userId: string, deviceId: string): DeviceWithState | null {
      const device = storage.devices.getOwned(userId, deviceId);
      if (!device) return null;
      return {
        device,
        online: isDeviceOnline(device, settings.offlineAfterMs),
        capabilities: storage.devices.listCapabilities(device.id).map((c) => ({
          capability: c.capability,
          version: c.version,
          advertised: c.advertised,
          enabled: c.enabled,
        })),
        groups: storage.deviceGroups
          .groupsForDevice(device.id)
          .map((g) => ({ id: g.id, name: g.name, slug: g.slug })),
      };
    },

    requireOwned(userId: string, deviceId: string): Device {
      const device = storage.devices.getOwned(userId, deviceId);
      if (!device) throw Errors.notFound('Device not found');
      return device;
    },

    rename(userId: string, deviceId: string, name: string): Device {
      const device = this.requireOwned(userId, deviceId);
      const trimmed = name.trim();
      if (!trimmed) throw Errors.badRequest('Device name cannot be empty');
      const clash = storage.devices.getByName(userId, trimmed);
      if (clash && clash.id !== device.id) {
        throw Errors.conflict(`You already have a device called "${trimmed}".`);
      }
      storage.devices.rename(deviceId, trimmed);
      storage.deviceEvents.record({
        userId,
        deviceId,
        kind: 'device.renamed',
        detail: `${device.name} -> ${trimmed}`,
      });
      const fresh = storage.devices.getById(deviceId)!;
      deviceEvents.publish(userId, {
        kind: 'device.updated',
        deviceId,
        deviceName: fresh.name,
        online: isDeviceOnline(fresh, settings.offlineAfterMs),
      });
      return fresh;
    },

    setPrimary(userId: string, deviceId: string): Device {
      this.requireOwned(userId, deviceId);
      storage.devices.setPrimary(userId, deviceId);
      const fresh = storage.devices.getById(deviceId)!;
      deviceEvents.publish(userId, {
        kind: 'device.updated',
        deviceId,
        deviceName: fresh.name,
        online: isDeviceOnline(fresh, settings.offlineAfterMs),
      });
      return fresh;
    },

    setCapabilityEnabled(
      userId: string,
      deviceId: string,
      capability: string,
      enabled: boolean,
    ): void {
      this.requireOwned(userId, deviceId);
      if (!getCapability(capability)) throw Errors.badRequest(`Unknown capability: ${capability}`);
      storage.devices.setCapabilityEnabled(deviceId, capability, enabled);
      storage.deviceEvents.record({
        userId,
        deviceId,
        kind: 'device.capabilities_updated',
        detail: `${capability} ${enabled ? 'enabled' : 'disabled'}`,
      });
    },

    /**
     * Revoke: the device stays in history but can never connect or run anything
     * again. All its credentials die with it.
     */
    revoke(userId: string, deviceId: string): void {
      const device = this.requireOwned(userId, deviceId);
      storage.deviceCredentials.revokeAllForDevice(deviceId);
      storage.devices.revoke(deviceId);
      storage.deviceEvents.record({
        userId,
        deviceId,
        kind: 'device.revoked',
        detail: device.name,
      });
      deviceEvents.publish(userId, {
        kind: 'device.revoked',
        deviceId,
        deviceName: device.name,
        online: false,
      });
      logger.info({ deviceId, userId }, 'device revoked');
    },

    /** Hard delete, including command history for that device. */
    remove(userId: string, deviceId: string): void {
      const device = this.requireOwned(userId, deviceId);
      storage.deviceCredentials.revokeAllForDevice(deviceId);
      storage.devices.remove(deviceId);
      storage.deviceEvents.record({
        userId,
        kind: 'device.removed',
        detail: device.name,
      });
      deviceEvents.publish(userId, {
        kind: 'device.revoked',
        deviceId,
        deviceName: device.name,
        online: false,
      });
    },

    /** Issue a fresh credential and kill the old ones. */
    rotateCredential(userId: string, deviceId: string): string {
      const device = this.requireOwned(userId, deviceId);
      storage.deviceCredentials.revokeAllForDevice(deviceId);
      const token = issueCredential(device);
      storage.deviceEvents.record({
        userId,
        deviceId,
        kind: 'device.credential_rotated',
      });
      logger.info({ deviceId }, 'device credential rotated');
      return token;
    },
  };
}

export type DeviceService = ReturnType<typeof createDeviceService>;
