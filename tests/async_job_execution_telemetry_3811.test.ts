// @vitest-environment node
/**
 * Issue #3811 (parent incident #3781) — job execution telemetry.
 *
 * A running async job's state is unanswerable from the runs view: the
 * row carries started_at/completed_at/result_json/error, written only
 * at terminal states. A running row has no heartbeat, no last-activity,
 * no progress; if the executor dies or the execution throws before
 * writing, nothing is recorded. This slice emits per-job execution
 * telemetry into the existing #1742/#1743 platform — no parallel
 * telemetry system, no second job-state record:
 *  - heartbeat / last-activity on running rows (stamped at claim,
 *    while the job runs, and at every terminal transition);
 *  - executor-side failure capture with a CODED error (the single
 *    outcome catalog is the resolver; never a message where a code
 *    belongs);
 *  - stage terminal reasons for all jobs (not only screening stages);
 *  - run-level outcome code for tool runs, surfaced in the runs view
 *    (last activity, heartbeat age, coded error) + audit.
 *
 * Harness mirrors tests/stale_async_job_sweep_3784.test.ts: real
 * node:sqlite behind the family's ports, rows seeded at controlled
 * ages, an injected audit spy.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASYNC_JOB_HEARTBEAT_MS,
  ensureAsyncJobGraphColumns,
  executeAsyncJob,
  heartbeatAsyncJob,
  resolveJobFailureCode,
  sweepStaleAsyncJobs,
  type AsyncJobsContext,
  type StuckRunAlertInfo,
} from "../src/agents/orchestrator/asyncJobs";
import { createAsyncJobPorts } from "../src/data/createAsyncJobPorts";
import { BusinessError } from "../src/outcomes/outcomeAspects";
import {
  runFromJobs,
  type WorkflowRunJobRow,
} from "../src/services/workflowRuns";

/** SqlStorage-shaped executor over node:sqlite (rowsWritten
 *  surfaced like the DO cursor — same shim as #2358/#2567). */
function makeSql(db: DatabaseSync) {
  return {
    exec: (query: string, ...args: unknown[]) => {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
        return stmt.all(...(args as never[])) as unknown[];
      }
      const info = stmt.run(...(args as never[]));
      const out = [] as unknown[] & { rowsWritten?: number };
      out.rowsWritten = Number(info.changes);
      return out;
    },
  };
}

const BASE_DDL = `CREATE TABLE IF NOT EXISTS mas_async_jobs (
  job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, capability TEXT NOT NULL,
  display_name TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
  result_json TEXT, response_status INTEGER, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  started_at TEXT, completed_at TEXT
)`;

const MIN = 60 * 1000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const isoAt = (ms: number) => new Date(ms).toISOString();

interface Harness {
  db: DatabaseSync;
  ctx: AsyncJobsContext;
  alerts: StuckRunAlertInfo[];
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
  routeRequest: ReturnType<typeof vi.fn>;
}

function makeHarness(options: { env?: Record<string, string> } = {}): Harness {
  const db = new DatabaseSync(":memory:");
  const sql = makeSql(db);
  const alerts: StuckRunAlertInfo[] = [];
  const audits: Harness["audits"] = [];
  const routeRequest = vi.fn(async () => new Response("ok", { status: 200 }));
  const ctx = {
    env: options.env ?? {},
    agentCtx: { storage: { sql } },
    ensureTables: () => {
      sql.exec(BASE_DDL);
      ensureAsyncJobGraphColumns(sql as never);
      return sql;
    },
    sessionKey: () => "owner-login-1",
    schedule: async () => ({}),
    audit: (type: string, _agent: unknown, payload: Record<string, unknown>) => {
      audits.push({ type, payload });
    },
    getOrm: () => {
      throw new Error("no orm in telemetry harness");
    },
    routeRequest,
    notifyStuckRun: async (info: StuckRunAlertInfo) => {
      alerts.push(info);
    },
  } as unknown as AsyncJobsContext;
  return { db, ctx, alerts, audits, routeRequest };
}

function seedRow(
  db: DatabaseSync,
  row: {
    jobId: string;
    status?: string;
    capability?: string;
    startedAt?: string | null;
    lastActivityAt?: string | null;
    errorCode?: string | null;
    stuckAlertedAt?: string | null;
  },
): void {
  ensureAsyncJobGraphColumns(makeSql(db) as never);
  db.prepare(
    "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at, started_at, completed_at, stuck_alerted_at, last_activity_at, error_code) VALUES (?, 'owner-login-1', ?, 'Seeded run', ?, '{}', ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.jobId,
    row.capability ?? "mcp.tool",
    row.status ?? "running",
    row.startedAt ?? isoAgo(19 * MIN),
    row.startedAt ?? isoAgo(19 * MIN),
    row.startedAt ?? null,
    null,
    row.stuckAlertedAt ?? null,
    row.lastActivityAt ?? null,
    row.errorCode ?? null,
  );
}

function readRow(
  db: DatabaseSync,
  jobId: string,
): Record<string, unknown> {
  return db
    .prepare("SELECT * FROM mas_async_jobs WHERE job_id = ?")
    .get(jobId) as Record<string, unknown>;
}

function insertQueued(
  h: Harness,
  jobId: string,
  capability = "http.request",
  payload: Record<string, unknown> = { method: "GET", pathAndQuery: "/api/ping" },
): void {
  const sql = makeSql(h.db);
  h.ctx.ensureTables();
  createAsyncJobPorts(sql as never).queue.insertQueued({
    jobId,
    sessionId: "owner-login-1",
    capability,
    displayName: `Seeded ${capability}`,
    payloadJson: JSON.stringify(payload),
    nowIso: new Date().toISOString(),
  });
}

describe("heartbeat / last-activity storage (#3811)", () => {
  it("claim stamps last_activity_at at the claim instant", () => {
    const h = makeHarness();
    insertQueued(h, "job-claim");
    const sql = makeSql(h.db);
    const claimed = createAsyncJobPorts(sql as never).queue.claim(
      "job-claim",
      "owner-login-1",
      isoAt(Date.now()),
    );
    expect(claimed).toBe(true);
    const row = readRow(h.db, "job-claim");
    expect(row.status).toBe("running");
    expect(row.started_at).toBe(row.last_activity_at);
    expect(typeof row.last_activity_at).toBe("string");
  });

  it("heartbeat advances last_activity_at on a running row only", () => {
    const h = makeHarness();
    const sql = makeSql(h.db);
    const ports = createAsyncJobPorts(sql as never);
    insertQueued(h, "job-beat");
    // Queued: no heartbeat is written.
    expect(ports.queue.heartbeat("job-beat", isoAt(Date.now()))).toBe(0);
    ports.queue.claim("job-beat", "owner-login-1", isoAgo(10 * MIN));
    const before = readRow(h.db, "job-beat").last_activity_at as string;
    expect(ports.queue.heartbeat("job-beat", isoAt(Date.now()))).toBe(1);
    const after = readRow(h.db, "job-beat").last_activity_at as string;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    // Terminal: the heartbeat no longer writes.
    ports.queue.complete("job-beat", "{}", null, isoAt(Date.now()));
    expect(ports.queue.heartbeat("job-beat", isoAt(Date.now()))).toBe(0);
    // The terminal transition stamps last_activity_at with its own
    // completed_at — at or after the last heartbeat, never before it.
    expect(Date.parse(readRow(h.db, "job-beat").last_activity_at as string)).toBeGreaterThanOrEqual(
      Date.parse(after),
    );
  });

  it("terminal transitions stamp last_activity_at and the failure code", () => {
    const h = makeHarness();
    const sql = makeSql(h.db);
    const ports = createAsyncJobPorts(sql as never);
    insertQueued(h, "job-fail");
    ports.queue.claim("job-fail", "owner-login-1", isoAgo(5 * MIN));
    ports.queue.failRunning(
      "job-fail",
      "[FAILURE_QUOTE_RATE_LIMITED] Quote rate limited",
      isoAt(Date.now()),
      "FAILURE_QUOTE_RATE_LIMITED",
    );
    const failed = readRow(h.db, "job-fail");
    expect(failed.status).toBe("failed");
    expect(failed.error_code).toBe("FAILURE_QUOTE_RATE_LIMITED");
    expect(failed.last_activity_at).toBe(failed.completed_at);

    insertQueued(h, "job-done");
    ports.queue.claim("job-done", "owner-login-1", isoAgo(5 * MIN));
    ports.queue.complete("job-done", "{}", null, isoAt(Date.now()));
    const done = readRow(h.db, "job-done");
    expect(done.status).toBe("completed");
    expect(done.last_activity_at).toBe(done.completed_at);
    expect(done.error_code).toBeNull();
  });

  it("legacy rows upgrade in place: the probed columns read NULL", () => {
    const h = makeHarness();
    const sql = makeSql(h.db);
    // A table created before this slice has neither column.
    sql.exec(BASE_DDL);
    h.db
      .prepare(
        "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at, started_at) VALUES ('job-legacy', 'owner-login-1', 'mcp.tool', 'Legacy', 'running', '{}', ?, ?, ?)",
      )
      .run(isoAgo(30 * MIN), isoAgo(30 * MIN), isoAgo(30 * MIN));
    ensureAsyncJobGraphColumns(sql as never);
    const row = readRow(h.db, "job-legacy");
    expect(row.last_activity_at).toBeNull();
    expect(row.error_code).toBeNull();
    // ...and the heartbeat writes on it afterwards.
    const now = isoAt(Date.now());
    expect(createAsyncJobPorts(sql as never).queue.heartbeat("job-legacy", now)).toBe(1);
    expect(readRow(h.db, "job-legacy").last_activity_at).toBe(now);
  });

  it("heartbeatAsyncJob is best-effort: it never throws the caller", () => {
    const h = makeHarness();
    insertQueued(h, "job-best");
    // A heartbeat on a queued row writes nothing but returns false.
    expect(heartbeatAsyncJob(h.ctx, "job-best")).toBe(false);
    const sql = makeSql(h.db);
    createAsyncJobPorts(sql as never).queue.claim("job-best", "owner-login-1", isoAgo(MIN));
    expect(heartbeatAsyncJob(h.ctx, "job-best")).toBe(true);
    expect(typeof readRow(h.db, "job-best").last_activity_at).toBe("string");
  });
});

describe("failure-code derivation (#3811)", () => {
  it("a BusinessError keeps its own catalog code", () => {
    expect(resolveJobFailureCode(new BusinessError("FAILURE_QUOTE_RATE_LIMITED"))).toBe(
      "FAILURE_QUOTE_RATE_LIMITED",
    );
  });

  it("a coded message keeps its leading catalog code", () => {
    expect(
      resolveJobFailureCode(
        new Error("[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED] Delivery recipient is not allowed — recipient x"),
      ),
    ).toBe("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED");
  });

  it("an uncoded throw falls back to the generic job code, never invented", () => {
    expect(resolveJobFailureCode(new Error("boom"))).toBe("FAILURE_ASYNC_JOB_FAILED");
    expect(resolveJobFailureCode("plain string failure")).toBe("FAILURE_ASYNC_JOB_FAILED");
    expect(resolveJobFailureCode(undefined)).toBe("FAILURE_ASYNC_JOB_FAILED");
  });

  it("an unknown bracket code falls back to the generic job code", () => {
    expect(resolveJobFailureCode(new Error("[NOPE_001] something"))).toBe(
      "FAILURE_ASYNC_JOB_FAILED",
    );
  });
});

describe("executor-side failure capture (#3811)", () => {
  it("a throwing leg fails the job with the coded error + audit code", async () => {
    const h = makeHarness();
    h.routeRequest.mockRejectedValueOnce(
      new Error("[FAILURE_QUOTE_RATE_LIMITED] Quote rate limited — retry later"),
    );
    insertQueued(h, "job-throw");
    await executeAsyncJob(h.ctx, { jobId: "job-throw" });
    const row = readRow(h.db, "job-throw");
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("FAILURE_QUOTE_RATE_LIMITED");
    expect(typeof row.completed_at).toBe("string");
    const failed = h.audits.find((a) => a.type === "async_job.failed");
    expect(failed).toBeDefined();
    expect(failed?.payload.errorCode).toBe("FAILURE_QUOTE_RATE_LIMITED");
    expect(failed?.payload.jobId).toBe("job-throw");
    // The started audit still fired first: queued → started → failed.
    const started = h.audits.find((a) => a.type === "async_job.started");
    expect(started?.payload.jobId).toBe("job-throw");
  });

  it("an uncoded throw fails the job with the generic code", async () => {
    const h = makeHarness();
    h.routeRequest.mockRejectedValueOnce(new Error("boom"));
    insertQueued(h, "job-boom");
    await executeAsyncJob(h.ctx, { jobId: "job-boom" });
    const row = readRow(h.db, "job-boom");
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("FAILURE_ASYNC_JOB_FAILED");
  });

  it("the heartbeat ticks while a long leg runs", async () => {
    vi.useFakeTimers();
    try {
      const startMs = Date.now();
      vi.setSystemTime(startMs);
      const h = makeHarness();
      // A slow leg: resolves after 5 minutes of fake time.
      h.routeRequest.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response("ok", { status: 200 })), 5 * MIN);
          }),
      );
      insertQueued(h, "job-slow");
      const run = executeAsyncJob(h.ctx, { jobId: "job-slow" });
      // Claim happens synchronously up to the first await; advance
      // past two heartbeat ticks (2 min each) but not the leg end.
      await vi.advanceTimersByTimeAsync(2 * MIN + 1000);
      const mid = readRow(h.db, "job-slow");
      expect(mid.status).toBe("running");
      expect(Date.parse(mid.last_activity_at as string)).toBeGreaterThanOrEqual(
        startMs + 2 * MIN,
      );
      await vi.advanceTimersByTimeAsync(3 * MIN);
      await run;
      const done = readRow(h.db, "job-slow");
      expect(done.status).toBe("completed");
      expect(done.last_activity_at).toBe(done.completed_at);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sweep carries last-activity evidence (#3811)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T21:33:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a stuck alert carries lastActivityAt + heartbeatAgeMs", async () => {
    const h = makeHarness();
    // Running 40 min; last activity 39 min ago (heartbeat 1 min after start).
    // The seeded instant is captured once: the sweep measures the age
    // at sweep time, a few ms past it, so exact-ms equality with a
    // fresh Date.now() at assertion time would flake.
    const lastActivity = isoAgo(39 * MIN);
    seedRow(h.db, {
      jobId: "job-stuck",
      startedAt: isoAgo(40 * MIN),
      lastActivityAt: lastActivity,
    });
    const result = sweepStaleAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, alerted: 1, reaped: 0 });
    // The notify hook is dispatched on a microtask (it must never
    // surface on the read path), so flush before reading the spy.
    await Promise.resolve();
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.lastActivityAt).toBe(lastActivity);
    expect(h.alerts[0]?.heartbeatAgeMs).toBeGreaterThanOrEqual(39 * MIN);
    expect(h.alerts[0]?.heartbeatAgeMs).toBeLessThan(39 * MIN + 60_000);
    const detected = h.audits.find((a) => a.type === "async_job.stuck_detected");
    expect(detected?.payload.lastActivityAt).toBe(lastActivity);
    expect(detected?.payload.heartbeatAgeMs).toBeGreaterThanOrEqual(39 * MIN);
    expect(detected?.payload.heartbeatAgeMs).toBeLessThan(39 * MIN + 60_000);
  });

  it("a reaped row carries the generic failure code", () => {
    const h = makeHarness();
    const lastActivity = isoAgo(3 * 60 * MIN);
    seedRow(h.db, {
      jobId: "job-reap",
      startedAt: isoAgo(3 * 60 * MIN),
      lastActivityAt: lastActivity,
    });
    const result = sweepStaleAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, alerted: 0, reaped: 1 });
    const row = readRow(h.db, "job-reap");
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("FAILURE_ASYNC_JOB_FAILED");
    const failed = h.audits.find((a) => a.type === "async_job.failed");
    expect(failed?.payload.errorCode).toBe("FAILURE_ASYNC_JOB_FAILED");
    expect(failed?.payload.lastActivityAt).toBe(lastActivity);
  });
});

describe("runs-view projection (#3811)", () => {
  const NOW = Date.parse("2026-11-08T21:33:00Z");
  // The projection is fed the fixed NOW as its clock, so every row
  // timestamp is relative to NOW — real-now stamps would make the
  // heartbeat age a ~5h negative number instead of the intended age.
  const isoBeforeNow = (ms: number) => new Date(NOW - ms).toISOString();
  function runJob(overrides: Partial<WorkflowRunJobRow> & { job_id: string }): WorkflowRunJobRow {
    return {
      capability: "mcp.tool",
      display_name: "MCP: get_feed_job_status",
      status: "running",
      created_at: isoBeforeNow(19 * MIN),
      started_at: isoBeforeNow(19 * MIN),
      ...overrides,
    };
  }

  it("a running job shows last activity and heartbeat age", () => {
    const run = runFromJobs(
      [
        runJob({
          job_id: "job-live",
          last_activity_at: isoBeforeNow(1 * MIN),
        }),
      ],
      [],
      undefined,
      NOW,
    );
    expect(run.status).toBe("running");
    expect(run.lastActivityAt).toBe(isoBeforeNow(1 * MIN));
    expect(run.heartbeatAgeMs).toBe(1 * MIN);
  });

  it("a legacy running row falls back to started_at, never invented", () => {
    const run = runFromJobs(
      [runJob({ job_id: "job-legacy" })],
      [],
      undefined,
      NOW,
    );
    expect(run.lastActivityAt).toBe(isoBeforeNow(19 * MIN));
    expect(run.heartbeatAgeMs).toBe(19 * MIN);
  });

  it("a failed tool run carries its coded error and stage reason", () => {
    const lastActivity = isoBeforeNow(2 * MIN);
    const run = runFromJobs(
      [
        runJob({
          job_id: "job-failed",
          status: "failed",
          completed_at: lastActivity,
          last_activity_at: lastActivity,
          error: "[FAILURE_QUOTE_RATE_LIMITED] Quote rate limited — retry later",
          error_code: "FAILURE_QUOTE_RATE_LIMITED",
        }),
      ],
      [],
      undefined,
      NOW,
    );
    expect(run.status).toBe("failed");
    expect(run.error).toContain("[FAILURE_QUOTE_RATE_LIMITED]");
    expect(run.stages[0]?.error).toContain("[FAILURE_QUOTE_RATE_LIMITED]");
    expect(run.stages[0]?.reason).toContain("[FAILURE_QUOTE_RATE_LIMITED]");
    // A terminal run has no heartbeat age.
    expect(run.heartbeatAgeMs).toBeNull();
    expect(run.lastActivityAt).toBe(lastActivity);
  });

  it("an uncoded failure keeps the raw message and the generic code", () => {
    const run = runFromJobs(
      [
        runJob({
          job_id: "job-boom",
          status: "failed",
          completed_at: isoBeforeNow(2 * MIN),
          last_activity_at: isoBeforeNow(2 * MIN),
          error: "boom",
          error_code: "FAILURE_ASYNC_JOB_FAILED",
        }),
      ],
      [],
      undefined,
      NOW,
    );
    expect(run.error).toContain("[FAILURE_ASYNC_JOB_FAILED]");
    expect(run.error).toContain("boom");
  });
});

describe("heartbeat interval (#3811)", () => {
  it("ticks every two minutes, matching the #624 research-task precedent", () => {
    expect(ASYNC_JOB_HEARTBEAT_MS).toBe(120_000);
  });
});
