/**
 * Issue #6482 — stop the runaway 1–2s SCREENER_AGENT alarm loop
 * completely, through configuration.
 *
 * RED first: these tests fail until the slice lands. Nothing here
 * asserts on another issue's surface.
 *
 * Pins (6482-P01..):
 * - P01 the floor is externalized with precedence managed setting >
 *   env carrier > fail-closed default monthly (2,592,000s).
 * - P02 the ONE hard-reject helper refuses a below-floor interval
 *   and a below-floor cron with the coded outcome, and one-shot
 *   timings pass through.
 * - P03 the capability classifier refuses below-floor arms (never
 *   approval-binds them) and managing an already-armed legacy
 *   schedule (pause/delete) still works.
 * - P04 the executor refuses a 1s create with the coded outcome,
 *   arms nothing, records no pending approval, and an approved
 *   pending id does NOT arm a below-floor schedule.
 * - P05 the kill-switch halts a firing at the one choke point
 *   (recordScheduleCallbackRun): the callback does not run, a
 *   skipped ledger row names the halt; firing on lets it run; a
 *   manual trigger is never halted.
 * - P06 the managed floor + kill-switch round-trip through the UX
 *   route GET/POST /api/schedules/controls (read + write +
 *   effective value), admin-gated.
 * - P07 the armed-schedule inventory lists callback + interval +
 *   owner for every armed schedule.
 * - P08 the firing-rate alert: a configured threshold + an emitted
 *   observation the existing alerting consumes.
 * - P09 the alarms port (the generic arm) refuses below-floor arms.
 * - P10 the REST create route refuses a 1s arm even with
 *   subDailyOptIn=true: the opt-in never overrides the floor — and
 *   a monthly create lands paused (never armed), with a duplicate
 *   submit returning the same paused record.
 * - P11 a stage-schedule create lands paused (never armed).
 * - P12 the SDK adapters create paused (never armed); with no
 *   store, create is refused fail-closed; deleting a paused
 *   schedule removes its record.
 * - P13 resume is the only activation: a paused monthly schedule
 *   resumes (arms); a paused sub-monthly schedule cannot resume
 *   (floor refusal); updating a paused schedule keeps it paused.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { makeFakeSessionStore } from "./fake-session-store";
import { handleSchedulesRoutes } from "../src/agents/routes/schedules";
import { MockSqlStorage } from "./mock-sql";
import {
  AGENT_SCHEDULE_MIN_INTERVAL_ENV_VAR,
  DEFAULT_SCHEDULE_MIN_INTERVAL_SECONDS,
  SCHEDULE_MIN_INTERVAL_SETTING_KEY,
  parseScheduleMinIntervalSeconds,
  resolveScheduleMinIntervalSeconds,
} from "../src/config/scheduleFrequencyFloor";
import {
  DEFAULT_SCHEDULE_FIRING_ENABLED,
  SCHEDULE_FIRING_ENABLED_ENV_VAR,
  SCHEDULE_FIRING_ENABLED_SETTING_KEY,
  parseScheduleFiringEnabled,
  resolveScheduleFiringEnabled,
} from "../src/config/scheduleFiringKillSwitch";
import {
  DEFAULT_SCHEDULE_FIRING_RATE_ALERT_THRESHOLD,
  DEFAULT_SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES,
  resolveScheduleFiringRateAlertThreshold,
  resolveScheduleFiringRateAlertWindowMinutes,
} from "../src/config/scheduleFiringRateAlert";
import {
  DEFAULT_GOAL_RUN_JOB_RUN_RECORD_CAP,
  DEFAULT_GOAL_RUN_TICK_HISTORY_CAP,
  resolveGoalRunJobRunRecordCap,
  resolveGoalRunTickHistoryCap,
} from "../src/config/goalRunRetention";
import {
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MINUTES,
  resolveHeartbeatIntervalSecondsFrom,
  resolveHeartbeatWatchdogConfigFrom,
  resolveHeartbeatWatchdogStaleAfterMsFrom,
} from "../src/config/heartbeatWatchdog";
import {
  DEFAULT_MISSED_SCHEDULE_GRACE_MINUTES,
  resolveMissedScheduleGraceMsFrom,
} from "../src/config/missedScheduleAlert";
import {
  parseResearchScheduleUtcHour,
  resolveResearchJobConfig,
  resolveResearchScheduleUtcHour,
} from "../src/config/researchJobConfig";
import {
  DEFAULT_SCHEDULE_DUE_GUARD_MS,
  resolveScheduleDueGuardMs,
} from "../src/config/scheduleDueGuard";
import {
  DEFAULT_STALE_RUNNING_REAP_MS,
  DEFAULT_STALE_SWEEP_BATCH_LIMIT,
  resolveStaleAsyncJobReapPolicy,
} from "../src/config/staleAsyncJobReap";
import { isDue } from "../src/schedule";
import {
  isHeartbeatStale,
  resolveStaleReapPolicy,
} from "../src/agents/orchestrator/asyncJobs";
import {
  SCHEDULE_BELOW_FREQUENCY_FLOOR,
  estimateCronMinGapMinutes,
  isBelowFrequencyFloorError,
  refuseBelowFloorTiming,
} from "../src/services/scheduleFrequencyFloor";
import {
  SCHEDULE_FIRING_RATE_ALERT_LAST_AT_KEY,
  applyScheduleControlsPatch,
  buildArmedScheduleInventory,
  checkScheduleFiringRate,
  evaluateScheduleFiringRate,
  readScheduleManagedSetting,
  resolveEffectiveMissedScheduleGrace,
  resolveEffectiveScheduleFiringEnabled,
  resolveEffectiveScheduleFloor,
  resolveScheduleControlsView,
  writeScheduleManagedSetting,
} from "../src/services/scheduleControls";
import { createSettingsPort } from "../src/data/createSettingsPorts";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import { recordScheduleCallbackRun } from "../src/agents/orchestrator/scheduleCallbackRunRecords";

/** A D1 ledger for the run-record assertions: the store + the env that carries it. */
function ledgerD1() {
  const mock = new MockD1Database();
  const d1 = mock as unknown as D1Database;
  const store = new D1JobRunRecordStore(createD1JobRunRecordDb(d1));
  return { mock, store, env: { AGENT_DB: d1 } };
}
import { makeScheduleAlarmsPort } from "../src/agents/routes/schedules";
import {
  classifyAgentScheduleRequest,
  createPausedAgentSdkScheduleRecord,
  executeAgentScheduleAction,
  nlqPortToAgentSdkAdapter,
  type AgentScheduleApprovalConfig,
  type PendingScheduleApproval,
} from "../src/services/agentScheduleCapability";
import {
  createWorkflowStageSchedule,
  pausedScreenScheduleToRecord,
  reconcileSystemScheduleRecords,
  resumeUnifiedSchedule,
  updateUnifiedSchedule,
} from "../src/services/unifiedScheduleManagement";
import { createD1UnifiedSchedulePorts, createUnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { createCommercialAdapter } from "../src/data/createCommercialPorts";
import { DEFAULT_TENANT_PROVIDERS } from "../src/data/commercialPorts";
import { resolveIaaaTenant } from "../src/security/iaaaGithubEndToEnd";

/** node:sqlite double for the SqlStorage seam (same shape as #2337). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  get sql(): SqliteTestStorage {
    return this;
  }
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

/**
 * Minimal D1Database stand-in over node:sqlite (test-only, same as
 * slice 1 / tests/d1_unified_schedule_6503.test.ts). #6503 step 6(c):
 * the schedules routes build the D1 store from ctx.env.AGENT_DB and
 * refuse fail-closed when it is unbound, so route harnesses bind a
 * mock D1 here instead of leaving env empty.
 */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

const FLOOR_CONFIG: AgentScheduleApprovalConfig = {
  budgetCentsThreshold: 10_000,
  minIntervalSeconds: 2_592_000,
};

describe("6482-P01 the floor is externalized: managed > env > fail-closed default monthly", () => {
  it("the default is monthly (2,592,000s) and the env carrier keeps its existing name", () => {
    expect(DEFAULT_SCHEDULE_MIN_INTERVAL_SECONDS).toBe(2_592_000);
    expect(AGENT_SCHEDULE_MIN_INTERVAL_ENV_VAR).toBe("AGENT_SCHEDULE_MIN_INTERVAL_SECONDS");
    expect(SCHEDULE_MIN_INTERVAL_SETTING_KEY).toBe("schedule.minIntervalSeconds");
    expect(resolveScheduleMinIntervalSeconds({})).toBe(2_592_000);
  });

  it("a managed setting beats the env carrier, which beats the default", () => {
    expect(resolveScheduleMinIntervalSeconds({ managed: 7_200, env: 1_800 })).toBe(7_200);
    expect(resolveScheduleMinIntervalSeconds({ env: 1_800 })).toBe(1_800);
    expect(resolveScheduleMinIntervalSeconds({ managed: 900 })).toBe(900);
  });

  it("an invalid managed value falls through instead of disabling the floor", () => {
    expect(parseScheduleMinIntervalSeconds(0)).toBeUndefined();
    expect(parseScheduleMinIntervalSeconds(-5)).toBeUndefined();
    expect(parseScheduleMinIntervalSeconds(61.5)).toBeUndefined();
    expect(parseScheduleMinIntervalSeconds("abc")).toBeUndefined();
    expect(resolveScheduleMinIntervalSeconds({ managed: 0, env: 1_800 })).toBe(1_800);
    expect(resolveScheduleMinIntervalSeconds({ managed: 0 })).toBe(2_592_000);
  });

  it("the effective floor resolves from the managed setting over the DO store", () => {
    const sql = new SqliteTestStorage() as never;
    createSettingsPort(sql as never).ensureSchema();
    expect(resolveEffectiveScheduleFloor(sql, {}).seconds).toBe(2_592_000);
    expect(resolveEffectiveScheduleFloor(sql, {}).source).toBe("default");
    writeScheduleManagedSetting(sql, SCHEDULE_MIN_INTERVAL_SETTING_KEY, "7200");
    const effective = resolveEffectiveScheduleFloor(sql, {
      AGENT_SCHEDULE_MIN_INTERVAL_SECONDS: "1800",
    });
    expect(effective.seconds).toBe(7_200);
    expect(effective.source).toBe("managed");
    expect(effective.managed).toBe(7_200);
    expect(effective.env).toBe(1_800);
    expect(readScheduleManagedSetting(sql, SCHEDULE_MIN_INTERVAL_SETTING_KEY)).toBe("7200");
  });

  it("a missing settings table fails safe to env, then default — never to no floor", () => {
    const sql = new SqliteTestStorage() as never;
    expect(resolveEffectiveScheduleFloor(sql, { AGENT_SCHEDULE_MIN_INTERVAL_SECONDS: "1800" }).seconds).toBe(1_800);
    expect(resolveEffectiveScheduleFloor(sql, {}).seconds).toBe(2_592_000);
  });
});

describe("6482-P02 the ONE hard-reject helper", () => {
  it("refuses a 1-second interval with the coded outcome", () => {
    const out = refuseBelowFloorTiming({ type: "interval", intervalSeconds: 1 }, 2_592_000);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe(SCHEDULE_BELOW_FREQUENCY_FLOOR);
      expect(out.code).toBe("SCHEDULE_BELOW_FREQUENCY_FLOOR");
      expect(out.message).toMatch(/1s.*below.*floor.*2592000s/i);
    }
  });

  it("refuses below the floor (a daily and an hourly arm included), allows at and above it", () => {
    expect(refuseBelowFloorTiming({ type: "interval", intervalSeconds: 2_591_999 }, 2_592_000).ok).toBe(false);
    expect(refuseBelowFloorTiming({ type: "interval", intervalSeconds: 3_600 }, 2_592_000).ok).toBe(false);
    expect(refuseBelowFloorTiming({ type: "interval", intervalSeconds: 86_400 }, 2_592_000).ok).toBe(false);
    expect(refuseBelowFloorTiming({ type: "interval", intervalSeconds: 2_592_000 }, 2_592_000).ok).toBe(true);
    expect(refuseBelowFloorTiming({ type: "interval", intervalSeconds: 5_184_000 }, 2_592_000).ok).toBe(true);
  });

  it("refuses a below-floor cron gap and an unparsable cron (fail-closed); hourly and daily crons are refused, a yearly cron passes", () => {
    expect(estimateCronMinGapMinutes("*/30 * * * *")).toBe(30);
    expect(refuseBelowFloorTiming({ type: "cron", cron: "*/30 * * * *" }, 2_592_000).ok).toBe(false);
    expect(refuseBelowFloorTiming({ type: "cron", cron: "0 * * * *" }, 2_592_000).ok).toBe(false);
    expect(refuseBelowFloorTiming({ type: "cron", cron: "0 9 * * 1-5" }, 2_592_000).ok).toBe(false);
    expect(refuseBelowFloorTiming({ type: "cron", cron: "0 0 1 1 *" }, 2_592_000).ok).toBe(true);
    const unparsable = refuseBelowFloorTiming({ type: "cron", cron: "not a cron" }, 2_592_000);
    expect(unparsable.ok).toBe(false);
  });

  it("one-shot timings carry no frequency and pass through", () => {
    expect(refuseBelowFloorTiming({ type: "delayed", delayInSeconds: 1 }, 2_592_000).ok).toBe(true);
    expect(refuseBelowFloorTiming({ type: "scheduled", time: 1_700_000_000 }, 2_592_000).ok).toBe(true);
  });

  it("the refusal is a typed error the routes can map to 400", () => {
    const out = refuseBelowFloorTiming({ type: "interval", intervalSeconds: 1 }, 2_592_000);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      const err = out.error;
      expect(err).toBeInstanceOf(Error);
      expect(isBelowFrequencyFloorError(err)).toBe(true);
      expect(isBelowFrequencyFloorError(new Error("something else"))).toBe(false);
    }
  });
});

describe("6482-P03 the classifier refuses below-floor arms, never approval-binds them", () => {
  it("a 1-second interval arm is refused with the coded reason", () => {
    const out = classifyAgentScheduleRequest(
      { kind: "sdk-callback", callback: "autonomousMarketScreen", intervalSeconds: 1 },
      FLOOR_CONFIG,
    );
    expect(out.schedulable).toBe(false);
    if (!out.schedulable) expect(out.denialReason).toContain(SCHEDULE_BELOW_FREQUENCY_FLOOR);
  });

  it("a below-floor cron arm is refused; a daily cron is refused too, a yearly cron is not", () => {
    const fast = classifyAgentScheduleRequest(
      { kind: "sdk-callback", callback: "autonomousMarketScreen", cron: "*/30 * * * *" },
      FLOOR_CONFIG,
    );
    expect(fast.schedulable).toBe(false);
    const daily = classifyAgentScheduleRequest(
      { kind: "sdk-callback", callback: "autonomousMarketScreen", cron: "0 9 * * 1-5" },
      FLOOR_CONFIG,
    );
    expect(daily.schedulable).toBe(false);
    const yearly = classifyAgentScheduleRequest(
      { kind: "sdk-callback", callback: "autonomousMarketScreen", cron: "0 0 1 1 *" },
      FLOOR_CONFIG,
    );
    expect(yearly).toEqual({ schedulable: true, requiresApproval: false, approvalReasons: [] });
  });

  it("with no floor configured the fail-closed default still refuses a 1s arm", () => {
    const out = classifyAgentScheduleRequest(
      { kind: "sdk-callback", callback: "autonomousMarketScreen", intervalSeconds: 1 },
      {},
    );
    expect(out.schedulable).toBe(false);
    if (!out.schedulable) expect(out.denialReason).toContain(SCHEDULE_BELOW_FREQUENCY_FLOOR);
  });

  it("frequency is not an approval reason any more: at-floor with no other class needs no approval", () => {
    const out = classifyAgentScheduleRequest(
      { kind: "sdk-callback", callback: "autonomousMarketScreen", intervalSeconds: 2_592_000 },
      FLOOR_CONFIG,
    );
    expect(out).toEqual({ schedulable: true, requiresApproval: false, approvalReasons: [] });
  });
});

describe("6482-P04 the executor refuses a 1s create with the coded outcome", () => {
  const principal = { login: "OpenAIMP", agentId: "agent-1" };

  function harness(overrides: Record<string, unknown> = {}) {
    const ledger: unknown[] = [];
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let pending: PendingScheduleApproval[] = [];
    const sdkItems: Array<{ id: string; callback: string; payload?: unknown; type: string; intervalSeconds?: number; cron?: string }> = [];
    let seq = 0;
    const deps = {
      pdp: async () => ({ enforced: true as const, allowed: true as const }),
      config: FLOOR_CONFIG,
      nowMs: () => 1_700_000_000_000,
      nowIso: () => "2026-11-11T12:00:00.000Z",
      recordLedger: (record: unknown) => {
        ledger.push(record);
      },
      audit: (type: string, payload: Record<string, unknown>) => {
        audits.push({ type, payload });
      },
      pendingApprovals: {
        load: async () => pending,
        save: async (list: PendingScheduleApproval[]) => {
          pending = list;
        },
      },
      stores: {
        sdk: {
          list: async () => sdkItems,
          get: async (id: string) => sdkItems.find((item) => item.id === id),
          create: async (input: { callback: string; payload?: unknown; timing: { type: string; cron?: string; intervalSeconds?: number } }) => {
            const item = { id: `sdk-${++seq}`, callback: input.callback, payload: input.payload, type: input.timing.type };
            sdkItems.push(item);
            return item;
          },
          cancel: async (id: string) => {
            const idx = sdkItems.findIndex((item) => item.id === id);
            if (idx < 0) return false;
            sdkItems.splice(idx, 1);
            return true;
          },
        },
        goals: {
          list: async () => [],
          add: async (goal: { id: string; operation: string }) => ({ ...goal, enabled: true }),
          remove: async () => true,
          setEnabled: async () => true,
          trigger: async () => ({ jobsCreated: 0, jobsSkipped: 0, errors: [] }),
        },
      },
      ...overrides,
    };
    return { deps, ledger, audits, getPending: () => pending, sdkItems };
  }

  it("a 1-second create is refused, arms nothing, records no pending approval", async () => {
    const { deps, getPending, sdkItems, audits } = harness();
    const out = await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "sdk",
      principal,
      tenantId: "primary",
      callback: "autonomousMarketScreen",
      timing: { type: "interval", intervalSeconds: 1 } as const,
      payload: {},
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("below-frequency-floor");
      expect(out.reason).toContain(SCHEDULE_BELOW_FREQUENCY_FLOOR);
    }
    expect(sdkItems).toHaveLength(0);
    expect(getPending()).toHaveLength(0);
    expect(audits.some((a) => a.type === "agent.schedule.denied")).toBe(true);
  });

  it("a below-floor cron create is refused the same way", async () => {
    const { deps, sdkItems } = harness();
    const out = await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "sdk",
      principal,
      tenantId: "primary",
      callback: "autonomousMarketScreen",
      timing: { type: "cron", cron: "*/5 * * * *" } as const,
      payload: {},
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("below-frequency-floor");
    expect(sdkItems).toHaveLength(0);
  });

  it("an approved pending id does NOT arm a below-floor schedule", async () => {
    const { deps, sdkItems } = harness();
    const out = await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "sdk",
      principal,
      tenantId: "primary",
      callback: "autonomousMarketScreen",
      timing: { type: "interval", intervalSeconds: 30 } as const,
      payload: {},
      approvedPendingId: "pending-approved-elsewhere",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("below-frequency-floor");
    expect(sdkItems).toHaveLength(0);
  });

  it("managing an already-armed legacy below-floor schedule still works (delete)", async () => {
    const { deps, sdkItems } = harness();
    sdkItems.push({
      id: "sdk-legacy",
      callback: "autonomousMarketScreen",
      type: "interval",
      intervalSeconds: 1,
      payload: { provenance: { origin: "user", createdBy: "OpenAIMP", createdAt: "2026-11-11T00:00:00.000Z" } },
    });
    const out = await executeAgentScheduleAction(deps as never, {
      action: "delete",
      kind: "sdk",
      principal,
      tenantId: "primary",
      scheduleId: "sdk-legacy",
    });
    expect(out.ok).toBe(true);
    expect(sdkItems).toHaveLength(0);
  });

  it("an at-floor create still arms", async () => {
    const { deps, sdkItems } = harness();
    const out = await executeAgentScheduleAction(deps as never, {
      action: "create",
      kind: "sdk",
      principal,
      tenantId: "primary",
      callback: "autonomousMarketScreen",
      timing: { type: "interval", intervalSeconds: 2_592_000 } as const,
      payload: {},
    });
    expect(out.ok).toBe(true);
    expect(sdkItems).toHaveLength(1);
  });
});

describe("6482-P05 the kill-switch halts a firing at the one choke point", () => {
  function killSwitchSql(enabled: "on" | "off" | null) {
    const sql = new SqliteTestStorage() as never;
    createSettingsPort(sql as never).ensureSchema();
    if (enabled !== null) {
      createSettingsPort(sql as never).set(SCHEDULE_FIRING_ENABLED_SETTING_KEY, enabled);
    }
    return sql;
  }

  it("kill-switch off halts a firing: the callback does not run, a skipped row names the halt", async () => {
    const sql = killSwitchSql("off");
    const run = vi.fn(async () => ({ outcome: "success" as const, descriptor: "ran" }));
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ledger = ledgerD1();
    await recordScheduleCallbackRun(
      sql as never,
      "autonomousMarketScreen",
      { trigger: "scheduled" },
      { id: "sched-1" },
      run,
      { audit: (type, agent, payload) => audits.push({ type, payload }), env: ledger.env },
    );
    expect(run).not.toHaveBeenCalled();
    const rows = await ledger.store.listRecent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("skipped");
    expect(String(rows[0].detail ?? "")).toMatch(/kill-switch/i);
    expect(audits.some((a) => a.type === "schedule.firing_halted")).toBe(true);
  });

  it("kill-switch on lets it run", async () => {
    const sql = killSwitchSql("on");
    const run = vi.fn(async () => ({ outcome: "success" as const, descriptor: "ran" }));
    const ledger = ledgerD1();
    await recordScheduleCallbackRun(sql as never, "autonomousMarketScreen", { trigger: "scheduled" }, { id: "sched-1" }, run, { env: ledger.env });
    expect(run).toHaveBeenCalledTimes(1);
    const rows = await ledger.store.listRecent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("success");
  });

  it("nothing configured means firing allowed: deploying the slice halts no existing schedule", async () => {
    const sql = killSwitchSql(null);
    const run = vi.fn(async () => ({ outcome: "success" as const, descriptor: "ran" }));
    const ledger = ledgerD1();
    await recordScheduleCallbackRun(sql as never, "autonomousMarketScreen", { trigger: "scheduled" }, { id: "sched-1" }, run, { env: ledger.env });
    expect(run).toHaveBeenCalledTimes(1);
    expect(DEFAULT_SCHEDULE_FIRING_ENABLED).toBe(true);
    expect(SCHEDULE_FIRING_ENABLED_ENV_VAR).toBe("SCHEDULE_FIRING_ENABLED");
  });

  it("the env carrier alone halts firings (managed setting absent)", async () => {
    const sql = killSwitchSql(null);
    const run = vi.fn(async () => ({ outcome: "success" as const, descriptor: "ran" }));
    const ledger = ledgerD1();
    await recordScheduleCallbackRun(
      sql as never,
      "autonomousMarketScreen",
      { trigger: "scheduled" },
      { id: "sched-1" },
      run,
      { env: { SCHEDULE_FIRING_ENABLED: "false", ...ledger.env } },
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("the managed setting beats the env carrier for the kill-switch", () => {
    expect(resolveScheduleFiringEnabled({ managed: "off", env: "true" })).toBe(false);
    expect(resolveScheduleFiringEnabled({ managed: "on", env: "false" })).toBe(true);
    expect(resolveScheduleFiringEnabled({ env: "false" })).toBe(false);
    expect(resolveScheduleFiringEnabled({})).toBe(true);
    expect(parseScheduleFiringEnabled("off")).toBe(false);
    expect(parseScheduleFiringEnabled("on")).toBe(true);
    expect(parseScheduleFiringEnabled("nope")).toBeUndefined();
  });

  it("a manual trigger is never halted by the kill-switch", async () => {
    const sql = killSwitchSql("off");
    const run = vi.fn(async () => ({ outcome: "success" as const, descriptor: "ran" }));
    const ledger = ledgerD1();
    await recordScheduleCallbackRun(
      sql as never,
      "autonomousMarketScreen",
      { trigger: "manual", scheduleId: "sched-1" },
      { id: "sched-1" },
      run,
      { env: ledger.env },
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("the effective kill-switch resolves from the DO store with its source named", () => {
    const sql = killSwitchSql("off");
    const resolved = resolveEffectiveScheduleFiringEnabled(sql, { SCHEDULE_FIRING_ENABLED: "true" });
    expect(resolved.enabled).toBe(false);
    expect(resolved.source).toBe("managed");
    const fresh = new SqliteTestStorage() as never;
    expect(resolveEffectiveScheduleFiringEnabled(fresh, {}).enabled).toBe(true);
    expect(resolveEffectiveScheduleFiringEnabled(fresh, {}).source).toBe("default");
  });
});

describe("6482-P06 the managed controls round-trip through the UX route", () => {
  const ADMIN_LOGIN = "venus-admin";
  const ADMIN_USER_ID = "user-admin-1";
  const PLAIN_LOGIN = "plain-user";
  const PLAIN_USER_ID = "user-plain-1";

  function stubKv(entries: Record<string, string>) {
    const store = new Map<string, string>();
    for (const [login, userId] of Object.entries(entries)) {
      store.set(`iaaa-alias:login:${login}`, JSON.stringify({ internalUserId: userId }));
    }
    return {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    };
  }
  function stubMembershipStore(adminIds: string[]) {
    return {
      getMembershipsByUser: async (internalUserId: string) =>
        adminIds.includes(internalUserId)
          ? [
              {
                membershipId: "m-admin-1",
                internalUserId,
                tenantId: "platform",
                roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "test" }],
                createdBy: "test",
                createdAtMs: 1,
              },
            ]
          : [],
      put: async () => {},
      revokeMembership: async () => false,
    };
  }

  function makeCtx() {
    const sql = new SqliteTestStorage() as never;
    const schedules = new Map<string, Record<string, unknown>>();
    const mockD1 = new MockD1Database();
    const audit = vi.fn();
    const ctx: Record<string, unknown> = {
      env: { AGENT_DB: mockD1 },
      agentCtx: { storage: { sql } },
      audit,
      listSchedules: async () => [...schedules.values()],
      cancelSchedule: async (id: string) => schedules.delete(id),
      getScheduleById: async (id: string) => schedules.get(id),
      schedule: async (when: unknown, callback: string, payload: unknown) => {
        const id = `new-${schedules.size + 1}`;
        const s = { id, callback, payload, type: typeof when === "string" ? "cron" : "scheduled" };
        schedules.set(id, s);
        return s;
      },
      scheduleEvery: async (intervalSeconds: number, callback: string, payload: unknown) => {
        const id = `new-${schedules.size + 1}`;
        const s = { id, callback, payload, type: "interval", intervalSeconds };
        schedules.set(id, s);
        return s;
      },
      getScreenerExecutionContext: async () => ({ userLogin: "venus", environment: "TEST" }),
      getOrm: () => ({}),
      autonomousMarketScreen: async () => {},
      autoRenewETradeTokens: async () => {},
      creatableScheduleCallbacks: ["autonomousOptionsAnalysis", "autonomousMarketScreen", "autonomousStrategyDiscovery"],
      accountScopedScheduleCallbacks: new Set(["autonomousOptionsAnalysis", "autonomousMarketScreen", "autonomousStrategyDiscovery"]),
      runScheduleCallback: async () => {},
      flagAliasKv: stubKv({ [ADMIN_LOGIN]: ADMIN_USER_ID, [PLAIN_LOGIN]: PLAIN_USER_ID }),
      flagMembershipStore: stubMembershipStore([ADMIN_USER_ID]),
    };
    return { ctx: ctx as never, sql, schedules, audit, mockD1 };
  }

  /** Seed the five system rows the way onStart does (#6503 step 7). */
  async function seedSystemRows(mockD1: MockD1Database, schedules: Map<string, Record<string, unknown>>) {
    // No userLogin, so the ledger sweep is skipped and exactly the
    // five render. Fresh seeds are paused, so reconcile arms
    // nothing; the arm stub throws if that ever changes.
    const alarms = {
      list: async () => [...schedules.values()],
      get: async (id: string) => schedules.get(id),
      cancel: async (id: string) => schedules.delete(id),
      arm: async () => {
        throw new Error("reconcile must not arm on a fresh store");
      },
    };
    await reconcileSystemScheduleRecords(
      {
        store: createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules,
        alarms: alarms as never,
      },
      "2026-11-24T00:00:00.000Z",
    );
  }

  function controlsRequest(method: string, body?: unknown, login?: string) {
    return new Request("https://agent.test/api/schedules/controls", {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(login ? { "x-user-login": login } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it("GET returns the effective floor (default monthly) + firing on + the inventory, read-only for anonymous callers", async () => {
    const { ctx, schedules, mockD1 } = makeCtx();
    // #6503 step 7 — D1 starts empty: the migration no longer seeds
    // the five system rows. The onStart reconcile seeds them, and
    // the list renders paused stored rows — so the inventory is the
    // five seeds, not empty. Goals are not inventory rows.
    await seedSystemRows(mockD1, schedules);
    const res = await handleSchedulesRoutes(
      controlsRequest("GET"),
      new URL("https://agent.test/api/schedules/controls"),
      "/api/schedules/controls",
      "s",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.minIntervalSeconds).toBe(2_592_000);
    expect(body.minIntervalSource).toBe("default");
    expect(body.managedMinIntervalSeconds).toBeNull();
    expect(body.firingEnabled).toBe(true);
    expect(body.canToggle).toBe(false);
    const inventory = body.inventory as Array<Record<string, unknown>>;
    expect(inventory).toHaveLength(5);
    expect(inventory.map((row) => row.id).sort()).toEqual([
      "nightly-research",
      "retention",
      "schedule-watchdog",
      "sweep-stale-async-jobs",
      "token-renewal",
    ]);
    for (const row of inventory) {
      expect(row).toMatchObject({ state: "paused", owner: "system", intervalSeconds: 2_592_000, cron: null });
    }
    expect(body.firingRate).toMatchObject({ threshold: 120, windowMinutes: 60, exceeded: false });
  });

  it("POST as admin sets the floor and the kill-switch; a later GET shows the managed effective values", async () => {
    const { ctx, audit } = makeCtx();
    const url = new URL("https://agent.test/api/schedules/controls");
    const res = await handleSchedulesRoutes(controlsRequest("POST", { minIntervalSeconds: 7_200, firingEnabled: false }, ADMIN_LOGIN), url, "/api/schedules/controls", "s", ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.minIntervalSeconds).toBe(7_200);
    expect(body.minIntervalSource).toBe("managed");
    expect(body.firingEnabled).toBe(false);
    expect(body.firingEnabledSource).toBe("managed");
    expect(audit).toHaveBeenCalledWith(
      "schedule.controls-changed",
      "orchestrator",
      expect.objectContaining({ minIntervalSeconds: 7_200, firingEnabled: false, changedBy: ADMIN_LOGIN }),
    );
    const again = await handleSchedulesRoutes(controlsRequest("GET"), url, "/api/schedules/controls", "s", ctx);
    const againBody = (await again!.json()) as Record<string, unknown>;
    expect(againBody.minIntervalSeconds).toBe(7_200);
    expect(againBody.managedMinIntervalSeconds).toBe(7_200);
    expect(againBody.firingEnabled).toBe(false);
  });

  it("POST as admin can clear the managed floor (null) back to the env/default value", async () => {
    const { ctx } = makeCtx();
    const url = new URL("https://agent.test/api/schedules/controls");
    await handleSchedulesRoutes(controlsRequest("POST", { minIntervalSeconds: 7_200 }, ADMIN_LOGIN), url, "/api/schedules/controls", "s", ctx);
    const cleared = await handleSchedulesRoutes(controlsRequest("POST", { minIntervalSeconds: null }, ADMIN_LOGIN), url, "/api/schedules/controls", "s", ctx);
    expect(cleared!.status).toBe(200);
    const clearedBody = (await cleared!.json()) as Record<string, unknown>;
    expect(clearedBody.minIntervalSeconds).toBe(2_592_000);
    expect(clearedBody.minIntervalSource).toBe("default");
  });

  it("POST refuses an invalid floor and writes nothing", async () => {
    const { ctx } = makeCtx();
    const url = new URL("https://agent.test/api/schedules/controls");
    for (const bad of [0, -5, 61.5, "fast"]) {
      const res = await handleSchedulesRoutes(controlsRequest("POST", { minIntervalSeconds: bad }, ADMIN_LOGIN), url, "/api/schedules/controls", "s", ctx);
      expect(res!.status).toBe(400);
    }
    const body = (await (await handleSchedulesRoutes(controlsRequest("GET"), url, "/api/schedules/controls", "s", ctx))!.json()) as Record<string, unknown>;
    expect(body.minIntervalSeconds).toBe(2_592_000);
    expect(body.minIntervalSource).toBe("default");
  });

  it("POST refuses a non-admin (403) and an unauthenticated caller (401)", async () => {
    const { ctx } = makeCtx();
    const url = new URL("https://agent.test/api/schedules/controls");
    const plain = await handleSchedulesRoutes(controlsRequest("POST", { minIntervalSeconds: 7_200 }, PLAIN_LOGIN), url, "/api/schedules/controls", "s", ctx);
    expect(plain!.status).toBe(403);
    const anon = await handleSchedulesRoutes(controlsRequest("POST", { minIntervalSeconds: 7_200 }), url, "/api/schedules/controls", "s", ctx);
    expect(anon!.status).toBe(401);
  });

  it("GET lists the armed-schedule inventory: callback + interval + owner", async () => {
    const { ctx, schedules, mockD1 } = makeCtx();
    // The home list is alarm-driven: the live alarm carries the
    // callback + interval, its payload carries the provenance owner.
    schedules.set("alarm-1", {
      id: "alarm-1",
      callback: "autonomousMarketScreen",
      type: "interval",
      intervalSeconds: 2_592_000,
      payload: { provenance: { origin: "user", createdBy: "venus", createdAt: "2026-11-24T00:00:00.000Z" } },
    });
    // #6503 step 7 — the five paused system rows come from the
    // onStart reconcile now, not the migration; they render in the
    // inventory alongside the armed row.
    await seedSystemRows(mockD1, schedules);
    const res = await handleSchedulesRoutes(
      controlsRequest("GET"),
      new URL("https://agent.test/api/schedules/controls"),
      "/api/schedules/controls",
      "s",
      ctx,
    );
    const body = (await res!.json()) as Record<string, unknown>;
    const inventory = body.inventory as Array<Record<string, unknown>>;
    expect(inventory).toHaveLength(6);
    const armed = inventory.find((row) => row.id === "alarm-1");
    expect(armed).toMatchObject({
      id: "alarm-1",
      callback: "autonomousMarketScreen",
      intervalSeconds: 2_592_000,
      owner: "venus",
    });
  });

  it("GET returns the step-13 defaults for every externalized value (behavior unchanged)", async () => {
    const { ctx } = makeCtx();
    const res = await handleSchedulesRoutes(
      controlsRequest("GET"),
      new URL("https://agent.test/api/schedules/controls"),
      "/api/schedules/controls",
      "s",
      ctx,
    );
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.heartbeatIntervalSeconds).toBe(1_800);
    expect(body.heartbeatIntervalSource).toBe("default");
    expect(body.heartbeatWatchdogStaleAfterMinutes).toBe(120);
    expect(body.heartbeatWatchdogStaleAfterSource).toBe("default");
    expect(body.missedScheduleGraceMinutes).toBe(60);
    expect(body.missedScheduleGraceSource).toBe("default");
    expect(body.dueGuardMs).toBe(82_800_000);
    expect(body.dueGuardSource).toBe("default");
    expect(body.staleRunningReapMs).toBe(7_200_000);
    expect(body.staleRunningReapSource).toBe("default");
    expect(body.staleSweepBatchLimit).toBe(100);
    expect(body.staleSweepBatchLimitSource).toBe("default");
    expect(body.researchScheduleUtcHour).toBe(21);
    expect(body.researchScheduleUtcHourSource).toBe("default");
    expect(body.jobRunRecordCap).toBe(500);
    expect(body.jobRunRecordCapSource).toBe("default");
    expect(body.tickHistoryCap).toBe(50);
    expect(body.tickHistoryCapSource).toBe("default");
  });

  it("POST as admin sets the step-13 values; a later GET shows the managed effective values", async () => {
    const { ctx, audit } = makeCtx();
    const url = new URL("https://agent.test/api/schedules/controls");
    const res = await handleSchedulesRoutes(
      controlsRequest(
        "POST",
        {
          heartbeatIntervalSeconds: 900,
          heartbeatWatchdogStaleAfterMinutes: 30,
          missedScheduleGraceMinutes: 5,
          dueGuardMs: 3_600_000,
          staleRunningReapMs: 3_600_000,
          staleSweepBatchLimit: 10,
          researchScheduleUtcHour: 20,
          jobRunRecordCap: 100,
          tickHistoryCap: 25,
        },
        ADMIN_LOGIN,
      ),
      url,
      "/api/schedules/controls",
      "s",
      ctx,
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.heartbeatIntervalSeconds).toBe(900);
    expect(body.heartbeatIntervalSource).toBe("managed");
    expect(body.heartbeatWatchdogStaleAfterMinutes).toBe(30);
    expect(body.heartbeatWatchdogStaleAfterSource).toBe("managed");
    expect(body.missedScheduleGraceMinutes).toBe(5);
    expect(body.missedScheduleGraceSource).toBe("managed");
    expect(body.dueGuardMs).toBe(3_600_000);
    expect(body.dueGuardSource).toBe("managed");
    expect(body.staleRunningReapMs).toBe(3_600_000);
    expect(body.staleRunningReapSource).toBe("managed");
    expect(body.staleSweepBatchLimit).toBe(10);
    expect(body.staleSweepBatchLimitSource).toBe("managed");
    expect(body.researchScheduleUtcHour).toBe(20);
    expect(body.researchScheduleUtcHourSource).toBe("managed");
    expect(body.jobRunRecordCap).toBe(100);
    expect(body.jobRunRecordCapSource).toBe("managed");
    expect(body.tickHistoryCap).toBe(25);
    expect(body.tickHistoryCapSource).toBe("managed");
    expect(audit).toHaveBeenCalledWith(
      "schedule.controls-changed",
      "orchestrator",
      expect.objectContaining({ missedScheduleGraceMinutes: 5, dueGuardMs: 3_600_000, changedBy: ADMIN_LOGIN }),
    );
    const again = await handleSchedulesRoutes(controlsRequest("GET"), url, "/api/schedules/controls", "s", ctx);
    const againBody = (await again!.json()) as Record<string, unknown>;
    expect(againBody.missedScheduleGraceMinutes).toBe(5);
    expect(againBody.managedMissedScheduleGraceMinutes).toBe(5);
    expect(againBody.researchScheduleUtcHour).toBe(20);
    expect(againBody.jobRunRecordCap).toBe(100);
  });

  it("POST as admin can set the grace to 0 (disabled) and clear it back to the default", async () => {
    const { ctx } = makeCtx();
    const url = new URL("https://agent.test/api/schedules/controls");
    const disabled = await handleSchedulesRoutes(
      controlsRequest("POST", { missedScheduleGraceMinutes: 0 }, ADMIN_LOGIN),
      url,
      "/api/schedules/controls",
      "s",
      ctx,
    );
    expect(disabled!.status).toBe(200);
    const disabledBody = (await disabled!.json()) as Record<string, unknown>;
    expect(disabledBody.missedScheduleGraceMinutes).toBe(0);
    expect(disabledBody.missedScheduleGraceSource).toBe("managed");
    const cleared = await handleSchedulesRoutes(
      controlsRequest("POST", { missedScheduleGraceMinutes: null }, ADMIN_LOGIN),
      url,
      "/api/schedules/controls",
      "s",
      ctx,
    );
    const clearedBody = (await cleared!.json()) as Record<string, unknown>;
    expect(clearedBody.missedScheduleGraceMinutes).toBe(60);
    expect(clearedBody.missedScheduleGraceSource).toBe("default");
  });

  it("POST refuses an invalid step-13 value and writes nothing", async () => {
    const { ctx } = makeCtx();
    const url = new URL("https://agent.test/api/schedules/controls");
    for (const bad of [
      { heartbeatIntervalSeconds: 0 },
      { heartbeatWatchdogStaleAfterMinutes: -1 },
      { missedScheduleGraceMinutes: "soon" },
      { dueGuardMs: 0 },
      { dueGuardMs: 61.5 },
      { staleRunningReapMs: -100 },
      { staleSweepBatchLimit: 0 },
      { researchScheduleUtcHour: 24 },
      { researchScheduleUtcHour: -1 },
      { jobRunRecordCap: 0 },
      { tickHistoryCap: "many" },
    ]) {
      const res = await handleSchedulesRoutes(controlsRequest("POST", bad, ADMIN_LOGIN), url, "/api/schedules/controls", "s", ctx);
      expect(res!.status).toBe(400);
    }
    const body = (await (await handleSchedulesRoutes(controlsRequest("GET"), url, "/api/schedules/controls", "s", ctx))!.json()) as Record<string, unknown>;
    expect(body.missedScheduleGraceMinutes).toBe(60);
    expect(body.dueGuardMs).toBe(82_800_000);
    expect(body.researchScheduleUtcHour).toBe(21);
    expect(body.jobRunRecordCap).toBe(500);
  });
});

describe("6482-P07 the armed-schedule inventory builder", () => {
  it("lists callback + interval + owner; cron rows carry the cron, ownerless rows carry null", () => {
    const items = buildArmedScheduleInventory([
      { id: "a1", callback: "autonomousMarketScreen", type: "interval", intervalSeconds: 2_592_000, state: "active", provenance: { createdBy: "venus" } },
      { id: "a2", callback: "autonomousOptionsAnalysis", type: "cron", cron: "0 9 * * *", state: "paused", provenance: { createdBy: "openaimp" } },
      { id: "a3", callback: "runPipelineJobSchedule", type: "interval", intervalSeconds: 7_200, state: "active" },
    ]);
    expect(items).toEqual([
      { id: "a1", callback: "autonomousMarketScreen", intervalSeconds: 2_592_000, cron: null, owner: "venus", state: "active" },
      { id: "a2", callback: "autonomousOptionsAnalysis", intervalSeconds: null, cron: "0 9 * * *", owner: "openaimp", state: "paused" },
      { id: "a3", callback: "runPipelineJobSchedule", intervalSeconds: 7_200, cron: null, owner: null, state: "active" },
    ]);
  });
});

describe("6482-P08 the firing-rate alert: threshold + emitted observation", () => {
  it("the threshold defaults to 120 firings in a 60-minute window (env-overridable)", () => {
    expect(DEFAULT_SCHEDULE_FIRING_RATE_ALERT_THRESHOLD).toBe(120);
    expect(DEFAULT_SCHEDULE_FIRING_RATE_ALERT_WINDOW_MINUTES).toBe(60);
    expect(resolveScheduleFiringRateAlertThreshold({})).toBe(120);
    expect(resolveScheduleFiringRateAlertThreshold({ SCHEDULE_FIRING_RATE_ALERT_THRESHOLD: "10" })).toBe(10);
    expect(resolveScheduleFiringRateAlertWindowMinutes({})).toBe(60);
  });

  it("exceeds only above the threshold", () => {
    expect(evaluateScheduleFiringRate({ firingsInWindow: 120, threshold: 120 }).exceeded).toBe(false);
    expect(evaluateScheduleFiringRate({ firingsInWindow: 121, threshold: 120 }).exceeded).toBe(true);
    expect(evaluateScheduleFiringRate({ firingsInWindow: 0, threshold: 120 }).exceeded).toBe(false);
  });

  it("a runaway-rate ledger emits the observation once per window through the audit sink", async () => {
    const sql = new SqliteTestStorage() as never;
    // Issue #6101 — the ledger is D1: the rows seed the D1 store
    // and the check resolves it from the env.
    const ledger = ledgerD1();
    const store = ledger.store;
    const nowMs = Date.parse("2026-11-24T12:00:00.000Z");
    for (let i = 0; i < 121; i++) {
      await store.record({
        system: "orchestrator-schedule",
        jobId: `sched-${i % 3}`,
        operation: "autonomousMarketScreen",
        started: new Date(nowMs - i * 1_000).toISOString(),
        finished: new Date(nowMs - i * 1_000).toISOString(),
        outcome: "success",
        triggeredBy: "scheduled",
        scheduleId: `sched-${i % 3}`,
        asyncJobId: null,
        workflowId: null,
      });
    }
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const first = await checkScheduleFiringRate(sql, ledger.env, nowMs, (type, payload) => emitted.push({ type, payload }));
    expect(first.exceeded).toBe(true);
    expect(first.count).toBe(121);
    expect(first.alerted).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("schedule.firing_rate_exceeded");
    expect(emitted[0].payload.count).toBe(121);
    // Second check inside the window: still exceeded, but no second alert.
    const second = await checkScheduleFiringRate(sql, ledger.env, nowMs + 60_000, (type, payload) => emitted.push({ type, payload }));
    expect(second.exceeded).toBe(true);
    expect(second.alerted).toBe(false);
    expect(emitted).toHaveLength(1);
    // The throttle marker is the managed-settings key, readable for the home.
    expect(readScheduleManagedSetting(sql, SCHEDULE_FIRING_RATE_ALERT_LAST_AT_KEY)).not.toBeNull();
  });

  it("a normal rate emits nothing", async () => {
    const sql = new SqliteTestStorage() as never;
    const ledger = ledgerD1();
    const store = ledger.store;
    const nowMs = Date.parse("2026-11-24T12:00:00.000Z");
    await store.record({
      system: "orchestrator-schedule",
      jobId: "sched-1",
      operation: "autonomousMarketScreen",
      started: new Date(nowMs - 60_000).toISOString(),
      finished: new Date(nowMs - 60_000).toISOString(),
      outcome: "success",
      triggeredBy: "scheduled",
      scheduleId: "sched-1",
      asyncJobId: null,
      workflowId: null,
    });
    const emitted: unknown[] = [];
    const out = await checkScheduleFiringRate(sql, ledger.env, nowMs, () => emitted.push(1));
    expect(out.exceeded).toBe(false);
    expect(out.alerted).toBe(false);
    expect(emitted).toHaveLength(0);
  });
});

describe("6482-P09 the alarms port refuses below-floor arms", () => {
  function fakeScheduling() {
    const armed: Array<{ timing: unknown; callback: string; options?: unknown }> = [];
    return {
      armed,
      listSchedules: async () => [],
      getScheduleById: async () => undefined,
      cancelSchedule: async () => true,
      schedule: async (when: unknown, callback: string, payload?: unknown, options?: unknown) => {
        armed.push({ timing: { type: "cron", cron: when }, callback, options });
        return { id: `alarm-${armed.length}`, callback, payload };
      },
      scheduleEvery: async (intervalSeconds: number, callback: string, payload?: unknown) => {
        armed.push({ timing: { type: "interval", intervalSeconds }, callback });
        return { id: `alarm-${armed.length}`, callback, payload };
      },
    };
  }

  it("a 1-second arm through the port throws the coded error and arms nothing", async () => {
    const scheduling = fakeScheduling();
    const port = makeScheduleAlarmsPort(scheduling as never);
    await expect(
      port.arm({ type: "interval", intervalSeconds: 1 }, "autonomousMarketScreen", {}),
    ).rejects.toThrow(/SCHEDULE_BELOW_FREQUENCY_FLOOR/);
    expect(scheduling.armed).toHaveLength(0);
  });

  it("a below-floor cron arm through the port throws; an at-floor arm succeeds", async () => {
    const scheduling = fakeScheduling();
    const port = makeScheduleAlarmsPort(scheduling as never);
    await expect(
      port.arm({ type: "cron", cron: "*/5 * * * *" }, "autonomousMarketScreen", {}),
    ).rejects.toThrow(/SCHEDULE_BELOW_FREQUENCY_FLOOR/);
    const armed = await port.arm({ type: "interval", intervalSeconds: 2_592_000 }, "autonomousMarketScreen", {});
    expect(armed.id).toBe("alarm-1");
    expect(scheduling.armed).toHaveLength(1);
  });

  it("a caller-supplied floor resolver wins over the default", async () => {
    const scheduling = fakeScheduling();
    const port = makeScheduleAlarmsPort(scheduling as never, { resolveFloor: () => 7_200 });
    await expect(
      port.arm({ type: "interval", intervalSeconds: 3_600 }, "autonomousMarketScreen", {}),
    ).rejects.toThrow(/SCHEDULE_BELOW_FREQUENCY_FLOOR/);
    expect(scheduling.armed).toHaveLength(0);
  });
});

describe("6482-P10 the REST create route refuses a 1s arm even with subDailyOptIn=true", () => {
  function makeCtx(sql: unknown = new MockSqlStorage()) {
    const schedules = new Map<string, Record<string, unknown>>();
    const scheduleEveryCalls: unknown[] = [];
    const scheduleCalls: unknown[] = [];
    // The success path reaches the E*TRADE token preflight (#3655):
    // seed a bound paper account + live tokens for venus, the same
    // shape as tests/schedules_create_route.test.ts.
    const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
    for (const environment of ["TEST", "PROD"]) {
      seedSession(
        "etrade",
        `etrade:token:${environment}:venus`,
        JSON.stringify({
          accessToken: "test-access-token",
          accessTokenSecret: "test-access-token-secret",
          storedAt: new Date().toISOString(),
          environment,
          userLogin: "venus",
        }),
      );
    }
    seedSession(
      "account_bindings",
      "acctbind:v1:venus",
      JSON.stringify([
        { broker: "etrade", mode: "paper", accountType: "stock", scope: "tenant", accountId: "ET-123" },
        { broker: "etrade", mode: "paper", accountType: "options", scope: "tenant", accountId: "ET-123" },
      ]),
    );
    const mockD1 = new MockD1Database();
    const ctx: Record<string, unknown> = {
      env: { APP_ENV: "TEST", SESSION_STORE: sessionStoreNs, AGENT_DB: mockD1 },
      agentCtx: { storage: { sql } },
      audit: vi.fn(),
      listSchedules: async () => [...schedules.values()],
      cancelSchedule: async (id: string) => schedules.delete(id),
      getScheduleById: async (id: string) => schedules.get(id),
      schedule: async (when: unknown, callback: string, payload: unknown) => {
        scheduleCalls.push([when, callback, payload]);
        return { id: `new-${scheduleCalls.length}`, callback, payload };
      },
      scheduleEvery: async (intervalSeconds: number, callback: string, payload: unknown) => {
        scheduleEveryCalls.push([intervalSeconds, callback, payload]);
        return { id: `new-${scheduleEveryCalls.length}`, callback, payload };
      },
      // TEST (not PROD): the success path resolves the paper binding
      // (etrade:paper:stock:schedule) from the seeded session store.
      getScreenerExecutionContext: async () => ({ userLogin: "venus", environment: "TEST" }),
      getOrm: () => ({}),
      autonomousMarketScreen: async () => {},
      autoRenewETradeTokens: async () => {},
      creatableScheduleCallbacks: ["autonomousOptionsAnalysis", "autonomousMarketScreen", "autonomousStrategyDiscovery"],
      accountScopedScheduleCallbacks: new Set(["autonomousOptionsAnalysis", "autonomousMarketScreen", "autonomousStrategyDiscovery"]),
      runScheduleCallback: async () => {},
    };
    return { ctx: ctx as never, sql, scheduleEveryCalls, scheduleCalls, mockD1 };
  }

  /**
   * #6503 step 6(c): binding AGENT_DB switches the commercial read
   * to the D1 adapter, so the tenant broker selection must be
   * configured in the store the code now reads. Before 6(c) the
   * read failed (store_unavailable) and the route took the legacy
   * E*TRADE bootstrap leg; after the first submit applies the D1
   * migrations the read succeeds-but-empty and the tenant falls to
   * the default broker (alpaca), which refuses the second submit
   * with a 409. Seeding etrade as the tenant's broker selection —
   * the data-provider axis stays at the vocabulary default — keeps
   * both submits on the E*TRADE preflight the harness seeds tokens
   * for. Applies the D1 schema first (the store's lazy ensure).
   */
  async function seedEtradeBroker(mockD1: MockD1Database) {
    await createD1UnifiedSchedulePorts({
      d1: mockD1 as unknown as D1Database,
    }).unifiedSchedules.list();
    const commercial = createCommercialAdapter({ AGENT_DB: mockD1 as never });
    await commercial?.setTenantProviders(resolveIaaaTenant({}), {
      brokerId: "etrade",
      dataProviderId: DEFAULT_TENANT_PROVIDERS.dataProviderId,
    });
  }

  function d1Store(mockD1: MockD1Database) {
    return createD1UnifiedSchedulePorts({
      d1: mockD1 as unknown as D1Database,
    }).unifiedSchedules;
  }

  async function postCreate(ctx: never, body: Record<string, unknown>) {
    const res = await handleSchedulesRoutes(
      new Request("https://agent.test/api/schedules/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": "venus" },
        body: JSON.stringify(body),
      }),
      new URL("https://agent.test/api/schedules/create"),
      "/api/schedules/create",
      "s",
      ctx,
    );
    return { status: res!.status, body: (await res!.json()) as Record<string, unknown> };
  }

  it("a 1-second interval with the opt-in is refused with the floor code and arms nothing", async () => {
    const { ctx, scheduleEveryCalls } = makeCtx();
    const { status, body } = await postCreate(ctx, {
      scheduleType: "interval",
      intervalSeconds: 1,
      subDailyOptIn: true,
      callback: "autonomousMarketScreen",
      payload: { universe: "NASDAQ100", maxItems: 5 },
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.code).toBe(SCHEDULE_BELOW_FREQUENCY_FLOOR);
    expect(String(body.error ?? "")).toMatch(/below.*floor/i);
    expect(scheduleEveryCalls).toHaveLength(0);
  });

  it("a below-floor cron with the opt-in is refused the same way", async () => {
    const { ctx, scheduleCalls } = makeCtx();
    const { status, body } = await postCreate(ctx, {
      scheduleType: "cron",
      cron: "*/5 * * * *",
      subDailyOptIn: true,
      callback: "autonomousMarketScreen",
      payload: { universe: "NASDAQ100", maxItems: 5 },
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.code).toBe(SCHEDULE_BELOW_FREQUENCY_FLOOR);
    expect(scheduleCalls).toHaveLength(0);
  });

  it("without the opt-in the sub-daily gate still fires first (400 opt-in, not floor)", async () => {
    const { ctx, scheduleEveryCalls } = makeCtx();
    const { status, body } = await postCreate(ctx, {
      scheduleType: "interval",
      intervalSeconds: 1,
      callback: "autonomousMarketScreen",
      payload: { universe: "NASDAQ100", maxItems: 5 },
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(String(body.error ?? "")).toMatch(/opt-in/i);
    expect(scheduleEveryCalls).toHaveLength(0);
  });

  it("a monthly create lands PAUSED: 200, a paused record, and the SDK is never armed", async () => {
    const sql = new SqliteTestStorage();
    const { ctx, scheduleEveryCalls, scheduleCalls, mockD1 } = makeCtx(sql as never);
    await seedEtradeBroker(mockD1);
    const { status, body } = await postCreate(ctx, {
      scheduleType: "interval",
      intervalSeconds: 2_592_000,
      callback: "autonomousMarketScreen",
      payload: { universe: "NASDAQ100", maxItems: 5 },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.paused).toBe(true);
    // The SDK is never armed at creation: no scheduleEvery/schedule call.
    expect(scheduleEveryCalls).toHaveLength(0);
    expect(scheduleCalls).toHaveLength(0);
    const record = (body.schedule ?? {}) as Record<string, unknown>;
    expect(typeof record.id).toBe("string");
    expect(record.state).toBe("paused");
    // #6503 step 6(c): the route writes the D1 store, so the
    // read-back reads the same D1 mock — not the DO sync store.
    const saved = await d1Store(mockD1).get(record.id as string);
    expect(saved?.state).toBe("paused");
    expect(saved?.alarmId ?? null).toBeNull();
    expect((saved?.definition as Record<string, unknown>).intervalSeconds).toBe(2_592_000);
  });

  it("a duplicate monthly submit returns the SAME paused record (no second row, no arm)", async () => {
    const sql = new SqliteTestStorage();
    const { ctx, scheduleEveryCalls, mockD1 } = makeCtx(sql as never);
    await seedEtradeBroker(mockD1);
    const payload = {
      scheduleType: "interval",
      intervalSeconds: 2_592_000,
      callback: "autonomousMarketScreen",
      payload: { universe: "NASDAQ100", maxItems: 5 },
    };
    const first = await postCreate(ctx, payload);
    expect(first.status).toBe(200);
    const second = await postCreate(ctx, payload);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect((second.body.schedule as Record<string, unknown>).id).toBe(
      (first.body.schedule as Record<string, unknown>).id,
    );
    expect(scheduleEveryCalls).toHaveLength(0);
    // #6503 step 6(c): the route writes the D1 store, so the
    // read-back reads the same D1 mock — not the DO sync store.
    // #6503 step 7: migration 0092 seeds only the 9 goal rows now
    // (the five system seeds moved to the onStart reconcile), so
    // the store holds 10 with the created row — and the created id
    // appears exactly once, which is the no-second-row assertion.
    const rows = await d1Store(mockD1).list();
    expect(rows).toHaveLength(10);
    expect(rows.filter((row) => row.id === (first.body.schedule as Record<string, unknown>).id)).toHaveLength(1);
  });
});

describe("6482 controls service: patch validation", () => {
  it("applyScheduleControlsPatch validates and persists; null clears a key", () => {
    const sql = new SqliteTestStorage() as never;
    const bad = applyScheduleControlsPatch(sql, { minIntervalSeconds: 0 }, "2026-11-24T00:00:00.000Z");
    expect(bad.ok).toBe(false);
    const ok = applyScheduleControlsPatch(sql, { minIntervalSeconds: 7_200, firingEnabled: false }, "2026-11-24T00:00:00.000Z");
    expect(ok.ok).toBe(true);
    expect(readScheduleManagedSetting(sql, SCHEDULE_MIN_INTERVAL_SETTING_KEY)).toBe("7200");
    expect(readScheduleManagedSetting(sql, SCHEDULE_FIRING_ENABLED_SETTING_KEY)).toBe("off");
    const cleared = applyScheduleControlsPatch(sql, { minIntervalSeconds: null }, "2026-11-24T00:01:00.000Z");
    expect(cleared.ok).toBe(true);
    expect(readScheduleManagedSetting(sql, SCHEDULE_MIN_INTERVAL_SETTING_KEY)).toBeNull();
    expect(readScheduleManagedSetting(sql, SCHEDULE_FIRING_ENABLED_SETTING_KEY)).toBe("off");
  });

  it("resolveScheduleControlsView names the effective values and the firing rate", async () => {
    const sql = new SqliteTestStorage() as never;
    const view = await resolveScheduleControlsView(sql, {}, []);
    expect(view.minIntervalSeconds).toBe(2_592_000);
    expect(view.minIntervalSource).toBe("default");
    expect(view.defaultMinIntervalSeconds).toBe(2_592_000);
    expect(view.firingEnabled).toBe(true);
    expect(view.firingRate).toMatchObject({ count: 0, threshold: 120, windowMinutes: 60, exceeded: false });
    expect(view.inventory).toEqual([]);
  });
});

describe("6482-P11 a stage-schedule create lands paused (never armed)", () => {
  it("createWorkflowStageSchedule saves a paused record and never calls the alarms port", async () => {
    const sql = new SqliteTestStorage();
    const store = createUnifiedSchedulePorts({ sql: sql as never, storage: { sql } as never }).unifiedSchedulesSync;
    const arm = vi.fn(async () => {
      throw new Error("the alarms port must not be called at creation");
    });
    const created = await createWorkflowStageSchedule(
      { store, alarms: { arm } as never },
      {
        jobId: "two-child",
        nodePath: "0",
        stageId: "stage-1",
        callback: "runWorkflowStage",
        timing: { type: "interval", intervalSeconds: 2_592_000 },
        payload: { jobId: "two-child", nodePath: "0", stageId: "stage-1" },
        ownerLogin: "venus",
      },
      "2026-11-24T00:00:00.000Z",
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.record.state).toBe("paused");
    expect(created.record.alarmId).toBeNull();
    expect(created.record.kind).toBe("workflow-stage");
    expect(arm).not.toHaveBeenCalled();
    expect(store.get(created.record.id)?.state).toBe("paused");
  });
});

describe("6482-P12 the SDK adapters create paused (never armed)", () => {
  function fakePort() {
    const calls: string[] = [];
    return {
      calls,
      listSchedules: async () => [],
      schedule: async () => {
        calls.push("schedule");
        return { id: "alarm-1", callback: "x", type: "cron" };
      },
      scheduleEvery: async () => {
        calls.push("scheduleEvery");
        return { id: "alarm-1", callback: "x", type: "interval" };
      },
      cancelSchedule: async () => false,
    };
  }

  it("nlq adapter create records a paused schedule and never arms the port", async () => {
    const sql = new SqliteTestStorage();
    const store = createUnifiedSchedulePorts({ sql: sql as never, storage: { sql } as never }).unifiedSchedulesSync;
    const port = fakePort();
    const adapter = nlqPortToAgentSdkAdapter(port as never, store as never);
    const created = await adapter.create({
      timing: { type: "interval", intervalSeconds: 2_592_000 },
      callback: "autonomousMarketScreen",
      payload: { provenance: { origin: "agent", createdBy: "OpenAIMP", createdAt: "2026-11-24T00:00:00.000Z" } },
    });
    expect(port.calls).toEqual([]);
    expect(typeof created.id).toBe("string");
    const saved = store.get(created.id);
    expect(saved?.state).toBe("paused");
    expect(saved?.alarmId ?? null).toBeNull();
    expect((saved?.definition as Record<string, unknown>).intervalSeconds).toBe(2_592_000);
    // The paused creation stays visible through the adapter's list/get.
    expect((await adapter.list()).map((item) => item.id)).toContain(created.id);
    expect((await adapter.get(created.id))?.callback).toBe("autonomousMarketScreen");
  });

  it("with no store, create is refused fail-closed instead of arming active", async () => {
    const port = fakePort();
    const adapter = nlqPortToAgentSdkAdapter(port as never, undefined);
    await expect(
      adapter.create({
        timing: { type: "interval", intervalSeconds: 2_592_000 },
        callback: "autonomousMarketScreen",
        payload: {},
      }),
    ).rejects.toThrow(/No schedule store is available/);
    expect(port.calls).toEqual([]);
  });

  it("deleting a paused schedule removes its record (no live alarm to cancel)", async () => {
    const sql = new SqliteTestStorage();
    const store = createUnifiedSchedulePorts({ sql: sql as never, storage: { sql } as never }).unifiedSchedulesSync;
    const created = await createPausedAgentSdkScheduleRecord(
      store as never,
      {
        timing: { type: "interval", intervalSeconds: 2_592_000 },
        callback: "autonomousMarketScreen",
        payload: {},
      },
      "2026-11-24T00:00:00.000Z",
    );
    const port = fakePort();
    const adapter = nlqPortToAgentSdkAdapter(port as never, store as never);
    expect(await adapter.cancel(created.id)).toBe(true);
    expect(store.get(created.id)).toBeUndefined();
  });
});

describe("6482-P13 resume is the only activation", () => {
  function fakeScheduling() {
    const armed: Array<{ timing: unknown; callback: string; options?: unknown }> = [];
    return {
      armed,
      listSchedules: async () => [],
      getScheduleById: async () => undefined,
      cancelSchedule: async () => true,
      schedule: async (when: unknown, callback: string, payload?: unknown, options?: unknown) => {
        armed.push({ timing: { type: "cron", cron: when }, callback, options });
        return { id: `alarm-${armed.length}`, callback, payload };
      },
      scheduleEvery: async (intervalSeconds: number, callback: string, payload?: unknown) => {
        armed.push({ timing: { type: "interval", intervalSeconds }, callback });
        return { id: `alarm-${armed.length}`, callback, payload };
      },
    };
  }

  it("a paused monthly schedule resumes: the port arms it and the record goes active", async () => {
    const sql = new SqliteTestStorage();
    const store = createUnifiedSchedulePorts({ sql: sql as never, storage: { sql } as never }).unifiedSchedulesSync;
    const scheduling = fakeScheduling();
    const alarms = makeScheduleAlarmsPort(scheduling as never);
    const record = pausedScreenScheduleToRecord(
      { callback: "autonomousMarketScreen", type: "interval", intervalSeconds: 2_592_000, payload: {}, ownerLogin: "venus" },
      "2026-11-24T00:00:00.000Z",
    );
    store.save(record);
    const resumed = await resumeUnifiedSchedule({ store, alarms }, record.id, "2026-11-24T01:00:00.000Z");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.record.state).toBe("active");
    expect(resumed.record.alarmId).toBe("alarm-1");
    expect(scheduling.armed).toHaveLength(1);
  });

  it("a paused sub-monthly schedule cannot resume: the floor refuses the re-arm and it stays paused", async () => {
    const sql = new SqliteTestStorage();
    const store = createUnifiedSchedulePorts({ sql: sql as never, storage: { sql } as never }).unifiedSchedulesSync;
    const scheduling = fakeScheduling();
    const alarms = makeScheduleAlarmsPort(scheduling as never);
    const record = pausedScreenScheduleToRecord(
      { callback: "autonomousMarketScreen", type: "interval", intervalSeconds: 3_600, payload: {}, ownerLogin: "venus" },
      "2026-11-24T00:00:00.000Z",
    );
    store.save(record);
    await expect(
      resumeUnifiedSchedule({ store, alarms }, record.id, "2026-11-24T01:00:00.000Z"),
    ).rejects.toThrow(/SCHEDULE_BELOW_FREQUENCY_FLOOR/);
    expect(scheduling.armed).toHaveLength(0);
    expect(store.get(record.id)?.state).toBe("paused");
  });

  it("a paused cron created with idempotent:false resumes with that opt-out on the SDK arm", async () => {
    const sql = new SqliteTestStorage();
    const store = createUnifiedSchedulePorts({ sql: sql as never, storage: { sql } as never }).unifiedSchedulesSync;
    const scheduling = fakeScheduling();
    const alarms = makeScheduleAlarmsPort(scheduling as never);
    const record = pausedScreenScheduleToRecord(
      {
        callback: "autonomousMarketScreen",
        type: "cron",
        cron: "0 0 1 1 *",
        payload: {},
        idempotent: false,
        ownerLogin: "venus",
      },
      "2026-11-24T00:00:00.000Z",
    );
    expect(record.definition.idempotent).toBe(false);
    store.save(record);
    const resumed = await resumeUnifiedSchedule({ store, alarms }, record.id, "2026-11-24T01:00:00.000Z");
    expect(resumed.ok).toBe(true);
    expect(scheduling.armed).toHaveLength(1);
    // The recorded opt-out rides resume: the SDK arm is called with
    // idempotent:false, not the default true.
    expect(scheduling.armed[0]?.options).toEqual({ idempotent: false });
  });

  it("updating a paused schedule keeps it paused (update preserves state; only resume activates)", async () => {
    const sql = new SqliteTestStorage();
    const store = createUnifiedSchedulePorts({ sql: sql as never, storage: { sql } as never }).unifiedSchedulesSync;
    const scheduling = fakeScheduling();
    const alarms = makeScheduleAlarmsPort(scheduling as never);
    const record = pausedScreenScheduleToRecord(
      { callback: "autonomousMarketScreen", type: "interval", intervalSeconds: 2_592_000, payload: {}, ownerLogin: "venus" },
      "2026-11-24T00:00:00.000Z",
    );
    store.save(record);
    const updated = await updateUnifiedSchedule(
      { store, alarms },
      record.id,
      { scheduleType: "interval", intervalSeconds: 5_184_000 },
      Date.parse("2026-11-24T01:00:00.000Z"),
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.record.state).toBe("paused");
    expect((updated.record.definition as Record<string, unknown>).intervalSeconds).toBe(5_184_000);
    expect(scheduling.armed).toHaveLength(0);
  });
});

describe("6503-S13 the remaining hardcoded scheduling values are externalized (managed > env > default)", () => {
  it("heartbeat: defaults are 1800s / 120 minutes; managed wins over env, env over default; invalid falls through", () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_SECONDS).toBe(1_800);
    expect(DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MINUTES).toBe(120);
    expect(resolveHeartbeatIntervalSecondsFrom({})).toBe(1_800);
    expect(resolveHeartbeatWatchdogStaleAfterMsFrom({})).toBe(120 * 60 * 1000);
    expect(resolveHeartbeatIntervalSecondsFrom({ managed: "900", env: "600" })).toBe(900);
    expect(resolveHeartbeatIntervalSecondsFrom({ env: "600" })).toBe(600);
    expect(resolveHeartbeatIntervalSecondsFrom({ managed: "soon", env: "600" })).toBe(600);
    expect(resolveHeartbeatIntervalSecondsFrom({ managed: "0", env: "600" })).toBe(600);
    expect(resolveHeartbeatWatchdogStaleAfterMsFrom({ managed: "30", env: "60" })).toBe(30 * 60 * 1000);
    expect(resolveHeartbeatWatchdogStaleAfterMsFrom({ managed: "0" })).toBe(120 * 60 * 1000);
  });

  it("step-12 staleness threshold is reachable as a managed setting through the heartbeat config", () => {
    const config = resolveHeartbeatWatchdogConfigFrom({
      managedStaleAfterMinutes: "30",
      envStaleAfterMinutes: "60",
    });
    expect(config.staleAfterMs).toBe(30 * 60 * 1000);
    expect(config.intervalSeconds).toBe(1_800);
    expect(
      resolveHeartbeatWatchdogConfigFrom({ envStaleAfterMinutes: "45" }).staleAfterMs,
    ).toBe(45 * 60 * 1000);
  });

  it("grace: default is 60 minutes; managed 0 disables; invalid falls through; the managed resolver reads the store", () => {
    expect(DEFAULT_MISSED_SCHEDULE_GRACE_MINUTES).toBe(60);
    expect(resolveMissedScheduleGraceMsFrom({})).toBe(60 * 60 * 1000);
    expect(resolveMissedScheduleGraceMsFrom({ managed: "0" })).toBe(0);
    expect(resolveMissedScheduleGraceMsFrom({ managed: "0", env: "30" })).toBe(0);
    expect(resolveMissedScheduleGraceMsFrom({ managed: "soon", env: "30" })).toBe(30 * 60 * 1000);
    expect(resolveMissedScheduleGraceMsFrom({ env: "0.5" })).toBe(30 * 1000);
    const sql = new SqliteTestStorage();
    expect(resolveEffectiveMissedScheduleGrace(sql.sql as never, {}).ms).toBe(60 * 60 * 1000);
    writeScheduleManagedSetting(sql.sql as never, "schedule.missedScheduleGraceMinutes", "5");
    const resolved = resolveEffectiveMissedScheduleGrace(sql.sql as never, {});
    expect(resolved.ms).toBe(5 * 60 * 1000);
    expect(resolved.source).toBe("managed");
  });

  it("due guard: default is 23h; managed wins over env; isDue honors the default and an override", () => {
    expect(DEFAULT_SCHEDULE_DUE_GUARD_MS).toBe(23 * 60 * 60 * 1000);
    expect(resolveScheduleDueGuardMs({})).toBe(23 * 60 * 60 * 1000);
    expect(resolveScheduleDueGuardMs({ managed: "3600000", env: "7200000" })).toBe(3_600_000);
    expect(resolveScheduleDueGuardMs({ env: "7200000" })).toBe(7_200_000);
    expect(resolveScheduleDueGuardMs({ managed: "0" })).toBe(23 * 60 * 60 * 1000);
    const now = new Date("2026-11-25T12:00:00.000Z");
    const last22h = new Date(now.getTime() - 22 * 60 * 60 * 1000).toISOString();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    // Daily cron, last run 22h ago: the default 23h guard blocks; 24h ago it fires.
    expect(isDue("0 12 * * *", last22h, now)).toBe(false);
    expect(isDue("0 12 * * *", last24h, now)).toBe(true);
    // The same 22h-old run fires with a 1h guard override — the seam works, the default does not move.
    expect(isDue("0 12 * * *", last22h, now, undefined, { dueGuardMs: 60 * 60 * 1000 })).toBe(true);
    expect(isDue("0 12 * * *", last22h, now, undefined, { dueGuardMs: 0 })).toBe(false);
  });

  it("reap: defaults are 2h / 100 rows; managed (via the context reader) wins over env, env over default", () => {
    expect(DEFAULT_STALE_RUNNING_REAP_MS).toBe(2 * 60 * 60 * 1000);
    expect(DEFAULT_STALE_SWEEP_BATCH_LIMIT).toBe(100);
    expect(resolveStaleAsyncJobReapPolicy({})).toEqual({ reapMs: 7_200_000, batchLimit: 100 });
    expect(
      resolveStaleAsyncJobReapPolicy({ managedReapMs: "60000", envReapMs: "120000" }),
    ).toEqual({ reapMs: 60_000, batchLimit: 100 });
    expect(
      resolveStaleAsyncJobReapPolicy({ managedReapMs: "soon", envReapMs: "120000" }),
    ).toEqual({ reapMs: 120_000, batchLimit: 100 });
    const ctx = {
      readSettingRaw: (key: string) =>
        key === "asyncJob.staleRunningReapMs" ? "60000" : key === "asyncJob.staleSweepBatchLimit" ? "7" : null,
      env: {},
    };
    expect(resolveStaleReapPolicy(ctx as never)).toEqual({ reapMs: 60_000, batchLimit: 7 });
    expect(resolveStaleReapPolicy({ env: { ASYNC_JOB_STALE_RUNNING_REAP_MS: "300000" } } as never)).toEqual({
      reapMs: 300_000,
      batchLimit: 100,
    });
    expect(resolveStaleReapPolicy({ env: {} } as never)).toEqual({ reapMs: 7_200_000, batchLimit: 100 });
  });

  it("reap: isHeartbeatStale honors a custom backstop for pre-heartbeat rows and keeps the default", () => {
    const nowMs = Date.parse("2026-11-25T12:00:00.000Z");
    const started3h = new Date(nowMs - 3 * 60 * 60 * 1000).toISOString();
    const legacy = { last_activity_at: null, started_at: started3h };
    expect(isHeartbeatStale(legacy, nowMs)).toBe(true);
    expect(isHeartbeatStale(legacy, nowMs, 4 * 60 * 60 * 1000)).toBe(false);
    expect(isHeartbeatStale(legacy, nowMs, 60 * 60 * 1000)).toBe(true);
  });

  it("research hour: default is 21 UTC; managed wins; env keeps its clamping; invalid managed falls through", () => {
    expect(resolveResearchScheduleUtcHour({})).toBe(21);
    expect(resolveResearchScheduleUtcHour({ managed: "20", env: "22" })).toBe(20);
    expect(resolveResearchScheduleUtcHour({ env: "22" })).toBe(22);
    expect(resolveResearchScheduleUtcHour({ env: "25" })).toBe(23);
    expect(resolveResearchScheduleUtcHour({ managed: "25", env: "22" })).toBe(22);
    expect(resolveResearchScheduleUtcHour({ managed: "soon" })).toBe(21);
    expect(parseResearchScheduleUtcHour(24)).toBeUndefined();
    expect(parseResearchScheduleUtcHour(-1)).toBeUndefined();
    expect(resolveResearchJobConfig({}, { scheduleUtcHour: "20" }).scheduleUtcHour).toBe(20);
    expect(resolveResearchJobConfig({ RESEARCH_SCHEDULE_UTC_HOUR: "22" }).scheduleUtcHour).toBe(22);
    expect(resolveResearchJobConfig({}).scheduleUtcHour).toBe(21);
  });

  it("retention: defaults are 500 records / 50 ticks; managed wins over env, env over default", () => {
    expect(DEFAULT_GOAL_RUN_JOB_RUN_RECORD_CAP).toBe(500);
    expect(DEFAULT_GOAL_RUN_TICK_HISTORY_CAP).toBe(50);
    expect(resolveGoalRunJobRunRecordCap({})).toBe(500);
    expect(resolveGoalRunTickHistoryCap({})).toBe(50);
    expect(resolveGoalRunJobRunRecordCap({ managed: "100", env: "200" })).toBe(100);
    expect(resolveGoalRunJobRunRecordCap({ env: "200" })).toBe(200);
    expect(resolveGoalRunJobRunRecordCap({ managed: "0" })).toBe(500);
    expect(resolveGoalRunTickHistoryCap({ managed: "25", env: "40" })).toBe(25);
    expect(resolveGoalRunTickHistoryCap({ managed: "soon", env: "40" })).toBe(40);
  });
});
