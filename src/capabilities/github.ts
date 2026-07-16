import jwt from 'jsonwebtoken';
import type { CapabilityDraft, CapabilityReview } from './draft.js';
import type { SourceChange } from './improvement.js';
import { capabilityRepository, getCapabilityGitHubConfig } from './config.js';

const API_ROOT = 'https://api.github.com';

interface GitHubResponse<T> {
  status: number;
  json: T;
}

export function createGitHubAppJwt(appId: string, privateKey: string): string {
  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  return jwt.sign(
    { iat: issuedAt, exp: issuedAt + 9 * 60, iss: appId },
    privateKey,
    { algorithm: 'RS256' },
  );
}

async function githubRequest<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<GitHubResponse<T>> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const json = await response.json().catch(() => ({})) as T;
  if (!response.ok) {
    const message = typeof json === 'object' && json !== null && 'message' in json
      ? String((json as { message: unknown }).message)
      : `GitHub HTTP ${response.status}`;
    throw new Error(`GitHub HTTP ${response.status}: ${message}`);
  }
  return { status: response.status, json };
}

async function installationToken(): Promise<string> {
  const config = getCapabilityGitHubConfig();
  const auth = createGitHubAppJwt(config.appId, config.privateKey);
  const result = await githubRequest<{ token: string }>(
    `/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`,
    auth,
    {
      method: 'POST',
      body: JSON.stringify({
        repositories: [config.repo],
        permissions: { contents: 'write', pull_requests: 'write' },
      }),
    },
  );
  if (!result.json.token) throw new Error('GitHub did not return an installation token');
  return result.json.token;
}

function capabilityFiles(
  draft: CapabilityDraft,
  review: CapabilityReview,
  task: string,
): Array<{ path: string; content: string }> {
  const root = `generated-tools/${draft.slug}`;
  const evidence = review.sources.length > 0
    ? [
      '',
      '## Independent verification evidence',
      '',
      ...review.sources.map((source) => `- [${source.title}](${source.url})`),
    ].join('\n')
    : '';
  const evidenceClaims = review.evidenceClaims.length > 0
    ? [
      '',
      '### Evidence-backed tests',
      '',
      ...review.evidenceClaims.map((claim) => {
        const testName = claim.testName.replaceAll('`', '');
        const quote = claim.quote.replace(/\s+/g, ' ').trim().slice(0, 500);
        return `- \`${testName}\`: “${quote}” ([source](${claim.sourceUrl}))`;
      }),
    ].join('\n')
    : '';
  return [
    { path: `${root}/tool.mjs`, content: draft.toolCode },
    { path: `${root}/tool.test.mjs`, content: draft.testCode },
    { path: `${root}/tool.review.test.mjs`, content: review.testCode },
    {
      path: `${root}/README.md`,
      content: `# ${draft.slug}\n\n${draft.summary}\n\n## Requested task\n\n${task}\n\n## Independent review\n\n${review.summary}${evidence}${evidenceClaims}\n\nThis generated tool is executed only inside a network-denied Vercel Sandbox. Passing generated tests is not a certification; the draft still requires human review.\n`,
    },
  ];
}

export interface PublishedCapability {
  branch: string;
  prUrl: string;
  prNumber: number;
}

export async function publishCapabilityDraft(
  draft: CapabilityDraft,
  task: string,
  requestId: string,
  sandboxSummary: string,
  review: CapabilityReview,
): Promise<PublishedCapability> {
  const config = getCapabilityGitHubConfig();
  const token = await installationToken();
  const ref = await githubRequest<{ object: { sha: string } }>(
    `/repos/${config.owner}/${config.repo}/git/ref/heads/${config.baseBranch}`,
    token,
  );
  const baseCommit = await githubRequest<{ tree: { sha: string } }>(
    `/repos/${config.owner}/${config.repo}/git/commits/${ref.json.object.sha}`,
    token,
  );
  const branch = `agi/capability-${draft.slug}-${requestId.slice(-6)}`;
  const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
  for (const file of capabilityFiles(draft, review, task)) {
    const blob = await githubRequest<{ sha: string }>(
      `/repos/${config.owner}/${config.repo}/git/blobs`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          content: Buffer.from(file.content).toString('base64'),
          encoding: 'base64',
        }),
      },
    );
    treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.json.sha });
  }
  const tree = await githubRequest<{ sha: string }>(
    `/repos/${config.owner}/${config.repo}/git/trees`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseCommit.json.tree.sha, tree: treeEntries }),
    },
  );
  const commit = await githubRequest<{ sha: string }>(
    `/repos/${config.owner}/${config.repo}/git/commits`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        message: `Add generated ${draft.slug} capability`,
        tree: tree.json.sha,
        parents: [ref.json.object.sha],
      }),
    },
  );
  await githubRequest(
    `/repos/${config.owner}/${config.repo}/git/refs`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.json.sha }),
    },
  );

  const pull = await githubRequest<{ html_url: string; number: number }>(
    `/repos/${config.owner}/${config.repo}/pulls`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        title: `Add generated capability: ${draft.slug}`,
        head: branch,
        base: config.baseBranch,
        draft: true,
        body: [
          '## Requested capability',
          task,
          '',
          '## Safety',
          '- Generated code was tested and executed in a non-persistent Vercel Sandbox.',
          '- A separate reviewer generated adversarial tests from the request and available official evidence.',
          '- Sandbox egress was set to deny-all and no credentials were injected.',
          '- This is a draft PR and cannot merge itself.',
          '- Passing these checks is not a standards certification; human review remains required.',
          '',
          '## Independent review',
          review.summary,
          ...(review.sources.length > 0
            ? ['', 'Evidence:', ...review.sources.map((source) => `- [${source.title}](${source.url})`)]
            : []),
          ...(review.evidenceClaims.length > 0
            ? [
              '',
              'Evidence-backed tests:',
              ...review.evidenceClaims.map((claim) => {
                const testName = claim.testName.replaceAll('`', '');
                const quote = claim.quote.replace(/\s+/g, ' ').trim().slice(0, 500);
                return `- \`${testName}\`: “${quote}” ([source](${claim.sourceUrl}))`;
              }),
            ]
            : []),
          '',
          '## Sandbox result',
          '```text',
          sandboxSummary.slice(0, 8_000),
          '```',
        ].join('\n'),
      }),
    },
  );
  return { branch, prUrl: pull.json.html_url, prNumber: pull.json.number };
}

function branchSlug(task: string): string {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (slug || 'source-update').slice(0, 28).replace(/-$/g, '');
}

export async function publishSourceImprovement(
  changes: SourceChange[],
  task: string,
  requestId: string,
  validatedBaseSha: string,
  sandboxSummary: string,
): Promise<PublishedCapability> {
  if (changes.length === 0) throw new Error('Source improvement has no changes to publish');
  const config = getCapabilityGitHubConfig();
  const token = await installationToken();
  const ref = await githubRequest<{ object: { sha: string } }>(
    `/repos/${config.owner}/${config.repo}/git/ref/heads/${config.baseBranch}`,
    token,
  );
  if (ref.json.object.sha !== validatedBaseSha) {
    throw new Error('main changed while the self-improvement was being validated; run the request again');
  }
  const baseCommit = await githubRequest<{ tree: { sha: string } }>(
    `/repos/${config.owner}/${config.repo}/git/commits/${validatedBaseSha}`,
    token,
  );

  const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
  for (const change of changes) {
    const blob = await githubRequest<{ sha: string }>(
      `/repos/${config.owner}/${config.repo}/git/blobs`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          content: Buffer.from(change.content).toString('base64'),
          encoding: 'base64',
        }),
      },
    );
    treeEntries.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.json.sha });
  }
  const tree = await githubRequest<{ sha: string }>(
    `/repos/${config.owner}/${config.repo}/git/trees`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseCommit.json.tree.sha, tree: treeEntries }),
    },
  );
  const commit = await githubRequest<{ sha: string }>(
    `/repos/${config.owner}/${config.repo}/git/commits`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        message: `Propose self-improvement: ${task.slice(0, 120)}`,
        tree: tree.json.sha,
        parents: [validatedBaseSha],
      }),
    },
  );
  const branch = `agi/self-improve-${branchSlug(task)}-${requestId.slice(-6)}`;
  await githubRequest(
    `/repos/${config.owner}/${config.repo}/git/refs`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.json.sha }),
    },
  );

  const pull = await githubRequest<{ html_url: string; number: number }>(
    `/repos/${config.owner}/${config.repo}/pulls`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        title: `Self-improvement: ${task.slice(0, 100)}`,
        head: branch,
        base: config.baseBranch,
        draft: true,
        body: [
          '## Improvement goal',
          task,
          '',
          '## Changed files',
          ...changes.map((change) => `- \`${change.path}\``),
          '',
          '## Safety and review boundary',
          '- FixMap ranked the repository context before generation.',
          '- The reviewed main branch installed dependencies before generated code was present.',
          '- Sandbox egress was changed to deny-all before the patch was written or executed.',
          '- The patch passed git validation, the full test suite, and the TypeScript build.',
          '- No credentials were injected into the sandbox.',
          '- This is a draft PR. The assistant cannot merge it or write directly to main.',
          '',
          '## Validation result',
          '```text',
          sandboxSummary.slice(0, 10_000),
          '```',
        ].join('\n'),
      }),
    },
  );
  return { branch, prUrl: pull.json.html_url, prNumber: pull.json.number };
}

export async function fetchMergedCapabilityCode(slug: string): Promise<string> {
  if (!/^[a-z][a-z0-9-]{2,39}$/.test(slug)) throw new Error('Invalid capability slug');
  const url = `https://raw.githubusercontent.com/${capabilityRepository()}/main/generated-tools/${slug}/tool.mjs`;
  const response = await fetch(url, { headers: { Accept: 'text/plain' } });
  if (!response.ok) {
    throw new Error(`Merged capability not found on main (${response.status})`);
  }
  const code = await response.text();
  if (code.length > 30_000) throw new Error('Merged capability exceeds the code size limit');
  return code;
}
