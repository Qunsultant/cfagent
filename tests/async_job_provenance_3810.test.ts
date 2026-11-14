// @vitest-environment node
/**
 * Issue #3810 — provenance stamped at submission onto the
 * mas_async_jobs row (trigger / triggered_by / schedule_id).
 *
 * Pins (submit path, node:sqlite harness — same shape as the
 * #2358 characterization harness):
 *  - an explicit trigger/triggeredBy/scheduleId on the submission
 *    lands on the row;
 *  - a follow-up payload's ledgerLinkage is the fallback source
 *    (scheduled / worker-cron map; async-chain maps to NULL —
 *    the chain step inherits its trigger from the chain, never
 *    from a guessed value);
 *  - no provenance anywhere leaves the columns NULL (honest);
 *  - a retry keeps the source row's provenance;
 *  - the probed migration adds the columns to a legacy table.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  ensureAsyncJobGraphColumns,
  getAsyncJob,
  retryAsyncJob,
  retryFailedChainJobs,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { readWorkflowRunJobs } from "../src/agents/routes/workflowRuns";
import { ensureAsyncJobGateIndexes } from "../src/services/asyncJobGate";
import type { AsyncJobSubmission } from "../src/types";

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

function makeHarness(session = "sess-3810") {
  const db = new DatabaseSync(":memory:");
  const sql = makeSql(db);
  const scheduled: Array<{ delay: unknown; callback: string; payload: unknown }> = [];
  const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
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
      throw new Error("no orm in provenance harness");
    },
    routeRequest: async () => new Response("{}"),
    nlqSchedulingPort: () => {
      throw new Error("unused");
    },
    nlqStockScreenPort: () => {
      throw new Error("unused");
    },
    followupReportPort: () => ({
      getStockPdf: async () => null,
      getOptionsPdf: async () => null,
    }),
    followupDeliveryPort: () => ({
      deliver: async () => ({ ok: true }),
      notify: async () => ({ ok: true }),
    }),
  } as unknown as AsyncJobsContext;
  return { db, sql, ctx };
}

function mcpJob(overrides: Partial<AsyncJobSubmission> = {}): AsyncJobSubmission {
  return {
    capability: "mcp.tool",
    payload: { toolName: "run_pipeline_chain", arguments: {} },
    ...overrides,
  } as AsyncJobSubmission;
}

describe("async-job provenance stamping (#3810)", () => {
  it("stamps an explicit trigger + actor + schedule on the row", async () => {
    const { ctx } = makeHarness();
    const submitted = await submitAsyncJob(
      ctx,
      mcpJob({ trigger: "agent", triggeredBy: "spr9s", scheduleId: null }),
    );
    const record = getAsyncJob(ctx, submitted.jobId);
    expect(record).toBeDefined();
    expect(record!.trigger).toBe("agent");
    expect(record!.triggeredBy).toBe("spr9s");
    expect(record!.scheduleId).toBeNull();
    const rows = readWorkflowRunJobs(ctx.agentCtx.storage.sql as never, "sess-3810", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe("agent");
    expect(rows[0].triggered_by).toBe("spr9s");
    expect(rows[0].schedule_id).toBeNull();
  });

  it("falls back to the payload ledgerLinkage for follow-up jobs", async () => {
    const { ctx } = makeHarness();
    const submitted = await submitAsyncJob(
      ctx,
      {
        capability: "followup.report",
        payload: {
          outcome: { kind: "stock" },
          userLogin: "spr9s",
          ledgerLinkage: { trigger: "scheduled", scheduleId: "goal-7", asyncJobId: null, workflowId: null },
        },
      } as unknown as AsyncJobSubmission,
    );
    const record = getAsyncJob(ctx, submitted.jobId);
    expect(record!.trigger).toBe("scheduled");
    expect(record!.scheduleId).toBe("goal-7");
  });

  it("maps a worker-cron ledger trigger to scheduled", async () => {
    const { ctx } = makeHarness();
    const submitted = await submitAsyncJob(
      ctx,
      {
        capability: "followup.report",
        payload: {
          outcome: { kind: "stock" },
          userLogin: "spr9s",
          ledgerLinkage: { trigger: "worker-cron", scheduleId: null, asyncJobId: null, workflowId: null },
        },
      } as unknown as AsyncJobSubmission,
    );
    expect(getAsyncJob(ctx, submitted.jobId)!.trigger).toBe("scheduled");
  });

  it("leaves async-chain ledger linkage unmapped — the chain inherits, never guessed", async () => {
    const { ctx } = makeHarness();
    const submitted = await submitAsyncJob(
      ctx,
      {
        capability: "followup.report",
        payload: {
          outcome: { kind: "stock" },
          userLogin: "spr9s",
          ledgerLinkage: { trigger: "async-chain", scheduleId: null, asyncJobId: null, workflowId: null },
        },
      } as unknown as AsyncJobSubmission,
    );
    const record = getAsyncJob(ctx, submitted.jobId);
    expect(record!.trigger).toBeNull();
    expect(record!.scheduleId).toBeNull();
  });

  it("leaves the columns NULL when no provenance exists anywhere", async () => {
    const { ctx } = makeHarness();
    const submitted = await submitAsyncJob(ctx, mcpJob());
    const record = getAsyncJob(ctx, submitted.jobId);
    expect(record!.trigger).toBeNull();
    expect(record!.triggeredBy).toBeNull();
    expect(record!.scheduleId).toBeNull();
  });

  it("keeps the source row's provenance on retry", async () => {
    const { db, ctx } = makeHarness();
    const submitted = await submitAsyncJob(ctx, mcpJob({ trigger: "agent", triggeredBy: "spr9s" }));
    db.prepare("UPDATE mas_async_jobs SET status = 'failed', error = 'boom' WHERE job_id = ?").run(submitted.jobId);
    const retried = await retryAsyncJob(ctx, submitted.jobId);
    const record = getAsyncJob(ctx, retried.jobId);
    expect(record!.trigger).toBe("agent");
    expect(record!.triggeredBy).toBe("spr9s");
  });

  it("adds the provenance columns to a legacy table via the probed migration", () => {
    const { db, sql } = makeHarness();
    sql.exec(BASE_DDL);
    const before = (db.prepare("PRAGMA table_info(mas_async_jobs)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(before).not.toContain("trigger");
    ensureAsyncJobGraphColumns(sql as never);
    const after = (db.prepare("PRAGMA table_info(mas_async_jobs)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(after).toContain("trigger");
    expect(after).toContain("triggered_by");
    expect(after).toContain("schedule_id");
    // Idempotent: a second ensure is a no-op, not an error.
    ensureAsyncJobGraphColumns(sql as never);
  });
});
describe("chain-level bulk retry (#4416)", () => {
  it("retries only the chain's failed shards — completed shards and other chains untouched", async () => {
    const { db, ctx } = makeHarness();
    const shard = (symbol: string, chainId: string): AsyncJobSubmission =>
      ({
        capability: "shard.execute",
        payload: { shard: { stage: "feed", key: symbol }, chain: { chainId, userLogin: "venus", trigger: "scheduled" } },
        chainId,
      }) as unknown as AsyncJobSubmission;
    const completed = await submitAsyncJob(ctx, shard("AAPL", "chain-9"));
    const failedA = await submitAsyncJob(ctx, shard("MSFT", "chain-9"));
    const failedB = await submitAsyncJob(ctx, shard("NVDA", "chain-9"));
    const otherChain = await submitAsyncJob(ctx, shard("AMZN", "chain-other"));
    db.prepare("UPDATE mas_async_jobs SET status = 'completed' WHERE job_id = ?").run(completed.jobId);
    db.prepare("UPDATE mas_async_jobs SET status = 'failed', error = 'boom' WHERE job_id IN (?, ?)").run(
      failedA.jobId,
      failedB.jobId,
    );
    db.prepare("UPDATE mas_async_jobs SET status = 'failed', error = 'boom' WHERE job_id = ?").run(otherChain.jobId);

    const result = await retryFailedChainJobs(ctx, "chain-9");
    expect(result.retried).toHaveLength(2);
    expect(result.untouched).toBe(1);
    expect(result.failures).toEqual([]);

    const rows = db.prepare("SELECT payload_json FROM mas_async_jobs WHERE payload_json LIKE '%retryOf%'").all() as Array<{
      payload_json: string;
    }>;
    const retriedOf = rows.map((row) => (JSON.parse(row.payload_json) as { retryOf?: string }).retryOf);
    expect(retriedOf.sort()).toEqual([failedA.jobId, failedB.jobId].sort());
  });
});