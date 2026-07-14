import { apiFetch } from './client.js'
import type { StoryToDatePage } from './types.js'

export async function fetchStoryToDate(
  storyId: string,
  options: { background?: boolean } = {},
): Promise<StoryToDatePage> {
  const res = await apiFetch(
    `/api/stories/${storyId}/story-to-date`,
    {},
    { background: options.background },
  )
  return res.json() as Promise<StoryToDatePage>
}

export async function backfillStoryToDateNames(storyId: string): Promise<StoryToDatePage> {
  const res = await apiFetch(`/api/stories/${storyId}/story-to-date/backfill-names`, {
    method: 'POST',
  })
  const data = (await res.json()) as { view: StoryToDatePage; error?: string }
  if (data.error) throw new Error(data.error)
  return data.view
}

export async function updateStoryToDateSegment(
  storyId: string,
  segmentId: string,
  patch: { content?: string; name?: string; coverageThroughIcPost?: number },
): Promise<StoryToDatePage> {
  const res = await apiFetch(`/api/stories/${storyId}/story-to-date/${segmentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = (await res.json()) as { view: StoryToDatePage; error?: string }
  if (data.error) throw new Error(data.error)
  return data.view
}

export async function deleteStoryToDateSegment(
  storyId: string,
  segmentId: string,
  options: { deleteLater?: boolean } = {},
): Promise<StoryToDatePage> {
  const q = options.deleteLater ? '?deleteLater=true' : ''
  const res = await apiFetch(`/api/stories/${storyId}/story-to-date/${segmentId}${q}`, {
    method: 'DELETE',
  })
  const data = (await res.json()) as { view: StoryToDatePage; error?: string }
  if (data.error) throw new Error(data.error)
  return data.view
}

export async function enqueueStoryToDate(storyId: string): Promise<StoryToDatePage> {
  const res = await apiFetch(`/api/stories/${storyId}/story-to-date/enqueue`, { method: 'POST' })
  const data = (await res.json()) as { view: StoryToDatePage; error?: string }
  if (data.error) throw new Error(data.error)
  return data.view
}

export async function requeueStoryToDateSegment(
  storyId: string,
  segmentId: string,
): Promise<StoryToDatePage> {
  const res = await apiFetch(`/api/stories/${storyId}/story-to-date/${segmentId}/requeue`, {
    method: 'POST',
  })
  const data = (await res.json()) as { view: StoryToDatePage; error?: string }
  if (data.error) throw new Error(data.error)
  return data.view
}

export type { StoryToDatePage, StoryToDateSegment, ActiveMemoryJob } from './types.js'
