export type IssuanceStatus = 'pending' | 'star_sent' | 'commented' | 'skipped' | 'failed';

export interface IssuanceRecord {
  id: number;
  threadId: number;
  postId: number;
  posterUserId: number;
  posterUsername: string;
  tgLink: string | null;
  tgChatId: string | null;
  tgMessageId: number | null;
  status: IssuanceStatus;
  skipReason: string | null;
  error: string | null;
  attempts: number;
  commentId: number | null;
  starSentAt: number | null;
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
