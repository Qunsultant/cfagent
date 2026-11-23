// @vitest-environment node
/**
 * Issue #6250 item 4 — the orphan reap path emits `job.run.settled`.
 *
 * `recoverStaleRunningAsyncJobs` / `settleStaleFeedDispatch` /
 * `sweepStaleAsyncJobs` settle jobs via `ports(ctx).queue.reapStaleRunning`
 * and never call the engine's `recordTerminal`, so reaped orphans were
 * invisible to Grafana by design. The reap now emits the same
 * `job.run.settled` event, same shape, state "failed" with the orphan
 * error — through the shared OTel observer set, never a duplicate
 * emitter. Best-effort: an observer failure never breaks the reap.
 *
 * The observer set is mocked at the module boundary (the repo's
 * vi.mock idiom): the test pins that the reap calls the shared
 * observer with the right shape, not the OTel stack itself (that
 * stack is pinned by tests/otel_job_pipeline_observers_6179.test.ts).
 *
 * Harness mirrors tests/async_job_orphan_stillborn_6216.test.ts:
 * real node:sqlite behind the family's ports, rows seeded at
 * controlled ages.
 *
 * TDD Red first: asyncJobs.ts emits nothing from the reap path yet,
 * so the emission assertions fail.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

const { observed, throwing } = vi.hoisted(() => ({
  observed: [] as Array<Record<string, unknown>>,
  throwing: { value: false },
}));

vi.mock("../src/observability/otelJobPipelineObservers", () => ({
  getOtelJobPipelineObservers: () => ({
    runSettledObserver: async (info: Record<string, unknown>) => {
      if (throwing.value) throw new Error("observer boom");
      observed.push(info);
    },
    journal: { do: async (_name: string, fn: () => Promise<unknown>) => fn() },
  }),
}));

import {
  ensureAsyncJobGraphColumns,
  recoverStaleRunningAsyncJobs,
  sweepStaleAsyncJobs,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";

/** SqlStorage-shaped executor over node:sqlite (same shim as #2358/#4002). */
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
  started_at TEXT, completed_at TEXT, host_version TEXT
)`;

const MIN = 60 * 1000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

interface Harness {
  db: DatabaseSync;
  sql: ReturnType<typeof makeSql>;
  ctx: AsyncJobsContext;
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
}

function makeHarness(env: Record<string, unknown>): Harness {
  const db = new DatabaseSync(":memory:");
  const sql = makeSql(db);
  const audits: Harness["audits"] = [];
  const ctx = {
    env,
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
      throw new Error("no orm in 6250 harness");
    },
  } as unknown as AsyncJobsContext;
  (ctx as unknown as { ensureTables: () => unknown }).ensureTables();
  return { db, sql, ctx, audits };
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
    "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at, started_at, last_activity_at, host_version) VALUES (?, 'owner-login-1', ?, 'Seeded run', ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.jobId,
    row.capability ?? "screen.run",
    row.status ?? "running",
    row.payloadJson ?? "{}",
    row.startedAt,
    row.startedAt,
    row.startedAt,
    row.lastActivityAt ?? null,
    null,
  );
}

function rowStatus(db: DatabaseSync, jobId: string): { status: string; error: string | null } {
  return db.prepare("SELECT status, error FROM mas_async_jobs WHERE job_id = ?").get(jobId) as {
    status: string;
    error: string | null;
  };
}

const feedRunPayload = () =>
  JSON.stringify({
    method: "POST",
    pathAndQuery: "/data-providers/yahoo/feed-run",
    headers: {},
    body: "{}",
  });

describe("orphan reap emits job.run.settled (#6250 item 4)", () => {
  it("recover: a reaped generic orphan emits one failed settle with the row's ids and the orphan error", async () => {
    observed.length = 0;
    const h = makeHarness({});
    const startedAt = isoAgo(20 * MIN);
    seedRow(h.db, {
      jobId: "job-orphan-generic",
      startedAt,
      lastActivityAt: new Date(Date.parse(startedAt) + 2000).toISOString(),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
    expect(rowStatus(h.db, "job-orphan-generic").status).toBe("failed");
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      jobId: "job-orphan-generic",
      runId: "job-orphan-generic",
      trigger: "manual",
      state: "failed",
    });
    expect(observed[0]?.error).toContain("Orphaned by a host restart");
  });

  it("recover: a reaped feed orphan names the feed job id (not the async row id); the run id is the pipeline run when known, else the row id", async () => {
    observed.length = 0;
    const h = makeHarness({});
    const startedAt = isoAgo(20 * MIN);
    seedRow(h.db, {
      jobId: "job-orphan-feed",
      startedAt,
      lastActivityAt: new Date(Date.parse(startedAt) + 2000).toISOString(),
      capability: "http.request",
      payloadJson: feedRunPayload(),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
    expect(observed).toHaveLength(1);
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed).toHaveLength(1);
    // The emission names the feed job the row was dispatching, exactly
    // as the audit does — never the async row id — and falls back to
    // the row id when no feed job resolves.
    const feedJobId = failed[0].payload.feedJobId;
    expect(observed[0]?.jobId).toBe(
      typeof feedJobId === "string" && feedJobId ? feedJobId : "job-orphan-feed",
    );
    expect(observed[0]?.runId).toBe("job-orphan-feed");
    expect(observed[0]?.state).toBe("failed");
    expect(observed[0]?.error).toContain("Orphaned by a host restart");
  });

  it("sweep: the feed settle path and the generic reap path both emit", async () => {
    observed.length = 0;
    const h = makeHarness({});
    const startedAt = isoAgo(3 * 60 * MIN);
    seedRow(h.db, {
      jobId: "job-sweep-feed",
      startedAt,
      lastActivityAt: startedAt,
      capability: "http.request",
      payloadJson: feedRunPayload(),
    });
    seedRow(h.db, {
      jobId: "job-sweep-generic",
      startedAt,
      lastActivityAt: startedAt,
    });

    const result = await sweepStaleAsyncJobs(h.ctx, Date.now());
    expect(result.reaped).toBe(2);
    expect(observed).toHaveLength(2);
    const byRunId = new Map(observed.map((o) => [o.runId, o]));
    expect(byRunId.get("job-sweep-feed")?.state).toBe("failed");
    expect(byRunId.get("job-sweep-generic")).toMatchObject({
      jobId: "job-sweep-generic",
      runId: "job-sweep-generic",
      state: "failed",
    });
    expect(byRunId.get("job-sweep-generic")?.error).toContain(
      "Execution stopped before a result was recorded",
    );
  });

  it("a fresh (not stale) row is not reaped and emits nothing", async () => {
    observed.length = 0;
    const h = makeHarness({});
    seedRow(h.db, {
      jobId: "job-fresh",
      startedAt: isoAgo(1 * MIN),
      lastActivityAt: isoAgo(1 * MIN),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result.failed).toBe(0);
    expect(observed).toHaveLength(0);
  });

  it("an observer failure never breaks the reap (best-effort)", async () => {
    observed.length = 0;
    throwing.value = true;
    try {
      const h = makeHarness({});
      const startedAt = isoAgo(20 * MIN);
      seedRow(h.db, {
        jobId: "job-orphan-observer-boom",
        startedAt,
        lastActivityAt: new Date(Date.parse(startedAt) + 2000).toISOString(),
      });

      const result = await recoverStaleRunningAsyncJobs(h.ctx);
      expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
      expect(rowStatus(h.db, "job-orphan-observer-boom").status).toBe("failed");
      expect(h.audits.filter((a) => a.type === "async_job.failed")).toHaveLength(1);
    } finally {
      throwing.value = false;
    }
  });
});
