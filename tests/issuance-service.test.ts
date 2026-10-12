import { describe, expect, it } from 'bun:test';
import type { AppConfig } from '../src/config';
import { DEFAULT_AD_TEMPLATE } from '../src/config/defaults';
import { Cooldown } from '../src/core/async';
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
  user_id: number;
  message: string;
  message_state?: string;
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
  latestPost?: { chatId: number; messageId: number } | null;
  resolvePostMap?: Record<string, { chatId: number; messageId: number } | null>;
  resolveLatestMap?: Record<string, { chatId: number; messageId: number } | null>;
  paidDisabledChats?: number[];
}

const isAd = (body: string): boolean => body.trimStart().startsWith('[ad=');

function setup(options: SetupOptions = {}) {
  const db = new Database(':memory:', testLogger);
  const repository = new IssuanceRepository(db);

  const sent: { chatId: number; messageId: number; count: number }[] = [];

  const telegram = {
    sendCalls: 0,
    resolveCalls: 0,
    latestCalls: 0,
    ownedCount: options.ownedCount ?? 0,
    resolvePost: async (url: string) => {
      telegram.resolveCalls += 1;
      if (options.resolvePostMap) return (options.resolvePostMap[url] ?? null) as never;
      return options.resolveNull ? null : { chatId: -100123, messageId: 25, message: {} as never };
    },
    resolveLatestPost: async (username: string) => {
      telegram.latestCalls += 1;
      if (options.resolveLatestMap) return options.resolveLatestMap[username] ?? null;
      return options.latestPost === undefined
        ? { chatId: -100777, messageId: 42 }
        : options.latestPost;
    },
    getOwnPaidReactionCount: async () => telegram.ownedCount,
    hasPaidReactions: async (chatId: number) => {
      if (options.paidDisabledChats) return !options.paidDisabledChats.includes(chatId);
      return !options.paidReactionsDisabled;
    },
    sendStarReaction: async (chatId: number, messageId: number, count: number) => {
      telegram.sendCalls += 1;
      sent.push({ chatId, messageId, count });
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
          user_id: 1,
          username: 'bot',
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
                user_id: 1,
                username: 'bot',
                message: CONFIRMATION_BODY,
                message_state: 'visible',
              },
            ]
          : []),
        ...posted.map((p) => ({
          post_comment_id: p.id,
          post_id: postId,
          user_id: 1,
          username: 'bot',
          message: p.body,
          message_state: 'visible',
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
    cooldown: new Cooldown(0),
  });

  return { db, repository, telegram, forum, service, sent };
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

  it('skips a post when our own comment is already there (lost database fallback)', async () => {
    const { service, repository, telegram } = setup({
      existingComments: [
        { post_comment_id: 777, user_id: 1, message: 'что-то', message_state: 'visible' },
      ],
    });

    const outcome = await service.process(makePost({ post_id: 101, comment_count: 2 }));

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'comments_present' });
    expect(telegram.sendCalls).toBe(0);
    expect(repository.findByPostId(101)?.skipReason).toBe('comments_present');
  });

  it('processes a post whose comments are not ours', async () => {
    const { service, repository, telegram } = setup({
      existingComments: [
        { post_comment_id: 900, user_id: 4242, message: 'чужой коммент', message_state: 'visible' },
      ],
    });

    const outcome = await service.process(makePost({ post_id: 160, comment_count: 2 }));

    expect(outcome).toMatchObject({ kind: 'processed' });
    expect(telegram.sendCalls).toBe(1);
    expect(repository.findByPostId(160)?.status).toBe('commented');
  });

  it('notices the user when the post has no Telegram link', async () => {
    const config = makeConfig();
    const { service, telegram, repository, forum } = setup({ config });

    const outcome = await service.process(
      makePost({ post_id: 102, message_html: '<div>nope</div>' }),
    );

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'no_link_found' });
    expect(telegram.sendCalls).toBe(0);
    expect(repository.findByPostId(102)?.status).toBe('skipped');
    expect(repository.findByPostId(102)?.skipReason).toBe('no_link_found');

    // Same unified notice path as the other checks: one message + the ad.
    expect(confirmationCount(forum.createdBodies)).toBe(1);
    expect(adCount(forum.createdBodies)).toBe(1);
    expect(forum.createdBodies[0]).toContain(config.comment.noLinkFoundText);
    expect(forum.createdBodies[0]).toContain('intimacy');
  });

  it('ignores the first post and its own posts', async () => {
    const { service } = setup();

    expect(await service.process(makePost({ post_id: 103, is_first_post: true }))).toMatchObject({
      kind: 'ignored',
      reason: 'first_post',
    });
    expect(await service.process(makePost({ post_id: 104, user_id: 1 }))).toMatchObject({
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

  it('notices the user when the link cannot be resolved', async () => {
    const config = makeConfig();
    const { service, repository, telegram, forum } = setup({ config, resolveNull: true });

    const outcome = await service.process(makePost({ post_id: 108 }));

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'link_unresolvable' });
    expect(telegram.sendCalls).toBe(0);
    expect(repository.findByPostId(108)?.skipReason).toBe('link_unresolvable');
    expect(confirmationCount(forum.createdBodies)).toBe(1);
    expect(adCount(forum.createdBodies)).toBe(1);
    expect(forum.createdBodies[0]).toContain(config.comment.linkUnresolvableText);
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
        {
          post_comment_id: 777,
          user_id: 1,
          message: CONFIRMATION_BODY,
          message_state: 'visible',
        },
      ],
    });

    const outcome = await service.process(makePost({ post_id: 114 }));

    expect(outcome).toMatchObject({ kind: 'processed', commentId: 777, adCommentId: 555 });
    // Only the ad was posted; the confirmation was adopted.
    expect(forum.createdBodies).toHaveLength(1);
    expect(isAd(forum.createdBodies[0]!)).toBe(true);
    expect(repository.findByPostId(114)?.status).toBe('commented');
  });

  it('does not adopt a comment that was deleted by moderators', async () => {
    const { service, repository } = setup({
      confirmationFailsOnce: true,
      existingComments: [
        {
          post_comment_id: 777,
          user_id: 1,
          message: CONFIRMATION_BODY,
          message_state: 'deleted',
        },
      ],
    });

    const outcome = await service.process(makePost({ post_id: 116 }));

    // The API still returns soft-deleted comments; treating one as ours would
    // mark the post handled while nobody can see our confirmation.
    expect(outcome).toMatchObject({ kind: 'failed', retryable: true });
    expect(repository.findByPostId(116)?.commentId).toBeNull();
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
    config.retry = { ...config.retry, failedPostCooldownMs: 3_600_000 };
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

  it('stars the latest post for a bare channel link', async () => {
    const { service, telegram, repository, forum } = setup({
      latestPost: { chatId: -100777, messageId: 42 },
    });

    const outcome = await service.process(
      makePost({
        post_id: 140,
        message_html: '<a href="https://t.me/flexinout">https://t.me/flexinout</a>',
      }),
    );

    expect(outcome).toMatchObject({ kind: 'processed' });
    expect(telegram.latestCalls).toBe(1);
    expect(telegram.sendCalls).toBe(1);
    expect(forum.createdBodies).toHaveLength(2);
    expect(repository.findByPostId(140)?.status).toBe('commented');
    expect(repository.findByPostId(140)?.tgMessageId).toBe(42);
  });

  it('notifies when a bare channel link has no posts', async () => {
    const { service, telegram, repository, forum } = setup({ latestPost: null });

    const outcome = await service.process(
      makePost({
        post_id: 141,
        message_html: '<a href="https://t.me/emptychannel">https://t.me/emptychannel</a>',
      }),
    );

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'no_posts_found' });
    expect(telegram.sendCalls).toBe(0);
    expect(forum.createdBodies).toHaveLength(2);
    expect(forum.createdBodies[0]).toBe(
      '[user="4371739"]intimacy[/user], не нашёл пост в канале, скиньте ссылку на конкретный пост!',
    );
    expect(repository.findByPostId(141)?.skipReason).toBe('no_posts_found');
  });

  it('picks the first star-able link among many candidates', async () => {
    const { service, forum, repository, sent } = setup({
      resolvePostMap: { 'https://t.me/goodchannel/7': { chatId: -1002, messageId: 7 } },
      resolveLatestMap: {
        paidchannel: { chatId: -1001, messageId: 1 },
        emptychannel: null,
      },
      paidDisabledChats: [-1001],
    });

    const html =
      '<a href="https://youtube.com/watch?v=x">yt</a> ' +
      '<a href="https://t.me/paidchannel">paid</a> ' +
      '<a href="https://t.me/goodchannel/7">good</a> ' +
      '<a href="https://t.me/emptychannel">empty</a>';

    const outcome = await service.process(makePost({ post_id: 150, message_html: html }));

    expect(outcome).toMatchObject({ kind: 'processed', link: 'https://t.me/goodchannel/7' });
    expect(sent).toEqual([{ chatId: -1002, messageId: 7, count: 1 }]);
    expect(repository.findByPostId(150)?.status).toBe('commented');
    expect(repository.findByPostId(150)?.tgLink).toBe('https://t.me/goodchannel/7');
    expect(confirmationCount(forum.createdBodies)).toBe(1);
    expect(adCount(forum.createdBodies)).toBe(1);
  });

  it('stars only the first valid link and notes the extra links', async () => {
    const config = makeConfig();
    const { service, sent, forum } = setup({
      config,
      resolvePostMap: {
        'https://t.me/alpha/1': { chatId: -2001, messageId: 1 },
        'https://t.me/beta/2': { chatId: -2002, messageId: 2 },
      },
    });

    const html = '<a href="https://t.me/alpha/1">a</a> <a href="https://t.me/beta/2">b</a>';
    const outcome = await service.process(makePost({ post_id: 151, message_html: html }));

    expect(outcome).toMatchObject({ kind: 'processed', link: 'https://t.me/alpha/1' });
    expect(sent).toEqual([{ chatId: -2001, messageId: 1, count: 1 }]);
    expect(forum.createdBodies[0]).toContain(config.comment.multipleLinksText);
  });

  it('notices paid_reactions_disabled when every candidate has stars disabled', async () => {
    const { service, telegram, repository, forum } = setup({
      resolvePostMap: { 'https://t.me/alpha/1': { chatId: -1, messageId: 1 } },
      resolveLatestMap: { bravo: { chatId: -2, messageId: 2 } },
      paidDisabledChats: [-1, -2],
    });

    const html = '<a href="https://t.me/alpha/1">a</a> <a href="https://t.me/bravo">b</a>';
    const outcome = await service.process(makePost({ post_id: 152, message_html: html }));

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'paid_reactions_disabled' });
    expect(telegram.sendCalls).toBe(0);
    expect(forum.createdBodies).toHaveLength(2);
    expect(repository.findByPostId(152)?.skipReason).toBe('paid_reactions_disabled');
  });

  it('reports the first failure reason when no candidate is usable', async () => {
    const { service, telegram, repository } = setup({
      resolveLatestMap: { empty: null },
      resolvePostMap: { 'https://t.me/xray/1': null },
    });

    const html = '<a href="https://t.me/empty">e</a> <a href="https://t.me/xray/1">x</a>';
    const outcome = await service.process(makePost({ post_id: 153, message_html: html }));

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'no_posts_found' });
    expect(telegram.sendCalls).toBe(0);
    expect(repository.findByPostId(153)?.skipReason).toBe('no_posts_found');
  });
});
