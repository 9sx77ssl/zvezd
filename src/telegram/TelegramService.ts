import { type Message, TelegramClient, tl, type User } from '@mtcute/bun';
import { TelegramAuthError } from '../core/errors';
import type { Logger } from '../core/logger';

export interface TelegramServiceOptions {
  apiId: number;
  apiHash: string;
  sessionPath: string;
  logger: Logger;
}

export interface ResolvedTgPost {
  chatId: number;
  messageId: number;
  message: Message;
}

export interface StarReactionResult {
  paidReactions: number;
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
  async getBalance(): Promise<number> {
    const status = await this.client!.getStarsTransactions('self', { limit: 1 });
    return normalizeStarsAmount(status.balance);
  }

  /**
   * Resolve a public `t.me/<username>/<id>` link to a message.
   * Returns `null` for links that can never be starred (deleted/private/...).
   */
  async resolvePost(link: string): Promise<ResolvedTgPost | null> {
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
  }

  /** Send `count` paid star reactions to a message. */
  async sendStarReaction(
    chatId: number,
    messageId: number,
    count: number,
  ): Promise<StarReactionResult> {
    const reactions = await this.client!.sendPaidReaction({ chatId, message: messageId, count });
    return { paidReactions: reactions.paidReactions.length };
  }

  async close(): Promise<void> {
    if (!this.client) return;
    this.logger.debug('Closing Telegram client');
    await this.client.destroy();
    this.client = undefined;
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
