import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchJobs, fetchSlots, fetchActiveJobs, cancelJob, panicStopAllJobs } from '../api'

export function useJobs(
  storyId: string | null,
  opts?: { background?: boolean; refetchInterval?: number },
) {
  return useQuery({
    queryKey: ['jobs', storyId],
    queryFn: () => fetchJobs(storyId!, opts),
    enabled: !!storyId,
    refetchInterval: opts?.refetchInterval,
  })
}

export function useSlots(opts?: { background?: boolean; refetchInterval?: number }) {
  return useQuery({
    queryKey: ['slots'],
    queryFn: () => fetchSlots(opts),
    refetchInterval: opts?.refetchInterval,
  })
}

export function useActiveJobs(storyId: string | null) {
  return useQuery({
    queryKey: ['active-jobs', storyId],
    queryFn: () => fetchActiveJobs(storyId!),
    enabled: !!storyId,
  })
}

export function useCancelJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ storyId, jobId }: { storyId: string; jobId: string }) =>
      cancelJob(storyId, jobId),
    onSuccess: (_data, { storyId }) => {
      qc.invalidateQueries({ queryKey: ['story-to-date', storyId] })
      qc.invalidateQueries({ queryKey: ['jobs', storyId] })
    },
  })
}

/** Panic button — stops every pending/running job for this user, across every story. */
export function usePanicStopAllJobs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => panicStopAllJobs(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] })
      qc.invalidateQueries({ queryKey: ['active-jobs'] })
      qc.invalidateQueries({ queryKey: ['slots'] })
      qc.invalidateQueries({ queryKey: ['story-to-date'] })
    },
  })
}
