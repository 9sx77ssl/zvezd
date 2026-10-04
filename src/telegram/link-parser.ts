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

/** Parse a single bare channel string into a link, or `null` when invalid. */
export function parseTgChannelLink(input: string): TgChannelLink | null {
  const match = new RegExp(
    String.raw`^(?:https?:\/\/)?(?:www\.)?(?:${HOST_PATTERN})\/(${USERNAME})\/?$`,
    'i',
  ).exec(input.trim());
  if (!match) return null;

  const username = match[1];
  if (!username) return null;

  return { kind: 'channel', url: `https://t.me/${username}`, username };
}

/**
 * Channel username behind a normalized stored link (a specific post or a bare
 * channel), or `null` when the string is not a valid public Telegram link.
 */
export function channelOfLink(input: string): string | null {
  return parseTgPostLink(input)?.username ?? parseTgChannelLink(input)?.username ?? null;
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

/**
 * Ordered candidates to try when starring a post: every extracted link in
 * order of appearance, minus a bare channel link when the same channel also
 * has a specific post link (the post is the more precise target).
 */
export function selectLinkCandidates(html: string): TgLink[] {
  const links = extractTgLinks(html);
  const channelsWithPost = new Set(
    links
      .filter((link): link is TgPostLink => link.kind === 'post')
      .map((link) => link.username.toLowerCase()),
  );
  return links.filter(
    (link) => link.kind === 'post' || !channelsWithPost.has(link.username.toLowerCase()),
  );
}

/** How many distinct channels a set of links points at. */
export function distinctChannelCount(links: readonly TgLink[]): number {
  return new Set(links.map((link) => link.username.toLowerCase())).size;
}
