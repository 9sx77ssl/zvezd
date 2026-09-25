/**
 * Telegram post link parsing.
 *
 * We only accept *public channel/group post* links of the form
 * `https://t.me/<username>/<messageId>`. Invite links (`/+hash`,
 * `/joinchat/...`), private links (`/c/...`) and bare profile links are
 * intentionally rejected.
 */

export interface TgPostLink {
  /** Canonical, normalized url. */
  url: string;
  username: string;
  messageId: number;
}

const HOSTS = ['t.me', 'telegram.me', 'telegram.dog'] as const;
const USERNAME = '[A-Za-z][A-Za-z0-9_]{3,31}';
const LINK_PATTERN = new RegExp(
  String.raw`(?:https?:\/\/)?(?:www\.)?(?:${HOSTS.join('|')})\/(${USERNAME})\/(\d+)(?!\w)`,
  'gi',
);

/** Parse a single string into a link, or `null` when invalid. */
export function parseTgPostLink(input: string): TgPostLink | null {
  const match = new RegExp(
    String.raw`^(?:https?:\/\/)?(?:www\.)?(?:${HOSTS.join('|')})\/(${USERNAME})\/(\d+)(?!\w)`,
    'i',
  ).exec(input.trim());
  if (!match) return null;

  const username = match[1];
  const messageId = Number(match[2]);
  if (!username || !Number.isInteger(messageId) || messageId <= 0) return null;

  return { url: `https://t.me/${username}/${messageId}`, username, messageId };
}

/**
 * Extract every distinct valid Telegram post link from an HTML string,
 * preserving the order of appearance. Duplicates (same channel + message)
 * are collapsed.
 */
export function extractTgPostLinks(html: string): TgPostLink[] {
  const found = new Map<string, TgPostLink>();

  for (const match of html.matchAll(LINK_PATTERN)) {
    const username = match[1];
    const messageId = Number(match[2]);
    if (!username || !Number.isInteger(messageId) || messageId <= 0) continue;

    const key = `${username.toLowerCase()}/${messageId}`;
    if (!found.has(key)) {
      found.set(key, { url: `https://t.me/${username}/${messageId}`, username, messageId });
    }
  }

  return [...found.values()];
}

/** First valid Telegram post link in the HTML, or `null`. */
export function selectFirstTgPostLink(html: string): TgPostLink | null {
  return extractTgPostLinks(html)[0] ?? null;
}
