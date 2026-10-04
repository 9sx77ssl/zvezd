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

describe('env schema (secrets only)', () => {
  it('accepts the three credentials', () => {
    const env = envSchema.parse(baseEnv);

    expect(env.FORUM_TOKEN).toBe('t');
    expect(env.TG_API_ID).toBe(1);
    expect(env.TG_API_HASH).toBe('h');
  });

  it('rejects missing or invalid credentials', () => {
    expect(envSchema.safeParse({ TG_API_ID: '1', TG_API_HASH: 'h' }).success).toBe(false);
    expect(
      envSchema.safeParse({ FORUM_TOKEN: 't', TG_API_ID: 'nope', TG_API_HASH: 'h' }).success,
    ).toBe(false);
  });

  it('ignores injected override variables', () => {
    const env = envSchema.parse({ ...baseEnv, DRY_RUN: 'true', POLL_INTERVAL_MS: '1' });

    expect('DRY_RUN' in env).toBe(false);
    expect('POLL_INTERVAL_MS' in env).toBe(false);
  });
});
