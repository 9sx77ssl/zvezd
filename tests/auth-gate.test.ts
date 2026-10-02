import { describe, expect, it } from 'bun:test';
import { parseEnvToken } from '../src/config/env-file';
import { sleep } from '../src/core/async';
import { ShuttingDownError } from '../src/core/errors';
import { AuthGate } from '../src/forum/AuthGate';
import { ForumClient } from '../src/forum/ForumClient';
import { rateLimiterFromPerMinute } from '../src/forum/RateLimiter';
import { testLogger } from './helpers';

interface GateSetup {
  token?: string;
  checkIntervalMs?: number;
  probe?: () => Promise<boolean>;
  applyToken?: (token: string) => void;
}

function makeGate(setup: GateSetup = {}) {
  const applied: string[] = [];
  let fileToken = setup.token ?? 'dead-token';

  const gate = new AuthGate({
    logger: testLogger,
    token: setup.token ?? 'dead-token',
    envPath: '.env',
    readToken: () => fileToken,
    applyToken:
      setup.applyToken ??
      ((token: string) => {
        fileToken = token;
        applied.push(token);
      }),
    probe: setup.probe ?? (async () => false),
    checkIntervalMs: setup.checkIntervalMs ?? 60_000,
    logEveryChecks: 0,
  });

  return {
    gate,
    applied,
    setFileToken: (token: string) => {
      fileToken = token;
    },
  };
}

function makeClient(token = 'dead-token'): ForumClient {
  return new ForumClient({
    baseUrl: 'https://api.lolz.team',
    token,
    timeoutMs: 1_000,
    retry: { attempts: 3, delayMs: 1, maxDelayMs: 2 },
    logger: testLogger,
    readLimiter: rateLimiterFromPerMinute(600, 'read'),
    writeLimiter: rateLimiterFromPerMinute(600, 'write'),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

describe('auth gate', () => {
  it('parks requests until the token file changes', async () => {
    const { gate, applied, setFileToken } = makeGate();

    gate.pause();
    expect(gate.isPaused).toBe(true);

    const parked = gate.waitWhilePaused();
    let resumed = false;
    void parked.then(() => {
      resumed = true;
    });

    await gate.check();
    expect(gate.isPaused).toBe(true);
    expect(resumed).toBe(false);
    expect(applied).toEqual([]);

    setFileToken('fresh-token');
    await gate.check();

    expect(gate.isPaused).toBe(false);
    expect(applied).toEqual(['fresh-token']);
    await parked;
  });

  it('resumes on its own when the forum accepts the token again', async () => {
    const { gate } = makeGate({ probe: async () => true });

    gate.pause();
    const parked = gate.waitWhilePaused();
    await gate.check();

    expect(gate.isPaused).toBe(false);
    await parked;
  });

  it('rejects parked requests when the bot stops', async () => {
    const { gate } = makeGate();

    gate.pause();
    const parked = gate.waitWhilePaused();
    gate.stop();

    let error: unknown;
    try {
      await parked;
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ShuttingDownError);
  });

  it('keeps checking the token file once started', async () => {
    const { gate, setFileToken } = makeGate({ checkIntervalMs: 10 });

    gate.pause();
    gate.start();
    setFileToken('fresh-token');

    await waitFor(() => !gate.isPaused);
    gate.stop();
  });
});

describe('forum client auth', () => {
  it('parks a 401 response and repeats it with the new token', async () => {
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];

    globalThis.fetch = (async (_input: URL | Request | string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers.authorization ?? '';
      seen.push(auth);

      if (auth !== 'Bearer fresh-token') {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          statusText: 'Unauthorized',
        });
      }
      return new Response(JSON.stringify({ user: { user_id: 42, username: 'bot' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      const forum = makeClient();
      const { gate, setFileToken } = makeGate({ applyToken: (token) => forum.setToken(token) });
      forum.setAuthGate(gate);

      const pending = forum.getMe();
      await waitFor(() => gate.isPaused);
      await gate.check();
      expect(gate.isPaused).toBe(true);
      expect(seen).toEqual(['Bearer dead-token']);

      setFileToken('fresh-token');
      await gate.check();

      const me = await pending;
      expect(me.user.user_id).toBe(42);
      expect(seen).toEqual(['Bearer dead-token', 'Bearer fresh-token']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('probeAuth reports the token state without parking anything', async () => {
    const originalFetch = globalThis.fetch;
    let status = 401;

    globalThis.fetch = (async () => new Response('x', { status })) as unknown as typeof fetch;

    try {
      const forum = makeClient();
      expect(await forum.probeAuth()).toBe(false);

      status = 200;
      expect(await forum.probeAuth()).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('parseEnvToken', () => {
  it('reads plain, quoted and exported values', () => {
    expect(parseEnvToken('FORUM_TOKEN=abc')).toBe('abc');
    expect(parseEnvToken('export FORUM_TOKEN=" abc "\nOTHER=1')).toBe('abc');
    expect(parseEnvToken("FORUM_TOKEN='xyz'")).toBe('xyz');
    expect(parseEnvToken('TG_API_HASH=1\nFORUM_TOKEN = tok \n')).toBe('tok');
  });

  it('returns null when the token is missing or empty', () => {
    expect(parseEnvToken('TG_API_HASH=1')).toBeNull();
    expect(parseEnvToken('FORUM_TOKEN=')).toBeNull();
    expect(parseEnvToken('')).toBeNull();
  });
});
