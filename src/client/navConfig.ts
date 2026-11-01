import { ROUTES, hasNavEntry, getNavGroup, type RouteCategory, type RouteBadgeType, type NavEntryMeta } from "./routes";
import { PLATFORM_ADMIN_NAV_ITEMS } from "./platformAdminConfig";

export interface NavSubMenuItemConfig {
  id: string;
  label: string;
  shortLabel?: string;
  icon?: string;
  badge?: string;
  badgeType?: RouteBadgeType;
  description?: string;
  subItems?: NavSubMenuItemConfig[];
}

export interface NavMenuItemConfig {
  id: string;
  label: string;
  shortLabel?: string;
  category: RouteCategory;
  icon: string;
  badge?: string;
  badgeType?: RouteBadgeType;
  description: string;
  subItems?: NavSubMenuItemConfig[];
}

export interface NavSectionConfig {
  id: string;
  title: string;
  category: RouteCategory;
  items: NavMenuItemConfig[];
}

export interface LeftNavConfig {
  sections: NavSectionConfig[];
}

/**
 * Sub-menu configuration map for navigation items that contain sub-menus.
 * For example, Screeners provides choices for stocks and options.
 */
export const SUB_MENU_CONFIGS: Record<string, NavSubMenuItemConfig[]> = {
  screeners: [
    {
      id: "screeners",
      label: "Stock Screener",
      shortLabel: "Stocks",
      icon: "Screeners",
      badge: "Stocks",
      badgeType: "pro",
      description: "Multi-factor equity screener and fundamental valuation filters",
    },
    {
      id: "options",
      label: "Options Screener",
      shortLabel: "Options",
      icon: "Options",
      badge: "Options",
      badgeType: "ai",
      description: "Options chain, unusual activity, and Greeks scanner",
    },
    {
      id: "scanner",
      label: "Strategy Scanner",
      shortLabel: "Scanner",
      icon: "Scanner",
      badge: "Scan",
      badgeType: "mcp",
      description: "Pattern matching, technical breakout, and momentum scans",
    },
    {
      id: "options-flows",
      label: "Options Flows",
      shortLabel: "Flows",
      icon: "Options",
      badge: "Flows",
      badgeType: "live",
      description: "Institutional block trades, sweeps, and dark pool prints",
    },
    {
      id: "iv-history",
      label: "IV History & Volatility",
      shortLabel: "IV",
      icon: "Options",
      badge: "IV",
      badgeType: "neutral",
      description: "Historical and implied volatility percentile ranks",
    },
  ],
  /**
   * Issue #2596, slice 1: the Options Screener's own sub-menu. Every
   * entry is an existing tab id — nothing here is a new surface.
   * The sub-products with no tab of their own (strategy panel,
   * best-trade, compare, LLM ideas/evaluate, discovery, IV history
   * as a hub section, scheduled runs, settings) are aggregated on
   * the Options Screener page itself (OptionsScreenerPage), which
   * links to the tab that hosts each one. The Screeners sub-menu
   * above keeps its "options" entry: promotion adds a top-level
   * home, it does not remove the historical path.
   */
  "options-screener": [
    {
      id: "options",
      label: "Contract Screen",
      shortLabel: "Contracts",
      icon: "Options",
      badge: "Contracts",
      badgeType: "ai",
      description: "Raw options contracts screener, hosted in the options hub",
    },
    {
      id: "scanner",
      label: "Strategy Scanner",
      shortLabel: "Scanner",
      icon: "Scanner",
      badge: "Scan",
      badgeType: "mcp",
      description: "Pattern matching, technical breakout, and momentum scans",
    },
    {
      id: "options-flows",
      label: "Options Flows",
      shortLabel: "Flows",
      icon: "Options",
      badge: "Flows",
      badgeType: "live",
      description: "Institutional block trades, sweeps, and dark pool prints",
    },
    {
      id: "docs",
      label: "Reports & Docs",
      shortLabel: "Docs",
      icon: "Screeners",
      badge: "Docs",
      badgeType: "pro",
      description: "Generated options reports and run details for every run",
    },
    {
      id: "workflow-runs",
      label: "Workflow Runs",
      shortLabel: "Runs",
      icon: "Screeners",
      badge: "Runs",
      badgeType: "neutral",
      description: "Every recorded workflow run with its stages and artifacts",
    },
    {
      id: "schedules",
      label: "Schedules",
      shortLabel: "Schedules",
      icon: "Screeners",
      badge: "Schedules",
      badgeType: "pro",
      description: "Scheduled options runs and their schedules",
    },
  ],
};

const SECTION_METADATA: { category: RouteCategory; title: string; id: string }[] = [
  { category: "Execution", title: "TRADING & EXECUTION", id: "section-execution" },
  { category: "Intelligence", title: "INTELLIGENCE & COPILOT", id: "section-intelligence" },
  { category: "Playbooks", title: "PLAYBOOKS & TOOLS", id: "section-playbooks" },
  { category: "Platform", title: "PLATFORM & BILLING", id: "section-platform" },
];

/**
 * Builds the default externalized LeftNavConfig derived from the single-source-of-truth
 * route table and enhanced with sub-menu definitions.
 */
/** Id of the left-nav item that hosts the Platform Admin sub-menu. */
export const PLATFORM_ADMIN_NAV_ID = "platform-admin";

/** Id of the left-nav item that links the demo checkout sandbox page. */
export const SANDBOX_NAV_ID = "sandbox-checkout";

/**
 * Issue #2645: `sandbox-checkout` is a nav id, not a route — it links the
 * standalone server-rendered /checkout/sandbox page, which is not an SPA tab.
 * Returns the page path for sandbox nav ids, undefined for everything else.
 */
export function sandboxNavHrefFromNavId(id: string): string | undefined {
  return id === SANDBOX_NAV_ID ? "/checkout/sandbox" : undefined;
}

export function buildDefaultLeftNavConfig(): LeftNavConfig {
  const navRoutes = ROUTES.filter(hasNavEntry).sort(
    (a, b) => a.navEntry.navOrder - b.navEntry.navOrder
  );

  const sections: NavSectionConfig[] = SECTION_METADATA.map((sec) => {
    const items: NavMenuItemConfig[] = navRoutes
      .filter((r) => r.category === sec.category)
      .map((r) => {
        const meta: NavEntryMeta = r.navEntry;
        const subItems = SUB_MENU_CONFIGS[r.id];
        return {
          id: r.id,
          label: meta.label,
          shortLabel: meta.shortLabel,
          category: r.category,
          icon: r.icon,
          badge: meta.badge,
          badgeType: meta.badgeType,
          description: r.description,
          ...(subItems ? { subItems } : {}),
        };
      });

    return {
      id: sec.id,
      title: sec.title,
      category: sec.category,
      items,
    };
  });

  // Issue #2624: the administration surfaces are a left-nav destination with
  // their own sub-menu — the same shape as Screeners — not a settings button.
  // The item is not a route: selecting it (or a sub-item) opens the Platform
  // Admin drawer at that section; navigation.tsx intercepts the ids.
  sections.push({
    id: "section-platform-admin",
    title: "PLATFORM ADMIN",
    category: "Platform",
    items: [
      {
        id: PLATFORM_ADMIN_NAV_ID,
        label: "Platform Admin",
        shortLabel: "Admin",
        category: "Platform",
        icon: "Settings",
        description: "Ads, tasks, keys, providers & IAAA",
        subItems: PLATFORM_ADMIN_NAV_ITEMS,
      },
    ],
  });

  // Issue #2645: the demo pages are a left-nav destination with the same
  // shape as Platform Admin — a section whose items are nav ids, not
  // routes. The nav shell intercepts the sandbox id and opens the
  // standalone server page (see sandboxNavHrefFromNavId); the route
  // itself stays public and ungated per the owner's 2026-11-01 decision.
  sections.push({
    id: "section-sandbox",
    title: "SANDBOX",
    category: "Platform",
    items: [
      {
        id: SANDBOX_NAV_ID,
        label: "Checkout sandbox",
        shortLabel: "Sandbox",
        category: "Platform",
        icon: "Checkout",
        description: "Demo checkout terminal (public sandbox page)",
      },
    ],
  });

  return { sections };
}

/** Sub-item ids are `platform-admin:<section>`; the nav shell routes them to the drawer. */
export function platformAdminSectionFromNavId(id: string): string | undefined {
  if (id === PLATFORM_ADMIN_NAV_ID) return "ads";
  const prefix = `${PLATFORM_ADMIN_NAV_ID}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}

export const DEFAULT_LEFT_NAV_CONFIG: LeftNavConfig = buildDefaultLeftNavConfig();

/**
 * Find a menu item within a LeftNavConfig by id.
 */
export function findNavItemConfig(
  config: LeftNavConfig,
  id: string
): NavMenuItemConfig | undefined {
  for (const section of config.sections) {
    for (const item of section.items) {
      if (item.id === id) return item;
    }
  }
  return undefined;
}

/**
 * Check if a menu item or any of its sub-items matches the current active tab.
 */
export function isNavItemOrSubItemActive(
  item: NavMenuItemConfig,
  currentTab: string
): boolean {
  if (item.id === currentTab) return true;
  if (getNavGroup(currentTab) === item.id) return true;
  if (item.subItems) {
    return item.subItems.some(
      (sub) => sub.id === currentTab || getNavGroup(currentTab) === sub.id
    );
  }
  return false;
}

