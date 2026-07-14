import { API_BASE, setSessionId } from './client.js'
import type { UserProfile } from './types.js'

/** Guard-exempt (GET only) — the picker needs this before any session exists. */
export async function fetchUsers(): Promise<UserProfile[]> {
  const res = await fetch(`${API_BASE}/api/users`)
  return res.json()
}

/**
 * Deliberately raw fetch, not apiFetch — this route is guard-exempt server-side
 * (src/routes/sessions.ts), and attaching a soon-to-be-invalidated old session header
 * here would be pointless. Keeps the exemption visible in client code too, not just the
 * server's.
 */
export async function claimSession(
  userId: string,
  password: string,
): Promise<{ sessionId: string; claimedAt: string }> {
  const res = await fetch(`${API_BASE}/api/sessions/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, password }),
  })
  const data = (await res.json()) as { sessionId?: string; claimedAt?: string; error?: string }
  if (!data.sessionId) throw new Error(data.error ?? 'claim failed')
  setSessionId(data.sessionId)
  localStorage.setItem('loremaster.userId', userId)
  return { sessionId: data.sessionId, claimedAt: data.claimedAt! }
}

export { getSessionId, setSessionId, getStoredUserId, onSuperseded } from './client.js'
export type { SupersededInfo, SupersededReason, UserProfile } from './types.js'
