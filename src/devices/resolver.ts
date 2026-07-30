// Deterministic target resolution.
//
// The planner may only produce a *description* of who to target. Turning that
// description into actual devices happens here, against the real registry, with
// no model involvement. That split is deliberate: the LLM is allowed to be
// wrong about phrasing, never about which devices exist, which are online, or
// which support an action.
//
// The resolver never guesses when a reference is ambiguous. It reports the
// ambiguity so the assistant can ask one short clarifying question.

import {
  isDeviceOnline,
  type Device,
  type DeviceType,
} from '../storage/repositories/deviceRepo.js';
import type { Storage } from '../storage/index.js';
import { slugifyGroup } from '../storage/repositories/deviceGroupRepo.js';
import {
  capabilitySupportsDeviceType,
  type CapabilityDefinition,
} from './capabilities.js';

/**
 * A target expression as produced by the planner or a REST caller. Every field
 * is optional; an expression with no positive selector resolves to nothing,
 * which the caller surfaces as "who did you mean?".
 */
export interface TargetExpression {
  includeDeviceIds?: string[];
  /** Spoken/typed device names, e.g. "Phone One". */
  includeDeviceNames?: string[];
  /** Group slugs, group names, or virtual groups (phones, computers, all). */
  includeGroups?: string[];
  excludeDeviceIds?: string[];
  excludeDeviceNames?: string[];
  excludeGroups?: string[];
  /** "my primary computer", "the main device" */
  primaryOnly?: boolean;
  /** "this device" — the browser session that issued the command. */
  thisDevice?: boolean;
  /** "the same devices as before" */
  sameAsPrevious?: boolean;
  /** "only the one that failed" */
  failedOnly?: boolean;
  /** "all online devices" — restricts the pool rather than reporting offline. */
  onlineOnly?: boolean;
}

export interface UnsupportedTarget {
  device: Device;
  reason: string;
}

export interface AmbiguousReference {
  reference: string;
  candidates: Device[];
}

export interface ResolvedTargets {
  /** Online, capable, permitted — these will actually receive the command. */
  matched: Device[];
  /** Selected by the expression but not currently connected. */
  offline: Device[];
  /** Selected but cannot run this capability, with the honest reason. */
  unsupported: UnsupportedTarget[];
  /** Removed by an explicit exclusion — reported so the user sees it worked. */
  excluded: Device[];
  ambiguous: AmbiguousReference[];
  /** References that matched no device at all. */
  unmatched: string[];
}

/** Extra context that only the conversation layer knows. */
export interface ResolveContext {
  /** Device id of the browser session issuing the command, if any. */
  thisDeviceId?: string | null;
  /** Devices targeted by the command being corrected or retried. */
  previousDeviceIds?: string[];
  /** Devices that failed / went offline on the previous command. */
  failedDeviceIds?: string[];
}

/**
 * Virtual groups derived from device_type. These are computed, never stored, so
 * "all my phones" cannot go stale when a device is added.
 * A user-created group with the same slug takes precedence — their explicit
 * grouping is a better signal of intent than our type mapping.
 */
const EVERY_TYPE: readonly DeviceType[] = [
  'android_phone',
  'android_tablet',
  'windows',
  'browser',
  'generic',
  'simulated',
];

/**
 * Only plural forms are groups. Singular words like "phone" or "laptop" are
 * left to device-name matching on purpose: with two devices called "Phone One"
 * and "Phone Two", "the phone" is genuinely ambiguous and the user should be
 * asked, not silently given both.
 */
const VIRTUAL_GROUPS: Record<string, readonly DeviceType[]> = {
  phones: ['android_phone'],
  tablets: ['android_tablet'],
  computers: ['windows'],
  laptops: ['windows'],
  desktops: ['windows'],
  pcs: ['windows'],
  browsers: ['browser'],
  'mobile-devices': ['android_phone', 'android_tablet'],
  mobiles: ['android_phone', 'android_tablet'],
  all: EVERY_TYPE,
  'all-devices': EVERY_TYPE,
  everything: EVERY_TYPE,
  devices: EVERY_TYPE,
};

export function isVirtualGroup(reference: string): boolean {
  return slugifyGroup(reference) in VIRTUAL_GROUPS;
}

/** Every group name the user could say, for planner prompts and the UI. */
export function knownGroupSlugs(storage: Storage, userId: string): string[] {
  const custom = storage.deviceGroups.listByUser(userId).map((g) => g.slug);
  return [...new Set([...Object.keys(VIRTUAL_GROUPS), ...custom])];
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Resolve one spoken device name.
 * Exact match wins. Otherwise fall back to a word-boundary containment match,
 * which is what makes "phone one" find "Phone One" and "laptop" find
 * "Work Laptop" — but only when exactly one device matches.
 */
function matchByName(
  reference: string,
  devices: Device[],
): { device?: Device; candidates: Device[] } {
  const needle = normalizeName(reference);
  if (!needle) return { candidates: [] };

  const exact = devices.filter((d) => normalizeName(d.name) === needle);
  if (exact.length === 1) return { device: exact[0], candidates: exact };
  if (exact.length > 1) return { candidates: exact };

  const contains = devices.filter((d) => {
    const haystack = normalizeName(d.name);
    return haystack === needle || haystack.includes(needle) || needle.includes(haystack);
  });
  if (contains.length === 1) return { device: contains[0], candidates: contains };
  return { candidates: contains };
}

function devicesInGroup(
  storage: Storage,
  userId: string,
  reference: string,
  pool: Device[],
): Device[] | null {
  const slug = slugifyGroup(reference);

  // A user-created group beats the type-derived one of the same name.
  const custom = storage.deviceGroups.getBySlug(userId, slug);
  if (custom) {
    const memberIds = new Set(storage.deviceGroups.memberDeviceIds(custom.id));
    return pool.filter((d) => memberIds.has(d.id));
  }

  const types = VIRTUAL_GROUPS[slug];
  if (types) return pool.filter((d) => types.includes(d.deviceType));

  return null;
}

export interface ResolveInput {
  userId: string;
  expression: TargetExpression;
  /** When present, targets are filtered by capability support. */
  capability?: CapabilityDefinition | null;
  context?: ResolveContext;
  offlineAfterMs: number;
  at?: number;
}

export function resolveTargets(storage: Storage, input: ResolveInput): ResolvedTargets {
  const { userId, expression, capability, context } = input;
  const at = input.at ?? Date.now();
  const pool = storage.devices.listByUser(userId); // active, non-revoked, this user only

  const matchedSet = new Map<string, Device>();
  const ambiguous: AmbiguousReference[] = [];
  const unmatched: string[] = [];
  let sawPositiveSelector = false;

  const addAll = (devices: Device[]) => {
    for (const d of devices) matchedSet.set(d.id, d);
  };

  // ---- positive selectors ----

  if (expression.includeDeviceIds?.length) {
    sawPositiveSelector = true;
    for (const id of expression.includeDeviceIds) {
      const found = pool.find((d) => d.id === id);
      if (found) matchedSet.set(found.id, found);
      else unmatched.push(id);
    }
  }

  if (expression.includeDeviceNames?.length) {
    sawPositiveSelector = true;
    for (const name of expression.includeDeviceNames) {
      // Order matters. An exact device name always wins — a device literally
      // called "Phones" is that device, not the group. Only then do we try the
      // reference as a group, and only then fall back to fuzzy name matching,
      // which is where ambiguity is reported instead of guessed at.
      const exact = pool.find((d) => normalizeName(d.name) === normalizeName(name));
      if (exact) {
        matchedSet.set(exact.id, exact);
        continue;
      }
      const asGroup = devicesInGroup(storage, userId, name, pool);
      if (asGroup && asGroup.length > 0) {
        addAll(asGroup);
        continue;
      }
      const { device, candidates } = matchByName(name, pool);
      if (device) matchedSet.set(device.id, device);
      else if (candidates.length > 1) ambiguous.push({ reference: name, candidates });
      else unmatched.push(name);
    }
  }

  if (expression.includeGroups?.length) {
    sawPositiveSelector = true;
    for (const g of expression.includeGroups) {
      const devices = devicesInGroup(storage, userId, g, pool);
      if (devices === null) unmatched.push(g);
      else if (devices.length === 0) unmatched.push(g);
      else addAll(devices);
    }
  }

  if (expression.primaryOnly) {
    sawPositiveSelector = true;
    const primary = pool.find((d) => d.isPrimary);
    if (primary) matchedSet.set(primary.id, primary);
    else unmatched.push('primary device');
  }

  if (expression.thisDevice) {
    sawPositiveSelector = true;
    const id = context?.thisDeviceId;
    const found = id ? pool.find((d) => d.id === id) : undefined;
    if (found) matchedSet.set(found.id, found);
    else unmatched.push('this device');
  }

  if (expression.sameAsPrevious) {
    sawPositiveSelector = true;
    const ids = context?.previousDeviceIds ?? [];
    if (ids.length === 0) unmatched.push('the same devices as before');
    else addAll(pool.filter((d) => ids.includes(d.id)));
  }

  if (expression.failedOnly) {
    sawPositiveSelector = true;
    const ids = context?.failedDeviceIds ?? [];
    if (ids.length === 0) unmatched.push('the devices that failed');
    else addAll(pool.filter((d) => ids.includes(d.id)));
  }

  // "all online devices" on its own is a positive selector.
  if (expression.onlineOnly && !sawPositiveSelector) {
    sawPositiveSelector = true;
    addAll(pool.filter((d) => isDeviceOnline(d, input.offlineAfterMs, at)));
  }

  // ---- exclusions ----

  const excluded: Device[] = [];
  const drop = (device: Device) => {
    if (matchedSet.delete(device.id)) excluded.push(device);
  };

  for (const id of expression.excludeDeviceIds ?? []) {
    const found = pool.find((d) => d.id === id);
    if (found) drop(found);
  }
  for (const name of expression.excludeDeviceNames ?? []) {
    // Same precedence as inclusion: exact name, then group, then fuzzy.
    const exact = pool.find((d) => normalizeName(d.name) === normalizeName(name));
    if (exact) {
      drop(exact);
      continue;
    }
    const asGroup = devicesInGroup(storage, userId, name, pool);
    if (asGroup && asGroup.length > 0) {
      for (const d of asGroup) drop(d);
      continue;
    }
    const { device, candidates } = matchByName(name, pool);
    if (device) drop(device);
    else if (candidates.length > 1) ambiguous.push({ reference: name, candidates });
    else unmatched.push(name);
  }
  for (const g of expression.excludeGroups ?? []) {
    const devices = devicesInGroup(storage, userId, g, pool);
    if (devices === null) unmatched.push(g);
    else for (const d of devices) drop(d);
  }

  let selected = [...matchedSet.values()];

  // "every online phone" — restrict rather than report offline members.
  if (expression.onlineOnly && sawPositiveSelector) {
    selected = selected.filter((d) => isDeviceOnline(d, input.offlineAfterMs, at));
  }

  // ---- partition by capability support and connectivity ----

  const unsupported: UnsupportedTarget[] = [];
  const capable: Device[] = [];

  for (const device of selected) {
    if (!capability) {
      capable.push(device);
      continue;
    }
    if (!capabilitySupportsDeviceType(capability, device.deviceType)) {
      unsupported.push({
        device,
        reason: `${capability.name} is not available on a ${device.deviceType.replace(/_/g, ' ')}`,
      });
      continue;
    }
    const entry = storage.devices.getCapability(device.id, capability.name);
    if (!entry || !entry.advertised) {
      unsupported.push({
        device,
        reason: `${device.name} does not report support for ${capability.name}`,
      });
      continue;
    }
    if (!entry.enabled) {
      unsupported.push({
        device,
        reason: `${capability.name} is switched off for ${device.name}`,
      });
      continue;
    }
    if (entry.version < capability.version) {
      unsupported.push({
        device,
        reason: `${device.name} supports an older version of ${capability.name}`,
      });
      continue;
    }
    capable.push(device);
  }

  const matched: Device[] = [];
  const offline: Device[] = [];
  for (const device of capable) {
    if (isDeviceOnline(device, input.offlineAfterMs, at)) matched.push(device);
    else offline.push(device);
  }

  const sortByName = (a: Device, b: Device) => a.name.localeCompare(b.name);
  return {
    matched: matched.sort(sortByName),
    offline: offline.sort(sortByName),
    unsupported,
    excluded: excluded.sort(sortByName),
    ambiguous,
    unmatched: [...new Set(unmatched)],
  };
}

/** True when nothing at all was selected and we should ask instead of guess. */
export function needsClarification(resolved: ResolvedTargets): boolean {
  if (resolved.ambiguous.length > 0) return true;
  return (
    resolved.matched.length === 0 &&
    resolved.offline.length === 0 &&
    resolved.unsupported.length === 0
  );
}

/** One short question, not a menu — e.g. "Phone One or Phone Two?" */
export function clarificationQuestion(resolved: ResolvedTargets): string {
  const amb = resolved.ambiguous[0];
  if (amb) {
    const names = amb.candidates.map((d) => d.name);
    return `Which one did you mean by "${amb.reference}" — ${listPhrase(names, 'or')}?`;
  }
  if (resolved.unmatched.length > 0) {
    return `I could not find ${listPhrase(resolved.unmatched, 'or')} in your devices. Which device did you mean?`;
  }
  return 'Which device should I use?';
}

/** "A, B and C" / "A or B" */
export function listPhrase(items: string[], conjunction: 'and' | 'or' = 'and'): string {
  if (items.length === 0) return 'nothing';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`;
}
