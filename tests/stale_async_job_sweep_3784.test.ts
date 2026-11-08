// @vitest-environment node
/**
 * Issue #3784 (parent incident #3781) — the scheduled stale-async-job
 * sweep. The read-path reap + stuck alert (#2567) fire only when a job
 * is read; a claimed-but-unfinished row whose executor stalled (the six
 * incident jobs, still `running` ~53 min after start) has no recovery
 * path until something reads it. This sweep applies the same two
 * transitions without a read: past the 30-min threshold a row is
 * flagged + alerted exactly once; past the 2h backstop it is reaped
 * as failed with the read path's exact unknown-outcome message.
 *
 * Harness mirrors tests/stuck_running_alert_2567.test.ts: real
 * node:sqlite behind the family's ports, rows seeded at controlled
 * ages, an injected notifyStuckRun spy standing in for the Slack
 * delivery the class wires in production.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  ensureAsyncJobGraphColumns,
  sweepStaleAsyncJobs,
  type AsyncJobsContext,
  type StuckRunAlertInfo,
} from "../src/agents/orchestrator/asyncJobs";
import { LIST_RUNNING_SQL } from "../src/data/asyncJobPorts";

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
const REAP_MESSAGE =
  "Execution stopped before a result was recorded; the outcome may be unknown. Verify external side effects before submitting again.";
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

interface Harness {
  db: DatabaseSync;
  ctx: AsyncJobsContext;
  alerts: StuckRunAlertInfo[];
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
}

function makeHarness(options: {
  env?: Record<string, string>;
  notify?: (info: StuckRunAlertInfo) => Promise<void>;
  withNotify?: boolean;
} = {}): Harness {
  const db = new DatabaseSync(":memory:");
  const sql = makeSql(db);
  const alerts: StuckRunAlertInfo[] = [];
  const audits: Harness["audits"] = [];
  const withNotify = options.withNotify !== false;
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
      throw new Error("no orm in stale-sweep harness");
    },
    ...(withNotify
      ? {
          notifyStuckRun: options.notify ?? (async (info: StuckRunAlertInfo) => {
            alerts.push(info);
          }),
        }
      : {}),
  } as unknown as AsyncJobsContext;
  return { db, ctx, alerts, audits };
}

function seedRow(
  db: DatabaseSync,
  row: { jobId: string; startedAt: string | null; status?: string; capability?: string; stuckAlertedAt?: string | null },
): void {
  ensureAsyncJobGraphColumns(makeSql(db) as never);
  db.prepare(
    "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at, started_at, stuck_alerted_at) VALUES (?, 'owner-login-1', ?, 'Seeded run', ?, '{}', ?, ?, ?, ?)",
  ).run(
    row.jobId,
    row.capability ?? "screen.run",
    row.status ?? "running",
    row.startedAt,
    row.startedAt,
    row.startedAt,
    row.stuckAlertedAt ?? null,
  );
}

function rowStatus(db: DatabaseSync, jobId: string): { status: string; error: string | null; stuck_alerted_at: string | null } {
  return db.prepare(
    "SELECT status, error, stuck_alerted_at FROM mas_async_jobs WHERE job_id = ?",
  ).get(jobId) as { status: string; error: string | null; stuck_alerted_at: string | null };
}

describe("stale async-job sweep (#3784)", () => {
  it("flags a run past the threshold: alert + stuck_detected audit, row stays running", async () => {
    const h = makeHarness();
    seedRow(h.db, { jobId: "job-stuck-1", startedAt: isoAgo(45 * MIN) });

    const result = sweepStaleAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, alerted: 1, reaped: 0 });
    // Delivery is fire-and-forget off the sweep path.
    await vi.waitFor(() => expect(h.alerts).toHaveLength(1));
    expect(h.alerts[0].jobId).toBe("job-stuck-1");
    expect(h.alerts[0].thresholdMs).toBe(30 * MIN);
    expect(
      h.audits.filter((a) => a.type === "async_job.stuck_detected" && a.payload.jobId === "job-stuck-1"),
    ).toHaveLength(1);
    const row = rowStatus(h.db, "job-stuck-1");
    expect(row.status).toBe("running");
    expect(row.stuck_alerted_at).not.toBeNull();
  });

  it("reaps a run past 2h as failed with the read path's exact message + async_job.failed audit, never alerted", async () => {
    const h = makeHarness();
    seedRow(h.db, { jobId: "job-ancient", startedAt: isoAgo(3 * 60 * MIN) });

    const result = sweepStaleAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, alerted: 0, reaped: 1 });
    await new Promise((r) => setTimeout(r, 25));
    expect(h.alerts).toHaveLength(0);
    const row = rowStatus(h.db, "job-ancient");
    expect(row.status).toBe("failed");
    expect(row.error).toBe(REAP_MESSAGE);
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toEqual({
      jobId: "job-ancient",
      capability: "screen.run",
      error: REAP_MESSAGE,
    });
    expect(
      h.audits.filter((a) => a.type === "async_job.stuck_detected"),
    ).toHaveLength(0);
  });

  it("leaves a young running row untouched (no false flag)", async () => {
    const h = makeHarness();
    seedRow(h.db, { jobId: "job-young", startedAt: isoAgo(5 * MIN) });

    const result = sweepStaleAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, alerted: 0, reaped: 0 });
    await new Promise((r) => setTimeout(r, 25));
    expect(h.alerts).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
    expect(rowStatus(h.db, "job-young").status).toBe("running");
  });

  it("a second sweep is a no-op for an already-flagged row (exactly-once)", async () => {
    const h = makeHarness();
    seedRow(h.db, { jobId: "job-stuck-2", startedAt: isoAgo(45 * MIN) });

    expect(sweepStaleAsyncJobs(h.ctx)).toEqual({ examined: 1, alerted: 1, reaped: 0 });
    await vi.waitFor(() => expect(h.alerts).toHaveLength(1));
    expect(sweepStaleAsyncJobs(h.ctx)).toEqual({ examined: 1, alerted: 0, reaped: 0 });
    await new Promise((r) => setTimeout(r, 25));
    expect(h.alerts).toHaveLength(1);
    expect(
      h.audits.filter((a) => a.type === "async_job.stuck_detected"),
    ).toHaveLength(1);
    expect(rowStatus(h.db, "job-stuck-2").status).toBe("running");
  });

  it("threshold disabled (0) alerts nothing, but the 2h reap still applies", async () => {
    const h = makeHarness({ env: { STUCK_RUN_ALERT_THRESHOLD_MINUTES: "0" } });
    seedRow(h.db, { jobId: "job-no-alert", startedAt: isoAgo(45 * MIN) });
    seedRow(h.db, { jobId: "job-still-reaped", startedAt: isoAgo(3 * 60 * MIN) });

    const result = sweepStaleAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 2, alerted: 0, reaped: 1 });
    await new Promise((r) => setTimeout(r, 25));
    expect(h.alerts).toHaveLength(0);
    expect(rowStatus(h.db, "job-no-alert").status).toBe("running");
    expect(rowStatus(h.db, "job-still-reaped").status).toBe("failed");
  });

  it("a row with an unparseable started_at is skipped and never fails the sweep", async () => {
    const h = makeHarness();
    seedRow(h.db, { jobId: "job-bad-clock", startedAt: "not-a-date" });
    seedRow(h.db, { jobId: "job-stuck-3", startedAt: isoAgo(45 * MIN) });

    const result = sweepStaleAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 2, alerted: 1, reaped: 0 });
    await vi.waitFor(() => expect(h.alerts).toHaveLength(1));
    expect(rowStatus(h.db, "job-bad-clock").status).toBe("running");
  });

  it("sweeps a mixed batch: young untouched, stuck flagged, ancient reaped", async () => {
    const h = makeHarness();
    seedRow(h.db, { jobId: "job-young-2", startedAt: isoAgo(5 * MIN) });
    seedRow(h.db, { jobId: "job-stuck-4", startedAt: isoAgo(45 * MIN) });
    seedRow(h.db, { jobId: "job-ancient-2", startedAt: isoAgo(3 * 60 * MIN) });

    const result = sweepStaleAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 3, alerted: 1, reaped: 1 });
    await vi.waitFor(() => expect(h.alerts).toHaveLength(1));
    expect(rowStatus(h.db, "job-young-2").status).toBe("running");
    expect(rowStatus(h.db, "job-stuck-4").status).toBe("running");
    expect(rowStatus(h.db, "job-ancient-2").status).toBe("failed");
  });
});

describe("listRunning query plan (#3784)", () => {
  function plan(db: DatabaseSync, sql: string): string {
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
      .map((row) => row.detail)
      .join(" | ");
  }

  it("seeks on an index, never scans the table", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(BASE_DDL);
    ensureAsyncJobGraphColumns(makeSql(db) as never);
    // The sweep's statement, with its bind values inlined for the plan.
    const planned = plan(
      db,
      LIST_RUNNING_SQL.replace("?", "'owner-login-1'").replace("?", "100"),
    );
    expect(planned).toContain("USING INDEX");
    expect(planned).not.toContain("SCAN mas_async_jobs");
  });

  it("returns only the session's running rows, oldest first, capped at the limit", () => {
    const db = new DatabaseSync(":memory:");
    const sql = makeSql(db);
    sql.exec(BASE_DDL);
    ensureAsyncJobGraphColumns(sql as never);
    seedRow(db, { jobId: "run-old", startedAt: isoAgo(50 * MIN) });
    seedRow(db, { jobId: "run-new", startedAt: isoAgo(10 * MIN) });
    seedRow(db, { jobId: "done-old", startedAt: isoAgo(50 * MIN), status: "completed" });
    const rows = sql.exec(LIST_RUNNING_SQL, "owner-login-1", 100) as unknown as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.job_id)).toEqual(["run-old", "run-new"]);
    const capped = sql.exec(LIST_RUNNING_SQL, "owner-login-1", 1) as unknown as Array<Record<string, unknown>>;
    expect(capped.map((r) => r.job_id)).toEqual(["run-old"]);
  });
});
