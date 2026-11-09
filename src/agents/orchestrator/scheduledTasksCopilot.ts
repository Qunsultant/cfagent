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
import { COPILOT_BROKER_ID, resolveCopilotTradingSelection } from "../copilotTradingMode";
import { brokerCopilotCapability, isCopilotBroker, type BrokerId } from "../../trading";
import type { CommercialStore } from "../../data/commercialPorts";
import {
  createStockCopilotActivityPort,
  createStockCopilotControlPort,
  createStockCopilotMemoryPort,
  createStockCopilotPositionPort,
} from "../../data/createStockCopilotStorePorts";
import { MarketDataResearchService } from "../../services/marketDataResearch";
import {
  copilotUniverseFromEnv,
  isStockCopilotPaperEnabled,
  runStockCopilotCycle,
} from "../../services/stockCopilot";
import { isAroundTheClock, resolveCopilotSessions } from "../../services/stockCopilotSessions";
import {
  DEFAULT_STOCK_COPILOT_SCHEDULE,
  resolveCopilotCadence,
} from "../../services/stockCopilotCadence";
import { resolveCopilotExecutionMode } from "../../services/stockCopilotExecutionMode";
import {
  resolveCopilotUniverse,
  resolveCopilotStrategies,
} from "../../services/stockCopilotConfiguration";
import {
  classifyCopilotNonDeclaration,
  copilotCycleErrorCode,
  copilotCycleLedgerOutcome,
  type CopilotNonDeclarationCause,
} from "../../services/scheduleWatchdog";
import { recordScheduleCallbackRun } from "./scheduleCallbackRunRecords";
import { TradingPlatformRegistry } from "../../trading";

/** The one code-declared task this slice arms. */
export const STOCK_COPILOT_TASK_ID = "stock-copilot-paper-cycle";
/** 30 minutes — the platform's fastest existing scheduling cadence (default). */
export const STOCK_COPILOT_SCHEDULE = DEFAULT_STOCK_COPILOT_SCHEDULE;

/**
 * Issue #3788: dedup for the non-declaration audit — one audit per
 * cause class, re-emitted only when the cause changes or 24h pass, so
 * declaration reconciliation never spams audit. Durable in the
 * agent's storage when available (survives isolate restarts); a
 * module-level fallback covers contexts without storage (unit
 * harnesses). The stored value is { cause, atMs }.
 */
const COPILOT_NOT_DECLARED_KEY = "stockCopilotNotDeclared";
const COPILOT_NOT_DECLARED_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
let fallbackNotDeclared: { cause: CopilotNonDeclarationCause; atMs: number } | null = null;

function readNotDeclaredState(
  value: unknown,
): { cause: CopilotNonDeclarationCause; atMs: number } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.cause !== "flag_off" && v.cause !== "no_login_context" && v.cause !== "context_error") {
    return null;
  }
  if (typeof v.atMs !== "number" || !Number.isFinite(v.atMs)) return null;
  return { cause: v.cause, atMs: v.atMs };
}

async function emitCopilotNotDeclared(
  ctx: ScheduledTasksCopilotContext,
  cause: CopilotNonDeclarationCause,
  nowMs: number = Date.now(),
): Promise<void> {
  const storage = (
    ctx.agentCtx as unknown as
      | { storage?: { get: (key: string) => Promise<unknown>; put: (key: string, value: unknown) => Promise<void> } }
      | undefined
  )?.storage;
  let last: { cause: CopilotNonDeclarationCause; atMs: number } | null = null;
  let useStorage = false;
  try {
    if (storage && typeof storage.get === "function") {
      last = readNotDeclaredState(await storage.get(COPILOT_NOT_DECLARED_KEY));
      useStorage = true;
    }
  } catch {
    last = null;
  }
  if (!useStorage) last = fallbackNotDeclared;
  if (last && last.cause === cause && nowMs - last.atMs < COPILOT_NOT_DECLARED_DEDUP_WINDOW_MS) {
    return;
  }
  const next = { cause, atMs: nowMs };
  try {
    if (useStorage) await storage!.put(COPILOT_NOT_DECLARED_KEY, next);
    else fallbackNotDeclared = next;
  } catch {
    // Dedup is best-effort; the audit below is the signal.
  }
  ctx.audit("stock_copilot.not_declared", "orchestrator", {
    code: cause,
    taskId: STOCK_COPILOT_TASK_ID,
  });
}

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
  if (!sql) {
    // Issue #3788: the silent early return is now an auditable signal
    // with a cause code, so "copilot never ran" is distinguishable
    // from "copilot ran and did nothing".
    ctx.audit("stock_copilot.no_sql_storage", "orchestrator", {
      code: "no_sql_storage",
      taskId: taskCtx.taskId,
      userLogin: executionContext.userLogin,
    });
    return;
  }
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
  // Issue #3839: the platform follows the SELECTED broker; the catalog's
  // copilot capability supplies the bars provider. No broker is hardcoded.
  const selectedBroker: BrokerId =
    selection.resolved && isCopilotBroker(selection.selection.brokerId)
      ? selection.selection.brokerId
      : COPILOT_BROKER_ID;
  const copilotCapability = brokerCopilotCapability(selectedBroker);
  const platform = TradingPlatformRegistry.getPlatform(
    selectedBroker,
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
  // Issue #3788: Think task firings are recorded in the runs ledger
  // (recordScheduleCallbackRun, the orchestrator-schedule seam) with
  // the cycle result's status mapped to the ledger outcome — "ok" is
  // the only success, every refusal state is a skip. The per-firing
  // stock_copilot.cycle audit still fires inside, unchanged. A cycle
  // that throws records a failure and rethrows to the handler, whose
  // catch audits it with a code.
  await recordScheduleCallbackRun(
    sql,
    "stock-copilot-paper-cycle",
    { scheduleId: STOCK_COPILOT_TASK_ID, trigger: "scheduled" },
    { id: taskCtx.taskId },
    async () => {
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
        aroundTheClock: isAroundTheClock({
          readSettingRaw: ctx.readSettingRaw,
          env: ctx.env,
        }),
        universe: resolveCopilotUniverse({
          readSettingRaw: ctx.readSettingRaw,
          env: ctx.env,
        }),
        strategies: resolveCopilotStrategies({
          readSettingRaw: ctx.readSettingRaw,
          env: ctx.env,
        }),
        executionMode: resolveCopilotExecutionMode({
          readSettingRaw: ctx.readSettingRaw,
          env: ctx.env,
        }),
        memory: createStockCopilotMemoryPort(sql),
        loadBars: async (symbol: string) => {
          // The facade's provider order with explicit-unavailable failure
          // (#923): no synthetic bars are ever substituted, so a data
          // outage surfaces as a cycle error entry, never a trade on
          // invented prices. The provider is the broker catalog's
          // declared copilot bars provider (#3839).
          const bars = await marketData.getHistoricalBars(symbol, "1D", 60, copilotCapability.barsProvider);
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
      return copilotCycleLedgerOutcome(result.status, result.refusal);
    },
  );
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
  // Issue #3788: every non-declaration path emits an auditable signal
  // with its cause class, so "copilot never ran" is distinguishable
  // from "copilot ran and did nothing". The signal is deduped on
  // change of cause class (or 24h) so declaration reconciliation
  // never spams audit.
  if (!isStockCopilotPaperEnabled(ctx.env)) {
    await emitCopilotNotDeclared(ctx, "flag_off");
    return {};
  }
  let executionContext: ScreenerExecutionContext | undefined;
  let contextError = false;
  try {
    executionContext = await ctx.getScreenerExecutionContext();
  } catch {
    contextError = true;
  }
  const cause = classifyCopilotNonDeclaration({
    flagEnabled: true,
    contextError,
    hasLogin: Boolean(executionContext?.userLogin),
  });
  if (cause) {
    await emitCopilotNotDeclared(ctx, cause);
    return {};
  }
  if (!executionContext?.userLogin) {
    // Unreachable in practice: the classifier returns
    // "no_login_context" for this case and we returned above. Kept
    // as a type-level guard so the handler below receives a defined
    // context with a login.
    return {};
  }
  const cadence = resolveCopilotCadence({
    env: ctx.env,
    readSettingRaw: ctx.readSettingRaw,
  });
  return {
    [STOCK_COPILOT_TASK_ID]: {
      schedule: cadence.effective as any,
      handler: async (taskCtx: ThinkScheduledTaskContext): Promise<void> => {
        await runStockCopilotCycleForInstance(ctx, executionContext, taskCtx).catch(
          (err: unknown) => {
            // Issue #3788: best-effort still — a throw here would invite
            // a retry double-fire — but no longer silent: the failure
            // is audited with an error CODE, never a swallowed message.
            ctx.audit("stock_copilot.cycle_failed", "orchestrator", {
              code: copilotCycleErrorCode(err),
              taskId: taskCtx.taskId,
              userLogin: executionContext!.userLogin,
            });
          },
        );
      },
    },
  };
}
