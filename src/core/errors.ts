/**
 * Central error hierarchy.
 *
 * Every error carries a stable machine-readable `code` so logs and retry
 * decisions never rely on string matching of human messages.
 */

import { NOTICES, type NoticeKind, type NoticeReason } from './vocab';

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

/**
 * Base class for "tell the user and close the submission" conditions. Such a
 * submission gets the notice comment plus the ad and is terminated as
 * `skipped` with the reason from {@link NOTICES}.
 *
 * The error only carries the {@link NoticeKind}; its `code`, persisted `reason`
 * and config text key all come from the single registry, so a new notice can
 * never drift between those places.
 */
export class NoticeError extends AppError {
  readonly kind: NoticeKind;
  readonly reason: NoticeReason;

  constructor(message: string, kind: NoticeKind, options?: ErrorOptions) {
    super(message, NOTICES[kind].code, options);
    this.kind = kind;
    this.reason = NOTICES[kind].reason;
  }
}

/** The target channel has paid (star) reactions disabled. */
export class PaidReactionsDisabledError extends NoticeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'paidReactionsDisabled', options);
  }
}

/** A bare channel link was submitted but the channel has no posts. */
export class NoPostsFoundError extends NoticeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'noPostsFound', options);
  }
}

/** The post contains no valid public Telegram link at all. */
export class NoLinkFoundError extends NoticeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'noLinkFound', options);
  }
}

/** The Telegram link exists but the message behind it cannot be resolved. */
export class LinkUnresolvableError extends NoticeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'linkUnresolvable', options);
  }
}

/** The process is stopping while a request was parked (forum auth paused). */
export class ShuttingDownError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'SHUTTING_DOWN', options);
  }
}
