/**
 * Issue #3519 — Stock Copilot Agentic Loop.
 *
 * Implements non-deterministic dual-mode cycle operation:
 * 1. Perceive: Gathers market bars, open positions, recent activity, active session,
 *    and prior distilled learnings from tenancy memory. The learnings are not
 *    decorative (#5055): the rules in `stockCopilotLearningPolicy.ts` turn them
 *    into plan constraints - risk learnings at/above the configured threshold
 *    hold back NEW entries (exits still execute), session learnings at/above the
 *    threshold force limit-only order shaping. A failed read fails open and is
 *    recorded as a `learning_readback` cycle error.
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
import { notifyOrderExecution } from "./orderExecutionNotifier";
import {
  copilotSessionAt,
  isAroundTheClock,
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
  deriveCopilotLearningPolicy,
  neutralCopilotLearningPolicy,
  resolveCopilotLearningPolicyThresholds,
  type CopilotLearningsPolicy,
} from "./stockCopilotLearningPolicy";
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
    /** #5055: what the prior learnings told this plan to do. */
    learningsPolicy: CopilotLearningsPolicy;
  };
  criticVerdict: CopilotCriticVerdict;
  learningsGenerated: number;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Issue #3899 (RC2) — record an agentic refusal as activity,
 * mirroring the deterministic path's `appendCycleActivity`
 * (src/services/stockCopilot.ts): one record per refused firing,
 * `mode: "agentic"`, the refusal code as `detail`, so `lastCycle`
 * reflects every firing. Best-effort: a store failure is collected
 * as a cycle error, never thrown — a record failure must not fail
 * the cycle that was refused.
 */
function recordAgenticRefusal(
  deps: StockCopilotDeps & { memory?: StockCopilotMemoryPort },
  result: StockCopilotAgenticCycleResult,
  cycleAt: string,
  outcome: "refused" | "inactive" | "outside_sessions",
  detail: string,
  session: CopilotSessionId | null,
): void {
  if (!deps.activity) return;
  try {
    deps.activity.ensureSchema();
    deps.activity.appendActivity({
      id: crypto.randomUUID(),
      userLogin: deps.userLogin,
      cycleAt,
      outcome,
      entries: [],
      exits: [],
      detail,
      session,
      mode: "agentic",
    });
  } catch (err) {
    result.errors.push({
      symbol: "",
      stage: "activity",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Issue #3899 (RC2) — the outside-enabled-sessions transition
 * record: one record per state change, mirroring the deterministic
 * path's `recordOutsideSessionsTransition` (#3398). A firing whose
 * state matches the latest record's outside state writes nothing,
 * so a persistent outside-sessions state is visible from the moment
 * it began without a record per firing.
 */
function recordAgenticOutsideSessionsTransition(
  deps: StockCopilotDeps & { memory?: StockCopilotMemoryPort },
  result: StockCopilotAgenticCycleResult,
  cycleAt: string,
  session: CopilotSessionId | null,
): void {
  if (!deps.activity) return;
  const detail = `${STOCK_COPILOT_OUTSIDE_ENABLED_SESSIONS}:${session ?? "none"}`;
  try {
    deps.activity.ensureSchema();
    const last = deps.activity.listActivity(deps.userLogin, 1)[0];
    if (last && last.outcome === "outside_sessions" && last.detail === detail) {
      return;
    }
  } catch (err) {
    result.errors.push({
      symbol: "",
      stage: "activity",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  recordAgenticRefusal(deps, result, cycleAt, "outside_sessions", detail, session);
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
      learningsPolicy: neutralCopilotLearningPolicy(true),
    },
    criticVerdict: {
      verdict: "accept",
      reason: "",
    },
    learningsGenerated: 0,
  };

  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();

  // 1. Core Gate Verification
  if (!isStockCopilotPaperEnabled(deps.env)) {
    result.status = "disabled";
    // Issue #3899 (RC2): a refused cycle is a recorded cycle — the
    // deterministic path records its refusals, and the agentic path
    // must too, so lastCycle reflects every firing.
    recordAgenticRefusal(deps, result, nowIso, "refused", "disabled", null);
    return result;
  }

  // 2. Session Perception
  const enabledSessions =
    deps.enabledSessions ?? resolveCopilotSessions({ env: deps.env });
  const aroundTheClock =
    deps.aroundTheClock ??
    isAroundTheClock({
      env: deps.env,
    });
  const session = copilotSessionAt(now, aroundTheClock);
  result.session = session;
  result.enabledSessions = [...enabledSessions];
  result.plan.perceivedSession = session;

  // Mode Selection Gates
  if (!deps.selection.resolved) {
    result.status = "mode_unresolved";
    result.refusal = STOCK_COPILOT_MODE_UNRESOLVED;
    // Issue #3899 (RC2): record the refusal — see the disabled gate.
    recordAgenticRefusal(deps, result, nowIso, "refused", STOCK_COPILOT_MODE_UNRESOLVED, session);
    return result;
  }
  const selection = deps.selection.selection;
  if (selection.brokerId !== COPILOT_BROKER_ID) {
    const isBrokerNeutral =
      String(deps.env.STOCK_COPILOT_BROKER_NEUTRAL ?? "").toLowerCase() === "true" ||
      deps.env.STOCK_COPILOT_BROKER_ID === selection.brokerId;
    if (!isBrokerNeutral) {
      result.status = "inactive_broker";
      result.refusal = STOCK_COPILOT_INACTIVE_BROKER;
      // Issue #3899 (RC2): record the refusal — see the disabled gate.
      recordAgenticRefusal(deps, result, nowIso, "inactive", STOCK_COPILOT_INACTIVE_BROKER, session);
      return result;
    }
  }

  // Session Enablement Gate
  if (!session || !enabledSessions.includes(session)) {
    result.status = "outside_enabled_sessions";
    result.refusal = `${STOCK_COPILOT_OUTSIDE_ENABLED_SESSIONS}:${session ?? "none"}`;
    // Issue #3899 (RC2): record the refusal — one transition record
    // per state change, mirroring the deterministic path (#3398), so
    // a persistent outside-sessions state does not spam the feed.
    recordAgenticOutsideSessionsTransition(deps, result, nowIso, session);
    return result;
  }

  // 1b. Prior-learning read-back (#5055). The loop distils a learning every
  // cycle; this is the read that makes the distillate a decision input. The
  // read is best-effort: a storage fault is a recorded cycle error and the
  // policy fails open (a blip must not halt a cycle) - it never invents a
  // constraint. `COPILOT_LEARNING_READBACK_ENABLED=false` skips it entirely.
  const learningThresholds = resolveCopilotLearningPolicyThresholds(deps.env);
  let learningsPolicy = neutralCopilotLearningPolicy(
    learningThresholds.enabled,
  );
  if (learningThresholds.enabled && deps.memory) {
    try {
      deps.memory.ensureSchema();
      const priorLearnings = deps.memory.listLearnings(
        deps.userLogin,
        learningThresholds.window,
      );
      learningsPolicy = deriveCopilotLearningPolicy(
        priorLearnings,
        learningThresholds,
      );
    } catch (err) {
      result.errors.push({
        symbol: "",
        stage: "learning_readback",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  result.plan.learningsPolicy = learningsPolicy;

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

  // Evaluate candidate entries for universe. A risk-learning block holds back
  // new entries only; the exit loop above has already run.
  for (const sym of learningsPolicy.blockEntries ? [] : universe) {
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
          const sessionShape = shapeCopilotSessionOrder(session, last);
          // #5055: a session learning makes new entries limit-only even in
          // the regular session, where the default shape is a market order.
          const orderType = learningsPolicy.requireLimitOrders
            ? ("LIMIT" as const)
            : sessionShape.orderType;
          const limitPrice = round2(last);

          proposedIntents.push({
            symbol: sym,
            action: "BUY",
            quantity: 10, // Sizing constraint
            orderType,
            limitPrice: orderType === "LIMIT" ? limitPrice : undefined,
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
  const learningNote = learningsPolicy.enabled
    ? ` Prior learnings read: ${learningsPolicy.considered} (risk ${learningsPolicy.riskCount}, session ${learningsPolicy.sessionCount}, refusal ${learningsPolicy.refusalCount}); ${learningsPolicy.reason}`
    : " Learning read-back disabled.";
  result.plan.reasoning = `Perceived ${openPositions.length} open positions and ${universe.length} universe tickers; identified ${proposedIntents.length} trade intent(s).${learningNote}`;

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
        await notifyOrderExecution(deps.env, {
          orderId: placed.brokerOrderRef || placed.executionId || `copilot-agentic-${intent.symbol}-${nowIso}`,
          broker: deps.selection.resolved ? deps.selection.selection.brokerId : "broker",
          mode: deps.selection.resolved ? deps.selection.selection.mode : "paper",
          symbol: intent.symbol,
          action: intent.action,
          quantity: intent.quantity,
          orderType: intent.orderType,
          price: placed.executionPrice > 0 ? placed.executionPrice : intent.limitPrice,
          takeProfitPrice: intent.targetPrice,
          stopLossPrice: intent.stopPrice,
          status: "executed",
          origin: "stock_copilot_agentic",
          userLogin: deps.userLogin,
          session: session ?? undefined,
          strategy: intent.strategy ?? "agentic",
          reason: criticVerdict.reason,
          timestamp: nowIso,
        });
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
