import { useEffect, useState } from 'react'

/**
 * Forces a re-render every `intervalMs` while `active` is true, so components that render a live
 * `Date.now()`-derived elapsed label (e.g. "Thinking… (12s)", queue turnaround) keep ticking
 * between data/SSE events. This is a purely client-side clock — it does NOT poll the backend;
 * SSE (and QueueView's own refetchInterval) still own all data freshness. It exists because the
 * "eliminate polling" refactor removed the interval that used to re-render these labels as a side
 * effect, and no server event fires just because a second has passed. Gate `active` on there
 * actually being something live so idle views don't re-render forever.
 */
export function useNowTick(active: boolean, intervalMs = 1000): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((t) => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])
}
