import type { Database } from '../Database';
import type { IssuanceRecord, IssuanceStats, IssuanceStatus, ReserveIssuanceInput } from '../types';

interface IssuanceRow {
  id: number;
  thread_id: number;
  post_id: number;
  poster_user_id: number;
  poster_username: string;
  tg_link: string | null;
  tg_chat_id: string | null;
  tg_message_id: number | null;
  tg_baseline: number | null;
  status: string;
  skip_reason: string | null;
  error: string | null;
  attempts: number;
  comment_id: number | null;
  star_sent_at: number | null;
  commented_at: number | null;
  created_at: number;
  updated_at: number;
}

function mapRow(row: IssuanceRow): IssuanceRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    postId: row.post_id,
    posterUserId: row.poster_user_id,
    posterUsername: row.poster_username,
    tgLink: row.tg_link,
    tgChatId: row.tg_chat_id,
    tgMessageId: row.tg_message_id,
    tgBaseline: row.tg_baseline,
    status: row.status as IssuanceStatus,
    skipReason: row.skip_reason,
    error: row.error,
    attempts: row.attempts,
    commentId: row.comment_id,
    starSentAt: row.star_sent_at,
    commentedAt: row.commented_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Persistence for star issuances. `post_id` is UNIQUE, which together with
 * `reserve()` gives us a race-free "claim this post exactly once" primitive.
 */
export class IssuanceRepository {
  constructor(private readonly db: Database) {}

  /**
   * Attempt to claim a post. Returns `true` when this call created the row and
   * the caller now owns processing it, `false` when it was already known.
   */
  reserve(input: ReserveIssuanceInput): boolean {
    const now = Date.now();
    const result = this.db
      .query(`
        INSERT OR IGNORE INTO issuances
          (thread_id, post_id, poster_user_id, poster_username, tg_link, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      `)
      .run(
        input.threadId,
        input.postId,
        input.posterUserId,
        input.posterUsername,
        input.tgLink,
        now,
        now,
      );

    return result.changes === 1;
  }

  findByPostId(postId: number): IssuanceRecord | null {
    const row = this.db
      .query<IssuanceRow, [number]>('SELECT * FROM issuances WHERE post_id = ?')
      .get(postId);
    return row ? mapRow(row) : null;
  }

  bumpAttempts(postId: number): void {
    this.db
      .query('UPDATE issuances SET attempts = attempts + 1, updated_at = ? WHERE post_id = ?')
      .run(Date.now(), postId);
  }

  /** Store the pre-send paid-reaction baseline for idempotent star issuance. */
  setStarBaseline(postId: number, baseline: number): void {
    this.db
      .query('UPDATE issuances SET tg_baseline = ?, updated_at = ? WHERE post_id = ?')
      .run(baseline, Date.now(), postId);
  }

  markStarSent(postId: number, chatId: string, messageId: number): void {
    this.db
      .query(`
        UPDATE issuances
        SET status = 'star_sent', tg_chat_id = ?, tg_message_id = ?, star_sent_at = ?,
            error = NULL, updated_at = ?
        WHERE post_id = ?
      `)
      .run(chatId, messageId, Date.now(), Date.now(), postId);
  }

  markCommented(postId: number, commentId: number | null): void {
    this.db
      .query(`
        UPDATE issuances
        SET status = 'commented', comment_id = ?, commented_at = ?, error = NULL, updated_at = ?
        WHERE post_id = ?
      `)
      .run(commentId, Date.now(), Date.now(), postId);
  }

  markSkipped(postId: number, reason: string): void {
    this.db
      .query(`
        UPDATE issuances
        SET status = 'skipped', skip_reason = ?, error = NULL, updated_at = ?
        WHERE post_id = ?
      `)
      .run(reason, Date.now(), postId);
  }

  markFailed(postId: number, error: string, retryable: boolean): void {
    this.db
      .query(`
        UPDATE issuances
        SET status = 'failed', error = ?, skip_reason = ?, updated_at = ?
        WHERE post_id = ?
      `)
      .run(error, retryable ? 'retryable' : 'permanent', Date.now(), postId);
  }

  isEmpty(): boolean {
    const row = this.db
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM issuances')
      .get();
    return (row?.count ?? 0) === 0;
  }

  stats(): IssuanceStats {
    const rows = this.db
      .query<{ status: string; count: number }, []>(
        'SELECT status, COUNT(*) AS count FROM issuances GROUP BY status',
      )
      .all();

    const stats: IssuanceStats = {
      total: 0,
      pending: 0,
      star_sent: 0,
      commented: 0,
      skipped: 0,
      failed: 0,
    };

    for (const row of rows) {
      const status = row.status as IssuanceStatus;
      if (status in stats) stats[status] = row.count;
      stats.total += row.count;
    }

    return stats;
  }
}
