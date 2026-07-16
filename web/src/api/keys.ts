import { apiFetch } from './client.js'
import type { AccountProfile } from './types.js'

export async function fetchAccount(): Promise<AccountProfile> {
  const res = await apiFetch(`/api/account`)
  return res.json()
}

export async function updateDisplayName(displayName: string): Promise<AccountProfile> {
  const res = await apiFetch(`/api/account/display-name`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

/**
 * Release the current claim: invalidate the session server-side, drop the stored session id, and
 * reload back to the claim screen (App boots straight into ClaimGate when no session id is present).
 * The stored userId is kept so re-claiming pre-fills the same account. Best-effort on the network
 * call — if it fails (already superseded, offline), we still drop the local session and reload.
 */
export async function logout(): Promise<void> {
  try {
    await apiFetch(`/api/account/logout`, { method: 'POST' })
  } catch {
    // logging out regardless — fall through to clearing local state
  }
  localStorage.removeItem('loremaster.sessionId')
  window.location.reload()
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await apiFetch(`/api/account/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
}

type KeyFields = Pick<AccountProfile, 'featherlessKeyMasked' | 'hordeKeyMasked'>

export async function setFeatherlessKey(key: string): Promise<KeyFields> {
  const res = await apiFetch(`/api/account/featherless-key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

export async function clearFeatherlessKey(): Promise<KeyFields> {
  const res = await apiFetch(`/api/account/featherless-key`, { method: 'DELETE' })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

export async function setHordeKey(key: string): Promise<KeyFields> {
  const res = await apiFetch(`/api/account/horde-key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

export async function clearHordeKey(): Promise<KeyFields> {
  const res = await apiFetch(`/api/account/horde-key`, { method: 'DELETE' })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}
