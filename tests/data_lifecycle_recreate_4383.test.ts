// @vitest-environment node
/**
 * #4282 P5 — the recreate operation on the Data Lifecycle surface.
 *
 * POST /api/data-lifecycle/recreate, following the existing contract
 * (clean-state's preview → confirm → audit, same gates):
 * - Operator gate (platformTenants idiom: 401 unauthenticated, 403
 *   non-operator); platform scope additionally requires live
 *   platform-admin membership (resolveWiredCaller).
 * - Preview deletes nothing, writes no audit, and returns a
 *   previewToken — a SHA-256 over the canonical enumeration (scope +
 *   tenant + D1 planned steps + per-instance planned steps + failed
 *   codes). A confirm must present the token of a preview of the
 *   same scope; the server recomputes the enumeration and refuses
 *   (409) when the token is absent or stale.
 * - Platform scope additionally requires confirmText "CLEAN
 *   PLATFORM" + auditConfirm (the clean-state precedent).
 * - Execute: D1 leg (probe AGENT_DB → select → executeD1Leg →
 *   re-introspect + verify) then DO fan-out per login (preview
 *   fan-out to /maintenance/recreate-schema, re-preview at confirm
 *   for the token check, then confirm fan-out). The last report is
 *   stored in KV under a namespaced key. Audit AFTER writes via
 *   auditOperation (action data-lifecycle.recreate).
 * - AGENT_DB unbound → honest 503, never fabricated. A second run
 *   is a no-op. A mid-run failure yields a truthful partial report
 *   and a safe re-run. Uncreatable layers are reported in the
 *   preview and the result, never faked.
 *
 * Test doubles mirror production coupling where the codebase relies
 * on it: one fake KV backs aliases + the REAL KV membership store;
 * per-login instances delegate recreate-schema to the REAL
 * maintenance handler over node:sqlite; the D1 leg runs against a
 * MockD1Database (the #2288 idiom) passed as env.AGENT_DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  handleDataLifecycleRoutes,
  type DataLifecycleRouteContext,
  type DataLifecycleKvStores,
} from "../src/agents/routes/dataLifecycle";
import { handleMaintenanceRoutes } from "../src/agents/routes/maintenance";
import { createKvMembershipStore } from "../src/security/iaaaMembershipStore";
import {
  createMembership,
  type MembershipStore,
} from "../src/security/authorization";
import { recordLoginAlias } from "../src/security/iaaaMigration";
import {
  createMemoryAuditStore,
  type AuditStore,
} from "../src/security/iaaaAudit";
import type { KvLike } from "../src/security/kvResilience";
import type { SqlStorage } from "../src/orm";
import {
  planForLeg,
  resolveRecreatePlan,
} from "../src/data/schemaComponent/recreateRunner";

const PATH = "/api/data-lifecycle/recreate";
const OP = "op";
const OP_ID = "00000000-0000-4000-8000-0000000000a1";
const ALICE = "alice";
const BOB = "bob";
const LEGACY_SEED_CODE = "seed.d1.agent_price_catalogue.insert_from_legacy";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeKv(map: Map<string, string>): KvLike {
  return {
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    putIfAbsent: async (key: string, value: string) => {
      if (map.has(key)) return false;
      map.set(key, value);
      return true;
    },
  } as KvLike;
}

function makeStores(
  sessions: Map<string, string>,
  etrade: Map<string, string>,
): DataLifecycleKvStores {
  const listFrom =
    (map: Map<string, string>) =>
    async (prefix: string) =>
      [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
  return {
    listSessions: listFrom(sessions),
    getSessionKey: async (key) => sessions.get(key) ?? null,
    putSessionKey: async (key, value) => {
      sessions.set(key, value);
    },
    deleteSessionKey: async (key) => {
      sessions.delete(key);
    },
    listEtrade: listFrom(etrade),
    deleteEtradeKey: async (key) => {
      etrade.delete(key);
    },
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

/** D1 double over node:sqlite, in the #2288 shape. */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  batchCalls = 0;
  failBatchOnce = false;
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    this.batchCalls += 1;
    if (this.failBatchOnce) {
      this.failBatchOnce = false;
      throw new Error("test double: the D1 batch failed");
    }
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

interface FakeInstance {
  db: DatabaseSync;
  audit: ReturnType<typeof vi.fn>;
  fetch(req: Request): Promise<Response>;
}

function makeInstance(): FakeInstance {
  const db = new DatabaseSync(":memory:");
  const inst: FakeInstance = {
    db,
    audit: vi.fn(),
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path.endsWith("/maintenance/recreate-schema")) {
        const res = await handleMaintenanceRoutes(
          req,
          url,
          path,
          "sess-1",
          { agentCtx: { storage: { sql: makeSql(db) } } as any, audit: inst.audit },
        );
        return res ?? Response.json({ error: "no route" }, { status: 404 });
      }
      return Response.json({ error: "unknown instance path" }, { status: 404 });
    },
  };
  return inst;
}

interface World {
  sessions: Map<string, string>;
  d1: MockD1Database;
  instances: Map<string, FakeInstance>;
  auditStore: AuditStore;
  funnel: ReturnType<typeof vi.fn>;
  ctx: DataLifecycleRouteContext;
}

async function grant(
  store: MembershipStore,
  internalUserId: string,
  tenantId: string,
  role: string,
  scope: string,
) {
  const created = await createMembership(store, {
    internalUserId,
    tenantId,
    roleBindings: [{ role: role as any, scope: scope as any, grantedBy: "seed" }],
    createdBy: "seed",
    nowMs: 1000,
  });
  if (!created.ok) throw new Error(`seed grant failed: ${created.error}`);
}

async function makeWorld(
  overrides: Partial<DataLifecycleRouteContext> = {},
  envExtra: Record<string, unknown> = {},
): Promise<World> {
  const sessions = new Map<string, string>();
  const etrade = new Map<string, string>();
  const kv = makeKv(sessions);
  const membershipStore = createKvMembershipStore(kv);
  const auditStore = createMemoryAuditStore();
  const instances = new Map<string, FakeInstance>();
  const funnel = vi.fn();
  const d1 = new MockD1Database();
  // The framework-owned tables the D1 leg's indexes attach to.
  d1.sqlite.exec(
    `CREATE TABLE cf_agents_jobs (time TEXT, exclusive TEXT, singleflight TEXT, running TEXT, execution_started_at TEXT, hung_timeout_seconds TEXT)`,
  );
  d1.sqlite.exec(`CREATE TABLE unified_schedules (id TEXT, created_at TEXT)`);

  for (const [login, id] of [
    [OP, OP_ID],
    [ALICE, "user-alice"],
    [BOB, "user-bob"],
  ] as const) {
    await recordLoginAlias(kv, { githubLogin: login, internalUserId: id, nowMs: 1000 });
  }
  await grant(membershipStore, OP_ID, "primary", "platform-admin", "platform");
  await grant(membershipStore, "user-alice", "tenant-a", "tenant-admin", "tenant");
  await grant(membershipStore, "user-bob", "tenant-a", "member", "tenant");
  for (const login of [OP, ALICE, BOB]) {
    instances.set(login, makeInstance());
  }

  const directory = {
    async listTenantIds() {
      return ["tenant-a"];
    },
    async listTenantMembers(tenantId: string) {
      return tenantId === "tenant-a" ? [ALICE, BOB] : [];
    },
  };
  const env = {
    COMMERCIAL_STORE_OPERATORS: "",
    IAAA_TENANT_ID: "primary",
    AGENT_DB: d1,
    ...envExtra,
  };
  const ctx: DataLifecycleRouteContext = {
    env: env as any,
    audit: funnel,
    commercial: null,
    directory: directory as any,
    channels: null,
    operators: {
      listOperators: async () => [{ login: OP, addedBy: "seed", addedAtMs: 1 }],
    },
    kv,
    membershipStore,
    stores: makeStores(sessions, etrade),
    auditStore,
    fetchInstance: (login: string) => instances.get(login) ?? null,
    iaaaTenantId: "primary",
    ...overrides,
  };
  return { sessions, d1, instances, auditStore, funnel, ctx };
}

async function call(
  ctx: DataLifecycleRouteContext,
  path: string,
  method: string,
  login: string | null = OP,
  body?: unknown,
) {
  const req = new Request(`https://worker.test${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const url = new URL(`https://worker.test${path}`);
  const res = await handleDataLifecycleRoutes(req, url, url.pathname, "sess-1", ctx);
  if (!res) throw new Error(`route did not match ${path}`);
  return { status: res.status, body: (await res.json()) as any };
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) !== undefined
  );
}

function doPlaneCodes(): string[] {
  return planForLeg(resolveRecreatePlan(), "do").steps.map((s) => s.code);
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe("recreate gates (#4383)", () => {
  it("401 without a login, 403 for a non-operator, 403 for platform scope without platform-admin", async () => {
    const world = await makeWorld();
    const anon = await call(world.ctx, PATH, "POST", null, { scope: "tenant", tenantId: "tenant-a" });
    expect(anon.status).toBe(401);
    const nonOp = await call(world.ctx, PATH, "POST", ALICE, { scope: "tenant", tenantId: "tenant-a" });
    expect(nonOp.status).toBe(403);
    // Alice is a tenant-admin, not a platform-admin: platform scope is refused.
    const platform = await call(world.ctx, PATH, "POST", ALICE, { scope: "platform" });
    expect(platform.status).toBe(403);
  });

  it("503 when AGENT_DB is unbound — honest, never fabricated", async () => {
    const world = await makeWorld({}, { AGENT_DB: undefined });
    const { status, body } = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
    });
    expect(status).toBe(503);
    expect(body.error).toContain("AGENT_DB");
    expect(world.d1.batchCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Preview → confirm, tenant scope
// ---------------------------------------------------------------------------

describe("recreate, tenant scope (#4383)", () => {
  it("preview plans the D1 leg and the per-instance DO legs without executing or auditing", async () => {
    const world = await makeWorld();
    const { status, body } = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
    });
    expect(status).toBe(200);
    expect(body.confirmed).toBe(false);
    expect(body.confirmRequired).toBe(true);
    expect(typeof body.previewToken).toBe("string");
    expect(body.previewToken).toHaveLength(64);
    // D1 leg: the fresh selection (238 schema + 12 seeds). Issue #4654 adds one
    // more ORM-plane entry to the catalogue, so the D1 leg skips one more.
    // Issue #5229 adds migration 0069 (agent_referral_rules expiry_period_ms
    // column): 247 → 248. Issue #5086 adds migration 0070
    // (otel_config_overrides table): 248 → 249.
    // Issue #4767 adds migrations 0071/0072 (4 D1 ALTERs): 249 → 253.
    // Issue #5865 adds migration 0074 (definition history table + D1
    // backfill seed): 253 → 255.
    // Issue #4204 adds migration 0073 (D1 job_run_records
    // recent-read index): the D1 step is selected and the ORM
    // plane's duplicate of the same index is skipped, so selected
    // stays 253 and skipped grows 8 → 9.
    // Issue #3185 bridge adds migration 0077 (agent_usage_events
    // mirror table + 2 indexes): 257 → 260.
    // Issue #5423 adds migration 0078 (agent_tenant_settings
    // turn_step_timeout_ms column): 260 → 261.
    // Issue #5425 adds migration 0079 (agent_tenant_settings
    // SLO threshold columns): 261 → 263.
    expect(body.d1.selected).toHaveLength(263);
    expect(body.d1.skipped).toHaveLength(9);
    // Two member instances (alice, bob), each planning the fresh DO leg.
    expect(body.instances).toHaveLength(2);
    for (const inst of body.instances) {
      // #4767 adds migrations 0071/0072 (4 remainder ALTERs): 132 → 136.
      // Issue #3185 adds the usage_events tenant index to the DO leg: 139 → 140.
      expect(inst.selected).toHaveLength(140);
      // Issue #4623 adds one probed DO statement (mas_async_jobs.tenant_id).
      // Issue #3185 adds one probed DO statement (usage_events.tenant_id):
      // the fresh CREATE TABLE already carries the column, so the ALTER
      // is probed-and-skipped: 36 → 37.
      expect(inst.skipped).toHaveLength(37);
    }
    expect(body.uncreatableLayers).toHaveLength(5);
    // Nothing executed: the D1 store and the member instances are
    // still empty.
    expect(tableExists(world.d1.sqlite, "agent_price_catalogue")).toBe(false);
    for (const login of [ALICE, BOB]) {
      expect(tableExists(world.instances.get(login)!.db, "mas_reports")).toBe(false);
    }
    expect(world.funnel).not.toHaveBeenCalled();
  });

  it("confirm without a token, and with a stale token, is refused and executes nothing", async () => {
    const world = await makeWorld();
    const noToken = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      auditConfirm: true,
    });
    expect(noToken.status).toBe(409);
    expect(world.d1.batchCalls).toBe(0);
    const preview = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
    });
    const stale = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      auditConfirm: true,
      previewToken: "0".repeat(64),
    });
    expect(stale.status).toBe(409);
    expect(world.d1.batchCalls).toBe(0);
    expect(preview.body.previewToken).not.toBe("0".repeat(64));
  });

  it("confirm executes the D1 leg and the per-instance DO legs, verifies, audits, and stores the last report", async () => {
    const world = await makeWorld();
    const preview = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
    });
    const { status, body } = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      auditConfirm: true,
      previewToken: preview.body.previewToken,
    });
    expect(status).toBe(200);
    expect(body.confirmed).toBe(true);
    expect(body.d1.report.outcome).toBe("succeeded");
    // #4767 adds migrations 0071/0072 (4 D1 ALTERs): 249 → 253.
    // #3185 bridge adds migration 0077 (agent_usage_events mirror
    // table + 2 indexes): 257 → 260.
    // Issue #5423 adds migration 0078 (agent_tenant_settings
    // turn_step_timeout_ms column): 260 → 261.
    // Issue #5425 adds migration 0079 (agent_tenant_settings
    // SLO threshold columns): 261 → 263.
    expect(body.d1.report.executed).toHaveLength(263);
    expect(body.d1.verification.ok).toBe(true);
    expect(body.instances).toHaveLength(2);
    for (const inst of body.instances) {
      expect(inst.report.outcome).toBe("succeeded");
      // #4767 adds migrations 0071/0072 (4 remainder ALTERs): 132 → 136.
      // Issue #3185 adds the usage_events tenant index to the DO leg: 139 → 140.
      expect(inst.report.executed).toHaveLength(140);
      expect(inst.verification.ok).toBe(true);
    }
    expect(body.uncreatableLayers).toHaveLength(5);
    expect(world.d1.batchCalls).toBe(1);
    expect(tableExists(world.d1.sqlite, "agent_price_catalogue")).toBe(true);
    // Tenant scope touches only the tenant's member instances
    // (alice, bob) — the operator's own instance is not a member
    // and is left alone.
    for (const login of [ALICE, BOB]) {
      expect(tableExists(world.instances.get(login)!.db, "mas_reports")).toBe(true);
    }
    expect(tableExists(world.instances.get(OP)!.db, "mas_reports")).toBe(false);
    // Audit AFTER the writes, through the funnel.
    expect(world.funnel).toHaveBeenCalledTimes(1);
    expect(world.funnel).toHaveBeenCalledWith(
      "data-lifecycle.recreate",
      "orchestrator",
      expect.objectContaining({ scope: "tenant", tenantId: "tenant-a" }),
    );
    expect(body.audit.funnel).toBe(true);
    expect(body.audit.auditLog.ok).toBe(true);
    // The last report is stored in KV under a namespaced key.
    const lastKey = "data-lifecycle:recreate:last:tenant:tenant-a";
    const stored = world.sessions.get(lastKey);
    expect(stored).toBeDefined();
    const storedReport = JSON.parse(stored!);
    expect(storedReport.d1.report.outcome).toBe("succeeded");
    expect(storedReport.instances).toHaveLength(2);
  });

  it("a second run is a no-op on both legs", async () => {
    const world = await makeWorld();
    const preview = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
    });
    await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      auditConfirm: true,
      previewToken: preview.body.previewToken,
    });
    const preview2 = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
    });
    expect(preview2.body.d1.selected).toHaveLength(0);
    for (const inst of preview2.body.instances) {
      expect(inst.selected).toHaveLength(0);
    }
    const { body } = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      auditConfirm: true,
      previewToken: preview2.body.previewToken,
    });
    expect(body.d1.report.executed).toHaveLength(0);
    expect(body.d1.verification.ok).toBe(true);
    for (const inst of body.instances) {
      expect(inst.report.executed).toHaveLength(0);
      expect(inst.verification.ok).toBe(true);
    }
    // The second run's D1 leg selects zero steps, so no batch is
    // sent at all (the aspect only calls batch() when the unit
    // buffered statements) — batchCalls stays at the first run's 1.
    expect(world.d1.batchCalls).toBe(1);
  });

  it("a failed D1 batch yields a truthful partial report and a safe re-run", async () => {
    const world = await makeWorld();
    world.d1.failBatchOnce = true;
    const preview = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
    });
    const { status, body } = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      auditConfirm: true,
      previewToken: preview.body.previewToken,
    });
    expect(status).toBe(200);
    expect(body.d1.report.outcome).toBe("failed");
    expect(body.d1.report.executed).toEqual([]);
    expect(body.d1.verification.ok).toBe(false);
    // The DO legs still ran (independent stores) and succeeded.
    for (const inst of body.instances) {
      expect(inst.report.outcome).toBe("succeeded");
    }
    expect(body.audit.auditLog.ok).toBe(true);
    expect(tableExists(world.d1.sqlite, "agent_price_catalogue")).toBe(false);
    // Safe re-run: a fresh preview + confirm now succeeds.
    const preview2 = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
    });
    const retry = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      auditConfirm: true,
      previewToken: preview2.body.previewToken,
    });
    expect(retry.body.d1.report.outcome).toBe("succeeded");
    expect(retry.body.d1.verification.ok).toBe(true);
    expect(tableExists(world.d1.sqlite, "agent_price_catalogue")).toBe(true);
  });

  it("a failed seed can be re-selected by passing its code (failedCodes)", async () => {
    const world = await makeWorld();
    // Healthy store (after a full run): nothing is selected — until
    // the client names the failed seed, which re-selects it alone.
    const preview = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
    });
    await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      auditConfirm: true,
      previewToken: preview.body.previewToken,
    });
    const { body } = await call(world.ctx, PATH, "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      failedCodes: [LEGACY_SEED_CODE],
    });
    expect(body.d1.selected).toHaveLength(1);
    expect(body.d1.selected[0].code).toBe(LEGACY_SEED_CODE);
  });
});

// ---------------------------------------------------------------------------
// Platform scope
// ---------------------------------------------------------------------------

describe("recreate, platform scope (#4383)", () => {
  it("requires confirmText CLEAN PLATFORM and auditConfirm, and fans out to every member instance", async () => {
    const world = await makeWorld();
    const preview = await call(world.ctx, PATH, "POST", OP, { scope: "platform" });
    expect(preview.status).toBe(200);
    // Platform scope covers every member instance (op + alice + bob).
    expect(preview.body.instances).toHaveLength(3);
    const noText = await call(world.ctx, PATH, "POST", OP, {
      scope: "platform",
      confirm: true,
      auditConfirm: true,
      previewToken: preview.body.previewToken,
    });
    expect(noText.status).toBe(400);
    const noAudit = await call(world.ctx, PATH, "POST", OP, {
      scope: "platform",
      confirm: true,
      confirmText: "CLEAN PLATFORM",
      previewToken: preview.body.previewToken,
    });
    expect(noAudit.status).toBe(400);
    const { status, body } = await call(world.ctx, PATH, "POST", OP, {
      scope: "platform",
      confirm: true,
      confirmText: "CLEAN PLATFORM",
      auditConfirm: true,
      previewToken: preview.body.previewToken,
    });
    expect(status).toBe(200);
    expect(body.d1.report.outcome).toBe("succeeded");
    expect(body.instances).toHaveLength(3);
    for (const inst of body.instances) {
      expect(inst.report.outcome).toBe("succeeded");
    }
    const lastKey = "data-lifecycle:recreate:last:platform:platform";
    expect(world.sessions.get(lastKey)).toBeDefined();
  });
});
