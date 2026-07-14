import { apiFetch } from './client.js'
import type { Position } from './types.js'

export async function fetchPosition(storyId: string): Promise<Position> {
  const res = await apiFetch(`/api/stories/${storyId}/position`)
  return res.json()
}

export async function undoPosition(storyId: string): Promise<Position> {
  const res = await apiFetch(`/api/stories/${storyId}/position/undo`, { method: 'POST' })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

export async function redoPosition(storyId: string): Promise<Position> {
  const res = await apiFetch(`/api/stories/${storyId}/position/redo`, { method: 'POST' })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

export async function jumpToPosition(storyId: string, pageId: string): Promise<Position> {
  const res = await apiFetch(`/api/stories/${storyId}/position`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageId }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

export type { Position } from './types.js'
