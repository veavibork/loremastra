import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { streamStoryEvents } from '../api'

const KIND_QUERY_KEYS: Record<'worldbook' | 'segments' | 'jobs', string> = {
  worldbook: 'worldbook',
  segments: 'story-to-date',
  // 'jobs' pings fire on creation, claim (pending→running), completion, and cancel — the Queue
  // tab polls only while something is in flight (to tick clocks/progress labels) and otherwise
  // rides these pings alone (use-jobs.ts pollOnlyWhileActive).
  jobs: 'jobs',
}

/**
 * One SSE connection per loaded story that turns server-side data changes (worldbook entries
 * written by setup/compact jobs, story-to-date segments filled or invalidated by post edits)
 * into TanStack query invalidations. This replaced the Worldbook/Segments tabs' 3s
 * refetchInterval polling. Client-initiated mutations don't need it — their mutation hooks
 * already update the cache — but the redundant invalidation they trigger is harmless.
 */
export function useStoryEvents(storyId: string | null): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!storyId) return
    return streamStoryEvents(
      storyId,
      (event) => {
        if (event.type !== 'data-changed') return
        void queryClient.invalidateQueries({ queryKey: [KIND_QUERY_KEYS[event.kind], storyId] })
      },
      () => {
        // Reconnected after a drop — refetch both views to cover anything missed while offline.
        for (const key of Object.values(KIND_QUERY_KEYS)) {
          void queryClient.invalidateQueries({ queryKey: [key, storyId] })
        }
      },
    )
  }, [storyId, queryClient])
}
