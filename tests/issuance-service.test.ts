import { describe, expect, it } from 'bun:test';
import type { AppConfig } from '../src/config';
import { DEFAULT_AD_TEMPLATE } from '../src/config/defaults';
import { PaidReactionsDisabledError } from '../src/core/errors';
import { Database } from '../src/db/Database';
import { IssuanceRepository } from '../src/db/repositories/IssuanceRepository';
import type { ForumClient } from '../src/forum/ForumClient';
import { IssuanceService } from '../src/services/IssuanceService';
import type { TelegramService } from '../src/telegram/TelegramService';
import { makeConfig, makePost, testLogger } from './helpers';

const CONFIRMATION_BODY = '[user="4371739"]intimacy[/user], +';

interface CommentRow {
  post_comment_id: number;
  poster_user_id: number;
  post_comment_body: string;
}

interface SetupOptions {
  config?: AppConfig;
  confirmationFailsOnce?: boolean;
  adFailsOnce?: boolean;
  resolveNull?: boolean;
  ownedCount?: number;
  existingComments?: CommentRow[];
  adoptAfterFailure?: boolean;
  sendThrowsButApplied?: boolean;
  paidReactionsDisabled?: boolean;
  sendThrowsPaidDisabled?: boolean;
}

const isAd = (body: string): boolean => body.trimStart().startsWith('[ad=');

function setup(options: SetupOptions = {}) {
  const db = new Database(':memory:', testLogger);
  const repository = new IssuanceRepository(db);

  const telegram = {
    sendCalls: 0,
    resolveCalls: 0,
    ownedCount: options.ownedCount ?? 0,
    resolvePost: async () => {
      telegram.resolveCalls += 1;
      return options.resolveNull ? null : { chatId: -100123, messageId: 25, message: {} as never };
    },
    getOwnPaidReactionCount: async () => telegram.ownedCount,
    hasPaidReactions: async () => !options.paidReactionsDisabled,
    sendStarReaction: async () => {
      telegram.sendCalls += 1;
      if (options.sendThrowsPaidDisabled) {
        throw new PaidReactionsDisabledError('paid reactions disabled');
      }
      telegram.ownedCount += 1;
      if (options.sendThrowsButApplied) {
        throw new Error(
          'Type assertion failed: expected updateMessageReactions, got updateEditChannelMessage',
        );
      }
      return { paidReactions: 1, ownCount: telegram.ownedCount };
    },
    getBalance: async () => 100,
  };

  let failConfirmation = options.confirmationFailsOnce ?? false;
  let failAd = options.adFailsOnce ?? false;
  let adopted = false;
  let nextId = 555;
  const posted: { id: number; body: string }[] = [];

  const forum = {
    createdBodies: [] as string[],
    createComment: async (postId: number, body: string) => {
      if (!isAd(body) && failConfirmation) {
        failConfirmation = false;
        if (options.adoptAfterFailure) adopted = true;
        throw new Error('forum exploded');
      }
      if (isAd(body) && failAd) {
        failAd = false;
        throw new Error('ad exploded');
      }
      forum.createdBodies.push(body);
      const id = nextId++;
      posted.push({ id, body });
      return {
        comment: {
          post_comment_id: id,
          post_id: postId,
          poster_user_id: 1,
          poster_username: 'bot',
        },
      };
    },
    getComments: async (postId: number) => ({
      comments: [
        ...(options.existingComments ?? []),
        ...(adopted
          ? [
              {
                post_comment_id: 777,
                post_id: postId,
                poster_user_id: 1,
                poster_username: 'bot',
                post_comment_body: CONFIRMATION_BODY,
              },
            ]
          : []),
        ...posted.map((p) => ({
          post_comment_id: p.id,
          post_id: postId,
          poster_user_id: 1,
          poster_username: 'bot',
          post_comment_body: p.body,
        })),
      ],
    }),
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

const confirmationCount = (bodies: string[]): number => bodies.filter((b) => !isAd(b)).length;
const adCount = (bodies: string[]): number => bodies.filter(isAd).length;

describe('IssuanceService', () => {
  it('issues a star, a confirmation comment and an ad comment', async () => {
    const { service, repository, telegram, forum } = setup();

    const outcome = await service.process(makePost());

    expect(outcome).toMatchObject({ kind: 'processed', commentId: 555, adCommentId: 556 });
    expect(telegram.sendCalls).toBe(1);
    expect(forum.createdBodies).toHaveLength(2);
    expect(forum.createdBodies[0]).toBe(CONFIRMATION_BODY);
    expect(forum.createdBodies[1]).toBe(DEFAULT_AD_TEMPLATE);
    expect(repository.findByPostId(100)?.status).toBe('commented');
    expect(repository.findByPostId(100)?.commentId).toBe(555);
    expect(repository.findByPostId(100)?.adCommentId).toBe(556);
  });

  it('is idempotent: the same post is never processed twice', async () => {
    const { service, telegram, forum } = setup();

    await service.process(makePost());
    const second = await service.process(makePost());

    expect(second).toMatchObject({ kind: 'already', status: 'commented' });
    expect(telegram.sendCalls).toBe(1);
    expect(forum.createdBodies).toHaveLength(2);
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

  it('keeps star_sent when the confirmation fails, then completes both comments', async () => {
    const { service, repository, telegram, forum } = setup({ confirmationFailsOnce: true });

    const first = await service.process(makePost({ post_id: 106 }));
    expect(first).toMatchObject({ kind: 'failed', retryable: true });
    expect(telegram.sendCalls).toBe(1);
    expect(repository.findByPostId(106)?.status).toBe('star_sent');

    const second = await service.process(makePost({ post_id: 106 }));
    expect(second).toMatchObject({ kind: 'processed', commentId: 555, adCommentId: 556 });
    expect(telegram.sendCalls).toBe(1);
    expect(confirmationCount(forum.createdBodies)).toBe(1);
    expect(adCount(forum.createdBodies)).toBe(1);
    expect(repository.findByPostId(106)?.status).toBe('commented');
  });

  it('keeps confirmed when the ad fails, then posts only the ad on retry', async () => {
    const { service, repository, telegram, forum } = setup({ adFailsOnce: true });

    const first = await service.process(makePost({ post_id: 107 }));
    expect(first).toMatchObject({ kind: 'failed', retryable: true });
    expect(telegram.sendCalls).toBe(1);
    expect(repository.findByPostId(107)?.status).toBe('confirmed');
    expect(confirmationCount(forum.createdBodies)).toBe(1);

    const second = await service.process(makePost({ post_id: 107 }));
    expect(second).toMatchObject({ kind: 'processed', adCommentId: 556 });
    expect(telegram.sendCalls).toBe(1);
    // The confirmation must not be posted a second time.
    expect(confirmationCount(forum.createdBodies)).toBe(1);
    expect(adCount(forum.createdBodies)).toBe(1);
    expect(repository.findByPostId(107)?.status).toBe('commented');
  });

  it('marks unresolvable links as permanent failures', async () => {
    const { service, repository } = setup({ resolveNull: true });

    const first = await service.process(makePost({ post_id: 108 }));
    expect(first).toMatchObject({ kind: 'failed', retryable: false });
    expect(repository.findByPostId(108)?.skipReason).toBe('permanent');

    const second = await service.process(makePost({ post_id: 108 }));
    expect(second).toMatchObject({ kind: 'already', status: 'failed_permanent' });
  });

  it('still posts the ad when confirmation comments are disabled', async () => {
    const config = makeConfig();
    config.comment = { ...config.comment, enabled: false };
    const { service, forum, repository } = setup({ config });

    const outcome = await service.process(makePost({ post_id: 109 }));

    expect(outcome).toMatchObject({ kind: 'processed', commentId: null, adCommentId: 555 });
    expect(forum.createdBodies).toHaveLength(1);
    expect(isAd(forum.createdBodies[0]!)).toBe(true);
    expect(repository.findByPostId(109)?.status).toBe('commented');
  });

  it('posts only the confirmation when the ad is disabled', async () => {
    const config = makeConfig();
    config.comment = { ...config.comment, ad: { ...config.comment.ad, enabled: false } };
    const { service, forum, repository } = setup({ config });

    const outcome = await service.process(makePost({ post_id: 110 }));

    expect(outcome).toMatchObject({ kind: 'processed', commentId: 555, adCommentId: null });
    expect(forum.createdBodies).toHaveLength(1);
    expect(forum.createdBodies[0]).toBe(CONFIRMATION_BODY);
    expect(repository.findByPostId(110)?.status).toBe('commented');
  });

  it('allows the same Telegram post to be starred again on a later submission', async () => {
    const { service, telegram, repository } = setup();

    const first = await service.process(makePost({ post_id: 111 }));
    expect(first).toMatchObject({ kind: 'processed' });
    expect(telegram.sendCalls).toBe(1);

    // Same TG link, but a brand new forum post (e.g. the next day).
    const second = await service.process(makePost({ post_id: 112 }));
    expect(second).toMatchObject({ kind: 'processed' });
    expect(telegram.sendCalls).toBe(2);
    expect(repository.findByPostId(112)?.tgBaseline).toBe(1);
  });

  it('does not charge again when the star already went through for the same submission', async () => {
    const { service, repository, telegram } = setup();

    repository.reserve({
      threadId: 1,
      postId: 113,
      posterUserId: 42,
      posterUsername: 'alice',
      tgLink: 'https://t.me/flexinout/25',
    });
    repository.setStarBaseline(113, 0);
    telegram.ownedCount = 1;

    const outcome = await service.process(makePost({ post_id: 113 }));

    expect(outcome).toMatchObject({ kind: 'processed' });
    expect(telegram.sendCalls).toBe(0);
    expect(repository.findByPostId(113)?.status).toBe('commented');
  });

  it('does not post a duplicate confirmation when it already exists', async () => {
    const { service, repository, forum } = setup({
      existingComments: [
        { post_comment_id: 777, poster_user_id: 1, post_comment_body: CONFIRMATION_BODY },
      ],
    });

    const outcome = await service.process(makePost({ post_id: 114 }));

    expect(outcome).toMatchObject({ kind: 'processed', commentId: 777, adCommentId: 555 });
    // Only the ad was posted; the confirmation was adopted.
    expect(forum.createdBodies).toHaveLength(1);
    expect(isAd(forum.createdBodies[0]!)).toBe(true);
    expect(repository.findByPostId(114)?.status).toBe('commented');
  });

  it('adopts a confirmation that went through despite an error', async () => {
    const { service, repository, forum } = setup({
      confirmationFailsOnce: true,
      adoptAfterFailure: true,
    });

    const outcome = await service.process(makePost({ post_id: 115 }));

    expect(outcome).toMatchObject({ kind: 'processed', commentId: 777, adCommentId: 555 });
    expect(confirmationCount(forum.createdBodies)).toBe(0);
    expect(adCount(forum.createdBodies)).toBe(1);
    expect(repository.findByPostId(115)?.status).toBe('commented');
  });

  it('recovers when the star send throws but the reaction was applied', async () => {
    const { service, repository, telegram, forum } = setup({ sendThrowsButApplied: true });

    const outcome = await service.process(makePost({ post_id: 116 }));

    expect(outcome).toMatchObject({ kind: 'processed', commentId: 555, adCommentId: 556 });
    expect(telegram.sendCalls).toBe(1);
    expect(forum.createdBodies).toHaveLength(2);
    expect(repository.findByPostId(116)?.status).toBe('commented');
  });

  it('notifies the user and posts the ad when paid reactions are disabled', async () => {
    const { service, repository, telegram, forum } = setup({ paidReactionsDisabled: true });

    const outcome = await service.process(makePost({ post_id: 120 }));

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'paid_reactions_disabled' });
    expect(telegram.sendCalls).toBe(0);
    expect(forum.createdBodies).toHaveLength(2);
    expect(forum.createdBodies[0]).toBe(
      '[user="4371739"]intimacy[/user], у вас выключены платные реакции, включите их и приходите еще!',
    );
    expect(forum.createdBodies[1]).toBe(DEFAULT_AD_TEMPLATE);
    expect(repository.findByPostId(120)?.status).toBe('skipped');
    expect(repository.findByPostId(120)?.skipReason).toBe('paid_reactions_disabled');
    expect(repository.findByPostId(120)?.commentId).toBe(555);
    expect(repository.findByPostId(120)?.adCommentId).toBe(556);
  });

  it('treats a paid-reaction send error as disabled and notifies', async () => {
    const { service, repository, telegram, forum } = setup({ sendThrowsPaidDisabled: true });

    const outcome = await service.process(makePost({ post_id: 121 }));

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'paid_reactions_disabled' });
    expect(telegram.sendCalls).toBe(1);
    expect(forum.createdBodies).toHaveLength(2);
    expect(repository.findByPostId(121)?.skipReason).toBe('paid_reactions_disabled');
  });

  it('retries a post once its attempt cooldown elapsed', async () => {
    const { service, repository, telegram } = setup();

    repository.reserve({
      threadId: 1,
      postId: 130,
      posterUserId: 42,
      posterUsername: 'alice',
      tgLink: 'https://t.me/flexinout/25',
    });
    repository.bumpAttempts(130);
    repository.bumpAttempts(130);
    repository.bumpAttempts(130);
    repository.markFailed(130, 'boom', true);

    const outcome = await service.process(makePost({ post_id: 130 }));

    expect(outcome).toMatchObject({ kind: 'processed' });
    expect(telegram.sendCalls).toBe(1);
    expect(repository.findByPostId(130)?.status).toBe('commented');
  });

  it('keeps waiting while the attempt cooldown has not elapsed', async () => {
    const config = makeConfig();
    config.retry = { ...config.retry, cooldownMs: 3_600_000 };
    const { service, repository } = setup({ config });

    repository.reserve({
      threadId: 1,
      postId: 131,
      posterUserId: 42,
      posterUsername: 'alice',
      tgLink: 'https://t.me/flexinout/25',
    });
    repository.bumpAttempts(131);
    repository.bumpAttempts(131);
    repository.bumpAttempts(131);
    repository.markFailed(131, 'boom', true);

    const outcome = await service.process(makePost({ post_id: 131 }));

    expect(outcome).toMatchObject({ kind: 'already', status: 'attempts_exhausted' });
  });
});
