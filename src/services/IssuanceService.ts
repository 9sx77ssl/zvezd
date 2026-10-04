import type { AppConfig } from '../config';
import { type ActionGate, sleep } from '../core/async';
import {
  ForumApiError,
  LinkUnresolvableError,
  NoLinkFoundError,
  NoPostsFoundError,
  NoticeError,
  PaidReactionsDisabledError,
  PermanentError,
} from '../core/errors';
import { errorToLog, type Logger } from '../core/logger';
import {
  type IgnoreReason,
  type IssuanceStatus,
  NOTICES,
  type NoticeKind,
  type NoticeReason,
  type SkipReason,
} from '../core/vocab';
import type { IssuanceRepository } from '../db/repositories/IssuanceRepository';
import type { IssuanceRecord } from '../db/types';
import type { ForumClient } from '../forum/ForumClient';
import type { ForumPost } from '../forum/types';
import { runPreChecks } from '../issuance/checks';
import {
  distinctChannelCount,
  parseTgChannelLink,
  parseTgPostLink,
  selectLinkCandidates,
  type TgLink,
} from '../telegram/link-parser';
import type { TelegramService } from '../telegram/TelegramService';
import { renderComment } from './comment-renderer';

/** Outcome-only statuses that are never persisted as such. */
export type SyntheticStatus = 'failed_permanent' | 'attempts_exhausted';

/** A candidate link resolved to a concrete Telegram message. */
interface ResolvedTarget {
  link: TgLink;
  chatId: number;
  messageId: number;
}

function linkFromUrl(url: string | null): TgLink | null {
  if (!url) return null;
  return parseTgPostLink(url) ?? parseTgChannelLink(url);
}

export type IssuanceOutcome =
  | {
      kind: 'processed';
      postId: number;
      username: string;
      link: string;
      commentId: number | null;
      adCommentId: number | null;
      balance?: number;
    }
  | { kind: 'already'; postId: number; status: IssuanceStatus | SyntheticStatus }
  | { kind: 'ignored'; postId: number; reason: IgnoreReason }
  | { kind: 'skipped'; postId: number; reason: SkipReason | NoticeReason }
  | { kind: 'failed'; postId: number; retryable: boolean; error: string };

export interface IssuanceServiceDeps {
  config: AppConfig;
  forum: ForumClient;
  telegram: TelegramService;
  repository: IssuanceRepository;
  logger: Logger;
  selfForumUserId: number;
  /** Shared pacing gate between outgoing actions (star, comments). */
  cooldown: ActionGate;
}

/**
 * The heart of the bot: processes a single forum post through the strict
 * state machine:
 *
 *   star -> confirmation comment -> ad comment
 *
 * Every step is persisted before the next one begins, so a crash (or a lost
 * database) can never charge the same post twice, and an interrupted run only
 * repeats the missing steps:
 *
 *   pending   -> claimed the post, nothing done yet
 *   star_sent -> star confirmed, comments missing
 *   confirmed -> confirmation comment posted, ad missing
 *   commented -> fully done (terminal)
 *   skipped   -> intentionally not processed (terminal)
 *   failed    -> retryable or permanent failure
 */
export class IssuanceService {
  private readonly config: AppConfig;
  private readonly forum: ForumClient;
  private readonly telegram: TelegramService;
  private readonly repository: IssuanceRepository;
  private readonly logger: Logger;
  private readonly selfForumUserId: number;
  private readonly cooldown: ActionGate;
  private readonly dryRunReported = new Set<number>();

  constructor(deps: IssuanceServiceDeps) {
    this.config = deps.config;
    this.forum = deps.forum;
    this.telegram = deps.telegram;
    this.repository = deps.repository;
    this.logger = deps.logger.child('Issuance');
    this.selfForumUserId = deps.selfForumUserId;
    this.cooldown = deps.cooldown;
  }

  async process(post: ForumPost): Promise<IssuanceOutcome> {
    const postId = post.post_id;
    const log = this.logger.child('Post', { postId, username: post.username });
    const links = selectLinkCandidates(post.message_html);
    const ctx = { selfForumUserId: this.selfForumUserId, link: links[0] ?? null };

    // Silent pre-reservation checks (first post, deleted/hidden, own post).
    const pre = runPreChecks(post, ctx);
    if (pre) {
      if (pre.kind === 'ignore') return { kind: 'ignored', postId, reason: pre.reason };
      return { kind: 'skipped', postId, reason: pre.reason };
    }

    if (this.config.star.dryRun) {
      const first = links[0];
      if (first && !this.dryRunReported.has(postId)) {
        this.dryRunReported.add(postId);
        log.info('Dry run: would issue star', {
          link: first.url,
          candidates: links.length,
          stars: this.config.star.count,
          comment: this.config.comment.enabled,
        });
      }
      return { kind: 'skipped', postId, reason: 'dry_run' };
    }

    const created = this.repository.reserve({
      threadId: post.thread_id,
      postId,
      posterUserId: post.user_id,
      posterUsername: post.username,
      tgLink: links[0]?.url ?? null,
    });
    const record = this.repository.findByPostId(postId);
    if (!record) return { kind: 'failed', postId, retryable: true, error: 'reservation_lost' };

    if (!created) {
      if (record.status === 'commented' || record.status === 'skipped') {
        return { kind: 'already', postId, status: record.status };
      }
      if (record.status === 'failed' && record.skipReason === 'permanent') {
        return { kind: 'already', postId, status: 'failed_permanent' };
      }
      if (record.attempts >= this.config.retry.attempts) {
        const cooldownPassed =
          Date.now() - record.updatedAt >= this.config.retry.failedPostCooldownMs;
        if (!cooldownPassed) {
          return { kind: 'already', postId, status: 'attempts_exhausted' };
        }
        this.logger.info('Retry cooldown elapsed, resetting attempts', {
          postId,
          attempts: record.attempts,
        });
        this.repository.resetAttempts(postId);
      }
    }

    // Second safety layer for a lost database: the forum post already has
    // comments, so we assume it was handled and never spend a star on it.
    if (created && (post.comment_count ?? 0) > 0) {
      this.repository.markSkipped(postId, 'comments_present');
      log.info('Skipped: post already has comments (assumed handled)', {
        commentCount: post.comment_count,
      });
      return { kind: 'skipped', postId, reason: 'comments_present' };
    }

    this.repository.bumpAttempts(postId);

    // User-facing checks (missing link, unusable links, ...) are evaluated
    // after the claim so the notice can be persisted; they throw a NoticeError
    // handled below.
    const noticeLink = links[0]?.url ?? '';

    try {
      if (links.length === 0) throw new NoLinkFoundError(`Post has no Telegram link: ${postId}`);

      // Try the links in order and star the first one Telegram actually accepts
      // (YouTube/other hosts are already filtered out by the parser).
      const target = await this.pickTarget(post, links, record, log);
      const multipleLinks = distinctChannelCount(links) > 1;

      let balance: number | undefined;

      const needsStar = record.status !== 'star_sent' && record.status !== 'confirmed';
      if (needsStar) {
        balance = await this.issueStar(post, target, log, record);
      }

      let commentId: number | null = record.commentId;
      if (record.status !== 'confirmed') {
        const note = multipleLinks ? this.config.comment.multipleLinksText : undefined;
        commentId = await this.writeConfirmation(post, target.link.url, log, note);
      }

      const adCommentId = await this.writeAd(post, target.link.url, log);

      return {
        kind: 'processed',
        postId,
        username: post.username,
        link: target.link.url,
        commentId,
        adCommentId,
        balance,
      };
    } catch (err) {
      if (err instanceof NoticeError) {
        return this.handleNotice(post, noticeLink, log, this.noticeText(err.kind), err.reason);
      }

      const permanent = this.isPermanent(err);
      const current = this.repository.findByPostId(postId);
      const message = err instanceof Error ? err.message : String(err);

      // A star or the confirmation comment was already done and only a later
      // step failed: keep the intermediate status so the next run retries just
      // the missing steps, never the star.
      if ((current?.status === 'star_sent' || current?.status === 'confirmed') && !permanent) {
        log.warn('Issuance step failed, will retry the remaining steps', {
          status: current.status,
          ...errorToLog(err),
        });
        return { kind: 'failed', postId, retryable: true, error: message };
      }

      this.repository.markFailed(postId, message, !permanent);
      log.error('Issuance failed', { ...errorToLog(err), retryable: !permanent });
      return { kind: 'failed', postId, retryable: !permanent, error: message };
    }
  }

  private async issueStar(
    post: ForumPost,
    target: ResolvedTarget,
    log: Logger,
    record: IssuanceRecord,
  ): Promise<number> {
    const expected = this.config.star.count;
    const { link, chatId, messageId } = target;

    // The baseline is how many of our paid reactions were on this exact
    // Telegram message *before* the first attempt for THIS forum post.
    // It lets the same TG post be starred again on a later submission while
    // keeping a retry of the very same submission idempotent.
    const current = await this.telegram.getOwnPaidReactionCount(chatId, messageId);
    if (record.tgBaseline === null) {
      this.repository.setStarBaseline(post.post_id, current);
    }
    const baseline = record.tgBaseline ?? current;

    if (current >= baseline + expected) {
      this.repository.markStarSent(post.post_id, String(chatId), messageId);
      const balance = await this.telegram.getBalance();
      log.info('Star already sent for this submission, not charging again', {
        link: link.url,
        current,
        baseline,
        balance,
      });
      return balance;
    }

    // The channel must accept paid reactions; otherwise we tell the user and
    // still post the ad, instead of failing forever.
    const paidEnabled = await this.telegram.hasPaidReactions(chatId);
    if (!paidEnabled) {
      throw new PaidReactionsDisabledError(`Channel has paid reactions disabled: ${link.url}`);
    }

    log.info('Sending star reaction', {
      link: link.url,
      chatId,
      messageId,
      count: expected,
      baseline,
    });

    try {
      await this.cooldown.wait();
      const result = await this.telegram.sendStarReaction(chatId, messageId, expected);

      this.repository.markStarSent(post.post_id, String(chatId), messageId);

      const balance = await this.telegram.getBalance();
      log.info('Star confirmed', {
        link: link.url,
        paidReactions: result.paidReactions,
        ownCount: result.ownCount,
        balance,
      });

      return balance;
    } catch (err) {
      // mtcute can throw a benign assertion error (e.g. Telegram returned an
      // `updateEditChannelMessage` instead of `updateMessageReactions`) even
      // though the reaction was applied. Verify before treating it as failed.
      await sleep(this.config.pacing.starVerifyDelayMs);
      const after = await this.telegram.getOwnPaidReactionCount(chatId, messageId);
      if (after >= baseline + expected) {
        this.repository.markStarSent(post.post_id, String(chatId), messageId);
        const balance = await this.telegram.getBalance();
        log.warn('Star send threw but the reaction is present; treating as sent', {
          link: link.url,
          after,
          baseline,
          balance,
          ...errorToLog(err),
        });
        return balance;
      }

      if (err instanceof PaidReactionsDisabledError) throw err;

      // The send failed and no reaction was applied. If the channel simply has
      // paid reactions disabled, tell the user instead of retrying forever.
      const stillEnabled = await this.telegram.hasPaidReactions(chatId);
      if (!stillEnabled) {
        throw new PaidReactionsDisabledError(`Channel has paid reactions disabled: ${link.url}`, {
          cause: err,
        });
      }

      throw err;
    }
  }

  /**
   * Pick the first candidate Telegram can actually star: resolvable (a specific
   * post, or a bare channel that has posts) and accepting paid reactions. A
   * target resolved on an earlier attempt is reused so retries stick to the
   * same message.
   */
  private async pickTarget(
    post: ForumPost,
    links: readonly TgLink[],
    record: IssuanceRecord,
    log: Logger,
  ): Promise<ResolvedTarget> {
    if (record.tgChatId && record.tgMessageId) {
      const link = linkFromUrl(record.tgLink) ?? links[0];
      if (link) {
        return { link, chatId: Number(record.tgChatId), messageId: record.tgMessageId };
      }
    }

    let firstFailure: 'unresolvable' | 'no_posts' | 'paid_disabled' | null = null;

    for (const link of links) {
      const resolved =
        link.kind === 'post'
          ? await this.telegram.resolvePost(link.url)
          : await this.telegram.resolveLatestPost(link.username);

      if (!resolved) {
        firstFailure ??= link.kind === 'post' ? 'unresolvable' : 'no_posts';
        continue;
      }

      if (!(await this.telegram.hasPaidReactions(resolved.chatId))) {
        firstFailure ??= 'paid_disabled';
        continue;
      }

      this.repository.setTarget(post.post_id, String(resolved.chatId), resolved.messageId);
      if (record.tgLink !== link.url) this.repository.setLink(post.post_id, link.url);
      log.info('Picked a star-able Telegram target', {
        link: link.url,
        candidates: links.length,
        chatId: resolved.chatId,
        messageId: resolved.messageId,
      });
      return { link, chatId: resolved.chatId, messageId: resolved.messageId };
    }

    switch (firstFailure) {
      case 'paid_disabled':
        throw new PaidReactionsDisabledError(`No candidate accepts stars: ${post.post_id}`);
      case 'no_posts':
        throw new NoPostsFoundError(`No candidate has posts: ${post.post_id}`);
      default:
        throw new LinkUnresolvableError(`No resolvable candidate link: ${post.post_id}`);
    }
  }

  /**
   * Tell the user something went wrong (paid reactions disabled, no posts...)
   * and still post the ad, respecting the same pacing. Marks the submission
   * terminal so we never retry it.
   */
  private async handleNotice(
    post: ForumPost,
    link: string,
    log: Logger,
    text: string,
    reason: NoticeReason,
  ): Promise<IssuanceOutcome> {
    const postId = post.post_id;
    let commentId: number | null = null;

    if (this.config.comment.enabled) {
      const noticeBody = this.renderBody(this.config.comment.template, post, link, text);
      const existing = await this.findOwnCommentByBody(postId, noticeBody);
      commentId = existing ?? (await this.postComment(post, noticeBody, log, 'notice'));
    }

    let adCommentId: number | null = null;
    if (this.config.comment.ad.enabled) {
      const adBody = this.renderBody(this.config.comment.ad.template, post, link);
      const existing = await this.findOwnCommentByBody(postId, adBody);
      adCommentId = existing ?? (await this.postComment(post, adBody, log, 'ad'));
    }

    this.repository.markSkippedWithComments(postId, reason, commentId, adCommentId);
    log.warn('Notified the user and posted the ad', { link, reason, commentId, adCommentId });

    return { kind: 'skipped', postId, reason };
  }

  /** Resolve the configured user-facing message for a notice kind. */
  private noticeText(kind: NoticeKind): string {
    return this.config.comment[NOTICES[kind].text];
  }

  private async writeConfirmation(
    post: ForumPost,
    link: string,
    log: Logger,
    note?: string,
  ): Promise<number | null> {
    if (!this.config.comment.enabled) {
      this.repository.markConfirmed(post.post_id, null);
      return null;
    }

    const rendered = this.renderBody(this.config.comment.template, post, link);
    const body = note ? `${rendered}\n\n${note}` : rendered;

    const existing = await this.findOwnCommentByBody(post.post_id, body);
    if (existing !== null) {
      this.repository.markConfirmed(post.post_id, existing);
      log.warn('Confirmation comment already present, not posting again', { commentId: existing });
      return existing;
    }

    const commentId = await this.postComment(post, body, log, 'confirmation');
    this.repository.markConfirmed(post.post_id, commentId);
    return commentId;
  }

  private async writeAd(post: ForumPost, link: string, log: Logger): Promise<number | null> {
    if (!this.config.comment.ad.enabled) {
      this.repository.markCommented(post.post_id, null);
      return null;
    }

    const body = this.renderBody(this.config.comment.ad.template, post, link);

    const existing = await this.findOwnCommentByBody(post.post_id, body);
    if (existing !== null) {
      this.repository.markCommented(post.post_id, existing);
      log.warn('Ad comment already present, not posting again', { adCommentId: existing });
      return existing;
    }

    const adCommentId = await this.postComment(post, body, log, 'ad');
    this.repository.markCommented(post.post_id, adCommentId);
    return adCommentId;
  }

  private renderBody(template: string, post: ForumPost, link: string, text?: string): string {
    return renderComment(template, {
      user_id: post.user_id,
      username: post.username,
      text: text ?? this.config.comment.text,
      stars: this.config.star.count,
      link,
    });
  }

  /**
   * Posts a comment with duplicate protection. The forum can be slow and lose
   * the response even though the write succeeded, so a failed attempt is
   * followed by a check for the exact body before the retry can post again.
   */
  private async postComment(
    post: ForumPost,
    body: string,
    log: Logger,
    kind: 'confirmation' | 'ad' | 'notice',
  ): Promise<number> {
    try {
      const response = await this.forum.createComment(post.post_id, body);
      const commentId = response.comment.post_comment_id;
      if (!commentId) throw new Error('Forum did not return a comment id');
      log.info('Comment posted', { kind, commentId, body });
      return commentId;
    } catch (err) {
      await sleep(this.config.pacing.commentVerifyDelayMs);
      const existing = await this.findOwnCommentByBody(post.post_id, body);
      if (existing !== null) {
        log.warn('Comment already exists despite the error; not posting again', {
          kind,
          commentId: existing,
          ...errorToLog(err),
        });
        return existing;
      }
      throw err;
    }
  }

  /**
   * Finds our own comment with an exact body match. Matching the body (rather
   * than just the author) distinguishes the confirmation comment from the ad
   * comment on the same post.
   */
  private async findOwnCommentByBody(postId: number, body: string): Promise<number | null> {
    try {
      const { comments } = await this.forum.getComments(postId);
      const normalized = body.trim();
      const mine = [...comments].reverse().find(
        (comment) =>
          // Deleted comments are still returned by the API; a moderated
          // comment must not make us believe our reply is there.
          comment.message_state === 'visible' &&
          comment.user_id === this.selfForumUserId &&
          comment.message.trim() === normalized,
      );
      return mine?.post_comment_id ?? null;
    } catch (err) {
      this.logger.warn('Could not read existing comments', { postId, ...errorToLog(err) });
      return null;
    }
  }

  private isPermanent(err: unknown): boolean {
    if (err instanceof PermanentError) return true;
    if (err instanceof ForumApiError) {
      // 403 is the forum's anti-flood response, so it stays retryable.
      return err.status === 400 || err.status === 401 || err.status === 404 || err.status === 422;
    }
    return false;
  }
}
