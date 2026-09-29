import type { AppConfig } from '../src/config';
import { DEFAULT_AD_TEMPLATE } from '../src/config/defaults';
import { Logger } from '../src/core/logger';
import type { ForumPost } from '../src/forum/types';

export const testLogger = Logger.create({ level: 'fatal', pretty: false });

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    forum: {
      baseUrl: 'https://api.lolz.team',
      threadId: 1,
      requestTimeoutMs: 1_000,
      order: 'natural_reverse',
      token: 'test-token',
    },
    polling: {
      intervalMs: 1_000,
      pageLimit: 20,
      pageDelayMs: 0,
      postDelayMs: 0,
      maxBackfillPages: 0,
      idlePage: 1,
    },
    pacing: { starToCommentMs: 0, commentToAdMs: 0, starVerifyDelayMs: 0, commentVerifyDelayMs: 0 },
    balance: { checkIntervalMs: 60_000 },
    star: { count: 1, dryRun: false },
    comment: {
      enabled: true,
      text: '+',
      template: '[user="{user_id}"]{username}[/user], {text}',
      paidReactionsDisabledText: 'у вас выключены платные реакции, включите их и приходите еще!',
      noPostsFoundText: 'не нашёл пост в канале, скиньте ссылку на конкретный пост!',
      ad: { enabled: true, template: DEFAULT_AD_TEMPLATE },
    },
    rateLimit: { readPerMinute: 240, writePerMinute: 20 },
    retry: { attempts: 3, delayMs: 1, maxDelayMs: 2, cooldownMs: 0 },
    database: { path: ':memory:' },
    telegram: { sessionPath: ':memory:', apiId: 1, apiHash: 'hash' },
    stats: {
      enabled: false,
      threadId: 1,
      intervalMs: 60_000,
      titleTemplate: 'stats - {date}',
      links: { enabled: true },
    },
    logging: { level: 'fatal', pretty: false },
  };

  return { ...base, ...overrides };
}

export function makePost(overrides: Partial<ForumPost> = {}): ForumPost {
  return {
    post_id: 100,
    thread_id: 1,
    poster_user_id: 4371739,
    poster_username: 'intimacy',
    post_create_date: 1_700_000_000,
    post_body: '[MEDIA=telegram]flexinout/25[/MEDIA]',
    post_body_html: '<a href="https://t.me/flexinout/25">https://t.me/flexinout/25</a>',
    post_body_plain_text: '[MEDIA]',
    post_is_first_post: false,
    post_is_published: true,
    post_is_deleted: false,
    ...overrides,
  };
}
