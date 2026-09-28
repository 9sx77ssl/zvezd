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

const RANK_COLORS = ['rgb(255,215,0)', 'rgb(192,192,192)', 'rgb(205,127,50)'];
const DEFAULT_RANK_COLOR = 'rgb(170,170,170)';

export interface StatsBodyParams {
  sourceThreadUrl: string;
  users: UserStat[];
  overall: OverallStats;
  now: Date;
  /** Hard cap so the post never exceeds the forum limit. */
  maxChars: number;
}

/**
 * Builds the BBCode body of the stats thread, using only tags documented at
 * /help/bb-codes: CENTER, LEFT, SIZE, B, COLOR, URL, USER.
 */
export function buildStatsBody(params: StatsBodyParams): string {
  const { sourceThreadUrl, users, overall, now, maxChars } = params;

  const header = [
    '[CENTER][SIZE=7][B][COLOR=rgb(226,66,66)]ZVEZDA STATS[/COLOR][/B][/SIZE]',
    `[SIZE=2][COLOR=rgb(150,150,150)]updated ${formatUtc(now)}[/COLOR][/SIZE]`,
    '',
    `[SIZE=5][B][URL=${sourceThreadUrl}]★ Razda4a zvezd ★[/URL][/B][/SIZE]`,
    '',
    '[SIZE=5][B][COLOR=rgb(88,180,255)]STATS OF ALL TIME[/COLOR][/B][/SIZE][/CENTER]',
    '',
    `[LEFT][SIZE=3][B]total:[/B] [COLOR=rgb(255,215,0)]${overall.stars} ★[/COLOR]   ` +
      `·   [COLOR=rgb(140,255,140)]${overall.users} users[/COLOR]   ` +
      `·   [COLOR=rgb(200,200,200)]${overall.posts} posts[/COLOR][/SIZE]`,
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
      `[SIZE=4][B][COLOR=${color}]${rank}.[/COLOR][/B][/SIZE] ` +
      `[USER=${user.userId}]${user.username}[/USER] — ` +
      `[B][COLOR=rgb(140,255,140)]${user.stars}[/COLOR][/B] ★ ` +
      `[COLOR=rgb(140,140,140)]/ ${user.posts} posts[/COLOR]`;

    if (length + line.length + 1 > maxChars - 40) {
      const remaining = users.length - index;
      lines.push(`[COLOR=rgb(150,150,150)]... and ${remaining} more[/COLOR]`);
      break;
    }

    lines.push(line);
    length += line.length + 1;
  }

  return [header, ...lines, footer].join('\n');
}
