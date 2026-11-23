// @vitest-environment node
/**
 * Issue #6216 — [#6167 follow-up] the stillborn gate never fires in
 * production: host_version is always NULL because CF_VERSION_METADATA
 * is unavailable in the Durable Object.
 *
 * RCA (verified in code on main `52167f898`, live proof 2026-11-23
 * 04:03 EST): the #6167 fix wired `shouldRearmOrphanedRow` into both
 * reap paths and the claim stamps `host_version`, but the version
 * source — `CF_VERSION_METADATA.id` (`hostVersionFromEnv`) — is NOT
 * available in the OrchestratorAgent DO execution context where jobs
 * are claimed and reaped. Both sides read null, so `host_version` is
 * always NULL, `restartClassFor` always returns "unknown", and the
 * gate (which refused only on "same-version" + stillborn) never
 * refused. A Yahoo feed job orphaned and reaped by the sweep had no
 * restart class and its stillborn orphan (died 0.21s after claim)
 * was re-armed.
 *
 * This file pins the #6216 fix:
 * - the host version is the deploy-time git SHA (`CF_DEPLOY_VERSION`,
 *   injected by the deploy workflow into wrangler.jsonc vars — a
 *   plain var, so it IS visible in the DO env), preferred over
 *   `CF_VERSION_METADATA.id`, which stays as the fallback for
 *   contexts where the deploy var was never injected. The deploy var
 *   must be a full 40-hex git SHA: a non-SHA value (the wrangler.jsonc
 *   placeholder, a failed injection) is rejected, never a version —
 *   a constant placeholder would stamp the same fake version on
 *   every claim and misread every reap as "same-version".
 * - the stillborn gate now refuses a re-arm whenever the orphan is
 *   stillborn and the restart class is NOT "deploy": a stillborn
 *   orphan is re-armed ONLY on positive evidence of a deploy (the
 *   version changed). On "same-version" (unchanged) and on "unknown"
 *   (either side reported no version) it is failed visibly with the
 *   reason named. The live evidence (three feed re-arms on 2026-11-22
 *   plus the 2026-11-23 one, all dead in seconds) argues for refusing
 *   on unknown: the dispatch died on arrival, and an identical
 *   re-arm replays the identical dispatch. A progressed orphan is
 *   still re-armed on any class, and a stillborn orphan on a changed
 *   version is still re-armed (a deploy killed it — the #3907/#4002
 *   case).
 *
 * Harness mirrors tests/async_job_orphan_stillborn_6167.test.ts:
 * real node:sqlite behind the family's ports, rows seeded at
 * controlled ages. The test DDL carries host_version (the
 * production ensureSchema adds it via remainder-alter).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  createAsyncJobPorts,
  ensureAsyncJobGraphColumns,
  hostVersionFromEnv,
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

/** Two distinct deploy SHAs (full 40-hex), standing in for two deploys. */
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

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
      throw new Error("no orm in 6216 harness");
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

describe("hostVersionFromEnv prefers the deploy SHA (#6216)", () => {
  it("prefers CF_DEPLOY_VERSION over CF_VERSION_METADATA.id when both are set", () => {
    expect(
      hostVersionFromEnv({ CF_DEPLOY_VERSION: SHA_A, CF_VERSION_METADATA: { id: "v-1" } }),
    ).toBe(SHA_A);
  });

  it("returns CF_VERSION_METADATA.id when the deploy var is absent", () => {
    expect(hostVersionFromEnv({ CF_VERSION_METADATA: { id: "v-1" } })).toBe("v-1");
  });

  it("returns null when neither source is set", () => {
    expect(hostVersionFromEnv({})).toBeNull();
    expect(hostVersionFromEnv(undefined)).toBeNull();
  });

  it("rejects a non-SHA deploy var (the wrangler.jsonc placeholder) and falls back", () => {
    expect(
      hostVersionFromEnv({
        CF_DEPLOY_VERSION: "<DEPLOY_VERSION>",
        CF_VERSION_METADATA: { id: "v-1" },
      }),
    ).toBe("v-1");
  });

  it("rejects a short SHA deploy var and falls back", () => {
    expect(
      hostVersionFromEnv({
        CF_DEPLOY_VERSION: "abc1234",
        CF_VERSION_METADATA: { id: "v-1" },
      }),
    ).toBe("v-1");
  });

  it("returns null when the deploy var is a placeholder and no fallback exists", () => {
    expect(hostVersionFromEnv({ CF_DEPLOY_VERSION: "<DEPLOY_VERSION>" })).toBeNull();
  });
});

describe("stillborn orphan on an unknown version is not re-armed (#6216)", () => {
  it("a stillborn feed row with NO version on either side is failed, named, and NOT re-armed", async () => {
    const h = makeHarness({});
    const startedAt = isoAgo(20 * MIN);
    const lastActivityAt = new Date(Date.parse(startedAt) + 2000).toISOString();
    seedRow(h.db, {
      jobId: "job-stillborn-unknown-both",
      startedAt,
      lastActivityAt,
      capability: "http.request",
      payloadJson: feedRunPayload(),
      hostVersion: null,
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
    expect(allRows(h.db)).toHaveLength(1);
    const row = rowStatus(h.db, "job-stillborn-unknown-both");
    expect(row.status).toBe("failed");
    expect(row.error).toContain("Orphaned by a host restart");
    expect(row.error).toContain("restart cause not reported");
    expect(row.error).toContain("Not re-armed");
    expect(h.audits.filter((a) => a.type === "async_job.retried")).toHaveLength(0);
    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.errorCode).toBe("FAILURE_ASYNC_JOB_ORPHANED");
    expect(failed[0].payload.restartClass).toBe("unknown");
    expect(failed[0].payload.notRearmedReason).toContain("unknown");
  });

  it("a stillborn feed row with a KNOWN claim version and an UNKNOWN reap version is NOT re-armed", async () => {
    const h = makeHarness({});
    const startedAt = isoAgo(20 * MIN);
    const lastActivityAt = new Date(Date.parse(startedAt) + 2000).toISOString();
    seedRow(h.db, {
      jobId: "job-stillborn-claim-known",
      startedAt,
      lastActivityAt,
      capability: "http.request",
      payloadJson: feedRunPayload(),
      hostVersion: SHA_A,
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
    const row = rowStatus(h.db, "job-stillborn-claim-known");
    expect(row.status).toBe("failed");
    expect(row.error).toContain("Not re-armed");
  });

  it("a stillborn feed row with an UNKNOWN claim version and a KNOWN reap version is NOT re-armed", async () => {
    const h = makeHarness({ CF_DEPLOY_VERSION: SHA_B });
    const startedAt = isoAgo(20 * MIN);
    const lastActivityAt = new Date(Date.parse(startedAt) + 2000).toISOString();
    seedRow(h.db, {
      jobId: "job-stillborn-reap-known",
      startedAt,
      lastActivityAt,
      capability: "http.request",
      payloadJson: feedRunPayload(),
      hostVersion: null,
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
    const row = rowStatus(h.db, "job-stillborn-reap-known");
    expect(row.status).toBe("failed");
    expect(row.error).toContain("Not re-armed");
  });

  it("a stillborn feed row on the SAME deploy SHA is NOT re-armed and names same-version", async () => {
    const h = makeHarness({ CF_DEPLOY_VERSION: SHA_A });
    const startedAt = isoAgo(20 * MIN);
    const lastActivityAt = new Date(Date.parse(startedAt) + 2000).toISOString();
    seedRow(h.db, {
      jobId: "job-stillborn-same-sha",
      startedAt,
      lastActivityAt,
      capability: "http.request",
      payloadJson: feedRunPayload(),
      hostVersion: SHA_A,
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 0 });
    const row = rowStatus(h.db, "job-stillborn-same-sha");
    expect(row.status).toBe("failed");
    expect(row.error).toContain("same-version restart");
    expect(row.error).toContain("Not re-armed");
  });

  it("a stillborn feed row on a CHANGED deploy SHA is still re-armed (a deploy killed it)", async () => {
    const h = makeHarness({ CF_DEPLOY_VERSION: SHA_B });
    const startedAt = isoAgo(20 * MIN);
    const lastActivityAt = new Date(Date.parse(startedAt) + 2000).toISOString();
    seedRow(h.db, {
      jobId: "job-stillborn-changed-sha",
      startedAt,
      lastActivityAt,
      capability: "http.request",
      payloadJson: feedRunPayload(),
      hostVersion: SHA_A,
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });
    const rearmed = allRows(h.db).filter((r) => r.job_id !== "job-stillborn-changed-sha");
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0].status).toBe("queued");
    const row = rowStatus(h.db, "job-stillborn-changed-sha");
    expect(row.error).toContain("deploy restart");
    expect(row.error).toContain(SHA_A);
    expect(row.error).toContain(SHA_B);
  });

  it("a PROGRESSED feed row with an unknown version is still re-armed (the gate is stillborn-only)", async () => {
    const h = makeHarness({});
    seedRow(h.db, {
      jobId: "job-progressed-unknown",
      startedAt: isoAgo(23 * MIN),
      lastActivityAt: isoAgo(10 * MIN),
      capability: "http.request",
      payloadJson: feedRunPayload(),
      hostVersion: null,
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });
    expect(allRows(h.db).filter((r) => r.job_id !== "job-progressed-unknown")).toHaveLength(1);
  });

  it("a row whose last activity predates its start by minutes is NOT stillborn (temporally inconsistent, not died-on-arrival)", async () => {
    const h = makeHarness({});
    // The #4002 recovery seeds carry this shape (last activity
    // minutes before the start stamp): the old one-sided check
    // (`diff <= bound`) misread it as stillborn, and the #6216
    // gate would have refused the re-arm. The stillborn window
    // is symmetric — only within 10s of the claim, either side.
    seedRow(h.db, {
      jobId: "job-inconsistent-stamps",
      startedAt: isoAgo(20 * MIN),
      lastActivityAt: isoAgo(30 * MIN),
      capability: "http.request",
      payloadJson: feedRunPayload(),
      hostVersion: null,
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 1, failed: 1, rearmed: 1 });
    expect(allRows(h.db).filter((r) => r.job_id !== "job-inconsistent-stamps")).toHaveLength(1);
  });

  it("the claim stamps the deploy SHA on the row (the resolver's value reaches the port)", () => {
    const h = makeHarness({ CF_DEPLOY_VERSION: SHA_A });
    h.ctx.ensureTables();
    const ports = createPorts(h.sql as never);
    const now = new Date().toISOString();
    ports.queue.insertQueued({
      jobId: "job-claim-stamp-sha",
      sessionId: "owner-login-1",
      capability: "http.request",
      displayName: "Claim stamp SHA",
      payloadJson: feedRunPayload(),
      nowIso: now,
    });
    const claimed = ports.queue.claim(
      "job-claim-stamp-sha",
      "owner-login-1",
      now,
      hostVersionFromEnv(h.ctx.env),
    );
    expect(claimed).toBe(true);
    const row = ports.read.getRow("job-claim-stamp-sha", "owner-login-1");
    expect(row?.host_version).toBe(SHA_A);
  });
});
