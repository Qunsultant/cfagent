// @vitest-environment node
/**
 * Issue #6167 — orphaned Yahoo feed jobs (2026-11-22).
 *
 * RCA: three consecutive Yahoo feed jobs orphaned, each dying within
 * seconds of the claim (before the first 2-minute heartbeat), and each
 * re-arm dying the same way. The re-arm replays the IDENTICAL dispatch
 * with no change and no delay, so it hits the identical fatal
 * condition — the re-arm burns runs instead of recovering. The
 * platform reports a version id, not a restart cause (#4418), so the
 * RCA could not name the restart class from the row alone.
 *
 * This file pins the fix in recoverStaleRunningAsyncJobs (+ the
 * sweep's settleStaleFeedDispatch, same shared rule):
 * - the claim stamps the host version (CF_VERSION_METADATA.id) on
 *   the row (host_version, probed additive column, NULL on legacy
 *   rows) and in the async_job.started audit;
 * - at reap time the orphan message NAMES the restart class:
 *   version changed => deploy restart; version unchanged =>
 *   same-version restart (eviction / hibernation / crash, not a
 *   deploy); version unknown on either side => the existing
 *   "restart cause not reported" text;
 * - a stillborn orphan on an UNCHANGED version is NOT re-armed:
 *   the dispatch never progressed past the claim (last activity
 *   within STILLBORN_ORPHAN_MS of the claim), so an immediate
 *   identical re-arm just burns another run. It fails visibly with
 *   the reason named. A stillborn orphan on a CHANGED version
 *   (a deploy killed it) and a PROGRESSED orphan are still
 *   re-armed as before, cap 2 preserved; an unknown version
 *   fell back to re-arming (existing behavior preserved) UNTIL
 *   #6216: the live evidence (three feed re-arms on 2026-11-22
 *   plus the 2026-11-23 one, all dead in seconds) showed the
 *   unknown fallback let the re-arm loop through, so #6216
 *   refuses a stillborn orphan on an unknown version too — a
 *   stillborn orphan is re-armed ONLY on positive evidence of
 *   a deploy. See tests/async_job_orphan_stillborn_6216.test.ts.
 *
 * Harness mirrors tests/async_job_recovery_rearm_4002.test.ts:
 * real node:sqlite behind the family's ports, rows seeded at
 * controlled ages. The test DDL carries host_version (the
 * production ensureSchema adds it via remainder-alter).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  createAsyncJobPorts,
  ensureAsyncJobGraphColumns,
  recoverStaleRunningAsyncJobs,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { createAsyncJobPorts as createPorts } from "../src/data/createAsyncJobPorts";

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

function makeHarness(): Harness {
  const db = new DatabaseSync(":memory:");
  const sql = makeSql(db);
  const audits: Harness["audits"] = [];
  const ctx = {
    // The host version at REAP time (what CF_VERSION_METADATA reports now).
    env: { CF_VERSION_METADATA: { id: "v-1" } },
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
      throw new Error("no orm in 6167 harness");
    },
  } as unknown as AsyncJobsContext;
  // Create the table now (BASE_DDL carries host_version) so seedRow
  // can set it before the recovery runs.
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

function rowStatus(db: DatabaseSync, jobId: string): { status: string; error: string | null } {
  return db.prepare(
    "SELECT status, error FROM mas_async_jobs WHERE job_id = ?",
  ).get(jobId) as { status: string; error: string | null };
}

function allRows(db: DatabaseSync): Array<{ job_id: string; status: string }> {
  return db.prepare("SELECT job_id, status FROM mas_async_jobs").all() as Array<{
    job_id: string;
    status: string;
  }>;
}

const feedRunPayload = () =>
  JSON.stringify({
    method: "POST",
    pathAndQuery: "/data-providers/yahoo/feed-run",
    headers: {},
    body: "{}",
  });

describe("stillborn orphan on an unchanged version is not re-armed (#6167)", () => {
  it("a stillborn feed row on the SAME version is failed, named, and NOT re-armed", async () => {
    const h = makeHarness();
    const startedAt = isoAgo(20 * MIN);
    // Stillborn: last activity 2s after the claim — never progressed.
    const lastActivityAt = new Date(Date.parse(startedAt) + 2000).toISOString();
    seedRow(h.db, {
      jobId: "job-stillborn-same",
      startedAt,
      lastActivityAt,
      capability: "http.request",
      payloadJson: feedRunPayload(),
      hostVersion: "v-1",
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
    expect(allRows(h.db)).toHaveLength(1);
    const row = rowStatus(h.db, "job-stillborn-same");
    expect(row.status).toBe("failed");
    expect(row.error).toContain("Orphaned by a host restart");
    expect(row.error).toContain("same-version restart");
    expect(row.error).toContain("Not re-armed");
    expect(h.audits.filter((a) => a.type === "async_job.retried")).toHaveLength(0);
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.errorCode).toBe("FAILURE_ASYNC_JOB_ORPHANED");
  });

  it("a stillborn feed row on a CHANGED version is still re-armed (a deploy killed it)", async () => {
    const h = makeHarness();
    const startedAt = isoAgo(20 * MIN);
    const lastActivityAt = new Date(Date.parse(startedAt) + 2000).toISOString();
    seedRow(h.db, {
      jobId: "job-stillborn-deploy",
      startedAt,
      lastActivityAt,
      capability: "http.request",
      payloadJson: feedRunPayload(),
      hostVersion: "v-0",
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });
    const rearmed = allRows(h.db).filter((r) => r.job_id !== "job-stillborn-deploy");
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0].status).toBe("queued");
    const row = rowStatus(h.db, "job-stillborn-deploy");
    expect(row.error).toContain("deploy restart");
    expect(row.error).toContain("v-0");
    expect(row.error).toContain("v-1");
  });

  it("a PROGRESSED feed row on the same version is still re-armed", async () => {
    const h = makeHarness();
    seedRow(h.db, {
      jobId: "job-progressed-same",
      startedAt: isoAgo(23 * MIN),
      lastActivityAt: isoAgo(10 * MIN),
      capability: "http.request",
      payloadJson: feedRunPayload(),
      hostVersion: "v-1",
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });
    expect(allRows(h.db).filter((r) => r.job_id !== "job-progressed-same")).toHaveLength(1);
  });

  it("a stillborn feed row with an UNKNOWN claim version is NOT re-armed (#6216: no deploy evidenced)", async () => {
    const h = makeHarness();
    const startedAt = isoAgo(20 * MIN);
    const lastActivityAt = new Date(Date.parse(startedAt) + 2000).toISOString();
    seedRow(h.db, {
      jobId: "job-stillborn-unknown",
      startedAt,
      lastActivityAt,
      capability: "http.request",
      payloadJson: feedRunPayload(),
      hostVersion: null,
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
    const row = rowStatus(h.db, "job-stillborn-unknown");
    expect(row.status).toBe("failed");
    expect(row.error).toContain("restart cause not reported");
    expect(row.error).toContain("Not re-armed");
    expect(row.error).not.toContain("same-version restart");
    expect(row.error).not.toContain("deploy restart");
  });

  it("the claim stamps the host version on the row", () => {
    const h = makeHarness();
    h.ctx.ensureTables();
    const ports = createPorts(h.sql as never);
    const now = new Date().toISOString();
    ports.queue.insertQueued({
      jobId: "job-claim-stamp",
      sessionId: "owner-login-1",
      capability: "http.request",
      displayName: "Claim stamp",
      payloadJson: feedRunPayload(),
      nowIso: now,
    });
    const claimed = ports.queue.claim("job-claim-stamp", "owner-login-1", now, "v-9");
    expect(claimed).toBe(true);
    const row = ports.read.getRow("job-claim-stamp", "owner-login-1");
    expect(row?.host_version).toBe("v-9");
  });
});
