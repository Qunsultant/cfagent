/**
 * Deep-link catalog (#2776) — every left-nav node maps to a shareable URL.
 *
 * Follows the externalized-menu idiom (#2529 navConfig.ts, #2624
 * platformAdminConfig.ts): navigation is DATA, components stay layout-only.
 * To add or change a link, edit DEEP_LINK_OVERRIDES below — not the nav
 * components. Nodes without an override resolve by rule:
 * - `platform-admin:<section>` ids → ?tab=platform-admin&view=<section>
 *   (same destination as today's `?tab=platform-admin:<section>` parse);
 * - every other id → ?tab=<id>, with unknown ids falling back to autopilot
 *   via resolveRouteId, exactly like today's unknown-tab behavior.
 *
 * The catalog is keyed by nav-node key, not bare id: the top-level
 * `stock-hub` item and the `screeners` sub-item under it are different
 * nodes with different links (?tab=stock-hub vs ?tab=stock-hub&view=stocks).
 */
import {
  DEFAULT_LEFT_NAV_CONFIG,
  platformAdminSectionFromNavId,
  type LeftNavConfig,
  type NavMenuItemConfig,
  type NavSubMenuItemConfig,
} from "./navConfig";
import { navigateToTab } from "./router";
import { resolveRouteId, type RouteId } from "./routes";
import { SCREENER_HUB_TABS } from "./ScreenersHub";
import { STOCK_HUB_TABS } from "./StockHub";
import { OPTIONS_HUB_TABS } from "./OptionsHub";

export type DeepLink =
  | { tab: RouteId; view?: string; params?: Record<string, string> }
  | { href: string; newTab?: boolean };

/**
 * The editable surface: nodes whose link differs from the default rule.
 * Everything else in the nav resolves by rule, so this table stays small
 * and every entry here documents a real behavioral special case (today's
 * hardcoded branches in LeftNavBar.handleItemClick/handleSubItemClick).
 */
export const DEEP_LINK_OVERRIDES: Record<string, DeepLink> = {
  // Top-level specials.
  // Issue #2970: Goal Screen's own page — the Intelligence menu item
  // links here now; the hub tab stays until #2971 (its keyed
  // assets-hub:goal-screen override below still lands on the hub).
  "goal-screen": { tab: "goal-screen" },
  sandbox: { href: "/checkout/sandbox", newTab: true },
  // Bare sandbox-checkout id (NavigationMenu path) shares the sub-item's
  // link; the resolver falls back to the bare id when no parent:key entry
  // exists, so both paths resolve identically.
  "sandbox-checkout": { href: "/checkout/sandbox", newTab: true },
  // Stock Hub views: sub-items that live under ?tab=stock-hub.
  "stock-hub:new-screen": { tab: "stock-hub", view: "new-screen" },
  "stock-hub:screeners": { tab: "stock-hub", view: "stocks" },
  "stock-hub:research": { tab: "stock-hub", view: "research" },
  "stock-hub:patterns": { tab: "stock-hub", view: "patterns" },
  "stock-hub:presets": { tab: "stock-hub", view: "presets" },
  // Assets Hub views: sub-items that live under ?tab=assets-hub.
  "assets-hub:forex": { tab: "assets-hub", view: "forex" },
  "assets-hub:futures": { tab: "assets-hub", view: "futures" },
  "assets-hub:commodities": { tab: "assets-hub", view: "commodities" },
  "assets-hub:bonds": { tab: "assets-hub", view: "bonds" },
  "assets-hub:goal-screen": { tab: "assets-hub", view: "goal-screen" },
  "assets-hub:reports": { tab: "assets-hub", view: "reports" },
  "assets-hub:schedules": { tab: "assets-hub", view: "schedules" },
  "assets-hub:review": { tab: "assets-hub", view: "review" },
  "assets-hub:track-record": { tab: "assets-hub", view: "track-record" },
  // Options copy hub (issue #2954): the options-screener subs link to
  // the copy hub's tabs. Discovery and Strategy Panel share the
  // strategy-discovery tab and differ by the discoveryView param
  // (Discovery Scanner vs Builder / Payoff Analyzer).
  "options-screener:strategy-scanner": { tab: "options", view: "strategy-scanner" },
  "options-screener:options-runs": { tab: "options", view: "options-runs" },
  "options-screener:discovery": { tab: "options", view: "strategy-discovery", params: { discoveryView: "discovery" } },
  "options-screener:strategy-panel": { tab: "options", view: "strategy-discovery", params: { discoveryView: "builder" } },
  "options-screener:contracts-screener": { tab: "options", view: "contracts-screener" },
  "options-screener:custom-thesis": { tab: "options", view: "custom-thesis" },
  "options-screener:nlq-options": { tab: "options", view: "nlq-options" },
  "options-screener:ai-strategy-ideas": { tab: "options", view: "ai-strategy-ideas" },
  "options-screener:scheduled-screening": { tab: "options", view: "scheduled-screening" },
  "options-screener:iv-history": { tab: "options", view: "iv-history" },
  "options-screener:options-flows": { tab: "options", view: "options-flows" },
  // Best Trade keeps its page, as it does today: the legacy research
  // param lands on the copy hub's custom-thesis tab via the hub's
  // legacy mapping.
  "options-screener:best-trade": { tab: "options", params: { research: "best-trade" } },
  // Issue #2970: Review and Track Record's own pages — the Workflow
  // Runs submenu items link here now; the hub tabs stay until #2971
  // (their keyed assets-hub:* overrides below still land on the hub).
  "workflow-runs:review": { tab: "review" },
  "workflow-runs:track-record": { tab: "track-record" },
  // Planned menu (issue #2783): subs link to their hub views. The
  // parent links to its first sub; the parent itself renders as a
  // toggle-only button in the sidebar, never as a link.
  planned: { tab: "assets-hub", view: "forex" },
  "planned:forex": { tab: "assets-hub", view: "forex" },
  "planned:futures": { tab: "assets-hub", view: "futures" },
  "planned:commodities": { tab: "assets-hub", view: "commodities" },
  "planned:bonds": { tab: "assets-hub", view: "bonds" },
};

/** Catalog key for a nav node: bare id for top-level items, parent:id for subs. */
export function navNodeKey(parentId: string | null, id: string): string {
  return parentId ? `${parentId}:${id}` : id;
}

/** Deep link for one nav node: parent:key override, then bare-id override,
 *  then the default rules. */
export function deepLinkForNavNode(parentId: string | null, id: string): DeepLink {
  const keyed = DEEP_LINK_OVERRIDES[navNodeKey(parentId, id)];
  if (keyed) return keyed;
  if (parentId !== null) {
    const bare = DEEP_LINK_OVERRIDES[id];
    if (bare) return bare;
  }
  const section = platformAdminSectionFromNavId(id);
  if (section) return { tab: "platform-admin", view: section };
  return { tab: resolveRouteId(id) };
}

/** URL string for a deep link: query form for tabs, absolute path otherwise. */
export function deepLinkHref(link: DeepLink): string {
  if ("href" in link) return link.href;
  const params = new URLSearchParams();
  params.set("tab", link.tab);
  if (link.view) params.set("view", link.view);
  if (link.params) {
    for (const [key, value] of Object.entries(link.params)) params.set(key, value);
  }
  return `?${params.toString()}`;
}

/** URL string for one nav node. */
export function deepLinkHrefForNavNode(parentId: string | null, id: string): string {
  return deepLinkHref(deepLinkForNavNode(parentId, id));
}

/** Follow a deep link: SPA navigation for tabs, page navigation for hrefs. */
export function navigateToDeepLink(link: DeepLink): void {
  if (typeof window === "undefined") return;
  if ("href" in link) {
    if (link.newTab) window.open(link.href, "_blank", "noopener");
    else window.location.href = link.href;
    return;
  }
  navigateToTab(link.tab, link.view, link.params);
}

export interface DeepLinkCatalogEntry {
  parentId: string | null;
  id: string;
  key: string;
  link: DeepLink;
  href: string;
}

type NavNodeLike = {
  id: string;
  subItems?: NavSubMenuItemConfig[] | NavMenuItemConfig["subItems"];
};

/** Every node in a nav config, each with its resolved deep link. */
export function buildDeepLinkCatalog(
  config: LeftNavConfig = DEFAULT_LEFT_NAV_CONFIG,
): DeepLinkCatalogEntry[] {
  const entries: DeepLinkCatalogEntry[] = [];
  const walk = (parentId: string | null, nodes: NavNodeLike[]) => {
    for (const node of nodes) {
      const link = deepLinkForNavNode(parentId, node.id);
      entries.push({
        parentId,
        id: node.id,
        key: navNodeKey(parentId, node.id),
        link,
        href: deepLinkHref(link),
      });
      if (node.subItems && node.subItems.length > 0) {
        walk(node.id, node.subItems as NavNodeLike[]);
      }
    }
  };
  for (const section of config.sections) {
    walk(null, section.items);
  }
  return entries;
}

/** The default catalog, built from the default left-nav config. */
export const DEEP_LINK_CATALOG: DeepLinkCatalogEntry[] = buildDeepLinkCatalog();

// ---------------------------------------------------------------------------
// In-page tab surfaces (#2776, expanded scope: nothing is excluded).
//
// A surface tab link is page + param + value. The canonical param is `view`
// wherever the surface already syncs through it (the established
// useUrlSyncedTabs convention); surfaces wired by this issue get a distinct
// `<surface>Tab` param so they can never collide with an outer tab system
// on the same page (Iaaa inside the admin page, Reports inside the hub).
// Keys are (surface, param, value) — never a bare tab id — so `ads` on
// RevenueTab, `ads` as a route, and AdsTab's own tabs never collide.
// ---------------------------------------------------------------------------

export interface SurfaceTabDef {
  /** Surface id, e.g. "payments", "iaaa-admin", "risk-analysis". */
  surface: string;
  /** Host page tab; null when host-dependent (modals open from many pages). */
  page: RouteId | null;
  /** Host page's view value when the surface lives under a view. */
  pageView?: string;
  /** Canonical query param for this surface's tabs. */
  param: string;
  /** Every tab id on the surface. */
  values: readonly string[];
}

/**
 * The editable surface-tab data. Already-synced surfaces keep their
 * existing param (`view`); newly wired surfaces get a distinct param.
 * The modal surface has no fixed page: its href is built with the host
 * page at link time (see surfaceTabHref).
 */
export const SURFACE_TAB_DEFS: SurfaceTabDef[] = [
  { surface: "screeners-hub", page: "screeners", param: "view", values: SCREENER_HUB_TABS },
  { surface: "stock-hub", page: "stock-hub", param: "view", values: STOCK_HUB_TABS },
  {
    surface: "options-hub",
    page: "options",
    param: "view",
    values: OPTIONS_HUB_TABS,
  },
  {
    surface: "platform-admin",
    page: "platform-admin",
    param: "view",
    values: [
      "ads",
      "background-tasks",
      "scheduled-goals",
      "provenance",
      "api-keys",
      "data-providers",
      "iaaa-admin",
      "admin-access",
    ],
  },
  {
    surface: "payments",
    page: "payments",
    param: "view",
    values: ["create", "gateways", "ledger", "stats", "wallet"],
  },
  {
    surface: "social",
    page: "social",
    param: "view",
    values: ["approvals", "brief", "goal", "posts", "tokens"],
  },
  { surface: "ads", page: "ads", param: "view", values: ["offers", "submit"] },
  {
    surface: "referrals",
    page: "referrals",
    param: "view",
    values: ["activity", "community", "links", "share"],
  },
  {
    surface: "revenue",
    page: "revenue",
    param: "view",
    values: ["ads", "categories", "metrics", "placements", "schemas"],
  },
  {
    surface: "workflows",
    page: "workflows",
    param: "view",
    values: ["faq", "workflows", "decisioning", "matrix", "improvements"],
  },
  { surface: "checkout", page: "checkout", param: "checkoutTab", values: ["pay", "subscriptions"] },
  {
    surface: "iaaa-admin",
    page: "platform-admin",
    pageView: "iaaa-admin",
    param: "iaaaTab",
    values: ["overview", "members", "api", "mcp", "iaaa", "correlations", "queue"],
  },
  {
    surface: "reports-panel",
    page: "screeners",
    pageView: "reports",
    param: "reportsTab",
    values: ["reports", "ideas", "track"],
  },
  {
    surface: "risk-analysis",
    page: null,
    param: "riskTab",
    values: ["anatomy", "playbook", "scenarios", "ai"],
  },
];

export interface SurfaceTabEntry {
  surface: string;
  page: RouteId | null;
  pageView?: string;
  param: string;
  value: string;
  key: string;
  href: string;
}

/** Href for one surface tab. Host-dependent surfaces need their page. */
export function surfaceTabHref(
  def: SurfaceTabDef,
  value: string,
  pageOverride?: RouteId,
): string {
  const page = pageOverride ?? def.page;
  const params = new URLSearchParams();
  if (page) params.set("tab", page);
  if (def.pageView) params.set("view", def.pageView);
  params.set(def.param, value);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

/** Every surface tab, each with its href (host pages filled in where fixed). */
export function buildSurfaceTabCatalog(): SurfaceTabEntry[] {
  const entries: SurfaceTabEntry[] = [];
  for (const def of SURFACE_TAB_DEFS) {
    for (const value of def.values) {
      entries.push({
        surface: def.surface,
        page: def.page,
        pageView: def.pageView,
        param: def.param,
        value,
        key: `${def.surface}:${def.param}:${value}`,
        href: surfaceTabHref(def, value),
      });
    }
  }
  return entries;
}

export const SURFACE_TAB_CATALOG: SurfaceTabEntry[] = buildSurfaceTabCatalog();
