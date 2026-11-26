/**
 * Issue #2489 — selective wipe: new clear-table rows (meta, events),
 * events export, and the KV wipe route.
 *
 * TDD: the meta/events branches and the KV route are new behavior;
 * the events gate (auditConfirm) and the marker coupling are the
 * fail-closed rules. The maintenance harness mirrors
 * tests/maintenanceClearTable.test.ts (node:sqlite + SqlStorage
 * adapter); the KV route uses in-memory fake stores via its ctx seams.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  handleMaintenanceRoutes,
  type MaintenanceRouteContext,
} from "../src/agents/routes/maintenance";
import {
  handleKvWipeRoutes,
  type KvWipeRouteContext,
  type KvWipeStores,
} from "../src/agents/routes/kvWipe";
import type { SqlStorage } from "../src/orm";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";

// Issue #6503 step 8b — the clear-table rows this file pins are all
// platform-admin only, so the fixture carries the platform-admin
// identity (same stub shape as tests/maintenanceClearTable.test.ts).
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
  db.exec(`CREATE TABLE mas_job_outcomes (id TEXT PRIMARY KEY, kind TEXT, trigger TEXT, status TEXT, created_at TEXT)`);
  db.exec(`CREATE TABLE mas_job_outcomes_meta (k TEXT PRIMARY KEY, v TEXT)`);
  db.exec(`CREATE TABLE mas_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, agent TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, previous_event_hash TEXT, event_hash TEXT)`);
  db.prepare(`INSERT INTO mas_job_outcomes (id, kind, trigger, status, created_at) VALUES ('o1', 'options', 'manual', 'completed', '2026-10-29')`).run();
  db.prepare(`INSERT INTO mas_job_outcomes_meta (k, v) VALUES ('pruned_at', '2026-10-29T00:00:00.000Z')`).run();
  const ev = db.prepare(`INSERT INTO mas_events (id, session_id, type, agent, payload, created_at) VALUES (?, 'sess-1', 't', 'orchestrator', '{}', '2026-10-29')`);
  ev.run("e1");
  ev.run("e2");
}

function makeCtx(db: DatabaseSync) {
  const ctx = {
    agentCtx: { storage: { sql: makeSql(db) } },
    audit: vi.fn(),
    // Issue #6503 step 9 (G2) — the gated clear-table audit blocks
    // without a working audit store; the fixture carries the
    // memory store (same pattern as maintenanceClearTable.test.ts).
    auditStore: createMemoryAuditStore(),
    getScreenerExecutionContext: async () => undefined,
    flagAliasKv: stubKv({ [ADMIN_LOGIN]: ADMIN_USER_ID }),
    flagMembershipStore: stubMembershipStore(),
  } as unknown as MaintenanceRouteContext;
  return ctx;
}

async function postMaintenance(
  ctx: MaintenanceRouteContext,
  path: string,
  body: Record<string, unknown>,
  method = "POST",
) {
  const req = new Request(`https://agent.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-user-login": ADMIN_LOGIN },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  const res = await handleMaintenanceRoutes(req, new URL(`https://agent.test${path}`), path, "sess-1", ctx);
  return { status: res!.status, body: (await res!.json()) as any };
}

async function getMaintenance(ctx: MaintenanceRouteContext, path: string) {
  const req = new Request(`https://agent.test${path}`, { method: "GET" });
  const res = await handleMaintenanceRoutes(req, new URL(`https://agent.test${path}`), path, "sess-1", ctx);
  return { status: res!.status, body: (await res!.json()) as any };
}

describe("POST /api/maintenance/clear-table — new rows (#2489)", () => {
  let db: DatabaseSync;
  let ctx: MaintenanceRouteContext;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    seed(db);
    ctx = makeCtx(db);
  });

  it("previews and clears mas_job_outcomes_meta without touching outcomes", async () => {
    const preview = await postMaintenance(ctx, "/api/maintenance/clear-table", { table: "mas_job_outcomes_meta" });
    expect(preview.body.wouldDelete).toBe(1);
    const confirmed = await postMaintenance(ctx, "/api/maintenance/clear-table", { table: "mas_job_outcomes_meta", confirm: true });
    expect(confirmed.body.deleted).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM mas_job_outcomes_meta").get() as any).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM mas_job_outcomes").get() as any).n).toBe(1);
  });

  it("clearing outcomes still preserves the meta watermark", async () => {
    const confirmed = await postMaintenance(ctx, "/api/maintenance/clear-table", { table: "mas_job_outcomes", confirm: true });
    expect(confirmed.body.deleted).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM mas_job_outcomes_meta").get() as any).n).toBe(1);
  });

  it("mas_events preview counts, confirm without auditConfirm is refused and deletes nothing", async () => {
    const preview = await postMaintenance(ctx, "/api/maintenance/clear-table", { table: "mas_events" });
    expect(preview.body.wouldDelete).toBe(2);
    const refused = await postMaintenance(ctx, "/api/maintenance/clear-table", { table: "mas_events", confirm: true });
    expect(refused.status).toBe(400);
    expect((db.prepare("SELECT COUNT(*) AS n FROM mas_events").get() as any).n).toBe(2);
  });

  it("mas_events confirm with auditConfirm deletes and audits after (surviving record)", async () => {
    const confirmed = await postMaintenance(ctx, "/api/maintenance/clear-table", { table: "mas_events", confirm: true, auditConfirm: true });
    expect(confirmed.body.deleted).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM mas_events").get() as any).n).toBe(0);
    expect(ctx.audit).toHaveBeenCalledWith(
      "maintenance.table.cleared",
      "orchestrator",
      expect.objectContaining({ table: "mas_events", deletedCount: 2 }),
    );
  });
});

describe("GET /api/maintenance/events-export (#2489)", () => {
  it("returns instance rows with a truncated flag", async () => {
    const db = new DatabaseSync(":memory:");
    seed(db);
    const ctx = makeCtx(db);
    const out = await getMaintenance(ctx, "/api/maintenance/events-export");
    expect(out.status).toBe(200);
    expect(out.body.count).toBe(2);
    expect(out.body.truncated).toBe(false);
    expect(out.body.events).toHaveLength(2);
  });

  it("caps at 5000 rows and flags truncation", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE mas_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, agent TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, previous_event_hash TEXT, event_hash TEXT)`);
    const insert = db.prepare(`INSERT INTO mas_events (id, session_id, type, agent, payload, created_at) VALUES (?, 's', 't', 'orchestrator', '{}', '2026-10-29')`);
    for (let i = 0; i < 5001; i++) insert.run(`e${i}`);
    const ctx = makeCtx(db);
    const out = await getMaintenance(ctx, "/api/maintenance/events-export");
    expect(out.body.count).toBe(5000);
    expect(out.body.truncated).toBe(true);
    expect(out.body.events).toHaveLength(5000);
  });
});

// ---- KV wipe route ----

function makeKvStores(): { stores: KvWipeStores; sessions: Map<string, string>; etrade: Map<string, string>; order: string[] } {
  const sessions = new Map<string, string>();
  const etrade = new Map<string, string>();
  const order: string[] = [];
  const stores: KvWipeStores = {
    listSessions: async (prefix) =>
      [...sessions.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
    getSessionKey: async (key) => sessions.get(key) ?? null,
    deleteSessionKey: async (key) => {
      order.push(`sessions:${key}`);
      sessions.delete(key);
    },
    listEtrade: async (prefix) =>
      [...etrade.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
    deleteEtradeKey: async (key) => {
      order.push(`etrade:${key}`);
      etrade.delete(key);
    },
  };
  return { stores, sessions, etrade, order };
}

function makeKvCtx(
  stores: KvWipeStores,
  admin = true,
): KvWipeRouteContext {
  const aliasKv = {
    get: async (key: string) =>
      key === "iaaa-alias:login:admin"
        ? JSON.stringify({ internalUserId: "user-admin", githubLogin: "admin" })
        : null,
    put: async () => {},
    delete: async () => {},
  };
  const membershipStore = {
    getMembershipsByUser: async (id: string) =>
      id === "user-admin" && admin
        ? [{ tenantId: "platform", roleBindings: [{ role: "platform-admin", scope: "platform" }] }]
        : [],
  };
  return {
    env: {} as any,
    audit: vi.fn(),
    stores,
    aliasKv: aliasKv as any,
    membershipStore: membershipStore as any,
    tenantId: "primary",
  };
}

async function postKv(
  ctx: KvWipeRouteContext,
  body: Record<string, unknown>,
  headers: Record<string, string> = { "x-user-login": "admin" },
) {
  const req = new Request("https://agent.test/api/maintenance/kv-wipe", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const res = await handleKvWipeRoutes(req, new URL("https://agent.test/api/maintenance/kv-wipe"), "/api/maintenance/kv-wipe", "sess-1", ctx);
  return { status: res!.status, body: (await res!.json()) as any };
}

function seedKv(sessions: Map<string, string>, etrade: Map<string, string>) {
  sessions.set("iaaa-membership:m1", "{}");
  sessions.set("iaaa-membership:user:user-admin", '["m1"]');
  sessions.set("iaaa-binding:https://github.com\u000082253453", "{}");
  sessions.set("iaaa-alias:login:admin", "{}");
  sessions.set("iaaa-bootstrap:platform-genesis:primary", "{}");
  sessions.set("11111111-2222-3333-4444-555555555555", "{}");
  sessions.set("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "{}");
  etrade.set("etrade:token:PROD:admin", "{}");
  etrade.set("etrade:token:TEST:admin", "{}");
}

describe("POST /api/maintenance/kv-wipe (#2489)", () => {
  it("previews per-row counts without deleting", async () => {
    const { stores, sessions, etrade } = makeKvStores();
    seedKv(sessions, etrade);
    const ctx = makeKvCtx(stores);
    const out = await postKv(ctx, { rows: ["memberships", "tokens", "bindings", "marker", "sessions"] });
    expect(out.status).toBe(200);
    expect(out.body.confirmed).toBe(false);
    const byRow = Object.fromEntries(out.body.rows.map((r: any) => [r.row, r.count]));
    expect(byRow).toEqual({ memberships: 2, tokens: 2, bindings: 2, marker: 1, sessions: 2 });
    expect(sessions.size).toBe(7);
    expect(etrade.size).toBe(2);
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("confirm executes in safe order with sessions last and verifies counts", async () => {
    const { stores, sessions, etrade, order } = makeKvStores();
    seedKv(sessions, etrade);
    const ctx = makeKvCtx(stores);
    const out = await postKv(ctx, { rows: ["sessions", "tokens", "memberships", "bindings", "marker"], confirm: true });
    expect(out.status).toBe(200);
    expect(out.body.confirmed).toBe(true);
    const byRow = Object.fromEntries(out.body.rows.map((r: any) => [r.row, r.count]));
    expect(byRow).toEqual({ memberships: 2, marker: 1, tokens: 2, bindings: 2, sessions: 2 });
    expect(sessions.size).toBe(0);
    expect(etrade.size).toBe(0);
    // Sessions deletes come after every other row's deletes.
    const firstSessionDelete = order.findIndex((o) => o.startsWith("sessions:11111111") || o.startsWith("sessions:aaaaaaaa"));
    const lastNonSessionDelete = Math.max(
      ...order.map((o, i) => (o.startsWith("sessions:11111111") || o.startsWith("sessions:aaaaaaaa") ? -1 : i)),
    );
    expect(firstSessionDelete).toBeGreaterThan(lastNonSessionDelete);
  });

  it("memberships without marker couples the marker (no platform lockout)", async () => {
    const { stores, sessions, etrade } = makeKvStores();
    seedKv(sessions, etrade);
    const ctx = makeKvCtx(stores);
    const out = await postKv(ctx, { rows: ["memberships"], confirm: true });
    const markerRow = out.body.rows.find((r: any) => r.row === "marker");
    expect(markerRow).toBeDefined();
    expect(markerRow.coupled).toBe(true);
    expect(markerRow.count).toBe(1);
    expect(sessions.has("iaaa-bootstrap:platform-genesis:primary")).toBe(false);
  });

  it("sessions row excludes iaaa-* keys owned by other rows", async () => {
    const { stores, sessions, etrade } = makeKvStores();
    seedKv(sessions, etrade);
    const ctx = makeKvCtx(stores);
    const out = await postKv(ctx, { rows: ["sessions"], confirm: true });
    expect(out.body.rows).toEqual([{ row: "sessions", count: 2 }]);
    expect(sessions.has("iaaa-membership:m1")).toBe(true);
    expect(sessions.has("iaaa-bootstrap:platform-genesis:primary")).toBe(true);
    expect(sessions.has("11111111-2222-3333-4444-555555555555")).toBe(false);
  });

  it("rejects non-platform-admin callers and unauthenticated callers", async () => {
    const { stores } = makeKvStores();
    const denied = await postKv(makeKvCtx(stores, false), { rows: ["tokens"], confirm: true });
    expect(denied.status).toBe(403);
    const unauth = await postKv(makeKvCtx(stores), { rows: ["tokens"], confirm: true }, {});
    expect(unauth.status).toBe(401);
  });

  it("rejects unknown rows and empty selection", async () => {
    const { stores } = makeKvStores();
    const ctx = makeKvCtx(stores);
    expect((await postKv(ctx, { rows: ["nope"], confirm: true })).status).toBe(400);
    expect((await postKv(ctx, { rows: [], confirm: true })).status).toBe(400);
  });

  it("a row with unavailable listing fails that row only", async () => {
    const { stores, sessions, etrade } = makeKvStores();
    seedKv(sessions, etrade);
    const failing: KvWipeStores = {
      ...stores,
      listEtrade: async () => null,
    };
    const ctx = makeKvCtx(failing);
    const out = await postKv(ctx, { rows: ["tokens", "marker"], confirm: true });
    const byRow = Object.fromEntries(out.body.rows.map((r: any) => [r.row, r]));
    expect(byRow.tokens.error).toMatch(/listing unavailable/);
    expect(byRow.marker.count).toBe(1);
    expect(etrade.size).toBe(2);
    expect(sessions.has("iaaa-bootstrap:platform-genesis:primary")).toBe(false);
  });
});
