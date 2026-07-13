import type { Context } from 'hono'

/**
 * Formats Zod validation errors into the `{ error: string }` shape the
 * frontend (`web/src/api.ts`) expects. Without this hook, @hono/standard-validator
 * returns `{ success: false, error: Issue[] }` which breaks the frontend's
 * `if (data.error) throw new Error(data.error)` check.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const validationHook = (result: any, c: Context) => {
  const msg =
    result.error?.map((i: any) => `${i.path?.join('.') || '(root)'}: ${i.message}`).join('; ') ??
    'validation failed'
  return c.json({ error: msg }, 400)
}
