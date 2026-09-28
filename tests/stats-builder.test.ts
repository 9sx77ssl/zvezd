import { describe, expect, it } from 'bun:test';
import type { OverallStats, UserStat } from '../src/db/types';
import { buildStatsBody, buildStatsTitle, formatUtc } from '../src/services/stats-builder';

const overall: OverallStats = { users: 2, posts: 5, stars: 4 };
const users: UserStat[] = [
  { userId: 10, username: 'alice', stars: 3, posts: 3 },
  { userId: 20, username: 'bob', stars: 1, posts: 2 },
];

describe('stats-builder', () => {
  it('formats dates as DD.MM.YY HH:MM UTC', () => {
    const date = new Date(Date.UTC(2026, 8, 26, 13, 12));
    expect(formatUtc(date)).toBe('26.09.26 13:12 UTC');
  });

  it('renders the title template', () => {
    const date = new Date(Date.UTC(2026, 8, 26, 13, 12));
    expect(buildStatsTitle('Razda4a zvezd stats - {date}', date)).toBe(
      'Razda4a zvezd stats - 26.09.26 13:12 UTC',
    );
  });

  it('builds a centered header with the source thread link and totals', () => {
    const body = buildStatsBody({
      sourceThreadUrl: 'https://lolz.team/threads/10335815/',
      users,
      overall,
      now: new Date(Date.UTC(2026, 8, 26, 13, 12)),
      maxChars: 65_000,
    });

    expect(body).toContain('[CENTER]');
    expect(body).toContain('updated 26.09.26 13:12 UTC');
    expect(body).toContain('[URL=https://lolz.team/threads/10335815/]');
    expect(body).toContain('4 ★');
    expect(body).toContain('2 users');
    expect(body).toContain('[/CENTER]');
    expect(body).toContain('[/LEFT]');
  });

  it('lists users sorted with ranks and mentions', () => {
    const body = buildStatsBody({
      sourceThreadUrl: 'https://lolz.team/threads/1/',
      users,
      overall,
      now: new Date(),
      maxChars: 65_000,
    });

    expect(body).toContain('[USER=10]alice[/USER]');
    expect(body).toContain('[USER=20]bob[/USER]');
    expect(body.indexOf('alice')).toBeLessThan(body.indexOf('bob'));
    expect(body).toContain('[COLOR=rgb(255,215,0)]1.[/COLOR]');
    expect(body).toContain('[COLOR=rgb(192,192,192)]2.[/COLOR]');
  });

  it('truncates the list to fit the character limit', () => {
    const many: UserStat[] = Array.from({ length: 500 }, (_, index) => ({
      userId: index + 1,
      username: `user_with_a_long_name_${index}`,
      stars: 500 - index,
      posts: 1,
    }));

    const body = buildStatsBody({
      sourceThreadUrl: 'https://lolz.team/threads/1/',
      users: many,
      overall: { users: 500, posts: 500, stars: 1000 },
      now: new Date(),
      maxChars: 2_000,
    });

    expect(body.length).toBeLessThanOrEqual(2_000);
    expect(body).toContain('... and');
    expect(body.endsWith('[/LEFT]')).toBe(true);
  });
});
