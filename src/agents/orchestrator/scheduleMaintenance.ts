/**
 * Issue #992: Schedule maintenance (screener execution context, legacy schedule migration, strategy-scan arming) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * ScheduleMaintenanceContext.
 */

import type { AgentContext, Schedule, ScheduleOptions } from "agents";
import type { AgentName } from "../../types";
import { createOptionsDiscoveryPorts } from "../../data/createOptionsDiscoveryPorts";
import { buildSchedulePayload } from "../../trading";
import {
  isLoginShaped,
  isSharedOrchestratorAddress,
} from "../../security/serviceIdentity";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/orchestrator/scheduleMaintenance",
});

/** The screener identity a scheduled run executes as (stored per DO). */
export type ScreenerExecutionContext = { userLogin: string; environment?: "TEST" | "PROD" };

/**
 * Ports the schedule-maintenance functions receive from the class.
 * Storage, schedule registry and audit ownership stay in
 * OrchestratorAgent; these are bound views of the class's own members.
 */
export interface ScheduleMaintenanceContext {
  agentCtx: AgentContext;
  listSchedules: () => Promise<Schedule<unknown>[]>;
  cancelSchedule: (id: string) => Promise<boolean>;
  schedule: (when: Date | number | string, callback: string, payload?: unknown, options?: ScheduleOptions) => Promise<unknown>;
  audit: (type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>) => void;
  screenerExecutionContextKey: string;
  legacyScheduleMigrationKey: string;
  strategyScanCron: string;
}

export async function getScreenerExecutionContext(ctx: ScheduleMaintenanceContext): Promise<ScreenerExecutionContext | undefined> {
  // Some lightweight route harnesses omit Durable Object storage. The
  // authenticated context is best-effort in those environments; real DO
  // instances always provide storage.
  const storage = ctx.agentCtx?.storage;
  if (!storage || typeof storage.get !== "function") return undefined;
  return storage.get<ScreenerExecutionContext>(ctx.screenerExecutionContextKey);
}

/**
 * Issue #1965: scheduled-run identity resolution. The schedule payload's
 * own login wins when present: it is the login that created and owns the
 * schedule (panel-verified). The saved execution context is the fallback
 * for legacy schedules whose payloads carry no login. Previously the
 * saved context won, so a stale context (a login with no stored token)
 * blocked scheduled runs with FAILURE_AUTH_NO_SESSION while manual runs under the
 * session login passed the guard. Callers resolve environment the same
 * way (payload first, saved context second): the payload owns the
 * schedule's environment too, and the context remains the legacy
 * fallback for payloads that carry none.
 */
export function resolveScheduledLogin(
  payloadLogin: string | undefined,
  savedLogin: string | undefined,
): string | undefined {
  // #4004: the payload login is authoritative only when it can BE a
  // principal. A legacy record can carry an instance address
  // (shared_orchestrator / default_trader) or a malformed value; the
  // dispatch gate refuses those by design, so preferring them denied
  // every firing (SHARED_ADDRESS / NO_IDENTITY) while the authenticated
  // context sat right behind it. Fall back to the context the last
  // signed-in request stored; when neither is usable, return the
  // recorded value so the audit names the real reason.
  const usable = (value: string | undefined): value is string =>
    isLoginShaped(value) && !isSharedOrchestratorAddress(value);
  if (usable(payloadLogin)) return payloadLogin;
  if (usable(savedLogin)) return savedLogin;
  return payloadLogin || savedLogin;
}

/** Retire old internal maintenance jobs while preserving account screening schedules. */
export async function migrateLegacyScreenSchedules(ctx: ScheduleMaintenanceContext, context: ScreenerExecutionContext): Promise<void> {
  const storage = ctx.agentCtx?.storage;
  if (!storage || typeof storage.get !== "function" || typeof storage.put !== "function") return;
  const environment = context.environment || "PROD";
  const migrationKey = `${ctx.legacyScheduleMigrationKey}:${context.userLogin}:${environment}`;
  if (await storage.get(migrationKey)) return;
  const existing = await ctx.listSchedules();
  let cleanupComplete = true;
  for (const schedule of existing) {
    const item = schedule as any;
    const payload = item.payload || {};
    const callback = item.callback;
    const isLegacyTokenRenewal = callback === "autoRenewETradeTokens" && payload.userLogin === context.userLogin;
    const isLegacyIvCollection =
      callback === "collectIvHistory" && payload.userLogin === context.userLogin && item.cron === "15 22 * * 1-5";
    if (isLegacyTokenRenewal || isLegacyIvCollection) {
      structuredLog.warn("scheduleMaintenance.legacy_schedule_remove", {
        message: `[OrchestratorAgent] Removing app-created legacy schedule ${item.id} (${callback})`,
        scheduleId: item.id,
        callback,
      });
      try {
        await ctx.cancelSchedule(item.id);
      } catch (error) {
        cleanupComplete = false;
        structuredLog.warn("scheduleMaintenance.legacy_schedule_remove_failed", {
          message: `[OrchestratorAgent] Could not remove legacy schedule ${item.id}:`,
          scheduleId: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  if (cleanupComplete) {
    await storage.put(migrationKey, { userLogin: context.userLogin, environment, migratedAt: new Date().toISOString() });
  }
}

export async function removeUnownedBaselineSchedules(ctx: ScheduleMaintenanceContext): Promise<void> {
  const schedules = await ctx.listSchedules().catch(() => [] as Schedule<unknown>[]);
  for (const schedule of schedules) {
    const item = schedule as any;
    const payload = item.payload || {};
    const callback = item.callback;
    const orphanedBaseline =
      (["autonomousMarketScreen", "autonomousOptionsAnalysis", "autonomousStrategyDiscovery", "autonomousGoalScreen", "autoRenewETradeTokens", "collectIvHistory"].includes(callback) && !payload.userLogin);
    if (orphanedBaseline) {
      structuredLog.warn("scheduleMaintenance.unowned_baseline_schedule_remove", {
        message: `[OrchestratorAgent] Removing unowned baseline schedule ${item.id} (${callback})`,
        scheduleId: item.id,
        callback,
      });
      await ctx.cancelSchedule(item.id).catch(() => undefined);
    }
  }
}

/**
 * Issue #275: arm the hourly Strategy/Symbol Scanner run once per
 * authenticated user — the full strategy catalog (no
 * allowedStrategies restriction) over the NASDAQ100 universe,
 * published through the same audit + Slack path as the equity
 * screens. Follows the ensureStaleSweepSchedule pattern, with one
 * addition: a scan the user paused in the Schedules tab (#273's
 * paused store) is never silently re-armed.
 */
export async function ensureStrategyScanSchedule(ctx: ScheduleMaintenanceContext, context: ScreenerExecutionContext): Promise<void> {
  const userLogin = context.userLogin;
  const environment = context.environment || "PROD";
  const existing = await ctx.listSchedules().catch(() => [] as Schedule<unknown>[]);
  const already = existing.some((s) => {
    const item = s as any;
    return item.callback === "autonomousOptionsAnalysis" && item.payload?.userLogin === userLogin;
  });
  if (already) return;
  try {
    const paused = createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).pausedSchedulesSync.list();
    const pausedForUser = paused.some(
      (r) =>
        r.callback === "autonomousOptionsAnalysis" &&
        (r.payload as { userLogin?: string } | undefined)?.userLogin === userLogin
    );
    if (pausedForUser) return;
  } catch {
    // Paused-store unavailable: the SDK arming below is idempotent,
    // so a missed pause check can only re-arm a job the user can
    // pause again — never duplicate one.
  }
  // Consolidation C3 (#1277): the baseline arm builds its payload
  // through the one shared schedule builder, like every other
  // creation path — the armed record is the builder's record
  // (including the creation-default maxItems stamp, which is exactly
  // the UNIVERSES default the options service applies itself when
  // maxItems is absent, so the run's behavior is unchanged).
  const built = buildSchedulePayload(
    "autonomousOptionsAnalysis",
    { universe: "NASDAQ100" },
    { userLogin, environment, trigger: "scheduled" }
  );
  if (!built.ok) {
    // The baseline criteria are constants; a builder rejection here
    // is a programming error, surfaced loudly rather than arming a
    // hand-built fallback payload outside the one capability.
    throw new Error(`Strategy-scan baseline payload rejected: ${built.error}`);
  }
  await ctx.schedule(ctx.strategyScanCron, "autonomousOptionsAnalysis", built.value, {
    idempotent: true,
  });
  ctx.audit("schedule.created", "orchestrator", {
    callback: "autonomousOptionsAnalysis",
    scheduleType: "cron",
    cron: ctx.strategyScanCron,
    origin: "strategy-scan-baseline",
  });
}
