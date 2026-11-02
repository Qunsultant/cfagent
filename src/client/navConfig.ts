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
      id: "new-screen",
      label: "Run a new screen",
      shortLabel: "Run",
      icon: "Screeners",
      badge: "New",
      badgeType: "ai",
      description: "Execute a manual multi-factor stock screener with customizable criteria and filters",
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
    {
      id: "goal-screen",
      label: "Goal Screen",
      shortLabel: "Goal",
      icon: "Goal",
      badge: "AI",
      badgeType: "ai",
      description: "Pick a goal; the unified screening stack screens stocks and options for it, with backtest-on-screen",
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
    {
      id: "discovery",
      label: "Discovery",
      shortLabel: "Discovery",
      icon: "Research",
      badge: "Runs",
      badgeType: "neutral",
      description: "Scheduled and manual discovery runs and their reports",
    },
    {
      id: "strategy-panel",
      label: "Strategy Panel",
      shortLabel: "Strategy",
      icon: "StrategyScan",
      badge: "Strategy",
      badgeType: "ai",
      description: "Strategy discovery and ranking for a symbol or universe",
    },
    {
      id: "best-trade",
      label: "Best Trade",
      shortLabel: "Best",
      icon: "Goal",
      badge: "Best",
      badgeType: "pro",
      description: "The single best trade for a name, plus alternatives",
    },
    {
      id: "compare",
      label: "Compare",
      shortLabel: "Compare",
      icon: "Review",
      badge: "Compare",
      badgeType: "ai",
      description: "Side-by-side comparison of candidate strategies, quant vs AI and across generators",
    },
    {
      id: "llm-ideas",
      label: "LLM Ideas",
      shortLabel: "LLM",
      icon: "Copilot",
      badge: "LLM",
      badgeType: "ai",
      description: "LLM evaluation of quantitative candidates",
    },
    {
      id: "llm-evaluate",
      label: "LLM Evaluate",
      shortLabel: "Eval",
      icon: "Audit",
      badge: "Eval",
      badgeType: "mcp",
      description: "LLM evaluation of one chosen strategy, from the discovery list",
    },
    {
      id: "run-records",
      label: "Run Records",
      shortLabel: "Records",
      icon: "Runs",
      badge: "Runs",
      badgeType: "neutral",
      description: "The options run record: scheduled and manual discovery runs, the screening activity log, and the schedules pointer",
    },
    {
      id: "nlq",
      label: "NLQ",
      shortLabel: "NLQ",
      icon: "Search",
      badge: "NLQ",
      badgeType: "neutral",
      description: "Natural-language options screen: describe the trade and scan underlyings for it",
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
      id: "workflows",
      label: "Workflows & FAQ",
      shortLabel: "Guides",
      icon: "Guides",
      badge: "14 Guides",
      badgeType: "neutral",
      description: "Platform architecture guides, strategy playbooks, order mechanics & FAQ",
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
    icon: item.icon ?? "Settings",
    description: item.description,
  })),
  sandbox: [
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
  // Issue #2783: Planned asset classes — valid hub views with no
  // provider adapter yet. Their links are catalog overrides
  // (planned:<id> → screeners view); their visibility is the
  // planned_asset_tabs flag, ON by default.
  planned: [
    {
      id: "forex",
      label: "Forex",
      shortLabel: "Forex",
      icon: "Screeners",
      badge: "Planned",
      badgeType: "neutral",
      description: "Screen foreign-exchange pairs — planned, no provider adapter yet",
    },
    {
      id: "futures",
      label: "Futures",
      shortLabel: "Futures",
      icon: "Screeners",
      badge: "Planned",
      badgeType: "neutral",
      description: "Screen futures contracts — planned, no provider adapter yet",
    },
    {
      id: "commodities",
      label: "Commodities",
      shortLabel: "Commodities",
      icon: "Screeners",
      badge: "Planned",
      badgeType: "neutral",
      description: "Screen commodities — planned, no provider adapter yet",
    },
    {
      id: "bonds",
      label: "Bonds",
      shortLabel: "Bonds",
      icon: "Screeners",
      badge: "Planned",
      badgeType: "neutral",
      description: "Screen bonds — planned, no provider adapter yet",
    },
  ],
};

const SECTION_METADATA: { category: RouteCategory; title: string; id: string }[] = [
  { category: "Execution", title: "TRADING & EXECUTION", id: "section-execution" },
  { category: "Intelligence", title: "INTELLIGENCE & COPILOT", id: "section-intelligence" },
  { category: "Playbooks", title: "WORKFLOWS", id: "section-workflows" },
  { category: "Marketing", title: "MARKETING", id: "section-marketing" },
  { category: "Billing", title: "BILLINGS/PAYMENTS", id: "section-billing" },
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
  "workflows",
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

      const workflowsIndex = items.findIndex((i) => i.id === "workflows");
      const insertAt = workflowsIndex !== -1 ? workflowsIndex : items.length;
      items.splice(insertAt, 0, {
        id: "schedules",
        label: "Schedules",
        shortLabel: "Schedules",
        category: "Platform",
        icon: "Schedules",
        badge: "Cron",
        badgeType: "neutral",
        description: "The one scheduling surface for screening runs — create, pause, and inspect scheduled jobs",
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
        icon: "Sandbox",
        description: "Payment assurance and demo checkout sandbox",
        subItems: SUB_MENU_CONFIGS.sandbox,
      },
    ],
  });

  // Dedicated Planned section (issue #2783): mirrors the Sandbox
  // section — a menu-only parent (no route) whose subs link to hub
  // views. Screening family, so the Intelligence category.
  sections.push({
    id: "section-planned",
    title: "PLANNED",
    category: "Intelligence",
    items: [
      {
        id: "planned",
        label: "Planned",
        shortLabel: "Planned",
        category: "Intelligence",
        icon: "Screeners",
        description:
          "Planned asset classes — forex, futures, commodities, and bonds (no provider adapters yet)",
        subItems: SUB_MENU_CONFIGS.planned,
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
  if (item.id === "schedules") {
    if (currentTab === "schedules") return true;
    if (typeof window !== "undefined") {
      const view = new URLSearchParams(window.location.search).get("view");
      return currentTab === "screeners" && (view === "schedules" || view === "schemas");
    }
  }
  if (item.id === "screeners") {
    if (typeof window !== "undefined") {
      const view = new URLSearchParams(window.location.search).get("view");
      if (view === "goal-screen" || view === "schedules" || view === "schemas") return false;
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
