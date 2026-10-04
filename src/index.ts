import { Application } from './app/Application';
import { loadConfig } from './config';
import { errorToLog, Logger } from './core/logger';

async function main(): Promise<void> {
  const config = loadConfig();

  // `bun run dry` passes `--dry`: simulate without spending stars. The
  // environment is reserved for credentials only.
  if (process.argv.includes('--dry')) {
    config.star = { ...config.star, dryRun: true };
  }

  const logger = Logger.create({ level: config.logging.level, pretty: config.logging.pretty });

  const app = await Application.create(config, logger);

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info(`Received ${signal}, stopping gracefully`);
    app.stop();
  };

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  await app.run();
}

main().catch((err: unknown) => {
  // Last-resort logger in case the structured one could not be built.
  console.error('Fatal error:', errorToLog(err));
  process.exit(1);
});
