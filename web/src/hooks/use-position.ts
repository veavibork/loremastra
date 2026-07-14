import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchPosition, undoPosition, redoPosition, jumpToPosition } from '../api'

export function usePosition(storyId: string | null) {
  return useQuery({
    queryKey: ['position', storyId],
    queryFn: () => fetchPosition(storyId!),
    enabled: !!storyId,
  })
}

export function useUndoPosition() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (storyId: string) => undoPosition(storyId),
    onSuccess: (data, storyId) => {
      qc.setQueryData(['position', storyId], data)
      qc.invalidateQueries({ queryKey: ['log', storyId] })
    },
  })
}

export function useRedoPosition() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (storyId: string) => redoPosition(storyId),
    onSuccess: (data, storyId) => {
      qc.setQueryData(['position', storyId], data)
      qc.invalidateQueries({ queryKey: ['log', storyId] })
    },
  })
}

export function useJumpToPosition() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ storyId, pageId }: { storyId: string; pageId: string }) =>
      jumpToPosition(storyId, pageId),
    onSuccess: (data, { storyId }) => {
      qc.setQueryData(['position', storyId], data)
      qc.invalidateQueries({ queryKey: ['log', storyId] })
    },
  })
}

export type { Position } from '../api'
