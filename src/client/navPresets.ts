/**
 * #6151 S2 — the nav preset maps, in shared data.
 *
 * Moved here from NavigationMenu.tsx (issues 3696 S1 + 3697 S2):
 * the preset maps are COMPUTED from DEFAULT_LEFT_NAV_CONFIG by
 * section, so a config change flows into the presets instead of
 * drifting from them — and the server route (src/server/routes/nav.ts)
 * expands the persona default from these same maps, so the client
 * and the server can never disagree about what a preset key means.
 * S1 expanded only `alltabs` server-side (every enumerated id ->
 * true, with a warn-log fallback for any other key); S2 expands ANY
 * key through expandPresetKey below — a sub-item key follows its
 * parent, the same rule mergeVisibleTabs applies client-side.
 * One home: NavigationMenu, Chat, NavSettingsPage and the tests all
 * import from here; no second copy of a preset map exists.
 */
import { DEFAULT_LEFT_NAV_CONFIG, enumerateNavAvailabilityIds } from "./navConfig";
import type { RouteCategory } from "./routes";

/**
 * Nav presets (issues 3696 S1 + 3697 S2, subs of epic 3695).
 *
 * The preset source of truth is the left-nav config, not a hand-listed
 * map: category presets are COMPUTED from `DEFAULT_LEFT_NAV_CONFIG` by
 * section, so a config change (a new item, a section move) flows into
 * the presets instead of silently drifting from them. `alltabs` is every
 * config id; `none` is empty. Only `minimal` is a curated list, decided
 * by Ceos 2026-11-17; `trading` is the Execution section plus `orders`,
 * `payment` the Billing section plus `sandbox` — the two cross-section
 * members the decided set names. The retired `all` / `traderFocus`
 * keys are gone with the menu buttons that used them.
 *
 * A preset map is keyed by config id only (26 on main at build time).
 * Route ids with a navEntry but no config entry resolve through their
 * left-nav parent — see `routeOnlyNavParent` — so the map never has to
 * list them.
 */
export type NavPresetKey =
  | "alltabs"
  | "research"
  | "trading"
  | "payment"
  | "marketing"
  | "platform"
  | "minimal"
  | "none";

export const NAV_PRESET_KEYS: NavPresetKey[] = [
  "alltabs",
  "research",
  "trading",
  "payment",
  "marketing",
  "platform",
  "minimal",
  "none",
];

export const NAV_PRESET_LABELS: Record<NavPresetKey, string> = {
  alltabs: "All Tabs",
  research: "Research",
  trading: "Trading",
  payment: "Payment",
  marketing: "Marketing",
  platform: "Platform",
  minimal: "Minimal",
  none: "None",
};

/** localStorage key for the selected preset, written beside the map. */
export const NAV_PRESET_STORAGE_KEY = "nextgentp_nav_preset";

/** Every id the left-nav config renders, in config order. */
export function leftNavConfigIds(): string[] {
  return DEFAULT_LEFT_NAV_CONFIG.sections.flatMap((section) =>
    section.items.map((item) => item.id),
  );
}

/** The config ids of one nav section, by category. */
export function leftNavSectionIds(category: RouteCategory): string[] {
  return DEFAULT_LEFT_NAV_CONFIG.sections
    .filter((section) => section.category === category)
    .flatMap((section) => section.items.map((item) => item.id));
}

/** The curated minimal set (Ceos 2026-11-17): the five desk essentials. */
const MINIMAL_PRESET_IDS = [
  "autopilot",
  "order",
  "portfolio",
  "stock-hub",
  "chat",
];

export function buildPresetMap(key: NavPresetKey): Record<string, boolean> {
  const ids = leftNavConfigIds();
  const members = (members: string[]): Record<string, boolean> =>
    Object.fromEntries(ids.map((id) => [id, members.includes(id)]));
  switch (key) {
    case "alltabs":
      return Object.fromEntries(ids.map((id) => [id, true]));
    case "research":
      return members(leftNavSectionIds("Intelligence"));
    case "trading":
      return members([...leftNavSectionIds("Execution"), "orders"]);
    case "payment":
      return members([...leftNavSectionIds("Billing"), "sandbox"]);
    case "marketing":
      return members(leftNavSectionIds("Marketing"));
    case "platform":
      // The Sandbox section carries category Platform in the config,
      // but the decided set puts sandbox in `payment`, not here.
      return members(
        leftNavSectionIds("Platform").filter((id) => id !== "sandbox"),
      );
    case "minimal":
      return members(MINIMAL_PRESET_IDS);
    case "none":
      return Object.fromEntries(ids.map((id) => [id, false]));
  }
}

export const NAV_TAB_PRESETS: Record<NavPresetKey, Record<string, boolean>> = {
  alltabs: buildPresetMap("alltabs"),
  research: buildPresetMap("research"),
  trading: buildPresetMap("trading"),
  payment: buildPresetMap("payment"),
  marketing: buildPresetMap("marketing"),
  platform: buildPresetMap("platform"),
  minimal: buildPresetMap("minimal"),
  none: buildPresetMap("none"),
};

export function isNavPresetKey(value: unknown): value is NavPresetKey {
  return (
    typeof value === "string" &&
    (NAV_PRESET_KEYS as string[]).includes(value)
  );
}

/**
 * The preset a complete map exactly matches, or null for a custom
 * selection. Compared over the config ids only.
 */
export function derivePresetKey(
  tabs: Record<string, boolean>,
): NavPresetKey | null {
  for (const key of NAV_PRESET_KEYS) {
    const preset = NAV_TAB_PRESETS[key];
    if (leftNavConfigIds().every((id) => tabs[id] === preset[id])) {
      return key;
    }
  }
  return null;
}

/**
 * Complete a persisted visible-tabs map over the current config ids.
 * Missing ids fill from the saved preset when it is valid — and from
 * `none` when every saved entry is false, so a legacy deselect-all
 * (written before the preset key existed) never resurrects tabs with
 * the alltabs default. Never-saved (`null`) starts at alltabs.
 */
export function completeVisibleTabs(
  saved?: Record<string, boolean> | null,
  savedPreset?: string | null,
): Record<string, boolean> {
  const ids = leftNavConfigIds();
  if (!saved) return { ...NAV_TAB_PRESETS.alltabs };
  const present = ids.filter((id) => id in saved);
  const allPresentFalse =
    present.length > 0 && present.every((id) => saved[id] === false);
  const base = allPresentFalse
    ? NAV_TAB_PRESETS.none
    : isNavPresetKey(savedPreset)
      ? NAV_TAB_PRESETS[savedPreset]
      : NAV_TAB_PRESETS.alltabs;
  const out: Record<string, boolean> = {};
  for (const id of ids) {
    out[id] = id in saved ? saved[id] === true : base[id];
  }
  return out;
}

/**
 * #6151 S2 — expand any preset key into the full availability map
 * (every id enumerateNavAvailabilityIds() yields). A top-level id
 * reads the preset map; a sub-item key `<parent>:<sub>` follows its
 * parent (sub-items derive from the parent until #6147 S6 adds
 * per-sub-item toggles — the same rule as mergeVisibleTabs). An
 * unknown key falls back to `alltabs`: availability is a UX
 * narrowing, never an authorization gate, so the permissive
 * fallback keeps the surface working.
 */
export function expandPresetKey(key: string): Record<string, boolean> {
  const map = isNavPresetKey(key) ? NAV_TAB_PRESETS[key] : NAV_TAB_PRESETS.alltabs;
  const out: Record<string, boolean> = {};
  for (const id of enumerateNavAvailabilityIds()) {
    if (id.includes(":")) {
      const parent = id.slice(0, id.indexOf(":"));
      out[id] = map[parent] === true;
    } else {
      out[id] = map[id] === true;
    }
  }
  return out;
}
