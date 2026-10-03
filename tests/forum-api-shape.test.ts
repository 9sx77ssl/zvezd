import { describe, expect, it } from 'bun:test';
import {
  commentsListResponseSchema,
  createCommentResponseSchema,
  forumPostSchema,
  postResponseSchema,
  postsResponseSchema,
  threadResponseSchema,
  userMeResponseSchema,
} from '../src/forum/types';
import { selectFirstTgLink } from '../src/telegram/link-parser';

/**
 * Fixtures are trimmed copies of real 2026-10 responses captured from
 * api.lolz.team after the payload rename (`post_body` → `message`,
 * `poster_user_id` → `user_id`, `post_is_first_post` → `is_first_post`,
 * publish/delete flags → `message_state`, `links.first_post` → `first_post_id`).
 *
 * If the forum renames these fields again, these tests must fail before the
 * bot does.
 */
const CONFIRMATION = '[user="9252369"]yolo[/user], +';

const realPost = {
  post_id: 65289501,
  thread_id: 10335815,
  user_id: 4771461,
  username: 'intimacy',
  username_html: '<span style="background-image: linear-gradient(...)">intimacy</span>',
  post_date: 1790621731,
  message: '[MEDIA=telegram]flexinout/25[/MEDIA]',
  message_html:
    '<p><a href="https://t.me/flexinout/25" data-xf-init="link--external">https://t.me/flexinout/25</a></p>',
  message_plain_text: 't.me/flexinout/25',
  message_state: 'visible',
  is_first_post: false,
  is_banned: false,
  is_staff: false,
  is_sticked: false,
  is_liked: false,
  comment_count: 2,
  likes: 3,
  view_url: 'https://lolz.team/posts/65289501/',
  update_date: 1790977040,
  signature: '',
  signature_html: '',
  thread_is_closed: false,
  thread_is_deleted: false,
};

const realThread = {
  thread_id: 10335815,
  node_id: 876,
  node_title: 'Тестовый раздел',
  title: 'Razda4a zvezd',
  post_count: 183,
  reply_count: 182,
  first_post_id: 65248344,
  last_post_id: 65301514,
  view_url: 'https://lolz.team/threads/10335815/',
  discussion_state: 'visible',
  discussion_open: true,
  is_hidden: false,
  user_id: 9252369,
  username: 'yolo',
};

const systemInfo = {
  rate_limit: { limit: 300, remaining: 296, reset: 1791065520 },
  visitor_id: 9252369,
  time: 1791065502,
  log_id: 8687226963,
};

describe('forum API shape (captured responses)', () => {
  it('parses GET /posts and exposes the thread first post id', () => {
    const parsed = postsResponseSchema.parse({
      posts: [{ ...realPost }],
      thread: { ...realThread },
      posts_total: 183,
      links: { pages: 61, page: 1, next: 'https://api.lolz.team/posts/?page=2' },
      system_info: systemInfo,
    });

    expect(parsed.thread?.first_post_id).toBe(65248344);
    expect(parsed.posts[0]!.is_first_post).toBe(false);
    expect(parsed.posts[0]!.message_state).toBe('visible');
    expect(parsed.posts[0]!.comment_count).toBe(2);
  });

  it('parses GET /posts with the thread description post', () => {
    const parsed = postsResponseSchema.parse({
      posts: [{ ...realPost, post_id: 65248344, is_first_post: true }],
      thread: { ...realThread },
      posts_total: 183,
      links: { pages: 61, page: 1 },
    });

    expect(parsed.posts[0]!.is_first_post).toBe(true);
    expect(parsed.posts[0]!.message_state).toBe('visible');
  });

  it('parses GET /threads (nested first_post object is ignored)', () => {
    const parsed = threadResponseSchema.parse({
      thread: {
        ...realThread,
        first_post: { ...realPost, post_id: 65248344, is_first_post: true },
      },
      system_info: systemInfo,
    });

    expect(parsed.thread.first_post_id).toBe(65248344);
    expect(parsed.thread.title).toContain('Razda4a zvezd');
  });

  it('parses PUT /posts response used by the stats service', () => {
    const parsed = postResponseSchema.parse({ post: { ...realPost }, system_info: systemInfo });

    expect(parsed.post.message_html).toContain('t.me/flexinout/25');
    expect(parsed.post.message_state).toBe('visible');
  });

  it('parses GET /posts/comments including soft-deleted comments', () => {
    const parsed = commentsListResponseSchema.parse({
      comments: [
        { ...realPost, post_comment_id: 27063460, message: '[user="4771461"]Кишлак[/user], +' },
        { ...realPost, post_comment_id: 27068802, message_state: 'deleted', delete_info: {} },
      ],
      system_info: systemInfo,
    });

    expect(parsed.comments).toHaveLength(2);
    expect(parsed.comments[0]!.message_state).toBe('visible');
    expect(parsed.comments[1]!.message_state).toBe('deleted');
    expect(parsed.comments[0]!.user_id).toBe(4771461);
  });

  it('parses POST /posts/comments response', () => {
    const parsed = createCommentResponseSchema.parse({
      comment: {
        post_comment_id: 27068801,
        post_id: 65248344,
        thread_id: 10345229,
        user_id: 9252369,
        username: 'yolo',
        message: CONFIRMATION,
        message_html: '<div>...</div>',
        message_plain_text: 'yolo, +',
        message_state: 'visible',
        comment_date: 1790977040,
        likes: 0,
      },
      system_info: systemInfo,
    });

    expect(parsed.comment.post_comment_id).toBe(27068801);
  });

  it('parses GET /users/me', () => {
    const parsed = userMeResponseSchema.parse({ user: { user_id: 9252369, username: 'yolo' } });

    expect(parsed.user.user_id).toBe(9252369);
  });

  it('finds the Telegram link the issuance service relies on', () => {
    const post = forumPostSchema.parse({ ...realPost });

    expect(selectFirstTgLink(post.message_html)).toMatchObject({
      kind: 'post',
      username: 'flexinout',
      messageId: 25,
    });
  });

  it('fails loudly when the API renames a field we depend on', () => {
    const { message_html: _droppedHtml, ...withoutHtml } = realPost;
    expect(forumPostSchema.safeParse(withoutHtml).success).toBe(false);

    const { user_id: _droppedAuthor, ...withoutAuthor } = realPost;
    expect(forumPostSchema.safeParse(withoutAuthor).success).toBe(false);

    const { is_first_post: _droppedFlag, ...withoutFlag } = realPost;
    expect(forumPostSchema.safeParse(withoutFlag).success).toBe(false);

    const { message_state: _droppedState, ...withoutState } = realPost;
    expect(forumPostSchema.safeParse(withoutState).success).toBe(false);
  });
});
