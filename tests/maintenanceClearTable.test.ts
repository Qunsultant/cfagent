import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  handleMaintenanceRoutes,
  type MaintenanceRouteContext,
} from "../src/agents/routes/maintenance";
import type { SqlStorage } from "../src/orm";

const PATH = "/api/maintenance/clear-table";

/** Eager SqlStorage adapter over node:sqlite (same pattern as the slice tests). */
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

function seed(db: DatabaseSync) {
  db.exec(`CREATE TABLE mas_async_jobs (
    job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, capability TEXT NOT NULL,
    display_name TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
    result_json TEXT, response_status INTEGER, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    started_at TEXT, completed_at TEXT
  )`);
  db.exec(`CREATE TABLE mas_job_outcomes (id TEXT PRIMARY KEY, kind TEXT, trigger TEXT, status TEXT, scanned INTEGER, matched INTEGER, coded_error TEXT, report_url TEXT, pdf_key TEXT, xlsx_key TEXT, csv_key TEXT, delivery_json TEXT, origin TEXT, created_at TEXT)`);
  db.exec(`CREATE TABLE mas_job_outcomes_meta (k TEXT PRIMARY KEY, v TEXT)`);
  db.exec(`CREATE TABLE unified_schedules (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
    callback TEXT, operation TEXT, definition_json TEXT NOT NULL,
    owner_login TEXT, provenance_json TEXT, alarm_id TEXT,
    paused_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const job = db.prepare(
    "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at) VALUES (?, ?, 'c', 'd', ?, '{}', '2026-10-29', '2026-10-29')",
  );
  job.run("j1", "sess-1", "queued");
  job.run("j2", "sess-1", "queued");
  job.run("j3", "sess-1", "running");
  job.run("j4", "sess-1", "completed");
  job.run("j5", "sess-2", "queued");
  const outcome = db.prepare("INSERT INTO mas_job_outcomes (id, kind, trigger, status, created_at) VALUES (?, 'options', 'manual', 'completed', '2026-10-29')");
  outcome.run("o1");
  outcome.run("o2");
  outcome.run("o3");
  db.prepare("INSERT INTO mas_job_outcomes_meta (k, v) VALUES ('pruned_at', '2026-10-29T00:00:00.000Z')").run();
  const paused = db.prepare("INSERT INTO unified_schedules (id, kind, state, callback, definition_json, alarm_id, paused_at, created_at, updated_at) VALUES (?, 'screen', ?, 'autonomousOptionsAnalysis', '{\"type\":\"cron\",\"callback\":\"autonomousOptionsAnalysis\",\"cron\":\"35 * * * *\"}', ?, ?, '2026-10-29', '2026-10-29')");
  paused.run("p1", "paused", "p1", "2026-10-29");
  paused.run("p2", "paused", "p2", "2026-10-29");
  paused.run("a1", "active", "a1", null);
}

function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as any).n;
}

function makeCtx(db: DatabaseSync) {
  const ctx = {
    agentCtx: { storage: { sql: makeSql(db) } },
    audit: vi.fn(),
  } as unknown as MaintenanceRouteContext;
  return ctx;
}

async function postClear(ctx: MaintenanceRouteContext, body: Record<string, unknown>) {
  const req = new Request(`https://agent.test${PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handleMaintenanceRoutes(req, new URL(`https://agent.test${PATH}`), PATH, "sess-1", ctx);
  return { status: res!.status, body: (await res!.json()) as any };
}

describe("POST /api/maintenance/clear-table (#2280)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    seed(db);
  });

  it("rejects unknown tables without deleting anything", async () => {
    const ctx = makeCtx(db);
    const { status, body } = await postClear(ctx, { table: "mas_reports", confirm: true });
    expect(status).toBe(400);
    expect(body.error).toContain("Clearable:");
    expect(count(db, "SELECT COUNT(*) AS n FROM mas_async_jobs")).toBe(5);
  });

  it("routes messages and the framework queue elsewhere; audit history needs the second confirmation (#2489 supersedes the old never-clearable rule)", async () => {
    const ctx = makeCtx(db);
    for (const [table, hint] of [
      ["mas_messages", "/clear"],
      ["cf_agents_jobs", "cancel-all"],
    ] as const) {
      const { status, body } = await postClear(ctx, { table, confirm: true });
      expect(status).toBe(400);
      expect(body.error).toContain(hint);
    }
    // mas_events without auditConfirm is still refused.
    const refused = await postClear(ctx, { table: "mas_events", confirm: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("auditConfirm");
  });

  it("preview counts without deleting and without auditing", async () => {
    const ctx = makeCtx(db);
    const { status, body } = await postClear(ctx, { table: "mas_async_jobs" });
    expect(status).toBe(200);
    expect(body.confirmed).toBe(false);
    expect(body.confirmRequired).toBe(true);
    expect(body.wouldDelete).toBe(3);
    expect(body.skippedRunning).toBe(1);
    expect(body.breakdown).toEqual({ queued: 2, running: 1, completed: 1 });
    expect(count(db, "SELECT COUNT(*) AS n FROM mas_async_jobs")).toBe(5);
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("confirm deletes only the caller's session, never running rows", async () => {
    const ctx = makeCtx(db);
    const { status, body } = await postClear(ctx, { table: "mas_async_jobs", confirm: true });
    expect(status).toBe(200);
    expect(body.deleted).toBe(3);
    expect(body.skippedRunning).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM mas_async_jobs")).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM mas_async_jobs WHERE session_id = 'sess-2'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM mas_async_jobs WHERE status = 'running'")).toBe(1);
    expect(ctx.audit).toHaveBeenCalledTimes(1);
    expect((ctx.audit as any).mock.calls[0][0]).toBe("maintenance.table.cleared");
  });

  it("a statuses filter narrows the delete", async () => {
    const ctx = makeCtx(db);
    const { body } = await postClear(ctx, { table: "mas_async_jobs", confirm: true, statuses: ["completed"] });
    expect(body.deleted).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM mas_async_jobs WHERE session_id = 'sess-1' AND status = 'queued'")).toBe(2);
  });

  it("outcomes clear deletes rows but preserves the prune watermark", async () => {
    const ctx = makeCtx(db);
    const { body } = await postClear(ctx, { table: "mas_job_outcomes", confirm: true });
    expect(body.deleted).toBe(3);
    expect(count(db, "SELECT COUNT(*) AS n FROM mas_job_outcomes")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM mas_job_outcomes_meta")).toBe(1);
  });

  it("paused clear deletes the paused records, never active ones (#3123)", async () => {
    const ctx = makeCtx(db);
    const { body } = await postClear(ctx, { table: "unified_schedules", confirm: true });
    expect(body.deleted).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM unified_schedules")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM unified_schedules WHERE state = 'active'")).toBe(1);
  });

  it("missing tables preview and confirm at zero, never 500", async () => {
    const fresh = new DatabaseSync(":memory:");
    const ctx = makeCtx(fresh);
    for (const table of ["mas_async_jobs", "mas_job_outcomes"] as const) {
      const preview = await postClear(ctx, { table });
      expect(preview.status).toBe(200);
      expect(preview.body.wouldDelete).toBe(0);
      const confirmed = await postClear(ctx, { table, confirm: true });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.deleted).toBe(0);
    }
  });
});
