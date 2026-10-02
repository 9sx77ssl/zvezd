import { sleep } from '../core/async';
import { ShuttingDownError } from '../core/errors';
import { errorToLog, type Logger } from '../core/logger';

export interface AuthGateOptions {
  logger: Logger;
  /** Token the HTTP client is currently using. */
  token: string;
  /** File that holds `FORUM_TOKEN`; shown in logs so the fix is obvious. */
  envPath: string;
  /** Re-reads `FORUM_TOKEN` from disk; `null` when missing or empty. */
  readToken: () => string | null;
  /** Pushes a new token into the HTTP client. */
  applyToken: (token: string) => void;
  /** Cheap request answering "does the current token still work?". */
  probe: () => Promise<boolean>;
  /** How often to re-read the token file / probe the forum. */
  checkIntervalMs: number;
  /** Repeat the "still waiting" log every N checks, 0 disables it. */
  logEveryChecks: number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Puts every forum request to sleep when the forum answers 401.
 *
 * 401 means the bearer token is dead. Instead of hammering the API and burning
 * retries, requests park here until a working token appears: either a fresh
 * `FORUM_TOKEN` written into the token file (no restart needed) or the forum
 * accepting the current token again after a hiccup.
 */
export class AuthGate {
  private readonly logger: Logger;
  private readonly envPath: string;
  private readonly readToken: () => string | null;
  private readonly applyToken: (token: string) => void;
  private readonly probe: () => Promise<boolean>;
  private readonly checkIntervalMs: number;
  private readonly logEveryChecks: number;

  private token: string;
  private paused = false;
  private stopping = false;
  private started = false;
  private waiters: Waiter[] = [];
  private checkInFlight: Promise<void> | null = null;
  private checksWhilePaused = 0;
  private readonly abort = new AbortController();

  constructor(options: AuthGateOptions) {
    this.logger = options.logger;
    this.envPath = options.envPath;
    this.readToken = options.readToken;
    this.applyToken = options.applyToken;
    this.probe = options.probe;
    this.checkIntervalMs = options.checkIntervalMs;
    this.logEveryChecks = options.logEveryChecks;
    this.token = options.token;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** The forum answered 401: freeze every request until auth is restored. */
  pause(): void {
    if (this.paused || this.stopping) return;
    this.paused = true;
    this.checksWhilePaused = 0;
    this.logger.error('Forum rejected the token (401), pausing all forum requests', {
      envPath: this.envPath,
      checkIntervalMs: this.checkIntervalMs,
      hint: 'put a fresh FORUM_TOKEN into the file, no restart needed',
    });
    // The new token may already be in the file: look right away.
    void this.check();
  }

  /** Resolves when the gate reopens; parks the caller while paused. */
  async waitWhilePaused(): Promise<void> {
    if (!this.paused) return;
    if (this.stopping) {
      throw new ShuttingDownError('Forum client stopped while waiting for auth');
    }
    await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    void this.loop();
  }

  /** Unparks nothing: waiters are rejected so the process can shut down. */
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.abort.abort(new Error('Auth gate stopped'));
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter.reject(new ShuttingDownError('Forum client stopped while waiting for auth'));
    }
  }

  /** One recovery attempt; safe to call concurrently. */
  check(): Promise<void> {
    if (this.checkInFlight) return this.checkInFlight;
    const promise = this.runCheck()
      .catch((err: unknown) => {
        this.logger.warn('Auth recovery check failed', errorToLog(err));
      })
      .finally(() => {
        this.checkInFlight = null;
      });
    this.checkInFlight = promise;
    return promise;
  }

  private async runCheck(): Promise<void> {
    const fresh = this.readToken();
    if (fresh && fresh !== this.token) {
      this.token = fresh;
      this.applyToken(fresh);
      this.logger.info('Loaded a new FORUM_TOKEN from the token file', { envPath: this.envPath });
      if (this.paused) this.resume('new-token-in-file');
      return;
    }

    if (!this.paused || this.stopping) return;

    if (await this.probe()) {
      this.resume('forum-accepted-the-token-again');
      return;
    }

    this.checksWhilePaused += 1;
    if (this.logEveryChecks > 0 && this.checksWhilePaused % this.logEveryChecks === 0) {
      this.logger.info('Still waiting for a working FORUM_TOKEN', { envPath: this.envPath });
    }
  }

  private resume(reason: string): void {
    this.paused = false;
    this.checksWhilePaused = 0;
    const waiters = this.waiters;
    this.waiters = [];
    this.logger.warn('Forum auth restored, resuming forum requests', { reason });
    for (const waiter of waiters) waiter.resolve();
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await sleep(this.checkIntervalMs, this.abort.signal);
      } catch {
        return;
      }
      await this.check();
    }
  }
}
