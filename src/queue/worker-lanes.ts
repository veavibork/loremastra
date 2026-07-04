/**
 * Lorepebble-style prose vs worker lanes — workers never run during active Featherless
 * prose/setup generation, and prose waits for workers to finish. Thread limits from env.
 */
let proseActive = 0;
let workerActive = 0;
let proseThreadLimit = 1;
let workerThreadLimit = 4;

export function refreshWorkerLaneLimits(): void {
  proseThreadLimit = Math.max(1, parseInt(process.env.PROSE_THREADS ?? "1", 10) || 1);
  workerThreadLimit = Math.max(1, parseInt(process.env.WORKER_THREADS ?? "3", 10) || 3);
}

export function getWorkerLaneSnapshot(): {
  proseActive: number;
  workerActive: number;
  proseThreadLimit: number;
  workerThreadLimit: number;
} {
  return { proseActive, workerActive, proseThreadLimit, workerThreadLimit };
}

export function isProsePreempting(): boolean {
  return proseActive > 0;
}

export function isWorkerLaneBusy(): boolean {
  return workerActive > 0;
}

/** Prose (author/editor) lane — never overlaps worker lane. */
export function tryAcquireProseLane(): boolean {
  if (workerActive > 0) return false;
  if (proseActive >= proseThreadLimit) return false;
  proseActive++;
  return true;
}

export function releaseProseLane(): void {
  proseActive = Math.max(0, proseActive - 1);
}

/** Worker (compress/archive/tag-gen/story-name) lane — never overlaps active prose. */
export function tryAcquireWorkerLane(): boolean {
  if (isProsePreempting()) return false;
  if (workerActive >= workerThreadLimit) return false;
  workerActive++;
  return true;
}

export function releaseWorkerLane(): void {
  workerActive = Math.max(0, workerActive - 1);
}
