import { describe, expect, it } from 'bun:test';
import { envSchema, fileConfigSchema } from '../src/config/schema';

const minimal = { forum: { threadId: 1 }, stats: { threadId: 2 } };
const baseEnv = { FORUM_TOKEN: 't', TG_API_ID: '1', TG_API_HASH: 'h' };

describe('file config schema', () => {
  it('applies defaults and the renamed keys', () => {
    const config = fileConfigSchema.parse(minimal);

    expect(config.forum.requestTimeoutMs).toBe(30_000);
    expect(config.pacing.cooldownMs).toBe(6_000);
    expect(config.retry.failedPostCooldownMs).toBe(3_600_000);
    expect(config.auth.tokenFile).toBe('.env');
    expect(config.auth.tokenCheckIntervalMs).toBe(60_000);
    expect(config.comment.linkUnresolvableText.length).toBeGreaterThan(0);
  });

  it('no longer has the removed keys', () => {
    const config = fileConfigSchema.parse(minimal);

    expect('idlePage' in config.polling).toBe(false);
    expect('cooldownMs' in config.retry).toBe(false);
    expect('envPath' in config.auth).toBe(false);
  });
});

describe('env boolean parsing', () => {
  it('accepts common truthy and falsy spellings', () => {
    expect(envSchema.parse({ ...baseEnv, DRY_RUN: 'YES' }).DRY_RUN).toBe(true);
    expect(envSchema.parse({ ...baseEnv, DRY_RUN: '1' }).DRY_RUN).toBe(true);
    expect(envSchema.parse({ ...baseEnv, DRY_RUN: 'on' }).DRY_RUN).toBe(true);
    expect(envSchema.parse({ ...baseEnv, LOG_PRETTY: 'off' }).LOG_PRETTY).toBe(false);
    expect(envSchema.parse({ ...baseEnv, LOG_PRETTY: '0' }).LOG_PRETTY).toBe(false);
    expect(envSchema.parse(baseEnv).DRY_RUN).toBeUndefined();
  });

  it('rejects nonsense values instead of silently disabling', () => {
    expect(envSchema.safeParse({ ...baseEnv, DRY_RUN: 'maybe' }).success).toBe(false);
  });
});
