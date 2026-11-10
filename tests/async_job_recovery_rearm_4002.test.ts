// @vitest-environment node
/**
 * Issue #4002 — Yahoo feed-runs failing with FAILURE_ASYNC_JOB_FAILED.
 *
 * Incident (2026-11-10): two POST /data-providers/yahoo/feed-run
 * runs started 7:42 and 7:51 AM and both ended at exactly 08:05:39
 * AM with [FAILURE_ASYNC_JOB_FAILED] + the generic unknown-outcome
 * text. The shared end time is one event: the #3980 production
 * deploy restarted the Orchestrator DO at 13:05:39 UTC, and
 * onStart recovery (#3907) reaped both rows — stale heartbeat,
 * any age — as failed with the generic code, because a feed run
 * is one long batch await with nothing persisted until the end.
 *
 * This file pins the fix in recoverStaleRunningAsyncJobs:
 * - a stale-heartbeat row whose work is a resumable pipeline
 *   feed-job dispatch (the HTTP feed-run route, or the MCP
 *   run_feed_job tool) is RE-ARMED, not reaped-and-lost: the
 *   original row is failed with the new cataloged
 *   FAILURE_ASYNC_JOB_ORPHANED code naming the restart, and a
 *   new queued row carries the same payload (retryOf +
 *   recoveryRearmOf link it to the original);
 * - a paid row is NEVER re-armed (its x402 signature was
 *   consumed — the #3907 rule), a non-feed row is never
 *   re-armed, and a row already re-armed twice is not re-armed
 *   a third time (cap 2);
 * - every row this recovery reaps — re-armed or not — carries
 *   FAILURE_ASYNC_JOB_ORPHANED, not the generic
 *   FAILURE_ASYNC_JOB_FAILED: the cause is named (the executor
 *   died with its host), with lastActivityAt as evidence;
 * - a fresh-heartbeat row is untouched, as before.
 *
 * Harness mirrors tests/async_job_heartbeat_reap_deadline_3907.test.ts:
 * real node:sqlite behind the family's ports, rows seeded at
 * controlled ages.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  ensureAsyncJobGraphColumns,
  recoverStaleRunningAsyncJobs,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";

/** SqlStorage-shaped executor over node:sqlite (rowsWritten surfaced like the DO cursor — same shim as #2358/#2567). */
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
const HOUR = 60 * MIN;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

interface Harness {
  db: DatabaseSync;
  ctx: AsyncJobsContext;
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
}

function makeHarness(): Harness {
  const db = new DatabaseSync(":memory:");
  const sql = makeSql(db);
  const audits: Harness["audits"] = [];
  const ctx = {
    env: {},
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
      throw new Error("no orm in 4002 harness");
    },
  } as unknown as AsyncJobsContext;
  return { db, ctx, audits };
}

function seedRow(
  db: DatabaseSync,
  row: {
    jobId: string;
    startedAt: string | null;
    lastActivityAt?: string | null;
    status?: string;
    capability?: string;
    payloadJson?: string;
  },
): void {
  ensureAsyncJobGraphColumns(makeSql(db) as never);
  db.prepare(
    "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at, started_at, last_activity_at) VALUES (?, 'owner-login-1', ?, 'Seeded run', ?, ?, ?, ?, ?, ?)",
  ).run(
    row.jobId,
    row.capability ?? "screen.run",
    row.status ?? "running",
    row.payloadJson ?? "{}",
    row.startedAt,
    row.startedAt,
    row.startedAt,
    row.lastActivityAt ?? null,
  );
}

function rowStatus(db: DatabaseSync, jobId: string): { status: string; error: string | null } {
  return db.prepare(
    "SELECT status, error FROM mas_async_jobs WHERE job_id = ?",
  ).get(jobId) as { status: string; error: string | null };
}

function allRows(db: DatabaseSync): Array<{
  job_id: string;
  status: string;
  payload_json: string;
  error: string | null;
}> {
  return db.prepare(
    "SELECT job_id, status, payload_json, error FROM mas_async_jobs",
  ).all() as Array<{ job_id: string; status: string; payload_json: string; error: string | null }>;
}

const feedRunPayload = () =>
  JSON.stringify({
    method: "POST",
    pathAndQuery: "/data-providers/yahoo/feed-run",
    headers: {},
    body: "{}",
  });

const runFeedJobPayload = (extraArgs: Record<string, unknown> = {}) =>
  JSON.stringify({ toolName: "run_feed_job", arguments: { source: "yahoo", ...extraArgs } });

describe("onStart recovery re-arms resumable feed dispatches (#4002)", () => {
  it("a stale HTTP feed-run row is re-armed: original failed as orphaned, new queued row carries the same dispatch", async () => {
    const h = makeHarness();
    const lastActivityAt = isoAgo(30 * MIN);
    seedRow(h.db, {
      jobId: "job-feed-run",
      startedAt: isoAgo(23 * MIN),
      lastActivityAt,
      capability: "http.request",
      payloadJson: feedRunPayload(),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });

    const original = rowStatus(h.db, "job-feed-run");
    expect(original.status).toBe("failed");
    expect(original.error).toContain("Orphaned by a host restart");
    expect(original.error).toContain(lastActivityAt);

    const rows = allRows(h.db);
    const rearmed = rows.filter((r) => r.job_id !== "job-feed-run");
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0].status).toBe("queued");
    const payload = JSON.parse(rearmed[0].payload_json) as Record<string, unknown>;
    expect(payload.method).toBe("POST");
    expect(payload.pathAndQuery).toBe("/data-providers/yahoo/feed-run");
    expect(payload.retryOf).toBe("job-feed-run");
    expect(payload.recoveryRearmOf).toBe("job-feed-run");
    expect(payload.recoveryRearmCount).toBe(1);

    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.errorCode).toBe("FAILURE_ASYNC_JOB_ORPHANED");
    expect(failed[0].payload.lastActivityAt).toBe(lastActivityAt);
    const retried = h.audits.filter((a) => a.type === "async_job.retried");
    expect(retried).toHaveLength(1);
    expect(retried[0].payload.jobId).toBe("job-feed-run");
    expect(retried[0].payload.retryJobId).toBe(rearmed[0].job_id);
    expect(retried[0].payload.recoveredBy).toBe("stale_running_recovery");
  });

  it("a stale MCP run_feed_job row is re-armed the same way (the copilot-dispatched shape)", async () => {
    const h = makeHarness();
    seedRow(h.db, {
      jobId: "job-mcp-feed",
      startedAt: isoAgo(20 * MIN),
      lastActivityAt: isoAgo(30 * MIN),
      capability: "mcp.tool",
      payloadJson: runFeedJobPayload(),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });

    const rows = allRows(h.db);
    const rearmed = rows.filter((r) => r.job_id !== "job-mcp-feed");
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0].status).toBe("queued");
    const payload = JSON.parse(rearmed[0].payload_json) as Record<string, unknown>;
    expect(payload.toolName).toBe("run_feed_job");
    expect(payload.retryOf).toBe("job-mcp-feed");
    expect(payload.recoveryRearmOf).toBe("job-mcp-feed");
  });

  it("a paid feed row is never re-armed (its x402 signature was consumed — the #3907 rule)", async () => {
    const h = makeHarness();
    seedRow(h.db, {
      jobId: "job-paid-feed",
      startedAt: isoAgo(20 * MIN),
      lastActivityAt: isoAgo(30 * MIN),
      capability: "mcp.tool",
      payloadJson: runFeedJobPayload({ paymentSignature: "0xabc123" }),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
    expect(allRows(h.db)).toHaveLength(1);
    expect(rowStatus(h.db, "job-paid-feed").status).toBe("failed");
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed[0].payload.errorCode).toBe("FAILURE_ASYNC_JOB_ORPHANED");
    expect(h.audits.filter((a) => a.type === "async_job.retried")).toHaveLength(0);
  });

  it("a stale non-feed row is never re-armed, but still reaps with the orphan code", async () => {
    const h = makeHarness();
    seedRow(h.db, {
      jobId: "job-switch",
      startedAt: isoAgo(20 * MIN),
      lastActivityAt: isoAgo(30 * MIN),
      capability: "http.request",
      payloadJson: JSON.stringify({
        method: "POST",
        pathAndQuery: "/environment/switch",
        headers: {},
        body: "{}",
      }),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
    expect(allRows(h.db)).toHaveLength(1);
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed[0].payload.errorCode).toBe("FAILURE_ASYNC_JOB_ORPHANED");
  });

  it("a feed row already re-armed twice is not re-armed a third time (cap 2)", async () => {
    const h = makeHarness();
    seedRow(h.db, {
      jobId: "job-capped",
      startedAt: isoAgo(23 * MIN),
      lastActivityAt: isoAgo(30 * MIN),
      capability: "http.request",
      payloadJson: feedRunPayload(),
    });
    for (const [sibling, count] of [
      ["job-rearm-1", 1],
      ["job-rearm-2", 2],
    ] as const) {
      seedRow(h.db, {
        jobId: sibling,
        startedAt: isoAgo(20 * MIN),
        lastActivityAt: isoAgo(30 * MIN),
        status: "completed",
        capability: "http.request",
        payloadJson: JSON.stringify({
          ...JSON.parse(feedRunPayload()),
          retryOf: "job-capped",
          recoveryRearmOf: "job-capped",
          recoveryRearmCount: count,
        }),
      });
    }

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
    expect(allRows(h.db).filter((r) => r.status === "queued")).toHaveLength(0);
  });

  it("a stale generic row reaps with the orphan code, never the generic unknown-outcome code", async () => {
    const h = makeHarness();
    const lastActivityAt = isoAgo(30 * MIN);
    seedRow(h.db, {
      jobId: "job-generic",
      startedAt: isoAgo(3 * HOUR),
      lastActivityAt,
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
    const row = rowStatus(h.db, "job-generic");
    expect(row.status).toBe("failed");
    expect(row.error).toContain("Orphaned by a host restart");
    expect(row.error).toContain(lastActivityAt);
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.errorCode).toBe("FAILURE_ASYNC_JOB_ORPHANED");
    expect(failed[0].payload.errorCode).not.toBe("FAILURE_ASYNC_JOB_FAILED");
  });

  it("a fresh-heartbeat feed-run row is untouched", async () => {
    const h = makeHarness();
    seedRow(h.db, {
      jobId: "job-live-feed",
      startedAt: isoAgo(20 * MIN),
      lastActivityAt: isoAgo(MIN),
      capability: "http.request",
      payloadJson: feedRunPayload(),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 0, rearmed: 0 });
    expect(rowStatus(h.db, "job-live-feed").status).toBe("running");
    expect(allRows(h.db)).toHaveLength(1);
  });
});
