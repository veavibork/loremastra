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
