import type { OverallStats, UserStat } from '../db/types';

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
  /** Hard cap so the post never exceeds the forum limit. */
  maxChars: number;
}

/**
 * Builds the BBCode body of the stats thread. Only tags documented at
 * /help/bb-codes are used: CENTER, LEFT, SIZE, COLOR, URL, UNFURL, USER.
 */
export function buildStatsBody(params: StatsBodyParams): string {
  const { sourceThreadUrl, users, overall, metrics, maxChars } = params;

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
      `[COLOR=${DIM}]/ ${plural(user.posts, 'post', 'posts')}[/COLOR]`;

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
