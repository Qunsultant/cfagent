/**
 * Route table (#1804 S1, issue #1808) — the single source of truth for
 * navigation. The table data lives in nav-config.json (issue #2977);
 * every left-nav page registers ONCE there; the nav items,
 * breadcrumbs, active states, and visibility defaults are all derived
 * from this table (see NavigationMenu.tsx and Chat.tsx).
 *
 * Shape of an entry:
 * - `id` is the tab id carried in the URL (`?tab=<id>`). All 36 ids Chat
 *   has ever used are entries, including the six legacy/alias ids
 *   (trading, orders, scanner, reports, schedules, options) that never
 *   render as nav items but still land on a page. Issue #2596 added
 *   the 33rd id, "options-screener", as a real nav entry (navOrder 26).
 *   Platform Admin was added as the 34th id (navOrder 27) as a real page.
 *   Products was added as the 35th id (navOrder 28) as a real page.
 *   Billing was added as the 36th id (navOrder 29) as a real page.
 *   Issue #4530 retired the Products route into the Product Hub, which
 *   took its navOrder 28 slot as the 37th id.
 * - `navEntry` is present only for the 30 entries that render in the nav.
 *   Its `navOrder` reproduces the historical sidebar/top-strip order, so
 *   deriving NAVIGATION_ITEMS from this table changes nothing visible.
 * - `navGroup` is the nav entry highlighted when this tab is active. It
 *   replaces `isTabActive`'s hand-coded groups: trading highlights
 *   autopilot, orders highlights order, and the four hub children
 *   highlight screeners.
 * - `crumb` is the breadcrumb label, which differs from the nav label on
 *   13 entries (e.g. nav "Autopilot Control" vs crumb "Autopilot").
 *
 * The retention flag IS in this table since #2077: trading ids carry
 * `retain: true` and chat/types.ts derives TRADING_TABS from it, so the
 * hub's retained set cannot drift from the route table (see #388).
 * The component map itself lives as TAB_CONTENT in Chat.tsx (#2077):
 * the six stateful inline tabs still own Chat-local state, so their
 * content definitions stay with that state until they are extracted
 * into components; the switch over them is already one table-keyed
 * lookup pinned against this table. The table stays sorted
 * alphabetically by id so concurrent additions land at different
 * positions instead of one prepend anchor (the CHANGELOG lesson).
 */
import navConfigData from "./nav-config.json";

export type RouteCategory = "Execution" | "Intelligence" | "Playbooks" | "Platform" | "Billing" | "Marketing";

export type RouteBadgeType = "pro" | "live" | "ai" | "mcp" | "new" | "neutral";

export interface NavEntryMeta {
  label: string;
  shortLabel: string;
  /** Display order in the nav (0-based, unique across nav entries). */
  navOrder: number;
  defaultVisible: boolean;
  badge?: string;
  badgeType?: RouteBadgeType;
}

export interface RouteDef {
  id: string;
  /**
   * Retained in the always-mounted trading hub (hidden when inactive),
   * instead of a TAB_CONTENT entry (#2077). The hub owns these ids'
   * sub-tab mapping; the table is the single source of truth for the set.
   */
  retain?: boolean;
  /**
   * Retained shell page (#2149): rendered from SHELL_CONTENT mounted-hidden
   * when inactive, instead of a TAB_CONTENT entry. Deliberately NOT `retain`:
   * TRADING_TABS derives from `retain`, so a `retain` flag here would route
   * the page to the trading hub. Shell retention is the same mounted-hidden
   * idea, applied to standalone pages.
   */
  shellRetain?: boolean;
  /** Nav entry highlighted when this tab is active. */
  navGroup: string;
  /** Breadcrumb label. */
  crumb: string;
  category: RouteCategory;
  /** NavIcons key, resolved by NavigationMenu. */
  icon: string;
  description: string;
  /** Present only for entries that render in the nav. */
  navEntry?: NavEntryMeta;
}

export type Route = RouteDef & ({ navEntry: NavEntryMeta } | { navEntry?: undefined });

/**
 * Route table data lives in nav-config.json (issue #2977). This module
 * loads it and derives the route helpers; edit the data file, not this
 * module, to add, rename, reorder, or hide a route.
 */
export const ROUTES: Route[] = navConfigData.routes as unknown as Route[];

export type RouteId = Route["id"];

const ROUTE_MAP: ReadonlyMap<string, Route> = new Map(ROUTES.map((r) => [r.id, r]));

/**
 * Type guard for entries that render in the nav. (Needed because the
 * table is a literal union: members without navEntry lack the property
 * entirely, so a plain `r.navEntry !== undefined` does not typecheck.)
 */
export function hasNavEntry(r: Route): r is Extract<Route, { navEntry: NavEntryMeta }> {
  return "navEntry" in r;
}

export function getRoute(id: string): Route | undefined {
  return ROUTE_MAP.get(id);
}

/** Unknown or missing tab ids fall back to autopilot (the historical default). */
export function resolveRouteId(id: string): RouteId {
  return ROUTE_MAP.has(id) ? (id as RouteId) : "autopilot";
}

/** Breadcrumb label for a tab; unknown ids read as "Revenue" (the historical ternary default). */
export function getCrumb(id: string): string {
  return getRoute(id)?.crumb ?? "Revenue";
}

/** Nav entry highlighted when `id` is active (alias ids highlight their group). */
export function getNavGroup(id: string): string {
  return getRoute(id)?.navGroup ?? "autopilot";
}

/** Visibility defaults, derived: every nav entry defaults to visible. */
export const DEFAULT_VISIBLE_NAV_TABS: Record<string, boolean> = Object.fromEntries(
  ROUTES.filter(hasNavEntry).map((r) => [r.id, r.navEntry.defaultVisible]),
);
