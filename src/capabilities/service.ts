import type { Storage } from '../storage/index.js';
import { assertCapabilityAdmin, getCapabilityGitHubConfig } from './config.js';
import { assertSafeCapabilityCode, generateCapabilityDraft } from './draft.js';
import { fetchMergedCapabilityCode, publishCapabilityDraft } from './github.js';
import {
  executeCapabilityCodeInSandbox,
  validateAndExecuteInSandbox,
} from './sandbox.js';

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

export interface CapabilityBuildResult {
  requestId: string;
  slug: string;
  summary: string;
  sampleOutput: string;
  branch: string;
  prUrl: string;
}

export async function buildCapability(
  storage: Storage,
  userId: string,
  task: string,
): Promise<CapabilityBuildResult> {
  assertCapabilityAdmin(userId);
  // Fail before model and sandbox work if the least-privilege publisher is absent.
  getCapabilityGitHubConfig();
  const request = await storage.capabilityRequests.create(userId, task);
  try {
    await storage.capabilityRequests.update(request.id, { status: 'generating' });
    let draft = await generateCapabilityDraft(task);
    await storage.capabilityRequests.update(request.id, {
      status: 'validating',
      slug: draft.slug,
    });
    let sandbox = await validateAndExecuteInSandbox(draft);
    if (!sandbox.passed) {
      await storage.capabilityRequests.update(request.id, { status: 'generating' });
      draft = await generateCapabilityDraft(task, undefined, sandbox.testOutput);
      await storage.capabilityRequests.update(request.id, {
        status: 'validating',
        slug: draft.slug,
      });
      sandbox = await validateAndExecuteInSandbox(draft);
    }
    const sandboxSummary = [sandbox.testOutput, `Sample output: ${sandbox.sampleOutput}`]
      .filter(Boolean)
      .join('\n');
    if (!sandbox.passed) {
      throw new Error(`Generated capability failed sandbox validation:\n${sandbox.testOutput}`);
    }
    const published = await publishCapabilityDraft(
      draft,
      task,
      request.id,
      sandboxSummary,
    );
    await storage.capabilityRequests.update(request.id, {
      status: 'pr_opened',
      slug: draft.slug,
      branchName: published.branch,
      prUrl: published.prUrl,
      sandboxSummary,
    });
    return {
      requestId: request.id,
      slug: draft.slug,
      summary: draft.summary,
      sampleOutput: sandbox.sampleOutput,
      branch: published.branch,
      prUrl: published.prUrl,
    };
  } catch (error) {
    try {
      await storage.capabilityRequests.update(request.id, {
        status: 'failed',
        error: errorMessage(error),
      });
    } catch {
      // Preserve the original build error if audit persistence also fails.
    }
    throw error;
  }
}

export async function runMergedCapability(
  userId: string,
  slug: string,
  input: unknown,
): Promise<string> {
  assertCapabilityAdmin(userId);
  const code = await fetchMergedCapabilityCode(slug);
  assertSafeCapabilityCode(code);
  const result = await executeCapabilityCodeInSandbox(code, input);
  if (!result.passed) throw new Error(`Capability execution failed:\n${result.output}`);
  return result.output;
}
