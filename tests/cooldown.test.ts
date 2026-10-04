import { describe, expect, it } from 'bun:test';
import { Cooldown } from '../src/core/async';
import { ForumClient } from '../src/forum/ForumClient';
import { rateLimiterFromPerMinute } from '../src/forum/RateLimiter';
import { testLogger } from './helpers';

describe('Cooldown', () => {
  it('spaces consecutive actions by at least the interval', async () => {
    const cooldown = new Cooldown(50);
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) {
      await cooldown.wait();
      starts.push(Date.now());
    }

    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(40);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(40);
  });

  it('serializes concurrent waiters in arrival order', async () => {
    const cooldown = new Cooldown(30);
    const order: number[] = [];
    const startedAt = Date.now();

    await Promise.all(
      [0, 1, 2].map(async (index) => {
        await cooldown.wait();
        order.push(index);
      }),
    );

    expect(order).toEqual([0, 1, 2]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  it('does not wait when the interval is zero', async () => {
    const cooldown = new Cooldown(0);
    const startedAt = Date.now();

    await Promise.all([cooldown.wait(), cooldown.wait(), cooldown.wait()]);

    expect(Date.now() - startedAt).toBeLessThan(50);
  });
});

describe('ForumClient cooldown', () => {
  it('paces writes but never reads', async () => {
    const originalFetch = globalThis.fetch;
    let gateCalls = 0;

    globalThis.fetch = (async (_input: URL | Request | string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body =
        method === 'POST'
          ? { comment: { post_comment_id: 7, post_id: 1, user_id: 1, username: 'bot' } }
          : { comments: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      const forum = new ForumClient({
        baseUrl: 'https://api.lolz.team',
        token: 'test-token',
        timeoutMs: 1_000,
        retry: { attempts: 1, delayMs: 1, maxDelayMs: 1 },
        logger: testLogger,
        readLimiter: rateLimiterFromPerMinute(6_000, 'read'),
        writeLimiter: rateLimiterFromPerMinute(6_000, 'write'),
        cooldown: {
          wait: async () => {
            gateCalls += 1;
          },
        },
      });

      await forum.getComments(1);
      expect(gateCalls).toBe(0);

      await forum.createComment(1, 'hello');
      expect(gateCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
