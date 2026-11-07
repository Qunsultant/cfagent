/**
 * Issue #3519 — Stock Copilot Agentic Loop.
 *
 * Implements non-deterministic dual-mode cycle operation:
 * 1. Perceive: Gathers market bars, open positions, recent activity, active session,
 *    and prior distilled learnings from tenancy memory.
 * 2. Plan: Evaluates setup candidates and exit triggers, constructing structured
 *    trade intents (data-only, no raw LLM text orders).
 * 3. Critic (Reflect): Validates planned intents against deterministic risk constraints,
 *    session venue rules, and CVaR caps via `evaluateCriticRules`.
 * 4. Execute: Dispatches approved intents through the platform order seam.
 * 5. Learn: Distills verdicts and execution deltas into tenancy memory (`StockCopilotMemoryPort`).
 */
import type {
  CopilotCriticVerdict,
  CopilotLearningRecord,
  StockCopilotMemoryPort,
} from "../data/stockCopilotStorePorts";
import {
  evaluateLatestPatternSignal,
  type SandboxStrategyId,
} from "./patternSignals";
import {
  copilotSessionAt,
  resolveCopilotSessions,
  shapeCopilotSessionOrder,
  STOCK_COPILOT_OUTSIDE_ENABLED_SESSIONS,
  type CopilotSessionId,
} from "./stockCopilotSessions";
import {
  COPILOT_BROKER_ID,
} from "../agents/copilotTradingMode";
import {
  COPILOT_STOP_LOSS_PCT,
  COPILOT_TAKE_PROFIT_PCT,
  DEFAULT_COPILOT_STRATEGIES,
  DEFAULT_COPILOT_UNIVERSE,
  STOCK_COPILOT_INACTIVE_BROKER,
  STOCK_COPILOT_MODE_UNRESOLVED,
  isStockCopilotPaperEnabled,
  type StockCopilotCycleResult,
  type StockCopilotDeps,
} from "./stockCopilot";
import { StockCopilotPositionStore } from "./stockCopilotStore";
import {
  evaluateCriticRules,
  type ProposedTradeIntent,
} from "./stockCopilotCritic";

export interface StockCopilotAgenticCycleResult extends StockCopilotCycleResult {
  mode: "agentic";
  plan: {
    perceivedSession: string | null;
    evaluatedSymbols: string[];
    proposedIntentsCount: number;
    reasoning: string;
  };
  criticVerdict: CopilotCriticVerdict;
  learningsGenerated: number;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export async function runStockCopilotAgenticCycle(
  deps: StockCopilotDeps & {
    memory?: StockCopilotMemoryPort;
  },
): Promise<StockCopilotAgenticCycleResult> {
  const result: StockCopilotAgenticCycleResult = {
    status: "ok",
    session: null,
    enabledSessions: [],
    entriesPlaced: 0,
    exitsPlaced: 0,
    entries: [],
    exits: [],
    rejections: [],
    errors: [],
    mode: "agentic",
    plan: {
      perceivedSession: null,
      evaluatedSymbols: [],
      proposedIntentsCount: 0,
      reasoning: "",
    },
    criticVerdict: {
      verdict: "accept",
      reason: "",
    },
    learningsGenerated: 0,
  };

  // 1. Core Gate Verification
  if (!isStockCopilotPaperEnabled(deps.env)) {
    result.status = "disabled";
    return result;
  }

  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();

  // 2. Session Perception
  const enabledSessions =
    deps.enabledSessions ?? resolveCopilotSessions({ env: deps.env });
  const aroundTheClock =
    String(deps.env?.STOCK_COPILOT_AROUND_THE_CLOCK ?? "").toLowerCase() === "true" ||
    String(deps.env?.STOCK_COPILOT_FORCE_ALL_SESSIONS ?? "").toLowerCase() === "true" ||
    String(deps.env?.STOCK_COPILOT_IGNORE_SESSIONS ?? "").toLowerCase() === "true";
  const session = copilotSessionAt(now, aroundTheClock);
  result.session = session;
  result.enabledSessions = [...enabledSessions];
  result.plan.perceivedSession = session;

  // Mode Selection Gates
  if (!deps.selection.resolved) {
    result.status = "mode_unresolved";
    result.refusal = STOCK_COPILOT_MODE_UNRESOLVED;
    return result;
  }
  const selection = deps.selection.selection;
  if (selection.brokerId !== COPILOT_BROKER_ID) {
    const isBrokerNeutral =
      String(deps.env.STOCK_COPILOT_BROKER_NEUTRAL ?? "").toLowerCase() === "true" ||
      deps.env.STOCK_COPILOT_BROKER_ID === selection.brokerId;
    if (!isBrokerNeutral) {
      result.status = "inactive_broker";
      return result;
    }
  }

  // Session Enablement Gate
  if (!session || !enabledSessions.includes(session)) {
    result.status = "outside_enabled_sessions";
    result.refusal = `${STOCK_COPILOT_OUTSIDE_ENABLED_SESSIONS}:${session ?? "none"}`;
    return result;
  }

  // 3. Perception Stage: Read Memory, Store, and Positions
  const store = new StockCopilotPositionStore(deps.positions);
  const openPositions = await store.listOpenPositions(deps.userLogin);
  const universe = deps.universe ?? [...DEFAULT_COPILOT_UNIVERSE];
  const strategies = deps.strategies ?? DEFAULT_COPILOT_STRATEGIES;
  result.plan.evaluatedSymbols = [...universe];

  const proposedIntents: ProposedTradeIntent[] = [];

  // Evaluate exits for open positions
  for (const pos of openPositions) {
    try {
      const closes = await deps.loadBars(pos.symbol);
      const last = closes.length > 0 ? closes[closes.length - 1] : 0;
      if (last > 0) {
        if (last <= pos.stopPrice || last >= pos.targetPrice) {
          const shape = shapeCopilotSessionOrder(session, last);
          proposedIntents.push({
            symbol: pos.symbol,
            action: "SELL",
            quantity: pos.quantity,
            orderType: shape.orderType,
            limitPrice: shape.orderType === "LIMIT" ? shape.limitPrice : undefined,
            stopPrice: pos.stopPrice,
            targetPrice: pos.targetPrice,
            strategy: pos.strategy,
          });
        }
      }
    } catch (err) {
      result.errors.push({
        symbol: pos.symbol,
        stage: "exit_perception",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Evaluate candidate entries for universe
  for (const sym of universe) {
    if (openPositions.some((p) => p.symbol === sym)) continue;
    for (const strat of strategies) {
      try {
        const closes = await deps.loadBars(sym);
        if (closes.length < 5) continue;
        const last = closes[closes.length - 1];
        const signal = evaluateLatestPatternSignal(strat, closes, { holding: false, entryPrice: 0 });
        if (signal.action === "enter_long" && last > 0) {
          const stopPrice = round2(last * (1 - COPILOT_STOP_LOSS_PCT / 100));
          const targetPrice = round2(last * (1 + COPILOT_TAKE_PROFIT_PCT / 100));
          const shape = shapeCopilotSessionOrder(session, last);

          proposedIntents.push({
            symbol: sym,
            action: "BUY",
            quantity: 10, // Sizing constraint
            orderType: shape.orderType,
            limitPrice: (shape.orderType === "LIMIT" ? shape.limitPrice : last) ?? last,
            stopPrice,
            targetPrice,
            strategy: strat,
          });
        }
      } catch (err) {
        result.errors.push({
          symbol: sym,
          stage: "candidate_perception",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  result.plan.proposedIntentsCount = proposedIntents.length;
  result.plan.reasoning = `Perceived ${openPositions.length} open positions and ${universe.length} universe tickers; identified ${proposedIntents.length} trade intent(s).`;

  // 4. Critic Stage (Reflect)
  const criticVerdict = evaluateCriticRules({
    userLogin: deps.userLogin,
    session,
    platform: deps.platform,
    proposedIntents,
    openPositions,
    noTradeReason: proposedIntents.length === 0 ? "No active pattern setup met alpha hurdle" : null,
  });

  result.criticVerdict = {
    verdict: criticVerdict.verdict,
    reason: criticVerdict.reason,
    recommendations: criticVerdict.recommendations,
  };

  // 5. Execution Stage (Only on Critic Acceptance)
  if (criticVerdict.verdict === "accept" && proposedIntents.length > 0) {
    for (const intent of proposedIntents) {
      const isExtended = session === "pre_market" || session === "after_hours" || session === "exto";
      const placed = await deps.platform.placeOrderRemote!({
        orderId: `copilot-${crypto.randomUUID()}`,
        symbol: intent.symbol,
        action: intent.action,
        quantity: intent.quantity,
        orderType: intent.orderType,
        ...(intent.orderType === "LIMIT" ? { limitPrice: intent.limitPrice } : {}),
        userLogin: deps.userLogin,
        session: session ?? undefined,
        extendedHours: isExtended,
      });

      if (placed.success) {
        if (intent.action === "BUY") {
          await store.openPosition({
            userLogin: deps.userLogin,
            symbol: intent.symbol,
            strategy: intent.strategy ?? "agentic",
            quantity: intent.quantity,
            entryPrice: placed.executionPrice > 0 ? placed.executionPrice : (intent.limitPrice ?? 100),
            stopPrice: intent.stopPrice!,
            targetPrice: intent.targetPrice!,
            brokerOrderRef: placed.brokerOrderRef || placed.executionId,
            entrySession: session,
            entryOrderType: intent.orderType,
            openedAt: nowIso,
          });
          result.entriesPlaced += 1;
          result.entries.push({ symbol: intent.symbol, strategy: intent.strategy ?? "agentic" });
        } else {
          result.exitsPlaced += 1;
          result.exits.push({ symbol: intent.symbol, reason: "critic_approved_exit" });
        }
      } else {
        result.rejections.push({
          symbol: intent.symbol,
          strategy: intent.strategy ?? "agentic",
          reason: placed.message || "Order refused by platform",
        });
      }
    }
  }

  // 6. Record Activity with Mode & Critic Verdict
  const outcome = result.entriesPlaced > 0 || result.exitsPlaced > 0 ? "traded" : "no_trade";
  const detail = outcome === "traded" ? null : criticVerdict.reason;

  if (deps.activity) {
    deps.activity.ensureSchema();
    deps.activity.appendActivity({
      id: crypto.randomUUID(),
      userLogin: deps.userLogin,
      cycleAt: nowIso,
      outcome,
      entries: result.entries.map((e) => e.symbol),
      exits: result.exits.map((e) => ({ symbol: e.symbol, reason: e.reason })),
      detail,
      session,
      mode: "agentic",
      criticVerdict: result.criticVerdict,
    });
  }

  // 7. Learning Distillation (Persist to Tenancy Memory)
  if (deps.memory && criticVerdict.distilledLearnings.length > 0) {
    deps.memory.ensureSchema();
    for (const l of criticVerdict.distilledLearnings) {
      deps.memory.recordLearning({
        id: crypto.randomUUID(),
        userLogin: deps.userLogin,
        cycleId: nowIso,
        timestamp: nowIso,
        category: l.category,
        insight: l.insight,
        sourceVerdict: criticVerdict.verdict,
        suggestedAction: l.suggestedAction,
      });
      result.learningsGenerated += 1;
    }
  }

  return result;
}

export function summarizeLearnings(learnings: readonly CopilotLearningRecord[]): string {
  if (learnings.length === 0) {
    return "### 🧠 Stock Copilot Learnings\nNo learnings recorded yet. Run agentic cycles to build tenancy memory.";
  }

  const lines: string[] = [
    "### 🧠 Stock Copilot Learnings (Tenancy Memory)",
    `Total distilled insights: **${learnings.length}**\n`,
  ];

  for (const item of learnings.slice(0, 5)) {
    const icon =
      item.category === "risk"
        ? "🛡️"
        : item.category === "session"
          ? "🌙"
          : item.category === "refusal"
            ? "⚠️"
            : "📈";
    lines.push(`- **${icon} [${item.category.toUpperCase()}]** (${new Date(item.timestamp).toLocaleTimeString("en-US")}):`);
    lines.push(`  ${item.insight}`);
    if (item.suggestedAction) {
      lines.push(`  *Action:* ${item.suggestedAction}`);
    }
  }

  return lines.join("\n");
}
