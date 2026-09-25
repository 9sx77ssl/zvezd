import { sleep } from '../core/async';

export interface RateLimiterOptions {
  /** Bucket size, i.e. the server advertised limit per window. */
  capacity: number;
  /** Tokens regenerated per millisecond. */
  refillPerMs: number;
  /** Minimum spacing between two requests, regardless of tokens. */
  minIntervalMs: number;
  /** Never let the server-side remaining drop below this value. */
  reserve: number;
}

export interface ServerRateLimit {
  remaining: number;
  /** Unix epoch seconds when the window resets. */
  reset: number;
}

/**
 * Builds a limiter from a human-friendly "requests per minute" value.
 * Keeps a safety reserve and never lets requests bunch up.
 */
export function rateLimiterFromPerMinute(perMinute: number, name: string): RateLimiter {
  const rate = Math.max(1, Math.floor(perMinute));
  return new RateLimiter(
    {
      capacity: rate,
      refillPerMs: rate / 60_000,
      minIntervalMs: Math.ceil(60_000 / rate),
      reserve: Math.max(1, Math.ceil(rate * 0.06)),
    },
    name,
  );
}

/**
 * Token bucket rate limiter that also honours the server-provided
 * `system_info.rate_limit` on every response. Requests are serialized so the
 * bucket can never be oversold by concurrent callers.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefillAt = Date.now();
  private lastRequestAt = 0;
  private blockedUntil = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: RateLimiterOptions,
    private readonly name: string,
  ) {
    this.tokens = options.capacity;
  }

  /**
   * Update the limiter with the authoritative server state. When the server
   * says we are close to the edge we hard-stop until the window resets.
   */
  noteServerState(limit: ServerRateLimit): void {
    if (limit.remaining <= this.options.reserve) {
      const resetAt = limit.reset * 1000 + 500;
      this.blockedUntil = Math.max(this.blockedUntil, resetAt);
    }
  }

  /** Acquire a single slot, waiting as long as necessary. */
  acquire(): Promise<void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return (async () => {
      await previous;
      try {
        await this.waitForTurn();
      } finally {
        release();
      }
    })();
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.options.capacity, this.tokens + elapsed * this.options.refillPerMs);
    this.lastRefillAt = now;
  }

  private async waitForTurn(): Promise<void> {
    for (;;) {
      const now = Date.now();

      if (now < this.blockedUntil) {
        await sleep(this.blockedUntil - now);
        continue;
      }

      this.refill(now);

      let waitMs = 0;
      if (this.tokens < 1) {
        waitMs = Math.ceil((1 - this.tokens) / this.options.refillPerMs);
      }
      const sinceLast = now - this.lastRequestAt;
      if (sinceLast < this.options.minIntervalMs) {
        waitMs = Math.max(waitMs, this.options.minIntervalMs - sinceLast);
      }

      if (waitMs > 0) {
        await sleep(waitMs);
        continue;
      }

      this.tokens -= 1;
      this.lastRequestAt = Date.now();
      return;
    }
  }

  /** Snapshot used for observability. */
  state(): { name: string; tokens: number; blockedUntil: number } {
    return { name: this.name, tokens: this.tokens, blockedUntil: this.blockedUntil };
  }
}
