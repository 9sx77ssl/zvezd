import type { IgnoreReason, SkipReason } from '../core/vocab';
import type { ForumPost } from '../forum/types';
import type { TgLink } from '../telegram/link-parser';

/**
 * Pluggable post checks.
 *
 * {@link PRE_CHECKS} run before anything is persisted and can silently ignore a
 * post or mark it as a no-message skip. Adding a rule is a single entry in the
 * list.
 *
 * Notice-producing conditions (missing link, disabled paid reactions, empty
 * channel...) are thrown as a `NoticeError` subclass from wherever they are
 * detected; the service routes every one of them through the same
 * notice + ad + terminal-skip handler, and their code/reason/text come from the
 * single `NOTICES` registry.
 */
export interface CheckContext {
  selfForumUserId: number;
  link: TgLink | null;
}

export type PreCheckDecision =
  | { kind: 'ignore'; reason: IgnoreReason }
  | { kind: 'skip'; reason: SkipReason };

export interface PreCheck {
  readonly name: string;
  run(post: ForumPost, ctx: CheckContext): PreCheckDecision | null;
}

export const PRE_CHECKS: readonly PreCheck[] = [
  {
    name: 'first_post',
    run: (post) => (post.is_first_post ? { kind: 'ignore', reason: 'first_post' } : null),
  },
  {
    name: 'deleted_post',
    run: (post) =>
      post.message_state === 'deleted' ? { kind: 'ignore', reason: 'deleted' } : null,
  },
  {
    name: 'hidden_post',
    run: (post) =>
      post.message_state !== 'visible' ? { kind: 'ignore', reason: 'unpublished' } : null,
  },
  {
    name: 'own_post',
    run: (post, ctx) =>
      post.user_id === ctx.selfForumUserId ? { kind: 'ignore', reason: 'own_post' } : null,
  },
];

/** First pre-check that rejects the post, or `null` when it may proceed. */
export function runPreChecks(post: ForumPost, ctx: CheckContext): PreCheckDecision | null {
  for (const check of PRE_CHECKS) {
    const decision = check.run(post, ctx);
    if (decision) return decision;
  }
  return null;
}
