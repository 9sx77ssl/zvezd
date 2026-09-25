import type { AppConfig } from '../config';
import { ForumApiError, PermanentError } from '../core/errors';
import { errorToLog, type Logger } from '../core/logger';
import type { IssuanceRepository } from '../db/repositories/IssuanceRepository';
import type { ForumClient } from '../forum/ForumClient';
import type { ForumPost } from '../forum/types';
import { selectFirstTgPostLink } from '../telegram/link-parser';
import type { TelegramService } from '../telegram/TelegramService';
import { renderComment } from './comment-renderer';

export type IssuanceOutcome =
  | { kind: 'processed'; postId: number; username: string; link: string; commentId: number | null }
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
 * `star -> confirm -> comment` state machine.
 *
 * Every step is persisted before the next one begins, so a crash (or a lost
 * database) can never charge the same post twice within a normal run:
 *
 *   pending  -> claimed the post, nothing done yet
 *   star_sent-> star confirmed, comment still missing (retry only comments)
 *   commented-> fully done (terminal)
 *   skipped  -> intentionally not processed (terminal)
 *   failed   -> retryable or permanent failure
 */
export class IssuanceService {
  private readonly config: AppConfig;
  private readonly forum: ForumClient;
  private readonly telegram: TelegramService;
  private readonly repository: IssuanceRepository;
  private readonly logger: Logger;
  private readonly selfForumUserId: number;

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
    const log = this.logger.child('', { postId, username: post.poster_username });

    if (post.post_is_first_post) return { kind: 'ignored', postId, reason: 'first_post' };
    if (post.post_is_deleted) return { kind: 'ignored', postId, reason: 'deleted' };
    if (post.post_is_published === false) return { kind: 'ignored', postId, reason: 'unpublished' };
    if (post.poster_user_id === this.selfForumUserId) {
      return { kind: 'ignored', postId, reason: 'own_post' };
    }

    const link = selectFirstTgPostLink(post.post_body_html);
    if (!link) {
      const created = this.repository.reserve({
        threadId: post.thread_id,
        postId,
        posterUserId: post.poster_user_id,
        posterUsername: post.poster_username,
        tgLink: null,
      });
      if (created) this.repository.markSkipped(postId, 'no_tg_link');
      return { kind: 'skipped', postId, reason: 'no_tg_link' };
    }

    if (this.config.star.dryRun) {
      log.info('Dry run: would issue star', {
        link: link.url,
        stars: this.config.star.count,
        comment: this.config.comment.enabled,
      });
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
      if (record.attempts >= this.config.retry.maxAttempts) {
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
      if (record.status !== 'star_sent') {
        await this.issueStar(post, link.url, log);
      }
      const commentId = await this.writeComment(post, link.url, log);
      return {
        kind: 'processed',
        postId,
        username: post.poster_username,
        link: link.url,
        commentId,
      };
    } catch (err) {
      const permanent = this.isPermanent(err);
      const current = this.repository.findByPostId(postId);
      const message = err instanceof Error ? err.message : String(err);

      // A star was already charged and only the comment failed: keep
      // `star_sent` so the next run retries the comment, never the star.
      if (current?.status === 'star_sent' && !permanent) {
        log.warn('Comment failed after star, will retry comment only', errorToLog(err));
        return { kind: 'failed', postId, retryable: true, error: message };
      }

      this.repository.markFailed(postId, message, !permanent);
      log.error('Issuance failed', { ...errorToLog(err), retryable: !permanent });
      return { kind: 'failed', postId, retryable: !permanent, error: message };
    }
  }

  private async issueStar(post: ForumPost, link: string, log: Logger): Promise<void> {
    const resolved = await this.telegram.resolvePost(link);
    if (!resolved) {
      throw new PermanentError(`Telegram post is not resolvable: ${link}`);
    }

    log.info('Sending star reaction', {
      link,
      chatId: resolved.chatId,
      messageId: resolved.messageId,
      count: this.config.star.count,
    });

    const result = await this.telegram.sendStarReaction(
      resolved.chatId,
      resolved.messageId,
      this.config.star.count,
    );

    this.repository.markStarSent(post.post_id, String(resolved.chatId), resolved.messageId);

    const balance = await this.telegram.getBalance();
    log.info('Star confirmed', {
      link,
      paidReactions: result.paidReactions,
      balance,
    });
  }

  private async writeComment(post: ForumPost, link: string, log: Logger): Promise<number | null> {
    if (!this.config.comment.enabled) {
      this.repository.markCommented(post.post_id, null);
      return null;
    }

    const body = renderComment(this.config.comment.template, {
      user_id: post.poster_user_id,
      username: post.poster_username,
      text: this.config.comment.text,
      stars: this.config.star.count,
      link,
    });

    const response = await this.forum.createComment(post.post_id, body);
    const commentId = response.comment.post_comment_id;
    if (!commentId) {
      throw new Error('Forum did not return a comment id');
    }

    this.repository.markCommented(post.post_id, commentId);
    log.info('Confirmation comment posted', { commentId, body });

    return commentId;
  }

  private isPermanent(err: unknown): boolean {
    if (err instanceof PermanentError) return true;
    if (err instanceof ForumApiError) return err.status < 500 && err.status !== 429;
    return false;
  }
}
