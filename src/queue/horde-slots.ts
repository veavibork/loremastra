/**
 * Horde has no account-wide concurrency signal the way Featherless does (see
 * concurrency-feed.ts) — no equivalent stream exists to gate against. This is a plain local
 * cap on outstanding submissions, deliberately much simpler than slots.ts. Default is
 * conservative given the anonymous key's shared global bucket across every anonymous caller
 * (see docs/roadmap.md's Horde research notes); a registered key can afford a higher ceiling.
 */
const HORDE_MAX_CONCURRENT = Number(process.env.HORDE_MAX_CONCURRENT ?? 2);

const active = new Set<string>();

export function tryAcquireHordeSlot(jobId: string): boolean {
  if (active.size >= HORDE_MAX_CONCURRENT) return false;
  active.add(jobId);
  return true;
}

export function releaseHordeSlot(jobId: string): void {
  active.delete(jobId);
}
