import { Errors } from '../util/errors.js';

const FIXED_REPOSITORY = 'aryamthecodebreaker/AGI-v1';

export interface CapabilityGitHubConfig {
  appId: string;
  installationId: string;
  privateKey: string;
  owner: string;
  repo: string;
  baseBranch: 'main';
}

function enabled(): boolean {
  return process.env.CAPABILITY_BUILDER_ENABLED?.trim().toLowerCase() === 'true';
}

export function assertCapabilityEnabled(): void {
  if (!enabled()) {
    throw Errors.forbidden('Capability builder is disabled');
  }
}

export function getCapabilityGitHubConfig(): CapabilityGitHubConfig {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  if (!appId || !installationId || !privateKey) {
    throw Errors.internal('Capability builder GitHub App credentials are not configured');
  }
  const [owner, repo] = FIXED_REPOSITORY.split('/');
  return { appId, installationId, privateKey, owner: owner!, repo: repo!, baseBranch: 'main' };
}

export function capabilityRepository(): string {
  return FIXED_REPOSITORY;
}
