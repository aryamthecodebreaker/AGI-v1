import { customAlphabet } from 'nanoid';

// URL-safe, no ambiguous chars, 16 chars ~ 95 bits of entropy.
const alpha = '0123456789abcdefghijklmnopqrstuvwxyz';
const nanoId = customAlphabet(alpha, 16);

export function newId(prefix?: string): string {
  const id = nanoId();
  return prefix ? `${prefix}_${id}` : id;
}

export const ids = {
  user: () => newId('u'),
  conversation: () => newId('c'),
  message: () => newId('m'),
  memory: () => newId('mem'),
  person: () => newId('p'),
  session: () => newId('s'),
  capabilityRequest: () => newId('cap'),
  // AGI Command
  device: () => newId('dev'),
  credential: () => newId('cred'),
  pairing: () => newId('pair'),
  group: () => newId('grp'),
  command: () => newId('cmd'),
  execution: () => newId('exec'),
  confirmation: () => newId('cfm'),
  event: () => newId('evt'),
  workflow: () => newId('wf'),
  workflowStep: () => newId('wfs'),
  workflowRun: () => newId('wfr'),
};
