/**
 * Issue #992: Schedule maintenance (screener execution context, legacy schedule migration, strategy-scan arming) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * ScheduleMaintenanceContext.
 */

import type { AgentContext, Schedule, ScheduleOptions } from "agents";
import type { AgentName, Env } from "../../types";
import { defaultAccountTypeForCallback } from "../../config/accountBindings";
import { resolveValidatedExecutionAccountContext } from "../../services/accountBindings";
import { createUnifiedSchedulePorts } from "../../data/createUnifiedSchedulePorts";
import { stampScheduleProvenance, systemProvenance } from "../../services/consolidatedScheduling";
import {
  STRATEGY_SCAN_BASELINE_ORIGIN,
  ivHistoryCollectionToRecord,
  strategyScanBaselineToRecord,
} from "../../services/unifiedScheduleManagement";
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
  /** Issue #5100 (F3 of #5094): the deployment env, so the baseline
   *  arm can resolve the tenant's broker selection + binding. */
  env?: Env;
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
  // (shared_orchestrator / the legacy default address) or a malformed
  // value; the
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
 * Issue #3121 #4236 — the unified store behind a baseline
 * arm/adoption, or null when the host has no DO SQLite. A missing
 * store never fails the arm: the scan is armed, and the management
 * path adopts the record on first touch. Issue #3121 #4238 reuses
 * it for the IV collection adoption (same store, same rule).
 */
function unifiedScheduleStore(ctx: ScheduleMaintenanceContext) {
  try {
    return createUnifiedSchedulePorts({
      sql: ctx.agentCtx.storage.sql,
      storage: ctx.agentCtx.storage,
    }).unifiedSchedulesSync;
  } catch {
    return null;
  }
}

/**
 * Issue #3121 #4236 — adopt an already-armed baseline into the
 * unified store: save the record, never re-arm. A record that
 * already exists is left untouched (its creation time stands).
 */
async function adoptStrategyScanBaselineRecord(
  ctx: ScheduleMaintenanceContext,
  alarm: Schedule<unknown>,
  context: ScreenerExecutionContext,
): Promise<void> {
  try {
    const store = unifiedScheduleStore(ctx);
    if (!store) return;
    const item = alarm as any;
    const alarmId = typeof item.id === "string" && item.id ? item.id : null;
    if (!alarmId) return;
    if (store.get(alarmId)) return;
    store.save(
      strategyScanBaselineToRecord(
        { id: alarmId, callback: "autonomousOptionsAnalysis", payload: item.payload },
        { userLogin: context.userLogin, cron: ctx.strategyScanCron },
        new Date().toISOString(),
      ),
    );
  } catch (error) {
    structuredLog.warn("scheduleMaintenance.strategy_scan_baseline_record_adopt_failed", {
      message:
        "[OrchestratorAgent] Could not adopt the strategy-scan baseline into the unified store:",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Issue #3121 #4236 — save the unified-store record for a just-armed
 * baseline (record id = alarm id, the #3123 screen precedent). The
 * SDK returns the armed schedule; a host that returns no id is
 * resolved by re-listing for the alarm just armed. No alarm id, or
 * a store failure, only warns — the arm already succeeded.
 */
async function saveStrategyScanBaselineRecord(
  ctx: ScheduleMaintenanceContext,
  armed: unknown,
  context: ScreenerExecutionContext,
  payload: unknown,
): Promise<void> {
  try {
    const store = unifiedScheduleStore(ctx);
    if (!store) return;
    let alarmId =
      armed && typeof armed === "object" && typeof (armed as { id?: unknown }).id === "string"
        ? ((armed as { id: string }).id as string)
        : null;
    if (!alarmId) {
      const relisted = await ctx.listSchedules().catch(() => [] as Schedule<unknown>[]);
      const match = relisted.find((s) => {
        const item = s as any;
        return (
          item.callback === "autonomousOptionsAnalysis" &&
          item.payload?.userLogin === context.userLogin
        );
      });
      alarmId =
        match && typeof (match as any).id === "string" && (match as any).id
          ? ((match as any).id as string)
          : null;
    }
    if (!alarmId) {
      structuredLog.warn("scheduleMaintenance.strategy_scan_baseline_record_no_alarm_id", {
        message:
          "[OrchestratorAgent] Strategy-scan baseline armed but no alarm id could be resolved — no unified-store record saved.",
      });
      return;
    }
    if (store.get(alarmId)) return;
    store.save(
      strategyScanBaselineToRecord(
        { id: alarmId, callback: "autonomousOptionsAnalysis", payload },
        { userLogin: context.userLogin, cron: ctx.strategyScanCron },
        new Date().toISOString(),
      ),
    );
  } catch (error) {
    structuredLog.warn("scheduleMaintenance.strategy_scan_baseline_record_save_failed", {
      message:
        "[OrchestratorAgent] Could not save the strategy-scan baseline unified-store record:",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Issue #3121 #4238 — adopt an armed IV history collection alarm
 * into the unified store: save the record, never arm, never cancel.
 * A record that already exists is left untouched (its creation time
 * stands). A pause/resume cycle keeps the record id and re-arms
 * under a new alarm id, so the live alarm's id is already that
 * record's alarmId — adopting by id alone would save a duplicate
 * record, so the alarmId scan guards it. The alarm's own cron is
 * the record's cadence (read, never a literal); a non-cron alarm
 * is not the known IV shape and is left alone.
 */
async function adoptIvHistoryCollectionRecord(
  ctx: ScheduleMaintenanceContext,
  alarm: Schedule<unknown>,
  context: ScreenerExecutionContext,
): Promise<void> {
  try {
    const store = unifiedScheduleStore(ctx);
    if (!store) return;
    const item = alarm as any;
    const alarmId = typeof item.id === "string" && item.id ? item.id : null;
    if (!alarmId) return;
    const cron = typeof item.cron === "string" && item.cron ? item.cron : null;
    if (!cron) return;
    if (store.get(alarmId)) return;
    if (store.list().some((r) => r.alarmId === alarmId)) return;
    store.save(
      ivHistoryCollectionToRecord(
        { id: alarmId, callback: "collectIvHistory", payload: item.payload },
        { userLogin: context.userLogin, cron },
        new Date().toISOString(),
      ),
    );
  } catch (error) {
    structuredLog.warn("scheduleMaintenance.iv_history_collection_record_adopt_failed", {
      message:
        "[OrchestratorAgent] Could not adopt IV history collection into the unified store:",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Issue #3121 #4238 — record the armed IV history collection alarm
 * in the unified store (record-only: nothing is armed, cancelled,
 * or re-armed here — the weekday evening alarm is the firing
 * schedule; this only records it so the home can list it and the
 * ledger can join its runs). Runs on the same authenticated
 * maintenance path as the strategy-scan baseline. An alarm for
 * another user, or one without a cron expression, is not this
 * user's IV record. A store failure only warns — adoption never
 * fails maintenance.
 */
export async function ensureIvHistoryCollectionRecord(
  ctx: ScheduleMaintenanceContext,
  context: ScreenerExecutionContext,
): Promise<void> {
  const existing = await ctx.listSchedules().catch(() => [] as Schedule<unknown>[]);
  const alarm = existing.find((s) => {
    const item = s as any;
    return (
      item.callback === "collectIvHistory" &&
      item.payload?.userLogin === context.userLogin &&
      typeof item.cron === "string" &&
      item.cron
    );
  });
  if (!alarm) return;
  await adoptIvHistoryCollectionRecord(ctx, alarm, context);
}

/**
 * Issue #6301 — the blank-broker repair sweep. Runs on the onStart
 * maintenance path (via ensureStrategyScanSchedule) so every agent
 * start re-checks the schedule store; it is idempotent by
 * construction (it only acts on payloads missing a binding-tuple
 * piece, and a re-stamped alarm is no longer blank on the next run).
 *
 * - The four broker-targeted callbacks are swept: a blank payload on
 *   any of them resolves through the one home at fire time (the
 *   guard), so the sweep's job is to FIND them and to re-stamp the
 *   one the system owns. Every blank schedule found is logged +
 *   audited with its callback and id, whether or not it is re-stamped.
 * - Only the system-owned strategy-scan baseline
 *   (`autonomousOptionsAnalysis`) is re-stamped: the system armed it,
 *   the adopt path re-creates its unified record on the next tick,
 *   and its id is the system's own. A blank baseline is re-stamped
 *   by creating the stamped alarm FIRST and cancelling the blank one
 *   after (a create failure leaves the old alarm untouched); a blank
 *   baseline is cancelled outright when a stamped baseline already
 *   exists (it is redundant). A blank baseline with no cron, a
 *   paused/disabled/deleted record, or an unresolvable binding is
 *   left alone and logged — the guard covers its firing.
 * - A blank schedule on any other broker-targeted callback is logged
 *   + audited but NOT re-stamped: its id is user-facing (a cancel +
 *   re-create would silently replace it), and the fire-time fallback
 *   covers its firing. Re-stamping user schedules is a follow-up,
 *   not a silent rewrite.
 * - The tuple resolves exactly as the arm path resolves it
 *   (resolveScreenSelection + resolveValidatedExecutionAccountContext):
 *   a re-stamp IS a re-arm, so it holds the same bar — an
 *   unresolvable selection/binding is a warn + skip, never a
 *   half-stamped alarm.
 *
 * Returns the schedule list the caller should use afterwards (the
 * input list when nothing changed, a re-list when it did, so the
 * caller's alreadyAlarm lookup cannot adopt a cancelled alarm).
 */
export async function repairBlankBrokerSchedules(
  ctx: ScheduleMaintenanceContext,
  context: ScreenerExecutionContext,
  existing: Schedule<unknown>[],
): Promise<Schedule<unknown>[]> {
  const userLogin = context.userLogin;
  const isBrokerTargeted = (callback: unknown): boolean =>
    callback === "autonomousOptionsAnalysis" ||
    callback === "autonomousMarketScreen" ||
    callback === "autonomousGoalScreen" ||
    callback === "autonomousStrategyDiscovery";
  const isBlankPayload = (payload: unknown): boolean => {
    if (!payload || typeof payload !== "object") return true;
    const p = payload as Record<string, unknown>;
    return (
      typeof p.brokerId !== "string" ||
      !p.brokerId ||
      (p.mode !== "live" && p.mode !== "paper") ||
      typeof p.accountType !== "string" ||
      !p.accountType ||
      typeof p.accountId !== "string" ||
      !p.accountId
    );
  };
  const ownBlank = existing.filter((s) => {
    const item = s as any;
    return (
      isBrokerTargeted(item.callback) &&
      item.payload?.userLogin === userLogin &&
      isBlankPayload(item.payload)
    );
  });
  if (ownBlank.length === 0) return existing;
  let changed = false;
  // Non-baseline blank schedules: found, logged, audited — not re-stamped.
  for (const blank of ownBlank) {
    const item = blank as any;
    if (item.callback === "autonomousOptionsAnalysis") continue;
    structuredLog.warn("scheduleMaintenance.blank_broker_schedule_found", {
      message: `[OrchestratorAgent] Blank-broker schedule found (not re-stamped): ${String(item.callback)} ${String(item.id ?? "?")} — it resolves to the tenant default at fire time.`,
      scheduleId: typeof item.id === "string" ? item.id : undefined,
      callback: typeof item.callback === "string" ? item.callback : undefined,
    });
    ctx.audit("schedule.blank_broker_found", "orchestrator", {
      scheduleId: typeof item.id === "string" ? item.id : undefined,
      callback: typeof item.callback === "string" ? item.callback : undefined,
      note: "blank broker/mode; resolves to the tenant default at fire time; not re-stamped (user-facing id)",
    });
  }
  const baselines = ownBlank.filter((s) => (s as any).callback === "autonomousOptionsAnalysis");
  if (baselines.length === 0) return existing;
  let stampedExists = existing.some((s) => {
    const item = s as any;
    return (
      item.callback === "autonomousOptionsAnalysis" &&
      item.payload?.userLogin === userLogin &&
      !isBlankPayload(item.payload)
    );
  });
  for (const blank of baselines) {
    const item = blank as any;
    const alarmId = typeof item.id === "string" && item.id ? item.id : null;
    const cron = typeof item.cron === "string" && item.cron ? item.cron : null;
    if (!alarmId) continue;
    const store = unifiedScheduleStore(ctx);
    const recordState = store?.get(alarmId)?.state;
    if (recordState && recordState !== "active") {
      // Paused/disabled/deleted: never silently re-arm; the guard
      // covers the firing if the schedule ever resumes.
      structuredLog.warn("scheduleMaintenance.blank_broker_schedule_paused", {
        message: `[OrchestratorAgent] Blank-broker baseline ${alarmId} is ${recordState}; left alone (never silently re-armed).`,
        scheduleId: alarmId,
      });
      ctx.audit("schedule.blank_broker_found", "orchestrator", {
        scheduleId: alarmId,
        callback: "autonomousOptionsAnalysis",
        note: `blank broker/mode; record is ${recordState}; not re-stamped`,
      });
      continue;
    }
    if (stampedExists) {
      // A stamped baseline already exists: the blank one is redundant.
      try {
        await ctx.cancelSchedule(alarmId);
        store?.remove(alarmId);
        ctx.audit("schedule.blank_broker_removed", "orchestrator", {
          scheduleId: alarmId,
          callback: "autonomousOptionsAnalysis",
          reason: "redundant blank baseline; a stamped baseline exists",
        });
        changed = true;
      } catch (error) {
        structuredLog.warn("scheduleMaintenance.blank_broker_baseline_cancel_failed", {
          message: `[OrchestratorAgent] Could not cancel redundant blank baseline ${alarmId}:`,
          scheduleId: alarmId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    if (!cron) {
      structuredLog.warn("scheduleMaintenance.blank_broker_schedule_no_cron", {
        message: `[OrchestratorAgent] Blank-broker baseline ${alarmId} has no cron expression; left alone (cannot re-arm without its cadence).`,
        scheduleId: alarmId,
      });
      ctx.audit("schedule.blank_broker_found", "orchestrator", {
        scheduleId: alarmId,
        callback: "autonomousOptionsAnalysis",
        note: "blank broker/mode; no cron expression; not re-stamped",
      });
      continue;
    }
    if (!ctx.env || !store) {
      structuredLog.warn("scheduleMaintenance.blank_broker_repair_skipped", {
        message: `[OrchestratorAgent] Blank-broker baseline ${alarmId} not re-stamped: ${!ctx.env ? "no execution environment" : "no unified schedule store"} (the guard covers its firing).`,
        scheduleId: alarmId,
      });
      continue;
    }
    // Resolve the tuple exactly as the arm path does; either failing
    // is a warn + skip, never a half-stamped alarm.
    const { resolveScreenSelection } = await import("../../services/providerConnections");
    const selection = await resolveScreenSelection({ env: ctx.env, userLogin });
    if (!selection.resolved) {
      structuredLog.warn("scheduleMaintenance.blank_broker_binding_unresolved", {
        message: `[OrchestratorAgent] Blank-broker baseline ${alarmId} not re-stamped: the tenant's broker selection could not be resolved.`,
        scheduleId: alarmId,
        error: selection.error,
      });
      ctx.audit("schedule.blank_broker_found", "orchestrator", {
        scheduleId: alarmId,
        callback: "autonomousOptionsAnalysis",
        note: "blank broker/mode; selection unresolvable; not re-stamped",
      });
      continue;
    }
    const { resolveTenantProviders } = await import("../../services/tenantProviders");
    const tenantProviders = await resolveTenantProviders(ctx.env);
    const bindingRes = await resolveValidatedExecutionAccountContext(ctx.env, userLogin, {
      broker: selection.selection.brokerId,
      mode: selection.selection.mode,
      accountType: defaultAccountTypeForCallback("autonomousOptionsAnalysis"),
      scope: "schedule",
    });
    if (!bindingRes.ok || !bindingRes.context.accountId) {
      structuredLog.warn("scheduleMaintenance.blank_broker_binding_unresolved", {
        message: `[OrchestratorAgent] Blank-broker baseline ${alarmId} not re-stamped: the bound account could not be resolved.`,
        scheduleId: alarmId,
        code: bindingRes.ok ? undefined : bindingRes.code,
        error: bindingRes.ok ? "no account id resolved" : bindingRes.error,
      });
      ctx.audit("schedule.blank_broker_found", "orchestrator", {
        scheduleId: alarmId,
        callback: "autonomousOptionsAnalysis",
        note: "blank broker/mode; bound account unresolvable; not re-stamped",
      });
      continue;
    }
    const repairedPayload = {
      ...(item.payload as Record<string, unknown>),
      brokerId: selection.selection.brokerId,
      dataProviderId: tenantProviders.dataProviderId,
      mode: selection.selection.mode,
      accountType: bindingRes.context.accountType,
      accountId: bindingRes.context.accountId,
    };
    // Create FIRST, cancel after: a create failure leaves the old
    // alarm untouched. No `idempotent` flag — the new payload differs,
    // and a dedupe by callback would silently return the blank alarm.
    let armed: unknown;
    try {
      armed = await ctx.schedule(cron, "autonomousOptionsAnalysis", repairedPayload);
    } catch (error) {
      structuredLog.warn("scheduleMaintenance.blank_broker_restamp_failed", {
        message: `[OrchestratorAgent] Blank-broker baseline ${alarmId} not re-stamped: the stamped alarm could not be created (old alarm untouched).`,
        scheduleId: alarmId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    let newId =
      armed && typeof armed === "object" && typeof (armed as { id?: unknown }).id === "string"
        ? ((armed as { id: string }).id as string)
        : null;
    if (!newId) {
      const relisted = await ctx.listSchedules().catch(() => [] as Schedule<unknown>[]);
      const match = relisted.find((s) => {
        const candidate = s as any;
        return (
          candidate.callback === "autonomousOptionsAnalysis" &&
          candidate.payload?.userLogin === userLogin &&
          candidate.payload?.brokerId === repairedPayload.brokerId &&
          candidate.payload?.accountId === repairedPayload.accountId &&
          candidate.id !== alarmId
        );
      });
      newId =
        match && typeof (match as any).id === "string" && (match as any).id
          ? ((match as any).id as string)
          : null;
    }
    try {
      await ctx.cancelSchedule(alarmId);
    } catch (error) {
      // The stamped alarm exists and the blank one survives: the next
      // tick finds the stamped baseline and cancels the blank one as
      // redundant, so this heals without a duplicate firing.
      structuredLog.warn("scheduleMaintenance.blank_broker_cancel_failed", {
        message: `[OrchestratorAgent] Blank-broker baseline ${alarmId} re-stamped as ${newId ?? "?"} but the old alarm could not be cancelled; the next tick removes it as redundant.`,
        scheduleId: alarmId,
        newScheduleId: newId ?? undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      changed = true;
      stampedExists = true;
      continue;
    }
    // Swap the unified record (best-effort; the next tick's adopt
    // heals a missing new record).
    try {
      store.remove(alarmId);
      if (newId) {
        store.save(
          strategyScanBaselineToRecord(
            { id: newId, callback: "autonomousOptionsAnalysis", payload: repairedPayload },
            { userLogin, cron },
            new Date().toISOString(),
          ),
        );
      }
    } catch (error) {
      structuredLog.warn("scheduleMaintenance.blank_broker_record_swap_failed", {
        message: `[OrchestratorAgent] Blank-broker baseline ${alarmId} re-stamped as ${newId ?? "?"} but the unified-store record could not be swapped.`,
        scheduleId: alarmId,
        newScheduleId: newId ?? undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    ctx.audit("schedule.blank_broker_repaired", "orchestrator", {
      scheduleId: alarmId,
      newScheduleId: newId ?? undefined,
      callback: "autonomousOptionsAnalysis",
      brokerId: repairedPayload.brokerId,
      mode: repairedPayload.mode,
    });
    changed = true;
    stampedExists = true;
  }
  return changed ? await ctx.listSchedules().catch(() => existing) : existing;
}

/**
 * Issue #275: arm the hourly Strategy/Symbol Scanner run once per
 * authenticated user — the full strategy catalog (no
 * allowedStrategies restriction) over the NASDAQ100 universe,
 * published through the same audit + Slack path as the equity
 * screens. Follows the ensureStaleSweepSchedule pattern, with one
 * addition: a scan the user paused in the Schedules tab (#273's
 * unified store, state paused) is never silently re-armed.
 */
export async function ensureStrategyScanSchedule(ctx: ScheduleMaintenanceContext, context: ScreenerExecutionContext): Promise<void> {
  const userLogin = context.userLogin;
  const environment = context.environment || "PROD";
  const existing = await ctx.listSchedules().catch(() => [] as Schedule<unknown>[]);
  // Issue #6301 — the blank-broker repair sweep runs first, on every
  // maintenance pass, so a pre-F3 blank baseline is re-stamped (and
  // any other blank-broker schedule is found + audited) instead of
  // being adopted as-is forever. The returned list is the
  // post-repair list, so the alreadyAlarm lookup below cannot adopt
  // a cancelled alarm.
  const current = await repairBlankBrokerSchedules(ctx, context, existing);
  const alreadyAlarm = current.find((s) => {
    const item = s as any;
    return item.callback === "autonomousOptionsAnalysis" && item.payload?.userLogin === userLogin;
  });
  if (alreadyAlarm) {
    await adoptStrategyScanBaselineRecord(ctx, alreadyAlarm, context);
    return;
  }
  try {
    const paused = createUnifiedSchedulePorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).unifiedSchedulesSync.listByState("paused");
    const pausedForUser = paused.some(
      (r) =>
        r.callback === "autonomousOptionsAnalysis" &&
        (r.definition.payload as { userLogin?: string } | undefined)?.userLogin === userLogin
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
  // Issue #5100 (F3 of #5094): the baseline arm stamps the resolved
  // binding tuple like every other creation path — a stamped payload
  // is the record of truth (the ledger reads it) even though the
  // fire-time guard now resolves an unstamped baseline from the one
  // defaults home instead of refusing it (issue #6301). The selection
  // + binding resolve here; either failing is a structured warn and
  // NO arm (best-effort function — the onStart caller already
  // try/catches).
  let baselineBrokerId: string | undefined;
  let baselineDataProviderId: string | undefined;
  let baselineMode: "live" | "paper" | undefined;
  let baselineAccountType: string | undefined;
  let baselineAccountId: string | undefined;
  if (ctx.env) {
    const { resolveScreenSelection } = await import("../../services/providerConnections");
    const selection = await resolveScreenSelection({ env: ctx.env, userLogin });
    if (!selection.resolved) {
      structuredLog.warn("scheduleMaintenance.strategy_scan_baseline_binding_unresolved", {
        message: "[OrchestratorAgent] Strategy-scan baseline NOT armed: the tenant's broker selection could not be resolved.",
        error: selection.error,
      });
      return;
    }
    const { resolveTenantProviders } = await import("../../services/tenantProviders");
    const tenantProviders = await resolveTenantProviders(ctx.env);
    const bindingRes = await resolveValidatedExecutionAccountContext(ctx.env, userLogin, {
      broker: selection.selection.brokerId,
      mode: selection.selection.mode,
      // Issue #6301: the callback's class default lives in the one
      // home (defaultAccountTypeForCallback), shared with the creation
      // route, the fire-time guard, and the blank-broker repair.
      accountType: defaultAccountTypeForCallback("autonomousOptionsAnalysis"),
      scope: "schedule",
    });
    if (!bindingRes.ok) {
      structuredLog.warn("scheduleMaintenance.strategy_scan_baseline_binding_unresolved", {
        message: "[OrchestratorAgent] Strategy-scan baseline NOT armed: the bound account could not be resolved.",
        code: bindingRes.code,
        error: bindingRes.error,
      });
      return;
    }
    baselineBrokerId = selection.selection.brokerId;
    baselineDataProviderId = tenantProviders.dataProviderId;
    baselineMode = selection.selection.mode;
    baselineAccountType = bindingRes.context.accountType;
    baselineAccountId = bindingRes.context.accountId ?? undefined;
  } else {
    structuredLog.warn("scheduleMaintenance.strategy_scan_baseline_binding_unresolved", {
      message: "[OrchestratorAgent] Strategy-scan baseline NOT armed: no execution environment is available to resolve the bound account.",
    });
    return;
  }
  const built = buildSchedulePayload(
    "autonomousOptionsAnalysis",
    { universe: "NASDAQ100" },
    {
      userLogin,
      environment,
      trigger: "scheduled",
      ...(baselineBrokerId ? { brokerId: baselineBrokerId } : {}),
      ...(baselineDataProviderId ? { dataProviderId: baselineDataProviderId } : {}),
      ...(baselineMode ? { mode: baselineMode } : {}),
      ...(baselineAccountType ? { accountType: baselineAccountType } : {}),
      ...(baselineAccountId ? { accountId: baselineAccountId } : {}),
    }
  );
  if (!built.ok) {
    // The baseline criteria are constants; a builder rejection here
    // is a programming error, surfaced loudly rather than arming a
    // hand-built fallback payload outside the one capability.
    throw new Error(`Strategy-scan baseline payload rejected: ${built.error}`);
  }
  // Issue #3121 #4236 — the armed payload carries the system
  // provenance the Schedules home badges on. The run reads its
  // known fields, so the extra key is inert at fire time.
  const armedPayload = stampScheduleProvenance(
    built.value,
    systemProvenance(STRATEGY_SCAN_BASELINE_ORIGIN),
  );
  const armed = await ctx.schedule(ctx.strategyScanCron, "autonomousOptionsAnalysis", armedPayload, {
    idempotent: true,
  });
  ctx.audit("schedule.created", "orchestrator", {
    callback: "autonomousOptionsAnalysis",
    scheduleType: "cron",
    cron: ctx.strategyScanCron,
    origin: STRATEGY_SCAN_BASELINE_ORIGIN,
  });
  // Issue #3121 #4236 — the arm saves the unified-store record
  // (id = alarm id, the #3123 screen precedent). A store failure
  // never fails the arm.
  await saveStrategyScanBaselineRecord(ctx, armed, context, armedPayload);
}
