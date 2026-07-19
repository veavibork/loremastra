import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchModelProfiles, requestModelProbe, cancelModelProbe } from '../api'

/**
 * Model format profiles + probe-queue state. Polls only while a probe is pending/running
 * (progress labels update server-side); once everything is settled, the data only changes on
 * user action, so the mutations below invalidate instead of polling.
 */
export function useModelProfiles() {
  return useQuery({
    queryKey: ['model-profiles'],
    queryFn: () => fetchModelProfiles({ background: true }),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((p) => p.status === 'running' || p.status === 'pending')
        ? 2000
        : false,
  })
}

export function useRequestModelProbe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ provider, model }: { provider: string; model: string }) =>
      requestModelProbe(provider, model),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['model-profiles'] }),
  })
}

export function useCancelModelProbe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ provider, model }: { provider: string; model: string }) =>
      cancelModelProbe(provider, model),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['model-profiles'] }),
  })
}
