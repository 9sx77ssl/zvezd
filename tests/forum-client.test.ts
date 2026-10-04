import { describe, expect, it } from 'bun:test';
import { ForumApiError } from '../src/core/errors';
import { ForumClient } from '../src/forum/ForumClient';
import { rateLimiterFromPerMinute } from '../src/forum/RateLimiter';
import { testLogger } from './helpers';

function makeClient(): ForumClient {
  return new ForumClient({
    baseUrl: 'https://api.lolz.team',
    token: 'test-token',
    timeoutMs: 1_000,
    retry: { attempts: 3, delayMs: 1, maxDelayMs: 2 },
    logger: testLogger,
    readLimiter: rateLimiterFromPerMinute(6_000),
    writeLimiter: rateLimiterFromPerMinute(6_000),
  });
}

const meOk = () =>
  new Response(JSON.stringify({ user: { user_id: 1, username: 'bot' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('ForumClient retries', () => {
  it('retries a GET after a 5xx and succeeds', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? new Response('{}', { status: 500, statusText: 'boom' }) : meOk();
    }) as unknown as typeof fetch;

    try {
      const me = await makeClient().getMe();
      expect(me.user.user_id).toBe(1);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never retries a write', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('{}', { status: 500, statusText: 'boom' });
    }) as unknown as typeof fetch;

    try {
      await expect(makeClient().createComment(1, 'hi')).rejects.toBeInstanceOf(ForumApiError);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails loudly on an unexpected payload', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ nope: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    try {
      await expect(makeClient().getMe()).rejects.toBeInstanceOf(ForumApiError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
