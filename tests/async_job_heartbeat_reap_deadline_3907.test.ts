// @vitest-environment node
/**
 * Issue #3907 — heartbeat-aware reap + execution deadline.
 *
 * Incident (2026-11-09): two paid MCP jobs (paid_options_screener
 * 62319ea2, paid_market_research f89ae255, both started 11:50 AM)
 * ran 2h11m and were both failed at 2:02:01 PM by one sweep tick.
 * The 2h reap decided on wall-clock age alone and never looked at
 * the heartbeat the executor maintains every 2 minutes (#3811) —
 * it killed live, heartbeating jobs after their x402 charges were
 * taken, with no result and no refund path.
 *
 * This file pins the fix:
 * - a row with a FRESH heartbeat is never reaped, at any age
 *   (sweep + getAsyncJob read path);
 * - a row with a STALE heartbeat is reaped past 2h, exactly as
 *   before (and a pre-heartbeat row falls back to started_at age,
 *   preserving the #3784 backstop);
 * - the executor's max-runtime deadline fails a hung leg with the
 *   cataloged FAILURE_ASYNC_JOB_TIMEOUT (never a silent reap);
 * - onStart recovery fails fast only stale-heartbeat rows, never
 *   re-runs one;
 * - a paid job's recorded payload cannot be retried (its x402
 *   signature was consumed at verification);
 * - the Queues-page status helpers never read a failure as clear.
 *
 * Harness mirrors tests/stale_async_job_sweep_3784.test.ts: real
 * node:sqlite behind the family's ports, rows seeded at controlled
 * ages, an injected notifyStuckRun spy standing in for the Slack
 * delivery the class wires in production.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  createExecutionDeadline,
  ensureAsyncJobGraphColumns,
  getAsyncJob,
  isHeartbeatStale,
  HEARTBEAT_STALE_MS,
  recoverStaleRunningAsyncJobs,
  resolveAsyncJobMaxRuntimeMs,
  retryAsyncJob,
  sweepStaleAsyncJobs,
  type AsyncJobsContext,
  type StuckRunAlertInfo,
} from "../src/agents/orchestrator/asyncJobs";
import { asyncJobsStatusLabel } from "../src/client/AsyncJobsPanel";
import { dlqHeaderStatus } from "../src/client/DlqPanel";

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
const HOUR = 60 * MIN;
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
      throw new Error("no orm in 3907 harness");
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

describe("isHeartbeatStale (#3907)", () => {
  it("a heartbeat 1 minute ago is fresh (never stale)", () => {
    const nowMs = Date.now();
    expect(isHeartbeatStale({ last_activity_at: new Date(nowMs - MIN).toISOString(), started_at: isoAgo(3 * HOUR) }, nowMs)).toBe(false);
  });

  it("a heartbeat 30 minutes ago is stale (3x the 2-min interval = 6 min)", () => {
    const nowMs = Date.now();
    expect(isHeartbeatStale({ last_activity_at: new Date(nowMs - 30 * MIN).toISOString(), started_at: isoAgo(3 * HOUR) }, nowMs)).toBe(true);
  });

  it("the bound is exactly three heartbeat intervals", () => {
    expect(HEARTBEAT_STALE_MS).toBe(6 * MIN);
    const nowMs = Date.now();
    // Exactly at the bound: silence equals the bound, not more — fresh.
    expect(isHeartbeatStale({ last_activity_at: new Date(nowMs - HEARTBEAT_STALE_MS).toISOString(), started_at: isoAgo(3 * HOUR) }, nowMs)).toBe(false);
    expect(isHeartbeatStale({ last_activity_at: new Date(nowMs - HEARTBEAT_STALE_MS - 1).toISOString(), started_at: isoAgo(3 * HOUR) }, nowMs)).toBe(true);
  });

  it("a pre-heartbeat row falls back to started_at age (the #3784 backstop)", () => {
    const nowMs = Date.now();
    expect(isHeartbeatStale({ last_activity_at: null, started_at: isoAgo(3 * HOUR) }, nowMs)).toBe(true);
    expect(isHeartbeatStale({ last_activity_at: null, started_at: isoAgo(30 * MIN) }, nowMs)).toBe(false);
  });

  it("an unparseable last_activity_at falls back to started_at, never throws", () => {
    const nowMs = Date.now();
    expect(isHeartbeatStale({ last_activity_at: "not-a-date", started_at: isoAgo(3 * HOUR) }, nowMs)).toBe(true);
    expect(isHeartbeatStale({ last_activity_at: "not-a-date", started_at: isoAgo(30 * MIN) }, nowMs)).toBe(false);
    expect(isHeartbeatStale({ last_activity_at: "not-a-date", started_at: "also-not-a-date" }, nowMs)).toBe(true);
  });
});

describe("heartbeat-aware sweep (#3907)", () => {
  it("NEVER reaps a live, heartbeating job at 2h+ (the incident case)", async () => {
    const h = makeHarness();
    // The incident shape: started 3h ago, heartbeat 1 minute ago.
    seedRow(h.db, { jobId: "job-live", startedAt: isoAgo(3 * HOUR), lastActivityAt: isoAgo(MIN) });

    const result = sweepStaleAsyncJobs(h.ctx);
    // The stuck alert still fires on started_at age (its #2567
    // contract — the heartbeat is evidence there, never a second
    // threshold); the reap must not.
    expect(result).toEqual({ examined: 1, alerted: 1, reaped: 0 });
    await vi.waitFor(() => expect(h.alerts).toHaveLength(1));
    expect(rowStatus(h.db, "job-live").status).toBe("running");
    expect(h.audits.filter((a) => a.type === "async_job.failed")).toHaveLength(0);
  });

  it("reaps a stale-heartbeat row past 2h, with the tool name in the audit", async () => {
    const h = makeHarness();
    const startedAt = isoAgo(3 * HOUR);
    // Captured once: the sweep's audit carries this exact instant as
    // the last activity, so a fresh Date.now() at assertion time
    // would flake by milliseconds (same idiom as #3784).
    const lastActivityAt = isoAgo(30 * MIN);
    seedRow(h.db, {
      jobId: "job-dead",
      startedAt,
      lastActivityAt,
      capability: "mcp.tool",
      payloadJson: JSON.stringify({ toolName: "paid_options_screener", arguments: { paymentSignature: "sig" } }),
    });

    const result = sweepStaleAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, alerted: 0, reaped: 1 });
    await new Promise((r) => setTimeout(r, 25));
    expect(h.alerts).toHaveLength(0);
    const row = rowStatus(h.db, "job-dead");
    expect(row.status).toBe("failed");
    expect(row.error).toBe(REAP_MESSAGE);
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toEqual({
      jobId: "job-dead",
      capability: "mcp.tool",
      // Issue #3907: the tool name, so a reaped paid job traces to
      // its x402 receipt.
      tool: "paid_options_screener",
      error: REAP_MESSAGE,
      errorCode: "FAILURE_ASYNC_JOB_FAILED",
      lastActivityAt,
    });
  });

  it("a pre-heartbeat row past 2h still reaps (the #3784 backstop is preserved)", async () => {
    const h = makeHarness();
    const startedAt = isoAgo(3 * HOUR);
    seedRow(h.db, { jobId: "job-legacy", startedAt, lastActivityAt: null });

    const result = sweepStaleAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, alerted: 0, reaped: 1 });
    expect(rowStatus(h.db, "job-legacy").status).toBe("failed");
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.errorCode).toBe("FAILURE_ASYNC_JOB_FAILED");
    expect(failed[0].payload.lastActivityAt).toBe(startedAt);
  });
});

describe("heartbeat-aware read-path reap (#3907)", () => {
  it("a fresh-heartbeat row reads back as running, never reaped", () => {
    const h = makeHarness();
    seedRow(h.db, { jobId: "job-live-read", startedAt: isoAgo(3 * HOUR), lastActivityAt: isoAgo(MIN) });

    const row = getAsyncJob(h.ctx, "job-live-read");
    expect(row?.status).toBe("running");
    expect(rowStatus(h.db, "job-live-read").status).toBe("running");
  });

  it("a stale-heartbeat row reads back as failed", () => {
    const h = makeHarness();
    seedRow(h.db, { jobId: "job-dead-read", startedAt: isoAgo(3 * HOUR), lastActivityAt: isoAgo(30 * MIN) });

    const row = getAsyncJob(h.ctx, "job-dead-read");
    expect(row?.status).toBe("failed");
    expect(rowStatus(h.db, "job-dead-read").status).toBe("failed");
  });
});

describe("execution deadline (#3907)", () => {
  it("resolves the max runtime: default 90 min, env override, 0 disables, garbage falls back", () => {
    expect(resolveAsyncJobMaxRuntimeMs({})).toBe(90 * MIN);
    expect(resolveAsyncJobMaxRuntimeMs({ ASYNC_JOB_MAX_RUNTIME_MINUTES: "120" })).toBe(120 * MIN);
    expect(resolveAsyncJobMaxRuntimeMs({ ASYNC_JOB_MAX_RUNTIME_MINUTES: "0" })).toBe(0);
    expect(resolveAsyncJobMaxRuntimeMs({ ASYNC_JOB_MAX_RUNTIME_MINUTES: "-5" })).toBe(0);
    expect(resolveAsyncJobMaxRuntimeMs({ ASYNC_JOB_MAX_RUNTIME_MINUTES: "not-a-number" })).toBe(90 * MIN);
    expect(resolveAsyncJobMaxRuntimeMs({ ASYNC_JOB_MAX_RUNTIME_MINUTES: "" })).toBe(90 * MIN);
    expect(resolveAsyncJobMaxRuntimeMs({ ASYNC_JOB_MAX_RUNTIME_MINUTES: " 45 " })).toBe(45 * MIN);
  });

  it("fires with the cataloged timeout code when the leg hangs", async () => {
    const deadline = createExecutionDeadline(10);
    const hungLeg = new Promise<string>((resolve) => setTimeout(() => resolve("too late"), 500));
    const error = await Promise.race([hungLeg, deadline.promise]).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).not.toBeNull();
    expect((error as { code?: unknown }).code).toBe("FAILURE_ASYNC_JOB_TIMEOUT");
    expect((error as Error).message).toContain("maximum runtime");
    deadline.cancel();
  });

  it("a fast leg wins the race and the deadline cancels cleanly", async () => {
    const deadline = createExecutionDeadline(500);
    const fastLeg = Promise.resolve("done");
    await expect(Promise.race([fastLeg, deadline.promise])).resolves.toBe("done");
    deadline.cancel();
    // After cancel the timer never fires: the promise stays pending.
    const outcome = await Promise.race([
      deadline.promise.then(() => "fired" as const, () => "fired" as const),
      new Promise((resolve) => setTimeout(() => resolve("no-fire" as const), 30)),
    ]);
    expect(outcome).toBe("no-fire");
  });

  it("a disabled deadline (0) never fires", async () => {
    const deadline = createExecutionDeadline(0);
    const outcome = await Promise.race([
      deadline.promise.then(() => "fired" as const, () => "fired" as const),
      new Promise((resolve) => setTimeout(() => resolve("no-fire" as const), 30)),
    ]);
    expect(outcome).toBe("no-fire");
    deadline.cancel();
  });
});

describe("orphaned-running recovery (#3907)", () => {
  it("fails fast only stale-heartbeat rows, leaves live ones running, never re-runs", async () => {
    const h = makeHarness();
    seedRow(h.db, { jobId: "job-orphan", startedAt: isoAgo(3 * HOUR), lastActivityAt: isoAgo(30 * MIN) });
    seedRow(h.db, { jobId: "job-alive", startedAt: isoAgo(3 * HOUR), lastActivityAt: isoAgo(MIN) });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 2, failed: 1 });
    expect(rowStatus(h.db, "job-orphan").status).toBe("failed");
    expect(rowStatus(h.db, "job-orphan").error).toBe(REAP_MESSAGE);
    expect(rowStatus(h.db, "job-alive").status).toBe("running");
    // The recovery audit is the reap's audit, with the tool omitted
    // for a non-MCP row.
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.jobId).toBe("job-orphan");
  });

  it("is idempotent: a second run fails nothing", async () => {
    const h = makeHarness();
    seedRow(h.db, { jobId: "job-orphan-2", startedAt: isoAgo(3 * HOUR), lastActivityAt: isoAgo(30 * MIN) });
    seedRow(h.db, { jobId: "job-alive-2", startedAt: isoAgo(3 * HOUR), lastActivityAt: isoAgo(MIN) });

    await recoverStaleRunningAsyncJobs(h.ctx);
    const second = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(second).toEqual({ examined: 1, failed: 0 });
    expect(rowStatus(h.db, "job-alive-2").status).toBe("running");
  });
});

describe("paid-job retry guard (#3907)", () => {
  it("refuses a retry when the recorded payload carries a consumed paymentSignature", async () => {
    const h = makeHarness();
    seedRow(h.db, {
      jobId: "job-paid",
      startedAt: isoAgo(3 * HOUR),
      lastActivityAt: isoAgo(30 * MIN),
      status: "failed",
      capability: "mcp.tool",
      payloadJson: JSON.stringify({ toolName: "paid_market_research", arguments: { paymentSignature: "x402-sig" } }),
    });

    await expect(retryAsyncJob(h.ctx, "job-paid")).rejects.toThrow(
      "payment was already consumed",
    );
    expect(rowStatus(h.db, "job-paid").status).toBe("failed");
  });

  it("retries a failed job whose payload carries no paymentSignature", async () => {
    const h = makeHarness();
    seedRow(h.db, {
      jobId: "job-free",
      startedAt: isoAgo(3 * HOUR),
      lastActivityAt: isoAgo(30 * MIN),
      status: "failed",
      capability: "mcp.tool",
      payloadJson: JSON.stringify({ toolName: "get_async_job", arguments: {} }),
    });

    const submitted = await retryAsyncJob(h.ctx, "job-free");
    expect(submitted.status).toBe("queued");
    expect(submitted.jobId).not.toBe("job-free");
    expect(rowStatus(h.db, "job-free").status).toBe("failed");
    expect(
      h.audits.filter((a) => a.type === "async_job.retried" && a.payload.jobId === "job-free"),
    ).toHaveLength(1);
  });
});

describe("Queues-page status helpers (#3907)", () => {
  it("asyncJobsStatusLabel: clear only when nothing active AND nothing failed", () => {
    expect(asyncJobsStatusLabel({ active: 0, failed: 0, error: null })).toBe("Idle / Queue clear");
    expect(asyncJobsStatusLabel({ active: 2, failed: 0, error: null })).toBe("2 tasks running");
    expect(asyncJobsStatusLabel({ active: 1, failed: 0, error: null })).toBe("1 task running");
    // The incident case: five failed, zero active — never "clear".
    expect(asyncJobsStatusLabel({ active: 0, failed: 5, error: null })).toBe("5 failed");
    expect(asyncJobsStatusLabel({ active: 0, failed: 1, error: null })).toBe("1 failed");
    expect(asyncJobsStatusLabel({ active: 1, failed: 3, error: null })).toBe("1 task running");
    expect(asyncJobsStatusLabel({ active: 0, failed: 0, error: "Could not load async jobs." })).toBe("Could not load");
  });

  it("dlqHeaderStatus: load failure never reads as Queue clear", () => {
    expect(dlqHeaderStatus({ loading: true, error: null, count: 0 })).toBe("Loading…");
    expect(dlqHeaderStatus({ loading: false, error: "The dead-letter queue could not be loaded.", count: 0 })).toBe("Could not load");
    expect(dlqHeaderStatus({ loading: false, error: null, count: 0 })).toBe("Queue clear");
    expect(dlqHeaderStatus({ loading: false, error: null, count: 1 })).toBe("1 unreplayed record");
    expect(dlqHeaderStatus({ loading: false, error: null, count: 3 })).toBe("3 unreplayed records");
  });
});
