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
Return only a valid unified git diff beginning with "diff --git". Do not use markdown fences.

Hard rules:
- Change at most 8 files and keep the patch under 100,000 characters.
- You may edit TypeScript under src/brain, src/http, src/llm, or src/util; browser JS/CSS/HTML under public; TypeScript scripts; tests; and README.md.
- Never edit authentication, dependencies, lockfiles, environment files, Vercel config, GitHub config, database migrations, capability safety code, or this self-improvement workflow.
- Do not delete, rename, chmod, or add binary files.
- Any executable change must include a focused regression test under tests/*.test.ts.
- Use only existing dependencies and interfaces shown in the supplied context.
- Keep the change narrowly scoped to the requested goal.
- The patch must pass npm test and npm run build.
- Do not claim that tests passed; the host will run them independently in a network-denied sandbox.`;

export async function generateImprovementPatch(
  task: string,
  context: string,
  llm: LlmBackend = getLlmBackend(),
  repairFeedback?: string,
): Promise<string> {
  const repair = repairFeedback
    ? `\n\nThe prior proposal was rejected. Produce a corrected complete patch.\nValidation output:\n${repairFeedback.slice(0, 8_000)}`
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
  const patch = extractImprovementPatch(raw);
  validateImprovementPatch(patch);
  return patch;
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

async function reverseAppliedPatch(sandbox: Sandbox): Promise<void> {
  await requireCommand(
    sandbox,
    'git',
    ['apply', '--reverse', '--index', '/tmp/agi-improvement.patch'],
    'Reverting rejected patch',
  );
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
      let applied = false;
      try {
        const patch = await generateImprovementPatch(task, context, llm, repairFeedback);
        await sandbox.writeFiles([{
          path: '/tmp/agi-improvement.patch',
          content: Buffer.from(patch),
        }]);
        await requireCommand(
          sandbox,
          'git',
          ['apply', '--check', '--index', '/tmp/agi-improvement.patch'],
          'Patch validation',
        );
        await requireCommand(
          sandbox,
          'git',
          ['apply', '--index', '/tmp/agi-improvement.patch'],
          'Patch application',
        );
        applied = true;
        await requireCommand(sandbox, 'git', ['diff', '--cached', '--check'], 'Git whitespace validation');
        const changedOutput = await requireCommand(
          sandbox,
          'git',
          ['diff', '--cached', '--name-only'],
          'Changed-file inspection',
        );
        const changedPaths = changedOutput.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        const declaredPaths = validateImprovementPatch(patch);
        if (changedPaths.join('\n') !== [...declaredPaths].sort().join('\n')) {
          throw new Error('Applied patch paths do not match the validated patch manifest');
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
        if (applied) await reverseAppliedPatch(sandbox);
        repairFeedback = lastError.message;
      }
    }
    throw lastError ?? new Error('Self-improvement validation failed');
  } finally {
    await sandbox.stop().catch(() => undefined);
  }
}
