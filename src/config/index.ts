import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from '../core/errors';
import { envSchema, type FileConfig, fileConfigSchema } from './schema';

export interface AppConfig {
  forum: {
    baseUrl: string;
    threadId: number;
    requestTimeoutMs: number;
    order: FileConfig['forum']['order'];
    token: string;
  };
  polling: FileConfig['polling'];
  star: FileConfig['star'];
  comment: FileConfig['comment'];
  database: { path: string };
  telegram: { sessionPath: string; apiId: number; apiHash: string };
  rateLimit: FileConfig['rateLimit'];
  retry: FileConfig['retry'];
  logging: FileConfig['logging'];
}

function stripEmptyValues(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '') result[key] = value;
  }
  return result;
}

function formatIssues(
  prefix: string,
  error: { issues: { path: PropertyKey[]; message: string }[] },
): string {
  const details = error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  return `${prefix}\n${details}`;
}

/**
 * Loads `config.yml`, injects secrets/overrides from the environment and
 * validates the result. Throws {@link ConfigError} with a readable summary.
 */
export function loadConfig(configPath = 'config.yml'): AppConfig {
  const env = envSchema.safeParse(stripEmptyValues(process.env));
  if (!env.success) {
    throw new ConfigError(
      formatIssues('Invalid environment. Did you copy .env.example to .env?', env.error),
    );
  }

  if (!existsSync(configPath)) {
    throw new ConfigError(`Config file not found: ${configPath}`);
  }

  const parsedYaml = parseYaml(readFileSync(configPath, 'utf8')) ?? {};
  const file = fileConfigSchema.safeParse(parsedYaml);
  if (!file.success) {
    throw new ConfigError(formatIssues(`Invalid config file: ${configPath}`, file.error));
  }

  const envValues = env.data;
  const values = file.data;

  return {
    forum: {
      baseUrl: envValues.FORUM_BASE_URL ?? values.forum.baseUrl,
      threadId: envValues.FORUM_THREAD_ID ?? values.forum.threadId,
      requestTimeoutMs: values.forum.requestTimeoutMs,
      order: values.forum.order,
      token: envValues.FORUM_TOKEN,
    },
    polling: {
      ...values.polling,
      intervalMs: envValues.POLL_INTERVAL_MS ?? values.polling.intervalMs,
    },
    star: {
      ...values.star,
      count: envValues.STAR_COUNT ?? values.star.count,
    },
    comment: values.comment,
    database: {
      path: envValues.DB_PATH ?? values.database.path,
    },
    telegram: {
      sessionPath: envValues.TG_SESSION_PATH ?? values.telegram.sessionPath,
      apiId: envValues.TG_API_ID,
      apiHash: envValues.TG_API_HASH,
    },
    rateLimit: values.rateLimit,
    retry: values.retry,
    logging: {
      level: envValues.LOG_LEVEL ?? values.logging.level,
      pretty: envValues.LOG_PRETTY ?? values.logging.pretty,
    },
  };
}
