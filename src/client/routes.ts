/**
 * Route table (#1804 S1, issue #1808) — the single source of truth for
 * navigation. Every left-nav page registers ONCE here; the nav items,
 * breadcrumbs, active states, and visibility defaults are all derived
 * from this table (see NavigationMenu.tsx and Chat.tsx).
 *
 * Shape of an entry:
 * - `id` is the tab id carried in the URL (`?tab=<id>`). All 33 ids Chat
 *   has ever used are entries, including the six legacy/alias ids
 *   (trading, orders, scanner, reports, schedules, options) that never
 *   render as nav items but still land on a page. Issue #2596 added
 *   the 33rd id, "options-screener", as a real nav entry (navOrder 26).
 * - `navEntry` is present only for the 27 entries that render in the nav.
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
export type RouteCategory = "Execution" | "Intelligence" | "Playbooks" | "Platform";

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

const SCREENERS_DESC =
  "The one screening hub: stock + options screening, the strategy scanner, IV history, goal screens, reports, schedules, proposal review, and the recommendation track record";

export const ROUTES = [
  {
    id: "ads",
    shellRetain: true,
    navGroup: "ads",
    crumb: "Marketplace",
    category: "Platform",
    icon: "Ads",
    description: "Curated partner marketplace, developer sponsorships, and deal feed",
    navEntry: {
      label: "Sponsored Marketplace",
      shortLabel: "Deals",
      navOrder: 18,
      defaultVisible: true,
      badge: "Partners",
      badgeType: "neutral",
    },
  },
  {
    id: "agents",
    navGroup: "agents",
    crumb: "Agents",
    category: "Platform",
    icon: "Agents",
    description:
      "The agent fleet as the G0 registry records it: every class, its bindings, doors and gates, identity and credential posture, and the honest degraded/absent records",
    navEntry: {
      label: "Agents",
      shortLabel: "Agents",
      navOrder: 25,
      defaultVisible: true,
      badge: "Registry",
      badgeType: "neutral",
    },
  },
  {
    id: "approvals",
    navGroup: "approvals",
    crumb: "Approvals",
    category: "Execution",
    icon: "Approvals",
    description:
      "Every consequential action awaiting your decision — trade drafts and held deliveries, composed in one place",
    navEntry: {
      label: "Approvals",
      shortLabel: "Approvals",
      navOrder: 4,
      defaultVisible: true,
      badge: "Queue",
      badgeType: "neutral",
    },
  },
  {
    id: "audit",
    navGroup: "audit",
    crumb: "Audit Vault",
    category: "Platform",
    icon: "Audit",
    description: "W3C Agent DID verification, memory vault, and immutable audit logs",
    navEntry: {
      label: "Audit Vault",
      shortLabel: "Audit Log",
      navOrder: 15,
      defaultVisible: true,
      badge: "DID",
      badgeType: "pro",
    },
  },
  {
    id: "autopilot",
    retain: true,
    navGroup: "autopilot",
    crumb: "Autopilot",
    category: "Execution",
    icon: "Autopilot",
    description: "Autonomous policy execution within limits, E*TRADE broker desk & real-time kill switch",
    navEntry: {
      label: "Autopilot Control",
      shortLabel: "Autopilot",
      navOrder: 0,
      defaultVisible: true,
      badge: "LIVE",
      badgeType: "live",
    },
  },
  {
    id: "chat",
    navGroup: "chat",
    crumb: "Copilot Ideas",
    category: "Intelligence",
    icon: "Copilot",
    description: "Conversational trading copilot, natural language strategies, and agent chat",
    navEntry: {
      label: "Copilot Ideas",
      shortLabel: "Copilot",
      navOrder: 8,
      defaultVisible: true,
      badge: "AI",
      badgeType: "ai",
    },
  },
  {
    id: "checkout",
    navGroup: "payments",
    crumb: "Checkout",
    category: "Platform",
    icon: "Checkout",
    description:
      "Pay for a screener run or manage a subscription: per-run checkout with the failure policy disclosed before payment, and plan purchase, status, and cancel-at-period-end",
    navEntry: {
      label: "Checkout",
      shortLabel: "Checkout",
      navOrder: 24,
      defaultVisible: true,
      badge: "Testnet",
      badgeType: "pro",
    },
  },
  {
    id: "docs",
    navGroup: "docs",
    crumb: "Docs & Reports",
    category: "Intelligence",
    icon: "Docs",
    description:
      "Every document set a screener-workflow run produced — stock, options, goal and strategy — with its PDF, XLSX and CSV downloads and run id",
    navEntry: {
      label: "Docs & Reports",
      shortLabel: "Docs",
      navOrder: 22,
      defaultVisible: true,
      badge: "PDF",
      badgeType: "neutral",
    },
  },
  {
    id: "endpoints",
    navGroup: "endpoints",
    crumb: "MCP Explorer",
    category: "Playbooks",
    icon: "Endpoints",
    description: "Interactive Model Context Protocol (MCP) tool and REST endpoint testing suite",
    navEntry: {
      label: "Developer & MCP",
      shortLabel: "Endpoints",
      navOrder: 13,
      defaultVisible: true,
      badge: "MCP",
      badgeType: "mcp",
    },
  },
  {
    id: "ledger",
    retain: true,
    navGroup: "ledger",
    crumb: "Ledger",
    category: "Execution",
    icon: "Ledger",
    description: "Full chronological ledger of open, executed, and cancelled orders with upstream IDs",
    navEntry: {
      label: "Order History Ledger",
      shortLabel: "Ledger",
      navOrder: 3,
      defaultVisible: true,
      badge: "AUDIT",
      badgeType: "pro",
    },
  },
  {
    id: "nlq",
    navGroup: "nlq",
    crumb: "Records NLQ",
    category: "Playbooks",
    icon: "Database",
    description: "Natural language records analytics, enterprise schema inspector & data browser",
    navEntry: {
      label: "Records NLQ",
      shortLabel: "Records",
      navOrder: 14,
      defaultVisible: true,
      badge: "NLQ",
      badgeType: "neutral",
    },
  },
  {
    id: "omnichannel",
    retain: true,
    navGroup: "omnichannel",
    crumb: "Email & Slack",
    category: "Intelligence",
    icon: "Omnichannel",
    description: "Autonomous alerts, trade approvals, and scheduled market briefings dispatched to Slack and Email",
    navEntry: {
      label: "Email & Slack Agents",
      shortLabel: "Omnichannel",
      navOrder: 10,
      defaultVisible: true,
      badge: "Relay",
      badgeType: "new",
    },
  },
  {
    id: "options",
    retain: true,
    navGroup: "screeners",
    crumb: "Options",
    category: "Intelligence",
    icon: "Screeners",
    description: SCREENERS_DESC,
  },
  {
    id: "options-flows",
    navGroup: "options-flows",
    crumb: "Options Flows",
    category: "Execution",
    icon: "Options",
    description: "Options flows, dark pool prints, institutional sweeps, blocks, and insider disclosures",
    navEntry: {
      label: "Options Flows",
      shortLabel: "Flows",
      navOrder: 5,
      defaultVisible: true,
      badge: "Sweeps",
      badgeType: "pro",
    },
  },
  {
    id: "options-screener",
    navGroup: "options-screener",
    crumb: "Options Screener",
    category: "Intelligence",
    // Icon key must be unique across nav entries (tests/nav_unique_icons_badges.test.ts):
    // "Options" is already the Options Flows entry's icon, and "Screeners"
    // is the Screeners entry's, so this entry reuses the otherwise
    // nav-unused "Scanner" key from the existing icon map — no new icon.
    icon: "Scanner",
    description:
      "The one options home: contract screen, strategy panel, best-trade, compare, LLM ideas and evaluate, discovery, scheduled runs, IV history, flows, reports, workflow runs, and schedules — linked to their existing surfaces, not duplicated (issue 2596, slice 1)",
    navEntry: {
      label: "Options Screener",
      shortLabel: "Options",
      navOrder: 26,
      defaultVisible: true,
      badge: "Options",
      badgeType: "ai",
    },
  },
  {
    id: "order",
    retain: true,
    navGroup: "order",
    crumb: "Order Ticket",
    category: "Execution",
    icon: "Order",
    description: "Build and validate live equity orders with two-step preview validation & DID signing",
    navEntry: {
      label: "Fast Order Ticket",
      shortLabel: "Orders",
      navOrder: 1,
      defaultVisible: true,
      badge: "HITL",
      badgeType: "pro",
    },
  },
  {
    id: "orders",
    retain: true,
    navGroup: "order",
    crumb: "Order Ticket",
    category: "Execution",
    icon: "Order",
    description: "Build and validate live equity orders with two-step preview validation & DID signing",
  },
  {
    id: "payment-assurance",
    navGroup: "payment-assurance",
    crumb: "Payment Assurance",
    category: "Platform",
    icon: "Assurance",
    description: "Test-only assurance harness for PaymentWorkflow: the real flow and gate behind fake cfpay/screener seams, no charge, no real run",
    navEntry: {
      label: "Payment Assurance",
      shortLabel: "Assurance",
      navOrder: 21,
      defaultVisible: true,
      badge: "Test",
      badgeType: "neutral",
    },
  },
  {
    id: "payments",
    shellRetain: true,
    navGroup: "payments",
    crumb: "Payments",
    category: "Platform",
    icon: "Payments",
    description: "x402 protocol, MPP micropayments, Stripe, PayPal, and DID billing",
    navEntry: {
      label: "Payments",
      shortLabel: "Payments",
      navOrder: 16,
      defaultVisible: true,
      badge: "x402",
      badgeType: "neutral",
    },
  },
  {
    id: "portfolio",
    retain: true,
    navGroup: "portfolio",
    crumb: "Portfolio",
    category: "Execution",
    icon: "Portfolio",
    description: "Inspect open equity and options holdings, cost basis, unrealized gain/loss & allocations",
    navEntry: {
      label: "Portfolio & Holdings",
      shortLabel: "Portfolio",
      navOrder: 2,
      defaultVisible: true,
      badge: "Broker",
      badgeType: "live",
    },
  },
  {
    id: "referrals",
    shellRetain: true,
    navGroup: "referrals",
    crumb: "Referrals",
    category: "Platform",
    icon: "Referrals",
    description: "Community referral engine, reward tracking, and social share links",
    navEntry: {
      label: "Referrals & Earn",
      shortLabel: "Referrals",
      navOrder: 17,
      defaultVisible: true,
      badge: "Earn",
      badgeType: "new",
    },
  },
  {
    id: "reports",
    retain: true,
    navGroup: "screeners",
    crumb: "Reports",
    category: "Intelligence",
    icon: "Screeners",
    description: SCREENERS_DESC,
  },
  {
    id: "research",
    navGroup: "research",
    crumb: "Research",
    category: "Intelligence",
    icon: "Research",
    description: "Zero-credential Yahoo Finance and Alpaca dual feed, fundamental peer comparison",
    navEntry: {
      label: "Research & Dual Feed",
      shortLabel: "Research",
      navOrder: 7,
      defaultVisible: true,
      badge: "Feed",
      badgeType: "new",
    },
  },
  {
    id: "revenue",
    shellRetain: true,
    navGroup: "revenue",
    crumb: "Revenue",
    category: "Platform",
    icon: "Revenue",
    description: "Platform monetization engine, ad network yield, CPM/CPC metrics, and ledger",
    navEntry: {
      label: "Revenue Analytics",
      shortLabel: "Revenue",
      navOrder: 19,
      defaultVisible: true,
      badge: "Yield",
      badgeType: "new",
    },
  },
  {
    id: "scanner",
    retain: true,
    navGroup: "screeners",
    crumb: "Strategy/Symbol Scanner",
    category: "Intelligence",
    icon: "Screeners",
    description: SCREENERS_DESC,
  },
  {
    id: "schedules",
    retain: true,
    navGroup: "screeners",
    crumb: "Schedules",
    category: "Intelligence",
    icon: "Screeners",
    description: SCREENERS_DESC,
  },
  {
    id: "screeners",
    retain: true,
    navGroup: "screeners",
    crumb: "Screeners",
    category: "Intelligence",
    icon: "Screeners",
    description: SCREENERS_DESC,
    navEntry: {
      label: "Screeners",
      shortLabel: "Screeners",
      navOrder: 6,
      defaultVisible: true,
      badge: "Multi",
      badgeType: "pro",
    },
  },
  {
    id: "search",
    navGroup: "search",
    crumb: "Search",
    category: "Intelligence",
    icon: "Search",
    description:
      "One search hub: NLQ records, AI search agent, semantic report search, agent memory, platform knowledge, and tool catalog",
    navEntry: {
      label: "Search",
      shortLabel: "Search",
      navOrder: 23,
      defaultVisible: true,
      badge: "Hub",
      badgeType: "mcp",
    },
  },
  {
    id: "social",
    shellRetain: true,
    navGroup: "social",
    crumb: "Social",
    category: "Platform",
    icon: "Social",
    description: "Today's social brief editor, manual daily-post trigger, pending approvals, and per-channel token health",
    navEntry: {
      label: "Social Posting",
      shortLabel: "Social",
      navOrder: 20,
      defaultVisible: true,
      badge: "Daily",
      badgeType: "new",
    },
  },
  {
    id: "trading",
    retain: true,
    navGroup: "autopilot",
    crumb: "Autopilot",
    category: "Execution",
    icon: "Autopilot",
    description: "Autonomous policy execution within limits, E*TRADE broker desk & real-time kill switch",
  },
  {
    id: "voice",
    retain: true,
    navGroup: "voice",
    crumb: "Voice Desk",
    category: "Intelligence",
    icon: "Voice",
    description: "Hands-free voice recognition desk for querying quotes, screening setups, and trade confirmation",
    navEntry: {
      label: "Voice Trading Desk",
      shortLabel: "Voice Desk",
      navOrder: 9,
      defaultVisible: true,
      badge: "Audio",
      badgeType: "ai",
    },
  },
  {
    id: "workflow-runs",
    navGroup: "workflow-runs",
    crumb: "Workflow Runs",
    category: "Playbooks",
    icon: "Runs",
    description:
      "Every recorded workflow run with its stages, inputs, outputs, failures, artifacts, and how it was triggered",
    navEntry: {
      label: "Workflow Runs",
      shortLabel: "Runs",
      navOrder: 12,
      defaultVisible: true,
      badge: "Trace",
      badgeType: "neutral",
    },
  },
  {
    id: "workflows",
    navGroup: "workflows",
    crumb: "Workflows",
    category: "Playbooks",
    icon: "Guides",
    description: "Platform architecture guides, strategy playbooks, order mechanics & FAQ",
    navEntry: {
      label: "Workflows & FAQ",
      shortLabel: "Workflows",
      navOrder: 11,
      defaultVisible: true,
      badge: "14 Guides",
      badgeType: "neutral",
    },
  },
] as const satisfies readonly RouteDef[];

export type Route = (typeof ROUTES)[number];
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
