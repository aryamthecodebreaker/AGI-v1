import jwt from 'jsonwebtoken';
import type { CapabilityDraft } from './draft.js';
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

function capabilityFiles(draft: CapabilityDraft, task: string): Array<{ path: string; content: string }> {
  const root = `generated-tools/${draft.slug}`;
  return [
    { path: `${root}/tool.mjs`, content: draft.toolCode },
    { path: `${root}/tool.test.mjs`, content: draft.testCode },
    {
      path: `${root}/README.md`,
      content: `# ${draft.slug}\n\n${draft.summary}\n\n## Requested task\n\n${task}\n\nThis generated tool is executed only inside a network-denied Vercel Sandbox.\n`,
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
): Promise<PublishedCapability> {
  const config = getCapabilityGitHubConfig();
  const token = await installationToken();
  const ref = await githubRequest<{ object: { sha: string } }>(
    `/repos/${config.owner}/${config.repo}/git/ref/heads/${config.baseBranch}`,
    token,
  );
  const branch = `agi/capability-${draft.slug}-${requestId.slice(-6)}`;
  await githubRequest(
    `/repos/${config.owner}/${config.repo}/git/refs`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.json.object.sha }),
    },
  );

  for (const file of capabilityFiles(draft, task)) {
    await githubRequest(
      `/repos/${config.owner}/${config.repo}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify({
          message: `Add generated ${draft.slug} capability`,
          content: Buffer.from(file.content).toString('base64'),
          branch,
        }),
      },
    );
  }

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
          '- Sandbox egress was set to deny-all and no credentials were injected.',
          '- This is a draft PR and cannot merge itself.',
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
