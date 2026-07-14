import { useQuery } from '@tanstack/react-query'
import { fetchAccount } from '../api'

export function useAccount() {
  return useQuery({
    queryKey: ['account'],
    queryFn: fetchAccount,
  })
}
