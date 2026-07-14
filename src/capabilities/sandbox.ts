import { Sandbox } from '@vercel/sandbox';
import type { CapabilityDraft } from './draft.js';

const OUTPUT_LIMIT = 12_000;
const runnerCode = `import fs from 'node:fs/promises';
import { run } from './tool.mjs';
const input = JSON.parse(await fs.readFile('./input.json', 'utf8'));
const output = await run(input);
process.stdout.write(JSON.stringify(output));
`;

export interface CapabilitySandboxResult {
  passed: boolean;
  testOutput: string;
  sampleOutput: string;
}

export interface CapabilityExecutionResult {
  passed: boolean;
  output: string;
}

function bounded(value: string): string {
  return value.length <= OUTPUT_LIMIT ? value : `${value.slice(0, OUTPUT_LIMIT)}\n[output truncated]`;
}

export async function validateAndExecuteInSandbox(
  draft: CapabilityDraft,
  input: unknown = draft.sampleInput,
): Promise<CapabilitySandboxResult> {
  const sandbox = await Sandbox.create({
    runtime: 'node24',
    resources: { vcpus: 1 },
    timeout: 60_000,
    networkPolicy: 'deny-all',
    persistent: false,
    tags: { purpose: 'agi-capability-validation' },
  });

  try {
    await sandbox.writeFiles([
      { path: 'tool.mjs', content: Buffer.from(draft.toolCode) },
      { path: 'tool.test.mjs', content: Buffer.from(draft.testCode) },
      { path: 'runner.mjs', content: Buffer.from(runnerCode) },
      { path: 'input.json', content: Buffer.from(JSON.stringify(input)) },
    ]);

    const syntax = await sandbox.runCommand('node', ['--check', 'tool.mjs']);
    const syntaxOutput = bounded(`${await syntax.stdout()}${await syntax.stderr()}`);
    if (syntax.exitCode !== 0) {
      return { passed: false, testOutput: syntaxOutput, sampleOutput: '' };
    }

    const tests = await sandbox.runCommand('node', ['--test', 'tool.test.mjs']);
    const testOutput = bounded(`${await tests.stdout()}${await tests.stderr()}`);
    if (tests.exitCode !== 0) {
      return { passed: false, testOutput, sampleOutput: '' };
    }

    const execution = await sandbox.runCommand('node', ['runner.mjs']);
    const sampleOutput = bounded(`${await execution.stdout()}${await execution.stderr()}`);
    return { passed: execution.exitCode === 0, testOutput, sampleOutput };
  } finally {
    await sandbox.stop().catch(() => undefined);
  }
}

export async function executeCapabilityCodeInSandbox(
  toolCode: string,
  input: unknown,
): Promise<CapabilityExecutionResult> {
  const sandbox = await Sandbox.create({
    runtime: 'node24',
    resources: { vcpus: 1 },
    timeout: 30_000,
    networkPolicy: 'deny-all',
    persistent: false,
    tags: { purpose: 'agi-capability-execution' },
  });
  try {
    await sandbox.writeFiles([
      { path: 'tool.mjs', content: Buffer.from(toolCode) },
      { path: 'runner.mjs', content: Buffer.from(runnerCode) },
      { path: 'input.json', content: Buffer.from(JSON.stringify(input)) },
    ]);
    const execution = await sandbox.runCommand('node', ['runner.mjs']);
    return {
      passed: execution.exitCode === 0,
      output: bounded(`${await execution.stdout()}${await execution.stderr()}`),
    };
  } finally {
    await sandbox.stop().catch(() => undefined);
  }
}
