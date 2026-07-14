import { apiFetch } from './client.js'
import type { GenerationOptions } from './types.js'

export async function postMessage(
  storyId: string,
  content: string,
  generationOptions?: GenerationOptions,
): Promise<{ jobId: string; agentPageId: string }> {
  const res = await apiFetch(`/api/stories/${storyId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, generationOptions }),
  })
  return res.json()
}

export async function retryPost(
  storyId: string,
  pageId: string,
  guidance?: string,
  generationOptions?: GenerationOptions,
): Promise<{ jobId: string; textId: string }> {
  const res = await apiFetch(`/api/stories/${storyId}/posts/${pageId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guidance, generationOptions }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

export async function editPost(storyId: string, pageId: string, content: string): Promise<void> {
  const res = await apiFetch(`/api/stories/${storyId}/posts/${pageId}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
}

export async function continuePost(
  storyId: string,
  guidance?: string,
  generationOptions?: GenerationOptions,
): Promise<{ agentPageId: string; jobId: string }> {
  const res = await apiFetch(`/api/stories/${storyId}/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guidance, generationOptions }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

export async function postSetupMessage(
  storyId: string,
  content: string,
): Promise<{ jobId: string; agentPageId: string }> {
  const res = await apiFetch(`/api/stories/${storyId}/setup/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

/** One-shot: generates the opening post and moves the story into story phase immediately. */
export async function kickoff(storyId: string): Promise<{ agentPageId: string; jobId: string }> {
  const res = await apiFetch(`/api/stories/${storyId}/kickoff`, { method: 'POST' })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

/** Marks a fresh post-kickoff OOC "update session" boundary — no page created, nothing new in the log. */
export async function startOocSession(storyId: string): Promise<void> {
  const res = await apiFetch(`/api/stories/${storyId}/ooc/start-session`, { method: 'POST' })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
}

export type { GenerationOptions } from './types.js'
