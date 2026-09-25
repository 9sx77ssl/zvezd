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

export const forumPostSchema = z.looseObject({
  post_id: z.number(),
  thread_id: z.number(),
  poster_user_id: z.number(),
  poster_username: z.string(),
  poster_username_html: z.string().optional(),
  poster_is_banned: z.union([z.number(), z.boolean()]).optional(),
  poster_is_staff: z.union([z.number(), z.boolean()]).optional(),
  post_create_date: z.number(),
  post_body: z.string().default(''),
  post_body_html: z.string().default(''),
  post_body_plain_text: z.string().default(''),
  post_update_date: z.number().optional(),
  post_is_first_post: z.boolean(),
  post_is_published: z.boolean().optional(),
  post_is_deleted: z.boolean().optional(),
  post_is_sticked: z.boolean().optional(),
  post_comment_count: z.number().optional(),
});

export type ForumPost = z.infer<typeof forumPostSchema>;

export const forumThreadSchema = z.looseObject({
  thread_id: z.number(),
  forum_id: z.number().optional(),
  thread_title: z.string().optional(),
  thread_post_count: z.number().optional(),
  thread_is_deleted: z.boolean().optional(),
  thread_is_closed: z.boolean().optional(),
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
  poster_user_id: z.number(),
  poster_username: z.string(),
  post_comment_body: z.string().default(''),
  post_comment_body_html: z.string().optional(),
  post_comment_body_plain_text: z.string().optional(),
  post_comment_is_deleted: z.boolean().optional(),
  post_comment_is_published: z.boolean().optional(),
  post_comment_create_date: z.number().optional(),
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
