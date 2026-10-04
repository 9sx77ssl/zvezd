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
  pacing: FileConfig['pacing'];
  balance: FileConfig['balance'];
  star: FileConfig['star'];
  comment: FileConfig['comment'];
  rateLimit: FileConfig['rateLimit'];
  retry: FileConfig['retry'];
  database: { path: string };
  auth: FileConfig['auth'];
  telegram: { sessionPath: string; apiId: number; apiHash: string };
  stats: FileConfig['stats'];
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
 * Loads `config.yml`, injects the secrets from the environment (`FORUM_TOKEN`,
 * `TG_API_ID`, `TG_API_HASH`) and validates the result. All behaviour lives in
 * `config.yml`; the environment is only for credentials.
 * Throws {@link ConfigError} with a readable summary.
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
      baseUrl: values.forum.baseUrl,
      threadId: values.forum.threadId,
      requestTimeoutMs: values.forum.requestTimeoutMs,
      order: values.forum.order,
      token: envValues.FORUM_TOKEN,
    },
    polling: values.polling,
    pacing: values.pacing,
    balance: values.balance,
    star: values.star,
    comment: values.comment,
    rateLimit: values.rateLimit,
    retry: values.retry,
    database: values.database,
    auth: values.auth,
    telegram: {
      sessionPath: values.telegram.sessionPath,
      apiId: envValues.TG_API_ID,
      apiHash: envValues.TG_API_HASH,
    },
    stats: values.stats,
    logging: values.logging,
  };
}
