// @vitest-environment node
/**
 * Issue #4623 — the tenant on the async-job row.
 *
 * The queue had no tenant anywhere: no field on the submission, no column on
 * `mas_async_jobs`, no tenant in the executor. A multi-tenant login's jobs for
 * different tenants were indistinguishable.
 *
 * Pins (same node:sqlite harness as the #3810 provenance suite):
 *  - the probed migration adds `tenant_id` to a legacy table;
 *  - an explicit tenant on the submission lands on the row and reads back;
 *  - all four submission kinds carry it (followup.deliver, shard.execute,
 *    http.request, mcp.tool);
 *  - a deployment WITHOUT an account store records null honestly and audits
 *    it (never a guessed tenant);
 *  - a deployment WITH an account store refuses a submission it cannot
 *    attribute (fail closed), and nothing is queued.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  AsyncJobTenantUnresolvedError,
  ensureAsyncJobGraphColumns,
  getAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
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

function makeHarness(options: { env?: Record<string, unknown>; session?: string } = {}) {
  const db = new DatabaseSync(":memory:");
  const sql = makeSql(db);
  const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    env: options.env ?? {},
    agentCtx: { storage: { sql } },
    ensureTables: () => {
      sql.exec(BASE_DDL);
      ensureAsyncJobGateIndexes(sql as never);
      ensureAsyncJobGraphColumns(sql as never);
      return sql;
    },
    sessionKey: () => options.session ?? "sess-4623",
    schedule: async () => ({}),
    audit: (type: string, _agent: unknown, payload: Record<string, unknown>) => {
      audits.push({ type, payload });
    },
    getOrm: () => {
      throw new Error("no orm in this harness");
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
  return { db, sql, ctx, audits };
}

function columns(db: DatabaseSync): string[] {
  return (db.prepare("PRAGMA table_info(mas_async_jobs)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function tenantOf(db: DatabaseSync, jobId: string): string | null {
  const row = db.prepare("SELECT tenant_id FROM mas_async_jobs WHERE job_id = ?").get(jobId) as
    | { tenant_id: string | null }
    | undefined;
  return row?.tenant_id ?? null;
}

describe("the queue has a tenant column (#4623)", () => {
  it("adds tenant_id to a legacy table through the probed migration", () => {
    const { db, ctx } = makeHarness();
    ctx.ensureTables();
    expect(columns(db)).toContain("tenant_id");
  });

  it("stamps an explicit tenant on the row and reads it back", async () => {
    const { db, ctx } = makeHarness();
    const submitted = await submitAsyncJob(ctx, {
      capability: "mcp.tool",
      payload: { toolName: "run_pipeline_chain", arguments: {} },
      tenantId: "tenant-a",
    } as AsyncJobSubmission);

    expect(tenantOf(db, submitted.jobId)).toBe("tenant-a");
    expect(getAsyncJob(ctx, submitted.jobId)?.tenantId).toBe("tenant-a");
  });

  it("carries the tenant for every submission kind", async () => {
    const { db, ctx } = makeHarness();
    const kinds: AsyncJobSubmission[] = [
      {
        capability: "followup.deliver",
        payload: { runId: "run-1", channel: "slack" },
        tenantId: "tenant-a",
      } as unknown as AsyncJobSubmission,
      {
        capability: "shard.execute",
        payload: { shard: { stage: "screen", key: "k1" } },
        tenantId: "tenant-a",
      } as unknown as AsyncJobSubmission,
      {
        capability: "http.request",
        payload: { pathAndQuery: "/api/x", method: "POST", headers: {}, body: "{}" },
        tenantId: "tenant-a",
      } as unknown as AsyncJobSubmission,
      {
        capability: "mcp.tool",
        payload: { toolName: "watchlists.list", arguments: {} },
        tenantId: "tenant-a",
      } as unknown as AsyncJobSubmission,
    ];

    for (const job of kinds) {
      const submitted = await submitAsyncJob(ctx, job);
      expect(tenantOf(db, submitted.jobId), job.capability).toBe("tenant-a");
    }
  });

  it("separates one login's tenants on the row", async () => {
    const { db, ctx } = makeHarness();
    const a = await submitAsyncJob(ctx, {
      capability: "mcp.tool",
      payload: { toolName: "watchlists.list", arguments: {} },
      tenantId: "tenant-a",
    } as AsyncJobSubmission);
    const b = await submitAsyncJob(ctx, {
      capability: "mcp.tool",
      payload: { toolName: "watchlists.list", arguments: {} },
      tenantId: "tenant-b",
    } as AsyncJobSubmission);

    expect(tenantOf(db, a.jobId)).toBe("tenant-a");
    expect(tenantOf(db, b.jobId)).toBe("tenant-b");
  });

  it("records null honestly and audits it when the deployment has no account store", async () => {
    const { db, ctx, audits } = makeHarness();
    const submitted = await submitAsyncJob(ctx, {
      capability: "mcp.tool",
      payload: { toolName: "watchlists.list", arguments: {} },
    } as AsyncJobSubmission);

    expect(tenantOf(db, submitted.jobId)).toBeNull();
    expect(getAsyncJob(ctx, submitted.jobId)?.tenantId).toBeNull();
    expect(audits.some((a) => a.type === "async_job.tenant_unresolved")).toBe(true);
  });

  it("refuses a submission it cannot attribute when the deployment CAN attribute", async () => {
    // A deployment with an account binding: createCommercialAdapter cannot
    // produce a store from this bogus handle, so the tenant stays unknown —
    // and the queue refuses rather than inventing one.
    const { db, ctx } = makeHarness({ env: { AGENT_DB: {} } });
    await expect(
      submitAsyncJob(ctx, {
        capability: "mcp.tool",
        payload: { toolName: "watchlists.list", arguments: {} },
      } as AsyncJobSubmission),
    ).rejects.toBeInstanceOf(AsyncJobTenantUnresolvedError);

    const count = (db.prepare("SELECT COUNT(*) AS n FROM mas_async_jobs").get() as { n: number }).n;
    expect(count).toBe(0);
  });
});
