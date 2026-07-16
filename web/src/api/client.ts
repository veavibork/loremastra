import { coordinatedFetch } from '../lib/api-limiter.js'
import type { SupersededInfo } from './types.js'

export const API_BASE = ''

export function getSessionId(): string | null {
  return localStorage.getItem('loremaster.sessionId')
}

export function setSessionId(id: string): void {
  localStorage.setItem('loremaster.sessionId', id)
}

export function getStoredUserId(): string | null {
  return localStorage.getItem('loremaster.userId')
}

type SupersededListener = (info: SupersededInfo) => void
const supersededListeners: SupersededListener[] = []

/** App.tsx subscribes once at the top level — any 409 from anywhere (including a background poll deep inside some view) flips the whole app to the claim screen through this one channel, no per-view wiring needed. */
export function onSuperseded(listener: SupersededListener): () => void {
  supersededListeners.push(listener)
  return () => {
    const i = supersededListeners.indexOf(listener)
    if (i !== -1) supersededListeners.splice(i, 1)
  }
}

/**
 * Every call in this file (except claimSession, which is deliberately guard-exempt)
 * routes through here so the session header and "you've been superseded" handling live
 * in exactly one place rather than threaded through ~40 call sites individually. Throws
 * on a 409 so a caller's normal .then()/await chain never mistakes a rejection payload
 * for real data — App.tsx's bootstrap already expects and swallows that via try/catch.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  opts?: { background?: boolean },
): Promise<Response> {
  return coordinatedFetch(
    path,
    init,
    async () => {
      // Resolved here, not before queuing — coordinatedFetch may defer this call, and baking
      // the session id in earlier risks firing a stale header if the session changed (re-claim)
      // while the request sat in the queue.
      const sessionId = getSessionId()
      const headers = new Headers(init.headers)
      if (sessionId) headers.set('X-Loremaster-Session', sessionId)
      if (opts?.background) headers.set('X-Loremaster-Interaction', 'background')

      let res: Response
      try {
        res = await fetch(`${API_BASE}${path}`, { ...init, headers })
      } catch (err) {
        console.error(`apiFetch: ${path} unreachable —`, err)
        throw err
      }
      if (res.status >= 500) {
        console.error(`apiFetch: ${path} returned ${res.status}`)
        const text = await res.text().catch(() => '')
        let message = text
        try {
          const parsed = JSON.parse(text) as { error?: string }
          if (parsed?.error) message = parsed.error
        } catch {
          // not JSON — use the raw text as-is
        }
        throw new Error(message || `request failed (${res.status})`)
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as Partial<SupersededInfo> & {
          error?: string
        }
        if (body.error === 'unclaimed' || body.error === 'superseded') {
          const info: SupersededInfo = {
            reason: body.error,
            active: body.active ?? null,
            stale: body.stale ?? null,
          }
          for (const listener of supersededListeners) listener(info)
          throw new Error(`session ${info.reason}`)
        }
        throw new Error(body.error || `request failed (${res.status})`)
      }
      return res
    },
    opts,
  )
}
