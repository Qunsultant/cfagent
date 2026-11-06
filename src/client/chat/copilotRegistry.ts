import type { ReactNode } from "react";
import type { CapabilityTabItem } from "../components/CapabilityNavBar";
import type { User } from "./types";
import type { BadgeTone } from "../components/ui";

/**
 * How a copilot's surface renders (#3449, #3521).
 *
 * - "chat": conversational interface with stream, quick chips, and composer.
 * - "custom": dedicated copilot dashboard rendered exclusively across full
 *   viewport height (e.g. Stock Copilot autonomous loop telemetry & controls),
 *   preventing UI overlap or dual scrollbars with the conversation stream.
 *
 * Registrations can also supply `renderCustom` directly to provide custom UI.
 * Use `hasCustomSurface()` to test whether a copilot provides a custom surface.
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
    badge: "Paper",
    badgeType: "cyan",
    mode: "chat",
    tooltip: {
      eyebrow: "Autonomous Trading",
      title: "Stock Copilot & Paper-Trading Loop",
      description: "Real-time telemetry, open positions with exit plans, cycle activity feed, and pause/resume execution controls.",
    },
    composerPlaceholder: "Ask Stock Copilot (e.g. 'What is the loop doing?', 'Show open positions', 'Pause loop')…",
    sourceTab: "Stock Copilot",
    banner: {
      icon: "📈",
      headline: "Stock Copilot Active:",
      description: "Autonomous paper-trading loop on Alpaca (Paper). 24/7 continuous session execution with CVaR risk management.",
      badgeText: "Alpaca · Paper Loop",
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
 * Whether the copilot declares a custom surface (#3449, #3521). When true,
 * the chat tab renders that dedicated surface exclusively across the
 * viewport without overlapping the general conversation stream or sticky composer.
 */
export function hasCustomSurface(config: CopilotConfig): boolean {
  return typeof config.renderCustom === "function" || config.mode === "custom";
}

export function isRegisteredCopilotId(id: unknown): id is string {
  return typeof id === "string" && copilotRegistry.some((c) => c.id === id);
}
