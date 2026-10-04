import { describe, expect, it } from 'bun:test';
import { normalizeStarsAmount } from '../src/telegram/TelegramService';

describe('normalizeStarsAmount', () => {
  it('adds the nanos for starsAmount', () => {
    expect(normalizeStarsAmount({ _: 'starsAmount', amount: 5, nanos: 500_000_000 } as never)).toBe(
      5.5,
    );
  });

  it('ignores nanos for other amount shapes', () => {
    expect(normalizeStarsAmount({ _: 'starsTonAmount', amount: 3 } as never)).toBe(3);
  });

  it('returns 0 for unknown shapes', () => {
    expect(normalizeStarsAmount({} as never)).toBe(0);
  });
});
