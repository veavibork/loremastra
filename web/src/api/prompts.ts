import { apiFetch } from './client.js'
import type { PromptCatalogEntry, PromptPreview } from './types.js'

export async function fetchPrompts(): Promise<PromptCatalogEntry[]> {
  const res = await apiFetch(`/api/prompts`)
  const data = (await res.json()) as { prompts: PromptCatalogEntry[] }
  return data.prompts
}

export async function fetchPromptPreview(
  storyId: string,
  opts?: { background?: boolean },
): Promise<PromptPreview> {
  const res = await apiFetch(`/api/stories/${storyId}/prompt-preview`, {}, opts)
  return res.json() as Promise<PromptPreview>
}

export type { PromptCatalogEntry, PromptPreview, PromptMessage } from './types.js'
