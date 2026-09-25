import { z } from 'zod';

/** Shape of `config.yml` before secrets are injected from the environment. */
export const fileConfigSchema = z.object({
  forum: z.object({
    baseUrl: z.string().url().default('https://api.lolz.team'),
    threadId: z.number().int().positive(),
    requestTimeoutMs: z.number().int().positive().default(15_000),
    order: z
      .enum(['natural', 'natural_reverse', 'post_likes', 'post_likes_reverse'])
      .default('natural_reverse'),
  }),
  polling: z
    .object({
      /** How often the newest page is checked for new posts. */
      intervalMs: z.number().int().min(1_000).default(15_000),
      /** Posts fetched per request (API max is 20). */
      pageLimit: z.number().int().min(1).max(20).default(20),
      /** Pause between page fetches while walking the backlog. */
      pageDelayMs: z.number().int().min(0).default(5_000),
      /** Pause after each handled post before moving to the next one. */
      postDelayMs: z.number().int().min(0).default(5_000),
      /** Safety cap for the backlog walk, 0 = unlimited. */
      maxBackfillPages: z.number().int().min(0).default(0),
      /** Page that carries the newest posts. */
      idlePage: z.number().int().positive().default(1),
    })
    .prefault({}),
  pacing: z
    .object({
      /** Pause between sending a star and writing the confirmation comment. */
      starToCommentMs: z.number().int().min(0).default(5_000),
      /** Wait before verifying a comment that errored (slow forum responses). */
      commentVerifyDelayMs: z.number().int().min(0).default(3_000),
    })
    .prefault({}),
  balance: z
    .object({
      /** While out of stars, how often to re-check the Telegram balance. */
      checkIntervalMs: z.number().int().min(5_000).default(60_000),
    })
    .prefault({}),
  star: z
    .object({
      count: z.number().int().positive().default(1),
      dryRun: z.boolean().default(false),
    })
    .prefault({}),
  comment: z
    .object({
      enabled: z.boolean().default(true),
      text: z.string().default('+'),
      template: z.string().default('[user="{user_id}"]{username}[/user], {text}'),
    })
    .prefault({}),
  rateLimit: z
    .object({
      /** Forum GET budget per minute (server allows 300). */
      readPerMinute: z.number().int().positive().default(240),
      /** Forum POST budget per minute (server allows 30). */
      writePerMinute: z.number().int().positive().default(20),
    })
    .prefault({}),
  retry: z
    .object({
      /** Max attempts for a request before giving up. */
      attempts: z.number().int().min(1).default(3),
      /** Base delay for retries (grows exponentially with jitter). */
      delayMs: z.number().int().positive().default(1_000),
      /** Ceiling for retry delays. */
      maxDelayMs: z.number().int().positive().default(30_000),
    })
    .prefault({}),
  database: z
    .object({
      path: z.string().default('./data/star.db'),
    })
    .prefault({}),
  telegram: z
    .object({
      sessionPath: z.string().default('./data/tg.session'),
    })
    .prefault({}),
  logging: z
    .object({
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
      pretty: z.boolean().default(true),
    })
    .prefault({}),
});

export type FileConfig = z.infer<typeof fileConfigSchema>;

/** Secrets and optional overrides read from the environment. */
export const envSchema = z.object({
  FORUM_TOKEN: z.string().min(1, 'FORUM_TOKEN is required'),
  TG_API_ID: z.coerce.number().int().positive('TG_API_ID must be a positive integer'),
  TG_API_HASH: z.string().min(1, 'TG_API_HASH is required'),
  FORUM_BASE_URL: z.string().url().optional(),
  FORUM_THREAD_ID: z.coerce.number().int().positive().optional(),
  DB_PATH: z.string().optional(),
  TG_SESSION_PATH: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
  LOG_PRETTY: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  STAR_COUNT: z.coerce.number().int().positive().optional(),
  POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).optional(),
  DRY_RUN: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

export type Env = z.infer<typeof envSchema>;
