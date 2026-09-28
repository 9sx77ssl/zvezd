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

const RANK_COLORS = ['rgb(200,170,110)', 'rgb(170,170,170)', 'rgb(175,140,100)'];
const DEFAULT_RANK_COLOR = 'rgb(140,140,140)';
const GOLD = 'rgb(200,170,110)';
const GREEN = 'rgb(140,180,140)';
const GRAY = 'rgb(150,150,150)';
const DIM = 'rgb(140,140,140)';

export interface StatsBodyParams {
  sourceThreadUrl: string;
  users: UserStat[];
  overall: OverallStats;
  /** Hard cap so the post never exceeds the forum limit. */
  maxChars: number;
}

/**
 * Builds the BBCode body of the stats thread, using only tags documented at
 * /help/bb-codes: CENTER, LEFT, SIZE, B, COLOR, URL, USER.
 */
export function buildStatsBody(params: StatsBodyParams): string {
  const { sourceThreadUrl, users, overall, maxChars } = params;

  const header = [
    '[CENTER][SIZE=6][B][COLOR=rgb(200,80,80)]ZVEZDA STATS[/COLOR][/B][/SIZE]',
    `[URL=${sourceThreadUrl}][SIZE=2][COLOR=rgb(120,150,200)]перейти к раздаче[/COLOR][/SIZE][/URL]`,
    '',
    `[SIZE=3][COLOR=${GRAY}]STATS OF ALL TIME[/COLOR][/SIZE][/CENTER]`,
    '',
    `[LEFT][SIZE=2][COLOR=${GRAY}]total:[/COLOR] ` +
      `[COLOR=${GOLD}]${plural(overall.stars, 'star', 'stars')}[/COLOR] · ` +
      `[COLOR=${GREEN}]${plural(overall.users, 'user', 'users')}[/COLOR] · ` +
      `[COLOR=rgb(180,180,180)]${plural(overall.posts, 'post', 'posts')}[/COLOR][/SIZE]`,
    '',
  ].join('\n');

  const footer = '[/LEFT]';
  const lines: string[] = [];
  let length = header.length + footer.length;

  for (let index = 0; index < users.length; index += 1) {
    const user = users[index]!;
    const rank = index + 1;
    const color = RANK_COLORS[index] ?? DEFAULT_RANK_COLOR;
    const line =
      `[SIZE=3][COLOR=${color}]${rank}.[/COLOR][/SIZE] ` +
      `[USER=${user.userId}]${user.username}[/USER] — ` +
      `[COLOR=${GOLD}]${plural(user.stars, 'star', 'stars')}[/COLOR] ` +
      `[COLOR=${DIM}]/ ${plural(user.posts, 'post', 'posts')}[/COLOR]`;

    if (length + line.length + 1 > maxChars - 40) {
      const remaining = users.length - index;
      lines.push(`[COLOR=${GRAY}]... and ${remaining} more[/COLOR]`);
      break;
    }

    lines.push(line);
    length += line.length + 1;
  }

  return [header, ...lines, footer].join('\n');
}
