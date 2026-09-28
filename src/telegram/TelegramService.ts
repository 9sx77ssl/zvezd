import { type Message, TelegramClient, tl, type User } from '@mtcute/bun';
import { backoffDelay, sleep } from '../core/async';
import { TelegramAuthError } from '../core/errors';
import { ensureParentDir } from '../core/fs';
import { errorToLog, type Logger } from '../core/logger';

export interface TelegramServiceOptions {
  apiId: number;
  apiHash: string;
  sessionPath: string;
  retry: { attempts: number; delayMs: number; maxDelayMs: number };
  logger: Logger;
}

export interface ResolvedTgPost {
  chatId: number;
  messageId: number;
  message: Message;
}

export interface StarReactionResult {
  /** Total number of distinct users with a paid reaction. */
  paidReactions: number;
  /** How many paid reactions the authorized account itself has on the post. */
  ownCount: number;
}

/** RPC errors that mean "this post can never be starred", so retrying is pointless. */
const PERMANENT_RESOLVE_ERRORS = new Set([
  'USERNAME_NOT_OCCUPIED',
  'USERNAME_INVALID',
  'CHANNEL_PRIVATE',
  'CHANNEL_INVALID',
  'CHANNEL_MONOFORUM_INVALID',
  'MSG_ID_INVALID',
  'MESSAGE_ID_INVALID',
  'MESSAGE_DELETE_FORBIDDEN',
]);

/** RPC errors that will never become successful on retry. */
function isPermanentRpcError(err: unknown): boolean {
  if (!(err instanceof tl.RpcError)) return false;
  return (
    PERMANENT_RESOLVE_ERRORS.has(err.text) ||
    err.text.startsWith('AUTH_') ||
    err.text === 'USER_DEACTIVATED' ||
    err.text === 'SESSION_REVOKED' ||
    err.text === 'SESSION_EXPIRED'
  );
}

/**
 * Wraps mtcute's user client. The session is persisted in SQLite at
 * `sessionPath`, so after a single interactive `bun run login` the bot runs
 * headless.
 */
export class TelegramService {
  private readonly options: TelegramServiceOptions;
  private readonly logger: Logger;
  private client?: TelegramClient;
  private self?: User;

  constructor(options: TelegramServiceOptions) {
    this.options = options;
    this.logger = options.logger.child('Telegram');
  }

  async init(): Promise<User> {
    if (this.client) return this.self as User;

    ensureParentDir(this.options.sessionPath);

    this.client = new TelegramClient({
      apiId: this.options.apiId,
      apiHash: this.options.apiHash,
      storage: this.options.sessionPath,
    });

    await this.client.connect();

    try {
      const me = await this.client.getMe();
      if (!me) throw new TelegramAuthError('Telegram session is not authorized');
      this.self = me;
    } catch (err) {
      if (tl.RpcError.is(err, 'AUTH_KEY_UNREGISTERED') || tl.RpcError.is(err, 'USER_DEACTIVATED')) {
        throw new TelegramAuthError(
          'Telegram session is missing or revoked. Run `bun run login`.',
          {
            cause: err,
          },
        );
      }
      throw err;
    }

    this.logger.info('Telegram client ready', {
      selfId: this.self.id,
      selfUsername: this.self.username ?? null,
      displayName: this.self.displayName,
    });

    return this.self;
  }

  get user(): User {
    if (!this.self) throw new Error('TelegramService.init() was not awaited');
    return this.self;
  }

  /** Current Telegram Stars balance for the authorized account. */
  getBalance(): Promise<number> {
    return this.withRetry('getBalance', async () => {
      const status = await this.client!.getStarsTransactions('self', { limit: 1 });
      return normalizeStarsAmount(status.balance);
    });
  }

  /**
   * Resolve a public `t.me/<username>/<id>` link to a message.
   * Returns `null` for links that can never be starred (deleted/private/...).
   */
  resolvePost(link: string): Promise<ResolvedTgPost | null> {
    return this.withRetry('resolvePost', async () => {
      try {
        const message = await this.client!.getMessageByLink(link);
        if (!message) return null;
        return { chatId: message.chat.id, messageId: message.id, message };
      } catch (err) {
        if (err instanceof tl.RpcError && PERMANENT_RESOLVE_ERRORS.has(err.text)) {
          this.logger.warn('Telegram post cannot be resolved', { link, rpc: err.text });
          return null;
        }
        throw err;
      }
    });
  }

  /** How many paid star reactions the authorized account already has on a post. */
  getOwnPaidReactionCount(chatId: number, messageId: number): Promise<number> {
    return this.withRetry('getOwnPaidReactionCount', async () => {
      const [reactions] = await this.client!.getMessageReactionsById(chatId, [messageId]);
      if (!reactions) return 0;
      return reactions.paidReactions.find((reaction) => reaction.my)?.count ?? 0;
    });
  }

  /**
   * Resolve a bare channel link to its latest non-service post.
   * Returns `null` when the channel has no posts.
   */
  resolveLatestPost(username: string): Promise<{ chatId: number; messageId: number } | null> {
    return this.withRetry('resolveLatestPost', async () => {
      const peer = await this.client!.resolvePeer(username);
      const history = await this.client!.getHistory(peer, { limit: 5 });
      const message = history.find((item) => !item.isService) ?? null;
      if (!message) return null;
      return { chatId: message.chat.id, messageId: message.id };
    });
  }

  /** Whether the channel accepts paid (star) reactions. `true` if unknown. */
  hasPaidReactions(chatId: number): Promise<boolean> {
    return this.withRetry('hasPaidReactions', async () => {
      try {
        const full = await this.client!.getFullChat(chatId);
        return full.hasPaidReactions;
      } catch (err) {
        this.logger.debug('Could not read paid-reaction setting, assuming enabled', {
          chatId,
          ...errorToLog(err),
        });
        return true;
      }
    });
  }

  /**
   * Send `count` paid star reactions to a message.
   *
   * Not retried internally on purpose: an ambiguous failure could otherwise
   * charge twice. The caller re-checks {@link getOwnPaidReactionCount} before
   * any retry.
   */
  async sendStarReaction(
    chatId: number,
    messageId: number,
    count: number,
  ): Promise<StarReactionResult> {
    const reactions = await this.client!.sendPaidReaction({ chatId, message: messageId, count });
    const ownCount = reactions.paidReactions.find((reaction) => reaction.my)?.count ?? 0;
    return { paidReactions: reactions.paidReactions.length, ownCount };
  }

  async close(): Promise<void> {
    if (!this.client) return;
    this.logger.debug('Closing Telegram client');
    try {
      await this.client.destroy();
    } catch (err) {
      // Bun may run mtcute's own `beforeExit` storage cleanup concurrently with
      // graceful shutdown, which closes its SQLite before `destroy()`. The
      // session is already persisted, so this is safe to ignore.
      this.logger.warn('Telegram close reported an error (ignored)', errorToLog(err));
    }
    this.client = undefined;
  }

  /** Retries transient errors with exponential backoff. Read-only operations only. */
  private async withRetry<T>(label: string, task: () => Promise<T>): Promise<T> {
    const { attempts, delayMs, maxDelayMs } = this.options.retry;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await task();
      } catch (err) {
        lastError = err;
        if (isPermanentRpcError(err) || attempt >= attempts) throw err;

        const delay = backoffDelay(attempt, delayMs, maxDelayMs);
        this.logger.warn(`Telegram ${label} failed, retrying`, {
          attempt,
          attempts,
          delayMs: delay,
          ...errorToLog(err),
        });
        await sleep(delay);
      }
    }

    throw lastError;
  }
}

function normalizeStarsAmount(amount: tl.TypeStarsAmount): number {
  if ('amount' in amount) {
    const whole = Number(amount.amount);
    const nanos = amount._ === 'starsAmount' ? amount.nanos : 0;
    return whole + nanos / 1_000_000_000;
  }
  return 0;
}
