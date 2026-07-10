/** Limits concurrent API requests and dedupes identical in-flight GETs — leaves headroom for SSE. */
const MAX_CONCURRENT = 4;

type QueuedTask = { run: () => void; priority: number };

const inflight = new Map<string, Promise<Response>>();
let active = 0;
const waitQueue: QueuedTask[] = [];

function requestKey(method: string, path: string): string {
  return `${method}:${path}`;
}

function drainQueue(): void {
  while (active < MAX_CONCURRENT && waitQueue.length > 0) {
    waitQueue.sort((a, b) => b.priority - a.priority);
    const next = waitQueue.shift();
    next?.run();
  }
}

function schedule(priority: number, run: () => Promise<void>): void {
  if (active < MAX_CONCURRENT) {
    void run().finally(() => {
      active--;
      drainQueue();
    });
    active++;
    return;
  }
  waitQueue.push({
    priority,
    run: () => {
      void run().finally(() => {
        active--;
        drainQueue();
      });
      active++;
    },
  });
}

/**
 * Wraps fetch with concurrency limiting and GET dedup. Callers sharing a deduped response
 * receive a clone so each can read the body independently.
 */
export function coordinatedFetch(
  path: string,
  init: RequestInit,
  perform: () => Promise<Response>,
  opts?: { background?: boolean }
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const key = requestKey(method, path);
  const priority = opts?.background ? 0 : 1;

  if (method === "GET" && !init.body) {
    const existing = inflight.get(key);
    if (existing) {
      return existing.then((res) => res.clone());
    }
  }

  const promise = new Promise<Response>((resolve, reject) => {
    schedule(priority, async () => {
      try {
        const res = await perform();
        resolve(res);
      } catch (err) {
        reject(err);
      } finally {
        if (method === "GET" && !init.body) inflight.delete(key);
      }
    });
  });

  if (method === "GET" && !init.body) inflight.set(key, promise);
  return promise;
}
