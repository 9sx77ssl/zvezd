import { describe, expect, it } from 'bun:test';
import type { OverallStats, UserStat } from '../src/db/types';
import {
  buildStatsBody,
  buildStatsTitle,
  formatRelative,
  formatUtc,
  type StatsMetrics,
} from '../src/services/stats-builder';

const overall: OverallStats = { users: 2, posts: 5, stars: 4 };
const users: UserStat[] = [
  { userId: 10, username: 'alice', stars: 3, posts: 3 },
  { userId: 20, username: 'bob', stars: 1, posts: 2 },
];

const baseMetrics: StatsMetrics = {
  balance: 29,
  spent: 4,
  avgPerDay: 2,
  todayStars: 1,
  lastIssuedAt: 1_000_000,
  now: 1_000_000 + 3 * 60_000,
};

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

  it('formats relative times with plurals', () => {
    const now = 10_000_000;
    expect(formatRelative(null, now)).toBe('never');
    expect(formatRelative(now - 5_000, now)).toBe('just now');
    expect(formatRelative(now - 60_000, now)).toBe('1 min ago');
    expect(formatRelative(now - 3 * 60_000, now)).toBe('3 mins ago');
    expect(formatRelative(now - 60 * 60_000, now)).toBe('1 hour ago');
    expect(formatRelative(now - 5 * 60 * 60_000, now)).toBe('5 hours ago');
    expect(formatRelative(now - 25 * 60 * 60_000, now)).toBe('1 day ago');
    expect(formatRelative(now - 3 * 24 * 60 * 60_000, now)).toBe('3 days ago');
  });

  it('builds a centered header with link, live metrics and totals', () => {
    const body = buildStatsBody({
      sourceThreadUrl: 'https://lolz.team/threads/10335815/',
      users,
      overall,
      metrics: baseMetrics,
      maxChars: 65_000,
    });

    expect(body).toContain("[UNFURL='https://lolz.team/threads/10335815/']");
    expect(body).toContain('balance:');
    expect(body).toContain('29 stars');
    expect(body).toContain('spent: 4');
    expect(body).toContain('avg/day: 2 stars');
    expect(body).toContain('today:');
    expect(body).toContain('last issued:');
    expect(body).toContain('3 mins ago');
    expect(body).toContain('total:');
    expect(body).toContain('2 users');
    expect(body).toContain('5 posts');
    expect(body).not.toContain('★');
    expect(body).toContain('[LEFT]');
    expect(body).toContain('[/LEFT]');
  });

  it('pluralizes balance and average stars', () => {
    const body = buildStatsBody({
      sourceThreadUrl: 'https://lolz.team/threads/1/',
      users: [],
      overall,
      metrics: { ...baseMetrics, balance: 1, avgPerDay: 1 },
      maxChars: 65_000,
    });

    expect(body).toContain('balance:');
    expect(body).toContain('1 star[/COLOR]');
  });

  it('lists users sorted with ranks and mentions', () => {
    const body = buildStatsBody({
      sourceThreadUrl: 'https://lolz.team/threads/1/',
      users,
      overall,
      metrics: baseMetrics,
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
      metrics: baseMetrics,
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
      metrics: baseMetrics,
      maxChars: 2_000,
    });

    expect(body.length).toBeLessThanOrEqual(2_000);
    expect(body).toContain('... and');
    expect(body.endsWith('[/LEFT]')).toBe(true);
  });
});
