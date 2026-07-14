import { useQuery } from '@tanstack/react-query'
import { fetchWorldbook } from '../api'

export function useWorldbook(storyId: string | null, opts?: { background?: boolean }) {
  return useQuery({
    queryKey: ['worldbook', storyId],
    queryFn: () => fetchWorldbook(storyId!, opts),
    enabled: !!storyId,
    refetchInterval: 3000,
  })
}
