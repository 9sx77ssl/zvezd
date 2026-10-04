import { describe, expect, it } from 'bun:test';
import { sleep } from '../src/core/async';
import { Database } from '../src/db/Database';
import { IssuanceRepository } from '../src/db/repositories/IssuanceRepository';
import type { ForumClient } from '../src/forum/ForumClient';
import { StatsService } from '../src/services/StatsService';
import { makeConfig, testLogger } from './helpers';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

function setup(options: { enabled?: boolean; getThread?: () => Promise<unknown> } = {}) {
  const config = makeConfig({
    stats: {
      enabled: options.enabled ?? true,
      threadId: 42,
      intervalMs: 60_000,
      titleTemplate: 'stats {date}',
      links: { enabled: true },
    },
  });
  const db = new Database(':memory:', testLogger);
  const repository = new IssuanceRepository(db);

  const calls = { threads: [] as number[], titles: [] as string[], bodies: [] as number[] };
  const forum = {
    getThread: async (id: number) => {
      calls.threads.push(id);
      if (options.getThread) return options.getThread();
      return { thread: { thread_id: id, first_post_id: 777 } };
    },
    editThread: async (id: number, title: string) => {
      calls.titles.push(title);
      return { thread: { thread_id: id } };
    },
    editPost: async (id: number, _body: string) => {
      calls.bodies.push(id);
      return { post: { post_id: id } };
    },
  };

  const service = new StatsService({
    config,
    forum: forum as unknown as ForumClient,
    repository,
    telegram: { getBalance: async () => 100 },
    logger: testLogger,
  });

  return { service, calls, db };
}

describe('StatsService', () => {
  it('rewrites the title and the first post on start', async () => {
    const { service, calls } = setup();

    const running = service.start();
    await waitFor(() => calls.titles.length >= 1);
    service.stop();
    await running;

    expect(calls.threads).toEqual([42]);
    expect(calls.titles[0]).toContain('stats ');
    expect(calls.bodies).toEqual([777]);
  });

  it('does nothing when disabled', async () => {
    const { service, calls } = setup({ enabled: false });

    await service.start();

    expect(calls.threads).toEqual([]);
    expect(calls.titles).toEqual([]);
  });

  it('gives up when the stats thread cannot be read', async () => {
    const { service, calls } = setup({
      getThread: async () => {
        throw new Error('boom');
      },
    });

    await service.start();

    expect(calls.titles).toEqual([]);
    expect(calls.bodies).toEqual([]);
  });
});
