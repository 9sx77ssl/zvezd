import { isIssuanceStatus, type NoticeReason, type SkipReason } from '../../core/vocab';
import type { Database } from '../Database';
import type {
  IssuanceRecord,
  IssuanceStats,
  OverallStats,
  ReserveIssuanceInput,
  UserLinkRow,
  UserStat,
} from '../types';

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
  ad_comment_id: number | null;
  star_sent_at: number | null;
  confirmed_at: number | null;
  commented_at: number | null;
  created_at: number;
  updated_at: number;
}

function mapRow(row: IssuanceRow): IssuanceRecord {
  if (!isIssuanceStatus(row.status)) {
    throw new Error(`Unknown issuance status in database: "${row.status}"`);
  }
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
    status: row.status,
    skipReason: row.skip_reason as IssuanceRecord['skipReason'],
    error: row.error,
    attempts: row.attempts,
    commentId: row.comment_id,
    adCommentId: row.ad_comment_id,
    starSentAt: row.star_sent_at,
    confirmedAt: row.confirmed_at,
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

  /**
   * Posts that still need work: not started, star sent but comments missing,
   * confirmation posted but ad missing, or a retryable failure.
   */
  listPending(): IssuanceRecord[] {
    const rows = this.db
      .query<IssuanceRow, []>(`
        SELECT * FROM issuances
        WHERE status IN ('pending', 'star_sent', 'confirmed')
           OR (status = 'failed' AND skip_reason = 'retryable')
        ORDER BY post_id ASC
      `)
      .all();
    return rows.map(mapRow);
  }

  bumpAttempts(postId: number): void {
    this.db
      .query('UPDATE issuances SET attempts = attempts + 1, updated_at = ? WHERE post_id = ?')
      .run(Date.now(), postId);
  }

  /** Reset the attempt counter so a post can be retried after a cooldown. */
  resetAttempts(postId: number): void {
    this.db
      .query('UPDATE issuances SET attempts = 0, updated_at = ? WHERE post_id = ?')
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

  /**
   * Persist the resolved Telegram target before we act on it, so retries stick
   * to the same message (important for bare channel links resolved to "latest").
   */
  setTarget(postId: number, chatId: string, messageId: number): void {
    this.db
      .query(
        'UPDATE issuances SET tg_chat_id = ?, tg_message_id = ?, updated_at = ? WHERE post_id = ?',
      )
      .run(chatId, messageId, Date.now(), postId);
  }

  /** First (confirmation) comment has been posted. */
  markConfirmed(postId: number, commentId: number | null): void {
    this.db
      .query(`
        UPDATE issuances
        SET status = 'confirmed', comment_id = ?, confirmed_at = ?, error = NULL, updated_at = ?
        WHERE post_id = ?
      `)
      .run(commentId, Date.now(), Date.now(), postId);
  }

  /** Terminal state: both confirmation and ad comments are done. */
  markCommented(postId: number, adCommentId: number | null): void {
    this.db
      .query(`
        UPDATE issuances
        SET status = 'commented', ad_comment_id = ?, commented_at = ?, error = NULL, updated_at = ?
        WHERE post_id = ?
      `)
      .run(adCommentId, Date.now(), Date.now(), postId);
  }

  markSkipped(postId: number, reason: SkipReason): void {
    this.db
      .query(`
        UPDATE issuances
        SET status = 'skipped', skip_reason = ?, error = NULL, updated_at = ?
        WHERE post_id = ?
      `)
      .run(reason, Date.now(), postId);
  }

  /**
   * Terminal state for a submission we could not star (e.g. paid reactions
   * disabled, no posts in the channel). Stores the posted comment ids.
   */
  markSkippedWithComments(
    postId: number,
    reason: NoticeReason,
    commentId: number | null,
    adCommentId: number | null,
  ): void {
    const now = Date.now();
    this.db
      .query(`
        UPDATE issuances
        SET status = 'skipped', skip_reason = ?,
            comment_id = ?, ad_comment_id = ?, commented_at = ?, error = NULL, updated_at = ?
        WHERE post_id = ?
      `)
      .run(reason, commentId, adCommentId, now, now, postId);
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

  /** Aggregated per-user stats for the public stats page. */
  statsByUser(): UserStat[] {
    const rows = this.db
      .query<{ user_id: number; username: string; stars: number; posts: number }, []>(`
        SELECT
          poster_user_id                        AS user_id,
          MAX(poster_username)                  AS username,
          SUM(CASE WHEN star_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS stars,
          COUNT(*)                              AS posts
        FROM issuances
        GROUP BY poster_user_id
        HAVING stars > 0
        ORDER BY stars DESC, posts DESC, username ASC
      `)
      .all();

    return rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      stars: row.stars,
      posts: row.posts,
    }));
  }

  /**
   * Every `(user, link)` pair with how many times the user submitted that exact
   * link. Channel-level aggregation and cross-user matching happen in the
   * stats builder; the stored link is normalized, so the raw rows are enough.
   */
  linkRowsByUser(): UserLinkRow[] {
    const rows = this.db
      .query<{ user_id: number; username: string; link: string; c: number }, []>(`
        SELECT
          poster_user_id  AS user_id,
          MAX(poster_username) AS username,
          tg_link         AS link,
          COUNT(*)        AS c
        FROM issuances
        WHERE tg_link IS NOT NULL AND tg_link <> ''
        GROUP BY poster_user_id, tg_link
        ORDER BY user_id ASC, c DESC, tg_link ASC
      `)
      .all();

    return rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      link: row.link,
      count: row.c,
    }));
  }

  overallStats(): OverallStats {
    const row = this.db
      .query<{ users: number; posts: number; stars: number }, []>(`
        SELECT
          COUNT(DISTINCT poster_user_id) AS users,
          COUNT(*)                       AS posts,
          SUM(CASE WHEN star_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS stars
        FROM issuances
      `)
      .get();

    return { users: row?.users ?? 0, posts: row?.posts ?? 0, stars: row?.stars ?? 0 };
  }

  /** Timestamp of the very first issued star, or `null`. */
  firstStarAt(): number | null {
    const row = this.db
      .query<{ t: number | null }, []>('SELECT MIN(star_sent_at) AS t FROM issuances')
      .get();
    return row?.t ?? null;
  }

  /** Timestamp of the most recently issued star, or `null`. */
  lastStarAt(): number | null {
    const row = this.db
      .query<{ t: number | null }, []>('SELECT MAX(star_sent_at) AS t FROM issuances')
      .get();
    return row?.t ?? null;
  }

  /** Number of posts that received a star since the given timestamp. */
  starsSince(since: number): number {
    const row = this.db
      .query<{ c: number }, [number]>('SELECT COUNT(*) AS c FROM issuances WHERE star_sent_at >= ?')
      .get(since);
    return row?.c ?? 0;
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
      confirmed: 0,
      commented: 0,
      skipped: 0,
      failed: 0,
    };

    for (const row of rows) {
      if (!isIssuanceStatus(row.status)) continue;
      const status = row.status;
      if (status in stats) stats[status] = row.count;
      stats.total += row.count;
    }

    return stats;
  }
}
