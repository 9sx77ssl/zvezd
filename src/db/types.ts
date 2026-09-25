export type IssuanceStatus =
  | 'pending'
  | 'star_sent'
  | 'confirmed'
  | 'commented'
  | 'skipped'
  | 'failed';

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
  skipReason: string | null;
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
