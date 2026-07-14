import { apiFetch } from './client.js'
import type { Story, StoryState, LogPage } from './types.js'

export async function listStories(): Promise<Story[]> {
  const res = await apiFetch(`/api/stories`)
  const data = (await res.json()) as { stories: Story[] }
  return data.stories
}

export async function createStory(name: string): Promise<Story> {
  const res = await apiFetch(`/api/stories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const data = (await res.json()) as { story: Story }
  return data.story
}

export async function deleteStory(storyId: string): Promise<void> {
  const res = await apiFetch(`/api/stories/${storyId}`, { method: 'DELETE' })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
}

export async function renameStory(storyId: string, name: string): Promise<void> {
  const res = await apiFetch(`/api/stories/${storyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
}

export async function forkStory(storyId: string, pageId?: string, name?: string): Promise<Story> {
  const res = await apiFetch(`/api/stories/${storyId}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageId, name }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.story
}

export async function fetchPhase(storyId: string): Promise<StoryState> {
  const res = await apiFetch(`/api/stories/${storyId}/phase`)
  return res.json()
}

export async function fetchLog(
  storyId: string,
  opts?: { background?: boolean; limit?: number; beforePageId?: string; throughPageId?: string },
): Promise<LogPage> {
  const params = new URLSearchParams()
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts?.beforePageId) params.set('beforePageId', opts.beforePageId)
  if (opts?.throughPageId) params.set('throughPageId', opts.throughPageId)
  const qs = params.toString()
  const res = await apiFetch(`/api/stories/${storyId}/log${qs ? `?${qs}` : ''}`, {}, opts)
  return (await res.json()) as LogPage
}

export type { Story, StoryState, StoryPhase, LogEntry, LogPage } from './types.js'
