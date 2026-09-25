import { describe, expect, it } from 'bun:test';
import { renderComment } from '../src/services/comment-renderer';

describe('comment-renderer', () => {
  it('renders the configured mention template', () => {
    const body = renderComment('[user="{user_id}"]{username}[/user], {text}', {
      user_id: 4371739,
      username: 'intimacy',
      text: 'выдал',
      stars: 1,
      link: 'https://t.me/x/1',
    });

    expect(body).toBe('[user="4371739"]intimacy[/user], выдал');
  });

  it('leaves unknown placeholders untouched', () => {
    const body = renderComment('{username}: {unknown}', {
      user_id: 1,
      username: 'bob',
      text: 'done',
      stars: 1,
      link: 'https://t.me/x/1',
    });

    expect(body).toBe('bob: {unknown}');
  });
});
