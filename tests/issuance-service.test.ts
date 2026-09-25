import { describe, expect, it } from 'bun:test';
import type { AppConfig } from '../src/config';
import { Database } from '../src/db/Database';
import { IssuanceRepository } from '../src/db/repositories/IssuanceRepository';
import type { ForumClient } from '../src/forum/ForumClient';
import { IssuanceService } from '../src/services/IssuanceService';
import type { TelegramService } from '../src/telegram/TelegramService';
import { makeConfig, makePost, testLogger } from './helpers';

interface SetupOptions {
  config?: AppConfig;
  commentFailsOnce?: boolean;
  resolveNull?: boolean;
  alreadyOwnedCount?: number;
}

function setup(options: SetupOptions = {}) {
  const db = new Database(':memory:', testLogger);
  const repository = new IssuanceRepository(db);

  const telegram = {
    sendCalls: 0,
    resolveCalls: 0,
    resolvePost: async () => {
      telegram.resolveCalls += 1;
      return options.resolveNull ? null : { chatId: -100123, messageId: 25, message: {} as never };
    },
    getOwnPaidReactionCount: async () => options.alreadyOwnedCount ?? 0,
    sendStarReaction: async () => {
      telegram.sendCalls += 1;
      return { paidReactions: 1, ownCount: 1 };
    },
    getBalance: async () => 100,
  };

  let failComment = options.commentFailsOnce ?? false;
  const forum = {
    commentCalls: 0,
    createComment: async (postId: number) => {
      forum.commentCalls += 1;
      if (failComment) {
        failComment = false;
        throw new Error('forum exploded');
      }
      return {
        comment: {
          post_comment_id: 555,
          post_id: postId,
          poster_user_id: 1,
          poster_username: 'bot',
        },
      };
    },
  };

  const service = new IssuanceService({
    config: options.config ?? makeConfig(),
    forum: forum as unknown as ForumClient,
    telegram: telegram as unknown as TelegramService,
    repository,
    logger: testLogger,
    selfForumUserId: 1,
  });

  return { db, repository, telegram, forum, service };
}

describe('IssuanceService', () => {
  it('issues a star then writes the confirmation comment', async () => {
    const { service, repository, telegram, forum } = setup();

    const outcome = await service.process(makePost());

    expect(outcome).toMatchObject({ kind: 'processed', commentId: 555 });
    expect(telegram.sendCalls).toBe(1);
    expect(forum.commentCalls).toBe(1);
    expect(repository.findByPostId(100)?.status).toBe('commented');
  });

  it('is idempotent: the same post is never processed twice', async () => {
    const { service, telegram } = setup();

    await service.process(makePost());
    const second = await service.process(makePost());

    expect(second).toMatchObject({ kind: 'already', status: 'commented' });
    expect(telegram.sendCalls).toBe(1);
  });

  it('skips posts that already have comments (lost database fallback)', async () => {
    const { service, repository, telegram } = setup();

    const outcome = await service.process(makePost({ post_id: 101, post_comment_count: 2 }));

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'comments_present' });
    expect(telegram.sendCalls).toBe(0);
    expect(repository.findByPostId(101)?.skipReason).toBe('comments_present');
  });

  it('ignores posts without a Telegram link (re-checked on next poll)', async () => {
    const { service, telegram, repository } = setup();

    const outcome = await service.process(
      makePost({ post_id: 102, post_body_html: '<div>nope</div>' }),
    );

    expect(outcome).toMatchObject({ kind: 'ignored', reason: 'no_tg_link' });
    expect(telegram.sendCalls).toBe(0);
    expect(repository.findByPostId(102)).toBeNull();
  });

  it('ignores the first post and its own posts', async () => {
    const { service } = setup();

    expect(
      await service.process(makePost({ post_id: 103, post_is_first_post: true })),
    ).toMatchObject({
      kind: 'ignored',
      reason: 'first_post',
    });
    expect(await service.process(makePost({ post_id: 104, poster_user_id: 1 }))).toMatchObject({
      kind: 'ignored',
      reason: 'own_post',
    });
  });

  it('does not spend stars in dry run mode', async () => {
    const config = makeConfig();
    config.star = { ...config.star, dryRun: true };
    const { service, telegram, repository } = setup({ config });

    const outcome = await service.process(makePost({ post_id: 105 }));

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'dry_run' });
    expect(telegram.sendCalls).toBe(0);
    expect(repository.findByPostId(105)).toBeNull();
  });

  it('keeps star_sent when only the comment fails, and retries only the comment', async () => {
    const { service, repository, telegram } = setup({ commentFailsOnce: true });

    const first = await service.process(makePost({ post_id: 106 }));
    expect(first).toMatchObject({ kind: 'failed', retryable: true });
    expect(telegram.sendCalls).toBe(1);
    expect(repository.findByPostId(106)?.status).toBe('star_sent');

    const second = await service.process(makePost({ post_id: 106 }));
    expect(second).toMatchObject({ kind: 'processed' });
    expect(telegram.sendCalls).toBe(1);
    expect(repository.findByPostId(106)?.status).toBe('commented');
  });

  it('marks unresolvable links as permanent failures', async () => {
    const { service, repository } = setup({ resolveNull: true });

    const first = await service.process(makePost({ post_id: 107 }));
    expect(first).toMatchObject({ kind: 'failed', retryable: false });
    expect(repository.findByPostId(107)?.skipReason).toBe('permanent');

    const second = await service.process(makePost({ post_id: 107 }));
    expect(second).toMatchObject({ kind: 'already', status: 'failed_permanent' });
  });

  it('supports disabling confirmation comments', async () => {
    const config = makeConfig();
    config.comment = { ...config.comment, enabled: false };
    const { service, forum, repository } = setup({ config });

    const outcome = await service.process(makePost({ post_id: 108 }));

    expect(outcome).toMatchObject({ kind: 'processed', commentId: null });
    expect(forum.commentCalls).toBe(0);
    expect(repository.findByPostId(108)?.status).toBe('commented');
  });

  it('does not double-charge when the star is already present', async () => {
    const { service, repository, telegram } = setup({ alreadyOwnedCount: 1 });

    const outcome = await service.process(makePost({ post_id: 109 }));

    expect(outcome).toMatchObject({ kind: 'processed' });
    expect(telegram.sendCalls).toBe(0);
    expect(repository.findByPostId(109)?.status).toBe('commented');
  });
});
