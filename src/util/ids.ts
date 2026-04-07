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
};
