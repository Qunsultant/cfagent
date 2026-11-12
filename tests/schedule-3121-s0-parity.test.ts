/**
 * Issue Qunsultant/cfagent#3121 Slice S0 — scheduling parity harness.
 *
 * Baseline parity tests for the #3121 feature inventory
 * (docs/architecture/scheduling/3121-s0-inventory.md), verified against
 * fresh main at 3c352390. These tests assert CURRENT behavior — including
 * the preserved quirks and the ledger gaps the program closes — so that
 * migration slices S1–S6 fail loudly if any inventoried behavior changes.
 *
 * Every test name carries its inventory item (B-Tx-yy / D-n). Conventions
 * follow tests/schedule-systems-488.test.ts (source-text pins for
 * inventories whose live home is config or another module) and
 * tests/research-schedule-guard.test.ts (pure-function pins).
 *
 * No behavior change in this slice: a red test here means the inventory
 * drifted from main, not that the code is wrong.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREATABLE_SCHEDULE_CALLBACKS_INVENTORY,
  JOB_RUN_RECORD_FIELDS,
  SCHEDULE_SYSTEMS,
  SCHEDULED_GOAL_IDS_INVENTORY,
  WORKER_CRON_TRIGGERS_INVENTORY,
} from "../src/services/scheduleSystems";
import { CREATABLE_SCHEDULE_CALLBACKS } from "../src/agents/orchestrator/scheduleCallbacks";
import { DEFAULT_SCHEDULES, isDue } from "../src/schedule";
import {
  RESEARCH_SCHEDULED_FIRE_HOUR_UTC,
  RESEARCH_SCHEDULED_LAST_RUN_KEY,
  researchTickDateKey,
  shouldFireResearchTick,
} from "../src/services/researchScheduleGuard";
import {
  buildJobRunRecord,
  resolveScheduleRunJobId,
  resolveScheduleRunTrigger,
} from "../src/services/jobRunRecords";
import { JOB_RUN_RECORDS_PER_JOB_CAP, JOB_RUN_RECORDS_TABLE } from "../src/data/jobRunRecordPorts";
import {
  MAS_EVENTS_RETENTION_DEFAULT_DAYS,
  MAS_MEMORY_RETENTION_DEFAULT_DAYS,
  STORAGE_RETENTION_CRON,
  STORAGE_RETENTION_DEFAULT_BATCH_SIZE,
  STORAGE_RETENTION_DEFAULT_DAYS,
  STORAGE_RETENTION_DEFAULT_MAX_PER_RUN,
} from "../src/security/storageRetention";
import { GOAL_FIRING_STALE_MS } from "../src/services/goalFiringClaims";
import { TICKER_PUSH_CALLBACK } from "../src/agents/ticker-agent";
import { SCHEDULED_JOB_OUTCOME_TYPE } from "../src/observability/scheduledJobOutcomes";
import { TRIGGER_ROUTES } from "../src/client/scheduledOptionsManager/systemJobs";

const root = join(__dirname, "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

/** Monday 2026-10-26 09:00 EDT == 13:00Z (copied from tests/schedule_isdue.test.ts). */
const MON_0900_EDT = new Date("2026-10-26T13:00:00Z");
/** Monday 2026-10-19 21:05 UTC (copied from tests/research-schedule-guard.test.ts). */
const MON_2105_UTC = new Date(Date.UTC(2026, 9, 19, 21, 5, 0));

describe("S0-P01 worker crons: no live trigger (#4112 owner direction)", () => {
  it("registers no cron, and keeps every expression commented out", () => {
    const wrangler = read("wrangler.jsonc");
    // #4112: the owner removed all schedules. The block survives as a comment,
    // so the expressions are still visible when a schedule is restored.
    expect(wrangler).not.toMatch(/^\s*"triggers":/m);
    expect(wrangler).not.toMatch(/^\s*"crons":/m);
    for (const cron of ["0 3 * * *", "*/30 * * * *", "0 4 * * *"]) {
      const lines = wrangler.split("\n").filter((l) => l.includes(`"${cron}"`));
      expect(lines.length, `${cron} is stated`).toBeGreaterThan(0);
      // Every occurrence must be a comment: the triggers block AND the
      // workflow schedule that used to carry "*/30 * * * *" (#4112).
      expect(
        lines.every((l) => l.trim().startsWith("//")),
        `${cron} is commented out everywhere`,
      ).toBe(true);
    }
    // The inventory stays: it is what the dispatcher can route once a
    // schedule is re-enabled, and it is no longer compared to wrangler.
    expect(WORKER_CRON_TRIGGERS_INVENTORY.length).toBeGreaterThan(0);
  });

  it("dispatches on event.cron for exactly those three expressions in scheduled()", () => {
    // Slice 8 of #2902 moves scheduled() from server.ts to
    // src/server/routes/queue.ts; S5 (#3121) moves the cron match
    // into resolveCronEntryPoint in consolidatedCronEntries.ts — the
    // dispatcher resolves, the module matches. The entry surface is
    // all three files; the pin tracks the move (gitops §7).
    const server = read("src/server.ts") + read("src/server/routes/queue.ts");
    expect(server).toContain("resolveCronEntryPoint(event?.cron)");
    const entries = read("src/services/consolidatedCronEntries.ts");
    for (const cron of ["0 3 * * *", "0 4 * * *"]) {
      expect(entries).toContain(`"${cron}"`);
    }
    // The tick matches through the S1 constant, not a re-typed
    // literal (single-sourced: the expression lives in WORKER_CRONS).
    expect(entries).toContain("WORKER_TICK_CRON");
  });
});

describe("S0-P02 SDK timing forms (B-T2-01): four forms resolve through ctx.schedule/scheduleEvery", () => {
  it("lists all four forms in the route table and resolves each", () => {
    const routes = read("src/agents/routes/schedules.ts");
    expect(routes).toContain("?type=cron|interval|delayed|scheduled");
    // Arming lives in the `alarms` adapter (#3123): the receiver is
    // `ctx` (one line up), so the forms assert without the prefix;
    // the create route arms directly in the same four forms.
    expect(routes).toContain("schedule(timing.cron, callback, payload, { idempotent: true })");
    expect(routes).toContain("scheduleEvery(timing.intervalSeconds, callback, payload)");
    expect(routes).toContain("schedule(new Date(timing.time * 1000), callback, payload)");
    expect(routes).toContain("ctx.schedule(cron, callback, screeningPayload, { idempotent: body.idempotent !== false })");
  });
});

describe("S0-P03 creatable callbacks (B-T2-02): allow-list is exactly the four callbacks", () => {
  it("pins the live allow-list and its inventory mirror", () => {
    expect([...CREATABLE_SCHEDULE_CALLBACKS]).toEqual([
      "autonomousOptionsAnalysis",
      "autonomousMarketScreen",
      "autonomousStrategyDiscovery",
      "autonomousGoalScreen",
    ]);
    expect(CREATABLE_SCHEDULE_CALLBACKS_INVENTORY).toEqual([
      ...CREATABLE_SCHEDULE_CALLBACKS,
    ]);
  });
});

describe("S0-P04 idempotent creates (B-T2-03): duplicate suppression + idempotent cron creates", () => {
  it("suppresses exact duplicates and audits duplicate_suppressed", () => {
    const routes = read("src/agents/routes/schedules.ts");
    expect(routes).toContain("findDuplicateSchedule");
    expect(routes).toContain('ctx.audit("schedule.duplicate_suppressed"');
    expect(routes).toContain("{ idempotent: body.idempotent !== false }");
  });
});

describe("S0-P05 pause/resume/trigger/delete/detail (B-T2-04): unified store round-trips", () => {
  it("names the pause/resume/trigger/delete/detail routes and the unified store", () => {
    const routes = read("src/agents/routes/schedules.ts");
    for (const route of [
      "POST        /schedules/:id/pause",
      "POST        /schedules/:id/resume",
      "POST        /schedules/:id/trigger",
      "DELETE      /schedules/:id",
      "GET         /schedules/:id",
    ]) {
      expect(routes).toContain(route);
    }
    // Issue #3121 Phase 2 (#3123) — the one store + one management path.
    expect(routes).toContain("unifiedStore()");
    expect(routes).toContain("unifiedScheduleManagement");
    expect(routes).toContain("pauseUnifiedSchedule");
    expect(routes).toContain('ctx.audit("schedule.paused"');
    expect(routes).toContain('ctx.audit("schedule.resumed"');
    expect(routes).toContain('ctx.audit("schedule.triggered"');
  });
});

describe("S0-P06 system-job trigger routes (B-T2-05): all six routes exist", () => {
  it("pins the trigger routes in the schedules route table and the options manager", () => {
    const routes = read("src/agents/routes/schedules.ts");
    for (const route of [
      "/schedules/trigger-screen",
      "/schedules/trigger-renew",
      "/schedules/trigger-options-analysis",
      "/schedules/trigger-retention",
      "/schedules/trigger-iv-collection",
      "/schedules/trigger-discovery",
    ]) {
      expect(routes).toContain(route);
    }
    expect(TRIGGER_ROUTES).toEqual({
      autonomousOptionsAnalysis: "/api/schedules/trigger-options-analysis",
      autonomousMarketScreen: "/api/schedules/trigger-screen",
      autonomousStrategyDiscovery: "/api/schedules/trigger-discovery",
    });
  });
});

describe("S0-P07 per-schedule audit events (B-T2-06): the eight lifecycle events", () => {
  it("pins every audited schedule lifecycle event name", () => {
    const routes = read("src/agents/routes/schedules.ts");
    for (const event of [
      "schedule.created",
      "schedule.cancelled",
      "schedules.cancelled.all",
      "schedule.paused",
      "schedule.resumed",
      "schedule.triggered",
      "schedule.updated",
      "schedule.duplicate_suppressed",
    ]) {
      expect(routes).toContain(`ctx.audit("${event}"`);
    }
  });
});

describe("S0-P08 per-run records (B-T2-07, B-T3-08): job_run_records shape and validation", () => {
  it("pins the record fields — S1 adds the §4 ledger linkage columns", () => {
    expect(JOB_RUN_RECORDS_TABLE).toBe("job_run_records");
    expect(JOB_RUN_RECORDS_PER_JOB_CAP).toBe(100);
    expect(JOB_RUN_RECORD_FIELDS).toEqual([
      "system",
      "jobId",
      "operation",
      "started",
      "finished",
      "outcome",
      "triggeredBy",
      // Issue #3121 S1 — the §4 consolidated-ledger linkage, stamped
      // at write time (B-L-01 closed). The #3264 gap is closed for
      // job_run_records: a run row now joins to its schedule, workflow,
      // and async job; B-L-02/03 (async jobs, scans) remain — see S0-P24.
      "trigger",
      "scheduleId",
      "asyncJobId",
      "workflowId",
      "error",
      "detail",
      "descriptor",
      "artifactRefs",
    ]);
    for (const field of ["trigger", "scheduleId", "asyncJobId", "workflowId"]) {
      expect(JOB_RUN_RECORD_FIELDS).toContain(field);
    }
  });

  it("builds a valid record and rejects an unknown trigger", () => {
    const record = buildJobRunRecord({
      system: "orchestrator-schedule",
      jobId: "sched-1",
      operation: "autonomousMarketScreen",
      started: "2026-11-05T06:00:00.000Z",
      finished: "2026-11-05T06:01:00.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
      descriptor: "screen ran",
    });
    expect(record.triggeredBy).toBe("scheduled");
    // Issue #3121 S1 — the builder derives the ledger trigger and
    // fills explicit nulls for the linkage ids it was not given.
    expect(record.trigger).toBe("scheduled");
    expect(record.scheduleId).toBeNull();
    expect(record.asyncJobId).toBeNull();
    expect(record.workflowId).toBeNull();
    expect(() =>
      buildJobRunRecord({
        system: "orchestrator-schedule",
        jobId: "sched-1",
        operation: "autonomousMarketScreen",
        started: "2026-11-05T06:00:00.000Z",
        finished: "2026-11-05T06:01:00.000Z",
        outcome: "success",
        // @ts-expect-error parity pin: only scheduled|manual is valid today
        triggeredBy: "worker-cron",
      }),
    ).toThrow("Unknown job run trigger");
  });

  it("requires error text on failure and a detail reason on skip", () => {
    const base = {
      system: "scheduled-agent-goal" as const,
      jobId: "daily-qa-sweep",
      operation: "qa.run_sweep",
      started: "2026-11-05T06:00:00.000Z",
      finished: "2026-11-05T06:00:00.000Z",
    };
    expect(() =>
      buildJobRunRecord({ ...base, outcome: "failure", triggeredBy: "scheduled" }),
    ).toThrow("requires error text");
    expect(() =>
      buildJobRunRecord({ ...base, outcome: "skipped", triggeredBy: "scheduled" }),
    ).toThrow("requires a detail reason");
    expect(
      buildJobRunRecord({
        ...base,
        outcome: "skipped",
        triggeredBy: "manual",
        detail: "budget check rejected",
      }).outcome,
    ).toBe("skipped");
  });

  it("resolves the run job id: SDK id, then stamped scheduleId, then callback fallback", () => {
    expect(resolveScheduleRunJobId("autonomousMarketScreen", {}, { id: "sdk-9" })).toBe("sdk-9");
    expect(
      resolveScheduleRunJobId("autonomousMarketScreen", { scheduleId: "manual-4" }, undefined),
    ).toBe("manual-4");
    expect(resolveScheduleRunJobId("autonomousMarketScreen", {}, undefined)).toBe(
      "callback:autonomousMarketScreen",
    );
  });

  it("resolves the trigger: manual only when the payload says so", () => {
    expect(resolveScheduleRunTrigger({ trigger: "manual" })).toBe("manual");
    expect(resolveScheduleRunTrigger({ trigger: "scheduled" })).toBe("scheduled");
    expect(resolveScheduleRunTrigger({})).toBe("scheduled");
    expect(resolveScheduleRunTrigger(undefined)).toBe("scheduled");
  });
});

describe("S0-P09 baseline reconciliation (B-T2-08): unowned baselines are removed on start", () => {
  it("names removeUnownedBaselineSchedules in the schedule systems description", () => {
    const systems = SCHEDULE_SYSTEMS.find((s) => s.id === "orchestrator-durable-schedules");
    expect(systems?.creation).toContain("removeUnownedBaselineSchedules");
  });
});

describe("S0-P10 tick evaluation (B-T3-01): goals are tick-polled, never SDK-scheduled", () => {
  it("pins the three schedule systems and the no-callback rule", () => {
    expect(SCHEDULE_SYSTEMS.map((s) => s.id)).toEqual([
      "orchestrator-durable-schedules",
      "scheduled-agent-goals",
      "worker-cron-triggers",
    ]);
    const agent = read("src/agents/scheduled-agent.ts");
    expect(agent).toContain("onCron() calls, never via the SDK scheduler");
    expect(agent).toContain("isDue(goal.cron, goal.lastRun, now, goal.timeZone)");
  });
});

describe("S0-P11 isDue gates (B-T3-02): 23h guard, timezone mode, never throws, NaN quirk", () => {
  it("fires in the target hour/minute window in UTC mode", () => {
    expect(isDue("0 6 * * *", undefined, new Date(Date.UTC(2026, 10, 5, 6, 5, 0)))).toBe(true);
    expect(isDue("0 6 * * *", undefined, new Date(Date.UTC(2026, 10, 5, 7, 5, 0)))).toBe(false);
    expect(isDue("0 6 * * *", undefined, new Date(Date.UTC(2026, 10, 5, 5, 59, 0)))).toBe(false);
  });

  it("suppresses a re-fire within 23 hours and allows one after 24 hours", () => {
    const now = new Date(Date.UTC(2026, 10, 5, 6, 5, 0));
    expect(isDue("0 6 * * *", "2026-11-05T05:05:00.000Z", now)).toBe(false);
    expect(isDue("0 6 * * *", "2026-11-04T06:05:00.000Z", now)).toBe(true);
  });

  it("preserves the opportunity-hunt quirk: '0 */6 * * *' is NEVER due in UTC mode", () => {
    expect(isDue("0 */6 * * *", undefined, new Date(Date.UTC(2026, 10, 5, 6, 0, 0)))).toBe(false);
    expect(isDue("0 */6 * * *", undefined, new Date(Date.UTC(2026, 10, 5, 12, 0, 0)))).toBe(false);
  });

  it("never throws on an unparseable cron or an unknown zone", () => {
    expect(isDue("not a cron", undefined, MON_0900_EDT)).toBe(false);
    expect(isDue("0 6 * * *", undefined, MON_0900_EDT, "No/Such_Zone")).toBe(false);
  });

  it("matches wall-clock parts in the goal's IANA zone", () => {
    expect(isDue("0 9 * * 1-5", undefined, MON_0900_EDT, "America/New_York")).toBe(true);
    expect(isDue("0 9 * * 1-5", undefined, MON_0900_EDT, "UTC")).toBe(false);
  });
});

describe("S0-P12 budget gate (B-T3-03): one check per firing, named bucket", () => {
  it("names the budget check and its explicit bucket in onCron", () => {
    const agent = read("src/agents/scheduled-agent.ts");
    expect(agent).toContain("budgetCheck({");
    expect(agent).toContain("agentId: AGENTIC_SPEND_AGENT_ID");
    expect(agent).toContain("budget check rejected");
  });
});

describe("S0-P13 in-flight firing guard (B-T3-04): duplicate firings are refused, claim goes stale", () => {
  it("pins the 30-minute stale claim window", () => {
    expect(GOAL_FIRING_STALE_MS).toBe(30 * 60 * 1000);
    const agent = read("src/agents/scheduled-agent.ts");
    expect(agent).toContain("already in flight");
    expect(agent).toContain("claimGoalFiring");
  });
});

describe("S0-P14 pipeline goals (B-T3-05): one firing, one budget check, fail-closed", () => {
  it("names the pipeline branch and its fail-closed unknown-pipeline rule", () => {
    const agent = read("src/agents/scheduled-agent.ts");
    expect(agent).toContain('goal.operation.startsWith("pipeline:")');
    expect(agent).toContain("Unknown pipeline ids fail closed");
  });
});

describe("S0-P15 synthesized schedules (B-T3-06): materialize first, fire via onCron", () => {
  it("refuses direct firing of unmaterialized synthesized schedules", () => {
    const agent = read("src/agents/scheduled-agent.ts");
    expect(agent).toContain("must materialize first and fire via onCron");
    expect(agent).toContain("materializeSynthesizedSchedule");
  });
});

describe("S0-P16 goal store (B-T3-07): nine shipped goals, social post disabled", () => {
  it("pins the DEFAULT_SCHEDULES ids and the disabled social post", () => {
    expect(DEFAULT_SCHEDULES.map((g) => g.id)).toEqual([
      ...SCHEDULED_GOAL_IDS_INVENTORY,
    ]);
    expect(SCHEDULED_GOAL_IDS_INVENTORY).toHaveLength(9);
    const social = DEFAULT_SCHEDULES.find((g) => g.id === "daily-social-post");
    expect(social).toMatchObject({
      cron: "0 9 * * 1-5",
      timeZone: "America/New_York",
      operation: "social.publish",
      enabled: false,
    });
  });
});

describe("S0-P17 worker cron duties (B-T1-01/02): renewal runs either way, tick fans out", () => {
  it("pins renewal, the tick fan-out, and the provisioning gate", () => {
    // Slice 8 of #2902 moves scheduled() from server.ts to
    // src/server/routes/queue.ts; S5 (#3121) moves the branch bodies
    // into the named entry points in consolidatedCronEntries.ts —
    // the dispatcher keeps the gate evaluation + stub creation, the
    // module keeps the dispatches. The entry surface is all three
    // files; the pin tracks the move (gitops §7). The route list is
    // SIX, not five: the pre-S5 list omitted the
    // reports-index-backfill sweep, the same six-vs-seven error S5
    // corrects in §1.2.
    const server = read("src/server.ts") + read("src/server/routes/queue.ts");
    const entries = read("src/services/consolidatedCronEntries.ts");
    expect(server).toContain("renewAllStoredETradeTokens");
    expect(server).toContain("SCHEDULED_AGENT");
    expect(entries).toContain("scheduledAgent.onCron()");
    for (const route of [
      "/research/scheduled-tick",
      "/reflection/run",
      "/adaptation/weights/run",
      "/knowledge/corpus-sync",
      "/trading/reports/index-backfill-sweep",
      "/payments/agentic/commercial/lifecycle/digest/run-due",
    ]) {
      expect(entries).toContain(route);
    }
    expect(entries).toContain("is not provisioned for the platform tier");
    expect(SCHEDULED_JOB_OUTCOME_TYPE).toBe("scheduled_job.outcome");
  });
});

describe("S0-P18 retention (B-T1-03/05): window, defaults, audit-chain guard", () => {
  it("pins the retention defaults and the pinned retention cron", () => {
    expect(MAS_EVENTS_RETENTION_DEFAULT_DAYS).toBe(365);
    expect(MAS_MEMORY_RETENTION_DEFAULT_DAYS).toBe(365);
    expect(STORAGE_RETENTION_DEFAULT_DAYS).toBe(90);
    expect(STORAGE_RETENTION_CRON).toBe("0 4 * * *");
    expect(STORAGE_RETENTION_DEFAULT_BATCH_SIZE).toBe(500);
    expect(STORAGE_RETENTION_DEFAULT_MAX_PER_RUN).toBe(5000);
  });

  it("verifies the audit chain before pruning and skips the prune on failure", () => {
    const routes = read("src/agents/routes/schedules.ts");
    expect(routes).toContain("verifyStoredAuditChainAndAlert");
    expect(routes).toContain("audit chain verification FAILED");
  });
});

describe("S0-P19 piggyback research guard (B-T1-04): exactly once per weekday at/after 21:00 UTC", () => {
  it("pins the guard constants", () => {
    expect(RESEARCH_SCHEDULED_FIRE_HOUR_UTC).toBe(21);
    expect(RESEARCH_SCHEDULED_LAST_RUN_KEY).toBe("research_scheduled_last_run");
    expect(researchTickDateKey(new Date(Date.UTC(2026, 9, 19, 23, 59)))).toBe("2026-10-19");
  });

  it("fires on a weekday at/after 21:00 UTC and refuses weekend / too-early / already-fired", () => {
    expect(shouldFireResearchTick(MON_2105_UTC, null)).toEqual({
      fire: true,
      dateKey: "2026-10-19",
    });
    expect(shouldFireResearchTick(new Date(Date.UTC(2026, 9, 19, 21, 0, 0)), null).fire).toBe(true);
    expect(
      shouldFireResearchTick(new Date(Date.UTC(2026, 9, 17, 21, 5, 0)), null),
    ).toMatchObject({ fire: false, reason: "weekend" });
    expect(
      shouldFireResearchTick(new Date(Date.UTC(2026, 9, 19, 20, 59, 0)), null),
    ).toMatchObject({ fire: false, reason: "too-early" });
    expect(shouldFireResearchTick(MON_2105_UTC, "2026-10-19")).toMatchObject({
      fire: false,
      reason: "already-fired",
    });
  });
});

describe("S0-P20 follow-up chain entry (B-T4-01): scheduleScreenerFollowups bridges a run end-to-end", () => {
  it("names the chain entry and its chainReport=false variant", () => {
    const jobs = read("src/agents/orchestrator/asyncJobs.ts");
    expect(jobs).toContain("export async function scheduleScreenerFollowups(");
    expect(jobs).toContain("recordScreenerRunMainJob");
    expect(jobs).toContain("chainReport: chainReport !== false");
  });
});

describe("S0-P21 chain graph and recovery (B-T4-02/04): graph columns, LIMIT 100, 30-day / 2-hour bounds", () => {
  it("pins the mas_async_jobs graph columns and the recovery re-arm", () => {
    const adapter = read("src/data/doSqliteAsyncJobAdapter.ts");
    for (const col of ["parent_job_id", "job_kind", "channel", "not_before", "stage", "chain_id"]) {
      expect(adapter).toContain(`ADD COLUMN ${col}`);
    }
    expect(adapter).toContain("ORDER BY created_at ASC LIMIT 100");
    const jobs = read("src/agents/orchestrator/asyncJobs.ts");
    expect(jobs).toContain("30 * 24 * 60 * 60 * 1000");
    expect(jobs).toContain("2 * 60 * 60 * 1000");
    expect(jobs).toContain("retry: { maxAttempts: 1 }");
  });
});

describe("S0-P22 chain retry (B-T4-03): retry-of, failed row kept, double retry refused", () => {
  it("names the retry rules and its audit event", () => {
    const jobs = read("src/agents/orchestrator/asyncJobs.ts");
    expect(jobs).toContain("payload.retryOf = jobId");
    expect(jobs).toContain("was already retried as job");
    expect(jobs).toContain('ctx.audit("async_job.retried"');
  });
});

describe("S0-P23 keyless options runs (B-T4-05): a keyless run is recorded, never silent", () => {
  it("names the keyless-record fix", () => {
    const jobs = read("src/agents/orchestrator/asyncJobs.ts");
    expect(jobs).toContain("recordKeylessOptionsServe");
    expect(jobs).toContain("never a silent absence");
  });
});

describe("S0-P24 ledger gap (B-L-01/02/03): S1 closes B-L-01 on job_run_records; B-L-02/03 remain", () => {
  it("pins job_run_records as carrying the four §4 linkage columns (B-L-01 closed by S1)", () => {
    const adapter = read("src/data/doSqliteJobRunRecordAdapter.ts");
    for (const col of ["trigger_text", "schedule_id", "async_job_id", "workflow_id"]) {
      expect(adapter).toContain(col);
    }
  });

  it("pins mas_async_jobs as carrying no workflow column (#3810 adds trigger/schedule provenance columns)", () => {
    const adapter = read("src/data/doSqliteAsyncJobAdapter.ts");
    // #3810: the adapter gains the three provenance columns (probed migration).
    for (const col of ["trigger", "triggered_by", "schedule_id"]) {
      expect(adapter).toContain(`ADD COLUMN ${col}`);
    }
    expect(adapter).not.toContain("workflow_id");
  });

  it("pins mas_opportunity_scans as carrying no linkage columns", () => {
    const scans = read("src/data/doSqliteScanRunAdapter.ts");
    const create = scans.slice(
      scans.indexOf("CREATE TABLE IF NOT EXISTS"),
      scans.indexOf(";", scans.indexOf("CREATE TABLE IF NOT EXISTS")),
    );
    for (const col of ["trigger", "schedule_id", "async_job_id", "workflow_id"]) {
      expect(create).not.toContain(col);
    }
    expect(create).toContain("user_login");
  });
});

describe("S0-P25 provenance gap (B-L-04): S1 stamps provenance on the create route; the update path preserves it", () => {
  it("finds provenance stamping on the schedule create route, and the update service carries provenance through", () => {
    expect(read("src/agents/routes/schedules.ts")).toContain("provenance");
    expect(read("src/agents/routes/schedules.ts")).toContain("stampScheduleProvenance");
    // Issue #3121 Phase 2 (#3123) — scheduleManagement.ts is retired;
    // the update rule lives in unifiedScheduleManagement.ts, where a
    // rebuilt payload keeps the original creation provenance verbatim
    // (an update never rewrites creation time).
    expect(read("src/services/unifiedScheduleManagement.ts")).toContain("provenance");
    expect(read("src/services/unifiedScheduleManagement.ts")).toContain("carryScheduleProvenance");
  });
});

describe("S0-P26 type-2 instances: pushTicks and the stale sweep ride scheduleEvery", () => {
  it("pins the ticker callback name and the 6-hour stale sweep", () => {
    expect(TICKER_PUSH_CALLBACK).toBe("pushTicks");
    const orchestrator = read("src/agents/orchestrator.ts");
    expect(orchestrator).toContain("STALE_SWEEP_INTERVAL_SECONDS = 6 * 60 * 60");
    expect(orchestrator).toContain('scheduleEvery(STALE_SWEEP_INTERVAL_SECONDS, "sweepStaleLedgerTasks"');
  });
});

describe("S0-P27 drift D6: the #2366 hung-timeout claim is not locatable under src/", () => {
  it("records that no hungTimeout mechanism exists in the named async homes", () => {
    for (const rel of ["src/agents/orchestrator/asyncJobs.ts", "src/agents/orchestrator.ts"]) {
      expect(read(rel)).not.toContain("hungTimeout");
    }
  });
});

describe("U-P01 URL inventory (§8 U-01): nav-config.json schedules route is de-hubbed in S2", () => {
  it("pins no retain flag, no navEntry, and the schedules-home description", () => {
    const config = JSON.parse(read("src/client/nav-config.json")) as {
      routes: Array<Record<string, unknown>>;
    };
    const route = config.routes.find((r) => r.id === "schedules");
    expect(route).toBeDefined();
    // S2 (#3121): the home renders from the shell (Chat.tsx
    // TAB_CONTENT), not through the retained ETradeTradingHub — the
    // route lost its retain flag.
    expect(route!.retain).toBeUndefined();
    expect(route!).not.toHaveProperty("navEntry");
    expect(route!.navGroup).toBe("schedules");
    expect(route!.description as string).toContain("schedules");
  });
});

describe("U-P02 URL inventory (§8 U-01/U-02): navConfig.ts #2974 synthesizes the Schedules nav item", () => {
  it("pins the label, Cron badge, description, and home-only active logic", () => {
    const nav = read("src/client/navConfig.ts");
    expect(nav).toContain("// Issue #2974: insert Schedules before the Workflows item");
    expect(nav).toContain('label: "Schedules"');
    expect(nav).toContain('badge: "Cron"');
    expect(nav).toContain(
      'description: "The one scheduling surface for screening runs — create, pause, and inspect scheduled jobs"',
    );
    expect(nav).toContain('if (item.id === "schedules") {');
    expect(nav).toContain('return currentTab === "schedules";');
    // S2 (#3121): the dual address is retired — no screeners address
    // may activate the Schedules item anymore.
    expect(nav).not.toContain('currentTab === "screeners" && (view === "schedules"');
  });
});

describe("U-P03 URL inventory (§8 U-03/U-04/U-05): deep links and deep-link surfaces for schedules", () => {
  it("pins the retired options deep link as gone and the platform-admin view values", () => {
    const config = JSON.parse(read("src/client/nav-config.json")) as {
      deepLinks: Record<string, unknown>;
      deepLinkSurfaces: Array<{ page: string; values: string[] }>;
    };
    // U-03 (owner decision, #3121 comment 6669207975): the
    // scheduled-screening deep link is gone with the mode — the
    // address redirects to the schedules home and the content it
    // carried lives on the Options Runs tab.
    expect(config.deepLinks["options-screener:scheduled-screening"]).toBeUndefined();
    const optionsHub = config.deepLinkSurfaces.find((s) => s.page === "options");
    expect(optionsHub).toBeDefined();
    expect(optionsHub!.values).not.toContain("scheduled-screening");
    const platformAdmin = config.deepLinkSurfaces.find((s) => s.page === "platform-admin");
    expect(platformAdmin).toBeDefined();
    expect(platformAdmin!.values).toContain("scheduled-goals");
    // "jobs" is a platform-admin section (and a PlatformAdminPage tab),
    // not a deepLinkSurfaces value — the view is read from ?view= directly.
    const sections = (
      config as { platformAdminSections: Array<{ items: Array<{ id: string }> }> }
    ).platformAdminSections.flatMap((s) => s.items.map((i) => i.id));
    expect(sections).toContain("scheduled-goals");
    expect(sections).toContain("jobs");
  });
});

describe("U-P04 URL inventory (§8 U-01): Chat.tsx renders schedules from the shell, de-hubbed in S2", () => {
  it("pins the home in TAB_CONTENT and the absence of any hub mapping", () => {
    const types = read("src/client/chat/types.ts");
    expect(types).not.toContain('case "schedules":\n      return "schedules";');
    const chat = read("src/client/Chat.tsx");
    expect(chat).toContain("the URL is the source of truth for navigation");
    // A CRLF checkout (Windows, or a blob that lost normalization) must not fail a
    // source-shape pin; the shape is what matters, not the line ending.
    expect(chat.replace(/\r\n/g, "\n")).toContain(
      "schedules: (\n      <SchedulesHome",
    );
    expect(chat).toContain('import { SchedulesHome } from "./SchedulesHome";');
    const hub = read("src/client/ETradeTradingHub.tsx");
    expect(hub).not.toContain('{effectiveSubTab === "schedules" && (');
    expect(hub).not.toContain("<SchedulesPanel");
  });
});

describe("U-P05 URL inventory (§8 U-06): the IAAA admin Queue sub-tab is retired to the home in S2", () => {
  it("pins the redirect (not a mount): the queue lives at ?tab=schedules&view=queue", () => {
    const panel = read("src/client/IaaaAdminPanel.tsx");
    expect(panel).not.toContain('{ id: "queue", label: "Queue" }');
    expect(panel).not.toContain("<AdminQueueWipePanel />");
    const home = read("src/client/schedulesHomeView.ts");
    expect(home).toContain('params.get("iaaaTab") === "queue"');
    expect(home).toContain('return { tab: SCHEDULES_HOME_TAB, view: "queue" };');
    const queueView = read("src/client/ScheduleQueueView.tsx");
    expect(queueView).toContain("fetchAdminOverview()");
    expect(queueView).toContain("<AdminQueueWipePanel />");
  });
});

describe("U-P06 URL inventory (§8): the hub sub-tab is a local mirror of the URL-driven value", () => {
  it("pins the local subTab state synced from the activeSubTab prop", () => {
    const hub = read("src/client/ETradeTradingHub.tsx");
    expect(hub).toContain(
      "const [subTab, setSubTab] = useState<TradingSubTab>(activeSubTab || \"autopilot\");",
    );
    expect(hub).toContain(
      'const effectiveSubTab: TradingSubTab = activeSubTab || subTab || "autopilot";',
    );
  });
});
