import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listStories,
  createStory,
  deleteStory,
  renameStory,
  forkStory,
  fetchPhase,
  fetchLog,
} from '../api'

export function useStories() {
  return useQuery({
    queryKey: ['stories'],
    queryFn: listStories,
  })
}

export function useCreateStory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => createStory(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stories'] }),
  })
}

export function useDeleteStory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (storyId: string) => deleteStory(storyId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stories'] }),
  })
}

export function useRenameStory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ storyId, name }: { storyId: string; name: string }) =>
      renameStory(storyId, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stories'] }),
  })
}

export function useForkStory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ storyId, pageId, name }: { storyId: string; pageId?: string; name?: string }) =>
      forkStory(storyId, pageId, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stories'] }),
  })
}

export function usePhase(storyId: string | null) {
  return useQuery({
    queryKey: ['phase', storyId],
    queryFn: () => fetchPhase(storyId!),
    enabled: !!storyId,
  })
}

export function useLog(
  storyId: string,
  opts?: {
    limit?: number
    beforePageId?: string
    throughPageId?: string
    refetchInterval?: number
  },
) {
  return useQuery({
    queryKey: ['log', storyId, opts],
    queryFn: () =>
      fetchLog(storyId, {
        limit: opts?.limit,
        beforePageId: opts?.beforePageId,
        throughPageId: opts?.throughPageId,
      }),
    enabled: !!storyId,
    refetchInterval: opts?.refetchInterval,
  })
}
