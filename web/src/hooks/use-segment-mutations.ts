import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  backfillStoryToDateNames,
  deleteStoryToDateSegment,
  enqueueStoryToDate,
  requeueStoryToDateSegment,
  updateStoryToDateSegment,
  type StoryToDatePage,
} from '../api'

/** Set the story-to-date page into the query cache. */
function setPage(qc: ReturnType<typeof useQueryClient>, storyId: string, page: StoryToDatePage) {
  qc.setQueryData(['story-to-date', storyId], page)
}

export function useBackfillStoryToDateNames() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (storyId: string) => backfillStoryToDateNames(storyId),
    onSuccess: (page, storyId) => setPage(qc, storyId, page),
  })
}

export function useEnqueueStoryToDate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (storyId: string) => enqueueStoryToDate(storyId),
    onSuccess: (page, storyId) => setPage(qc, storyId, page),
  })
}

export function useUpdateStoryToDateSegment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      storyId,
      segmentId,
      changes,
    }: {
      storyId: string
      segmentId: string
      changes: { content?: string; coverageThroughIcPost?: number }
    }) => updateStoryToDateSegment(storyId, segmentId, changes),
    onSuccess: (page, { storyId }) => setPage(qc, storyId, page),
  })
}

export function useDeleteStoryToDateSegment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      storyId,
      segmentId,
      opts,
    }: {
      storyId: string
      segmentId: string
      opts?: { deleteLater?: boolean }
    }) => deleteStoryToDateSegment(storyId, segmentId, opts),
    onSuccess: (page, { storyId }) => setPage(qc, storyId, page),
  })
}

export function useRequeueStoryToDateSegment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ storyId, segmentId }: { storyId: string; segmentId: string }) =>
      requeueStoryToDateSegment(storyId, segmentId),
    onSuccess: (page, { storyId }) => setPage(qc, storyId, page),
  })
}
