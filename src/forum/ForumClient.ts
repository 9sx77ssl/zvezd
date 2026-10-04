import type { z } from 'zod';
import { type ActionGate, backoffDelay, sleep } from '../core/async';
import { ForumApiError, ForumRateLimitError, ShuttingDownError } from '../core/errors';
import { errorToLog, type Logger } from '../core/logger';
import type { AuthGate } from './AuthGate';
import type { RateLimiter, ServerRateLimit } from './RateLimiter';
import {
  type CommentsListResponse,
  type CreateCommentResponse,
  commentsListResponseSchema,
  createCommentResponseSchema,
  type PostResponse,
  type PostsResponse,
  postResponseSchema,
  postsResponseSchema,
  systemInfoSchema,
  type ThreadResponse,
  threadResponseSchema,
  type UserMeResponse,
  userMeResponseSchema,
} from './types';

export interface RetryOptions {
  attempts: number;
  delayMs: number;
  maxDelayMs: number;
}

export interface ForumClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  retry: RetryOptions;
  logger: Logger;
  readLimiter: RateLimiter;
  writeLimiter: RateLimiter;
  /** Shared pacing gate applied before every write request. */
  cooldown?: ActionGate;
}

export interface GetPostsParams {
  threadId: number;
  page?: number;
  limit: number;
  order: string;
  /** Fetch the page that contains this post. `threadId` may be omitted then. */
  pageOfPostId?: number;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
}

/**
 * Typed HTTP client for the Lolzteam forum API.
 *
 * Responsibilities:
 *  - serialized, server-aware rate limiting;
 *  - retries with backoff for transient failures and HTTP 429;
 *  - strict response validation via zod;
 *  - rich structured logging.
 */
export class ForumClient {
  private readonly baseUrl: string;
  private token: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryOptions;
  private readonly logger: Logger;
  private readonly readLimiter: RateLimiter;
  private readonly writeLimiter: RateLimiter;
  private readonly cooldown?: ActionGate;
  private authGate?: AuthGate;

  constructor(options: ForumClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.retry = options.retry;
    this.logger = options.logger;
    this.readLimiter = options.readLimiter;
    this.writeLimiter = options.writeLimiter;
    this.cooldown = options.cooldown;
  }

  /** Gate that parks requests while the forum rejects the token (401). */
  setAuthGate(gate: AuthGate): void {
    this.authGate = gate;
  }

  /** Swap the bearer token without restarting (used by the auth gate). */
  setToken(token: string): void {
    this.token = token;
  }

  /** Liveness check for the current token; never parks, used by the gate. */
  async probeAuth(): Promise<boolean> {
    try {
      const response = await fetch(new URL('/users/me', this.baseUrl), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  getPosts(params: GetPostsParams): Promise<PostsResponse> {
    return this.request(
      'GET',
      '/posts',
      {
        query: {
          thread_id: params.threadId,
          page: params.page,
          limit: params.limit,
          order: params.order,
          page_of_post_id: params.pageOfPostId,
        },
      },
      postsResponseSchema,
    );
  }

  createComment(postId: number, body: string): Promise<CreateCommentResponse> {
    return this.request(
      'POST',
      '/posts/comments',
      { body: { post_id: postId, comment_body: body } },
      createCommentResponseSchema,
    );
  }

  getComments(postId: number): Promise<CommentsListResponse> {
    return this.request(
      'GET',
      '/posts/comments',
      { query: { post_id: postId } },
      commentsListResponseSchema,
    );
  }

  getMe(): Promise<UserMeResponse> {
    return this.request('GET', '/users/me', {}, userMeResponseSchema);
  }

  getThread(threadId: number): Promise<ThreadResponse> {
    return this.request('GET', `/threads/${threadId}`, {}, threadResponseSchema);
  }

  /** Edit a thread's title. */
  editThread(threadId: number, title: string): Promise<ThreadResponse> {
    return this.request('PUT', `/threads/${threadId}`, { body: { title } }, threadResponseSchema);
  }

  /** Edit a post's body. */
  editPost(postId: number, postBody: string): Promise<PostResponse> {
    return this.request(
      'PUT',
      `/posts/${postId}`,
      { body: { post_body: postBody } },
      postResponseSchema,
    );
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    options: RequestOptions & { body?: unknown },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const limiter = method === 'GET' ? this.readLimiter : this.writeLimiter;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      await limiter.acquire();
      if (method !== 'GET') await this.cooldown?.wait();
      try {
        return await this.execute(method, path, options, schema);
      } catch (err) {
        lastError = err;
        const decision = this.retryDecision(err, attempt, method);
        if (!decision.retry) throw err;

        this.logger.warn('Forum request failed, retrying', {
          method,
          path,
          attempt,
          maxAttempts: this.retry.attempts,
          delayMs: decision.delayMs,
          ...errorToLog(err),
        });
        await sleep(decision.delayMs);
      }
    }

    throw lastError;
  }

  private retryDecision(
    err: unknown,
    attempt: number,
    method: 'GET' | 'POST' | 'PUT',
  ): { retry: boolean; delayMs: number } {
    if (err instanceof ShuttingDownError) return { retry: false, delayMs: 0 };
    if (attempt >= this.retry.attempts) return { retry: false, delayMs: 0 };

    if (err instanceof ForumRateLimitError) {
      const delayMs = Math.max(0, err.retryAt.getTime() - Date.now());
      return { retry: true, delayMs: Math.max(delayMs, this.retry.delayMs) };
    }

    // Writes are not idempotent: an ambiguous failure (timeout, connection
    // reset, 5xx) may still have been applied server-side. Never auto-retry
    // them here; the caller verifies and the issuance state machine retries.
    if (method !== 'GET') return { retry: false, delayMs: 0 };

    if (err instanceof ForumApiError) {
      // 5xx = server failure; 403/408/425 = the forum's anti-flood / transient
      // throttling (it returns 403 instead of 429 for rapid writes).
      const retryable =
        err.status >= 500 || err.status === 403 || err.status === 408 || err.status === 425;
      return retryable
        ? {
            retry: true,
            delayMs: backoffDelay(attempt, this.retry.delayMs, this.retry.maxDelayMs),
          }
        : { retry: false, delayMs: 0 };
    }

    // Network errors, timeouts, unexpected exceptions.
    return {
      retry: true,
      delayMs: backoffDelay(attempt, this.retry.delayMs, this.retry.maxDelayMs),
    };
  }

  private async execute<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    options: RequestOptions & { body?: unknown },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    for (;;) {
      // Dead token (401): park here until auth is restored instead of failing.
      await this.authGate?.waitWhilePaused();

      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${this.token}`,
      };
      if (options.body !== undefined) headers['content-type'] = 'application/json';

      const startedAt = Date.now();
      this.logger.debug('Forum request', { method, path, query: options.query });

      const response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const text = await response.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      const rateLimit = this.extractRateLimit(json);
      if (rateLimit) {
        (method === 'GET' ? this.readLimiter : this.writeLimiter).noteServerState(rateLimit);
      }

      if (response.status === 401 && this.authGate) {
        // The token is dead: freeze every request, wait for a working one and
        // then repeat this very request as if nothing happened.
        this.authGate.pause();
        continue;
      }

      if (response.status === 429) {
        throw new ForumRateLimitError(this.resolveRetryAt(response, rateLimit), json);
      }

      if (!response.ok) {
        throw new ForumApiError(
          `Forum API responded with ${response.status} ${response.statusText}`,
          response.status,
          json,
        );
      }

      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new ForumApiError('Forum API returned an unexpected payload', response.status, {
          issues: parsed.error.issues,
        });
      }

      this.logger.debug('Forum response', {
        method,
        path,
        status: response.status,
        durationMs: Date.now() - startedAt,
        remaining: rateLimit?.remaining,
      });

      return parsed.data;
    }
  }

  private extractRateLimit(json: unknown): ServerRateLimit | undefined {
    const systemInfo = systemInfoSchema.safeParse((json as { system_info?: unknown })?.system_info);
    if (!systemInfo.success) return undefined;
    return systemInfo.data.rate_limit;
  }

  private resolveRetryAt(response: Response, rateLimit?: ServerRateLimit): Date {
    if (rateLimit) return new Date(rateLimit.reset * 1000 + 500);

    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return new Date(Date.now() + seconds * 1000);
    }

    return new Date(Date.now() + 5_000);
  }
}
