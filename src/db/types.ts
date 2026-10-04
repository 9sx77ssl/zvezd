import type { IssuanceReason, IssuanceStatus } from '../core/vocab';

export type { IssuanceStatus } from '../core/vocab';

export interface IssuanceRecord {
  id: number;
  threadId: number;
  postId: number;
  posterUserId: number;
  posterUsername: string;
  tgLink: string | null;
  tgChatId: string | null;
  tgMessageId: number | null;
  /** Our paid-reaction count on the TG post before the first attempt for this forum post. */
  tgBaseline: number | null;
  status: IssuanceStatus;
  skipReason: IssuanceReason | null;
  error: string | null;
  attempts: number;
  commentId: number | null;
  adCommentId: number | null;
  starSentAt: number | null;
  confirmedAt: number | null;
  commentedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReserveIssuanceInput {
  threadId: number;
  postId: number;
  posterUserId: number;
  posterUsername: string;
  tgLink: string | null;
}

export type IssuanceStats = Record<IssuanceStatus | 'total', number>;

/** Per-user aggregate for the forum stats page. */
export interface UserStat {
  userId: number;
  username: string;
  /** Stars issued to this user. */
  stars: number;
  /** Posts submitted by this user. */
  posts: number;
}

/** Overall aggregate for the forum stats page. */
export interface OverallStats {
  users: number;
  posts: number;
  stars: number;
}

/** A single `(user, link)` group as read from the database. */
export interface UserLinkRow {
  userId: number;
  username: string;
  /** Normalized link exactly as stored (`https://t.me/<channel>[/<id>]`). */
  link: string;
  /** How many times this user submitted this exact link. */
  count: number;
}

/** Another forum user that submitted one of the same channels. */
export interface SharedUser {
  userId: number;
  username: string;
}

/** A channel a user submitted, with how many times and who else used it. */
export interface UserChannelRef {
  channel: string;
  count: number;
  /** Other users that submitted this same channel (empty when unique). */
  sharedWith: SharedUser[];
}

/** Per-user channel links (with per-channel overlaps) for the stats page. */
export interface UserChannelStats {
  userId: number;
  username: string;
  channels: UserChannelRef[];
}
