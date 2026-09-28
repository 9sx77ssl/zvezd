/**
 * Central error hierarchy.
 *
 * Every error carries a stable machine-readable `code` so logs and retry
 * decisions never rely on string matching of human messages.
 */

export type ErrorOptions = { cause?: unknown };

export class AppError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Configuration / environment problems, always fatal. */
export class ConfigError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'CONFIG_ERROR', options);
  }
}

/** Base class for anything the forum HTTP layer rejects. */
export class ForumApiError extends AppError {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown, options?: ErrorOptions) {
    super(message, 'FORUM_API_ERROR', options);
    this.status = status;
    this.body = body;
  }
}

/** HTTP 429 — caller should back off until `retryAt`. */
export class ForumRateLimitError extends AppError {
  readonly retryAt: Date;

  constructor(retryAt: Date, body: unknown, options?: ErrorOptions) {
    super(`Forum rate limit hit, retry at ${retryAt.toISOString()}`, 'FORUM_RATE_LIMIT', options);
    this.retryAt = retryAt;
    this.body = body;
  }

  readonly body: unknown;
}

/** Telegram session is missing or rejected; user must run `bun run login`. */
export class TelegramAuthError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'TG_AUTH_ERROR', options);
  }
}

/** A condition that will never resolve on retry (deleted post, bad link...). */
export class PermanentError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'PERMANENT_ERROR', options);
  }
}

/** The target channel has paid (star) reactions disabled. */
export class PaidReactionsDisabledError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'PAID_REACTIONS_DISABLED', options);
  }
}

/** A bare channel link was submitted but the channel has no posts. */
export class NoPostsFoundError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'NO_POSTS_FOUND', options);
  }
}
