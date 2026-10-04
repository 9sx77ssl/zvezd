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
      maxBackfillPages: 0,
    },
    pacing: { cooldownMs: 0, starVerifyDelayMs: 0, commentVerifyDelayMs: 0 },
    balance: { checkIntervalMs: 60_000 },
    star: { count: 1, dryRun: false },
    comment: {
      enabled: true,
      text: '+',
      template: '[user="{user_id}"]{username}[/user], {text}',
      paidReactionsDisabledText: 'у вас выключены платные реакции, включите их и приходите еще!',
      noPostsFoundText: 'не нашёл пост в канале, скиньте ссылку на конкретный пост!',
      noLinkFoundText: 'не нашёл ссылку в посте, скиньте ссылку на канал или конкретный пост!',
      linkUnresolvableText: 'не смог открыть ссылку, проверьте её и скиньте ещё раз!',
      ad: { enabled: true, template: DEFAULT_AD_TEMPLATE },
    },
    rateLimit: { readPerMinute: 240, writePerMinute: 20 },
    retry: { attempts: 3, delayMs: 1, maxDelayMs: 2, failedPostCooldownMs: 0 },
    database: { path: ':memory:' },
    auth: { tokenFile: '.env', tokenCheckIntervalMs: 60_000, logEveryChecks: 10 },
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
    user_id: 4371739,
    username: 'intimacy',
    post_date: 1_700_000_000,
    message: '[MEDIA=telegram]flexinout/25[/MEDIA]',
    message_html: '<a href="https://t.me/flexinout/25">https://t.me/flexinout/25</a>',
    message_plain_text: '[MEDIA]',
    is_first_post: false,
    message_state: 'visible',
    ...overrides,
  };
}
