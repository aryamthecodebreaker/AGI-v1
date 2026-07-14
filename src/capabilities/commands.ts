export type CapabilityCommand =
  | { type: 'build'; task: string }
  | { type: 'run'; slug: string; input: unknown };

export function parseCapabilityCommand(content: string): CapabilityCommand | null {
  const build = content.match(/^\/build-tool\s+([\s\S]+)$/i);
  if (build) {
    const task = build[1]!.trim();
    if (task.length < 10 || task.length > 2_000) {
      throw new Error('/build-tool requires a task between 10 and 2,000 characters');
    }
    return { type: 'build', task };
  }

  const run = content.match(/^\/run-tool\s+([a-z][a-z0-9-]{2,39})(?:\s+([\s\S]+))?$/i);
  if (run) {
    let input: unknown = {};
    if (run[2]?.trim()) {
      try { input = JSON.parse(run[2]); }
      catch { throw new Error('/run-tool input must be valid JSON'); }
    }
    return { type: 'run', slug: run[1]!.toLowerCase(), input };
  }
  return null;
}
