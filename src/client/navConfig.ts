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
      id: "research",
      label: "Market Research",
      shortLabel: "Research",
      icon: "Research",
      badge: "Feed",
      badgeType: "new",
      description: "Zero-credential Yahoo Finance and Alpaca dual feed, fundamental peer comparison",
    },
  ],
  "options-screener": [
    {
      id: "options",
      label: "Contract Screen",
      shortLabel: "Contracts",
      icon: "Contracts",
      badge: "Contracts",
      badgeType: "ai",
      description: "Raw options contracts screener, hosted in the options hub",
    },
    {
      id: "scanner",
      label: "Strategy Scanner",
      shortLabel: "Scanner",
      icon: "StrategyScan",
      badge: "Scan",
      badgeType: "mcp",
      description: "Pattern matching, technical breakout, and momentum scans",
    },
    {
      id: "options-flows",
      label: "Options Flows",
      shortLabel: "Flows",
      icon: "Flows",
      badge: "Flows",
      badgeType: "live",
      description: "Institutional block trades, sweeps, and dark pool prints",
    },
    {
      id: "iv-history",
      label: "IV History & Volatility",
      shortLabel: "IV",
      icon: "Volatility",
      badge: "IV",
      badgeType: "neutral",
      description: "Historical and implied volatility percentile ranks",
    },
  ],
  "workflow-runs": [
    {
      id: "docs",
      label: "Reports & Docs",
      shortLabel: "Docs",
      icon: "Docs",
      badge: "Docs",
      badgeType: "pro",
      description: "Generated options and stock reports with PDF/XLSX/CSV downloads",
    },
    {
      id: "workflow-runs",
      label: "Workflow Runs",
      shortLabel: "Runs",
      icon: "Runs",
      badge: "Runs",
      badgeType: "neutral",
      description: "Every recorded workflow run with its stages and artifacts",
    },
    {
      id: "reports",
      label: "Screener Reports",
      shortLabel: "Reports",
      icon: "Reports",
      badge: "Reports",
      badgeType: "pro",
      description: "Comprehensive market screener reports and run details",
    },
    {
      id: "review",
      label: "Proposal Review",
      shortLabel: "Review",
      icon: "Review",
      badge: "Review",
      badgeType: "ai",
      description: "Autonomous proposal evaluation and human-in-the-loop approvals",
    },
    {
      id: "track-record",
      label: "Track Record",
      shortLabel: "Record",
      icon: "TrackRecord",
      badge: "Track",
      badgeType: "pro",
      description: "Recommendation track record, hit rates, and historical outcomes",
    },
  ],
  agents: [
    {
      id: "agents",
      label: "Agent Mesh Registry",
      shortLabel: "Agents",
      icon: "Agents",
      badge: "Mesh",
      badgeType: "ai",
      description: "Autonomous agents, capabilities, heartbeats, and peer delegations",
    },
    {
      id: "endpoints",
      label: "API Endpoints",
      shortLabel: "Endpoints",
      icon: "Endpoints",
      badge: "MCP",
      badgeType: "mcp",
      description: "Model Context Protocol tools, OpenAPI schemas, and server endpoints",
    },
  ],
  "platform-admin": PLATFORM_ADMIN_NAV_ITEMS.map((item) => ({
    id: item.id,
    label: item.label,
    shortLabel: item.shortLabel,
    icon: "Settings",
    description: item.description,
  })),
  sandbox: [
    {
      id: "payment-assurance",
      label: "Payment Assurance",
      shortLabel: "Assurance",
      icon: "Assurance",
      badge: "Test",
      badgeType: "neutral",
      description: "Live & simulation payment assurance test suite",
    },
    {
      id: "sandbox-checkout",
      label: "Checkout sandbox",
      shortLabel: "Sandbox",
      icon: "Checkout",
      badge: "Demo",
      badgeType: "pro",
      description: "Demo checkout terminal (public sandbox page)",
    },
  ],
};

const SECTION_METADATA: { category: RouteCategory; title: string; id: string }[] = [
  { category: "Execution", title: "TRADING & EXECUTION", id: "section-execution" },
  { category: "Intelligence", title: "INTELLIGENCE & COPILOT", id: "section-intelligence" },
  { category: "Playbooks", title: "WORKFLOWS", id: "section-workflows" },
  { category: "Marketing", title: "MARKETING", id: "section-marketing" },
  { category: "Billing", title: "BILLING", id: "section-billing" },
  { category: "Platform", title: "PLATFORM", id: "section-platform" },
];

/** Id of the left-nav item that hosts the Platform Admin sub-menu. */
export const PLATFORM_ADMIN_NAV_ID = "platform-admin";

/** Id of the left-nav item that links the demo checkout sandbox page. */
export const SANDBOX_NAV_ID = "sandbox-checkout";

/**
 * Returns the page path for sandbox nav ids, undefined for everything else.
 */
export function sandboxNavHrefFromNavId(id: string): string | undefined {
  return id === SANDBOX_NAV_ID ? "/checkout/sandbox" : undefined;
}

/** Items whose primary navigation home is inside a sub-menu, so they do not repeat as top-level main items */
const SUB_MENU_HOSTED_IDS = new Set([
  "options-flows",
  "research",
  "docs",
  "payment-assurance",
  "endpoints",
  PLATFORM_ADMIN_NAV_ID,
]);

export function buildDefaultLeftNavConfig(): LeftNavConfig {
  const navRoutes = ROUTES.filter(hasNavEntry).sort(
    (a, b) => a.navEntry.navOrder - b.navEntry.navOrder
  );

  const sections: NavSectionConfig[] = SECTION_METADATA.map((sec) => {
    const items: NavMenuItemConfig[] = navRoutes
      .filter((r) => r.category === sec.category && !SUB_MENU_HOSTED_IDS.has(r.id))
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

    // Add Goal Screen to Intelligence section directly under Options Screener and above Chat
    if (sec.id === "section-intelligence") {
      const chatIndex = items.findIndex((i) => i.id === "chat");
      const insertAt = chatIndex !== -1 ? chatIndex : 2;
      items.splice(insertAt, 0, {
        id: "goal-screen",
        label: "Goal Screen",
        shortLabel: "Goal",
        category: "Intelligence",
        icon: "Goal",
        badge: "Goal",
        badgeType: "ai",
        description: "Goal-driven screening flow with AI-orchestrated criteria",
      });
    }

    // Add Platform Admin to Platform section
    if (sec.id === "section-platform") {
      items.unshift({
        id: PLATFORM_ADMIN_NAV_ID,
        label: "Platform Admin",
        shortLabel: "Admin",
        category: "Platform",
        icon: "Settings",
        badge: "Admin",
        badgeType: "pro",
        description: "Ads, tasks, keys, providers & IAAA",
        subItems: PLATFORM_ADMIN_NAV_ITEMS,
      });
    }

    return {
      id: sec.id,
      title: sec.title,
      category: sec.category,
      items,
    };
  });

  // Dedicated Sandbox section
  sections.push({
    id: "section-sandbox",
    title: "SANDBOX",
    category: "Platform",
    items: [
      {
        id: "sandbox",
        label: "Sandbox",
        shortLabel: "Sandbox",
        category: "Platform",
        icon: "Checkout",
        description: "Payment assurance and demo checkout sandbox",
        subItems: SUB_MENU_CONFIGS.sandbox,
      },
    ],
  });

  return { sections };
}

/** Sub-item ids are `platform-admin:<section>`; the nav shell routes them to the drawer or tab view. */
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
      if (item.subItems) {
        for (const sub of item.subItems) {
          if (sub.id === id) {
            return {
              id: sub.id,
              label: sub.label,
              shortLabel: sub.shortLabel,
              category: section.category,
              icon: sub.icon || item.icon,
              badge: sub.badge,
              badgeType: sub.badgeType,
              description: sub.description || "",
            };
          }
        }
      }
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
  if (item.id === "goal-screen") {
    if (typeof window !== "undefined") {
      const view = new URLSearchParams(window.location.search).get("view");
      return currentTab === "screeners" && view === "goal-screen";
    }
    return false;
  }
  if (item.id === "screeners") {
    if (typeof window !== "undefined") {
      const view = new URLSearchParams(window.location.search).get("view");
      if (view === "goal-screen") return false;
    }
  }
  if (getNavGroup(currentTab) === item.id) return true;
  if (item.subItems) {
    return item.subItems.some((sub) => {
      if (sub.id === currentTab) return true;
      if (getNavGroup(currentTab) === sub.id) return true;
      if (typeof window !== "undefined") {
        const view = new URLSearchParams(window.location.search).get("view");
        if (currentTab === "screeners" && view === sub.id) return true;
      }
      return false;
    });
  }
  return false;
}
