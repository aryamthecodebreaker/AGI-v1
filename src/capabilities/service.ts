import type { Storage } from '../storage/index.js';
import type { CapabilityRequestRow } from '../storage/repositories/capabilityRequestRepo.js';
import { Errors } from '../util/errors.js';
import { assertCapabilityEnabled, getCapabilityGitHubConfig } from './config.js';
import {
  assertSafeCapabilityCode,
  type CapabilityReview,
  generateCapabilityDraft,
  generateCapabilityReview,
} from './draft.js';
import { fetchMergedCapabilityCode, publishCapabilityDraft } from './github.js';
import { publishSourceImprovement } from './github.js';
import { generateAndValidateSourceImprovement } from './improvement.js';
import {
  executeCapabilityCodeInSandbox,
  validateAndExecuteInSandbox,
} from './sandbox.js';

const CREATION_WINDOW_MS = 60 * 60 * 1_000;
const MAX_CREATIONS_PER_WINDOW = 2;
const ACTIVE_REQUEST_TIMEOUT_MS = 15 * 60 * 1_000;
const ACTIVE_STATUSES = new Set(['pending', 'generating', 'validating']);
const MAX_CAPABILITY_VALIDATION_ATTEMPTS = 3;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

export function assertCapabilityCreationQuota(
  requests: CapabilityRequestRow[],
  currentTime = Date.now(),
): void {
  const activeCutoff = currentTime - ACTIVE_REQUEST_TIMEOUT_MS;
  const hasActiveRequest = requests.some((request) =>
    ACTIVE_STATUSES.has(request.status) && request.updated_at >= activeCutoff);
  if (hasActiveRequest) {
    throw Errors.conflict('Finish the active capability request before starting another');
  }

  const windowCutoff = currentTime - CREATION_WINDOW_MS;
  const recentCreations = requests.filter((request) => request.created_at >= windowCutoff);
  if (recentCreations.length >= MAX_CREATIONS_PER_WINDOW) {
    throw Errors.rateLimited('Capability creation is limited to 2 requests per user per hour');
  }
}

async function createCapabilityRequest(
  storage: Storage,
  userId: string,
  task: string,
): Promise<CapabilityRequestRow> {
  const priorRequests = await storage.capabilityRequests.listByUser(userId);
  assertCapabilityCreationQuota(priorRequests);
  return await storage.capabilityRequests.create(userId, task);
}

export interface CapabilityBuildResult {
  requestId: string;
  slug: string;
  summary: string;
  sampleOutput: string;
  branch: string;
  prUrl: string;
}

export interface SourceImprovementBuildResult {
  requestId: string;
  changedFiles: string[];
  branch: string;
  prUrl: string;
  fixMapSummary: string;
}

export function buildCapabilityRepairFeedback(
  review: CapabilityReview,
  testOutput: string,
): string {
  return [
    'The independent reviewer tests are a fixed regression gate and will be reused.',
    'Do not assume the author-written expected values are correct when they conflict with official evidence.',
    `Independent review summary: ${review.summary}`,
    ...(review.sources.length > 0
      ? [`Official evidence: ${review.sources.map((source) => source.url).join(', ')}`]
      : []),
    ...(review.evidenceClaims.length > 0
      ? [
        'Official evidence excerpts:',
        ...review.evidenceClaims.map((claim) =>
          `- ${claim.testName}: ${claim.quote} (${claim.sourceUrl})`),
      ]
      : []),
    '',
    'Combined sandbox output:',
    testOutput,
    '',
    'Independent reviewer test code:',
    review.testCode,
  ].join('\n').slice(0, 12_000);
}

export async function buildCapability(
  storage: Storage,
  userId: string,
  task: string,
): Promise<CapabilityBuildResult> {
  assertCapabilityEnabled();
  // Fail before model and sandbox work if the least-privilege publisher is absent.
  getCapabilityGitHubConfig();
  const request = await createCapabilityRequest(storage, userId, task);
  try {
    await storage.capabilityRequests.update(request.id, { status: 'generating' });
    let draft = await generateCapabilityDraft(task);
    const review = await generateCapabilityReview(task, draft);
    let sandbox: Awaited<ReturnType<typeof validateAndExecuteInSandbox>> = {
      passed: false,
      testOutput: '',
      sampleOutput: '',
    };
    for (let attempt = 0; attempt < MAX_CAPABILITY_VALIDATION_ATTEMPTS; attempt++) {
      await storage.capabilityRequests.update(request.id, {
        status: 'validating',
        slug: draft.slug,
      });
      sandbox = await validateAndExecuteInSandbox(draft, draft.sampleInput, review);
      if (sandbox.passed || attempt === MAX_CAPABILITY_VALIDATION_ATTEMPTS - 1) break;
      await storage.capabilityRequests.update(request.id, { status: 'generating' });
      draft = await generateCapabilityDraft(
        task,
        undefined,
        buildCapabilityRepairFeedback(review, sandbox.testOutput),
      );
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
      review,
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
  _userId: string,
  slug: string,
  input: unknown,
): Promise<string> {
  assertCapabilityEnabled();
  const code = await fetchMergedCapabilityCode(slug);
  assertSafeCapabilityCode(code);
  const result = await executeCapabilityCodeInSandbox(code, input);
  if (!result.passed) throw new Error(`Capability execution failed:\n${result.output}`);
  return result.output;
}

export async function improveSource(
  storage: Storage,
  userId: string,
  task: string,
): Promise<SourceImprovementBuildResult> {
  assertCapabilityEnabled();
  getCapabilityGitHubConfig();
  const request = await createCapabilityRequest(storage, userId, `[self-improvement] ${task}`);
  try {
    await storage.capabilityRequests.update(request.id, {
      status: 'generating',
      slug: 'self-improve',
    });
    const result = await generateAndValidateSourceImprovement(task);
    await storage.capabilityRequests.update(request.id, {
      status: 'validating',
      slug: 'self-improve',
    });
    const sandboxSummary = [
      result.fixMapSummary,
      `Context: ${result.contextPaths.join(', ')}`,
      `Changed: ${result.changes.map((change) => change.path).join(', ')}`,
      '',
      result.testOutput,
      result.buildOutput,
    ].join('\n').slice(0, 12_000);
    const published = await publishSourceImprovement(
      result.changes,
      task,
      request.id,
      result.baseSha,
      sandboxSummary,
    );
    await storage.capabilityRequests.update(request.id, {
      status: 'pr_opened',
      slug: 'self-improve',
      branchName: published.branch,
      prUrl: published.prUrl,
      sandboxSummary,
    });
    return {
      requestId: request.id,
      changedFiles: result.changes.map((change) => change.path),
      branch: published.branch,
      prUrl: published.prUrl,
      fixMapSummary: result.fixMapSummary,
    };
  } catch (error) {
    try {
      await storage.capabilityRequests.update(request.id, {
        status: 'failed',
        error: errorMessage(error),
      });
    } catch {
      // Preserve the original improvement error if audit persistence also fails.
    }
    throw error;
  }
}
