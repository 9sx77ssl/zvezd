import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../src/db/Database';
import { IssuanceRepository } from '../src/db/repositories/IssuanceRepository';
import { testLogger } from './helpers';

describe('IssuanceRepository', () => {
  let db: Database;
  let repo: IssuanceRepository;

  beforeEach(() => {
    db = new Database(':memory:', testLogger);
    repo = new IssuanceRepository(db);
  });

  it('reserves a post exactly once', () => {
    const input = {
      threadId: 1,
      postId: 100,
      posterUserId: 42,
      posterUsername: 'alice',
      tgLink: 'https://t.me/x/1',
    };

    expect(repo.reserve(input)).toBe(true);
    expect(repo.reserve(input)).toBe(false);
    expect(repo.findByPostId(100)?.status).toBe('pending');
  });

  it('runs the star -> confirmation -> ad state machine', () => {
    repo.reserve({
      threadId: 1,
      postId: 100,
      posterUserId: 42,
      posterUsername: 'alice',
      tgLink: 'https://t.me/x/1',
    });

    repo.markStarSent(100, '-100123', 25);
    let record = repo.findByPostId(100);
    expect(record?.status).toBe('star_sent');
    expect(record?.tgChatId).toBe('-100123');
    expect(record?.tgMessageId).toBe(25);

    repo.markConfirmed(100, 555);
    record = repo.findByPostId(100);
    expect(record?.status).toBe('confirmed');
    expect(record?.commentId).toBe(555);
    expect(record?.confirmedAt).not.toBeNull();

    repo.markCommented(100, 556);
    record = repo.findByPostId(100);
    expect(record?.status).toBe('commented');
    expect(record?.adCommentId).toBe(556);
    expect(record?.commentedAt).not.toBeNull();
  });

  it('tracks attempts and terminal states', () => {
    repo.reserve({
      threadId: 1,
      postId: 100,
      posterUserId: 42,
      posterUsername: 'alice',
      tgLink: null,
    });

    repo.bumpAttempts(100);
    repo.bumpAttempts(100);
    expect(repo.findByPostId(100)?.attempts).toBe(2);

    repo.markFailed(100, 'boom', true);
    expect(repo.findByPostId(100)?.skipReason).toBe('retryable');

    repo.markSkipped(100, 'comments_present');
    expect(repo.findByPostId(100)?.status).toBe('skipped');
    expect(repo.findByPostId(100)?.skipReason).toBe('comments_present');
  });

  it('reports empty state and stats', () => {
    expect(repo.isEmpty()).toBe(true);

    repo.reserve({
      threadId: 1,
      postId: 1,
      posterUserId: 1,
      posterUsername: 'a',
      tgLink: null,
    });
    repo.reserve({
      threadId: 1,
      postId: 2,
      posterUserId: 2,
      posterUsername: 'b',
      tgLink: null,
    });
    repo.markCommented(2, 10);

    expect(repo.isEmpty()).toBe(false);
    expect(repo.stats()).toMatchObject({ total: 2, pending: 1, commented: 1 });
  });

  it('lists posts that still need work', () => {
    const base = { threadId: 1, posterUserId: 1, posterUsername: 'a', tgLink: null };
    repo.reserve({ ...base, postId: 1 });
    repo.reserve({ ...base, postId: 2 });
    repo.markStarSent(2, '-100', 5);
    repo.reserve({ ...base, postId: 3 });
    repo.markConfirmed(3, 10);
    repo.markCommented(3, 11);
    repo.reserve({ ...base, postId: 4 });
    repo.markFailed(4, 'boom', true);
    repo.reserve({ ...base, postId: 5 });
    repo.markFailed(5, 'nope', false);
    repo.reserve({ ...base, postId: 6 });
    repo.markSkipped(6, 'comments_present');
    repo.reserve({ ...base, postId: 7 });
    repo.markConfirmed(7, 12);

    expect(repo.listPending().map((record) => record.postId)).toEqual([1, 2, 4, 7]);
  });

  it('aggregates per-user and overall stats', () => {
    const base = { threadId: 1, tgLink: null };
    repo.reserve({ ...base, postId: 1, posterUserId: 10, posterUsername: 'alice' });
    repo.markStarSent(1, '-100', 1);
    repo.reserve({ ...base, postId: 2, posterUserId: 10, posterUsername: 'alice' });
    repo.markStarSent(2, '-100', 2);
    repo.reserve({ ...base, postId: 3, posterUserId: 20, posterUsername: 'bob' });
    repo.markStarSent(3, '-100', 3);
    repo.reserve({ ...base, postId: 4, posterUserId: 20, posterUsername: 'bob' });

    const byUser = repo.statsByUser();
    expect(byUser).toEqual([
      { userId: 10, username: 'alice', stars: 2, posts: 2 },
      { userId: 20, username: 'bob', stars: 1, posts: 2 },
    ]);

    expect(repo.overallStats()).toEqual({ users: 2, posts: 4, stars: 3 });
  });

  it('groups stored links per user with submission counts', () => {
    const base = { threadId: 1 };
    repo.reserve({
      ...base,
      postId: 1,
      posterUserId: 10,
      posterUsername: 'alice',
      tgLink: 'https://t.me/foo/1',
    });
    repo.reserve({
      ...base,
      postId: 2,
      posterUserId: 10,
      posterUsername: 'alice',
      tgLink: 'https://t.me/foo/2',
    });
    repo.reserve({
      ...base,
      postId: 3,
      posterUserId: 10,
      posterUsername: 'alice',
      tgLink: 'https://t.me/bar',
    });
    repo.reserve({
      ...base,
      postId: 4,
      posterUserId: 10,
      posterUsername: 'alice',
      tgLink: 'https://t.me/foo/1',
    });
    repo.reserve({
      ...base,
      postId: 5,
      posterUserId: 20,
      posterUsername: 'bob',
      tgLink: 'https://t.me/foo/9',
    });
    repo.reserve({ ...base, postId: 6, posterUserId: 20, posterUsername: 'bob', tgLink: null });

    expect(repo.linkRowsByUser()).toEqual([
      { userId: 10, username: 'alice', link: 'https://t.me/foo/1', count: 2 },
      { userId: 10, username: 'alice', link: 'https://t.me/bar', count: 1 },
      { userId: 10, username: 'alice', link: 'https://t.me/foo/2', count: 1 },
      { userId: 20, username: 'bob', link: 'https://t.me/foo/9', count: 1 },
    ]);
  });

  it('exposes first/last star timestamps and recent counts', () => {
    const base = { threadId: 1, tgLink: null };
    repo.reserve({ ...base, postId: 1, posterUserId: 10, posterUsername: 'alice' });
    repo.markStarSent(1, '-100', 1);
    repo.reserve({ ...base, postId: 2, posterUserId: 20, posterUsername: 'bob' });
    repo.markStarSent(2, '-100', 2);

    expect(repo.firstStarAt()).not.toBeNull();
    expect(repo.lastStarAt()).not.toBeNull();
    expect(repo.lastStarAt()! >= repo.firstStarAt()!).toBe(true);
    expect(repo.starsSince(0)).toBe(2);
    expect(repo.starsSince(Date.now() + 60_000)).toBe(0);
  });
});
