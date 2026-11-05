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

describe("S0-P01 worker crons (B-T1-01/02/03): exactly three triggers in wrangler.jsonc", () => {
  it("pins the three cron entries, with no fourth trigger", () => {
    const wrangler = read("wrangler.jsonc");
    const cronsStart = wrangler.indexOf('"crons": [') + '"crons": ['.length;
    expect(cronsStart).toBeGreaterThanOrEqual('"crons": ['.length);
    const cronsEnd = wrangler.indexOf("]", cronsStart);
    expect(cronsEnd).toBeGreaterThan(cronsStart);
    // Strip full-line // comments first: the ceiling note quotes the
    // refused "0 21 * * 1-5" trigger, which must NOT count as an entry.
    const block = wrangler
      .slice(cronsStart, cronsEnd)
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const entries = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(entries).toEqual(["0 3 * * *", "*/30 * * * *", "0 4 * * *"]);
    expect(WORKER_CRON_TRIGGERS_INVENTORY).toEqual(entries);
    expect(block).not.toContain("0 21 * * 1-5");
  });

  it("dispatches on event.cron for exactly those three expressions in scheduled()", () => {
    const server = read("src/server.ts");
    for (const cron of ["0 3 * * *", "*/30 * * * *", "0 4 * * *"]) {
      expect(server).toContain(`event?.cron === "${cron}"`);
    }
  });
});

describe("S0-P02 SDK timing forms (B-T2-01): four forms resolve through ctx.schedule/scheduleEvery", () => {
  it("lists all four forms in the route table and resolves each", () => {
    const routes = read("src/agents/routes/schedules.ts");
    expect(routes).toContain("?type=cron|interval|delayed|scheduled");
    expect(routes).toContain("ctx.schedule(timing.cron, callback, payload, { idempotent: true })");
    expect(routes).toContain("ctx.scheduleEvery(timing.intervalSeconds, callback, payload)");
    expect(routes).toContain("ctx.schedule(new Date(timing.time * 1000), callback, payload)");
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

describe("S0-P05 pause/resume/trigger/delete/detail (B-T2-04): paused store round-trips", () => {
  it("names the pause/resume/trigger/delete/detail routes and the paused store", () => {
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
    expect(routes).toContain("pausedStore()");
    expect(routes).toContain("pausedRecordToListItem");
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
  it("pins the record fields — and the absence of ledger linkage columns", () => {
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
      "error",
      "detail",
      "descriptor",
      "artifactRefs",
    ]);
    // The #3264 gap, pinned: no scheduleId / asyncJobId / workflowId.
    expect(JOB_RUN_RECORD_FIELDS).not.toContain("scheduleId");
    expect(JOB_RUN_RECORD_FIELDS).not.toContain("asyncJobId");
    expect(JOB_RUN_RECORD_FIELDS).not.toContain("workflowId");
    expect(JOB_RUN_RECORD_FIELDS).not.toContain("trigger");
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

describe("S0-P16 goal store (B-T3-07): eight shipped goals, social post disabled", () => {
  it("pins the DEFAULT_SCHEDULES ids and the disabled social post", () => {
    expect(DEFAULT_SCHEDULES.map((g) => g.id)).toEqual([
      ...SCHEDULED_GOAL_IDS_INVENTORY,
    ]);
    expect(SCHEDULED_GOAL_IDS_INVENTORY).toHaveLength(8);
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
    const server = read("src/server.ts");
    expect(server).toContain("renewAllStoredETradeTokens");
    expect(server).toContain("schedAgent.onCron()");
    for (const route of [
      "/research/scheduled-tick",
      "/reflection/run",
      "/adaptation/weights/run",
      "/knowledge/corpus-sync",
      "/payments/agentic/commercial/lifecycle/digest/run-due",
    ]) {
      expect(server).toContain(route);
    }
    expect(server).toContain("is not provisioned for the platform tier");
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

describe("S0-P24 ledger gap (B-L-01/02/03): no run store carries trigger/scheduleId/asyncJobId/workflowId", () => {
  it("pins mas_async_jobs as carrying no schedule/workflow/trigger column", () => {
    const adapter = read("src/data/doSqliteAsyncJobAdapter.ts");
    expect(adapter).not.toContain("schedule_id");
    expect(adapter).not.toContain("workflow_id");
    expect(adapter).not.toContain("ADD COLUMN trigger");
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

describe("S0-P25 provenance gap (B-L-04): no origin/provenance on any schedule path", () => {
  it("finds no provenance field on the schedule routes or schedule management", () => {
    for (const rel of ["src/agents/routes/schedules.ts", "src/services/scheduleManagement.ts"]) {
      expect(read(rel)).not.toContain("provenance");
    }
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
