export const now = (): number => Date.now();

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
