// Minimal in-memory fixed-window rate limiter.
//
// Used for pairing-code creation and pairing attempts, where the goal is to stop
// someone grinding through the short code space. Single-process and
// intentionally simple — the durable protections are the 5-minute TTL and the
// single-use consume, this just makes brute force impractical.

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns false when the caller is over budget. */
  tryConsume(key: string, at: number = Date.now()): boolean {
    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= at) {
      this.windows.set(key, { count: 1, resetAt: at + this.windowMs });
      return true;
    }
    if (existing.count >= this.limit) return false;
    existing.count++;
    return true;
  }

  retryAfterMs(key: string, at: number = Date.now()): number {
    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= at) return 0;
    return existing.resetAt - at;
  }

  reset(key?: string): void {
    if (key === undefined) this.windows.clear();
    else this.windows.delete(key);
  }

  /** Drop expired windows so a long-running process does not grow unbounded. */
  prune(at: number = Date.now()): void {
    for (const [key, w] of this.windows) {
      if (w.resetAt <= at) this.windows.delete(key);
    }
  }
}
