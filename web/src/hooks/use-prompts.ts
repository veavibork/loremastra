import { useQuery } from '@tanstack/react-query'
import { fetchPrompts, fetchPromptPreview } from '../api'

export function usePrompts() {
  return useQuery({
    queryKey: ['prompts'],
    queryFn: fetchPrompts,
  })
}

export function usePromptPreview(storyId: string | null, opts?: { background?: boolean }) {
  return useQuery({
    queryKey: ['prompt-preview', storyId],
    queryFn: () => fetchPromptPreview(storyId!, opts),
    enabled: !!storyId,
  })
}
