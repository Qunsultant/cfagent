import type { ReactNode } from "react";
import type { CapabilityTabItem } from "../components/CapabilityNavBar";
import type { User } from "./types";
import type { BadgeTone } from "../components/ui";

/**
 * How a copilot's surface composes (#3454 — uniform shell).
 *
 * Historically this selected between two exclusive renders: "chat"
 * showed the conversation, "custom" replaced it with the custom
 * surface — which is how the stock sub-tab lost its composer. The
 * shell is now uniform for every copilot: banner (when configured),
 * the custom surface (when the copilot declares one) composed ABOVE
 * the conversation, and ALWAYS the shared conversation. The mode no
 * longer selects a render; it only declares whether the copilot has
 * a custom surface:
 * - "chat": conversation only (no custom surface).
 * - "custom": a custom surface above the conversation.
 * The type and values are retained so existing registrations keep
 * their meaning (deprecated-compatible reading); a registration may
 * also supply renderCustom directly, which declares a surface
 * regardless of mode. Use hasCustomSurface() to read the composition.
 */
export type CopilotMode = "chat" | "custom";

export interface CopilotBannerConfig {
  icon: string;
  headline: string;
  description: string;
  badgeText?: string;
  badgeColor?: "brand" | "danger" | "important" | "informative" | "severe" | "subtle" | "success" | "warning";
}

export interface CopilotCustomRenderProps {
  user: User;
  onChipClick?: (prompt: string, sourceTab?: string) => void;
  onNavigateTab?: (tab: any) => void;
}

export interface CopilotConfig {
  id: string;
  label: string;
  icon?: string;
  badge?: string;
  badgeType?: CapabilityTabItem["badgeType"];
  tooltip: {
    eyebrow: string;
    title: string;
    description: string;
  };
  /** Declares whether the copilot has a custom surface — see CopilotMode (#3454). Never suppresses the conversation. */
  mode: CopilotMode;
  composerPlaceholder?: string;
  sourceTab?: string;
  banner?: CopilotBannerConfig;
  /**
   * Custom surface renderer, composed above the shared conversation
   * (#3454). Supplying one declares a custom surface regardless of
   * mode. A "custom" copilot without one falls back to the stock
   * surface in the chat shell (the #3449 stock registration's shape);
   * new registrations should provide their own renderer.
   */
  renderCustom?: (props: CopilotCustomRenderProps) => ReactNode;
}

export const DEFAULT_COPILOTS: CopilotConfig[] = [
  {
    id: "general",
    label: "General Copilot",
    icon: "⚡",
    mode: "chat",
    tooltip: {
      eyebrow: "AI Intelligence",
      title: "Multi-Agent Orchestrator",
      description: "Conversational multi-agent copilot for platform capabilities, market queries, and general workflows.",
    },
    composerPlaceholder: "Ask about platform capabilities, workflows, how to screen, draft orders, or query data…",
    sourceTab: "Chat & Agents",
  },
  {
    id: "options",
    label: "Options Copilot",
    icon: "🎯",
    badge: "AI",
    badgeType: "cyan",
    mode: "chat",
    tooltip: {
      eyebrow: "Options Intelligence",
      title: "Options Strategy & Structured Outputs",
      description: "Specialized copilot for options screening, multi-leg spreads, Greeks analysis, and interactive payoff visualizers.",
    },
    composerPlaceholder: "Ask Options Copilot (e.g. 'Screen for Bull Put spreads on NVDA with max loss <= $30', 'Best SPY Iron Condor')...",
    sourceTab: "E*TRADE · Auto Options Research",
    banner: {
      icon: "🎯",
      headline: "Options Copilot Active:",
      description: "Queries generate structured strategy cards with multi-leg execution plans, Greeks, and interactive payoff visualizers.",
      badgeText: "Structured Outputs",
      badgeColor: "brand",
    },
  },
  {
    id: "stock",
    label: "Stock Copilot",
    icon: "📈",
    badge: "Live",
    badgeType: "live",
    mode: "custom",
    tooltip: {
      eyebrow: "Autonomous Trading",
      title: "Stock Copilot & Paper-Trading Loop",
      description: "Real-time telemetry, open positions with exit plans, cycle activity feed, and pause/resume execution controls.",
    },
    composerPlaceholder: "Ask about the Stock Copilot loop — open positions, recent cycles, or why a cycle was refused…",
    banner: {
      icon: "📈",
      headline: "Stock Copilot Active:",
      description: "Autonomous paper-trading loop telemetry, open positions with exit plans, cycle activity, and execution controls.",
      badgeText: "Paper Trading Loop",
      badgeColor: "brand",
    },
  },
];

const copilotRegistry: CopilotConfig[] = [...DEFAULT_COPILOTS];

export function getRegisteredCopilots(): readonly CopilotConfig[] {
  return copilotRegistry;
}

export function registerCopilot(config: CopilotConfig): () => void {
  const index = copilotRegistry.findIndex((c) => c.id === config.id);
  if (index >= 0) {
    copilotRegistry[index] = config;
  } else {
    copilotRegistry.push(config);
  }
  return () => {
    const idx = copilotRegistry.findIndex((c) => c.id === config.id);
    if (idx >= 0) {
      copilotRegistry.splice(idx, 1);
    }
  };
}

export function findCopilot(id: string): CopilotConfig | undefined {
  return copilotRegistry.find((c) => c.id === id);
}

/**
 * Whether the copilot declares a custom surface (#3454). The chat
 * shell composes that surface above the shared conversation, which
 * renders for every copilot either way — a custom surface never
 * replaces the conversation.
 */
export function hasCustomSurface(config: CopilotConfig): boolean {
  return typeof config.renderCustom === "function" || config.mode === "custom";
}

export function isRegisteredCopilotId(id: unknown): id is string {
  return typeof id === "string" && copilotRegistry.some((c) => c.id === id);
}
