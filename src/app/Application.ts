import type { AppConfig } from '../config';
import type { Logger } from '../core/logger';
import { Database } from '../db/Database';
import { IssuanceRepository } from '../db/repositories/IssuanceRepository';
import { StateRepository } from '../db/repositories/StateRepository';
import { ForumClient } from '../forum/ForumClient';
import { RateLimiter } from '../forum/RateLimiter';
import { IssuanceService } from '../services/IssuanceService';
import { ScannerService } from '../services/ScannerService';
import { TelegramService } from '../telegram/TelegramService';

interface ApplicationDeps {
  config: AppConfig;
  logger: Logger;
  database: Database;
  repository: IssuanceRepository;
  state: StateRepository;
  forum: ForumClient;
  telegram: TelegramService;
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
  private stopped = false;

  private constructor(deps: ApplicationDeps) {
    this.logger = deps.logger.child('Application');
    this.database = deps.database;
    this.telegram = deps.telegram;

    const issuance = new IssuanceService({
      config: deps.config,
      forum: deps.forum,
      telegram: deps.telegram,
      repository: deps.repository,
      logger: deps.logger,
      selfForumUserId: deps.selfForumUserId,
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
  }

  static async create(config: AppConfig, logger: Logger): Promise<Application> {
    const database = new Database(config.database.path, logger);
    const repository = new IssuanceRepository(database);
    const state = new StateRepository(database);

    const forum = new ForumClient({
      baseUrl: config.forum.baseUrl,
      token: config.forum.token,
      timeoutMs: config.forum.requestTimeoutMs,
      retry: config.retry,
      logger,
      readLimiter: new RateLimiter(config.rateLimit.read, 'read'),
      writeLimiter: new RateLimiter(config.rateLimit.write, 'write'),
    });

    const telegram = new TelegramService({
      apiId: config.telegram.apiId,
      apiHash: config.telegram.apiHash,
      sessionPath: config.telegram.sessionPath,
      logger,
    });

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
      telegram,
      selfForumUserId: me.user.user_id,
    });
  }

  async run(): Promise<void> {
    try {
      await this.scanner.start();
    } finally {
      await this.shutdown();
    }
  }

  /** Request a graceful stop; `run()` will then close all resources. */
  stop(): void {
    this.scanner.stop();
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.scanner.stop();
    await this.telegram.close();
    this.database.close();
    this.logger.info('Shutdown complete');
  }
}
