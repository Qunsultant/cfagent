/**
 * Issue #3121 Slice S6 — final parity + deprecation renames.
 *
 * S6 closes the scheduling consolidation program's core slices (S0–S5
 * merged). It proves the §9 capability-coverage map complete against
 * §1, corrects the two stale §9 rows (U-07, U-08), records the one
 * §9 row S2 filed but never mapped (#3361), admits `worker-cron`
 * into the S1 ledger builder's SYSTEMS allowlist (the S5 decision 9
 * follow-up, whose precondition — #3650 landed via Qunsultant/cfagent#3723
 * — is now met), and pins the retired-module determination: ZERO
 * renames, because every S0 old-home module still has a live
 * production importer (consumer analysis on main 7c461e5, 2026-11-11).
 * S1–S5 migrated behavior in place; the consolidated path IS those
 * modules plus the two new consolidated modules, not a replacement
 * for them. Fail closed: nothing is renamed on an uncertain
 * retirement, and no retirement list is invented.
 *
 * - S6-P01 §9 map completeness (accounting, not literal sizes): every
 *   §9 table row's Status names a landed slice, a preserved
 *   capability, a filed open issue, Phase 2 / Phase 3, or an explicit
 *   out-of-scope owner (a named issue in another program, e.g.
 *   #2366). No row stays "planned" and no row has no home without a
 *   filed issue or a named owner.
 * - S6-P02 §9 carries the #3361 row (preview-trade prefill, filed
 *   in S2, never mapped — landed by #3361 after S6).
 * - S6-P03 U-07 corrected: the Queues tab (`?tab=queues`,
 *   QueuesPage) is the T4 surface with S4 linkage landed; the admin
 *   queue is `?tab=schedules&view=queue` (S2).
 * - S6-P04 U-08 corrected: the workflow-runs deep link (`?run=`,
 *   #2777/#3163) and the stamped `schedule_id` schedule column
 *   (#3810) are landed; the #3264 read-path gap's remainder is
 *   #3314 (open).
 * - S6-P05 the four surfaces are reachable through the consolidated
 *   path: the home's four views resolve (list/runs/goals/queue,
 *   `ledger` aliasing `runs`), `SchedulesHome` renders each view's
 *   consolidated panel, and the five retired addresses redirect.
 * - S6-P06 `worker-cron` is admitted into the `buildJobRunRecord`
 *   SYSTEMS allowlist (S5 decision 9 follow-up).
 * - S6-P07 retired-module determination: every S0 old-home module
 *   still has a live production importer (declared pairs, each
 *   proven by an import) — except `src/services/scheduleManagement.ts`,
 *   retired by #3123 (its pair is replaced by the unified successor
 *   pair below); the deprecated set is exactly the three known AOP
 *   files plus the five #3123 renames plus the #4192 screener-flow
 *   rename, and the deprecation ledger carries the five #3123 entries.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildJobRunRecord } from "../src/services/jobRunRecords";
import { buildCronDispatchRecord } from "../src/services/consolidatedCronEntries";
import {
  SCHEDULES_HOME_VIEWS,
  legacySchedulesRedirect,
  normalizeSchedulesHomeView,
  parseSchedulesDeepLink,
} from "../src/client/schedulesHomeView";

function source(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

/** The §9 capability-coverage map section of the S0 doc. */
function section9(): string {
  const doc = source("docs/architecture/scheduling/3121-s0-inventory.md");
  const start = doc.indexOf("## 9. Capability-coverage map");
  expect(start).toBeGreaterThan(-1);
  return doc.slice(start);
}

function section91to97(name: string, next: string | null): string {
  const s9 = section9();
  const start = s9.indexOf(name);
  expect(start).toBeGreaterThan(-1);
  if (next === null) return s9.slice(start);
  const end = s9.indexOf(next, start);
  expect(end).toBeGreaterThan(start);
  return s9.slice(start, end);
}

/** Table rows of a §9 section: [cells...] per row, header/separator skipped. */
function tableRows(section: string): string[][] {
  return section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter(
      (cells) =>
        cells.length >= 4 &&
        cells[0] !== "Capability" &&
        !cells[0].startsWith("---"),
    );
}

/** A §9 row is complete iff its Status names a landed slice, a preserved capability, a filed open issue, Phase 2/3, or an explicit out-of-scope owner (a named issue in another program). */
function isCompleteStatus(status: string): boolean {
  return (
    status.includes("landed") ||
    status.includes("preserved") ||
    /Filed #\d+ \(open\)/.test(status) ||
    status.includes("Phase 2") ||
    status.includes("Phase 3") ||
    (/out of scope/i.test(status) && /#\d+/.test(status))
  );
}

describe("S6-P01 §9 map completeness", () => {
  it("every §9 row has a complete status (landed, preserved, filed-open, Phase 2/3, or out-of-scope with a named owner)", () => {
    const rows = tableRows(section9());
    expect(rows.length).toBeGreaterThan(0);
    const incomplete = rows.filter((cells) => !isCompleteStatus(cells[3]));
    expect(incomplete).toEqual([]);
  });

  it("no §9 row is left 'planned' outside Phase 2/3 and none is homeless without a filed issue", () => {
    const rows = tableRows(section9());
    for (const cells of rows) {
      const [capability, , home, status] = cells;
      if (status.includes("(planned)")) {
        expect(
          status.includes("Phase 2") || status.includes("Phase 3"),
        ).toBe(true);
      }
      if (home.includes("no home")) {
        expect(status).toMatch(/Filed #\d+ \(open\)/);
      }
      expect(capability.length).toBeGreaterThan(0);
    }
  });
});

describe("S6-P02 §9 carries the #3361 row", () => {
  it("§9.2 names the preview-trade prefill as #3361 landed (S6 mapped it as filed-open; #3361 landed it)", () => {
    const s92 = section91to97("### 9.2 Surfaces", "### 9.3");
    expect(s92).toContain("#3361");
    expect(s92).toContain("Preview-trade");
    expect(s92).toContain("#3361 — landed");
  });
});

describe("S6-P03 U-07 corrected", () => {
  it("§9.6 names the Queues tab as the T4 surface with S4 linkage landed", () => {
    const s96 = section91to97("### 9.6 URL inventory", null);
    expect(s96).not.toContain("S4 (planned)");
    expect(s96).toContain("?tab=queues");
    expect(s96).toContain("QueuesPage");
    expect(s96).toContain("S4 — landed");
  });

  it("the admin queue resolves through the consolidated home (view=queue, S2)", () => {
    expect(parseSchedulesDeepLink("?tab=schedules&view=queue").view).toBe(
      "queue",
    );
    expect(
      legacySchedulesRedirect(
        "?tab=platform-admin&view=iaaa-admin&iaaaTab=queue",
      ),
    ).toEqual({ tab: "schedules", view: "queue" });
    const home = source("src/client/SchedulesHome.tsx");
    expect(home).toContain("ScheduleQueueView");
    expect(home).toContain('tabId="queue"');
  });
});

describe("S6-P04 U-08 corrected", () => {
  it("§9.6 names the workflow-runs deep link and stamped schedule_id as landed", () => {
    const s96 = section91to97("### 9.6 URL inventory", null);
    expect(s96).not.toContain("S4/S6 (planned)");
    expect(s96).toContain("?tab=workflow-runs&run=");
    expect(s96).toContain("#3810");
    expect(s96).toContain("schedule_id");
    expect(s96).toContain("#3314");
  });

  it("the panel deep-links by run id and the runs projection reads stamped schedule_id", () => {
    const panel = source("src/client/WorkflowRunsPanel.tsx");
    expect(panel).toContain("?tab=workflow-runs&run=<id>");
    expect(panel).toContain("#2777");
    expect(panel).toContain("#3163");
    const runs = source("src/services/workflowRuns.ts");
    expect(runs).toContain("schedule_id?: string | null");
    expect(runs).toContain("#3810");
  });
});

describe("S6-P05 four surfaces reachable through the consolidated path", () => {
  it("the home resolves exactly the four views, ledger aliasing runs", () => {
    expect([...SCHEDULES_HOME_VIEWS]).toEqual([
      "list",
      "runs",
      "goals",
      "queue",
    ]);
    for (const view of ["list", "runs", "goals", "queue"] as const) {
      expect(parseSchedulesDeepLink(`?tab=schedules&view=${view}`).view).toBe(
        view,
      );
    }
    expect(normalizeSchedulesHomeView("ledger")).toBe("runs");
    expect(normalizeSchedulesHomeView("nonsense")).toBe("list");
    expect(parseSchedulesDeepLink("?tab=schedules&schedule=abc").view).toBe(
      "list",
    );
    expect(parseSchedulesDeepLink("?tab=schedules&run=job_1").view).toBe(
      "runs",
    );
  });

  it("SchedulesHome renders each view's consolidated panel", () => {
    const home = source("src/client/SchedulesHome.tsx");
    expect(home).toContain("SchedulesPanel");
    expect(home).toContain("ScheduleRunLedgerPanel");
    expect(home).toContain("ScheduledGoalsPanel");
    expect(home).toContain("ScheduleQueueView");
    expect(home).toContain('deepLink.view === "list"');
    expect(home).toContain('deepLink.view === "runs"');
    expect(home).toContain('deepLink.view === "goals"');
    expect(home).toContain('deepLink.view === "queue"');
  });

  it("all five retired addresses redirect to the home", () => {
    expect(legacySchedulesRedirect("?tab=screeners&view=schedules")).toEqual({
      tab: "schedules",
    });
    expect(
      legacySchedulesRedirect("?tab=options&view=scheduled-screening"),
    ).toEqual({ tab: "schedules" });
    expect(
      legacySchedulesRedirect("?tab=platform-admin&view=scheduled-goals"),
    ).toEqual({ tab: "schedules", view: "goals" });
    expect(legacySchedulesRedirect("?tab=platform-admin&view=jobs")).toEqual({
      tab: "schedules",
      view: "runs",
    });
    expect(
      legacySchedulesRedirect(
        "?tab=platform-admin&view=iaaa-admin&iaaaTab=queue",
      ),
    ).toEqual({ tab: "schedules", view: "queue" });
    expect(legacySchedulesRedirect("?tab=schedules&view=list")).toBeNull();
  });
});

describe("S6-P06 worker-cron admitted to the ledger builder (S5 decision 9)", () => {
  const WORKER_CRON_INPUT = {
    system: "worker-cron" as const,
    jobId: "*/30 * * * *",
    operation: "tick",
    started: "2026-11-11T10:30:00.000Z",
    finished: "2026-11-11T10:30:01.000Z",
    outcome: "success" as const,
    triggeredBy: "scheduled" as const,
    trigger: "worker-cron" as const,
  };

  it("buildJobRunRecord accepts system worker-cron", () => {
    const record = buildJobRunRecord(WORKER_CRON_INPUT);
    expect(record.system).toBe("worker-cron");
    expect(record.trigger).toBe("worker-cron");
    expect(record.jobId).toBe("*/30 * * * *");
  });

  it("the SYSTEMS allowlist names worker-cron (S5 decision 9 follow-up)", () => {
    const builder = source("src/services/jobRunRecords.ts");
    expect(builder).toContain('"worker-cron"');
  });

  it("buildCronDispatchRecord still stamps worker-cron (restamp retained, S6)", () => {
    const record = buildCronDispatchRecord({
      entryPoint: "tick",
      cron: "*/30 * * * *",
      outcome: "success",
      started: "2026-11-11T10:30:00.000Z",
      finished: "2026-11-11T10:30:01.000Z",
    });
    expect(record.system).toBe("worker-cron");
    expect(record.scheduleId).toBe("*/30 * * * *");
    const entries = source("src/services/consolidatedCronEntries.ts");
    expect(entries).toContain("S6");
    expect(entries).toContain("admits");
  });
});

describe("S6-P07 retired-module determination: the #3123 renames", () => {
  /**
   * Each pair is one S0 old-home module plus one live production
   * importer that must import it (consumer analysis on main 7c461e5,
   * 2026-11-11). A module is retired only when its capability fully
   * moved AND all consumers migrated. Issue #3121 Phase 2 (#3123)
   * retired exactly one pair below — `src/services/scheduleManagement.ts`
   * (capability moved to unifiedScheduleManagement.ts, all consumers
   * migrated) — so that pair is replaced by the successor pair; every
   * other module below still has a live consumer.
   */
  const LIVE_CONSUMERS: Array<[string, string, string]> = [
    ["src/agents/routes/schedules.ts", "src/agents/orchestrator/routeRequest.ts", "schedules"],
    ["src/services/unifiedScheduleManagement.ts", "src/agents/routes/schedules.ts", "unifiedScheduleManagement"],
    ["src/agents/orchestrator/scheduleCallbacks.ts", "src/agents/orchestrator.ts", "scheduleCallbacks"],
    ["src/agents/orchestrator/scheduleCallbackRunRecords.ts", "src/agents/routes/cronDispatchRecord.ts", "scheduleCallbackRunRecords"],
    ["src/agents/scheduled-agent.ts", "src/server/exports.ts", "scheduled-agent"],
    ["src/schedule.ts", "src/agents/scheduled-agent.ts", "schedule"],
    ["src/services/goalFiringClaims.ts", "src/agents/scheduled-agent.ts", "goalFiringClaims"],
    ["src/agents/orchestrator/asyncJobs.ts", "src/agents/orchestrator.ts", "asyncJobs"],
    ["src/data/doSqliteAsyncJobAdapter.ts", "src/data/createAsyncJobPorts.ts", "doSqliteAsyncJobAdapter"],
    ["src/services/scheduleSystems.ts", "src/server/routes/trading.ts", "scheduleSystems"],
    ["src/services/scheduleDedupe.ts", "src/agents/routes/schedules.ts", "scheduleDedupe"],
    ["src/services/researchScheduleGuard.ts", "src/agents/research-agent.ts", "researchScheduleGuard"],
    ["src/services/scheduledTasks.ts", "src/agents/orchestrator.ts", "scheduledTasks"],
    ["src/services/scheduledReports.ts", "src/agents/mas.ts", "scheduledReports"],
    ["src/services/scheduleWatchdog.ts", "src/agents/orchestrator.ts", "scheduleWatchdog"],
    ["src/services/scheduledBrokerGuard.ts", "src/services/scheduledTasks.ts", "scheduledBrokerGuard"],
    ["src/services/scheduledEffectiveMode.ts", "src/services/scheduledTasks.ts", "scheduledEffectiveMode"],
    ["src/server/routes/queue.ts", "src/server.ts", "queue"],
    ["src/client/SchedulesPanel.tsx", "src/client/SchedulesHome.tsx", "SchedulesPanel"],
    ["src/client/ScheduledOptionsManager.tsx", "src/client/SchedulesPanel.tsx", "ScheduledOptionsManager"],
    ["src/client/ScheduledGoalsPanel.tsx", "src/client/SchedulesHome.tsx", "ScheduledGoalsPanel"],
    ["src/client/AdminQueueWipePanel.tsx", "src/client/ScheduleQueueView.tsx", "AdminQueueWipePanel"],
  ];

  it("every S0 old-home module still has a live production importer", () => {
    for (const [module, importer, stem] of LIVE_CONSUMERS) {
      const importerSource = source(importer);
      expect(
        importerSource.includes(`/${stem}"`) ||
          importerSource.includes(`/${stem}'`),
        `${module} must still be imported by ${importer}`,
      ).toBe(true);
    }
  });

  it("the deprecated set is exactly the three known AOP files plus the five #3123 renames plus the #4192 screener-flow rename plus the #4280 chain-start rename", () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(rel);
        } else if (entry.name.includes(".deprecated.")) {
          found.push(rel);
        }
      }
    };
    walk("src");
    walk("docs");
    expect(found.sort()).toEqual([
      "docs/compliance/anti-drift-controls.deprecated.md",
      "src/client/scheduleApi.deprecated.ts",
      "src/data/doSqlitePausedScheduleAdapter.deprecated.ts",
      "src/data/inMemoryPausedScheduleAdapter.deprecated.ts",
      "src/data/pausedSchedulePorts.deprecated.ts",
      "src/errors/errorAspects.deprecated.ts",
      "src/errors/errorCatalog.deprecated.json",
      "src/services/scheduleManagement.deprecated.ts",
      "src/workflows/screenerWorkflowFlow.deprecated.ts",
      "src/workflows/startScheduledShardedChain.deprecated.ts",
    ]);
  });

  it("the deprecation ledger carries the five #3123 entries", () => {
    const ledger = source("docs/architecture/transition/deprecations.md");
    expect(ledger).toContain("#3123");
    for (const file of [
      "src/data/pausedSchedulePorts.deprecated.ts",
      "src/data/doSqlitePausedScheduleAdapter.deprecated.ts",
      "src/data/inMemoryPausedScheduleAdapter.deprecated.ts",
      "src/services/scheduleManagement.deprecated.ts",
      "src/client/scheduleApi.deprecated.ts",
    ]) {
      expect(ledger).toContain(file);
    }
  });
});
