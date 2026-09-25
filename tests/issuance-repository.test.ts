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

  it('runs the star -> comment state machine', () => {
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

    repo.markCommented(100, 555);
    record = repo.findByPostId(100);
    expect(record?.status).toBe('commented');
    expect(record?.commentId).toBe(555);
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
    repo.markCommented(3, 10);
    repo.reserve({ ...base, postId: 4 });
    repo.markFailed(4, 'boom', true);
    repo.reserve({ ...base, postId: 5 });
    repo.markFailed(5, 'nope', false);
    repo.reserve({ ...base, postId: 6 });
    repo.markSkipped(6, 'comments_present');

    expect(repo.listPending().map((record) => record.postId)).toEqual([1, 2, 4]);
  });
});
