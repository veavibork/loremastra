import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchModelConfigs,
  fetchModelCatalog,
  createModelConfig,
  deleteModelConfig,
  reorderModelConfigs,
  updateModelConfig,
} from '../api'
import type { ModelConfigPatch } from '../api'

export function useModelConfigs() {
  return useQuery({
    queryKey: ['model-configs'],
    queryFn: fetchModelConfigs,
  })
}

export function useModelCatalog(provider: string | null) {
  return useQuery({
    queryKey: ['model-catalog', provider],
    queryFn: () => fetchModelCatalog(provider!),
    enabled: !!provider,
  })
}

export function useCreateModelConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => createModelConfig(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['model-configs'] }),
  })
}

export function useUpdateModelConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ModelConfigPatch }) =>
      updateModelConfig(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['model-configs'] }),
  })
}

export function useDeleteModelConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteModelConfig(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['model-configs'] }),
  })
}

export function useReorderModelConfigs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => reorderModelConfigs(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['model-configs'] }),
  })
}
