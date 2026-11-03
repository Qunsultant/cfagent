import type { TradingSubTab } from "../ETradeTradingHub";
import { ROUTES } from "../routes";
export interface User {
  login: string;
  name: string;
  avatar: string;
  /**
   * Issue #1759: the login provider id for this session (from the
   * server-injected window.__USER__, same source as /api/me).
   * Absent for legacy sessions; the DID display then falls back
   * to the legacy GitHub derivation (see getDisplayUserDid).
   */
  providerId?: string;
}

export const TRADING_TABS = new Set<string>(
  ROUTES.filter((r) => "retain" in r && r.retain).map((r) => r.id),
);

export function isTradingTab(targetTab: string): boolean {
  return TRADING_TABS.has(targetTab);
}

/**
 * Shell-retained pages (#2149): standalone pages rendered mounted-hidden
 * when inactive, like the trading hub but outside it. Derived from the
 * `shellRetain` route field, never from `retain` (that set is the hub's).
 */
export const SHELL_RETAINED_PAGES = new Set<string>(
  ROUTES.filter((r) => "shellRetain" in r && r.shellRetain).map((r) => r.id),
);

export function isShellRetainedTab(targetTab: string): boolean {
  return SHELL_RETAINED_PAGES.has(targetTab);
}

export function mapTabToTradingSubTab(targetTab: string): TradingSubTab {
  switch (targetTab) {
    case "order":
    case "orders":
      return "order";
    case "portfolio":
      return "portfolio";
    case "ledger":
      return "ledger";
    case "screeners":
      return "screeners";
    case "stock-hub":
      return "stock-hub";
    case "scanner":
      return "scanner";
    case "reports":
      return "reports";
    case "schedules":
      return "schedules";
    case "goal-screen":
      return "goal-screen";
    case "review":
      return "review";
    case "track-record":
      return "track-record";
    case "options":
      return "options";
    case "assets-hub":
      return "assets-hub";
    case "voice":
      return "voice";
    case "omnichannel":
      return "omnichannel";
    case "trading":
    case "autopilot":
    default:
      return "autopilot";
  }
}

/** #2371: read-time aspect resolution attached by GET /api/audit and
 * GET /api/audit/:id, resolved from the #2381 outcome catalog. Null
 * when no cataloged code is found in the payload — the read never
 * invents aspects. The stored payload is returned unchanged alongside
 * this field. */
export interface ResolvedAuditAspects {
  code: string;
  businessMessage: string;
  category: string;
  retryable: boolean;
  variant: string;
}

export interface AuditLogEvent {
  id: string;
  type: string;
  agent: string;
  payload: Record<string, unknown>;
  created_at: string;
  resolvedAspects?: ResolvedAuditAspects | null;
}

export interface MemoryItem {
  key: string;
  value: string;
  updatedAt: string;
}

export interface ReferralItem {
  id: string;
  userLogin: string;
  title: string;
  url: string;
  category: string;
  rewardText: string;
  clicks: number;
  signups: number;
  createdAt: string;
}

export interface AdItem {
  id: string;
  title: string;
  tagline: string;
  sponsor: string;
  badge: string;
  url: string;
  ctaText: string;
  accentColor: string;
  impressions: number;
  clicks: number;
  createdAt: string;
}

export interface TransactionItem {
  id: string;
  sessionId: string;
  action: "charge" | "refund" | "invoice" | "payout";
  amount: number;
  currency: string;
  customer: string;
  gateway: "stripe" | "paypal" | "lemonsqueezy" | "sandbox";
  gatewayRef?: string;
  status: "draft" | "awaiting_confirmation" | "authorized" | "completed" | "failed" | "rejected";
  checkoutUrl?: string;
  proposerDid: string;
  authorizerDid?: string;
  proofSignature: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayInfo {
  id: "stripe" | "paypal" | "lemonsqueezy" | "sandbox";
  name: string;
  configured: boolean;
  mode: "live" | "sandbox" | "simulated";
  capabilities: string[];
}

export interface CategoryItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAdItem {
  id: string;
  name: string;
  network: "direct" | "ethicalads" | "carbon" | "adsense" | "google";
  placement: "header_leaderboard" | "in_stream" | "footer_deck" | "sidebar";
  title: string;
  tagline: string;
  ctaText: string;
  targetUrl: string;
  bannerImageUrl?: string;
  cpmRate: number;
  cpcRate: number;
  impressions: number;
  clicks: number;
  earnings: number;
  isActive: boolean;
  createdAt: string;
}

export interface RevenueSummaryData {
  grossRevenue: number;
  adNetworkRevenue: number;
  marketplaceRevenue: number;
  paymentPlatformFees: number;
  referralPayouts: number;
  netRevenue: number;
  totalImpressions: number;
  totalAdClicks: number;
  averageRPM: number;
}

export interface TableMetadataItem {
  name: string;
  description: string;
  rowCount: number;
  columns: Array<{ name: string; type: string; isPrimary: boolean }>;
}

export function extractText(message: any): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("") || "";
  }
  return "";
}
