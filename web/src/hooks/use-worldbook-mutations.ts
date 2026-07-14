import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createWorldbookEntry, updateWorldbookEntry, compactWorldbook } from '../api'
import type { WorldbookEntryType } from '../api'

export function useCreateWorldbookEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      storyId,
      entry,
    }: {
      storyId: string
      entry: { entryType: WorldbookEntryType; content: string }
    }) => createWorldbookEntry(storyId, entry),
    onSuccess: (_data, { storyId }) => qc.invalidateQueries({ queryKey: ['worldbook', storyId] }),
  })
}

export function useUpdateWorldbookEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      storyId,
      pageId,
      changes,
    }: {
      storyId: string
      pageId: string
      changes: { content?: string; hidden?: boolean }
    }) => updateWorldbookEntry(storyId, pageId, changes),
    onSuccess: (_data, { storyId }) => qc.invalidateQueries({ queryKey: ['worldbook', storyId] }),
  })
}

export function useCompactWorldbook() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (storyId: string) => compactWorldbook(storyId),
    onSuccess: (_data, storyId) => qc.invalidateQueries({ queryKey: ['worldbook', storyId] }),
  })
}
