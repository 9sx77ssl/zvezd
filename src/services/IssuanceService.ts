import type { AppConfig } from '../config';
import { sleep } from '../core/async';
import { ForumApiError, PermanentError } from '../core/errors';
import { errorToLog, type Logger } from '../core/logger';
import type { IssuanceRepository } from '../db/repositories/IssuanceRepository';
import type { IssuanceRecord } from '../db/types';
import type { ForumClient } from '../forum/ForumClient';
import type { ForumPost } from '../forum/types';
import { selectFirstTgPostLink } from '../telegram/link-parser';
import type { TelegramService } from '../telegram/TelegramService';
import { renderComment } from './comment-renderer';

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
  | { kind: 'already'; postId: number; status: string }
  | { kind: 'ignored'; postId: number; reason: string }
  | { kind: 'skipped'; postId: number; reason: string }
  | { kind: 'failed'; postId: number; retryable: boolean; error: string };

export interface IssuanceServiceDeps {
  config: AppConfig;
  forum: ForumClient;
  telegram: TelegramService;
  repository: IssuanceRepository;
  logger: Logger;
  selfForumUserId: number;
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
  private readonly dryRunReported = new Set<number>();

  constructor(deps: IssuanceServiceDeps) {
    this.config = deps.config;
    this.forum = deps.forum;
    this.telegram = deps.telegram;
    this.repository = deps.repository;
    this.logger = deps.logger.child('Issuance');
    this.selfForumUserId = deps.selfForumUserId;
  }

  async process(post: ForumPost): Promise<IssuanceOutcome> {
    const postId = post.post_id;
    const log = this.logger.child('Post', { postId, username: post.poster_username });

    if (post.post_is_first_post) return { kind: 'ignored', postId, reason: 'first_post' };
    if (post.post_is_deleted) return { kind: 'ignored', postId, reason: 'deleted' };
    if (post.post_is_published === false) return { kind: 'ignored', postId, reason: 'unpublished' };
    if (post.poster_user_id === this.selfForumUserId) {
      return { kind: 'ignored', postId, reason: 'own_post' };
    }

    const link = selectFirstTgPostLink(post.post_body_html);
    if (!link) {
      // Not persisted: users sometimes edit a post to add the link, so we
      // simply re-check it on the next poll.
      log.debug('Post has no Telegram link yet');
      return { kind: 'ignored', postId, reason: 'no_tg_link' };
    }

    if (this.config.star.dryRun) {
      if (!this.dryRunReported.has(postId)) {
        this.dryRunReported.add(postId);
        log.info('Dry run: would issue star', {
          link: link.url,
          stars: this.config.star.count,
          comment: this.config.comment.enabled,
        });
      }
      return { kind: 'skipped', postId, reason: 'dry_run' };
    }

    const created = this.repository.reserve({
      threadId: post.thread_id,
      postId,
      posterUserId: post.poster_user_id,
      posterUsername: post.poster_username,
      tgLink: link.url,
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
        return { kind: 'already', postId, status: 'attempts_exhausted' };
      }
    }

    // Second safety layer for a lost database: the forum post already has
    // comments, so we assume it was handled and never spend a star on it.
    if (created && (post.post_comment_count ?? 0) > 0) {
      this.repository.markSkipped(postId, 'comments_present');
      log.info('Skipped: post already has comments (assumed handled)', {
        commentCount: post.post_comment_count,
      });
      return { kind: 'skipped', postId, reason: 'comments_present' };
    }

    this.repository.bumpAttempts(postId);

    try {
      let balance: number | undefined;

      const needsStar = record.status !== 'star_sent' && record.status !== 'confirmed';
      if (needsStar) {
        balance = await this.issueStar(post, link.url, log, record);
        if (this.config.pacing.starToCommentMs > 0) {
          await sleep(this.config.pacing.starToCommentMs);
        }
      }

      let commentId: number | null = record.commentId;
      if (record.status !== 'confirmed') {
        commentId = await this.writeConfirmation(post, link.url, log);
        if (this.config.pacing.commentToAdMs > 0) {
          await sleep(this.config.pacing.commentToAdMs);
        }
      }

      const adCommentId = await this.writeAd(post, link.url, log);

      return {
        kind: 'processed',
        postId,
        username: post.poster_username,
        link: link.url,
        commentId,
        adCommentId,
        balance,
      };
    } catch (err) {
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
    link: string,
    log: Logger,
    record: IssuanceRecord,
  ): Promise<number> {
    const resolved = await this.telegram.resolvePost(link);
    if (!resolved) {
      throw new PermanentError(`Telegram post is not resolvable: ${link}`);
    }

    const expected = this.config.star.count;

    // The baseline is how many of our paid reactions were on this exact
    // Telegram message *before* the first attempt for THIS forum post.
    // It lets the same TG post be starred again on a later submission while
    // keeping a retry of the very same submission idempotent.
    const current = await this.telegram.getOwnPaidReactionCount(
      resolved.chatId,
      resolved.messageId,
    );
    if (record.tgBaseline === null) {
      this.repository.setStarBaseline(post.post_id, current);
    }
    const baseline = record.tgBaseline ?? current;

    if (current >= baseline + expected) {
      this.repository.markStarSent(post.post_id, String(resolved.chatId), resolved.messageId);
      const balance = await this.telegram.getBalance();
      log.info('Star already sent for this submission, not charging again', {
        link,
        current,
        baseline,
        balance,
      });
      return balance;
    }

    log.info('Sending star reaction', {
      link,
      chatId: resolved.chatId,
      messageId: resolved.messageId,
      count: expected,
      baseline,
    });

    const result = await this.telegram.sendStarReaction(
      resolved.chatId,
      resolved.messageId,
      expected,
    );

    this.repository.markStarSent(post.post_id, String(resolved.chatId), resolved.messageId);

    const balance = await this.telegram.getBalance();
    log.info('Star confirmed', {
      link,
      paidReactions: result.paidReactions,
      ownCount: result.ownCount,
      balance,
    });

    return balance;
  }

  private async writeConfirmation(
    post: ForumPost,
    link: string,
    log: Logger,
  ): Promise<number | null> {
    if (!this.config.comment.enabled) {
      this.repository.markConfirmed(post.post_id, null);
      return null;
    }

    const body = this.renderBody(this.config.comment.template, post, link);

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

  private renderBody(template: string, post: ForumPost, link: string): string {
    return renderComment(template, {
      user_id: post.poster_user_id,
      username: post.poster_username,
      text: this.config.comment.text,
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
    kind: 'confirmation' | 'ad',
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
      const mine = [...comments]
        .reverse()
        .find(
          (comment) =>
            comment.poster_user_id === this.selfForumUserId &&
            comment.post_comment_body.trim() === normalized,
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
