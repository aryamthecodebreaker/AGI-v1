import { Sandbox } from '@vercel/sandbox';
import { z } from 'zod';
import { getLlmBackend } from '../llm/registry.js';
import type { ChatMessage, LlmBackend } from '../llm/types.js';
import { capabilityRepository } from './config.js';

const OUTPUT_LIMIT = 16_000;
const PATCH_LIMIT = 100_000;
const CONTEXT_LIMIT = 90_000;
const FILE_CONTEXT_LIMIT = 20_000;
const MAX_CHANGED_FILES = 8;
const MAX_REPLACEMENTS_PER_FILE = 20;
const REPOSITORY_ROOT = '/vercel/sandbox';
const PROTECTED_IMPROVEMENT_PATHS = new Set([
  'src/http/routes/auth.ts',
  'src/http/routes/chat.ts',
  'src/http/server.ts',
]);

const fixMapReportSchema = z.object({
  summary: z.string().optional(),
  contextFiles: z.array(z.object({
    path: z.string(),
    score: z.number().optional(),
    confidence: z.string().optional(),
    reasons: z.array(z.string()).optional(),
  }).passthrough()),
  testRoutes: z.array(z.object({ command: z.string() }).passthrough()).optional(),
  risks: z.array(z.object({
    area: z.string(),
    severity: z.string(),
    reason: z.string(),
  }).passthrough()).optional(),
}).passthrough();

const textReplacementSchema = z.object({
  oldText: z.string().min(1).max(FILE_CONTEXT_LIMIT),
  newText: z.string().max(PATCH_LIMIT),
}).strict();

const existingFileChangeSchema = z.object({
  path: z.string().min(1).max(180),
  replacements: z.array(textReplacementSchema).min(1).max(MAX_REPLACEMENTS_PER_FILE),
}).strict();

const newFileChangeSchema = z.object({
  path: z.string().min(1).max(180),
  content: z.string().min(1).max(PATCH_LIMIT),
}).strict();

const improvementProposalSchema = z.object({
  changes: z.array(z.union([existingFileChangeSchema, newFileChangeSchema]))
    .min(1)
    .max(MAX_CHANGED_FILES),
}).strict();

export type ImprovementProposalChange = z.infer<typeof improvementProposalSchema>['changes'][number];

export interface SourceChange {
  path: string;
  content: string;
}

export interface SourceImprovementResult {
  changes: SourceChange[];
  baseSha: string;
  contextPaths: string[];
  fixMapSummary: string;
  testOutput: string;
  buildOutput: string;
}

function firstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index++) {
    const char = raw[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return raw.slice(start, index + 1);
  }
  return null;
}

function bounded(value: string): string {
  return value.length <= OUTPUT_LIMIT
    ? value
    : `${value.slice(0, OUTPUT_LIMIT)}\n[output truncated]`;
}

function safeContextPath(path: string): boolean {
  return path.length <= 180
    && !path.startsWith('/')
    && !path.includes('\\')
    && !path.split('/').includes('..')
    && /^[a-zA-Z0-9._/-]+$/.test(path);
}

function allowedImprovementPath(path: string): boolean {
  if (!safeContextPath(path)) return false;
  if (path === 'README.md') return true;
  if (/^tests\/[a-zA-Z0-9._/-]+\.test\.ts$/.test(path)) return true;
  if (/^public\/[a-zA-Z0-9._/-]+\.(?:js|css|html)$/.test(path)) return true;
  if (/^scripts\/[a-zA-Z0-9._/-]+\.ts$/.test(path)) return true;
  if (!/^src\/(?:brain|http|llm|util)\/[a-zA-Z0-9._/-]+\.ts$/.test(path)) return false;

  // The assistant may improve its brain, chat flow, and UI, but it cannot rewrite
  // authentication, publishing, sandbox, or self-improvement guardrails.
  return !PROTECTED_IMPROVEMENT_PATHS.has(path);
}

export function validateImprovementProposal(value: unknown): ImprovementProposalChange[] {
  const proposal = improvementProposalSchema.parse(value);
  const paths = proposal.changes.map((change) => change.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error('Self-improvement proposal contains duplicate file paths');
  }
  for (const path of paths) {
    if (!allowedImprovementPath(path)) {
      throw new Error(`Self-improvement proposal targets protected or unsupported path: ${path}`);
    }
  }

  const proposalSize = proposal.changes.reduce((total, change) => {
    if ('content' in change) return total + change.content.length;
    return total + change.replacements.reduce(
      (fileTotal, replacement) => fileTotal + replacement.oldText.length + replacement.newText.length,
      0,
    );
  }, 0);
  if (proposalSize > PATCH_LIMIT) {
    throw new Error(`Self-improvement proposal must be at most ${PATCH_LIMIT} characters`);
  }

  const executableChange = paths.some((path) => /^(?:src|public|scripts)\//.test(path));
  if (executableChange && !paths.some((path) => path.startsWith('tests/'))) {
    throw new Error('Executable self-improvements must include a regression test under tests/');
  }
  return proposal.changes;
}

export function applyImprovementReplacements(
  original: string,
  replacements: Array<{ oldText: string; newText: string }>,
): string {
  let content = original;
  for (const replacement of replacements) {
    const first = content.indexOf(replacement.oldText);
    if (first < 0) {
      throw new Error('A proposed oldText block was not found in the current file');
    }
    if (content.indexOf(replacement.oldText, first + replacement.oldText.length) >= 0) {
      throw new Error('A proposed oldText block is ambiguous because it appears more than once');
    }
    content = `${content.slice(0, first)}${replacement.newText}${content.slice(first + replacement.oldText.length)}`;
  }
  if (content === original) throw new Error('The structured edit does not change the file');
  return content;
}

export function extractImprovementPatch(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  const start = normalized.indexOf('diff --git ');
  if (start < 0) throw new Error('The model did not return a unified git patch');
  let patch = normalized.slice(start);
  const fence = patch.lastIndexOf('\n```');
  if (fence >= 0) patch = patch.slice(0, fence);
  return patch.endsWith('\n') ? patch : `${patch}\n`;
}

export function validateImprovementPatch(patch: string): string[] {
  if (!patch || patch.length > PATCH_LIMIT) {
    throw new Error(`Self-improvement patch must be between 1 and ${PATCH_LIMIT} characters`);
  }
  if (/^(?:deleted file mode|rename from|rename to|old mode|new mode|GIT binary patch|Binary files)/m.test(patch)) {
    throw new Error('Self-improvement patches cannot delete, rename, chmod, or add binary files');
  }
  if (/^\+\+\+ \/dev\/null$/m.test(patch)) {
    throw new Error('Self-improvement patches cannot delete files');
  }

  const matches = Array.from(patch.matchAll(/^diff --git a\/([^\s]+) b\/([^\s]+)$/gm));
  if (matches.length === 0 || matches.length > MAX_CHANGED_FILES) {
    throw new Error(`Self-improvement patches must change 1-${MAX_CHANGED_FILES} files`);
  }

  const paths = matches.map((match) => {
    const before = match[1]!;
    const after = match[2]!;
    if (before !== after) throw new Error('Self-improvement patches cannot rename files');
    if (!allowedImprovementPath(after)) {
      throw new Error(`Self-improvement patch targets protected or unsupported path: ${after}`);
    }
    return after;
  });
  if (new Set(paths).size !== paths.length) {
    throw new Error('Self-improvement patch contains duplicate file sections');
  }

  const executableChange = paths.some((path) => /^(?:src|public|scripts)\//.test(path));
  if (executableChange && !paths.some((path) => path.startsWith('tests/'))) {
    throw new Error('Executable self-improvements must include a regression test under tests/');
  }
  return paths;
}

const generationPrompt = `You are proposing a small, reviewable improvement to AGI-v1 itself.
Return exactly one JSON object with a changes array. Do not use markdown fences or text outside the JSON object.

Each array item must use exactly one of these forms:
- Existing file: {"path":"README.md","replacements":[{"oldText":"exact unique text from context","newText":"replacement text"}]}
- New file: {"path":"tests/example.test.ts","content":"complete new file content"}

Hard rules:
- Change at most 8 files and keep all proposed text under 100,000 characters.
- You may edit TypeScript under src/brain, src/http, src/llm, or src/util; browser JS/CSS/HTML under public; TypeScript scripts; tests; and README.md.
- Never edit authentication, dependencies, lockfiles, environment files, Vercel config, GitHub config, database migrations, capability safety code, or this self-improvement workflow.
- Do not delete, rename, chmod, or add binary files.
- Any executable change must include a focused regression test under tests/*.test.ts.
- For existing files, oldText must be copied exactly from the supplied context and occur exactly once. Use multiple replacements for separate edits.
- Use content only for genuinely new files. Never return the complete contents of an existing file.
- Use only existing dependencies and interfaces shown in the supplied context.
- Keep the change narrowly scoped to the requested goal.
- The resulting change must pass npm test and npm run build.
- Do not claim that tests passed; the host will run them independently in a network-denied sandbox.`;

export async function generateImprovementProposal(
  task: string,
  context: string,
  llm: LlmBackend = getLlmBackend(),
  repairFeedback?: string,
): Promise<ImprovementProposalChange[]> {
  const repair = repairFeedback
    ? `\n\nThe prior proposal was rejected. Produce a corrected complete JSON proposal.\nValidation output:\n${repairFeedback.slice(0, 8_000)}`
    : '';
  const messages: ChatMessage[] = [
    { role: 'system', content: generationPrompt },
    {
      role: 'user',
      content: `Improvement goal:\n${task}\n\nFixMap-ranked repository context:\n${context}${repair}`,
    },
  ];
  await llm.ready();
  const raw = await llm.generateOnce(messages, { maxNewTokens: 6_000, temperature: 0.1 });
  const json = firstJsonObject(raw);
  if (!json) throw new Error('The model did not return a JSON self-improvement proposal');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('The model returned invalid JSON for the self-improvement proposal');
  }
  return validateImprovementProposal(parsed);
}

async function commandText(command: Awaited<ReturnType<Sandbox['runCommand']>>): Promise<string> {
  return bounded(`${await command.stdout()}${await command.stderr()}`);
}

async function requireCommand(
  sandbox: Sandbox,
  cmd: string,
  args: string[],
  label: string,
): Promise<string> {
  const result = await sandbox.runCommand({ cmd, args, cwd: REPOSITORY_ROOT });
  const output = await commandText(result);
  if (result.exitCode !== 0) throw new Error(`${label} failed:\n${output}`);
  return output;
}

async function readContext(sandbox: Sandbox, paths: string[]): Promise<string> {
  const uniquePaths = Array.from(new Set(['package.json', ...paths])).filter(safeContextPath);
  const sections: string[] = [];
  let remaining = CONTEXT_LIMIT;
  for (const path of uniquePaths) {
    if (remaining <= 0) break;
    const buffer = await sandbox.readFileToBuffer({ path, cwd: REPOSITORY_ROOT });
    if (!buffer || buffer.includes(0)) continue;
    const content = buffer.toString('utf8').slice(0, Math.min(FILE_CONTEXT_LIMIT, remaining));
    sections.push(`\n===== ${path} =====\n${content}`);
    remaining -= content.length;
  }
  return sections.join('');
}

async function resetRejectedProposal(sandbox: Sandbox): Promise<void> {
  await requireCommand(
    sandbox,
    'git',
    ['reset', '--hard', 'HEAD'],
    'Resetting rejected proposal',
  );
  await requireCommand(sandbox, 'git', ['clean', '-fd'], 'Cleaning rejected proposal files');
}

async function materializeProposal(
  sandbox: Sandbox,
  proposal: ImprovementProposalChange[],
): Promise<void> {
  const files: Array<{ path: string; content: Buffer }> = [];
  for (const change of proposal) {
    let content: string;
    if ('content' in change) {
      const tracked = await sandbox.runCommand({
        cmd: 'git',
        args: ['ls-files', '--error-unmatch', '--', change.path],
        cwd: REPOSITORY_ROOT,
      });
      if (tracked.exitCode === 0) {
        throw new Error(`New-file proposal targets an existing file: ${change.path}`);
      }
      content = change.content;
    } else {
      const buffer = await sandbox.readFileToBuffer({ path: change.path, cwd: REPOSITORY_ROOT });
      if (!buffer || buffer.includes(0)) {
        throw new Error(`Existing-file proposal target is missing or binary: ${change.path}`);
      }
      content = applyImprovementReplacements(buffer.toString('utf8'), change.replacements);
    }
    files.push({
      path: `${REPOSITORY_ROOT}/${change.path}`,
      content: Buffer.from(content),
    });
  }
  await sandbox.writeFiles(files);
}

export async function generateAndValidateSourceImprovement(
  task: string,
  llm: LlmBackend = getLlmBackend(),
): Promise<SourceImprovementResult> {
  const sandbox = await Sandbox.create({
    runtime: 'node24',
    source: {
      type: 'git',
      url: `https://github.com/${capabilityRepository()}.git`,
      revision: 'main',
      depth: 1,
    },
    resources: { vcpus: 2 },
    timeout: 270_000,
    networkPolicy: 'allow-all',
    persistent: false,
    tags: { purpose: 'agi-source-improvement' },
  });

  try {
    // Only the already-reviewed main branch installs packages with network access.
    // No credentials are injected. Generated code is written only after deny-all.
    await requireCommand(
      sandbox,
      'npm',
      ['ci', '--include=dev'],
      'Trusted dependency installation',
    );
    await sandbox.update({ networkPolicy: 'deny-all' });
    const baseSha = (await requireCommand(
      sandbox,
      'git',
      ['rev-parse', 'HEAD'],
      'Base revision inspection',
    )).trim();
    if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error('Sandbox returned an invalid base revision');

    await requireCommand(
      sandbox,
      './node_modules/.bin/fixmap',
      ['plan', '--issue', task, '--repo', '.', '--format', 'json', '--output', '/tmp/agi-fixmap.json'],
      'FixMap repository analysis',
    );
    const reportBuffer = await sandbox.readFileToBuffer({ path: '/tmp/agi-fixmap.json' });
    if (!reportBuffer) throw new Error('FixMap did not produce a repository report');
    const report = fixMapReportSchema.parse(JSON.parse(reportBuffer.toString('utf8')));
    const contextPaths = report.contextFiles
      .map((file) => file.path)
      .filter(safeContextPath)
      .slice(0, 8);
    const context = await readContext(sandbox, contextPaths);
    if (!context.trim()) throw new Error('FixMap did not identify readable repository context');

    let repairFeedback: string | undefined;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let proposalStarted = false;
      try {
        const proposal = await generateImprovementProposal(task, context, llm, repairFeedback);
        const declaredPaths = proposal.map((change) => change.path).sort();
        proposalStarted = true;
        await materializeProposal(sandbox, proposal);
        await requireCommand(
          sandbox,
          'git',
          ['add', '--', ...declaredPaths],
          'Staging structured proposal',
        );
        await requireCommand(sandbox, 'git', ['diff', '--cached', '--check'], 'Git whitespace validation');
        const changedOutput = await requireCommand(
          sandbox,
          'git',
          ['diff', '--cached', '--name-only'],
          'Changed-file inspection',
        );
        const changedPaths = changedOutput.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        if (changedPaths.join('\n') !== declaredPaths.join('\n')) {
          throw new Error('Materialized paths do not match the validated structured proposal');
        }

        const diff = await sandbox.runCommand({
          cmd: 'git',
          args: ['diff', '--cached', '--no-ext-diff'],
          cwd: REPOSITORY_ROOT,
        });
        const actualPatch = await diff.stdout();
        const diffError = await diff.stderr();
        if (diff.exitCode !== 0) throw new Error(`Generated diff inspection failed:\n${bounded(diffError)}`);
        const patchPaths = validateImprovementPatch(actualPatch).sort();
        if (patchPaths.join('\n') !== declaredPaths.join('\n')) {
          throw new Error('Generated Git diff paths do not match the structured proposal');
        }

        const testOutput = await requireCommand(sandbox, 'npm', ['test'], 'Regression tests');
        const buildOutput = await requireCommand(sandbox, 'npm', ['run', 'build'], 'TypeScript build');
        const changes: SourceChange[] = [];
        for (const path of changedPaths) {
          const buffer = await sandbox.readFileToBuffer({ path, cwd: REPOSITORY_ROOT });
          if (!buffer || buffer.includes(0)) throw new Error(`Changed file is missing or binary: ${path}`);
          changes.push({ path, content: buffer.toString('utf8') });
        }
        return {
          changes,
          baseSha,
          contextPaths,
          fixMapSummary: report.summary ?? `FixMap selected ${contextPaths.length} context files.`,
          testOutput,
          buildOutput,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === 1) break;
        if (proposalStarted) await resetRejectedProposal(sandbox);
        repairFeedback = lastError.message;
      }
    }
    throw lastError ?? new Error('Self-improvement validation failed');
  } finally {
    await sandbox.stop().catch(() => undefined);
  }
}
