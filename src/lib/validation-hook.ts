import type { Context } from 'hono'

/**
 * Formats Zod validation errors into the `{ error: string }` shape the
 * frontend (`web/src/api.ts`) expects. Without this hook, @hono/standard-validator
 * returns `{ success: false, error: Issue[] }` which breaks the frontend's
 * `if (data.error) throw new Error(data.error)` check.
 *
 * The hook is called on both success and failure — on success we return
 * nothing (void) so the handler proceeds with validated data.
 */
export const validationHook = (
  result: {
    success: boolean
    error?: readonly {
      path?: readonly (string | number | symbol | { readonly key: string | number | symbol })[]
      message: string
    }[]
  },
  c: Context,
): Response | void => {
  if (result.success) return // let handler proceed
  if (result.error?.length) {
    const msg = result.error
      .map(
        (i) =>
          `${i.path?.map((p) => (typeof p === 'object' ? p.key : p)).join('.') || '(root)'}: ${i.message}`,
      )
      .join('; ')
    return c.json({ error: msg }, 400)
  }
  return c.json({ error: 'validation failed' }, 400)
}
