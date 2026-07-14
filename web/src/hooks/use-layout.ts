import { useQuery } from '@tanstack/react-query'
import { fetchLayout } from '../api'

export function useLayout() {
  return useQuery({
    queryKey: ['layout'],
    queryFn: async () => (await fetchLayout()).config,
  })
}
