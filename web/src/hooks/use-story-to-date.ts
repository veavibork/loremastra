import { useQuery } from '@tanstack/react-query'
import { fetchStoryToDate } from '../api'

export function useStoryToDate(storyId: string | null, opts?: { background?: boolean }) {
  // No refetchInterval: freshness comes from mutation-hook cache writes (local edits) and the
  // story events SSE stream (segment fills/invalidations) — see use-story-events.ts.
  return useQuery({
    queryKey: ['story-to-date', storyId],
    queryFn: () => fetchStoryToDate(storyId!, opts),
    enabled: !!storyId,
  })
}
