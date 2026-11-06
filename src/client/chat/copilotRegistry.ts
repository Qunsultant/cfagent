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

export interface CopilotHeroConfig {
  icon?: string;
  title: string;
  description: string;
}

export interface QuickChipConfig {
  label: string;
  prompt: string;
  category?: string;
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
  hero?: CopilotHeroConfig;
  quickChips?: QuickChipConfig[];
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
    hero: {
      icon: "⚡",
      title: "Enterprise Multi-Agent Studio",
      description: "Ask any question about platform capabilities, workflows, algorithmic decisioning, or command tools directly through chat. Your prompt is routed by an LLM Judge and orchestrated across specialized sub-agents with neural strategy intelligence and transactional ledger persistence.",
    },
    quickChips: [
      {
        label: "⚡ Platform Capabilities",
        prompt: "What are the capabilities of this platform and how do I use the 8 core workflows?",
        category: "Platform Capabilities",
      },
      {
        label: "📈 Technical Screener",
        prompt: "Screen for top momentum and breakout stocks using the Technical Screener",
        category: "Screening Guide",
      },
      {
        label: "🌊 Options Sweeps",
        prompt: "Show recent aggressive institutional options sweeps and unusual volume alerts",
        category: "Options Flow Guide",
      },
      {
        label: "⚡ NVDA Earnings Moves",
        prompt: "Evaluate straddle pricing, implied move, and volatility skew for upcoming earnings on NVDA",
        category: "Options Strategy Guide",
      },
      {
        label: "🤖 Build Trading Rules",
        prompt: "How do I build an algorithmic mean reversion trading rule?",
        category: "Algorithmic Rules",
      },
      {
        label: "🛡️ Audit & Performance",
        prompt: "Audit system state, latency, and Durable Object ledgers across all workers",
        category: "System Operations",
      },
    ],
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
    hero: {
      icon: "🎯",
      title: "Options Strategy & Intelligence Copilot",
      description: "Screen, construct, and evaluate structured multi-leg options strategies with real-time Greeks, risk-reward ratios, and 1-click execution. Responses produce interactive structured strategy cards and payoff curves.",
    },
    quickChips: [
      {
        label: "🎯 Bull Put Spread (≤ $30 Max Loss)",
        prompt: "Screen for Bull Put credit spreads with max loss <= $30 and max profit > 0",
        category: "Options Strategy Guide",
      },
      {
        label: "🦅 SPY Iron Condor (High POP)",
        prompt: "Find delta-neutral Iron Condors on SPY with 30-45 DTE and probability of profit > 70%",
        category: "Options Strategy Guide",
      },
      {
        label: "📈 AAPL Covered Call (Income)",
        prompt: "Find covered call setups on AAPL targeting 15-20 delta with 30 DTE",
        category: "Options Strategy Guide",
      },
      {
        label: "🌊 Unusual Options Flow Sweeps",
        prompt: "Show recent aggressive institutional options sweeps and unusual volume alerts",
        category: "Options Flow Guide",
      },
      {
        label: "⚡ NVDA Straddle / Volatility",
        prompt: "Evaluate straddle pricing, implied move, and volatility skew for upcoming earnings on NVDA",
        category: "Options Strategy Guide",
      },
      {
        label: "🛡️ Portfolio Delta Hedge",
        prompt: "Calculate a delta-neutral portfolio hedge using index put options",
        category: "Trading Safety Guide",
      },
    ],
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
    hero: {
      icon: "📈",
      title: "Stock Copilot & Autonomous Loop",
      description: "Continuous autonomous trading loop operating across all 4 sessions (Pre-market, Regular, After-hours, and Overnight EXTO) with pattern scoring, CVaR risk optimization, and automatic bracket exits. Ask questions about open positions, cycle telemetry, or adjust the loop directly.",
    },
    quickChips: [
      {
        label: "⏱️ Set loop interval to 1 hour",
        prompt: "Set loop interval to 1 hour",
        category: "Loop Cadence",
      },
      {
        label: "🌙 Enable pre-market and overnight sessions",
        prompt: "Enable pre-market and overnight sessions",
        category: "Trading Sessions",
      },
      {
        label: "⏸️ Pause trading until 9:30 AM",
        prompt: "Pause trading until 9:30 AM",
        category: "Loop Control",
      },
      {
        label: "🔍 What are you doing?",
        prompt: "What is the Stock Copilot doing right now and what happened in the latest cycle?",
        category: "Loop Telemetry",
      },
      {
        label: "🧠 Explain workflow & tools",
        prompt: "Explain your autonomous trading workflow, 5-stage pipeline, and active tools",
        category: "Tool Introspection",
      },
      {
        label: "📊 Open Positions & Exits",
        prompt: "Show all open positions and their take-profit / stop-loss exit plans",
        category: "Stock Copilot Guide",
      },
      {
        label: "⏸️ Pause Loop",
        prompt: "Pause the Stock Copilot trading loop",
        category: "Stock Copilot Guide",
      },
      {
        label: "▶️ Resume Loop",
        prompt: "Resume the Stock Copilot trading loop",
        category: "Stock Copilot Guide",
      },
      {
        label: "🎯 Buy AAPL Bracket (TP +4% / SL -2%)",
        prompt: "Draft a limit buy order for 10 AAPL with +4% take-profit and -2% stop-loss bracket exits",
        category: "Order Execution",
      },
      {
        label: "🌙 Extended-Hours Limit Order",
        prompt: "Place an extended-hours limit order for TSLA with session-specific bracket exits",
        category: "Extended-Hours Trading",
      },
      {
        label: "📈 Screen Momentum Breakouts",
        prompt: "Scan the active stock universe for Momentum Breakout and Gap & Go setups",
        category: "Pattern Screening",
      },
      {
        label: "🧪 Evaluate NVDA vs Strategies",
        prompt: "Evaluate NVDA against all active trading strategies without placing orders",
        category: "Strategy Evaluation",
      },
      {
        label: "🛡️ Portfolio CVaR & Sizing",
        prompt: "Analyze portfolio risk and calculate CVaR position sizing for $10,000 buying power",
        category: "Risk Management",
      },
      {
        label: "🌐 Universe: S&P 500 & Movers",
        prompt: "Set the trading universe to S&P 500 and top pre-market volume movers",
        category: "Universe Selection",
      },
      {
        label: "📄 Generate Trade Performance Report",
        prompt: "Generate a comprehensive trading and cycle audit report in Markdown format",
        category: "Performance Reports",
      },
      {
        label: "🔍 Audit Refusals & Skipped Trades",
        prompt: "Show recent cycle refusal reasons and explain why trades were skipped",
        category: "Cycle Audit",
      },
      {
        label: "💡 What have you learned?",
        prompt: "What have you learned from recent cycles and critic reflection?",
        category: "Learning Retrospective",
      },
      {
        label: "🧠 Switch to Agentic Dual-Mode",
        prompt: "Switch Stock Copilot to agentic dual-mode with critic reflection and self-correction",
        category: "Dual-Mode Execution",
      },
    ],
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
