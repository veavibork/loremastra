import { apiFetch } from './client.js'
import type { ModelProfileRow } from './types.js'

export async function fetchModelProfiles(opts?: {
  background?: boolean
}): Promise<ModelProfileRow[]> {
  const res = await apiFetch('/api/model-profiles', {}, opts)
  const data = (await res.json()) as { profiles: ModelProfileRow[] }
  return data.profiles
}

/** Enqueue a format probe (or re-probe). No-op if one is already pending/running. */
export async function requestModelProbe(provider: string, model: string): Promise<void> {
  const res = await apiFetch('/api/model-profiles/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? 'failed to request probe')
  }
}

export async function cancelModelProbe(provider: string, model: string): Promise<void> {
  const res = await apiFetch('/api/model-profiles/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? 'failed to cancel probe')
  }
}
