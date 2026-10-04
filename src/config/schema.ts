import { z } from 'zod';
import { DEFAULT_AD_TEMPLATE } from './defaults';

/** Parse common truthy/falsy env spellings; reject anything else loudly. */
const booleanString = (name: string) =>
  z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined) return;
      const normalized = value.trim().toLowerCase();
      if (!['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(normalized)) {
        ctx.addIssue({ code: 'custom', message: `${name} must be a boolean (true/false)` });
      }
    })
    .transform((value) =>
      value === undefined
        ? undefined
        : ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase()),
    );

/** Shape of `config.yml` before secrets are injected from the environment. */
export const fileConfigSchema = z.object({
  forum: z.object({
    baseUrl: z.string().url().default('https://api.lolz.team'),
    threadId: z.number().int().positive(),
    requestTimeoutMs: z.number().int().positive().default(30_000),
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
      /** Safety cap for the backlog walk, 0 = unlimited. */
      maxBackfillPages: z.number().int().min(0).default(0),
    })
    .prefault({}),
  pacing: z
    .object({
      /**
       * Shared minimum pause between any two outgoing actions (star, comments,
       * stats edits). One knob for the whole bot.
       */
      cooldownMs: z.number().int().min(0).default(6_000),
      /** Wait before verifying a star reaction whose send threw. */
      starVerifyDelayMs: z.number().int().min(0).default(2_000),
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
      /** Shown when the channel has paid reactions disabled. */
      paidReactionsDisabledText: z
        .string()
        .default('у вас выключены платные реакции, включите их и приходите еще!'),
      /** Shown when a bare channel link is submitted but the channel has no posts. */
      noPostsFoundText: z
        .string()
        .default('не нашёл пост в канале, скиньте ссылку на конкретный пост!'),
      /** Shown when the post contains no valid public Telegram link at all. */
      noLinkFoundText: z
        .string()
        .default('не нашёл ссылку в посте, скиньте ссылку на канал или конкретный пост!'),
      /** Shown when the link exists but its Telegram message cannot be resolved. */
      linkUnresolvableText: z
        .string()
        .default('не смог открыть ссылку, проверьте её и скиньте ещё раз!'),
      ad: z
        .object({
          enabled: z.boolean().default(true),
          /** Second comment; same `{placeholder}` syntax as the confirmation. */
          template: z.string().default(DEFAULT_AD_TEMPLATE),
        })
        .prefault({}),
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
      /** How long to wait before retrying a post that exhausted its attempts. */
      failedPostCooldownMs: z.number().int().min(0).default(3_600_000),
    })
    .prefault({}),
  database: z
    .object({
      path: z.string().default('./data/star.db'),
    })
    .prefault({}),
  auth: z
    .object({
      /** File holding FORUM_TOKEN; re-read while the forum rejects it. */
      tokenFile: z.string().default('.env'),
      /** How often to re-read the token file / probe the forum. */
      tokenCheckIntervalMs: z.number().int().min(5_000).default(60_000),
      /** Repeat the "still waiting" log every N checks, 0 disables it. */
      logEveryChecks: z.number().int().min(0).default(10),
    })
    .prefault({}),
  stats: z.object({
    /** Live stats page shown as a forum thread. */
    enabled: z.boolean().default(true),
    threadId: z.number().int().positive(),
    intervalMs: z.number().int().min(10_000).default(60_000),
    titleTemplate: z.string().default('Razda4a zvezd stats / updated at {date}'),
    links: z
      .object({
        /** Show a per-user channel-links spoiler under each ranking row. */
        enabled: z.boolean().default(true),
      })
      .prefault({}),
  }),
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
  LOG_PRETTY: booleanString('LOG_PRETTY'),
  STAR_COUNT: z.coerce.number().int().positive().optional(),
  POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).optional(),
  DRY_RUN: booleanString('DRY_RUN'),
});
