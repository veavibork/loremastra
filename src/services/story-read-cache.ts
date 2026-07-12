/** Short-TTL cache + in-flight dedup for expensive per-story read endpoints. */

const cache = new Map<string, { expires: number; data: unknown }>()
const inflight = new Map<string, Promise<unknown>>()

export function invalidateStoryReadCache(storyId: string): void {
  const prefix = `${storyId}:`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) inflight.delete(key)
  }
}

/** One compute per key while in flight; TTL reuse for concurrent tab polls. */
export function cachedStoryRead<T>(key: string, ttlMs: number, compute: () => T): Promise<T> {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expires > now) return Promise.resolve(hit.data as T)

  const pending = inflight.get(key)
  if (pending) return pending as Promise<T>

  const promise = Promise.resolve().then(() => {
    const data = compute()
    cache.set(key, { expires: Date.now() + ttlMs, data })
    inflight.delete(key)
    return data
  })
  inflight.set(key, promise)
  return promise as Promise<T>
}
