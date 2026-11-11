/**
 * Issue #3021 — Workflow Runs lifecycle states + schedule types.
 *
 * The page surfaces exactly one lifecycle state per run (scheduled /
 * in-progress / done / cancelled) and per-run schedule provenance
 * (mechanism + identity + reason), with a schedule-type filter. The
 * mapping is total: every recorded status — including Cloudflare
 * workflow instance statuses and the unknown fallback — lands in
 * exactly one state, never unclassified. Schedule facts are never
 * invented: a mechanism, identity, or reason the stores do not
 * record renders as null, never a guess.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  BINDING_SCHEDULES,
  bindingScheduleRows,
  lifecycleStateForRunStatus,
  lifecycleStateForRun,
  resolveScheduleBranch,
  runFromScheduleRecord,
  scheduleProvenanceForJobs,
  type ScheduleRecord,
  type WorkflowLifecycleState,
} from "../src/services/workflowLifecycle";
import {
  filterWorkflowRuns,
  runFromJobs,
  type WorkflowRun,
  type WorkflowRunJobRow,
} from "../src/services/workflowRuns";

function job(overrides: Partial<WorkflowRunJobRow> = {}): WorkflowRunJobRow {
  return {
    job_id: "job-1",
    capability: "screener.run",
    display_name: "Screen",
    status: "queued",
    created_at: "2026-11-04T10:00:00.000Z",
    ...overrides,
  };
}

function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

describe("lifecycle mapping (#3021)", () => {
  it("maps every recorded run status onto exactly one lifecycle state", () => {
    const expected: Record<string, WorkflowLifecycleState> = {
      queued: "in-progress",
      running: "in-progress",
      awaiting: "in-progress",
      unknown: "in-progress",
      completed: "done",
      partial: "done",
      failed: "done",
      skipped: "done",
      cancelled: "cancelled",
    };
    for (const [status, lifecycle] of Object.entries(expected)) {
      expect(lifecycleStateForRunStatus(status)).toBe(lifecycle);
    }
  });

  it("maps Cloudflare workflow instance statuses onto the same four states", () => {
    expect(lifecycleStateForRunStatus("paused")).toBe("in-progress");
    expect(lifecycleStateForRunStatus("waiting")).toBe("in-progress");
    expect(lifecycleStateForRunStatus("waitingForPause")).toBe("in-progress");
    expect(lifecycleStateForRunStatus("complete")).toBe("done");
    expect(lifecycleStateForRunStatus("errored")).toBe("done");
    expect(lifecycleStateForRunStatus("terminated")).toBe("cancelled");
  });

  it("maps transition-only held status onto in-progress, never unclassified", () => {
    expect(lifecycleStateForRunStatus("held")).toBe("in-progress");
  });

  it("maps garbage and empty status onto in-progress (the visible default, never dropped)", () => {
    expect(lifecycleStateForRunStatus("bogus")).toBe("in-progress");
    expect(lifecycleStateForRunStatus("")).toBe("in-progress");
  });

  it("a run whose stages are all cancelled is cancelled even when its status verb is unknown", () => {
    const run = {
      status: "unknown",
      stages: [
        { status: "cancelled" },
        { status: "cancelled" },
      ],
    } as unknown as WorkflowRun;
    expect(lifecycleStateForRun(run)).toBe("cancelled");
  });

  it("a run with a failed stage but a completed verb is done (failure is an outcome within done)", () => {
    const run = { status: "completed", stages: [{ status: "failed" }] } as unknown as WorkflowRun;
    expect(lifecycleStateForRun(run)).toBe("done");
  });
});

describe("schedule provenance from job rows (#3021)", () => {
  const NOW = Date.parse("2026-11-04T12:00:00.000Z");

  it("a queued job with a future not_before is scheduled queue work with its delay", () => {
    const provenance = scheduleProvenanceForJobs(
      [job({ status: "queued", not_before: "2026-11-04T12:30:00.000Z" })],
      "unknown",
      NOW,
    );
    expect(provenance?.mechanism).toBe("queue");
    // The delay is the queue delay the producer set (not_before minus
    // created_at), not the remaining time — a stable schedule fact.
    expect(provenance?.delaySeconds).toBe(9000);
    expect(provenance?.identity).toBe("delay 9000s");
    expect(provenance?.nextFiringAt).toBe("2026-11-04T12:30:00.000Z");
    expect(lifecycleStateForRunStatus("queued")).toBe("in-progress");
    // The delayed job itself is scheduled, not in-progress: the run
    // builder applies the not_before rule (pinned via runFromJobs).
    const run = runFromJobs(
      [job({ status: "queued", not_before: "2026-11-04T12:30:00.000Z" })],
      [],
      undefined,
      NOW,
    );
    expect(run.lifecycle).toBe("scheduled");
    expect(run.schedule?.mechanism).toBe("queue");
  });

  it("a queued job whose not_before has passed is in-progress, not scheduled", () => {
    const run = runFromJobs(
      [job({ status: "queued", not_before: "2026-11-04T11:00:00.000Z" })],
      [],
      undefined,
      NOW,
    );
    expect(run.lifecycle).toBe("in-progress");
  });

  it("a job carrying a schedule id is agent-scheduler work with that identity", () => {
    const provenance = scheduleProvenanceForJobs(
      [job({ payload_json: JSON.stringify({ trigger: "scheduled", scheduleId: "sched_abc", scheduleReason: "nightly screen" }) })],
      "scheduled",
      NOW,
    );
    expect(provenance?.mechanism).toBe("agent-scheduler");
    expect(provenance?.identity).toBe("sched_abc");
    expect(provenance?.reason).toBe("nightly screen");
  });

  it("a job carrying only a cron expression is agent-scheduler work with the cron as identity", () => {
    const provenance = scheduleProvenanceForJobs(
      [job({ payload_json: JSON.stringify({ trigger: "scheduled", cron: "0 4 * * *" }) })],
      "scheduled",
      NOW,
    );
    expect(provenance?.mechanism).toBe("agent-scheduler");
    expect(provenance?.identity).toBe("0 4 * * *");
    expect(provenance?.reason).toBeNull();
  });

  it("a scheduled run with no schedule id is cron-trigger work with no invented identity", () => {
    const provenance = scheduleProvenanceForJobs([job({})], "scheduled", NOW);
    expect(provenance?.mechanism).toBe("cron-trigger");
    expect(provenance?.identity).toBeNull();
    expect(provenance?.reason).toBeNull();
  });

  it("a manual run is manual work; an untriggered run is unknown, never guessed", () => {
    expect(scheduleProvenanceForJobs([job({})], "manual", NOW)?.mechanism).toBe("manual");
    expect(scheduleProvenanceForJobs([job({})], "unknown", NOW)?.mechanism).toBe("unknown");
  });

  it("a workflow-binding schedule identity on the command rides through as workflow-binding", () => {
    const provenance = scheduleProvenanceForJobs(
      [job({ payload_json: JSON.stringify({ scheduleMechanism: "workflow-binding", scheduleIdentity: "*/30 * * * *", scheduleReason: "tick migration" }) })],
      "scheduled",
      NOW,
    );
    expect(provenance?.mechanism).toBe("workflow-binding");
    expect(provenance?.identity).toBe("*/30 * * * *");
    expect(provenance?.reason).toBe("tick migration");
  });
});

describe("agent-scheduler schedule records as runs (#3021 deliverable b)", () => {
  it("a cron schedule record becomes a scheduled run with its cron and next firing", () => {
    const record: ScheduleRecord = {
      id: "sched_1",
      callback: "autonomousMarketScreen",
      payload: { universe: "NASDAQ100" },
      type: "cron",
      cron: "0 4 * * *",
      time: 1792000000,
    };
    const run = runFromScheduleRecord(record, "user-1");
    expect(run.source).toBe("schedule");
    expect(run.status).toBe("queued");
    expect(run.lifecycle).toBe("scheduled");
    expect(run.schedule?.mechanism).toBe("agent-scheduler");
    expect(run.schedule?.identity).toBe("0 4 * * *");
    expect(run.schedule?.nextFiringAt).toBe(new Date(1792000000 * 1000).toISOString());
    expect(run.title).toContain("market screen");
  });

  it("a delayed schedule record carries its delay as identity", () => {
    const run = runFromScheduleRecord(
      { id: "sched_2", callback: "sendScheduledReminder", payload: {}, type: "delayed", time: 1792000000, delayInSeconds: 3600 },
      "user-1",
    );
    expect(run.schedule?.identity).toBe("delay 3600s");
    expect(run.lifecycle).toBe("scheduled");
  });

  it("an interval schedule record carries its interval as identity", () => {
    const run = runFromScheduleRecord(
      { id: "sched_3", callback: "collectIvHistory", payload: {}, type: "interval", time: 1792000000, intervalSeconds: 1800 },
      "user-1",
    );
    expect(run.schedule?.identity).toBe("every 1800s");
  });

  it("an unknown callback renders under its own name, never a fabricated label", () => {
    const run = runFromScheduleRecord(
      { id: "sched_4", callback: "someFutureCallback", payload: {}, type: "scheduled", time: 1792000000 },
      "user-1",
    );
    expect(run.title).toContain("someFutureCallback");
  });

  it("a payload reason rides through; an absent reason stays null", () => {
    const withReason = runFromScheduleRecord(
      { id: "sched_5", callback: "autonomousGoalScreen", payload: { reason: "weekly rebalance" }, type: "cron", cron: "0 9 * * 1", time: 1792000000 },
      "user-1",
    );
    expect(withReason.schedule?.reason).toBe("weekly rebalance");
    const withoutReason = runFromScheduleRecord(
      { id: "sched_6", callback: "autonomousGoalScreen", payload: {}, type: "cron", cron: "0 9 * * 1", time: 1792000000 },
      "user-1",
    );
    expect(withoutReason.schedule?.reason).toBeNull();
  });
});

describe("workflow binding schedules (#3021 deliverable a)", () => {
  it("the registry names the screener workflow binding schedule with a reason", () => {
    const entry = BINDING_SCHEDULES.find((b) => b.binding === "SCREENER_WORKFLOW");
    expect(entry).toBeDefined();
    expect(entry!.cron).toBe("*/30 * * * *");
    expect(entry!.reason.length).toBeGreaterThan(0);
  });

  it("declares no workflow schedule in wrangler.jsonc (#4112 owner direction)", () => {
    const wrangler = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as {
      workflows?: Array<{ binding?: string; schedules?: string[] }>;
    };
    const declared = (wrangler.workflows ?? []).flatMap((w) => w.schedules ?? []);
    // The binding stays so an on-demand run still resolves; only the
    // schedule is gone, so nothing fires on a timer.
    expect(declared).toEqual([]);
    // The registry keeps the capability: re-enabling is a wrangler edit.
    expect(BINDING_SCHEDULES.length).toBeGreaterThan(0);
  });

  it("binding schedule rows surface as scheduled runs with workflow-binding provenance", () => {
    const rows = bindingScheduleRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toBe("schedule");
      expect(row.lifecycle).toBe("scheduled");
      expect(row.schedule?.mechanism).toBe("workflow-binding");
      expect(row.schedule?.identity).toBeTruthy();
      expect(row.schedule?.reason).toBeTruthy();
    }
  });

  it("a binding-schedule firing resolves to the schedule branch, never the command path", () => {
    const resolved = resolveScheduleBranch({ schedule: { cron: "*/30 * * * *", scheduledTime: 1792000000 } });
    expect(resolved.handled).toBe(true);
    expect(resolved.cron).toBe("*/30 * * * *");
  });

  it("a normal command event does not resolve to the schedule branch", () => {
    expect(resolveScheduleBranch({ payload: { jobId: "job-1" } }).handled).toBe(false);
    expect(resolveScheduleBranch({}).handled).toBe(false);
  });
});

describe("lifecycle + schedule filtering (#3021)", () => {
  function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
    return {
      id: "run-1",
      runId: "run-1",
      workflow: "Stock screening workflow",
      family: "stock",
      title: "Screen",
      source: "job-chain",
      trigger: "manual",
      triggerDetail: "Manual",
      triggeredBy: null,
      status: "completed",
      startedAt: "2026-11-04T10:00:00.000Z",
      finishedAt: "2026-11-04T10:05:00.000Z",
      durationMs: 300000,
      stageCount: 1,
      completedStages: 1,
      failedStages: 0,
      stages: [],
      inputs: null,
      outputs: null,
      artifacts: [],
      deliveryStates: {},
      error: null,
      fanoutCapReason: null,
      resumedSkippedUnits: [],
      ...overrides,
    };
  }

  it("lifecycle filter selects by the rolled-up state, not the raw status", () => {
    const rows = [
      run({ id: "a", status: "failed", lifecycle: "done" }),
      run({ id: "b", status: "running", lifecycle: "in-progress" }),
      run({ id: "c", status: "queued", lifecycle: "scheduled", schedule: { mechanism: "queue", identity: "delay 60s", reason: null, nextFiringAt: null, delaySeconds: 60 } }),
    ];
    expect(filterWorkflowRuns(rows, { lifecycle: "done" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterWorkflowRuns(rows, { lifecycle: "scheduled" }).map((r) => r.id)).toEqual(["c"]);
    expect(filterWorkflowRuns(rows, { lifecycle: "all" }).length).toBe(3);
  });

  it("schedule filter selects by mechanism", () => {
    const rows = [
      run({ id: "a", schedule: { mechanism: "agent-scheduler", identity: "sched_1", reason: null, nextFiringAt: null, delaySeconds: null } }),
      run({ id: "b", schedule: { mechanism: "cron-trigger", identity: null, reason: null, nextFiringAt: null, delaySeconds: null } }),
      run({ id: "c", schedule: null }),
    ];
    expect(filterWorkflowRuns(rows, { schedule: "agent-scheduler" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterWorkflowRuns(rows, { schedule: "all" }).length).toBe(3);
  });

  it("lifecycle and schedule filters compose", () => {
    const rows = [
      run({ id: "a", lifecycle: "scheduled", schedule: { mechanism: "agent-scheduler", identity: "sched_1", reason: null, nextFiringAt: null, delaySeconds: null } }),
      run({ id: "b", lifecycle: "scheduled", schedule: { mechanism: "queue", identity: "delay 60s", reason: null, nextFiringAt: null, delaySeconds: 60 } }),
    ];
    expect(filterWorkflowRuns(rows, { lifecycle: "scheduled", schedule: "agent-scheduler" }).map((r) => r.id)).toEqual(["a"]);
  });
});
