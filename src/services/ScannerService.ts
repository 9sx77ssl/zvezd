import type { AppConfig } from '../config';
import { sleep } from '../core/async';
import { errorToLog, type Logger } from '../core/logger';
import type { IssuanceRepository } from '../db/repositories/IssuanceRepository';
import type { StateRepository } from '../db/repositories/StateRepository';
import type { ForumClient } from '../forum/ForumClient';
import type { ForumPost } from '../forum/types';
import type { IssuanceOutcome, IssuanceService } from './IssuanceService';

export interface ScannerServiceDeps {
  config: AppConfig;
  forum: ForumClient;
  issuance: IssuanceService;
  repository: IssuanceRepository;
  state: StateRepository;
  telegram: { getBalance(): Promise<number> };
  logger: Logger;
}

const STATE_BACKFILL_COMPLETED = 'backfill_completed';

type WalkContext = 'startup' | 'poll';

/**
 * Drives the whole workflow:
 *
 *  1. on startup, walk the thread from page 1 until an empty page (backfill),
 *     or until a fully-processed page (catch-up after a restart);
 *  2. then poll the thread forever. Each poll walks pages 1, 2, 3... and stops
 *     as soon as it reaches a page with nothing new, so it also survives bursts
 *     that push posts past page 1.
 *
 * When the star balance runs out the scanner stops touching the forum and only
 * re-checks the Telegram balance until it is topped up again.
 */
export class ScannerService {
  private readonly config: AppConfig;
  private readonly forum: ForumClient;
  private readonly issuance: IssuanceService;
  private readonly repository: IssuanceRepository;
  private readonly state: StateRepository;
  private readonly telegram: { getBalance(): Promise<number> };
  private readonly logger: Logger;

  private running = false;
  private readonly abort = new AbortController();
  private pollCount = 0;
  private balance: number | null = null;

  constructor(deps: ScannerServiceDeps) {
    this.config = deps.config;
    this.forum = deps.forum;
    this.issuance = deps.issuance;
    this.repository = deps.repository;
    this.state = deps.state;
    this.telegram = deps.telegram;
    this.logger = deps.logger.child('Scanner');
  }

  async start(): Promise<void> {
    this.running = true;
    await this.logStartupInfo();

    const completed = this.state.getBool(STATE_BACKFILL_COMPLETED);
    this.logger.info(completed ? 'Starting catch-up sync' : 'Starting full backfill', {
      fromPage: 1,
    });

    await this.walkPages(!completed, 'startup');

    if (!completed && !this.config.star.dryRun) {
      this.state.setBool(STATE_BACKFILL_COMPLETED, true);
      this.logger.info('Backfill finished, marker stored');
    }

    await this.retryPending();

    await this.pollLoop();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.abort.abort(new Error('Scanner stopped'));
  }

  private async logStartupInfo(): Promise<void> {
    await this.refreshBalance();

    this.logger.info('Bot started', {
      threadId: this.config.forum.threadId,
      pollingIntervalMs: this.config.polling.intervalMs,
      starCount: this.config.star.count,
      dryRun: this.config.star.dryRun,
      commentsEnabled: this.config.comment.enabled,
      adCommentEnabled: this.config.comment.ad.enabled,
      starsBalance: this.balance,
      database: this.config.database.path,
      issuances: this.repository.stats(),
    });
  }

  /**
   * Walk pages top-down.
   *
   * `full` = keep going until an empty page (fresh backfill). Otherwise stop at
   * the first page that had no new/actionable posts.
   */
  private async walkPages(full: boolean, context: WalkContext): Promise<IssuanceOutcome[]> {
    const maxPages = this.config.polling.maxBackfillPages;
    const collected: IssuanceOutcome[] = [];
    let page = 1;

    for (;;) {
      if (!this.running) return collected;
      await this.ensureSufficientStars();
      if (!this.running) return collected;

      const response = await this.forum.getPosts({
        threadId: this.config.forum.threadId,
        page,
        limit: this.config.polling.pageLimit,
        order: this.config.forum.order,
      });

      const posts: ForumPost[] = response.posts;
      if (posts.length === 0) {
        if (context === 'startup') {
          this.logger.info('Backfill complete: reached empty page', { lastPage: page - 1 });
        }
        return collected;
      }

      const outcomes = await this.processPosts(posts);
      collected.push(...outcomes);

      const issued = outcomes.filter((outcome) => outcome.kind === 'processed').length;
      const activity = outcomes.filter(
        (outcome) =>
          outcome.kind === 'processed' || outcome.kind === 'failed' || outcome.kind === 'skipped',
      ).length;

      const pageInfo = {
        page,
        received: posts.length,
        issued,
        activity,
        totalPages: response.links?.pages ?? null,
      };
      if (context === 'startup') {
        this.logger.info('Backfill page processed', pageInfo);
      } else {
        this.logger.debug('Poll page processed', pageInfo);
      }

      if (!full && activity === 0) {
        if (context === 'startup') {
          this.logger.info('Catch-up complete: reached a fully processed page', { page });
        }
        return collected;
      }

      page += 1;
      if (maxPages > 0 && page > maxPages) {
        this.logger.warn('Page walk stopped: reached maxBackfillPages', { maxPages });
        return collected;
      }

      await this.interruptibleSleep(this.config.polling.pageDelayMs);
    }
  }

  private async pollLoop(): Promise<void> {
    const interval = this.config.polling.intervalMs;
    const heartbeatEvery = Math.max(1, Math.round(60_000 / interval));

    while (this.running) {
      const startedAt = Date.now();
      try {
        const outcomes = await this.walkPages(false, 'poll');
        if (!this.running) break;

        this.pollCount += 1;
        const issued = outcomes.filter((outcome) => outcome.kind === 'processed').length;
        if (issued > 0) {
          this.logHeartbeat('Issued stars on new posts', issued);
        } else if (this.pollCount % heartbeatEvery === 0) {
          this.logHeartbeat('Idle heartbeat');
        }
      } catch (err) {
        this.logger.error('Poll cycle failed', errorToLog(err));
      }

      const elapsed = Date.now() - startedAt;
      await this.interruptibleSleep(Math.max(0, interval - elapsed));
    }
  }

  /**
   * Retries unfinished posts without rescanning the whole thread. Each pending
   * post's page is resolved via `page_of_post_id`, so old pages are only
   * fetched when they actually still have work.
   */
  private async retryPending(): Promise<void> {
    const pending = this.repository.listPending();
    if (pending.length === 0) return;

    const pendingIds = new Set(pending.map((record) => record.postId));
    const attempted = new Set<number>();
    this.logger.info('Retrying unfinished posts', { count: pending.length });

    for (const record of pending) {
      if (!this.running) return;
      if (attempted.has(record.postId)) continue;

      await this.ensureSufficientStars();
      if (!this.running) return;

      try {
        const response = await this.forum.getPosts({
          threadId: this.config.forum.threadId,
          pageOfPostId: record.postId,
          limit: this.config.polling.pageLimit,
          order: this.config.forum.order,
        });

        for (const post of response.posts) {
          if (!this.running) return;
          if (!pendingIds.has(post.post_id) || attempted.has(post.post_id)) continue;
          attempted.add(post.post_id);

          const outcome = await this.issuance.process(post);
          if (outcome.kind === 'processed' && outcome.balance !== undefined) {
            this.balance = outcome.balance;
          }
          await this.interruptibleSleep(this.config.polling.postDelayMs);
        }
      } catch (err) {
        attempted.add(record.postId);
        this.logger.warn('Could not retry pending post', {
          postId: record.postId,
          ...errorToLog(err),
        });
      }
    }
  }

  /**
   * Stops all forum traffic while the account has too few stars, and resumes
   * automatically once the balance is topped up.
   */
  /**
   * Reads the real balance before each check of new posts. If there are not
   * enough stars it pauses and keeps re-checking until they appear.
   */
  private async ensureSufficientStars(): Promise<void> {
    if (this.config.star.dryRun) return;

    await this.refreshBalance();

    const required = this.config.star.count;
    if (this.balance === null || this.balance >= required) return;

    this.logger.warn('Not enough Telegram Stars, pausing forum polling', {
      balance: this.balance,
      required,
      retryInMs: this.config.balance.checkIntervalMs,
    });

    while (this.running && (this.balance ?? 0) < required) {
      await this.interruptibleSleep(this.config.balance.checkIntervalMs);
      if (!this.running) return;
      await this.refreshBalance();
    }

    if (this.running) {
      this.logger.info('Stars topped up, resuming', { balance: this.balance });
    }
  }

  private async refreshBalance(): Promise<void> {
    try {
      this.balance = await this.telegram.getBalance();
    } catch (err) {
      this.logger.warn('Could not read Telegram Stars balance', errorToLog(err));
    }
  }
  private logHeartbeat(message: string, issued = 0): void {
    this.logger.info(message, {
      issued,
      starsBalance: this.balance,
      issuances: this.repository.stats(),
    });
  }

  private async processPosts(posts: ForumPost[]): Promise<IssuanceOutcome[]> {
    const outcomes: IssuanceOutcome[] = [];
    for (const post of posts) {
      if (!this.running) break;

      let outcome: IssuanceOutcome;
      try {
        outcome = await this.issuance.process(post);
      } catch (err) {
        outcome = {
          kind: 'failed',
          postId: post.post_id,
          retryable: true,
          error: err instanceof Error ? err.message : String(err),
        };
        this.logger.error('Unhandled error while processing post', {
          postId: post.post_id,
          ...errorToLog(err),
        });
      }

      outcomes.push(outcome);
      if (outcome.kind === 'processed' && outcome.balance !== undefined) {
        this.balance = outcome.balance;
      }

      const actionable =
        outcome.kind === 'processed' || outcome.kind === 'failed' || outcome.kind === 'skipped';
      if (actionable && this.config.polling.postDelayMs > 0) {
        await this.interruptibleSleep(this.config.polling.postDelayMs);
      }
    }
    return outcomes;
  }

  private async interruptibleSleep(ms: number): Promise<void> {
    if (!this.running) return;
    try {
      await sleep(ms, this.abort.signal);
    } catch {
      // aborted
    }
  }
}
