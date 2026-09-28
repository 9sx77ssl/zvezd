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

const YELLOW = 'rgb(213,219,78)';
const GREEN = 'rgb(140,180,140)';
const GRAY = 'rgb(150,150,150)';
const DIM = 'rgb(140,140,140)';
const POSTS_GRAY = 'rgb(180,180,180)';
const RANK_COLORS = [YELLOW, 'rgb(170,170,170)', 'rgb(175,140,100)'];

export interface StatsBodyParams {
  sourceThreadUrl: string;
  users: UserStat[];
  overall: OverallStats;
  /** Hard cap so the post never exceeds the forum limit. */
  maxChars: number;
}

/**
 * Builds the BBCode body of the stats thread. Only tags documented at
 * /help/bb-codes are used: CENTER, LEFT, SIZE, COLOR, URL, UNFURL, USER.
 */
export function buildStatsBody(params: StatsBodyParams): string {
  const { sourceThreadUrl, users, overall, maxChars } = params;

  const header =
    `[CENTER][UNFURL='${sourceThreadUrl}'][SIZE=5]${sourceThreadUrl}[/SIZE][/UNFURL][SIZE=5] [/SIZE][/CENTER]\n\n` +
    `[LEFT][SIZE=5][COLOR=${GRAY}]total:[/COLOR] ` +
    `[COLOR=${YELLOW}]${plural(overall.stars, 'star', 'stars')}[/COLOR] · ` +
    `[COLOR=${GREEN}]${plural(overall.users, 'user', 'users')}[/COLOR] · ` +
    `[COLOR=${POSTS_GRAY}]${plural(overall.posts, 'post', 'posts')}[/COLOR]\n\n`;

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
