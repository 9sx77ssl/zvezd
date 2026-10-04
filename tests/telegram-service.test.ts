import { describe, expect, it } from 'bun:test';
import { tl } from '@mtcute/bun';
import { isPermanentResolveError, normalizeStarsAmount } from '../src/telegram/TelegramService';

describe('isPermanentResolveError', () => {
  it('flags links that can never be resolved', () => {
    expect(isPermanentResolveError(new tl.RpcError(400, 'USERNAME_INVALID'))).toBe(true);
    expect(isPermanentResolveError(new tl.RpcError(400, 'CHANNEL_PRIVATE'))).toBe(true);
    expect(isPermanentResolveError(new tl.RpcError(400, 'MESSAGE_ID_INVALID'))).toBe(true);
  });

  it('leaves transient errors and non-RPC errors retryable', () => {
    expect(isPermanentResolveError(new tl.RpcError(420, 'FLOOD_WAIT'))).toBe(false);
    expect(isPermanentResolveError(new Error('network'))).toBe(false);
  });
});

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
