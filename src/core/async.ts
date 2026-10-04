/** Small, dependency-free async helpers used across the app. */

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (timeoutMs <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Exponential backoff with full jitter, capped at `maxDelayMs`. */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exponential * 0.5 + exponential * 0.5);
}

/** A promise-chain based mutex. All critical sections run strictly in order. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Minimal contract for a shared pacing gate. Kept as an interface so services
 * depend on the capability, not on the concrete {@link Cooldown} (and tests can
 * pass a trivial stub).
 */
export interface ActionGate {
  wait(): Promise<void>;
}

/**
 * One shared gate that guarantees at least `intervalMs` between the starts of
 * two gated actions. Callers queue up, so forum writes and Telegram sends from
 * every service (issuance, stats) never bunch up.
 *
 * It is a *pacing* primitive, separate from {@link ../forum/RateLimiter}: the
 * limiter enforces the API budget, the cooldown keeps the bot looking human.
 * A non-positive interval disables the wait but keeps callers serialized.
 */
export class Cooldown implements ActionGate {
  private lastStartedAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly intervalMs: number) {}

  /** Wait for this action's turn, spacing it from the previous one. */
  async wait(): Promise<void> {
    const run = this.tail.then(async () => {
      const waitMs = this.lastStartedAt + this.intervalMs - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      this.lastStartedAt = Date.now();
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }
}
