import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchSettingsSpace, saveSettingsSpace, revertSettingsSpace } from '../api'

export function useSettingsSpace<T>(space: string) {
  return useQuery({
    queryKey: ['settings', space],
    queryFn: () => fetchSettingsSpace<T>(space),
  })
}

export function useSaveSettingsSpace<T>() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ space, value }: { space: string; value: T }) =>
      saveSettingsSpace<T>(space, value),
    onSuccess: (_data, { space }) => qc.invalidateQueries({ queryKey: ['settings', space] }),
  })
}

export function useRevertSettingsSpace<T>() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (space: string) => revertSettingsSpace<T>(space),
    onSuccess: (_data, space) => qc.invalidateQueries({ queryKey: ['settings', space] }),
  })
}
