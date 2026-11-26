import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  handleMaintenanceRoutes,
  type MaintenanceRouteContext,
} from "../src/agents/routes/maintenance";
import type { SqlStorage } from "../src/orm";
import { MockD1Database } from "./mock-d1";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";

const PATH = "/api/maintenance/clear-table";

// Issue #6503 step 8b — the platform-admin identity stubs, same
// shape as tests/no_derived_consolidation_6503.test.ts (alias KV:
// login → internal id; membership store: a live platform-admin
// binding for the admin, nothing for anyone else).
const ADMIN_LOGIN = "venus-admin";
const ADMIN_USER_ID = "user-admin-1";

function stubKv(entries: Record<string, string>) {
  const store = new Map<string, string>();
  for (const [login, userId] of Object.entries(entries)) {
    store.set(`iaaa-alias:login:${login}`, JSON.stringify({ internalUserId: userId }));
  }
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function stubMembershipStore() {
  const byUser: Record<string, Array<Record<string, unknown>>> = {
    [ADMIN_USER_ID]: [
      {
        membershipId: "m-admin-1",
        internalUserId: ADMIN_USER_ID,
        tenantId: "platform",
        roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "test" }],
        createdBy: "test",
        createdAtMs: 1,
      },
    ],
  };
  return {
    getMembershipsByUser: async (internalUserId: string) => byUser[internalUserId] ?? [],
    put: async () => {},
    revokeMembership: async () => false,
  };
}

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
  db.exec(`CREATE TABLE mas_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, agent TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)`);
  // Issue #6503 — the unified_schedules rows live in D1 now, not
  // in this DO sqlite seed: seedD1Paused below seeds them through
  // the D1 port. No DO unified_schedules table is created here.
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
  const ev = db.prepare("INSERT INTO mas_events (id, session_id, type, agent, payload, created_at) VALUES (?, 'sess-1', 't', 'orchestrator', '{}', '2026-10-29')");
  ev.run("e1");
  ev.run("e2");
}

/** Issue #6503 — the D1 unified_schedules seed: 2 paused + 1 active. */
async function seedD1Paused(mockD1: MockD1Database) {
  const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
  const now = "2026-10-29T00:00:00.000Z";
  for (const [id, state] of [
    ["p1", "paused"],
    ["p2", "paused"],
    ["a1", "active"],
  ] as const) {
    const record: UnifiedScheduleRecord = {
      id,
      kind: "screen",
      state,
      callback: "autonomousOptionsAnalysis",
      definition: {
        type: "cron",
        callback: "autonomousOptionsAnalysis",
        cron: "35 * * * *",
        payload: {},
      },
      ownerLogin: "venus",
      provenance: { origin: "user", createdBy: "venus", reason: id, createdAt: now },
      alarmId: id,
      pausedAt: state === "paused" ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    await store.save(record);
  }
}

async function d1Count(mockD1: MockD1Database, state?: "paused" | "active"): Promise<number> {
  const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
  const rows = state ? await store.listByState(state) : await store.list();
  return rows.length;
}

function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as any).n;
}

function makeCtx(db: DatabaseSync, mockD1?: MockD1Database) {
  const ctx = {
    agentCtx: { storage: { sql: makeSql(db) } },
    audit: vi.fn(),
    // Issue #6503 step 9 (G2) — gated clears audit-before-write
    // through this store; without it the wired fallback (no
    // SESSION_STORE in tests) blocks every confirmed clear with 503.
    auditStore: createMemoryAuditStore(),
    // Issue #6503 step 8b — the gate's identity inputs: the alias
    // KV + membership store name only the platform-admin; every
    // other login resolves as a plain user. The request header
    // picks the caller (none = anonymous).
    getScreenerExecutionContext: async () => undefined,
    flagAliasKv: stubKv({ [ADMIN_LOGIN]: ADMIN_USER_ID }),
    flagMembershipStore: stubMembershipStore(),
    ...(mockD1 ? { env: { AGENT_DB: mockD1 } } : {}),
  } as unknown as MaintenanceRouteContext;
  return ctx;
}

async function postClear(ctx: MaintenanceRouteContext, body: Record<string, unknown>, login?: string) {
  const req = new Request(`https://agent.test${PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(login ? { "x-user-login": login } : {}),
    },
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
    // Issue #6503 step 8b — mas_job_outcomes is platform-admin only.
    const { body } = await postClear(ctx, { table: "mas_job_outcomes", confirm: true }, ADMIN_LOGIN);
    expect(body.deleted).toBe(3);
    expect(count(db, "SELECT COUNT(*) AS n FROM mas_job_outcomes")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM mas_job_outcomes_meta")).toBe(1);
  });

  it("paused clear deletes the paused records, never active ones (#3123)", async () => {
    // Issue #6503 — the paused rows live in D1 now: the wipe reads
    // them through the D1 port (MockD1 bound as AGENT_DB), and the
    // table is platform-admin only (step 8b gate). The store also
    // holds the migration-seeded built-in goals (two of them
    // paused), so the test pins the contract relatively — preview
    // count equals the paused count, confirm deletes exactly those
    // rows, active rows survive — and pins its own rows by id.
    const mockD1 = new MockD1Database();
    await seedD1Paused(mockD1);
    const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
    const pausedBefore = await d1Count(mockD1, "paused");
    const activeBefore = await d1Count(mockD1, "active");
    expect(pausedBefore).toBeGreaterThanOrEqual(2);
    const ctx = makeCtx(db, mockD1);
    const { body } = await postClear(ctx, { table: "unified_schedules", confirm: true }, ADMIN_LOGIN);
    expect(body.deleted).toBe(pausedBefore);
    expect(await store.get("p1")).toBeUndefined();
    expect(await store.get("p2")).toBeUndefined();
    expect(await store.get("a1")).toBeDefined();
    expect(await d1Count(mockD1, "paused")).toBe(0);
    expect(await d1Count(mockD1, "active")).toBe(activeBefore);
  });

  it("missing tables preview and confirm at zero, never 500", async () => {
    const fresh = new DatabaseSync(":memory:");
    const ctx = makeCtx(fresh);
    for (const table of ["mas_async_jobs", "mas_job_outcomes"] as const) {
      // Issue #6503 step 8b — mas_job_outcomes is gated, so the
      // missing-table tolerance is pinned as the platform-admin.
      const preview = await postClear(ctx, { table }, ADMIN_LOGIN);
      expect(preview.status).toBe(200);
      expect(preview.body.wouldDelete).toBe(0);
      const confirmed = await postClear(ctx, { table, confirm: true }, ADMIN_LOGIN);
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.deleted).toBe(0);
    }
  });
});

describe("POST /api/maintenance/clear-table — platform-admin gate (#6503 step 8b)", () => {
  let db: DatabaseSync;
  let mockD1: MockD1Database;
  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    seed(db);
    mockD1 = new MockD1Database();
    await seedD1Paused(mockD1);
  });

  it("anonymous preview and confirm of unified_schedules are 401 and delete nothing", async () => {
    const ctx = makeCtx(db, mockD1);
    const pausedBefore = await d1Count(mockD1, "paused");
    const preview = await postClear(ctx, { table: "unified_schedules" });
    expect(preview.status).toBe(401);
    const confirmed = await postClear(ctx, { table: "unified_schedules", confirm: true });
    expect(confirmed.status).toBe(401);
    expect(await d1Count(mockD1, "paused")).toBe(pausedBefore);
    // Issue #6503 step 9 (G2) — the refusals are audited (one
    // refusal event per refused call, naming the action, the table,
    // the reason, and anonymous); nothing is deleted either way.
    expect(ctx.audit).toHaveBeenCalledTimes(2);
    expect(ctx.audit).toHaveBeenCalledWith(
      "schedule.control-refused",
      "orchestrator",
      expect.objectContaining({
        action: "maintenance.table.cleared",
        scheduleId: "unified_schedules",
        table: "unified_schedules",
        callerLogin: "anonymous",
        callerLevel: "anonymous",
      }),
    );
  });

  it("a non-admin preview and confirm of unified_schedules are 403 and delete nothing", async () => {
    const ctx = makeCtx(db, mockD1);
    const pausedBefore = await d1Count(mockD1, "paused");
    const preview = await postClear(ctx, { table: "unified_schedules" }, "venus");
    expect(preview.status).toBe(403);
    const confirmed = await postClear(ctx, { table: "unified_schedules", confirm: true }, "venus");
    expect(confirmed.status).toBe(403);
    expect(await d1Count(mockD1, "paused")).toBe(pausedBefore);
  });

  it("platform-admin preview + confirm of unified_schedules still work (200)", async () => {
    const ctx = makeCtx(db, mockD1);
    const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
    const pausedBefore = await d1Count(mockD1, "paused");
    const activeBefore = await d1Count(mockD1, "active");
    const preview = await postClear(ctx, { table: "unified_schedules" }, ADMIN_LOGIN);
    expect(preview.status).toBe(200);
    expect(preview.body.confirmed).toBe(false);
    expect(preview.body.wouldDelete).toBe(pausedBefore);
    expect(await d1Count(mockD1, "paused")).toBe(pausedBefore);
    const confirmed = await postClear(ctx, { table: "unified_schedules", confirm: true }, ADMIN_LOGIN);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.deleted).toBe(pausedBefore);
    expect(await store.get("p1")).toBeUndefined();
    expect(await store.get("p2")).toBeUndefined();
    expect(await store.get("a1")).toBeDefined();
    expect(await d1Count(mockD1, "paused")).toBe(0);
    expect(await d1Count(mockD1, "active")).toBe(activeBefore);
    expect(ctx.audit).toHaveBeenCalledTimes(1);
  });

  it("mas_events is platform-admin only: 401 anonymous, 403 non-admin, 200 for the admin", async () => {
    const ctx = makeCtx(db, mockD1);
    expect((await postClear(ctx, { table: "mas_events" })).status).toBe(401);
    expect(
      (await postClear(ctx, { table: "mas_events", confirm: true, auditConfirm: true }, "venus")).status,
    ).toBe(403);
    expect(count(db, "SELECT COUNT(*) AS n FROM mas_events")).toBe(2);
    const preview = await postClear(ctx, { table: "mas_events" }, ADMIN_LOGIN);
    expect(preview.status).toBe(200);
    expect(preview.body.wouldDelete).toBe(2);
    const confirmed = await postClear(
      ctx,
      { table: "mas_events", confirm: true, auditConfirm: true },
      ADMIN_LOGIN,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.deleted).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM mas_events")).toBe(0);
  });

  it("mas_job_outcomes is platform-admin only (anonymous preview is 401)", async () => {
    const ctx = makeCtx(db, mockD1);
    expect((await postClear(ctx, { table: "mas_job_outcomes" })).status).toBe(401);
    expect((await postClear(ctx, { table: "mas_job_outcomes" }, "venus")).status).toBe(403);
  });

  it("mas_async_jobs stays ungated: the WorkflowRunsPanel prune is a legitimate non-admin use", async () => {
    // The prune is session-scoped (the caller's own rows only) and
    // never deletes running rows — see the gate comment in
    // src/agents/routes/maintenance.ts. Anonymous preview + confirm
    // still work, exactly as the general-user ledger calls them.
    const ctx = makeCtx(db, mockD1);
    const preview = await postClear(ctx, { table: "mas_async_jobs" });
    expect(preview.status).toBe(200);
    expect(preview.body.wouldDelete).toBe(3);
    const confirmed = await postClear(ctx, { table: "mas_async_jobs", confirm: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.deleted).toBe(3);
    expect(count(db, "SELECT COUNT(*) AS n FROM mas_async_jobs WHERE status = 'running'")).toBe(1);
  });
});
