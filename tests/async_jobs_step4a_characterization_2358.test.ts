// @vitest-environment node
/**
 * #2358 (#1976 step 4a) — async-job family CHARACTERIZATION.
 *
 * Written against the UNMODIFIED implementation (the legacy
 * modules src/agents/orchestrator/asyncJobs.ts, src/services/
 * asyncJobGate.ts, src/services/shardJobs.ts, src/agents/
 * routes/workflowRuns.ts and src/agents/routes/maintenance.ts,
 * before any of them served through the ports) and passing
 * pre-cutover; the same file must pass post-cutover unchanged,
 * which is what proves the port move changed no behaviour.
 *
 * Pins: the submit/claim/complete/fail lifecycle incl. the
 * guarded claim (a second claim is an honest no-op), the
 * stale-running reap INSIDE the read path, retention pruning at
 * submit (30d + 500-per-session cap), retry's duplicate guard,
 * the screener-run bridge row, the gate's active-payload scan,
 * the chain-rows reader, the chain-executor overlay, the
 * workflow-runs job read, and the maintenance clears (running
 * jobs never deleted; the mas_job_outcomes_meta watermark
 * preserved).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  ensureAsyncJobGraphColumns,
  executeAsyncJob,
  getAsyncJob,
  listAsyncJobs,
  recordScreenerRunMainJob,
  recoverQueuedAsyncJobs,
  retryAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import {
  ACTIVE_JOB_PAYLOADS_SQL,
  ensureAsyncJobGateIndexes,
  hasActiveChain,
} from "../src/services/asyncJobGate";
import { chainRowsFromSql } from "../src/services/shardJobs";
import { readWorkflowRunJobs } from "../src/agents/routes/workflowRuns";
import { handleMaintenanceRoutes } from "../src/agents/routes/maintenance";
import { createChainLegExecutor } from "../src/agentic/chainExecutor";

/** SqlStorage-shaped executor over node:sqlite (real semantics,
 *  rowsWritten surfaced like the DO cursor). */
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

interface Harness {
  db: DatabaseSync;
  sql: ReturnType<typeof makeSql>;
  ctx: AsyncJobsContext;
  scheduled: Array<{ delay: unknown; callback: string; payload: unknown }>;
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
}

function makeHarness(session = "sess-1"): Harness {
  const db = new DatabaseSync(":memory:");
  const sql = makeSql(db);
  const scheduled: Harness["scheduled"] = [];
  const audits: Harness["audits"] = [];
  const ctx = {
    env: {},
    agentCtx: { storage: { sql } },
    ensureTables: () => {
      sql.exec(BASE_DDL);
      ensureAsyncJobGateIndexes(sql as never);
      ensureAsyncJobGraphColumns(sql as never);
      return sql;
    },
    sessionKey: () => session,
    schedule: async (when: unknown, callback: string, payload?: unknown) => {
      scheduled.push({ delay: when, callback, payload });
      return {};
    },
    audit: (type: string, _agent: unknown, payload: Record<string, unknown>) => {
      audits.push({ type, payload });
    },
    getOrm: () => {
      throw new Error("no orm in characterization harness");
    },
    routeRequest: async () => new Response("{}"),
    nlqSchedulingPort: () => {
      throw new Error("unused");
    },
    nlqStockScreenPort: () => {
      throw new Error("unused");
    },
  } as unknown as AsyncJobsContext;
  return { db, sql, ctx, scheduled, audits };
}

function seedJob(
  db: DatabaseSync,
  row: {
    jobId: string;
    session?: string;
    status: string;
    capability?: string;
    payload?: unknown;
    result?: string | null;
    createdAt?: string;
    startedAt?: string | null;
    chainId?: string | null;
    stage?: string | null;
  },
): void {
  // Seeds write graph columns, so the graph migration must have
  // run — exactly as production ensureTables runs it on every call.
  ensureAsyncJobGraphColumns(makeSql(db) as never);
  db.prepare(
    "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, result_json, created_at, updated_at, started_at, stage, chain_id) VALUES (?, ?, ?, 'seeded', ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.jobId,
    row.session ?? "sess-1",
    row.capability ?? "task.draft",
    row.status,
    JSON.stringify(row.payload ?? { title: "seed" }),
    row.result ?? null,
    row.createdAt ?? "2026-10-29T00:00:00.000Z",
    row.createdAt ?? "2026-10-29T00:00:00.000Z",
    row.startedAt ?? null,
    row.stage ?? null,
    row.chainId ?? null,
  );
}

function rawJob(db: DatabaseSync, jobId: string): Record<string, unknown> | undefined {
  return db
    .prepare("SELECT * FROM mas_async_jobs WHERE job_id = ?")
    .get(jobId) as Record<string, unknown> | undefined;
}

describe("characterization 4a: submit", () => {
  it("inserts a queued row with graph defaults, arms immediately, audits queued", async () => {
    const h = makeHarness();
    const out = await submitAsyncJob(h.ctx, {
      capability: "task.draft",
      payload: { title: "Hello" },
    });
    expect(out.status).toBe("queued");
    expect(out.statusUrl).toBe(`/api/jobs/${out.jobId}`);
    const row = rawJob(h.db, out.jobId)!;
    expect(row.status).toBe("queued");
    expect(row.session_id).toBe("sess-1");
    expect(row.display_name).toBe("Task: Hello");
    expect(row.job_kind).toBe("main");
    expect(row.parent_job_id).toBeNull();
    expect(h.scheduled).toEqual([
      {
        delay: 0,
        callback: "executeAsyncJob",
        payload: {
          jobId: out.jobId,
          // Issue #3121 S1 — provenance travels in the arm payload
          // (origin system / async-job-arm); createdAt is minted at
          // submit time, so it is pinned by shape, not by value.
          provenance: expect.objectContaining({
            origin: "system",
            createdBy: "system",
            reason: "async-job-arm",
            createdAt: expect.any(String),
          }),
        },
      },
    ]);
    expect(h.audits).toEqual([
      { type: "async_job.queued", payload: { jobId: out.jobId, capability: "task.draft" } },
    ]);
  });

  it("rejects a payload over the 17 MB limit and inserts nothing", async () => {
    const h = makeHarness();
    await expect(
      submitAsyncJob(h.ctx, {
        capability: "task.draft",
        payload: { blob: "x".repeat(17_000_001) },
      } as never),
    ).rejects.toThrow(/17 MB/);
    const n = (h.db.prepare("SELECT COUNT(*) AS n FROM mas_async_jobs").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it("a schedule failure marks the row failed and rethrows", async () => {
    const h = makeHarness();
    (h.ctx as { schedule: unknown }).schedule = async () => {
      throw new Error("alarm down");
    };
    await expect(
      submitAsyncJob(h.ctx, { capability: "task.draft", payload: { title: "t" } }),
    ).rejects.toThrow("alarm down");
    const rows = h.db.prepare("SELECT status, error FROM mas_async_jobs").all() as Array<{
      status: string;
      error: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toContain("Could not schedule async work: alarm down");
  });

  it("prunes terminal rows older than 30 days at submit; queued and fresh rows survive", async () => {
    const h = makeHarness();
    h.sql.exec(BASE_DDL);
    seedJob(h.db, { jobId: "old-terminal", status: "completed", createdAt: "2026-08-01T00:00:00.000Z" });
    seedJob(h.db, { jobId: "old-queued", status: "queued", createdAt: "2026-08-01T00:00:00.000Z" });
    seedJob(h.db, { jobId: "fresh-terminal", status: "failed", createdAt: new Date().toISOString() });
    await submitAsyncJob(h.ctx, { capability: "task.draft", payload: { title: "new" } });
    expect(rawJob(h.db, "old-terminal")).toBeUndefined();
    expect(rawJob(h.db, "old-queued")).toBeDefined();
    expect(rawJob(h.db, "fresh-terminal")).toBeDefined();
  });

  it("caps terminal rows at 500 per session at submit, dropping the oldest", async () => {
    const h = makeHarness();
    h.sql.exec(BASE_DDL);
    const insert = h.db.prepare(
      "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at) VALUES (?, 'sess-1', 'task.draft', 'seeded', 'completed', '{}', ?, ?)",
    );
    for (let i = 0; i < 505; i++) {
      const ts = new Date(Date.now() - (600 - i) * 1000).toISOString();
      insert.run(`cap-${String(i).padStart(3, "0")}`, ts, ts);
    }
    await submitAsyncJob(h.ctx, { capability: "task.draft", payload: { title: "new" } });
    const n = (
      h.db
        .prepare("SELECT COUNT(*) AS n FROM mas_async_jobs WHERE status = 'completed'")
        .get() as { n: number }
    ).n;
    expect(n).toBe(500);
    expect(rawJob(h.db, "cap-000")).toBeUndefined();
    expect(rawJob(h.db, "cap-504")).toBeDefined();
  });
});

describe("characterization 4a: claim / execute", () => {
  it("claims a queued job exactly once: the second claim is a no-op (guarded UPDATE)", async () => {
    const h = makeHarness();
    const out = await submitAsyncJob(h.ctx, {
      capability: "task.draft",
      payload: { title: "once" },
    });
    await Promise.all([
      executeAsyncJob(h.ctx, { jobId: out.jobId }),
      executeAsyncJob(h.ctx, { jobId: out.jobId }),
    ]);
    const rec = getAsyncJob(h.ctx, out.jobId)!;
    expect(rec.status).toBe("completed");
    expect((rec.result as { status?: string }).status).toBe("draft");
    expect(h.audits.filter((a) => a.type === "async_job.completed")).toHaveLength(1);
    const completedAt = rec.completedAt;
    await executeAsyncJob(h.ctx, { jobId: out.jobId });
    expect(getAsyncJob(h.ctx, out.jobId)?.completedAt).toBe(completedAt);
  });

  it("refuses to claim a deferred job early: re-arms for the remainder", async () => {
    const h = makeHarness();
    const runAt = new Date(Date.now() + 3600_000).toISOString();
    const out = await submitAsyncJob(h.ctx, {
      capability: "task.draft",
      payload: { title: "later" },
      runAt,
    });
    h.scheduled.length = 0;
    await executeAsyncJob(h.ctx, { jobId: out.jobId });
    expect(rawJob(h.db, out.jobId)?.status).toBe("queued");
    expect(h.scheduled).toHaveLength(1);
    expect(Number(h.scheduled[0].delay)).toBeGreaterThan(3500);
  });

  it("an unsupported capability fails the job with the error recorded", async () => {
    const h = makeHarness();
    const out = await submitAsyncJob(h.ctx, {
      capability: "bogus.capability",
      payload: {},
    } as never);
    await executeAsyncJob(h.ctx, { jobId: out.jobId });
    const rec = getAsyncJob(h.ctx, out.jobId)!;
    expect(rec.status).toBe("failed");
    expect(rec.error).toContain("Unsupported async capability: bogus.capability");
  });

  it("executing a missing job is a silent no-op", async () => {
    const h = makeHarness();
    h.sql.exec(BASE_DDL);
    await expect(executeAsyncJob(h.ctx, { jobId: "nope" })).resolves.toBeUndefined();
  });
});

describe("characterization 4a: reads and the reap-inside-a-read", () => {
  it("get is session-scoped; list is newest-first with the limit clamped to >= 1", async () => {
    const h = makeHarness();
    h.sql.exec(BASE_DDL);
    seedJob(h.db, { jobId: "a", status: "completed", createdAt: "2026-10-29T01:00:00.000Z" });
    seedJob(h.db, { jobId: "b", status: "queued", createdAt: "2026-10-29T02:00:00.000Z" });
    seedJob(h.db, { jobId: "other", session: "sess-2", status: "queued" });
    expect(getAsyncJob(h.ctx, "other")).toBeUndefined();
    expect(listAsyncJobs(h.ctx).map((j) => j.jobId)).toEqual(["b", "a"]);
    expect(listAsyncJobs(h.ctx, 0)).toHaveLength(1);
  });

  it("reaps a stale running job inside getAsyncJob (a read that writes)", () => {
    const h = makeHarness();
    h.sql.exec(BASE_DDL);
    seedJob(h.db, {
      jobId: "stale",
      status: "running",
      startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    });
    seedJob(h.db, {
      jobId: "fresh",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const reaped = getAsyncJob(h.ctx, "stale")!;
    expect(reaped.status).toBe("failed");
    expect(reaped.error).toContain("Execution stopped before a result was recorded");
    expect(rawJob(h.db, "stale")?.status).toBe("failed");
    expect(getAsyncJob(h.ctx, "fresh")?.status).toBe("running");
  });

  it("get throws on a corrupt stored result, naming the job", () => {
    const h = makeHarness();
    h.sql.exec(BASE_DDL);
    seedJob(h.db, { jobId: "corrupt", status: "completed", result: "{not json" });
    expect(() => getAsyncJob(h.ctx, "corrupt")).toThrow(/invalid JSON/);
  });

  it("recover re-arms queued jobs only, honouring not_before delays", async () => {
    const h = makeHarness();
    h.sql.exec(BASE_DDL);
    seedJob(h.db, { jobId: "q1", status: "queued" });
    seedJob(h.db, { jobId: "r1", status: "running" });
    h.db
      .prepare("UPDATE mas_async_jobs SET not_before = ? WHERE job_id = 'q1'")
      .run(new Date(Date.now() + 600_000).toISOString());
    await recoverQueuedAsyncJobs(h.ctx);
    expect(h.scheduled).toHaveLength(1);
    // Issue #3121 S1 — a recovery re-arm carries origin system /
    // recovery in its payload; createdAt is minted at re-arm time.
    expect(h.scheduled[0].payload).toEqual({
      jobId: "q1",
      provenance: expect.objectContaining({
        origin: "system",
        createdBy: "system",
        reason: "recovery",
        createdAt: expect.any(String),
      }),
    });
    expect(Number(h.scheduled[0].delay)).toBeGreaterThan(500);
  });
});

describe("characterization 4a: retry", () => {
  it("resubmits a failed job with retryOf and its graph identity; the failed row stays failed", async () => {
    const h = makeHarness();
    const out = await submitAsyncJob(h.ctx, {
      capability: "task.draft",
      payload: { title: "retry me" },
      jobKind: "report",
      stage: "serve",
      chainId: "chain-9",
    });
    h.db
      .prepare("UPDATE mas_async_jobs SET status = 'failed', error = 'boom' WHERE job_id = ?")
      .run(out.jobId);
    const retried = await retryAsyncJob(h.ctx, out.jobId);
    expect(retried.status).toBe("queued");
    const row = rawJob(h.db, retried.jobId)!;
    expect(JSON.parse(String(row.payload_json)).retryOf).toBe(out.jobId);
    expect(row.stage).toBe("serve");
    expect(row.chain_id).toBe("chain-9");
    expect(rawJob(h.db, out.jobId)?.status).toBe("failed");
    await expect(retryAsyncJob(h.ctx, out.jobId)).rejects.toThrow(/already retried/);
  });

  it("refuses to retry a non-failed or missing job", async () => {
    const h = makeHarness();
    const out = await submitAsyncJob(h.ctx, {
      capability: "task.draft",
      payload: { title: "queued" },
    });
    await expect(retryAsyncJob(h.ctx, out.jobId)).rejects.toThrow(/Only a failed job/);
    await expect(retryAsyncJob(h.ctx, "missing")).rejects.toThrow(/was not found/);
  });
});

describe("characterization 4a: screener-run bridge", () => {
  it("records a terminal main-job row and a job-outcome for a finished run", async () => {
    const h = makeHarness();
    const jobId = await recordScreenerRunMainJob(
      h.ctx,
      {
        kind: "stock",
        trigger: "manual",
        success: true,
        matchedCount: 3,
        totalScanned: 50,
        pdfKeys: [],
      } as never,
      "alice",
      { chainReport: false },
    );
    const row = rawJob(h.db, jobId)!;
    expect(row.capability).toBe("screener.run");
    expect(row.status).toBe("completed");
    expect(row.job_kind).toBe("main");
    const outcomes = h.db.prepare("SELECT id, status, origin FROM mas_job_outcomes").all() as Array<{
      id: string;
      status: string;
      origin: string;
    }>;
    expect(outcomes).toEqual([{ id: jobId, status: "completed", origin: "job-tree" }]);
    expect(h.audits.some((a) => a.type === "screener.run_bridged")).toBe(true);
  });
});

describe("characterization 4a: gate, chain rows, workflow read, overlay", () => {
  it("the gate scan returns only queued/running payloads and matches chains exactly", () => {
    const h = makeHarness();
    h.sql.exec(BASE_DDL);
    ensureAsyncJobGateIndexes(h.sql as never);
    seedJob(h.db, {
      jobId: "g1",
      status: "queued",
      payload: { chain: { userLogin: "alice", universe: "NASDAQ100" } },
    });
    seedJob(h.db, { jobId: "g2", status: "completed", payload: { chain: { userLogin: "alice", universe: "NASDAQ100" } } });
    seedJob(h.db, { jobId: "g3", status: "running", payload: { chain: { userLogin: "bob", universe: "SP100" } } });
    const rows = Array.from(h.sql.exec(ACTIVE_JOB_PAYLOADS_SQL)) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(hasActiveChain(rows, "alice", "NASDAQ100")).toBe(true);
    expect(hasActiveChain(rows, "alice", "SP100")).toBe(false);
    expect(hasActiveChain(rows, "carol", "NASDAQ100")).toBe(false);
  });

  it("chainRowsFromSql projects a chain's rows, tolerating corrupt JSON", () => {
    const h = makeHarness();
    h.sql.exec(BASE_DDL);
    seedJob(h.db, {
      jobId: "c1",
      status: "completed",
      stage: "feed",
      chainId: "chain-1",
      createdAt: "2026-10-29T01:00:00.000Z",
      payload: { shard: { stage: "feed", key: "nasdaq" } },
      result: JSON.stringify({ listings: 3 }),
    });
    seedJob(h.db, {
      jobId: "c2",
      status: "failed",
      stage: "feed",
      chainId: "chain-1",
      createdAt: "2026-10-29T02:00:00.000Z",
      payload: "{broken",
      result: "{broken",
    });
    seedJob(h.db, { jobId: "c3", status: "queued", chainId: "chain-2" });
    const rows = chainRowsFromSql(h.sql as never, "chain-1", "sess-1");
    expect(rows.map((r) => r.jobId)).toEqual(["c1", "c2"]);
    expect(rows[0].shardKey).toBe("nasdaq");
    expect(rows[0].result).toEqual({ listings: 3 });
    expect(rows[1].shardKey).toBeUndefined();
    expect(rows[1].result).toBeUndefined();
  });

  it("readWorkflowRunJobs returns the full-row projection, session-scoped", () => {
    const h = makeHarness();
    h.sql.exec(BASE_DDL);
    seedJob(h.db, { jobId: "w1", status: "completed", stage: "generate", chainId: "chain-1" });
    seedJob(h.db, { jobId: "w2", session: "sess-2", status: "queued" });
    const rows = readWorkflowRunJobs(h.sql as never, "sess-1", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].job_id).toBe("w1");
    expect(rows[0].status).toBe("completed");
    expect(rows[0].stage).toBe("generate");
    expect(rows[0].chain_id).toBe("chain-1");
  });

  it("the chain-executor overlay composes in-memory siblings over the base read", async () => {
    const baseSql = {
      exec: (_query: string, ..._params: unknown[]) => [] as Record<string, unknown>[],
    };
    const seenSiblingCounts: number[] = [];
    const runner = async (deps: { sql: unknown }, payload: { shard: { stage: string; key: string } }) => {
      const rows = chainRowsFromSql(deps.sql as never, "chain-ov", "sess-1");
      seenSiblingCounts.push(rows.length);
      return { ok: payload.shard.key };
    };
    const executeLeg = createChainLegExecutor(
      {
        sql: baseSql as never,
        env: {},
        orm: {},
        storage: {},
        createETradeService: () => ({}) as never,
        sessionId: "sess-1",
      },
      { chainId: "chain-ov", userLogin: "alice", universe: "NASDAQ100" },
      { shardRunner: runner as never },
    );
    const out = await executeLeg({ capabilityId: "feed-dataprovider", stage: "feed" } as never);
    // First shard sees no siblings; later shards see the earlier
    // in-memory completions through the overlay — with NO durable rows.
    expect(seenSiblingCounts).toEqual([0, 1, 2]);
    expect((out as { shardJobIds: string[] }).shardJobIds).toHaveLength(3);
  });
});

describe("characterization 4a: maintenance clears", () => {
  function maintenanceHarness() {
    const db = new DatabaseSync(":memory:");
    const sql = makeSql(db);
    db.exec(BASE_DDL);
    db.exec(
      "CREATE TABLE mas_job_outcomes (id TEXT PRIMARY KEY, kind TEXT, trigger TEXT, status TEXT, scanned INTEGER, matched INTEGER, coded_error TEXT, report_url TEXT, pdf_key TEXT, xlsx_key TEXT, csv_key TEXT, delivery_json TEXT, origin TEXT, created_at TEXT)",
    );
    db.exec("CREATE TABLE mas_job_outcomes_meta (k TEXT PRIMARY KEY, v TEXT)");
    db.exec(
      "CREATE TABLE paused_schedules (id TEXT PRIMARY KEY, callback TEXT NOT NULL, payload_json TEXT, sched_type TEXT NOT NULL, cron TEXT, interval_seconds INTEGER, time INTEGER, delay_seconds INTEGER, paused_at TEXT NOT NULL)",
    );
    seedJob(db, { jobId: "m1", status: "queued" });
    seedJob(db, { jobId: "m2", status: "running" });
    seedJob(db, { jobId: "m3", status: "completed" });
    seedJob(db, { jobId: "m4", session: "sess-2", status: "queued" });
    db.prepare("INSERT INTO mas_job_outcomes (id, kind, trigger, status, created_at) VALUES ('o1', 'stock', 'manual', 'completed', '2026-10-29')").run();
    db.prepare("INSERT INTO mas_job_outcomes_meta (k, v) VALUES ('pruned_at', '2026-10-29T00:00:00.000Z')").run();
    const audit = vi.fn();
    const ctx = {
      agentCtx: { storage: { sql } },
      audit,
    } as never;
    return { db, ctx, audit };
  }

  async function postClear(ctx: never, sessionId: string, body: Record<string, unknown>) {
    const req = new Request("https://agent.test/api/maintenance/clear-table", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await handleMaintenanceRoutes(
      req,
      new URL("https://agent.test/api/maintenance/clear-table"),
      "/api/maintenance/clear-table",
      sessionId,
      ctx,
    );
    return { status: res!.status, body: (await res!.json()) as Record<string, unknown> };
  }

  it("preview counts the caller's non-running jobs; confirm deletes them, running survives", async () => {
    const { db, ctx, audit } = maintenanceHarness();
    const preview = await postClear(ctx, "sess-1", { table: "mas_async_jobs" });
    expect(preview.body.wouldDelete).toBe(2);
    expect(preview.body.skippedRunning).toBe(1);
    expect(preview.body.breakdown).toEqual({ queued: 1, running: 1, completed: 1 });
    expect(audit).not.toHaveBeenCalled();
    const done = await postClear(ctx, "sess-1", { table: "mas_async_jobs", confirm: true });
    expect(done.body.deleted).toBe(2);
    const left = db.prepare("SELECT job_id FROM mas_async_jobs ORDER BY job_id").all() as Array<{ job_id: string }>;
    expect(left.map((r) => r.job_id)).toEqual(["m2", "m4"]);
  });

  it("status-filtered clear deletes only the requested non-running statuses", async () => {
    const { db, ctx } = maintenanceHarness();
    const done = await postClear(ctx, "sess-1", {
      table: "mas_async_jobs",
      confirm: true,
      statuses: ["queued", "running"],
    });
    expect(done.body.deleted).toBe(1);
    expect(rawJob(db, "m1")).toBeUndefined();
    expect(rawJob(db, "m2")).toBeDefined();
    expect(rawJob(db, "m3")).toBeDefined();
  });

  it("the job-outcomes clear preserves the pruned_at watermark exactly", async () => {
    const { db, ctx } = maintenanceHarness();
    const done = await postClear(ctx, "sess-1", { table: "mas_job_outcomes", confirm: true });
    expect(done.body.deleted).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM mas_job_outcomes").get() as { n: number }).n).toBe(0);
    const meta = db.prepare("SELECT v FROM mas_job_outcomes_meta WHERE k = 'pruned_at'").get() as { v: string };
    expect(meta.v).toBe("2026-10-29T00:00:00.000Z");
  });

  it("a missing table previews as zero and confirms without error", async () => {
    const db = new DatabaseSync(":memory:");
    const sql = makeSql(db);
    const ctx = { agentCtx: { storage: { sql } }, audit: vi.fn() } as never;
    const preview = await postClear(ctx, "sess-1", { table: "mas_async_jobs" });
    expect(preview.status).toBe(200);
    expect(preview.body.wouldDelete).toBe(0);
    const done = await postClear(ctx, "sess-1", { table: "mas_async_jobs", confirm: true });
    expect(done.status).toBe(200);
    expect(done.body.deleted).toBe(0);
  });
});
