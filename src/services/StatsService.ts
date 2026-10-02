import type { AppConfig } from '../config';
import { sleep } from '../core/async';
import { ShuttingDownError } from '../core/errors';
import { errorToLog, type Logger } from '../core/logger';
import type { IssuanceRepository } from '../db/repositories/IssuanceRepository';
import type { ForumClient } from '../forum/ForumClient';
import { buildStatsBody, buildStatsTitle, buildUserChannelStats } from './stats-builder';

export interface StatsServiceDeps {
  config: AppConfig;
  forum: ForumClient;
  repository: IssuanceRepository;
  telegram: { getBalance(): Promise<number> };
  logger: Logger;
}

/** Keep just under the forum's 72k character limit. */
const MAX_BODY_CHARS = 70_000;

/**
 * Maintains a live stats thread on the forum: rewrites its title and first post
 * with aggregated issuance stats every `stats.intervalMs`.
 */
export class StatsService {
  private readonly config: AppConfig;
  private readonly forum: ForumClient;
  private readonly repository: IssuanceRepository;
  private readonly telegram: { getBalance(): Promise<number> };
  private readonly logger: Logger;

  private running = false;
  private readonly abort = new AbortController();
  private firstPostId: number | null = null;
  private lastBody: string | null = null;
  private lastBalance = 0;

  constructor(deps: StatsServiceDeps) {
    this.config = deps.config;
    this.forum = deps.forum;
    this.repository = deps.repository;
    this.telegram = deps.telegram;
    this.logger = deps.logger.child('Stats');
  }

  async start(): Promise<void> {
    if (!this.config.stats.enabled) {
      this.logger.info('Stats page disabled');
      return;
    }

    this.running = true;
    const firstPostId = await this.resolveFirstPostId();
    if (!this.running) return;
    if (firstPostId === null) {
      this.logger.error('Stats page disabled: could not resolve the first post');
      this.running = false;
      return;
    }
    this.firstPostId = firstPostId;

    this.logger.info('Stats page started', {
      statsThreadId: this.config.stats.threadId,
      firstPostId,
      intervalMs: this.config.stats.intervalMs,
    });

    await this.updateOnce();

    while (this.running) {
      await this.interruptibleSleep(this.config.stats.intervalMs);
      if (!this.running) return;
      await this.updateOnce();
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.abort.abort(new Error('Stats stopped'));
  }

  private async resolveFirstPostId(): Promise<number | null> {
    try {
      const response = await this.forum.getThread(this.config.stats.threadId);
      const link = response.thread.links?.first_post;
      if (!link) return null;
      const match = /\/(\d+)\/?$/.exec(link);
      return match?.[1] ? Number(match[1]) : null;
    } catch (err) {
      this.logger.error('Failed to read the stats thread', errorToLog(err));
      return null;
    }
  }

  private async updateOnce(): Promise<void> {
    if (this.firstPostId === null) return;

    const now = Date.now();
    const users = this.repository.statsByUser();
    const overall = this.repository.overallStats();
    const sourceThreadUrl = `https://lolz.team/threads/${this.config.forum.threadId}/`;

    const perStar = this.config.star.count;
    const spent = overall.stars * perStar;
    const firstStarAt = this.repository.firstStarAt();
    const days = firstStarAt ? Math.max(1, Math.round((now - firstStarAt) / 86_400_000)) : 1;
    const avgPerDay = Math.round(spent / days);
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStars = this.repository.starsSince(todayStart.getTime()) * perStar;
    const lastIssuedAt = this.repository.lastStarAt();

    try {
      this.lastBalance = await this.telegram.getBalance();
    } catch (err) {
      this.logger.warn('Could not read Telegram balance for stats', errorToLog(err));
    }

    const title = buildStatsTitle(this.config.stats.titleTemplate, new Date(now));
    const links = this.config.stats.links.enabled
      ? buildUserChannelStats(this.repository.linkRowsByUser())
      : undefined;

    const body = buildStatsBody({
      sourceThreadUrl,
      users,
      overall,
      links,
      metrics: {
        balance: this.lastBalance,
        spent,
        avgPerDay,
        todayStars,
        lastIssuedAt,
        now,
      },
      maxChars: MAX_BODY_CHARS,
    });

    try {
      await this.forum.editThread(this.config.stats.threadId, title);

      if (body !== this.lastBody) {
        await this.forum.editPost(this.firstPostId, body);
        this.lastBody = body;
      }

      this.logger.info('Stats page updated', {
        title,
        users: overall.users,
        posts: overall.posts,
        stars: overall.stars,
        listed: users.length,
      });
    } catch (err) {
      if (err instanceof ShuttingDownError) return;
      this.logger.error('Stats page update failed', errorToLog(err));
    }
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
