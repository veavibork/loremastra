import { useQuery } from '@tanstack/react-query'
import { fetchStoryToDate } from '../api'

export function useStoryToDate(storyId: string | null, opts?: { background?: boolean }) {
  return useQuery({
    queryKey: ['story-to-date', storyId],
    queryFn: () => fetchStoryToDate(storyId!, opts),
    enabled: !!storyId,
    refetchInterval: 3000,
  })
}
