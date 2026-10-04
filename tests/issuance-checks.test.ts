import { describe, expect, it } from 'bun:test';
import { runPreChecks } from '../src/issuance/checks';
import { makePost } from './helpers';

const ctx = { selfForumUserId: 999, link: null };

describe('runPreChecks', () => {
  it('lets a normal post through', () => {
    expect(runPreChecks(makePost(), ctx)).toBeNull();
  });

  it('ignores the first post', () => {
    expect(runPreChecks(makePost({ is_first_post: true }), ctx)).toEqual({
      kind: 'ignore',
      reason: 'first_post',
    });
  });

  it('ignores deleted and hidden posts', () => {
    expect(runPreChecks(makePost({ message_state: 'deleted' }), ctx)).toEqual({
      kind: 'ignore',
      reason: 'deleted',
    });
    expect(runPreChecks(makePost({ message_state: 'moderated' }), ctx)).toEqual({
      kind: 'ignore',
      reason: 'unpublished',
    });
  });

  it('ignores own posts', () => {
    expect(runPreChecks(makePost({ user_id: 999 }), ctx)).toEqual({
      kind: 'ignore',
      reason: 'own_post',
    });
  });
});
