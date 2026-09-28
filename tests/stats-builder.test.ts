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
    expect(buildStatsTitle('Razda4a zvezd stats / updated at {date}', date)).toBe(
      'Razda4a zvezd stats / updated at 26.09.26 13:12 UTC',
    );
  });

  it('builds a centered header with the source thread link and totals', () => {
    const body = buildStatsBody({
      sourceThreadUrl: 'https://lolz.team/threads/10335815/',
      users,
      overall,
      maxChars: 65_000,
    });

    expect(body).toContain("[UNFURL='https://lolz.team/threads/10335815/']");
    expect(body).toContain('total:');
    expect(body).toContain('4 stars');
    expect(body).toContain('2 users');
    expect(body).toContain('5 posts');
    expect(body).not.toContain('★');
    expect(body).toContain('[LEFT]');
    expect(body).toContain('[/LEFT]');
  });

  it('lists users sorted with ranks and mentions', () => {
    const body = buildStatsBody({
      sourceThreadUrl: 'https://lolz.team/threads/1/',
      users,
      overall,
      maxChars: 65_000,
    });

    expect(body).toContain('[USER=10]@alice[/USER]');
    expect(body).toContain('[USER=20]@bob[/USER]');
    expect(body.indexOf('alice')).toBeLessThan(body.indexOf('bob'));
    expect(body).toContain('[COLOR=rgb(213,219,78)]1.[/COLOR]');
    expect(body).toContain('[COLOR=rgb(170,170,170)]2.[/COLOR]');
  });

  it('pluralizes stars and posts', () => {
    const body = buildStatsBody({
      sourceThreadUrl: 'https://lolz.team/threads/1/',
      users: [
        { userId: 1, username: 'one', stars: 1, posts: 1 },
        { userId: 2, username: 'two', stars: 2, posts: 2 },
      ],
      overall: { users: 2, posts: 3, stars: 3 },
      maxChars: 65_000,
    });

    expect(body).toContain('1 star');
    expect(body).toContain('/ 1 post');
    expect(body).toContain('2 stars');
    expect(body).toContain('/ 2 posts');
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
      maxChars: 2_000,
    });

    expect(body.length).toBeLessThanOrEqual(2_000);
    expect(body).toContain('... and');
    expect(body.endsWith('[/LEFT]')).toBe(true);
  });
});
