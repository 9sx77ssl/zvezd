import type { OverallStats, UserChannelStats, UserLinkRow, UserStat } from '../db/types';
import { channelOfLink } from '../telegram/link-parser';

/** Formats a date as `DD.MM.YY HH:MM UTC`. */
export function formatUtc(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${year} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())} UTC`;
}

export function buildStatsTitle(template: string, now: Date): string {
  return template.replaceAll('{date}', formatUtc(now));
}

/** `1 star` / `2 stars`. */
function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Human relative time, e.g. `just now`, `3 mins ago`, `2 hours ago`. */
export function formatRelative(timestamp: number | null, now: number): string {
  if (timestamp === null) return 'never';

  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'min' : 'mins'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

const YELLOW = 'rgb(213,219,78)';
const GREEN = 'rgb(140,180,140)';
const GRAY = 'rgb(150,150,150)';
const LIGHT = 'rgb(180,180,180)';
const DIM = 'rgb(140,140,140)';
const RANK_COLORS = [YELLOW, 'rgb(170,170,170)', 'rgb(175,140,100)'];

/** Hard cap on how many channels are listed per user inside the spoiler. */
export const MAX_CHANNELS_PER_USER = 40;

/**
 * Turns raw `(user, link, count)` rows into per-user channel aggregates and
 * flags which other forum users submitted one of the same channels. Matching
 * happens on the channel username (case-insensitive), so two different posts in
 * the same channel still count as an overlap.
 */
export function buildUserChannelStats(rows: UserLinkRow[]): UserChannelStats[] {
  const byUser = new Map<number, UserChannelStats>();
  const channelHolders = new Map<string, Map<number, string>>();

  for (const row of rows) {
    const channel = channelOfLink(row.link);
    if (!channel) continue;

    const key = channel.toLowerCase();

    let user = byUser.get(row.userId);
    if (!user) {
      user = { userId: row.userId, username: row.username, channels: [] };
      byUser.set(row.userId, user);
    }

    const existing = user.channels.find((entry) => entry.channel.toLowerCase() === key);
    if (existing) existing.count += row.count;
    else user.channels.push({ channel, count: row.count, sharedWith: [] });

    let holders = channelHolders.get(key);
    if (!holders) {
      holders = new Map();
      channelHolders.set(key, holders);
    }
    holders.set(row.userId, row.username);
  }

  for (const user of byUser.values()) {
    user.channels.sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel));

    for (const channel of user.channels) {
      const holders = channelHolders.get(channel.channel.toLowerCase());
      if (!holders) continue;
      channel.sharedWith = [...holders.entries()]
        .filter(([userId]) => userId !== user.userId)
        .map(([userId, username]) => ({ userId, username }))
        .sort((a, b) => a.username.localeCompare(b.username));
    }
  }

  return [...byUser.values()].sort((a, b) => a.userId - b.userId);
}

export interface StatsMetrics {
  /** Telegram Stars left on the account. */
  balance: number;
  /** Total stars spent. */
  spent: number;
  /** Average stars per day (rounded). */
  avgPerDay: number;
  /** Stars issued today (UTC). */
  todayStars: number;
  /** Timestamp of the last issued star. */
  lastIssuedAt: number | null;
  now: number;
}

export interface StatsBodyParams {
  sourceThreadUrl: string;
  users: UserStat[];
  overall: OverallStats;
  metrics: StatsMetrics;
  /** Per-user channel links shown in a spoiler under each ranking row. */
  links?: UserChannelStats[];
  /** Hard cap so the post never exceeds the forum limit. */
  maxChars: number;
}

/**
 * The "hide" block appended under a user's ranking row. Inside a spoiler, at a
 * smaller size, each channel is shown as an inline-code chip `t.me/<channel> ·
 * <count>` on its own line. When other users submitted the same channel, a
 * minimal gray `/ match: name (profile)` note follows that exact link, and the
 * spoiler title carries `has match`.
 */
function renderUserLinks(stats: UserChannelStats | undefined): string {
  if (!stats || stats.channels.length === 0) return '';

  const shown = stats.channels.slice(0, MAX_CHANNELS_PER_USER);
  const lines = shown.map((entry) => {
    const chip = `[srci]t.me/${entry.channel} · ${entry.count}[/srci]`;
    if (entry.sharedWith.length === 0) return chip;

    const matches = entry.sharedWith
      .map((other) => `[USER=${other.userId}]@${other.username}[/USER]`)
      .join(', ');
    return `${chip} [COLOR=${GRAY}]/ match: ${matches}[/COLOR]`;
  });

  if (stats.channels.length > shown.length) {
    lines.push(`[COLOR=${DIM}]+${stats.channels.length - shown.length} more[/COLOR]`);
  }

  const hasMatch = stats.channels.some((entry) => entry.sharedWith.length > 0);
  const title = hasMatch
    ? `links · ${stats.channels.length} · has match`
    : `links · ${stats.channels.length}`;

  return `\n[SPOILER=${title}][SIZE=3]${lines.join('\n')}[/SIZE][/SPOILER]`;
}

/**
 * Builds the BBCode body of the stats thread. Only tags documented at
 * /help/bb-codes are used: CENTER, LEFT, SIZE, COLOR, USER, SPOILER, SRCI.
 */
export function buildStatsBody(params: StatsBodyParams): string {
  const { sourceThreadUrl, users, overall, metrics, links, maxChars } = params;
  const linksByUser = new Map((links ?? []).map((entry) => [entry.userId, entry]));

  const header =
    `[CENTER][UNFURL='${sourceThreadUrl}'][SIZE=5]${sourceThreadUrl}[/SIZE][/UNFURL][SIZE=5] [/SIZE][/CENTER]\n\n` +
    `[LEFT][SIZE=5][COLOR=${GRAY}]balance:[/COLOR] ` +
    `[COLOR=${GREEN}]${plural(metrics.balance, 'star', 'stars')}[/COLOR] · ` +
    `[COLOR=${YELLOW}]spent: ${metrics.spent}[/COLOR] · ` +
    `[COLOR=${LIGHT}]avg/day: ${plural(metrics.avgPerDay, 'star', 'stars')}[/COLOR]\n` +
    `[COLOR=${GRAY}]today:[/COLOR] ` +
    `[COLOR=${YELLOW}]${plural(metrics.todayStars, 'star', 'stars')}[/COLOR] · ` +
    `[COLOR=${GRAY}]last issued:[/COLOR] ` +
    `[COLOR=${LIGHT}]${formatRelative(metrics.lastIssuedAt, metrics.now)}[/COLOR]\n\n` +
    `[COLOR=${GRAY}]total:[/COLOR] ` +
    `[COLOR=${YELLOW}]${plural(overall.stars, 'star', 'stars')}[/COLOR] · ` +
    `[COLOR=${GREEN}]${plural(overall.users, 'user', 'users')}[/COLOR] · ` +
    `[COLOR=${LIGHT}]${plural(overall.posts, 'post', 'posts')}[/COLOR]\n\n`;

  const suffix = '\n[/SIZE][/LEFT]';
  const lines: string[] = [];
  let length = header.length + suffix.length;

  for (let index = 0; index < users.length; index += 1) {
    const user = users[index]!;
    const rank = index + 1;
    const color = RANK_COLORS[index] ?? DIM;
    const line =
      `[COLOR=${color}]${rank}.[/COLOR] [/SIZE]` +
      `[USER=${user.userId}]@${user.username}[/USER]` +
      `[SIZE=5] — [COLOR=${YELLOW}]${plural(user.stars, 'star', 'stars')}[/COLOR] ` +
      `[COLOR=${DIM}]/ ${plural(user.posts, 'post', 'posts')}[/COLOR]` +
      renderUserLinks(linksByUser.get(user.userId));

    if (length + line.length + 1 > maxChars - 40) {
      const remaining = users.length - index;
      lines.push(`[COLOR=${GRAY}]... and ${remaining} more[/COLOR]`);
      break;
    }

    lines.push(line);
    length += line.length + 1;
  }

  return `${header}${lines.join('\n')}${suffix}`;
}
