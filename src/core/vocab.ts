/**
 * Single source of truth for the issuance vocabulary: persisted statuses,
 * non-terminal ignore/skip reasons, failure classes and user-facing notices.
 *
 * Everything that used to be a scattered string literal (DB values, SQL,
 * error codes, config text keys, log wording) is declared here once. Adding a
 * notice is a single row in {@link NOTICES}; adding a status or reason is a
 * single entry in the corresponding list.
 */

/** Values stored in `issuances.status`. */
export const ISSUANCE_STATUSES = [
  'pending',
  'star_sent',
  'confirmed',
  'commented',
  'skipped',
  'failed',
] as const;
export type IssuanceStatus = (typeof ISSUANCE_STATUSES)[number];

/** Posts silently ignored before any DB row is created. */
export const IGNORE_REASONS = ['first_post', 'deleted', 'unpublished', 'own_post'] as const;
export type IgnoreReason = (typeof IGNORE_REASONS)[number];

/** Terminal skips that persist a row but never message the user. */
export const SKIP_REASONS = ['dry_run', 'comments_present'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** How a failed submission is classified for retries. */
export const FAILURE_REASONS = ['retryable', 'permanent'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/**
 * User-facing notices. One row drives everything:
 *  - `code`   — machine code on the thrown `NoticeError`;
 *  - `reason` — value persisted in `issuances.skip_reason`;
 *  - `text`   — which `comment.*` config field holds the message.
 */
export const NOTICES = {
  paidReactionsDisabled: {
    code: 'PAID_REACTIONS_DISABLED',
    reason: 'paid_reactions_disabled',
    text: 'paidReactionsDisabledText',
  },
  noPostsFound: {
    code: 'NO_POSTS_FOUND',
    reason: 'no_posts_found',
    text: 'noPostsFoundText',
  },
  noLinkFound: {
    code: 'NO_LINK_FOUND',
    reason: 'no_link_found',
    text: 'noLinkFoundText',
  },
  linkUnresolvable: {
    code: 'LINK_UNRESOLVABLE',
    reason: 'link_unresolvable',
    text: 'linkUnresolvableText',
  },
} as const;

export type NoticeKind = keyof typeof NOTICES;
export type NoticeReason = (typeof NOTICES)[NoticeKind]['reason'];
export type NoticeTextKey = (typeof NOTICES)[NoticeKind]['text'];
export const NOTICE_KINDS = Object.keys(NOTICES) as NoticeKind[];

/** Anything that can be persisted in `issuances.skip_reason`. */
export type IssuanceReason = IgnoreReason | SkipReason | FailureReason | NoticeReason;

export function isIssuanceStatus(value: string): value is IssuanceStatus {
  return (ISSUANCE_STATUSES as readonly string[]).includes(value);
}
