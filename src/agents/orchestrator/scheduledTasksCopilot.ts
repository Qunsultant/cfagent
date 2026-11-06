/**
 * Issue #3391: the Stock Copilot's Think scheduled-task declaration —
 * extracted from OrchestratorAgent in the #992/#2693 pattern (the
 * class owns storage, ORM and audit; this module owns the declaration
 * and the cycle invocation, through the explicit context below).
 *
 * The task is declared ONLY on instances where both gates hold:
 * - the STOCK_COPILOT_PAPER_ENABLED flag is on (default OFF — flag-off
 *   instances declare nothing, run no cycles, place no orders), and
 * - the instance holds a screener execution context (the per-login
 *   instances that carry an acting identity; context-less instances
 *   declare nothing, exactly as the #2693 observe task gates).
 *
 * Cadence: "every 30 minutes" (Think's interval grammar) — aligned
 * with the fastest recurring cadence this platform's scheduling
 * already runs (the Workers cron set's finest trigger is the `*\/30`
 * tick; no new cron can be added, the account is at its trigger
 * ceiling — see wrangler.jsonc). The cycle
 * itself re-checks the flag, the trading-mode selection, and market
 * hours on every firing, so a declaration that outlives a config
 * change still cannot trade.
 *
 * Issue #3451: the cycle's trading mode comes from the panel menu's
 * selection model (../copilotTradingMode.ts) — the tenant's active
 * broker and this login's stored trade environment — resolved here
 * at firing time. The screener execution context contributes ONLY
 * the acting login: its environment snapshot is not a trading mode
 * and no longer reaches the platform or the cycle (that conflation
 * refused every cycle in a PROD context, whatever the menu said).
 *
 * Issue #3398: the cycle's enabled trading sessions are likewise
 * resolved here at firing time (../../services/stockCopilotSessions.ts)
 * from the login's stored session setting over the deployment env —
 * the cycle itself re-checks them on every firing, so a settings
 * change takes effect at the next cycle without any redeclaration.
 */

import type { AgentContext } from "agents";
import type { DatabaseORM, SqlStorage } from "../../orm";
import type {
  ThinkScheduledTaskContext,
  ThinkScheduledTasks,
} from "../../actors/thinkAdapter";
import type { Env } from "../../types";
import type { ScreenerExecutionContext } from "./scheduleMaintenance";
import { resolveCopilotTradingSelection } from "../copilotTradingMode";
import type { CommercialStore } from "../../data/commercialPorts";
import {
  createStockCopilotActivityPort,
  createStockCopilotControlPort,
  createStockCopilotPositionPort,
} from "../../data/createStockCopilotStorePorts";
import { MarketDataResearchService } from "../../services/marketDataResearch";
import {
  copilotUniverseFromEnv,
  isStockCopilotPaperEnabled,
  runStockCopilotCycle,
} from "../../services/stockCopilot";
import { resolveCopilotSessions } from "../../services/stockCopilotSessions";
import {
  DEFAULT_STOCK_COPILOT_SCHEDULE,
  resolveCopilotCadence,
} from "../../services/stockCopilotCadence";
import { TradingPlatformRegistry } from "../../trading";

/** The one code-declared task this slice arms. */
export const STOCK_COPILOT_TASK_ID = "stock-copilot-paper-cycle";
/** 30 minutes — the platform's fastest existing scheduling cadence (default). */
export const STOCK_COPILOT_SCHEDULE = DEFAULT_STOCK_COPILOT_SCHEDULE;

/**
 * Ports the copilot declaration receives from the class. Storage, ORM
 * and audit ownership stay in OrchestratorAgent; these are bound
 * views of the class's own members.
 */
export interface ScheduledTasksCopilotContext {
  env: Env;
  agentCtx: AgentContext;
  getScreenerExecutionContext: () => Promise<ScreenerExecutionContext | undefined>;
  getOrm: () => DatabaseORM | undefined;
  /** The instance's settings reader (#3451: the stored trade
   *  environment the mode selection reads, #2482/#3382). */
  readSettingRaw: (key: string) => string | null;
  /** #3451 composition seam for the broker-selection read: when
   *  omitted, the resolver composes the commercial store from env;
   *  tests inject the store directly. */
  commercial?: CommercialStore | null;
  audit: (
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ) => void;
}

/**
 * Run one cycle for the instance's login. Best-effort by design — the
 * handler must never throw (a thrown handler invites engine retries
 * that could double-fire a cycle), and the cycle itself already
 * collects per-symbol failures into its result instead of throwing.
 */
export async function runStockCopilotCycleForInstance(
  ctx: ScheduledTasksCopilotContext,
  executionContext: ScreenerExecutionContext,
  taskCtx: ThinkScheduledTaskContext,
): Promise<void> {
  const sql = (ctx.agentCtx?.storage as unknown as { sql?: SqlStorage } | undefined)?.sql;
  if (!sql) return;
  const userLogin = executionContext.userLogin;
  // #3451: resolve the active broker + mode for this login from the
  // panel menu's selection model. The platform is constructed under
  // the SELECTED environment, so its own credential pair and base
  // URL follow the mode; an unresolved selection constructs it
  // unselected and the cycle refuses before touching it.
  const selection = await resolveCopilotTradingSelection({
    env: ctx.env,
    readSettingRaw: ctx.readSettingRaw,
    commercial: ctx.commercial,
  });
  const platform = TradingPlatformRegistry.getPlatform(
    "alpaca",
    ctx.env,
    ctx.getOrm(),
    userLogin,
    selection.resolved ? selection.selection.environment : undefined,
  );
  const marketData = new MarketDataResearchService(ctx.env);
  // #3398: the user's enabled trading sessions, resolved at firing
  // time from the same settings the status route reports — the
  // per-login stored choice wins, the deployment env is the
  // default, regular-only when neither speaks.
  const enabledSessions = resolveCopilotSessions({
    readSettingRaw: ctx.readSettingRaw,
    env: ctx.env,
  });
  const result = await runStockCopilotCycle({
    env: ctx.env,
    positions: createStockCopilotPositionPort(sql),
    // #3422: the chat-tab surface's ports over the same storage —
    // the pause control the cycle reads at firing, and the
    // activity log the panel reads back.
    control: createStockCopilotControlPort(sql),
    activity: createStockCopilotActivityPort(sql),
    userLogin,
    platform,
    selection,
    enabledSessions,
    universe: copilotUniverseFromEnv(ctx.env),
    loadBars: async (symbol: string) => {
      // The facade's alpaca-first order with explicit-unavailable
      // failure (#923): no synthetic bars are ever substituted, so a
      // data outage surfaces as a cycle error entry, never a trade
      // on invented prices.
      const bars = await marketData.getHistoricalBars(symbol, "1D", 60, "alpaca");
      return bars
        .map((b) => b.close)
        .filter((c) => Number.isFinite(c) && c > 0);
    },
  });
  ctx.audit("stock_copilot.cycle", "orchestrator", {
    taskId: taskCtx.taskId,
    userLogin,
    status: result.status,
    session: result.session,
    enabledSessions: result.enabledSessions,
    entriesPlaced: result.entriesPlaced,
    exitsPlaced: result.exitsPlaced,
    rejections: result.rejections.length,
    errors: result.errors.length,
  });
}

/**
 * The getScheduledTasks() contribution for OrchestratorAgent: exactly
 * one copilot cycle task, and only on flag-enabled instances holding
 * a login context. Re-declaring is a no-op shape-wise (Think
 * reconciles by task id + schedule hash).
 */
export async function declareStockCopilotTasks(
  ctx: ScheduledTasksCopilotContext,
): Promise<ThinkScheduledTasks> {
  if (!isStockCopilotPaperEnabled(ctx.env)) return {};
  const executionContext = await ctx
    .getScreenerExecutionContext()
    .catch(() => undefined);
  if (!executionContext?.userLogin) return {};
  const cadence = resolveCopilotCadence({
    env: ctx.env,
    readSettingRaw: ctx.readSettingRaw,
  });
  return {
    [STOCK_COPILOT_TASK_ID]: {
      schedule: cadence.effective,
      handler: async (taskCtx: ThinkScheduledTaskContext): Promise<void> => {
        await runStockCopilotCycleForInstance(ctx, executionContext, taskCtx).catch(
          () => {
            // Best-effort: a failed cycle is visible in the audit the
            // cycle emits per firing when it runs; a throw here would
            // only invite a retry double-fire.
          },
        );
      },
    },
  };
}
