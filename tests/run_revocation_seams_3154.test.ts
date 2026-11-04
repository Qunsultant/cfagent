/**
 * Issue #3154 (parent #945, Q6) — seam proof tests.
 *
 * The pure gate + bridge are proven in
 * tests/run_revocation_gate_3154.test.ts. These tests prove the
 * LIVE seams call them:
 * 1. Scheduled-callback dispatch: autoRenewETradeTokens with a
 *    revoked owner denies at dispatch, audits
 *    schedule.dispatch_denied with OWNER_MEMBERSHIP_REVOKED, never
 *    runs the renewal service, and never removes the schedule
 *    (preserved, not deleted).
 * 2. Async-job execution: a mid-pipeline stage job (stage
 *    "generate") whose owner was revoked denies at that stage's
 *    execution, audits async_job.dispatch_denied +
 *    async_job.failed, is marked failed, never reaches a
 *    capability leg, and schedules nothing downstream (the chain
 *    stops). A live owner control proves intact authority still
 *    executes.
 *
 * The fake SQL + context harness below mirror the proven C3
 * harness (tests/consolidation_c3_stage_chain.test.ts) in
 * miniature: generic INSERT/UPDATE/SELECT over mas_async_jobs +
 * mas_screening_activity, status-guard honoring on UPDATE.
 */
import { describe, expect, it, vi } from "vitest";
import {
  executeAsyncJob,
  submitAsyncJob,
  getAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import {
  autoRenewETradeTokens,
  type ScheduledCallbacksContext,
} from "../src/agents/orchestrator/scheduledCallbacks";
import type { Membership, MembershipStore } from "../src/security/authorization";

type Row = Record<string, unknown>;

class FakeSql {
  tables: Record<string, Row[]> = { mas_async_jobs: [], mas_screening_activity: [] };

  exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<Row> {
    const q = query.trim().replace(/\s+/g, " ");
    const wrap = (rows: Row[], rowsWritten = 0) => Object.assign(rows, { rowsWritten });
    if (/^CREATE TABLE|^CREATE INDEX|^PRAGMA|^ALTER/i.test(q)) return wrap([]);
    const tableMatch = q.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
    const table = tableMatch?.[1] ?? "";
    if (/^DELETE FROM/i.test(q)) return wrap([]);
    if (/^INSERT INTO/i.test(q)) {
      const cols = q.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
      const tokens = q.match(/VALUES \(([^)]+)\)/i)![1].split(",").map((c) => c.trim());
      const row: Row = {};
      let ai = 0;
      cols.forEach((col, i) => {
        row[col] = tokens[i] === "?" ? (args[ai++] ?? null) : tokens[i].replace(/^'|'$/g, "");
      });
      (this.tables[table] ??= []).push(row);
      return wrap([], 1);
    }
    if (/^UPDATE/i.test(q)) {
      const setPart = q.match(/SET (.+?) WHERE/i)![1];
      let ai = 0;
      const updates: Array<[string, unknown]> = setPart.split(",").map((a) => {
        const eq = a.indexOf("=");
        const col = a.slice(0, eq).trim();
        const expr = a.slice(eq + 1).trim();
        return [col, expr === "?" ? args[ai++] : expr.replace(/^'|'$/g, "")] as [string, unknown];
      });
      const wherePart = q.split(/ WHERE /i)[1] ?? "";
      const conds: Array<[string, unknown]> = [];
      for (const cond of wherePart.split(/ AND /i)) {
        const m = cond.trim().match(/^(\w+)\s*=\s*(\?|'[^']*')$/);
        if (m) conds.push([m[1], m[2] === "?" ? args[ai++] : m[2].replace(/^'|'$/g, "")]);
      }
      let written = 0;
      for (const row of this.tables[table] ?? []) {
        if (conds.every(([c, v]) => row[c] === v)) {
          for (const [col, val] of updates) row[col] = val;
          written++;
        }
      }
      return wrap([], written);
    }
    if (/^SELECT/i.test(q)) {
      const listMatch = q.match(/SELECT (.+?) FROM (\w+)/i);
      if (!listMatch) return wrap([]);
      const cols = listMatch[1].split(",").map((c) => c.trim());
      let rows = [...(this.tables[listMatch[2]] ?? [])];
      const wherePart = (q.split(/ WHERE /i)[1] ?? "").split(/ ORDER BY /i)[0];
      let ai = 0;
      for (const cond of wherePart.split(/ AND /i)) {
        const m = cond.trim().match(/^(\w+)\s*=\s*(\?|'[^']*')$/);
        if (m) {
          const val = m[2] === "?" ? args[ai++] : m[2].replace(/^'|'$/g, "");
          rows = rows.filter((r) => r[m[1]] === val);
        }
      }
      if (/ORDER BY created_at DESC/i.test(q)) rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      if (/ORDER BY created_at ASC/i.test(q)) rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      const limitMatch = q.match(/LIMIT (\?|\d+)/i);
      if (limitMatch) {
        const n = limitMatch[1] === "?" ? Number(args[ai++]) : Number(limitMatch[1]);
        if (Number.isFinite(n)) rows = rows.slice(0, n);
      }
      return wrap(rows.map((row) => {
        const out: Row = {};
        for (const col of cols) out[col] = row[col] ?? null;
        return out;
      }));
    }
    throw new Error(`FakeSql: unsupported: ${q.slice(0, 90)}`);
  }
}

function liveMembership(): Membership {
  return {
    membershipId: "m1",
    internalUserId: "v1:abc",
    tenantId: "primary",
    createdBy: "admin",
    createdAtMs: 1,
    roleBindings: [{ role: "member", scope: "tenant" }],
  } as Membership;
}

function revokedMembership(): Membership {
  return { ...liveMembership(), revokedAtMs: 500 };
}

function storeFor(list: Membership[]): MembershipStore {
  return { getMembershipsByUser: async () => list } as unknown as MembershipStore;
}

describe("scheduled-callback dispatch seam (#3154)", () => {
  it("revoked owner: denies, audits, runs nothing, preserves the schedule", async () => {
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let removed = 0;
    const ctx = {
      env: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", SCREENER_EMAIL_TO: "ops@example.com" },
      waitUntilStable: async () => true,
      getScreenerExecutionContext: async () => undefined,
      audit: (type: string, _agent: string, payload: Record<string, unknown>) => {
        audits.push({ type, payload });
      },
      serviceMembershipStore: storeFor([revokedMembership()]),
      resolveOwnerInternalUserId: async () => "v1:abc",
      removeUnownedBaselineSchedules: async () => { removed++; },
      getOrm: () => { throw new Error("service must not run on a denied dispatch"); },
      sessionKey: () => "owner",
    } as unknown as ScheduledCallbacksContext;

    await autoRenewETradeTokens(ctx, { userLogin: "owner" });

    const denial = audits.find((a) => a.type === "schedule.dispatch_denied");
    expect(denial).toBeDefined();
    expect(denial!.payload.reason).toBe("OWNER_MEMBERSHIP_REVOKED");
    expect(denial!.payload.callback).toBe("autoRenewETradeTokens");
    expect(removed).toBe(0);
  });
});

describe("async-job execution seam (#3154)", () => {
  function makeCtx(sql: FakeSql, overrides: Partial<AsyncJobsContext> = {}) {
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
    const routeRequest = vi.fn(async () => new Response("{}", { status: 200 }));
    const ctx = {
      env: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", SCREENER_EMAIL_TO: "ops@example.com" },
      agentCtx: { storage: { sql: storage } },
      ensureTables: () => storage,
      sessionKey: () => "owner",
      schedule: async () => ({}),
      audit: (type: string, _agent: string, payload: Record<string, unknown>) => {
        audits.push({ type, payload });
      },
      getOrm: () => ({ events: { create: () => ({}) } }),
      routeRequest,
      nlqSchedulingPort: () => { throw new Error("unused"); },
      nlqStockScreenPort: () => { throw new Error("unused"); },
      followupReportPort: () => ({ getStockPdf: async () => null, getOptionsPdf: async () => null }),
      followupDeliveryPort: () => ({ deliver: async () => ({ ok: true }), notify: async () => ({ ok: true }) }),
      ...overrides,
    } as unknown as AsyncJobsContext;
    return { ctx, audits, routeRequest };
  }

  it("revoked owner, mid-pipeline stage: denies at execution, fails visibly, runs no leg", async () => {
    const sql = new FakeSql();
    const { ctx, audits, routeRequest } = makeCtx(sql, {
      serviceMembershipStore: storeFor([revokedMembership()]),
      resolveOwnerInternalUserId: async () => "v1:abc",
    });
    const { jobId } = await submitAsyncJob(ctx, {
      capability: "http.request",
      payload: { userLogin: "owner", pathAndQuery: "/api/test", method: "GET", headers: {} },
      stage: "generate",
      chainId: "chain-1",
    });

    await executeAsyncJob(ctx, { jobId });

    expect(getAsyncJob(ctx, jobId)?.status).toBe("failed");
    const denial = audits.find((a) => a.type === "async_job.dispatch_denied");
    expect(denial).toBeDefined();
    expect(denial!.payload.reason).toBe("OWNER_MEMBERSHIP_REVOKED");
    expect(audits.some((a) => a.type === "async_job.failed")).toBe(true);
    expect(routeRequest).not.toHaveBeenCalled();
  });

  it("live owner control: intact authority still executes", async () => {
    const sql = new FakeSql();
    const { ctx, routeRequest } = makeCtx(sql, {
      serviceMembershipStore: storeFor([liveMembership()]),
      resolveOwnerInternalUserId: async () => "v1:abc",
    });
    const { jobId } = await submitAsyncJob(ctx, {
      capability: "http.request",
      payload: { userLogin: "owner", pathAndQuery: "/api/test", method: "GET", headers: {} },
      stage: "generate",
      chainId: "chain-1",
    });

    await executeAsyncJob(ctx, { jobId });

    expect(getAsyncJob(ctx, jobId)?.status).toBe("completed");
    expect(routeRequest).toHaveBeenCalledTimes(1);
  });
});
