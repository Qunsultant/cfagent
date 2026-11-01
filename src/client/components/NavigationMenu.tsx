import React, { useState, useEffect } from "react";
import type { ThemeMode } from "../theme";
import { StockSearchBar } from "./StockSearchBar";
import { Badge, Button, type BadgeTone } from "./ui";
import { ROUTES, DEFAULT_VISIBLE_NAV_TABS, getNavGroup, hasNavEntry, type RouteId, type NavEntryMeta } from "../routes";
export { DEFAULT_VISIBLE_NAV_TABS };
import { MarketStatusPill } from "./MarketStatusPill";
import { adjustFontScale, getStoredFontScale } from "../typography";
import { BRAND } from "../branding";
import { LeftNavBar } from "./LeftNavBar";
import { PlatformAdminPanel } from "../PlatformAdminPanel";
import { platformAdminSectionFromNavId, sandboxNavHrefFromNavId } from "../navConfig";
export { LeftNavBar };
import { isTabFeatureEnabled } from "../featureFlags";
import { navigateToTab } from "../router";

export type NavTabId = RouteId;

export type NavLayoutMode = "left" | "top";

export function isTabActive(itemTabId: NavTabId, currentTab: NavTabId): boolean {
  // Nav groups come from the route table (routes.ts): alias ids highlight
  // their group (trading -> autopilot, orders -> order, the four hub
  // children -> screeners). This replaces the hand-coded groups.
  return getNavGroup(currentTab) === itemTabId;
}

export interface NavItemDef {
  id: NavTabId;
  label: string;
  shortLabel: string;
  category: "Execution" | "Intelligence" | "Playbooks" | "Platform";
  badge?: string;
  badgeType?: "pro" | "live" | "ai" | "mcp" | "new" | "neutral";

  icon: (props: { active?: boolean; className?: string }) => React.ReactNode;
  description: string;
}

/** Nav item badge kinds -> Badge tones (#492). */
export const NAV_BADGE_TONES: Record<string, BadgeTone> = {
  live: "danger",
  pro: "success",
  ai: "purple",
  mcp: "info",
  new: "accent",
  neutral: "neutral",
  default: "neutral",
};

export interface NavigationMenuProps {
  layout: NavLayoutMode;
  onToggleLayout: (newLayout: NavLayoutMode) => void;
  activeTab: NavTabId;
  onSelectTab: (tab: NavTabId) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  user: {
    login: string;
    name: string;
    avatar: string;
  };
  agentStatus?: {
    dotClass: string;
    label: string;
  };
  accountMode?: "paper" | "live";
  onToggleAccountMode?: () => void;
  headerChildren?: React.ReactNode;
  theme?: ThemeMode;
  onCycleTheme?: () => void;
  onAskAgent?: (query: string) => void;
  visibleTabs?: Record<string, boolean>;
  /** Issue #69: unread broker-alert count badged on the Portfolio item. */
  alertBadgeCount?: number;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  lastRefreshedAt?: string;
}

export const NAV_TAB_PRESETS: Record<string, Record<string, boolean>> = {
  all: { ...DEFAULT_VISIBLE_NAV_TABS },
  traderFocus: {
    autopilot: true,
    order: true,
    portfolio: true,
    ledger: true,
    "options-flows": true,
    options: true,
    screeners: true,
    scanner: false,
    research: true,
    chat: true,
    voice: false,
    omnichannel: false,
    workflows: false,
    "workflow-runs": false,
    endpoints: false,
    nlq: false,
    audit: false,
    payments: false,
    referrals: false,
    ads: false,
    revenue: false,
  },
  minimal: {
    autopilot: true,
    order: true,
    portfolio: true,
    ledger: false,
    "options-flows": false,
    options: false,
    screeners: false,
    scanner: false,
    research: true,
    chat: true,
    voice: false,
    omnichannel: false,
    workflows: false,
    "workflow-runs": false,
    endpoints: false,
    nlq: false,
    audit: false,
    payments: false,
    referrals: false,
    ads: false,
    revenue: false,
  },
};

// Crisp, modern SVG icons designed for institutional UI
export const NavIcons = {
  Autopilot: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      <circle cx="12" cy="12" r="4" fill={active ? "currentColor" : "none"} fillOpacity={0.2} />
    </svg>
  ),
  Agents: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5" r="2.5" fill={active ? "currentColor" : "none"} fillOpacity={0.2} />
      <circle cx="5" cy="19" r="2.5" fill={active ? "currentColor" : "none"} fillOpacity={0.2} />
      <circle cx="19" cy="19" r="2.5" fill={active ? "currentColor" : "none"} fillOpacity={0.2} />
      <path d="M12 7.5 5.9 16.6M12 7.5l6.1 9.1M7.5 19h9" />
    </svg>
  ),
  Order: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill={active ? "currentColor" : "none"} fillOpacity={0.2} />
    </svg>
  ),
  Portfolio: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" fill={active ? "currentColor" : "none"} fillOpacity={0.15} />
    </svg>
  ),
  Ledger: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" fill={active ? "currentColor" : "none"} fillOpacity={0.12} />
      <line x1="8" y1="7" x2="16" y2="7" />
    </svg>
  ),
  Options: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      <circle cx="15" cy="21" r="1.5" fill={active ? "currentColor" : "none"} />
      <circle cx="9" cy="3" r="1.5" fill={active ? "currentColor" : "none"} />
    </svg>
  ),
  Bot: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4" />
      <line x1="8" y1="16" x2="8.01" y2="16" strokeWidth="2.5" />
      <line x1="16" y1="16" x2="16.01" y2="16" strokeWidth="2.5" />
    </svg>
  ),
  Screeners: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" fill={active ? "currentColor" : "none"} fillOpacity={0.15} />
    </svg>
  ),
  Scanner: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  ),
  Research: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <path d="M11 8v6M8 11h6" />
    </svg>
  ),
  Voice: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" fill={active ? "currentColor" : "none"} fillOpacity={0.2} />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  ),
  Omnichannel: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  ),
  Workflows: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 19 21 12 17 5 21 12 2" fill={active ? "currentColor" : "none"} fillOpacity={0.15} />
    </svg>
  ),
  Endpoints: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
      <line x1="14" y1="4" x2="10" y2="20" />
    </svg>
  ),
  Copilot: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M9 10h.01M15 10h.01M12 14c1.5 0 2-.8 2-.8" strokeWidth="2.5" />
    </svg>
  ),
  Database: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  Audit: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill={active ? "currentColor" : "none"} fillOpacity={0.15} />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  Payments: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="3" ry="3" />
      <line x1="1" y1="10" x2="23" y2="10" />
      <line x1="5" y1="15" x2="9" y2="15" strokeWidth="2.5" />
    </svg>
  ),
  Referrals: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 12 20 22 4 22 4 12" />
      <rect x="2" y="7" width="20" height="5" />
      <line x1="12" y1="22" x2="12" y2="7" />
      <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
      <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
    </svg>
  ),
  Ads: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 11 18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  ),
  Revenue: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  Social: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="12" r="3" fill={active ? "currentColor" : "none"} fillOpacity={0.2} />
      <circle cx="17" cy="6" r="3" fill={active ? "currentColor" : "none"} fillOpacity={0.2} />
      <circle cx="17" cy="18" r="3" fill={active ? "currentColor" : "none"} fillOpacity={0.2} />
      <line x1="8.5" y1="10.5" x2="14.5" y2="7.5" />
      <line x1="8.5" y1="13.5" x2="14.5" y2="16.5" />
    </svg>
  ),
  Approvals: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" fill={active ? "currentColor" : "none"} fillOpacity={0.12} />
    </svg>
  ),
  Docs: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill={active ? "currentColor" : "none"} fillOpacity={0.12} />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
  Runs: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="18" r="3" fill={active ? "currentColor" : "none"} fillOpacity={0.15} />
      <circle cx="6" cy="6" r="3" fill={active ? "currentColor" : "none"} fillOpacity={0.15} />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </svg>
  ),
  Guides: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" fill={active ? "currentColor" : "none"} fillOpacity={0.1} />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" fill={active ? "currentColor" : "none"} fillOpacity={0.1} />
    </svg>
  ),
  Search: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" fill={active ? "currentColor" : "none"} fillOpacity={0.1} />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  Checkout: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="21" r="1" fill={active ? "currentColor" : "none"} />
      <circle cx="20" cy="21" r="1" fill={active ? "currentColor" : "none"} />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  ),
  Assurance: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6" />
      <path d="M10 3v6L4.5 19a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 9V3" fill={active ? "currentColor" : "none"} fillOpacity={0.1} />
      <line x1="7" y1="15" x2="17" y2="15" />
    </svg>
  ),
  LayoutSidebar: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  ),
  LayoutTop: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
    </svg>
  ),
  ChevronLeft: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  ),
  ChevronRight: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  NextGenLogo: () => (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="8" fill="var(--color-surface-sunken)" stroke="var(--color-success)" strokeWidth="1.5" />
      <path d="M7 23V9L15 23V9" stroke="var(--color-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 14H26M22.5 10.5V23" stroke="var(--color-success)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  ),
  Sun: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  ),
  Moon: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
  System: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  Logout: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
  Settings: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

/** NavIcons key -> component (the route table carries keys, not components). */
export const NAV_ICON_MAP: Record<string, NavItemDef["icon"]> = {
  Agents: NavIcons.Agents,
  Autopilot: NavIcons.Autopilot,
  Order: NavIcons.Order,
  Portfolio: NavIcons.Portfolio,
  Ledger: NavIcons.Ledger,
  Options: NavIcons.Options,
  Screeners: NavIcons.Screeners,
  Scanner: NavIcons.Scanner,
  Research: NavIcons.Research,
  Copilot: NavIcons.Copilot,
  Voice: NavIcons.Voice,
  Omnichannel: NavIcons.Omnichannel,
  Workflows: NavIcons.Workflows,
  Endpoints: NavIcons.Endpoints,
  Database: NavIcons.Database,
  Audit: NavIcons.Audit,
  Payments: NavIcons.Payments,
  Referrals: NavIcons.Referrals,
  Ads: NavIcons.Ads,
  Revenue: NavIcons.Revenue,
  Social: NavIcons.Social,
  Approvals: NavIcons.Approvals,
  Docs: NavIcons.Docs,
  Runs: NavIcons.Runs,
  Guides: NavIcons.Guides,
  Search: NavIcons.Search,
  Checkout: NavIcons.Checkout,
  Assurance: NavIcons.Assurance,
  Settings: NavIcons.Settings,
};

/** Nav items, derived from the route table in display order (#1804 S1). */
export const NAVIGATION_ITEMS: NavItemDef[] = ROUTES.filter(hasNavEntry)
  .sort((a, b) => a.navEntry.navOrder - b.navEntry.navOrder)
  .map((r) => {
    // Widen the literal entry meta so optional badge fields read cleanly.
    const meta: NavEntryMeta = r.navEntry;
    return {
      id: r.id,
      label: meta.label,
      shortLabel: meta.shortLabel,
      category: r.category,
      badge: meta.badge,
      badgeType: meta.badgeType,
      icon: NAV_ICON_MAP[r.icon],
      description: r.description,
    };
  });

export function NavigationMenu({
  layout,
  onToggleLayout,
  activeTab,
  onSelectTab,
  collapsed = false,
  onToggleCollapse,
  user,
  agentStatus,
  accountMode = "paper",
  onToggleAccountMode,
  headerChildren,
  theme,
  onCycleTheme,
  onAskAgent,
  visibleTabs,
  alertBadgeCount,
  onRefresh,
  isRefreshing,
  lastRefreshedAt,
}: NavigationMenuProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // Issue #2624: the Platform Admin drawer is owned by the nav shell so the
  // left-nav item works on every page, not only where settings is mounted.
  const [platformAdminOpen, setPlatformAdminOpen] = useState(false);
  const [platformAdminSection, setPlatformAdminSection] = useState<string | undefined>(undefined);
  const [navFontScale, setNavFontScale] = useState<number>(getStoredFontScale);

  useEffect(() => {
    function handleTypo(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.scale !== undefined) setNavFontScale(detail.scale);
    }
    window.addEventListener("typography-changed", handleTypo);
    return () => window.removeEventListener("typography-changed", handleTypo);
  }, []);

  // `platform-admin` / `platform-admin:<section>` are nav ids:
  // selecting them navigates to the Platform Admin page at that section.
  const handleSelectNavId = (id: string) => {
    const section = platformAdminSectionFromNavId(id);
    if (section) {
      onSelectTab("platform-admin" as NavTabId);
      navigateToTab("platform-admin", section);
      return;
    }
    // Issue #2645: sandbox ids link standalone server pages, not SPA tabs:
    // open the page in a new tab so the app stays open behind it.
    const sandboxHref = sandboxNavHrefFromNavId(id);
    if (sandboxHref) {
      window.open(sandboxHref, "_blank", "noopener");
      return;
    }
    onSelectTab(id as Parameters<typeof onSelectTab>[0]);
  };

  const isTabVisible = (id: string) => {
    if (!isTabFeatureEnabled(id as NavTabId)) return false;
    if (!visibleTabs) return true;
    return visibleTabs[id] !== false;
  };

  const filteredNavItems = NAVIGATION_ITEMS.filter((i) => isTabVisible(i.id));
  const fallbackEnabledItems = NAVIGATION_ITEMS.filter((i) => isTabFeatureEnabled(i.id as NavTabId));
  const effectiveNavItems = filteredNavItems.length > 0 ? filteredNavItems : fallbackEnabledItems;

  // Group items by category for sidebar navigation
  const executionItems = effectiveNavItems.filter((i) => i.category === "Execution");
  const intelligenceItems = effectiveNavItems.filter((i) => i.category === "Intelligence");
  const playbookItems = effectiveNavItems.filter((i) => i.category === "Playbooks");
  const platformItems = effectiveNavItems.filter((i) => i.category === "Platform");

  // 1. LEFT SIDEBAR LAYOUT
  if (layout === "left") {
    return (
      <>
        <LeftNavBar
          activeTab={activeTab}
          onSelectTab={handleSelectNavId}
          collapsed={collapsed}
          onToggleCollapse={onToggleCollapse}
          visibleTabs={visibleTabs}
          alertBadgeCount={alertBadgeCount}
        />
        <PlatformAdminPanel
          open={platformAdminOpen}
          onClose={() => setPlatformAdminOpen(false)}
          initialSection={platformAdminSection}
          user={{ login: user.login, name: user.name, avatar: user.avatar }}
        />
      </>
    );
  }

  // 2. TOP NAV BAR LAYOUT (Two-tier institutional layout with dedicated full menu bar)
  return (
    <div className="app-top-header nextgentp-top-nav-container" aria-label="Top Navigation">
      {/* Tier 1: Brand, Status Badges, Stock Search, Quick Trade & Profile Controls */}
      <div className="top-nav-utility-bar">
        {/* Brand & Market Badges */}
        <div className="top-nav-brand-section">
          <div className="top-brand" onClick={() => onSelectTab("autopilot")}>
            <NavIcons.NextGenLogo />
            <span className="top-brand-name">{BRAND.name}</span>
            <span className="brand-badge-pill">{BRAND.badge}</span>
          </div>

          {/* Institutional Market Status */}
          <div className="top-status-pills">
            <MarketStatusPill variant="pill" />
          </div>
        </div>

        {/* Right Controls: Stock Search, Universal Top Refresh, Quick Trade, Settings Menu */}
        <div className="top-nav-right-controls">
          {/* Global Stock Search Bar */}
          <StockSearchBar onSelectTab={onSelectTab} onAskAgent={onAskAgent} />

          {/* Universal Top Bar Refresh Button */}
          {onRefresh && (
            <Button
              variant="ghost"
              className={`nav-refresh-btn ${isRefreshing ? "refreshing" : ""}`}
              onClick={onRefresh}
              disabled={isRefreshing}
              title={`Refresh active workspace & market data feeds${lastRefreshedAt ? ` (last refreshed: ${lastRefreshedAt})` : ""}`}
              aria-label="Refresh workspace data"
            >
              <span className={`nav-refresh-icon ${isRefreshing ? "spin" : ""}`}>↻</span>
              <span className="nav-refresh-text">Refresh</span>
              {lastRefreshedAt && <span className="nav-refresh-time">{lastRefreshedAt}</span>}
            </Button>
          )}

          {/* Quick Font Size Controls */}
          <div className="nav-font-size-ctrl" title="Adjust application font size throughout the app">
            <Button
              variant="ghost"
              className="nav-font-btn"
              onClick={() => {
                const next = adjustFontScale(-0.05);
                setNavFontScale(next);
              }}
              aria-label="Decrease font size"
              title="Decrease font size (A-)"
              disabled={navFontScale <= 0.75}
            >
              A-
            </Button>
            <span className="nav-font-scale-text" title={`Current font zoom: ${Math.round(navFontScale * 100)}%`}>
              {Math.round(navFontScale * 100)}%
            </span>
            <Button
              variant="ghost"
              className="nav-font-btn"
              onClick={() => {
                const next = adjustFontScale(0.05);
                setNavFontScale(next);
              }}
              aria-label="Increase font size"
              title="Increase font size (A+)"
              disabled={navFontScale >= 1.5}
            >
              A+
            </Button>
          </div>

          {/* Quick Trade Button */}
          <Button
            variant="ghost"
            className="nav-trade-btn"
            onClick={() => onSelectTab("autopilot")}
            title="Open Autopilot & Trading execution center"
          >
            Trade
          </Button>

          {headerChildren}

          {/* Fixed Top-Right Sign Out Icon */}
          {user && (
            <a
              href="/auth/logout"
              className="top-nav-logout-btn icon-only-logout"
              title={`Sign Out (@${user.login} · ${user.name})`}
              aria-label="Sign out"
            >
              <span className="top-nav-logout-icon"><NavIcons.Logout /></span>
            </a>
          )}
        </div>
      </div>

      {/* Tier 2: Dedicated Top Navigation Menu Bar with all items */}
      <nav className="top-nav-menu-strip" aria-label="Top Navigation Menu">
        <div className="top-menu-strip-inner">
          {effectiveNavItems.map((item) => {
            const active = isTabActive(item.id, activeTab);
            const Icon = item.icon;
            return (
              <Button
                variant="ghost"
                key={item.id}
                className={`top-menu-item-btn ${active ? "active" : ""}`}
                onClick={() => onSelectTab(item.id)}
                title={item.description}
              >
                <Icon active={active} />
                <span className="top-menu-label">{item.label}</span>
                {item.badge && (
                  <Badge size="sm" tone={NAV_BADGE_TONES[item.badgeType || "default"]}>
                    {item.badge}
                  </Badge>
                )}
              </Button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
