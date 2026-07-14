import { apiFetch } from './client.js'

/** Generic Settings-tab JSON space storage — see src/routes/settings-spaces.ts. */
export async function fetchSettingsSpace<T>(space: string): Promise<T> {
  const res = await apiFetch(`/api/settings/${space}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.value as T
}

export async function saveSettingsSpace<T>(space: string, value: T): Promise<T> {
  const res = await apiFetch(`/api/settings/${space}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.value as T
}

export async function revertSettingsSpace<T>(space: string): Promise<T> {
  const res = await apiFetch(`/api/settings/${space}/revert`, { method: 'POST' })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.value as T
}
