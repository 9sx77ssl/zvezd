import { describe, expect, it } from 'bun:test';
import { Database } from '../src/db/Database';
import { IssuanceRepository } from '../src/db/repositories/IssuanceRepository';
import { StateRepository } from '../src/db/repositories/StateRepository';
import type { ForumClient } from '../src/forum/ForumClient';
import type { ForumPost } from '../src/forum/types';
import type { IssuanceService } from '../src/services/IssuanceService';
import { ScannerService } from '../src/services/ScannerService';
import { makeConfig, makePost, testLogger } from './helpers';

type OutcomeKind = 'processed' | 'already' | 'ignored';

interface SetupOptions {
  completed?: boolean;
  outcomeFor?: (post: ForumPost, page: number) => OutcomeKind;
  stopOnEmptyPage?: boolean;
  pageOfPost?: Record<number, ForumPost[]>;
  getBalance?: () => Promise<number>;
}

function setup(pages: Record<number, ForumPost[]>, options: SetupOptions = {}) {
  const db = new Database(':memory:', testLogger);
  const repository = new IssuanceRepository(db);
  const state = new StateRepository(db);
  if (options.completed) state.setBool('backfill_completed', true);

  const requestedPages: number[] = [];
  const requestedPageOfPost: number[] = [];
  const processed: number[] = [];
  let scanner: ScannerService;

  const forum = {
    getPosts: async (params: { page?: number; pageOfPostId?: number }) => {
      if (params.pageOfPostId !== undefined) {
        requestedPageOfPost.push(params.pageOfPostId);
        return {
          posts: options.pageOfPost?.[params.pageOfPostId] ?? [],
          posts_total: 99,
          links: { pages: 5, page: 1 },
        };
      }
      const page = params.page ?? 1;
      requestedPages.push(page);
      const posts = pages[page] ?? [];
      if (posts.length === 0 && options.stopOnEmptyPage) scanner.stop();
      return { posts, posts_total: 99, links: { pages: 5, page } };
    },
  };

  const issuance = {
    process: async (post: ForumPost) => {
      processed.push(post.post_id);
      const kind = options.outcomeFor?.(post, post.post_id) ?? 'processed';
      if (kind === 'processed') {
        return {
          kind,
          postId: post.post_id,
          username: 'x',
          link: 'l',
          commentId: 1,
          balance: 10,
        };
      }
      if (kind === 'already') return { kind, postId: post.post_id, status: 'commented' };
      return { kind: 'ignored', postId: post.post_id, reason: 'no_tg_link' };
    },
  };

  scanner = new ScannerService({
    config: makeConfig(),
    forum: forum as unknown as ForumClient,
    issuance: issuance as unknown as IssuanceService,
    repository,
    state,
    telegram: { getBalance: options.getBalance ?? (async () => 100) },
    logger: testLogger,
  });

  const walk = (full: boolean, context: 'startup' | 'poll' = 'startup') => {
    // `walkPages` is normally driven by `start()`, which flips `running` on.
    (scanner as unknown as { running: boolean }).running = true;
    return (
      scanner as unknown as {
        walkPages: (f: boolean, c: 'startup' | 'poll') => Promise<unknown[]>;
      }
    ).walkPages(full, context);
  };

  const retryPending = () => {
    (scanner as unknown as { running: boolean }).running = true;
    return (scanner as unknown as { retryPending: () => Promise<void> }).retryPending();
  };

  return {
    scanner,
    walk,
    retryPending,
    requestedPages,
    requestedPageOfPost,
    processed,
    state,
    repository,
  };
}

const p = (id: number) => makePost({ post_id: id });

describe('ScannerService page walking', () => {
  it('full backfill walks pages 1..N until an empty page', async () => {
    const { walk, requestedPages, processed } = setup({
      1: [p(1), p(2)],
      2: [p(3)],
      3: [],
    });

    await walk(true);

    expect(requestedPages).toEqual([1, 2, 3]);
    expect(processed).toEqual([1, 2, 3]);
  });

  it('catch-up stops as soon as a page has nothing new', async () => {
    const { walk, requestedPages } = setup(
      { 1: [p(1)], 2: [p(2)], 3: [p(3)] },
      { completed: true, outcomeFor: () => 'already' },
    );

    await walk(false, 'poll');

    expect(requestedPages).toEqual([1]);
  });

  it('poll walks forward across a burst until a known page', async () => {
    const { walk, requestedPages, processed } = setup(
      { 1: [p(1)], 2: [p(2)], 3: [p(3)] },
      {
        completed: true,
        outcomeFor: (post) => (post.post_id === 1 ? 'processed' : 'already'),
      },
    );

    await walk(false, 'poll');

    expect(requestedPages).toEqual([1, 2]);
    expect(processed).toEqual([1, 2]);
  });

  it('start() stores the backfill marker and then stops polling', async () => {
    const { scanner, requestedPages, state } = setup(
      { 1: [p(1)], 2: [], 3: [] },
      { stopOnEmptyPage: true },
    );

    await scanner.start();

    expect(requestedPages).toEqual([1, 2]);
    expect(state.getBool('backfill_completed')).toBe(true);
  });

  it('retries unfinished posts via page_of_post_id without rescanning the thread', async () => {
    const { retryPending, requestedPageOfPost, processed, repository } = setup(
      { 1: [p(1)] },
      {
        completed: true,
        pageOfPost: { 999: [p(999), p(1000)] },
        outcomeFor: () => 'processed',
      },
    );

    // A deep post that was left unfinished by a previous run.
    repository.reserve({
      threadId: 1,
      postId: 999,
      posterUserId: 1,
      posterUsername: 'deep',
      tgLink: null,
    });

    await retryPending();

    expect(requestedPageOfPost).toEqual([999]);
    expect(processed).toEqual([999]);
  });

  it('re-reads the real balance on every check', async () => {
    let calls = 0;
    const { scanner } = setup(
      { 1: [p(1)] },
      {
        getBalance: async () => {
          calls += 1;
          return 5;
        },
      },
    );

    const internals = scanner as unknown as {
      balance: number | null;
      running: boolean;
      ensureSufficientStars: () => Promise<void>;
    };

    internals.running = true;
    internals.balance = 9999; // even a fresh-looking cache is re-read
    await internals.ensureSufficientStars();

    expect(calls).toBe(1);
    expect(internals.balance).toBe(5);
  });
});
