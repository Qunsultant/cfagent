// @vitest-environment node
/**
 * Issue #4002 (recording slice, owner decision 2026-11-10 11:22 EST):
 * a failed feed-run must record its feed job id + pipeline run id
 * on the async job row / outcome even when no artifact is stored,
 * so the next identical failure is identifiable beyond its
 * provider in the Workflow Runs view.
 *
 * The three rows that motivated this were all QUOTES runs by
 * construction (the feed-run route takes only a provider id and
 * forSource() returns the first registered job for that source),
 * but no surface recorded that: the data_provider.feed_run audit
 * exists only when an artifact was stored, the per-job surface
 * only from persisted artifacts, and the mas_async_jobs row's
 * display is just "METHOD path". This file pins the recording in
 * recoverStaleRunningAsyncJobs:
 * - the feed job id is resolved from the dispatch payload
 *   (HTTP: provider in the path -> forSource; MCP: the source
 *   argument -> resolveFeedJob) and recorded in the reap
 *   message (the row's error column, rendered by the Workflow
 *   Runs view) and in the async_job.failed / async_job.retried
 *   audit fields;
 * - the pipeline run id is read from the pipeline host through
 *   the existing getFeedJobSurfaceStatus door method
 *   (pipeline.currentRunId) and recorded the same way — but
 *   ONLY when the run started before the executor's last
 *   activity (pipeline.runStartedAt <= lastActivityAt): a run
 *   that started after is a LATER run, not this row's orphan,
 *   and must never be attributed to it;
 * - when the door is unavailable, the call throws, or the guard
 *   fails, the feed job id is still recorded and the pipeline
 *   run id is honestly null — the recovery never fails because
 *   the lookup failed, and a non-feed row records nothing extra.
 *
 * Harness mirrors tests/async_job_recovery_rearm_4002.test.ts.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  ensureAsyncJobGraphColumns,
  recoverStaleRunningAsyncJobs,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";

/** SqlStorage-shaped executor over node:sqlite (same shim as #2358/#2567). */
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

interface Harness {
  db: DatabaseSync;
  ctx: AsyncJobsContext;
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
}

function makeHarness(env: Record<string, unknown> = {}): Harness {
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

function rowError(db: DatabaseSync, jobId: string): string | null {
  return (
    db.prepare("SELECT error FROM mas_async_jobs WHERE job_id = ?").get(jobId) as {
      error: string | null;
    }
  ).error;
}

const feedRunPayload = (provider = "yahoo") =>
  JSON.stringify({
    method: "POST",
    pathAndQuery: `/data-providers/${provider}/feed-run`,
    headers: {},
    body: "{}",
  });

const runFeedJobPayload = (source: string) =>
  JSON.stringify({ toolName: "run_feed_job", arguments: { source } });

/** A fake SCHEDULED_AGENT namespace whose door returns one canned surface view. */
function doorEnv(view: Record<string, unknown> | null, throwOnCall = false) {
  return {
    SCHEDULED_AGENT: {
      idFromName: () => "default-id",
      get: () => ({
        getFeedJobSurfaceStatus: async (_jobId: string) => {
          if (throwOnCall) throw new Error("door down");
          return view;
        },
      }),
    },
  };
}

const orphanView = (overrides: Record<string, unknown> = {}) => ({
  jobId: "yahoo-nasdaq100-quotes",
  pipeline: {
    state: "failed",
    currentRunId: "run-orphan-1",
    runStartedAt: isoAgo(23 * 60 * 1000),
    lastRunStatus: "failed",
    lastRunAt: isoAgo(5 * 60 * 1000),
    stages: [],
    ...overrides,
  },
});

describe("onStart recovery records the feed job id + pipeline run id (#4002)", () => {
  it("an orphaned Yahoo feed-run records both ids in the row error and the audits", async () => {
    const h = makeHarness(doorEnv(orphanView()));
    // The run started 23m ago and the executor was still alive
    // 7m ago (its last heartbeat) — runStartedAt precedes
    // lastActivityAt, so the run is this row's orphan.
    const lastActivityAt = isoAgo(7 * MIN);
    seedRow(h.db, {
      jobId: "job-feed-run",
      startedAt: isoAgo(23 * 60 * 1000),
      lastActivityAt,
      capability: "http.request",
      payloadJson: feedRunPayload("yahoo"),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });

    const error = rowError(h.db, "job-feed-run");
    expect(error).toContain("yahoo-nasdaq100-quotes");
    expect(error).toContain("run-orphan-1");

    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.feedJobId).toBe("yahoo-nasdaq100-quotes");
    expect(failed[0].payload.pipelineRunId).toBe("run-orphan-1");
    const retried = h.audits.filter((a) => a.type === "async_job.retried");
    expect(retried).toHaveLength(1);
    expect(retried[0].payload.feedJobId).toBe("yahoo-nasdaq100-quotes");
    expect(retried[0].payload.pipelineRunId).toBe("run-orphan-1");
  });

  it("a run that started AFTER the executor's last activity is never attributed to the row", async () => {
    const h = makeHarness(
      doorEnv(
        orphanView({
          currentRunId: "run-later-1",
          runStartedAt: isoAgo(2 * 60 * 1000),
        }),
      ),
    );
    const lastActivityAt = isoAgo(30 * MIN);
    seedRow(h.db, {
      jobId: "job-feed-run",
      startedAt: isoAgo(23 * 60 * 1000),
      lastActivityAt,
      capability: "http.request",
      payloadJson: feedRunPayload("yahoo"),
    });

    await recoverStaleRunningAsyncJobs(h.ctx);

    const error = rowError(h.db, "job-feed-run");
    expect(error).toContain("yahoo-nasdaq100-quotes");
    expect(error).not.toContain("run-later-1");
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.feedJobId).toBe("yahoo-nasdaq100-quotes");
    expect(failed[0].payload.pipelineRunId).toBeUndefined();
  });

  it("a down door still records the feed job id; the pipeline run id is honestly null", async () => {
    const h = makeHarness(doorEnv(null, true));
    const lastActivityAt = isoAgo(30 * MIN);
    seedRow(h.db, {
      jobId: "job-feed-run",
      startedAt: isoAgo(23 * 60 * 1000),
      lastActivityAt,
      capability: "http.request",
      payloadJson: feedRunPayload("public"),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });

    const error = rowError(h.db, "job-feed-run");
    expect(error).toContain("public-nasdaq100-quotes");
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed[0].payload.feedJobId).toBe("public-nasdaq100-quotes");
    expect(failed[0].payload.pipelineRunId).toBeUndefined();
  });

  it("no door binding at all still records the feed job id (the Public row's shape)", async () => {
    const h = makeHarness({});
    seedRow(h.db, {
      jobId: "job-feed-run",
      startedAt: isoAgo(23 * 60 * 1000),
      lastActivityAt: isoAgo(30 * MIN),
      capability: "http.request",
      payloadJson: feedRunPayload("public"),
    });

    await recoverStaleRunningAsyncJobs(h.ctx);

    expect(rowError(h.db, "job-feed-run")).toContain("public-nasdaq100-quotes");
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed[0].payload.feedJobId).toBe("public-nasdaq100-quotes");
  });

  it("an MCP run_feed_job row resolves its job from the source argument (sentiment)", async () => {
    const h = makeHarness(
      doorEnv({
        jobId: "yahoo-nasdaq100-sentiment",
        pipeline: {
          state: "failed",
          currentRunId: "run-sentiment-1",
          runStartedAt: isoAgo(23 * 60 * 1000),
          lastRunStatus: "failed",
          lastRunAt: isoAgo(5 * 60 * 1000),
          stages: [],
        },
      }),
    );
    seedRow(h.db, {
      jobId: "job-sentiment-run",
      startedAt: isoAgo(23 * 60 * 1000),
      // Run started 23m ago; executor alive 7m ago — the run is
      // this row's orphan (see the Yahoo test above).
      lastActivityAt: isoAgo(7 * MIN),
      capability: "mcp.tool",
      payloadJson: runFeedJobPayload("yahoo sentiment"),
    });

    await recoverStaleRunningAsyncJobs(h.ctx);

    const error = rowError(h.db, "job-sentiment-run");
    expect(error).toContain("yahoo-nasdaq100-sentiment");
    expect(error).toContain("run-sentiment-1");
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed[0].payload.feedJobId).toBe("yahoo-nasdaq100-sentiment");
    expect(failed[0].payload.pipelineRunId).toBe("run-sentiment-1");
  });

  it("a non-feed row records nothing extra", async () => {
    const h = makeHarness(doorEnv(orphanView()));
    seedRow(h.db, {
      jobId: "job-generic",
      startedAt: isoAgo(23 * 60 * 1000),
      lastActivityAt: isoAgo(30 * MIN),
      capability: "screen.run",
      payloadJson: "{}",
    });

    await recoverStaleRunningAsyncJobs(h.ctx);

    const error = rowError(h.db, "job-generic");
    expect(error).not.toContain("yahoo-nasdaq100-quotes");
    expect(error).not.toContain("run-orphan-1");
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed[0].payload.feedJobId).toBeUndefined();
    expect(failed[0].payload.pipelineRunId).toBeUndefined();
  });

  it("an unresolvable provider still reaps, with no invented job id", async () => {
    const h = makeHarness(doorEnv(orphanView()));
    seedRow(h.db, {
      jobId: "job-unknown-provider",
      startedAt: isoAgo(23 * 60 * 1000),
      lastActivityAt: isoAgo(30 * MIN),
      capability: "http.request",
      payloadJson: feedRunPayload("nope"),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });

    const error = rowError(h.db, "job-unknown-provider");
    expect(error).not.toContain("yahoo-nasdaq100-quotes");
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed[0].payload.feedJobId).toBeUndefined();
  });
});
