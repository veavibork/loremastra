import { apiFetch } from './client.js'
import type { WorldbookEntry, WorldbookEntryType } from './types.js'

export async function fetchWorldbook(
  storyId: string,
  opts?: { background?: boolean },
): Promise<WorldbookEntry[]> {
  const res = await apiFetch(`/api/stories/${storyId}/worldbook`, {}, opts)
  const data = (await res.json()) as { entries: WorldbookEntry[] }
  return data.entries
}

export async function createWorldbookEntry(
  storyId: string,
  input: { entryType: WorldbookEntryType; content: string },
): Promise<WorldbookEntry> {
  const res = await apiFetch(`/api/stories/${storyId}/worldbook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = (await res.json()) as { entry?: WorldbookEntry; error?: string }
  if (!data.entry) throw new Error(data.error ?? 'failed to create worldbook entry')
  return data.entry
}

export async function updateWorldbookEntry(
  storyId: string,
  pageId: string,
  input: { content?: string; hidden?: boolean },
): Promise<void> {
  const res = await apiFetch(`/api/stories/${storyId}/worldbook/${pageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = (await res.json()) as { ok?: boolean; error?: string }
  if (!data.ok) throw new Error(data.error ?? 'failed to update worldbook entry')
}

export async function compactWorldbook(
  storyId: string,
  opts?: { entryType?: WorldbookEntryType; includeHidden?: boolean },
): Promise<{ jobId: string }> {
  const res = await apiFetch(`/api/stories/${storyId}/worldbook/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts ?? {}),
  })
  const data = (await res.json()) as {
    ok?: boolean
    jobId?: string
    error?: string
  }
  if (!data.ok || !data.jobId) {
    throw new Error(data.error ?? 'failed to queue worldbook crunch')
  }
  return { jobId: data.jobId }
}

export type { WorldbookEntry, WorldbookEntryType, WorldbookCompactResult } from './types.js'
