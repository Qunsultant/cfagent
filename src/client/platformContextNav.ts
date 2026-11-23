/**
 * #6151 S1 — the selection ∩ availability merge.
 *
 * Chat.tsx keeps the user's SELECTION (the adopted localStorage
 * map, or the persona default for a fresh user); the context store
 * carries the server-computed AVAILABILITY. The effective map passed
 * down to NavigationMenu / LeftNavBar / NavSettingsPage is the
 * intersection — the server decides what is available, the user
 * decides what is selected, and neither side can widen the other.
 */

/**
 * Merge a selection map with an availability map. Top-level ids are
 * visible iff selected AND available; a sub-item key
 * `<parent>:<sub>` is visible iff its PARENT is selected AND the
 * sub-item itself is available (sub-items follow their parent until
 * #6147 S6 adds per-sub-item toggles). The result covers exactly
 * the availability keys — a stale selection id the server no longer
 * enumerates is dropped, never resurrected.
 */
export function mergeVisibleTabs(
  selection: Record<string, boolean>,
  availability: Record<string, boolean>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, available] of Object.entries(availability)) {
    if (key.includes(":")) {
      const parent = key.slice(0, key.indexOf(":"));
      out[key] = selection[parent] === true && available === true;
    } else {
      out[key] = selection[key] === true && available === true;
    }
  }
  return out;
}
