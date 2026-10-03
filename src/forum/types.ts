import { z } from 'zod';

/** Shape of `system_info.rate_limit` returned by every endpoint. */
export const rateLimitSchema = z.looseObject({
  limit: z.number(),
  remaining: z.number(),
  reset: z.number(),
});

export const systemInfoSchema = z.looseObject({
  rate_limit: rateLimitSchema.optional(),
  visitor_id: z.number().optional(),
  time: z.number().optional(),
  log_id: z.number().optional(),
});

export type SystemInfo = z.infer<typeof systemInfoSchema>;
export type RateLimit = z.infer<typeof rateLimitSchema>;

/**
 * A forum post as returned by `GET /posts`.
 *
 * Lolz renamed the payload fields in the 2026-10 API update: `post_body` →
 * `message`, `poster_user_id` → `user_id`, `post_create_date` → `post_date`,
 * `post_comment_count` → `comment_count`, `post_is_first_post` → `is_first_post`
 * and the publish/delete flags collapsed into `message_state`.
 *
 * Identity, timing and the fields we rely on are required on purpose: when the
 * API renames them again we want a loud parse error instead of a bot that
 * silently stops issuing stars.
 */
export const forumPostSchema = z.looseObject({
  post_id: z.number(),
  thread_id: z.number(),
  user_id: z.number(),
  username: z.string(),
  post_date: z.number(),
  is_first_post: z.boolean(),
  /** `visible`, `deleted`, `moderated`... */
  message_state: z.string(),
  /** Raw BBCode; kept for logs. */
  message: z.string().default(''),
  /** Rendered body — this is where Telegram links are parsed from. */
  message_html: z.string(),
  message_plain_text: z.string().optional(),
  username_html: z.string().optional(),
  avatar_url: z.string().optional(),
  view_url: z.string().optional(),
  update_date: z.number().optional(),
  comment_count: z.number().optional(),
  likes: z.number().optional(),
  is_banned: z.boolean().optional(),
  is_staff: z.boolean().optional(),
  is_sticked: z.boolean().optional(),
  is_liked: z.boolean().optional(),
  signature: z.string().optional(),
  signature_html: z.string().optional(),
  thread_is_closed: z.boolean().optional(),
  thread_is_deleted: z.boolean().optional(),
});

export type ForumPost = z.infer<typeof forumPostSchema>;

export const forumThreadSchema = z.looseObject({
  thread_id: z.number(),
  node_id: z.number().optional(),
  title: z.string().optional(),
  post_count: z.number().optional(),
  reply_count: z.number().optional(),
  first_post_id: z.number().optional(),
  last_post_id: z.number().optional(),
  view_url: z.string().optional(),
  /** `visible` when the thread is published. */
  discussion_state: z.string().optional(),
  discussion_open: z.boolean().optional(),
  is_hidden: z.boolean().optional(),
  user_id: z.number().optional(),
  username: z.string().optional(),
});

export type ForumThread = z.infer<typeof forumThreadSchema>;

export const paginationLinksSchema = z.looseObject({
  pages: z.number().optional(),
  page: z.number().optional(),
  prev: z.string().optional(),
  next: z.string().optional(),
});

export const postsResponseSchema = z.looseObject({
  posts: z.array(forumPostSchema),
  thread: forumThreadSchema.optional(),
  posts_total: z.number(),
  links: paginationLinksSchema.optional(),
  system_info: systemInfoSchema.optional(),
});

export type PostsResponse = z.infer<typeof postsResponseSchema>;

export const postCommentSchema = z.looseObject({
  post_comment_id: z.number(),
  post_id: z.number(),
  thread_id: z.number().optional(),
  user_id: z.number(),
  username: z.string(),
  message: z.string().default(''),
  message_state: z.string().default('visible'),
  message_html: z.string().optional(),
  message_plain_text: z.string().optional(),
  comment_date: z.number().optional(),
  username_html: z.string().optional(),
  likes: z.number().optional(),
});

export type PostComment = z.infer<typeof postCommentSchema>;

export const createCommentResponseSchema = z.looseObject({
  comment: postCommentSchema,
  system_info: systemInfoSchema.optional(),
});

export type CreateCommentResponse = z.infer<typeof createCommentResponseSchema>;

export const commentsListResponseSchema = z.looseObject({
  comments: z.array(postCommentSchema),
  system_info: systemInfoSchema.optional(),
});

export type CommentsListResponse = z.infer<typeof commentsListResponseSchema>;

export const forumUserSchema = z.looseObject({
  user_id: z.number(),
  username: z.string(),
});

export const userMeResponseSchema = z.looseObject({
  user: forumUserSchema,
  system_info: systemInfoSchema.optional(),
});

export type UserMeResponse = z.infer<typeof userMeResponseSchema>;

export const threadResponseSchema = z.looseObject({
  thread: forumThreadSchema,
  system_info: systemInfoSchema.optional(),
});

export type ThreadResponse = z.infer<typeof threadResponseSchema>;

export const postResponseSchema = z.looseObject({
  post: forumPostSchema,
  system_info: systemInfoSchema.optional(),
});

export type PostResponse = z.infer<typeof postResponseSchema>;
