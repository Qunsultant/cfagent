// @vitest-environment node
/**
 * Issue #6217 — the orphan reap emits no `job.run.settled`:
 * `recoverStaleRunningAsyncJobs` / `settleStaleFeedDispatch`
 * settle the job via `reapStaleRunning` + an audit event, but
 * never fire the pipeline engine's `runSettledObserver`, so an
 * orphaned feed run produces NO OTel telemetry — even with a
 * working Grafana key, Grafana shows nothing for it. (The
 * #6179 live proof FAILED on exactly this shape: a UX options
 * run settled/failed with no `job.run.settled` in Grafana.)
 *
 * This file pins the fix: a reaped feed dispatch whose
 * pipeline run id resolved fires the context's run-settled
 * observer with the SAME `JobRunSettledInfo` shape
 * `recordTerminal` emits for a pipeline-settled failure —
 * jobId = the feed job id, runId = the pipeline run id,
 * trigger from the row's provenance, state "failed", error =
 * the reap message, kind from the dispatch, originRunId null
 * (the reap has no run-origin link; never invented) — so
 * Grafana queries for `job.run.settled` see orphans and
 * normal failures identically. The emission rides the
 * context's `otel` port (the #6179 shared-helper shape);
 * absent, the reap runs exactly as before.
 *
 * The guard rules are the #4002 recording rules, reused:
 * - no pipeline run id (door down, guard failed) → no event,
 *   never a fabricated run id;
 * - a run that started AFTER the executor's last activity is a
 *   LATER run, not this row's orphan → no event;
 * - a non-feed row has no pipeline run at all → no event (the
 *   engine's own guard: no run, no settle event);
 * - an observer failure never fails the reap.
 *
 * Harness mirrors tests/async_job_recovery_recording_4002.test.ts.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  ensureAsyncJobGraphColumns,
  orphanRunSettledKind,
  orphanRunSettledTrigger,
  recoverStaleRunningAsyncJobs,
  sweepStaleAsyncJobs,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import type { JobRunSettledInfo } from "../src/services/jobPipelineEngine";

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
  started_at TEXT, completed_at TEXT, host_version TEXT
)`;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

interface Harness {
  db: DatabaseSync;
  ctx: AsyncJobsContext;
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
  settled: JobRunSettledInfo[];
}

function makeHarness(env: Record<string, unknown> = {}, withObserver = true): Harness {
  const db = new DatabaseSync(":memory:");
  const sql = makeSql(db);
  const audits: Harness["audits"] = [];
  const settled: JobRunSettledInfo[] = [];
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
      throw new Error("no orm in 6217 harness");
    },
    ...(withObserver
      ? {
          otel: {
            runSettledObserver: async (info: JobRunSettledInfo) => {
              settled.push(info);
            },
            journal: { do: async (_name: string, fn: () => Promise<unknown>) => fn() },
          },
        }
      : {}),
  } as unknown as AsyncJobsContext;
  return { db, ctx, audits, settled };
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
    hostVersion?: string | null;
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
    row.hostVersion ?? null,
  );
}

const feedRunPayload = (provider = "yahoo") =>
  JSON.stringify({
    method: "POST",
    pathAndQuery: `/data-providers/${provider}/feed-run`,
    headers: {},
    body: "{}",
  });

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
    runStartedAt: isoAgo(23 * MIN),
    lastRunStatus: "failed",
    lastRunAt: isoAgo(5 * MIN),
    stages: [],
    ...overrides,
  },
});

describe("orphan reap emits job.run.settled through the run-settled observer (#6217)", () => {
  it("the onStart recovery fires one failed settle event for the orphaned feed run", async () => {
    const h = makeHarness(doorEnv(orphanView()));
    // Progressed orphan (run started 23m ago, executor alive
    // 7m ago): re-armed AND failed as orphaned — the original
    // run settled failed, so exactly one settle event fires
    // for it; the re-armed row settles on its own later.
    seedRow(h.db, {
      jobId: "job-feed-run",
      startedAt: isoAgo(23 * MIN),
      lastActivityAt: isoAgo(7 * MIN),
      capability: "http.request",
      payloadJson: feedRunPayload("yahoo"),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });

    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]).toEqual({
      jobId: "yahoo-nasdaq100-quotes",
      runId: "run-orphan-1",
      trigger: "manual",
      state: "failed",
      error: expect.stringContaining("Orphaned by a host restart"),
      kind: "original",
      originRunId: null,
    });
  });

  it("the sweep fires one failed settle event for a stale feed dispatch", async () => {
    const h = makeHarness(
      doorEnv(
        orphanView({
          currentRunId: "run-orphan-1",
          runStartedAt: isoAgo(3 * HOUR),
        }),
      ),
    );
    // Older than the 2h reap backstop, heartbeat stale, run
    // started before the executor's last activity.
    seedRow(h.db, {
      jobId: "job-feed-run",
      startedAt: isoAgo(3 * HOUR),
      lastActivityAt: isoAgo(2.5 * HOUR),
      capability: "http.request",
      payloadJson: feedRunPayload("yahoo"),
    });

    const result = await sweepStaleAsyncJobs(h.ctx);
    expect(result.reaped).toBe(1);

    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]).toEqual({
      jobId: "yahoo-nasdaq100-quotes",
      runId: "run-orphan-1",
      trigger: "manual",
      state: "failed",
      error: expect.stringContaining("Orphaned by a host restart"),
      kind: "original",
      originRunId: null,
    });
  });

  it("no otel port: the reap runs exactly as before (no event, no throw)", async () => {
    const h = makeHarness(doorEnv(orphanView()), false);
    seedRow(h.db, {
      jobId: "job-feed-run",
      startedAt: isoAgo(23 * MIN),
      lastActivityAt: isoAgo(7 * MIN),
      capability: "http.request",
      payloadJson: feedRunPayload("yahoo"),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });
    expect(h.settled).toHaveLength(0);
  });

  it("a non-feed row reaps with no settle event (no pipeline run to settle)", async () => {
    const h = makeHarness(doorEnv(orphanView()));
    seedRow(h.db, {
      jobId: "job-generic",
      startedAt: isoAgo(23 * MIN),
      lastActivityAt: isoAgo(7 * MIN),
      capability: "screen.run",
      payloadJson: "{}",
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
    expect(h.settled).toHaveLength(0);
  });

  it("a feed row with no resolvable pipeline run id emits nothing (no invented run id)", async () => {
    const h = makeHarness(doorEnv(null, true));
    seedRow(h.db, {
      jobId: "job-feed-run",
      startedAt: isoAgo(23 * MIN),
      lastActivityAt: isoAgo(7 * MIN),
      capability: "http.request",
      payloadJson: feedRunPayload("yahoo"),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });
    expect(h.settled).toHaveLength(0);
  });

  it("a run that started AFTER the executor's last activity emits nothing (a later run, not this orphan)", async () => {
    const h = makeHarness(
      doorEnv(
        orphanView({
          currentRunId: "run-later-1",
          runStartedAt: isoAgo(2 * MIN),
        }),
      ),
    );
    seedRow(h.db, {
      jobId: "job-feed-run",
      startedAt: isoAgo(23 * MIN),
      lastActivityAt: isoAgo(30 * MIN),
      capability: "http.request",
      payloadJson: feedRunPayload("yahoo"),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });
    expect(h.settled).toHaveLength(0);
  });

  it("a throwing observer never fails the reap (the row still fails as orphaned)", async () => {
    const h = makeHarness(doorEnv(orphanView()));
    (h.ctx as unknown as { otel: { runSettledObserver: unknown } }).otel.runSettledObserver =
      async () => {
        throw new Error("otel down");
      };
    seedRow(h.db, {
      jobId: "job-feed-run",
      startedAt: isoAgo(23 * MIN),
      lastActivityAt: isoAgo(7 * MIN),
      capability: "http.request",
      payloadJson: feedRunPayload("yahoo"),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });
    expect(h.settled).toHaveLength(0);
  });

  it("a re-armed stillborn feed row still emits for the original run (failed, not re-armed)", async () => {
    const h = makeHarness(doorEnv(orphanView()));
    // Stillborn on a CHANGED deploy SHA (#6216): re-armed AND
    // failed as orphaned — the settle event names the
    // ORIGINAL run, which did fail.
    (h.ctx.env as Record<string, unknown>).CF_DEPLOY_VERSION = "b".repeat(40);
    seedRow(h.db, {
      jobId: "job-stillborn-changed-sha",
      startedAt: isoAgo(20 * MIN),
      lastActivityAt: new Date(Date.parse(isoAgo(20 * MIN)) + 2000).toISOString(),
      capability: "http.request",
      payloadJson: feedRunPayload("yahoo"),
      hostVersion: "a".repeat(40),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0].runId).toBe("run-orphan-1");
    expect(h.settled[0].state).toBe("failed");
  });
});

describe("orphanRunSettledTrigger maps the row's provenance onto the run trigger (#6217)", () => {
  it("manual and scheduled pass through", () => {
    expect(orphanRunSettledTrigger("manual")).toBe("manual");
    expect(orphanRunSettledTrigger("scheduled")).toBe("scheduled");
  });

  it("autonomous maps to autopilot (the ledger vocabulary: autopilot = the autonomous loop dispatched it)", () => {
    expect(orphanRunSettledTrigger("autonomous")).toBe("autopilot");
  });

  it("an absent or unmappable trigger reads as manual (the normalizer's fail-closed default — never invented)", () => {
    expect(orphanRunSettledTrigger(null)).toBe("manual");
    expect(orphanRunSettledTrigger("webhook")).toBe("manual");
    expect(orphanRunSettledTrigger("agent")).toBe("manual");
  });
});

describe("orphanRunSettledKind derives the run's kind from the dispatch (#6217)", () => {
  it("a plain feed-run is an original", () => {
    expect(
      orphanRunSettledKind("http.request", {
        method: "POST",
        pathAndQuery: "/data-providers/yahoo/feed-run",
      }),
    ).toBe("original");
  });

  it("a feed-jobs retry is a re-run, a resume is a resume, a run is an original", () => {
    const base = "/data-providers/yahoo/feed-jobs/yahoo-nasdaq100-quotes";
    expect(orphanRunSettledKind("http.request", { pathAndQuery: `${base}/retry` })).toBe(
      "re-run",
    );
    expect(orphanRunSettledKind("http.request", { pathAndQuery: `${base}/resume` })).toBe(
      "resume",
    );
    expect(orphanRunSettledKind("http.request", { pathAndQuery: `${base}/run` })).toBe(
      "original",
    );
  });

  it("a row carrying retryOf / recoveryRearmOf is a re-run (it is itself a re-arm)", () => {
    expect(
      orphanRunSettledKind("http.request", {
        method: "POST",
        pathAndQuery: "/data-providers/yahoo/feed-run",
        retryOf: "job-earlier",
      }),
    ).toBe("re-run");
    expect(
      orphanRunSettledKind("mcp.tool", {
        toolName: "run_feed_job",
        arguments: { source: "yahoo sentiment" },
        recoveryRearmOf: "job-earlier",
      }),
    ).toBe("re-run");
  });

  it("anything else is an original (never claims to be a re-run of a run it cannot name)", () => {
    expect(orphanRunSettledKind("mcp.tool", { toolName: "run_feed_job" })).toBe("original");
    expect(orphanRunSettledKind("screen.run", {})).toBe("original");
  });
});
