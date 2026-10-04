import type { AppConfig } from '../config';
import { readEnvToken } from '../config/env-file';
import { Cooldown } from '../core/async';
import type { Logger } from '../core/logger';
import { Database } from '../db/Database';
import { IssuanceRepository } from '../db/repositories/IssuanceRepository';
import { StateRepository } from '../db/repositories/StateRepository';
import { AuthGate } from '../forum/AuthGate';
import { ForumClient } from '../forum/ForumClient';
import { rateLimiterFromPerMinute } from '../forum/RateLimiter';
import { IssuanceService } from '../services/IssuanceService';
import { ScannerService } from '../services/ScannerService';
import { StatsService } from '../services/StatsService';
import { TelegramService } from '../telegram/TelegramService';

interface ApplicationDeps {
  config: AppConfig;
  logger: Logger;
  database: Database;
  repository: IssuanceRepository;
  state: StateRepository;
  forum: ForumClient;
  authGate: AuthGate;
  telegram: TelegramService;
  cooldown: Cooldown;
  selfForumUserId: number;
}

/**
 * Composition root. Builds the object graph, wires lifecycle hooks and keeps
 * `index.ts` free of any construction details.
 */
export class Application {
  private readonly logger: Logger;
  private readonly database: Database;
  private readonly telegram: TelegramService;
  private readonly scanner: ScannerService;
  private readonly stats: StatsService;
  private readonly authGate: AuthGate;
  private stopped = false;

  private constructor(deps: ApplicationDeps) {
    this.logger = deps.logger.child('Application');
    this.database = deps.database;
    this.telegram = deps.telegram;
    this.authGate = deps.authGate;

    const issuance = new IssuanceService({
      config: deps.config,
      forum: deps.forum,
      telegram: deps.telegram,
      repository: deps.repository,
      logger: deps.logger,
      selfForumUserId: deps.selfForumUserId,
      cooldown: deps.cooldown,
    });

    this.scanner = new ScannerService({
      config: deps.config,
      forum: deps.forum,
      issuance,
      repository: deps.repository,
      state: deps.state,
      telegram: deps.telegram,
      logger: deps.logger,
    });

    this.stats = new StatsService({
      config: deps.config,
      forum: deps.forum,
      repository: deps.repository,
      telegram: deps.telegram,
      logger: deps.logger,
    });
  }

  static async create(config: AppConfig, logger: Logger): Promise<Application> {
    const database = new Database(config.database.path, logger);
    const repository = new IssuanceRepository(database);
    const state = new StateRepository(database);

    // One gate shared by every outbound action (forum writes in ForumClient,
    // Telegram sends in IssuanceService), so nothing bunches up.
    const cooldown = new Cooldown(config.pacing.cooldownMs);

    const forum = new ForumClient({
      baseUrl: config.forum.baseUrl,
      token: config.forum.token,
      timeoutMs: config.forum.requestTimeoutMs,
      retry: config.retry,
      logger,
      readLimiter: rateLimiterFromPerMinute(config.rateLimit.readPerMinute),
      writeLimiter: rateLimiterFromPerMinute(config.rateLimit.writePerMinute),
      cooldown,
    });

    const telegram = new TelegramService({
      apiId: config.telegram.apiId,
      apiHash: config.telegram.apiHash,
      sessionPath: config.telegram.sessionPath,
      retry: config.retry,
      logger,
    });

    // A dead token must freeze the bot, not crash-loop it: every request parks
    // here until FORUM_TOKEN in the token file starts working again.
    const authGate = new AuthGate({
      logger: logger.child('Auth'),
      token: config.forum.token,
      envPath: config.auth.tokenFile,
      readToken: () => readEnvToken(config.auth.tokenFile),
      applyToken: (token) => forum.setToken(token),
      probe: () => forum.probeAuth(),
      checkIntervalMs: config.auth.tokenCheckIntervalMs,
      logEveryChecks: config.auth.logEveryChecks,
    });
    forum.setAuthGate(authGate);
    authGate.start();

    try {
      await telegram.init();
      const me = await forum.getMe();

      logger.info('Authenticated', {
        forumUserId: me.user.user_id,
        forumUsername: me.user.username,
        threadId: config.forum.threadId,
      });

      return new Application({
        config,
        logger,
        database,
        repository,
        state,
        forum,
        authGate,
        telegram,
        cooldown,
        selfForumUserId: me.user.user_id,
      });
    } catch (err) {
      authGate.stop();
      throw err;
    }
  }

  async run(): Promise<void> {
    try {
      await Promise.all([this.scanner.start(), this.stats.start()]);
    } finally {
      await this.shutdown();
    }
  }

  /** Request a graceful stop; `run()` will then close all resources. */
  stop(): void {
    this.authGate.stop();
    this.scanner.stop();
    this.stats.stop();
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.authGate.stop();
    this.scanner.stop();
    this.stats.stop();
    await this.telegram.close();
    this.database.close();
    this.logger.info('Shutdown complete');
  }
}
