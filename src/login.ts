import { TelegramClient } from '@mtcute/bun';
import { loadConfig } from './config';
import { ensureParentDir } from './core/fs';
import { errorToLog, Logger } from './core/logger';

/**
 * One-time interactive authorization.
 *
 * Usage: `bun run login`
 *
 * The session is persisted by mtcute in the SQLite storage configured via
 * `telegram.sessionPath`, so the main bot runs fully headless afterwards.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = Logger.create({ level: config.logging.level, pretty: config.logging.pretty });

  ensureParentDir(config.telegram.sessionPath);

  const client = new TelegramClient({
    apiId: config.telegram.apiId,
    apiHash: config.telegram.apiHash,
    storage: config.telegram.sessionPath,
  });

  logger.info('Starting interactive Telegram login');

  const me = await client.start({
    phone: () => client.input('Phone (e.g. +79991234567): '),
    code: () => client.input('Login code: '),
    password: () => client.input('2FA password (leave empty if none): '),
  });

  const session = await client.exportSession();
  logger.info('Logged in successfully', {
    id: me.id,
    username: me.username ?? null,
    displayName: me.displayName,
  });

  console.log('\nSession stored at:', config.telegram.sessionPath);
  console.log('Backup session string (treat as a password, never commit it):\n');
  console.log(session);

  await client.destroy();
}

main().catch((err: unknown) => {
  console.error('Login failed:', errorToLog(err));
  process.exit(1);
});
