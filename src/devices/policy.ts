// The single policy decision point for device commands.
//
// Every command — typed, spoken, or produced by a workflow — passes through
// evaluatePolicy() exactly once before anything is dispatched. Keeping this in
// one function means "does this need confirmation?" cannot drift between the
// chat path, the REST path, and the workflow runner.
//
// Risk can be escalated by context, not just by the capability itself:
//   * a wide fan-out is riskier than the same action on one device
//   * a queued action is a side effect the user will not be watching for
// Escalation only ever moves risk up.

import {
  isProhibitedCapability,
  maxRisk,
  type CapabilityDefinition,
  type RiskLevel,
} from './capabilities.js';
import type { PolicyDecision } from '../storage/repositories/commandRepo.js';

/**
 * Fan-out at or above this size is treated as moderate risk and asks first.
 * Three devices is a normal "all my phones"; ten is worth a second look.
 */
export const BROADCAST_CONFIRM_THRESHOLD = 4;

export interface PolicyInput {
  capability: CapabilityDefinition;
  /** How many devices would actually receive this command. */
  targetCount: number;
  /** The command will be held for devices that are currently offline. */
  queueIfOffline: boolean;
  /**
   * Set when the user has already confirmed a workflow run that contains this
   * step. Suppresses *escalation-driven* confirmation only — it can never turn
   * a deny into an allow, and never bypasses a capability that always asks.
   */
  preConfirmed?: boolean;
}

export interface PolicyResult {
  decision: PolicyDecision;
  /** Effective risk after escalation — this is what gets stored and audited. */
  risk: RiskLevel;
  /** Human-readable, safe to show the user verbatim. */
  reason: string;
}

export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const { capability, targetCount, queueIfOffline, preConfirmed } = input;

  // Hard denials first — no context can unlock these.
  if (isProhibitedCapability(capability.name)) {
    return {
      decision: 'deny',
      risk: 'prohibited',
      reason: `${capability.name} is not a supported action.`,
    };
  }
  if (capability.risk === 'prohibited') {
    return {
      decision: 'deny',
      risk: 'prohibited',
      reason: `${capability.name} is not a supported action.`,
    };
  }

  let risk: RiskLevel = capability.risk;
  const escalations: string[] = [];

  if (targetCount >= BROADCAST_CONFIRM_THRESHOLD) {
    risk = maxRisk(risk, 'moderate');
    escalations.push(`it affects ${targetCount} devices at once`);
  }
  if (queueIfOffline) {
    risk = maxRisk(risk, 'moderate');
    escalations.push('it will run later, when the device reconnects');
  }

  // A capability that always asks does so regardless of fan-out.
  if (capability.requiresConfirmation) {
    return {
      decision: 'require_confirmation',
      risk: maxRisk(risk, 'moderate'),
      reason: `${capability.name} always asks before running.`,
    };
  }

  if (risk === 'read_only' || risk === 'low') {
    return { decision: 'allow', risk, reason: 'Low-risk action.' };
  }

  if (preConfirmed) {
    return {
      decision: 'allow',
      risk,
      reason: 'Already confirmed as part of a workflow run.',
    };
  }

  return {
    decision: 'require_confirmation',
    risk,
    reason: escalations.length > 0 ? `Confirm because ${escalations.join(' and ')}.` : 'Confirm this action.',
  };
}

/** Risk level for a whole workflow run: at least moderate, so it asks once. */
export function workflowRunRisk(stepRisks: RiskLevel[]): RiskLevel {
  return stepRisks.reduce<RiskLevel>((acc, r) => maxRisk(acc, r), 'moderate');
}

/**
 * Capability categories we explicitly do not implement, with the honest reason.
 * Surfaced to the user when a request lands on one of them, instead of the
 * assistant pretending it tried and failed.
 */
export const UNSUPPORTED_INTENTS: { match: RegExp; reason: string }[] = [
  {
    match: /\b(unlock|bypass|crack|defeat)\b.{0,30}\b(phone|screen|lock ?screen|pin|password|passcode|fingerprint|face ?id|biometric)/i,
    reason:
      'I cannot unlock a locked device or bypass a PIN, password or biometric. That protection is enforced by the operating system and getting around it is not something I will do.',
  },
  {
    match: /\b(record|listen to|spy on|watch)\b.{0,30}\b(mic|microphone|camera|screen|room|conversation)/i,
    reason:
      'I cannot silently record a microphone, camera or screen. Hidden recording is not a supported capability.',
  },
  {
    match: /\b(run|execute|exec)\b.{0,20}\b(shell|command|powershell|cmd|bash|script|terminal)\b/i,
    reason:
      'I cannot run arbitrary shell commands or scripts on your devices. Device agents only expose a fixed set of approved actions.',
  },
  {
    match: /\b(disable|turn off|kill)\b.{0,25}\b(antivirus|defender|firewall|security|protection)\b/i,
    reason: 'I cannot disable security software or protections on a device.',
  },
  {
    match: /\b(delete|wipe|erase|format)\b.{0,25}\b(files?|disk|drive|everything|data)\b/i,
    reason:
      'I cannot delete files or wipe storage on a device. File deletion is not an exposed capability.',
  },
  {
    match: /\b(buy|purchase|order|pay)\b/i,
    reason:
      'I cannot make purchases or move money from a device. You will need to do that yourself.',
  },
];

/**
 * Detect a request for something we deliberately do not support, so the
 * assistant can say so plainly instead of planning a command that would fail.
 */
export function findUnsupportedIntent(text: string): string | null {
  for (const entry of UNSUPPORTED_INTENTS) {
    if (entry.match.test(text)) return entry.reason;
  }
  return null;
}
