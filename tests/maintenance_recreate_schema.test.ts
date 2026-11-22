// @vitest-environment node
/**
 * #4282 P5 — the maintenance door for the recreate (DO leg, own-instance).
 *
 * POST /api/maintenance/recreate-schema, the door the Data Lifecycle
 * route fans out to per login. It runs inside each instance's agent
 * (own SqlStorage), so the route never touches an instance's store
 * directly: the route sends the DO-plane codes, the door probes its
 * own store, selects the steps that close a diff, and executes them.
 *
 * Contract (mirrors clear-table):
 * - Code-only validation: every requested code must be a DO-plane
 *   code from the plan; anything else — an unknown code, a D1-plane
 *   code, raw SQL passed as a code — is a 400 and nothing runs.
 * - Preview ({ preview: true }): probe + select only, no execution,
 *   no audit. Returns the selected and skipped codes plus the
 *   uncreatable layers.
 * - Execute (no preview flag): probe + select + execute the selected
 *   steps that are also in the requested codes, stop at the first
 *   failure with an honest partial report, then re-probe and verify
 *   against the DO leg's expected model. Audits once after the
 *   attempt (maintenance.schema.recreated).
 * - The DO leg claims no atomicity (see the transaction proof): a
 *   failed run leaves an honest partial report and is re-run safely
 *   because selection is diff-based.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  handleMaintenanceRoutes,
  type MaintenanceRouteContext,
} from "../src/agents/routes/maintenance";
import type { SqlStorage } from "../src/orm";
import {
  planForLeg,
  resolveRecreatePlan,
} from "../src/data/schemaComponent/recreateRunner";

const PATH = "/api/maintenance/recreate-schema";

const GENERATION_INDEX_CODE =
  "schema.index.mas_reports.create_unique_index_idx_mas_reports_generation";
const MAS_DATA_CAPTURES_CREATE_CODE =
  "schema.do.mas_data_captures.create_table";
const D1_CREATE_CODE = "schema.d1.agent_referral_rules.create_table";

/** Eager SqlStorage adapter over node:sqlite (same pattern as the clear-table tests). */
function makeSql(db: DatabaseSync): SqlStorage {
  return {
    exec: (query: string, ...args: unknown[]) => {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|EXPLAIN|PRAGMA|WITH)\b/i.test(query)) {
        return stmt.all(...(args as any[])) as unknown[];
      }
      stmt.run(...(args as any[]));
      return [];
    },
  } as unknown as SqlStorage;
}

function makeCtx(db: DatabaseSync) {
  const ctx = {
    agentCtx: { storage: { sql: makeSql(db) } },
    audit: vi.fn(),
  } as unknown as MaintenanceRouteContext;
  return ctx;
}

function doPlaneCodes(): string[] {
  const plan = resolveRecreatePlan();
  return planForLeg(plan, "do").steps.map((s) => s.code);
}

async function postRecreate(
  ctx: MaintenanceRouteContext,
  body: Record<string, unknown>,
) {
  const req = new Request(`https://agent.test${PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handleMaintenanceRoutes(
    req,
    new URL(`https://agent.test${PATH}`),
    PATH,
    "sess-1",
    ctx,
  );
  return { status: res!.status, body: (await res!.json()) as any };
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(table) !== undefined
  );
}

describe("POST /api/maintenance/recreate-schema (#4383)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
  });

  it("rejects unknown codes, D1-plane codes, and raw SQL — nothing runs", async () => {
    const ctx = makeCtx(db);
    for (const codes of [
      ["schema.do.no_such_table.create_table"],
      [D1_CREATE_CODE],
      ["DROP TABLE mas_reports"],
      [GENERATION_INDEX_CODE, "schema.do.nope.create_table"],
    ]) {
      const { status, body } = await postRecreate(ctx, { codes });
      expect(status).toBe(400);
      expect(body.error).toContain("Unknown or not DO-plane code");
      expect(tableExists(db, "mas_reports")).toBe(false);
    }
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("preview selects the closing steps without executing or auditing", async () => {
    const ctx = makeCtx(db);
    const { status, body } = await postRecreate(ctx, {
      codes: doPlaneCodes(),
      preview: true,
    });
    expect(status).toBe(200);
    expect(body.preview).toBe(true);
    expect(body.leg).toBe("do");
    // A fresh store selects the DO leg's fresh selection (132 steps,
    // #3251 adds the iaaa_audit_events CREATE TABLE: 128 → 129;
    // #5175 slice 2 adds mas_runs + mas_run_aliases + its index: 129 → 132;
    // #4767 adds migrations 0071/0072 (4 remainder ALTERs): 132 → 136);
    // the conditional index drop is among the skipped. Steps are
    // descriptors (code + params), not bare codes: the generic
    // column-add steps share one code and differ only by params.
    // Issue #3185 adds the usage_events tenant index to the DO leg: 139 → 140.
    // Issue #6167 adds the host_version remainder ALTER on mas_async_jobs: 140 → 141.
    expect(body.selected).toHaveLength(141);
    // Issue #4623 adds one probed DO statement (mas_async_jobs.tenant_id).
    // Issue #3185 adds one probed DO statement (usage_events.tenant_id):
    // the fresh CREATE TABLE already carries the column, so the ALTER
    // is probed-and-skipped: 36 → 37.
    expect(body.skipped).toHaveLength(37);
    expect(body.skipped.map((s: any) => s.code)).toContain(
      "schema.index.mas_reports.drop_index_idx_mas_reports_generation",
    );
    expect(body.uncreatableLayers).toHaveLength(5);
    expect(tableExists(db, "mas_reports")).toBe(false);
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("executes the fresh DO leg, verifies against the leg model, and audits once", async () => {
    const ctx = makeCtx(db);
    const { status, body } = await postRecreate(ctx, {
      codes: doPlaneCodes(),
    });
    expect(status).toBe(200);
    expect(body.preview).toBe(false);
    expect(body.leg).toBe("do");
    expect(body.report.outcome).toBe("succeeded");
    // #4767 adds migrations 0071/0072 (4 remainder ALTERs): 132 → 136.
    // Issue #3185 adds the usage_events tenant index to the DO leg: 139 → 140.
    // Issue #6167 adds the host_version remainder ALTER on mas_async_jobs: 140 → 141.
    expect(body.report.executed).toHaveLength(141);
    expect(body.report.failed).toEqual([]);
    expect(body.verification.ok).toBe(true);
    expect(body.verification.failures).toEqual([]);
    expect(tableExists(db, "mas_reports")).toBe(true);
    expect(ctx.audit).toHaveBeenCalledTimes(1);
    expect(ctx.audit).toHaveBeenCalledWith(
      "maintenance.schema.recreated",
      "orchestrator",
      expect.objectContaining({ leg: "do", outcome: "succeeded" }),
    );
  });

  it("a second run is a no-op: zero steps executed, verification still ok", async () => {
    const ctx = makeCtx(db);
    await postRecreate(ctx, { codes: doPlaneCodes() });
    const { status, body } = await postRecreate(ctx, {
      codes: doPlaneCodes(),
    });
    expect(status).toBe(200);
    expect(body.report.outcome).toBe("succeeded");
    expect(body.report.executed).toHaveLength(0);
    expect(body.verification.ok).toBe(true);
  });

  it("a mid-leg failure stops at the first failure with an honest partial report", async () => {
    const ctx = makeCtx(db);
    // A creation that succeeds, then an index creation whose table
    // was never created (the requested codes omit the report table's
    // creation): the creation stays, the index fails, nothing after
    // it runs.
    const { status, body } = await postRecreate(ctx, {
      codes: [MAS_DATA_CAPTURES_CREATE_CODE, GENERATION_INDEX_CODE],
    });
    expect(status).toBe(200);
    expect(body.report.outcome).toBe("failed");
    expect(body.report.executed).toEqual([MAS_DATA_CAPTURES_CREATE_CODE]);
    expect(body.report.failed).toHaveLength(1);
    expect(body.report.failed[0].code).toBe(GENERATION_INDEX_CODE);
    expect(body.verification.ok).toBe(false);
    expect(tableExists(db, "mas_data_captures")).toBe(true);
    expect(tableExists(db, "mas_reports")).toBe(false);
    // The attempt is audited even when it fails.
    expect(ctx.audit).toHaveBeenCalledTimes(1);
    expect(ctx.audit).toHaveBeenCalledWith(
      "maintenance.schema.recreated",
      "orchestrator",
      expect.objectContaining({ leg: "do", outcome: "failed" }),
    );
  });

  it("an empty code list is a no-op execute: probe + verify, nothing runs", async () => {
    const ctx = makeCtx(db);
    const { status, body } = await postRecreate(ctx, { codes: [] });
    expect(status).toBe(200);
    expect(body.preview).toBe(false);
    expect(body.report.outcome).toBe("succeeded");
    expect(body.report.executed).toHaveLength(0);
    // Issue #3185 adds the usage_events tenant index to the DO leg: 139 → 140.
    // Issue #6167 adds the host_version remainder ALTER on mas_async_jobs: 140 → 141.
    expect(body.planned).toHaveLength(141);
    expect(body.notRequested).toHaveLength(141);
    expect(body.verification.ok).toBe(false); // fresh store, nothing executed
    expect(ctx.audit).toHaveBeenCalledTimes(1);
  });

  it("executes only the requested codes, even when more steps are selected", async () => {
    const ctx = makeCtx(db);
    // Only the report table's creation is requested: the door
    // executes exactly that step. The probe still selects the full
    // fresh set, and the unrequested selections are reported as
    // notRequested — not silently dropped.
    const { status, body } = await postRecreate(ctx, {
      codes: ["schema.do.mas_reports.create_table"],
    });
    expect(status).toBe(200);
    // Issue #3185 adds the usage_events tenant index to the DO leg: 139 → 140.
    // Issue #6167 adds the host_version remainder ALTER on mas_async_jobs: 140 → 141.
    expect(body.planned).toHaveLength(141);
    expect(body.notRequested).toHaveLength(140);
    expect(body.notRequested.map((s: any) => s.code)).not.toContain(
      "schema.do.mas_reports.create_table",
    );
    expect(body.report.executed).toEqual([
      "schema.do.mas_reports.create_table",
    ]);
    expect(tableExists(db, "mas_reports")).toBe(true);
    expect(tableExists(db, "mas_data_captures")).toBe(false);
  });
});
