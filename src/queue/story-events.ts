import { EventEmitter } from 'node:events'

/**
 * Story-scoped data-change bus — the invalidation counterpart to job-events.ts's per-job
 * streams. Job streams carry one generation's tokens to the client that started it; this
 * carries "something you may be displaying just changed server-side" pings (worldbook entries
 * written by setup/compact jobs, story-to-date segments filled/renamed/invalidated) so the
 * Worldbook and Segments tabs can invalidate their queries instead of polling on a timer.
 * Events are deliberately content-free — the client refetches through the normal HTTP views,
 * so there's no second serialization path to keep consistent.
 */
const emitter = new EventEmitter()
emitter.setMaxListeners(0)

export type StoryDataKind = 'worldbook' | 'segments' | 'jobs'

export interface StoryDataEvent {
  type: 'data-changed'
  kind: StoryDataKind
}

export function publishStoryDataChanged(storyId: string, kind: StoryDataKind): void {
  emitter.emit(storyId, { type: 'data-changed', kind } satisfies StoryDataEvent)
}

export function subscribeStoryEvents(
  storyId: string,
  onEvent: (event: StoryDataEvent) => void,
): () => void {
  emitter.on(storyId, onEvent)
  return () => emitter.off(storyId, onEvent)
}
