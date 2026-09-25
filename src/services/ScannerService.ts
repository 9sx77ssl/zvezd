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

/**
 * Drives the whole workflow:
 *
 *  1. on startup, walk the thread from page 1 to the end (backfill);
 *  2. then poll the newest page forever, picking up freshly created posts.
 *
 * Because the listing uses `natural_reverse`, new posts always appear on
 * page 1, so polling a single page is enough once the backlog is drained.
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
    await this.backfill();
    await this.pollLoop();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.abort.abort(new Error('Scanner stopped'));
  }

  private async logStartupInfo(): Promise<void> {
    const stats = this.repository.stats();
    let balance: number | null = null;
    try {
      balance = await this.telegram.getBalance();
    } catch (err) {
      this.logger.warn('Could not read Telegram Stars balance', errorToLog(err));
    }

    this.logger.info('Bot started', {
      threadId: this.config.forum.threadId,
      pollingIntervalMs: this.config.polling.intervalMs,
      starCount: this.config.star.count,
      dryRun: this.config.star.dryRun,
      commentsEnabled: this.config.comment.enabled,
      starsBalance: balance,
      database: this.config.database.path,
      issuances: stats,
    });
  }

  private async backfill(): Promise<void> {
    const completed = this.state.getBool(STATE_BACKFILL_COMPLETED);
    this.logger.info(completed ? 'Starting catch-up sync' : 'Starting full backfill', {
      fromPage: 1,
    });

    const maxPages = this.config.polling.maxBackfillPages;
    let page = 1;

    for (;;) {
      const response = await this.forum.getPosts({
        threadId: this.config.forum.threadId,
        page,
        limit: this.config.polling.pageLimit,
        order: this.config.forum.order,
      });

      const posts = response.posts;
      if (posts.length === 0) {
        this.logger.info('Backfill complete: reached empty page', { lastPage: page - 1 });
        break;
      }

      const outcomes = await this.processPosts(posts);
      const issued = outcomes.filter((outcome) => outcome.kind === 'processed').length;
      const activity = outcomes.filter(
        (outcome) =>
          outcome.kind === 'processed' || outcome.kind === 'failed' || outcome.kind === 'skipped',
      ).length;

      this.logger.info('Backfill page processed', {
        page,
        received: posts.length,
        issued,
        totalPages: response.links?.pages ?? null,
      });

      // Already backfilled once: a fully-known page means we caught up.
      if (completed && activity === 0) {
        this.logger.info('Catch-up complete: reached a fully processed page', { page });
        break;
      }

      page += 1;
      if (maxPages > 0 && page > maxPages) {
        this.logger.warn('Backfill stopped: reached maxBackfillPages', { maxPages });
        break;
      }

      await this.interruptibleSleep(this.config.polling.backfillDelayMs);
    }

    if (!completed && !this.config.star.dryRun) {
      this.state.setBool(STATE_BACKFILL_COMPLETED, true);
      this.logger.info('Full backfill finished, marker stored');
    }
  }

  private async pollLoop(): Promise<void> {
    const interval = this.config.polling.intervalMs;
    const heartbeatEvery = Math.max(1, Math.round(60_000 / interval));

    while (this.running) {
      const startedAt = Date.now();
      try {
        const response = await this.forum.getPosts({
          threadId: this.config.forum.threadId,
          page: this.config.polling.idlePage,
          limit: this.config.polling.pageLimit,
          order: this.config.forum.order,
        });

        const outcomes = await this.processPosts(response.posts);
        this.pollCount += 1;

        const issued = outcomes.filter((outcome) => outcome.kind === 'processed').length;
        if (issued > 0) {
          await this.logHeartbeat('Issued stars on new posts', issued);
        } else if (this.pollCount % heartbeatEvery === 0) {
          await this.logHeartbeat('Idle heartbeat');
        }
      } catch (err) {
        this.logger.error('Poll cycle failed', errorToLog(err));
      }

      const elapsed = Date.now() - startedAt;
      await this.interruptibleSleep(Math.max(0, interval - elapsed));
    }
  }

  private async logHeartbeat(message: string, issued = 0): Promise<void> {
    let balance: number | null = null;
    try {
      balance = await this.telegram.getBalance();
    } catch {
      balance = null;
    }
    this.logger.info(message, {
      issued,
      starsBalance: balance,
      issuances: this.repository.stats(),
    });
  }

  private async processPosts(posts: ForumPost[]): Promise<IssuanceOutcome[]> {
    const outcomes: IssuanceOutcome[] = [];
    for (const post of posts) {
      if (!this.running) break;
      try {
        outcomes.push(await this.issuance.process(post));
      } catch (err) {
        outcomes.push({
          kind: 'failed',
          postId: post.post_id,
          retryable: true,
          error: err instanceof Error ? err.message : String(err),
        });
        this.logger.error('Unhandled error while processing post', {
          postId: post.post_id,
          ...errorToLog(err),
        });
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
