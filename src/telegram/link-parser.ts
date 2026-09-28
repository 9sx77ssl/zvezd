/**
 * Telegram link parsing.
 *
 * We accept two kinds of public links:
 *  - a specific post: `https://t.me/<username>/<messageId>`
 *  - a bare channel:  `https://t.me/<username>`
 *
 * Invite links (`/+hash`, `/joinchat/...`), private links (`/c/...`) and the
 * web-preview prefix (`/s/...`) are intentionally rejected.
 */

export interface TgPostLink {
  kind: 'post';
  /** Canonical, normalized url. */
  url: string;
  username: string;
  messageId: number;
}

export interface TgChannelLink {
  kind: 'channel';
  /** Canonical, normalized url. */
  url: string;
  username: string;
}

export type TgLink = TgPostLink | TgChannelLink;

const HOSTS = ['t.me', 'telegram.me', 'telegram.dog'] as const;
const HOST_PATTERN = HOSTS.join('|');
const USERNAME = '[A-Za-z][A-Za-z0-9_]{3,31}';

const POST_PATTERN = new RegExp(
  String.raw`(?:https?:\/\/)?(?:www\.)?(?:${HOST_PATTERN})\/(${USERNAME})\/(\d+)(?!\w)`,
  'gi',
);

const CHANNEL_PATTERN = new RegExp(
  String.raw`(?:https?:\/\/)?(?:www\.)?(?:${HOST_PATTERN})\/(${USERNAME})(?![\w/])`,
  'gi',
);

/** Parse a single string into a link, or `null` when invalid. */
export function parseTgPostLink(input: string): TgPostLink | null {
  const match = new RegExp(
    String.raw`^(?:https?:\/\/)?(?:www\.)?(?:${HOST_PATTERN})\/(${USERNAME})\/(\d+)(?!\w)`,
    'i',
  ).exec(input.trim());
  if (!match) return null;

  const username = match[1];
  const messageId = Number(match[2]);
  if (!username || !Number.isInteger(messageId) || messageId <= 0) return null;

  return { kind: 'post', url: `https://t.me/${username}/${messageId}`, username, messageId };
}

/**
 * Extract every distinct valid link from an HTML string, preserving order of
 * appearance. Duplicates (same channel + message, or same channel) collapse.
 */
export function extractTgLinks(html: string): TgLink[] {
  const found = new Map<string, { link: TgLink; index: number }>();

  for (const match of html.matchAll(POST_PATTERN)) {
    const username = match[1];
    const messageId = Number(match[2]);
    if (!username || !Number.isInteger(messageId) || messageId <= 0) continue;

    const key = `post:${username.toLowerCase()}/${messageId}`;
    if (!found.has(key)) {
      found.set(key, {
        link: { kind: 'post', url: `https://t.me/${username}/${messageId}`, username, messageId },
        index: match.index ?? 0,
      });
    }
  }

  for (const match of html.matchAll(CHANNEL_PATTERN)) {
    const username = match[1];
    if (!username) continue;

    const key = `channel:${username.toLowerCase()}`;
    if (!found.has(key)) {
      found.set(key, {
        link: { kind: 'channel', url: `https://t.me/${username}`, username },
        index: match.index ?? 0,
      });
    }
  }

  return [...found.values()].sort((a, b) => a.index - b.index).map((entry) => entry.link);
}

/** Only the post links (kept for backwards compatibility). */
export function extractTgPostLinks(html: string): TgPostLink[] {
  return extractTgLinks(html).filter((link): link is TgPostLink => link.kind === 'post');
}

/** First valid Telegram post link in the HTML, or `null`. */
export function selectFirstTgPostLink(html: string): TgPostLink | null {
  return extractTgPostLinks(html)[0] ?? null;
}

/**
 * First valid link: a specific post if present, otherwise a bare channel link.
 */
export function selectFirstTgLink(html: string): TgLink | null {
  const links = extractTgLinks(html);
  return (
    links.find((link) => link.kind === 'post') ??
    links.find((link) => link.kind === 'channel') ??
    null
  );
}
