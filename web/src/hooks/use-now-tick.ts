import { useEffect, useState } from 'react'

/**
 * Forces a re-render every `intervalMs` while `active` is true, so components that render a live
 * `Date.now()`-derived elapsed label (e.g. "Thinking… (12s)", queue turnaround) keep ticking
 * between data/SSE events. This is a purely client-side clock — it does NOT poll the backend;
 * SSE (and QueueView's own refetchInterval) still own all data freshness. It exists because the
 * "eliminate polling" refactor removed the interval that used to re-render these labels as a side
 * effect, and no server event fires just because a second has passed. Gate `active` on there
 * actually being something live so idle views don't re-render forever.
 *
 * Returns the current tick count. Plain components can ignore it (the re-render is the effect),
 * but a virtualized list (react-virtuoso) memoizes item content and won't re-render items on a
 * parent render alone — pass this value as its `context` prop so item renderers actually re-run.
 */
export function useNowTick(active: boolean, intervalMs = 1000): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((t) => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])
  return tick
}
