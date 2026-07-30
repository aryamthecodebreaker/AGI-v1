// Natural-language planning for device intents.
//
// The planner's only job is to turn a sentence into a *proposal*. It is not
// trusted with anything else:
//
//   * Its output is validated against a zod schema. Malformed output is
//     discarded and the turn falls through to ordinary chat — never executed.
//   * It never chooses device ids. It describes targets in the user's own terms
//     ("the phones", "except the laptop") and the deterministic resolver maps
//     that onto the real registry.
//   * A cheap heuristic gate runs first, so ordinary conversation costs zero
//     extra LLM calls. This matters on Gemini's free tier, where every turn
//     already spends one call on the reply and one on memory extraction.
//
// Provider-neutral by construction: it takes an LlmBackend, so Gemini, local
// transformers, or any future backend work unchanged.

import { z } from 'zod';
import type { ChatMessage, LlmBackend } from '../llm/types.js';
import { logger } from '../logger.js';
import { capabilityNames, listCapabilities } from './capabilities.js';
import { extractFirstJsonObject } from '../brain/memoryExtraction.js';

export type PlanKind =
  | 'chat'
  | 'device_query'
  | 'device_command'
  | 'correction'
  | 'retry'
  | 'cancel'
  | 'command_status'
  | 'confirmation_response'
  | 'workflow_run'
  | 'ambiguous';

export type DeviceQueryKind =
  | 'count'
  | 'online'
  | 'list'
  | 'battery'
  | 'status'
  | 'failed'
  | 'capabilities';

const targetSchema = z
  .object({
    includeDeviceNames: z.array(z.string().min(1).max(80)).max(20).optional(),
    includeGroups: z.array(z.string().min(1).max(60)).max(10).optional(),
    excludeDeviceNames: z.array(z.string().min(1).max(80)).max(20).optional(),
    excludeGroups: z.array(z.string().min(1).max(60)).max(10).optional(),
    primaryOnly: z.boolean().optional(),
    thisDevice: z.boolean().optional(),
    sameAsPrevious: z.boolean().optional(),
    failedOnly: z.boolean().optional(),
    onlineOnly: z.boolean().optional(),
  })
  .strict();

const planSchema = z
  .object({
    kind: z.enum([
      'chat',
      'device_query',
      'device_command',
      'correction',
      'retry',
      'cancel',
      'command_status',
      'confirmation_response',
      'workflow_run',
      'ambiguous',
    ]),
    action: z.string().max(64).optional(),
    parameters: z.record(z.unknown()).optional(),
    target: targetSchema.optional(),
    queueIfOffline: z.boolean().optional(),
    query: z
      .enum(['count', 'online', 'list', 'battery', 'status', 'failed', 'capabilities'])
      .optional(),
    workflowName: z.string().max(80).optional(),
    confirm: z.boolean().optional(),
    /** Only used for `ambiguous`: the single question to ask. */
    question: z.string().max(300).optional(),
  })
  .strip();

export type DevicePlan = z.infer<typeof planSchema>;

/** What the planner is allowed to see about the user's world. */
export interface PlannerContext {
  devices: { name: string; type: string; online: boolean; isPrimary: boolean }[];
  groups: string[];
  workflows: string[];
  /** Summary of the most recent command in this conversation, if any. */
  lastCommand?: {
    capability: string;
    requestText: string;
    targets: string[];
    failedTargets: string[];
    status: string;
  } | null;
  hasPendingConfirmation: boolean;
}

// ---------------------------------------------------------------------------
// Heuristic gate
// ---------------------------------------------------------------------------

const DEVICE_WORDS = [
  'device',
  'devices',
  'phone',
  'phones',
  'tablet',
  'tablets',
  'laptop',
  'laptops',
  'computer',
  'computers',
  'desktop',
  'pc',
  'browser',
];

const ACTION_WORDS = [
  'open',
  'launch',
  'start',
  'play',
  'pause',
  'resume',
  'skip',
  'next track',
  'previous',
  'mute',
  'unmute',
  'volume',
  'battery',
  'notify',
  'notification',
  'wake',
  'ping',
  'status',
  'online',
  'offline',
  'connected',
  'retry',
  'cancel',
  'again',
];

const CONTROL_WORDS = [
  'not on',
  'instead',
  'except',
  'only on',
  'same as',
  'same thing',
  'do it on',
  'the other',
  'that failed',
  'which failed',
];

const CONFIRM_YES = /^(yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|confirm(ed)?|please do)\b/i;
const CONFIRM_NO = /^(no|nope|nah|don'?t|stop|cancel|never ?mind|abort)\b/i;

/**
 * An imperative opening is the clearest signal that a message is a command
 * rather than conversation. "Open YouTube." has no device word in it at all, but
 * it is plainly an instruction — provided the user actually has devices.
 */
const IMPERATIVE_OPENING =
  /^(open|launch|start|run|play|pause|resume|skip|mute|unmute|wake|ping|show|turn|set|cancel|retry)\b/i;

/** Whole-word match, so "called" does not match the group "all". */
function mentionsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

/**
 * Decide whether a turn is worth planning. Returns a fast deterministic plan
 * when one is obvious (a yes/no answer to a pending confirmation), `null` when
 * the turn is plainly ordinary chat, and 'plan' when the LLM should look at it.
 */
export function triageMessage(
  text: string,
  context: PlannerContext,
): { decision: 'skip' } | { decision: 'plan' } | { decision: 'immediate'; plan: DevicePlan } {
  const lower = text.toLowerCase().trim();

  // A pending confirmation makes bare yes/no unambiguous — no model needed.
  if (context.hasPendingConfirmation) {
    if (CONFIRM_YES.test(lower)) {
      return { decision: 'immediate', plan: { kind: 'confirmation_response', confirm: true } };
    }
    if (CONFIRM_NO.test(lower)) {
      return { decision: 'immediate', plan: { kind: 'confirmation_response', confirm: false } };
    }
  }

  const hasDevices = context.devices.length > 0;
  const mentionsDeviceName = context.devices.some((d) =>
    mentionsWord(lower, d.name.toLowerCase()),
  );
  const mentionsGroup = context.groups.some((g) => mentionsWord(lower, g.replace(/-/g, ' ')));
  const mentionsWorkflow = context.workflows.some((w) => mentionsWord(lower, w.toLowerCase()));
  const hasDeviceWord = DEVICE_WORDS.some((w) => mentionsWord(lower, w));
  const hasActionWord = ACTION_WORDS.some((w) => lower.includes(w));
  const hasControlWord = CONTROL_WORDS.some((w) => lower.includes(w));

  // A correction only makes sense if there is something to correct.
  const correctionLikely = Boolean(context.lastCommand) && hasControlWord;

  if (
    mentionsDeviceName ||
    mentionsGroup ||
    mentionsWorkflow ||
    correctionLikely ||
    (hasDeviceWord && hasActionWord) ||
    (hasDeviceWord && /how many|which|list|show/.test(lower)) ||
    // "Open YouTube." names no device, but it is unmistakably an instruction.
    // Only worth a planner call if there is something to command.
    (hasDevices && IMPERATIVE_OPENING.test(lower))
  ) {
    return { decision: 'plan' };
  }

  return { decision: 'skip' };
}

// ---------------------------------------------------------------------------
// LLM planning
// ---------------------------------------------------------------------------

function buildSystemPrompt(context: PlannerContext): string {
  const deviceLines =
    context.devices.length > 0
      ? context.devices
          .map(
            (d) =>
              `- ${d.name} (${d.type}, ${d.online ? 'online' : 'offline'}${d.isPrimary ? ', primary' : ''})`,
          )
          .join('\n')
      : '- (no devices paired)';

  const capabilityLines = listCapabilities()
    .map((c) => `- ${c.name}: ${c.description}`)
    .join('\n');

  const last = context.lastCommand
    ? `Most recent command in this conversation:
- action: ${context.lastCommand.capability}
- user said: "${context.lastCommand.requestText}"
- targets: ${context.lastCommand.targets.join(', ') || 'none'}
- targets that failed or were offline: ${context.lastCommand.failedTargets.join(', ') || 'none'}
- status: ${context.lastCommand.status}`
    : 'There is no recent command in this conversation.';

  return `You classify a user's message for a multi-device assistant and output ONE JSON object, nothing else.

The user's devices:
${deviceLines}

Device groups they can name: ${context.groups.join(', ') || '(none)'}
Saved workflows: ${context.workflows.join(', ') || '(none)'}

Available actions:
${capabilityLines}

${last}

Output exactly one JSON object with a "kind" field, one of:
- "chat": ordinary conversation, nothing to do with devices.
- "device_query": they are ASKING about devices, not commanding. Set "query" to one of count, online, list, battery, status, failed, capabilities.
- "device_command": a NEW action on devices. Set "action" to an action name from the list, "parameters" for that action, and "target".
- "correction": they are changing the TARGETS of the most recent command ("not on the laptop, on the phones"). Set "target" only — keep the same action.
- "retry": rerun the most recent command on whatever failed.
- "cancel": cancel the pending or most recent command.
- "command_status": asking how the most recent command went.
- "confirmation_response": answering a confirmation. Set "confirm" true or false.
- "workflow_run": run a saved workflow. Set "workflowName".
- "ambiguous": you genuinely cannot tell which device or action they mean. Set "question" to ONE short clarifying question.

The "target" object may contain:
- "includeDeviceNames": device names exactly as listed above
- "includeGroups": group names, or one of: phones, tablets, computers, browsers, all
- "excludeDeviceNames", "excludeGroups": things to leave out ("every device except my laptop")
- "primaryOnly": true for "my primary/main device"
- "thisDevice": true for "this device", "here"
- "sameAsPrevious": true for "the same devices as before"
- "failedOnly": true for "only the one that failed"
- "onlineOnly": true for "all online devices"

Set "queueIfOffline": true only if they explicitly want it to happen later, when a device reconnects.

Rules:
- Use ONLY device names that appear in the list above. Never invent a device.
- Use ONLY action names from the list above. If the request needs an action that is not listed, use "chat".
- For app.open, "parameters" is {"appId": "<lowercase app name>"}. For url.open it is {"url": "<absolute https URL>"}.
- If the user is just chatting, use {"kind":"chat"}. Do not force a device interpretation.

Examples of FORMAT only — do not copy these device names:
Message: "how many devices are connected?"
Output: {"kind":"device_query","query":"count"}

Message: "open youtube on all my phones"
Output: {"kind":"device_command","action":"app.open","parameters":{"appId":"youtube"},"target":{"includeGroups":["phones"]}}

Message: "not on the laptop. only on the phones."
Output: {"kind":"correction","target":{"includeGroups":["phones"],"excludeDeviceNames":["laptop"]}}

Message: "mute every device except my main computer"
Output: {"kind":"device_command","action":"volume.mute","parameters":{},"target":{"includeGroups":["all"],"excludeDeviceNames":["main computer"]}}

Message: "retry only on the device that failed"
Output: {"kind":"retry"}

Message: "thanks, that's great"
Output: {"kind":"chat"}`;
}

/**
 * Ask the LLM to classify a turn. Any failure — network, malformed JSON, schema
 * mismatch — degrades to ordinary chat rather than guessing at a device action.
 */
export async function planDeviceIntent(
  llm: LlmBackend,
  context: PlannerContext,
  userMessage: string,
): Promise<DevicePlan> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(context) },
    { role: 'user', content: userMessage },
  ];

  let raw: string;
  try {
    raw = await llm.generateOnce(messages, { maxNewTokens: 300, temperature: 0 });
  } catch (err) {
    logger.warn({ err }, 'device planner LLM call failed — treating as chat');
    return { kind: 'chat' };
  }

  const json = extractFirstJsonObject(raw);
  if (!json) {
    logger.warn({ raw: raw.slice(0, 200) }, 'device planner returned no JSON object');
    return { kind: 'chat' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return { kind: 'chat' };
  }

  const parsed = planSchema.safeParse(parsedJson);
  if (!parsed.success) {
    logger.warn(
      { issue: parsed.error.errors[0]?.message },
      'device planner output failed validation — treating as chat',
    );
    return { kind: 'chat' };
  }

  const plan = parsed.data;

  // A command with an action we do not have is not executable. Fall back to
  // chat rather than sending something the registry would reject anyway.
  if (
    (plan.kind === 'device_command' || plan.kind === 'correction') &&
    plan.action &&
    !capabilityNames().includes(plan.action)
  ) {
    logger.warn({ action: plan.action }, 'planner proposed an unknown action');
    return { kind: 'chat' };
  }
  if (plan.kind === 'device_command' && !plan.action) {
    return { kind: 'chat' };
  }

  return plan;
}
