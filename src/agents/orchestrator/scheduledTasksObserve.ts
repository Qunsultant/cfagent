/**
 * Issue #2693 (#2494 Think adoption, screener slice 1): observe-only
 * adoption of Think's code-declared scheduled tasks
 * (getScheduledTasks) for the options strategy-scan baseline —
 * extracted from OrchestratorAgent (src/agents/orchestrator.ts) in
 * the #992 pattern. The class owns storage and audit; this module
 * owns the declaration and the occurrence recording, through the
 * explicit context below.
 *
 * OBSERVE ONLY. The declared task's handler records each occurrence
 * and NEVER dispatches the scan: the existing "35 * * * *" Agents
 * SDK cron row (STRATEGY_SCAN_CRON, armed by
 * scheduleMaintenance.ts) keeps firing autonomousOptionsAnalysis
 * exactly as today. Think's interval grammar cannot express the
 * :35 cron and the SDK typings do not specify an interval task's
 * firing phase, so this slice collects the production evidence
 * (observed phase + cadence stability) for the follow-up
 * dispatch-flip decision — a separate owner decision, not part of
 * this slice.
 *
 * The declaration is gated on the instance's stored screener
 * execution context: the per-login instances that hold the baseline
 * SDK row are exactly the instances holding that context, and
 * context-less instances declare nothing.
 */

import type { AgentContext } from "agents";
import type { AgentName } from "../../types";
import type {
  ThinkScheduledTaskContext,
  ThinkScheduledTasks,
} from "../../actors/thinkAdapter";
import type { ScreenerExecutionContext } from "./scheduleMaintenance";

/** The one code-declared task this slice arms (observe-only). */
export const STRATEGY_SCAN_OBSERVE_TASK_ID = "options-strategy-scan-observe";
/**
 * Think's interval grammar has no cron form; "every 1 hour" is the
 * closest declaration to the baseline's hourly cadence. Its firing
 * phase is anchored at reconcile time and is NOT :35 — the phase is
 * what the occurrence ledger below exists to observe.
 */
export const STRATEGY_SCAN_OBSERVE_SCHEDULE = "every 1 hour" as const;
/** DO-storage key for the capped occurrence ledger. */
export const STRATEGY_SCAN_OBSERVE_LEDGER_KEY = "screener:strategy-scan-observe:occurrences";
/** Ledger cap — the ScheduledAgent tickHistory pattern (newest 50). */
export const STRATEGY_SCAN_OBSERVE_LEDGER_CAP = 50;

/** One recorded firing of the observe task. */
export interface StrategyScanObserveOccurrence {
  taskId: string;
  scheduledFor: number;
  occurrenceKey: string;
  idempotencyKey: string;
  /** Minute of the hour (UTC) the occurrence was scheduled for. */
  phaseMinuteUtc: number;
  recordedAt: string;
}

/**
 * Ports the observe functions receive from the class. Storage and
 * audit ownership stay in OrchestratorAgent; these are bound views
 * of the class's own members. There is deliberately NO dispatch
 * port: the handler cannot invoke the scan through this context.
 */
export interface ScheduledTasksObserveContext {
  agentCtx: AgentContext;
  getScreenerExecutionContext: () => Promise<ScreenerExecutionContext | undefined>;
  audit: (type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>) => void;
}

/**
 * Record one firing of the observe task: append to the capped
 * DO-storage ledger (newest first) and emit the audit record
 * carrying the occurrence's identity fields + firing phase.
 * Best-effort by design — the handler must never throw (a thrown
 * handler invites engine retries that would double-record), and the
 * class's audit() already swallows its own failures.
 */
export async function recordStrategyScanObserveOccurrence(
  ctx: ScheduledTasksObserveContext,
  taskCtx: ThinkScheduledTaskContext,
): Promise<void> {
  const occurrence: StrategyScanObserveOccurrence = {
    taskId: taskCtx.taskId,
    scheduledFor: taskCtx.scheduledFor,
    occurrenceKey: taskCtx.occurrenceKey,
    idempotencyKey: taskCtx.idempotencyKey,
    phaseMinuteUtc: new Date(taskCtx.scheduledFor).getUTCMinutes(),
    recordedAt: new Date().toISOString(),
  };
  const storage = ctx.agentCtx?.storage;
  if (storage && typeof storage.get === "function" && typeof storage.put === "function") {
    try {
      const existing =
        (await storage.get<StrategyScanObserveOccurrence[]>(STRATEGY_SCAN_OBSERVE_LEDGER_KEY)) ?? [];
      await storage.put(STRATEGY_SCAN_OBSERVE_LEDGER_KEY, [occurrence, ...existing].slice(0, STRATEGY_SCAN_OBSERVE_LEDGER_CAP));
    } catch {
      // Ledger write failed: fall through to the audit record,
      // which is the second evidence surface for the same firing.
    }
  }
  const executionContext = await ctx.getScreenerExecutionContext().catch(() => undefined);
  ctx.audit("schedule.observe_occurrence", "orchestrator", {
    taskId: occurrence.taskId,
    scheduledFor: occurrence.scheduledFor,
    occurrenceKey: occurrence.occurrenceKey,
    idempotencyKey: occurrence.idempotencyKey,
    phaseMinuteUtc: occurrence.phaseMinuteUtc,
    userLogin: executionContext?.userLogin,
  });
}

/**
 * The getScheduledTasks() declaration for OrchestratorAgent:
 * exactly one observe-only task, and only on instances holding a
 * screener execution context. Re-declaring is a no-op shape-wise
 * (Think reconciles by task id + schedule hash), so repeated
 * startup reconciliation changes nothing.
 */
export async function declareStrategyScanObserveTasks(
  ctx: ScheduledTasksObserveContext,
): Promise<ThinkScheduledTasks> {
  const executionContext = await ctx.getScreenerExecutionContext();
  if (!executionContext?.userLogin) return {};
  return {
    [STRATEGY_SCAN_OBSERVE_TASK_ID]: {
      schedule: STRATEGY_SCAN_OBSERVE_SCHEDULE,
      handler: async (taskCtx: ThinkScheduledTaskContext): Promise<void> => {
        await recordStrategyScanObserveOccurrence(ctx, taskCtx);
      },
    },
  };
}
