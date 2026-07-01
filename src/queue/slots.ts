const MAX_SLOTS = 4;
let slotsInUse = 0;

export function getMaxSlots(): number {
  return MAX_SLOTS;
}

export function getSlotsInUse(): number {
  return slotsInUse;
}

export function canAcquireSlots(cost: number): boolean {
  return slotsInUse + cost <= MAX_SLOTS;
}

export function tryAcquireSlots(cost: number): boolean {
  if (!canAcquireSlots(cost)) return false;
  slotsInUse += cost;
  return true;
}

export function releaseSlots(cost: number): void {
  slotsInUse = Math.max(0, slotsInUse - cost);
}
