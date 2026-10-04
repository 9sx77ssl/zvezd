import { describe, expect, it } from 'bun:test';
import { fileConfigSchema } from '../src/config/schema';
import {
  LinkUnresolvableError,
  NoLinkFoundError,
  NoPostsFoundError,
  PaidReactionsDisabledError,
} from '../src/core/errors';
import { isIssuanceStatus, NOTICE_KINDS, NOTICES } from '../src/core/vocab';

const config = fileConfigSchema.parse({ forum: { threadId: 1 }, stats: { threadId: 2 } });

describe('notice registry', () => {
  it('every notice text key resolves to a configured message', () => {
    for (const kind of NOTICE_KINDS) {
      const text = config.comment[NOTICES[kind].text];
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('notice errors carry the registry code and reason', () => {
    const cases = [
      [new PaidReactionsDisabledError('x'), 'paidReactionsDisabled'],
      [new NoPostsFoundError('x'), 'noPostsFound'],
      [new NoLinkFoundError('x'), 'noLinkFound'],
      [new LinkUnresolvableError('x'), 'linkUnresolvable'],
    ] as const;

    for (const [error, kind] of cases) {
      expect(error.kind).toBe(kind);
      expect(error.code).toBe(NOTICES[kind].code);
      expect(error.reason).toBe(NOTICES[kind].reason);
    }
  });
});

describe('isIssuanceStatus', () => {
  it('accepts known statuses and rejects anything else', () => {
    expect(isIssuanceStatus('commented')).toBe(true);
    expect(isIssuanceStatus('skipped')).toBe(true);
    expect(isIssuanceStatus('nonsense')).toBe(false);
    expect(isIssuanceStatus('')).toBe(false);
  });
});
