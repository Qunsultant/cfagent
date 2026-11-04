/**
 * Ad-beacon gate preference (#2786 Part 2, scope d-ii).
 *
 * The Workflow Runs toolbar's "Ad beacons" toggle writes this
 * per-browser preference; GoogleAdUnit reads it before firing an
 * impression or click beacon. Default: beacons ON (today's behavior).
 * Pausing is a per-browser, user-visible choice — it undercounts ad
 * attribution while paused, which the toolbar states next to the
 * toggle. Storage access is guarded: without a storage object the
 * preference reads as "not paused" and writes are dropped, never
 * thrown — a missing storage must never break an ad render.
 */
export const AD_BEACONS_PAUSED_KEY = "openaimp:ad-beacons-paused";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function readStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  try {
    if (typeof globalThis !== "undefined" && (globalThis as { localStorage?: StorageLike }).localStorage) {
      return (globalThis as { localStorage: StorageLike }).localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

export function isAdBeaconsPaused(storage?: StorageLike | null): boolean {
  try {
    return readStorage(storage)?.getItem(AD_BEACONS_PAUSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAdBeaconsPaused(paused: boolean, storage?: StorageLike | null): void {
  try {
    const store = readStorage(storage);
    if (!store) return;
    if (paused) store.setItem(AD_BEACONS_PAUSED_KEY, "1");
    else store.removeItem(AD_BEACONS_PAUSED_KEY);
  } catch {
    // A missing storage must never break the caller.
  }
}
