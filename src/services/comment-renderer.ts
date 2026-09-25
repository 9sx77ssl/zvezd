export interface CommentTemplateContext {
  user_id: number | string;
  username: string;
  text: string;
  stars: number | string;
  link: string;
}

/**
 * Renders a small `{placeholder}` template. Unknown placeholders are left
 * untouched so misconfiguration is visible instead of silently dropped.
 */
export function renderComment(template: string, context: CommentTemplateContext): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key in context) return String(context[key as keyof CommentTemplateContext]);
    return match;
  });
}
