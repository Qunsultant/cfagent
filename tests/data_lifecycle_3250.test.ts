/**
 * Issue #3250 (#1976 scope addition) — admin data lifecycle routes.
 *
 * Three preview → confirm → audit operations in the Platform Admin
 * neighbourhood:
 *   POST /api/data-lifecycle/clean-state     tenant + platform scope
 *   GET  /api/data-lifecycle/export          pre-wipe bundle
 *   GET  /api/data-lifecycle/bootstrap       platform bootstrap check
 *   POST /api/data-lifecycle/bootstrap       platform bootstrap initialize
 *   POST /api/data-lifecycle/tenant-bootstrap  per-tenant bootstrap
 *
 * Contract pins:
 * - Operator gate (platformTenants idiom: env COMMERCIAL_STORE_
 *   OPERATORS ∪ store operators). Platform clean state and the
 *   tenant-genesis claim additionally require platform-admin
 *   membership (kvWipe idiom / Slice 3 grant rule).
 * - Confirm is bound to a preview: the confirm body must carry the
 *   previewToken issued by a preview of the SAME scope; a confirm
 *   without one, or with a stale one, is refused and deletes
 *   nothing.
 * - Clean-state definitions are the exported enumerated target
 *   sets; the exact sets are pinned below (an added target fails).
 * - Tenant scope touches only that tenant's memberships, genesis
 *   marker, member sessions, and member instances (the #2457
 *   per-login instance fan-out); the platform-global audit chain,
 *   D1 directory/commercial records, and claim buckets are never
 *   in tenant scope.
 * - Every confirmed operation audits AFTER its clears, through
 *   both the orchestrator funnel (mas_events idiom) and the
 *   AuditLog port (recordAuditEvent over the wired store); for
 *   platform scope the audit segments are cleared first, so the
 *   operation's own record is the fresh chain's surviving event.
 *
 * Test doubles mirror production coupling where the codebase
 * relies on it: one fake KV backs aliases + the REAL KV membership
 * store; per-login instances delegate clear-table to the REAL
 * maintenance handler over node:sqlite (the selective_wipe_2489
 * harness), and emulate cancel-all's response contract (its own
 * suite covers the handler); the in-memory directory registers a
 * tenant when the wrapped commercial adapter writes its settings
 * row, mirroring the shared-D1 semantics both production adapters
 * read (see inMemoryTenantDirectoryAdapter.ts header).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  handleDataLifecycleRoutes,
  TENANT_CLEAN_TARGETS,
  PLATFORM_CLEAN_TARGETS,
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
import { createInMemoryAuditPorts } from "../src/data/createAuditPorts";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import type { TenantDirectory } from "../src/data/tenantDirectoryPorts";
import { InMemoryTenantChannelAdapter } from "../src/data/inMemoryTenantChannelAdapter";
import { platformGenesisMarkerKey } from "../src/security/iaaaGithubEndToEnd";
import type { KvLike } from "../src/security/kvResilience";
import type { SqlStorage } from "../src/orm";

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

function seedInstanceDb(db: DatabaseSync) {
  db.exec(`CREATE TABLE mas_async_jobs (
    job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, capability TEXT NOT NULL,
    display_name TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
    result_json TEXT, response_status INTEGER, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    started_at TEXT, completed_at TEXT
  )`);
  db.exec(`CREATE TABLE mas_job_outcomes (id TEXT PRIMARY KEY, kind TEXT, trigger TEXT, status TEXT, scanned INTEGER, matched INTEGER, coded_error TEXT, report_url TEXT, pdf_key TEXT, xlsx_key TEXT, csv_key TEXT, delivery_json TEXT, origin TEXT, created_at TEXT)`);
  db.exec(`CREATE TABLE mas_job_outcomes_meta (k TEXT PRIMARY KEY, v TEXT)`);
  db.exec(`CREATE TABLE mas_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, agent TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, previous_event_hash TEXT, event_hash TEXT)`);
  db.exec(`CREATE TABLE paused_schedules (
    id TEXT PRIMARY KEY, callback TEXT NOT NULL, payload_json TEXT,
    sched_type TEXT NOT NULL, cron TEXT, interval_seconds INTEGER,
    time INTEGER, delay_seconds INTEGER, paused_at TEXT NOT NULL
  )`);
  const job = db.prepare(
    "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at) VALUES (?, 'sess-1', 'c', 'd', ?, '{}', '2026-10-29', '2026-10-29')",
  );
  job.run("j1", "queued");
  job.run("j2", "running");
  const outcome = db.prepare("INSERT INTO mas_job_outcomes (id, kind, trigger, status, created_at) VALUES (?, 'options', 'manual', 'completed', '2026-10-29')");
  outcome.run("o1");
  db.prepare("INSERT INTO mas_job_outcomes_meta (k, v) VALUES ('pruned_at', '2026-10-29T00:00:00.000Z')").run();
  const ev = db.prepare("INSERT INTO mas_events (id, session_id, type, agent, payload, created_at) VALUES (?, 'sess-1', 't', 'orchestrator', '{}', '2026-10-29')");
  ev.run("e1");
  ev.run("e2");
}

interface FakeInstance {
  schedules: Array<{ id: string; callback: string }>;
  paused: number;
  db: DatabaseSync;
  audit: ReturnType<typeof vi.fn>;
  fetch(req: Request): Promise<Response>;
}

function makeInstance(): FakeInstance {
  const db = new DatabaseSync(":memory:");
  seedInstanceDb(db);
  const inst: FakeInstance = {
    schedules: [
      { id: "s1", callback: "autonomousMarketScreen" },
      { id: "s2", callback: "autoRenewETradeTokens" },
    ],
    paused: 1,
    db,
    audit: vi.fn(),
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path.endsWith("/schedules/cancel-all")) {
        const body = (await req.json().catch(() => ({}))) as any;
        if (body.confirm !== true) {
          return Response.json({
            cancelled: 0,
            confirmRequired: true,
            wouldCancel: inst.schedules.map((s) => ({ id: s.id, callback: s.callback })),
            wouldCancelCount: inst.schedules.length,
            pausedPreserved: inst.paused,
          });
        }
        const n = inst.schedules.length;
        inst.schedules = [];
        return Response.json({
          cancelled: n,
          cancelledIds: [],
          failed: [],
          pausedPreserved: inst.paused,
        });
      }
      if (path.endsWith("/maintenance/clear-table")) {
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

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

interface World {
  sessions: Map<string, string>;
  etrade: Map<string, string>;
  kv: KvLike;
  membershipStore: MembershipStore;
  commercial: InMemoryCommercialAdapter;
  directory: TenantDirectory & { register(tenantId: string, members: string[]): void };
  channels: InMemoryTenantChannelAdapter;
  auditStore: AuditStore;
  instances: Map<string, FakeInstance>;
  funnel: ReturnType<typeof vi.fn>;
  ctx: DataLifecycleRouteContext;
}

const OP = "op";
const OP_ID = "00000000-0000-4000-8000-0000000000a1";
const ALICE = "alice";
const BOB = "bob";
const CAROL = "carol";
const FOUNDER = "founder";

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
  const commercial = new InMemoryCommercialAdapter();
  const directoryRows = new Map<string, string[]>();
  const directory: World["directory"] = {
    register(tenantId, members) {
      directoryRows.set(tenantId, members);
    },
    async listTenantIds() {
      return [...directoryRows.keys()].sort();
    },
    async listTenantMembers(tenantId) {
      return [...(directoryRows.get(tenantId) ?? [])].sort();
    },
  };
  // Mirror the shared-D1 coupling: a settings-row write registers
  // the tenant in the directory (both production adapters read the
  // same database; see platformTenants.ts create).
  const rawSetAds = commercial.setTenantAdsEnabled.bind(commercial);
  commercial.setTenantAdsEnabled = async (tenantId: string, ads: boolean) => {
    const out = await rawSetAds(tenantId, ads);
    if (!directoryRows.has(tenantId)) directoryRows.set(tenantId, []);
    return out;
  };
  const channels = new InMemoryTenantChannelAdapter();
  const auditStore = createMemoryAuditStore();
  const instances = new Map<string, FakeInstance>();
  const funnel = vi.fn();

  // Aliases (real writer) for every login.
  for (const [login, id] of [
    [OP, OP_ID],
    [ALICE, "user-alice"],
    [BOB, "user-bob"],
    [CAROL, "user-carol"],
    [FOUNDER, "user-founder"],
  ] as const) {
    await recordLoginAlias(kv, { githubLogin: login, internalUserId: id, nowMs: 1000 });
  }
  // Memberships: op is platform-admin (primary); alice + bob in
  // tenant-a; carol in tenant-b.
  await grant(membershipStore, OP_ID, "primary", "platform-admin", "platform");
  await grant(membershipStore, "user-alice", "tenant-a", "tenant-admin", "tenant");
  await grant(membershipStore, "user-bob", "tenant-a", "member", "tenant");
  await grant(membershipStore, "user-carol", "tenant-b", "tenant-admin", "tenant");
  // Genesis markers for both tenants.
  sessions.set(
    platformGenesisMarkerKey("tenant-a"),
    JSON.stringify({ grantedTo: "user-alice", tenantId: "tenant-a", atMs: 900 }),
  );
  sessions.set(
    platformGenesisMarkerKey("tenant-b"),
    JSON.stringify({ grantedTo: "user-carol", tenantId: "tenant-b", atMs: 900 }),
  );
  // Session records (bare UUID keys; SessionData-shaped values).
  const sessionValue = (login: string, id: string) =>
    JSON.stringify({ githubLogin: login, githubAvatar: "", githubName: login, createdAt: 1, internalUserId: id });
  sessions.set("11111111-1111-4111-8111-111111111111", sessionValue(ALICE, "user-alice"));
  sessions.set("22222222-2222-4222-8222-222222222222", sessionValue(CAROL, "user-carol"));
  sessions.set("33333333-3333-4333-8333-333333333333", sessionValue(OP, OP_ID));
  // One pre-existing audit segment + broker token.
  sessions.set("iaaa-audit:seg:0001", JSON.stringify([{ id: "old-event" }]));
  etrade.set("etrade:token:PROD:alice", "{}");
  // Instances for every login.
  for (const login of [OP, ALICE, BOB, CAROL, FOUNDER]) {
    instances.set(login, makeInstance());
  }
  // Directory tenants (account-row world, as in #2221).
  directory.register("tenant-a", [ALICE, BOB]);
  directory.register("tenant-b", [CAROL]);
  await commercial.setTenantAdsEnabled("tenant-a", true);
  await commercial.setTenantAdsEnabled("tenant-b", true);

  const env = {
    COMMERCIAL_STORE_OPERATORS: "",
    IAAA_TENANT_ID: "primary",
    IAAA_BOOTSTRAP_ADMINS: `platform:${OP_ID}`,
    ...envExtra,
  };
  const ctx: DataLifecycleRouteContext = {
    env: env as any,
    audit: funnel,
    commercial,
    directory,
    channels,
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
  return { sessions, etrade, kv, membershipStore, commercial, directory, channels, auditStore, instances, funnel, ctx };
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
  const res = await handleDataLifecycleRoutes(
    req,
    url,
    // The production dispatch passes url.pathname (no query
    // string); the query lives on the URL object.
    url.pathname,
    "sess-1",
    ctx,
  );
  if (!res) throw new Error(`route did not match ${path}`);
  return { status: res.status, body: (await res.json()) as any };
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n as number;
}

// ---------------------------------------------------------------------------
// Clean-state definitions (enumeration pins)
// ---------------------------------------------------------------------------

describe("clean-state definitions (#3250)", () => {
  it("tenant scope is exactly the enumerated target set", () => {
    expect(TENANT_CLEAN_TARGETS.map((t) => t.id)).toEqual([
      "instance-queues",
      "instance-tables",
      "tenant-memberships",
      "tenant-genesis-marker",
      "tenant-sessions",
    ]);
  });

  it("platform scope is exactly the enumerated target set", () => {
    expect(PLATFORM_CLEAN_TARGETS.map((t) => t.id)).toEqual([
      "instance-queues",
      "instance-tables",
      "platform-memberships",
      "platform-bindings",
      "platform-genesis-markers",
      "platform-tokens",
      "platform-audit-log",
      "platform-sessions",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe("gate (#3250)", () => {
  it("no login is 401 and a non-operator is 403, deleting nothing", async () => {
    const w = await makeWorld();
    const anon = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", null, { scope: "tenant", tenantId: "tenant-a" });
    expect(anon.status).toBe(401);
    const stranger = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", ALICE, { scope: "tenant", tenantId: "tenant-a" });
    expect(stranger.status).toBe(403);
    expect(w.sessions.size).toBeGreaterThan(0);
    expect(w.funnel).not.toHaveBeenCalled();
  });

  it("platform clean state additionally requires platform-admin membership", async () => {
    // A second operator who is a store operator but holds no
    // platform-admin membership.
    const w = await makeWorld({
      operators: {
        listOperators: async () => [
          { login: OP, addedBy: "seed", addedAtMs: 1 },
          { login: "op2", addedBy: "seed", addedAtMs: 1 },
        ],
      },
    });
    await recordLoginAlias(w.kv, { githubLogin: "op2", internalUserId: "user-op2", nowMs: 1000 });
    const out = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", "op2", { scope: "platform" });
    expect(out.status).toBe(403);
    expect(out.body.error).toMatch(/platform-admin/);
  });
});

// ---------------------------------------------------------------------------
// Clean state — tenant scope
// ---------------------------------------------------------------------------

describe("clean state, tenant scope (#3250)", () => {
  let w: World;
  beforeEach(async () => {
    w = await makeWorld();
  });

  it("preview enumerates scope with counts and deletes nothing", async () => {
    const sessionsBefore = w.sessions.size;
    const out = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, { scope: "tenant", tenantId: "tenant-a" });
    expect(out.status).toBe(200);
    expect(out.body.confirmed).toBe(false);
    expect(out.body.confirmRequired).toBe(true);
    expect(typeof out.body.previewToken).toBe("string");
    const byId = Object.fromEntries(out.body.targets.map((t: any) => [t.id, t]));
    expect(byId["tenant-memberships"].count).toBe(2);
    expect(byId["tenant-genesis-marker"].count).toBe(1);
    expect(byId["tenant-sessions"].count).toBe(1);
    expect(byId["instance-queues"].count).toBe(4); // alice + bob, 2 each
    expect(byId["instance-tables"].count).toBe(10); // per instance: 1 job + 1 outcome + 1 meta + 2 events = 5
    expect(w.sessions.size).toBe(sessionsBefore);
    expect(countRows(w.instances.get(ALICE)!.db, "mas_events")).toBe(2);
    expect(w.funnel).not.toHaveBeenCalled();
  });

  it("confirm without a preview token is refused and deletes nothing (sabotage pin)", async () => {
    const out = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      auditConfirm: true,
    });
    expect(out.status).toBe(409);
    expect(countRows(w.instances.get(ALICE)!.db, "mas_events")).toBe(2);
    expect(await w.membershipStore.getMembershipsByUser("user-alice")).toHaveLength(1);
  });

  it("confirm with a stale preview token is refused", async () => {
    const preview = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, { scope: "tenant", tenantId: "tenant-a" });
    // Scope changes after the preview: a new membership lands.
    await grant(w.membershipStore, "user-founder", "tenant-a", "member", "tenant");
    const out = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      auditConfirm: true,
      previewToken: preview.body.previewToken,
    });
    expect(out.status).toBe(409);
    expect(countRows(w.instances.get(ALICE)!.db, "mas_events")).toBe(2);
  });

  it("confirm clears exactly the tenant scope and audits after the clear", async () => {
    const preview = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, { scope: "tenant", tenantId: "tenant-a" });
    const out = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      auditConfirm: true,
      previewToken: preview.body.previewToken,
    });
    expect(out.status).toBe(200);
    expect(out.body.confirmed).toBe(true);
    // Tenant-a memberships gone, indexes repaired; tenant-b intact.
    expect(await w.membershipStore.getMembershipsByUser("user-alice")).toHaveLength(0);
    expect(await w.membershipStore.getMembershipsByUser("user-bob")).toHaveLength(0);
    expect(await w.membershipStore.getMembershipsByUser("user-carol")).toHaveLength(1);
    // Markers: tenant-a gone, tenant-b intact.
    expect(w.sessions.has(platformGenesisMarkerKey("tenant-a"))).toBe(false);
    expect(w.sessions.has(platformGenesisMarkerKey("tenant-b"))).toBe(true);
    // Sessions: alice's gone; carol's and op's intact.
    expect(w.sessions.has("11111111-1111-4111-8111-111111111111")).toBe(false);
    expect(w.sessions.has("22222222-2222-4222-8222-222222222222")).toBe(true);
    expect(w.sessions.has("33333333-3333-4333-8333-333333333333")).toBe(true);
    // Instances: alice + bob cleared; carol untouched (isolation).
    for (const login of [ALICE, BOB]) {
      const inst = w.instances.get(login)!;
      expect(inst.schedules).toHaveLength(0);
      expect(countRows(inst.db, "mas_async_jobs")).toBe(1); // the running row is never deleted
      expect(countRows(inst.db, "mas_job_outcomes")).toBe(0);
      expect(countRows(inst.db, "mas_events")).toBe(0);
    }
    const carol = w.instances.get(CAROL)!;
    expect(carol.schedules).toHaveLength(2);
    expect(countRows(carol.db, "mas_events")).toBe(2);
    // Operational KV outside tenant scope untouched: token + audit chain.
    expect(w.etrade.size).toBe(1);
    expect(w.sessions.has("iaaa-audit:seg:0001")).toBe(true);
    // Audit: funnel called after the clears + AuditLog record exists.
    expect(w.funnel).toHaveBeenCalledWith(
      "data-lifecycle.clean-state",
      "orchestrator",
      expect.objectContaining({ scope: "tenant", tenantId: "tenant-a" }),
    );
    const events = await w.auditStore.list();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("data-lifecycle.clean-state");
    expect(events[0].tenantId).toBe("tenant-a");
    expect(out.body.audit.auditLog.ok).toBe(true);
  });

  it("tenant isolation: extra body fields naming another tenant change nothing", async () => {
    const preview = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, { scope: "tenant", tenantId: "tenant-a" });
    const out = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      auditConfirm: true,
      previewToken: preview.body.previewToken,
      // Smuggled fields: must be ignored entirely.
      alsoTenantId: "tenant-b",
      logins: [CAROL],
      tenantIds: ["tenant-b"],
    });
    expect(out.status).toBe(200);
    expect(await w.membershipStore.getMembershipsByUser("user-carol")).toHaveLength(1);
    expect(w.sessions.has(platformGenesisMarkerKey("tenant-b"))).toBe(true);
    expect(countRows(w.instances.get(CAROL)!.db, "mas_events")).toBe(2);
  });

  it("unknown tenant is 404 and a missing auditConfirm is refused before any delete", async () => {
    const missing = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, { scope: "tenant", tenantId: "tenant-nope" });
    expect(missing.status).toBe(404);
    const preview = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, { scope: "tenant", tenantId: "tenant-a" });
    const refused = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      previewToken: preview.body.previewToken,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/auditConfirm/);
    expect(countRows(w.instances.get(ALICE)!.db, "mas_events")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Clean state — platform scope + export
// ---------------------------------------------------------------------------

describe("clean state, platform scope (#3250)", () => {
  let w: World;
  beforeEach(async () => {
    w = await makeWorld();
  });

  async function previewPlatform() {
    return call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, { scope: "platform" });
  }

  it("preview enumerates the platform targets", async () => {
    const out = await previewPlatform();
    expect(out.status).toBe(200);
    const byId = Object.fromEntries(out.body.targets.map((t: any) => [t.id, t]));
    expect(byId["platform-memberships"].count).toBe(4);
    expect(byId["platform-genesis-markers"].count).toBe(2);
    expect(byId["platform-tokens"].count).toBe(1);
    expect(byId["platform-sessions"].count).toBe(3);
    expect(byId["platform-audit-log"].count).toBe(1);
    expect(w.funnel).not.toHaveBeenCalled();
  });

  it("confirm requires the typed scope confirmation and auditConfirm", async () => {
    const preview = await previewPlatform();
    const noText = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, {
      scope: "platform",
      confirm: true,
      auditConfirm: true,
      previewToken: preview.body.previewToken,
    });
    expect(noText.status).toBe(400);
    expect(noText.body.error).toMatch(/confirmText/);
    const noAudit = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, {
      scope: "platform",
      confirm: true,
      confirmText: "CLEAN PLATFORM",
      previewToken: preview.body.previewToken,
    });
    expect(noAudit.status).toBe(400);
    expect(w.sessions.has("iaaa-audit:seg:0001")).toBe(true);
  });

  it("confirm clears the platform and the operation's audit record survives in the fresh chain", async () => {
    const preview = await previewPlatform();
    const out = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, {
      scope: "platform",
      confirm: true,
      auditConfirm: true,
      confirmText: "CLEAN PLATFORM",
      previewToken: preview.body.previewToken,
    });
    expect(out.status).toBe(200);
    expect(out.body.confirmed).toBe(true);
    // Identity state gone.
    expect(await w.membershipStore.getMembershipsByUser("user-carol")).toHaveLength(0);
    expect(w.sessions.has(platformGenesisMarkerKey("tenant-a"))).toBe(false);
    expect(w.sessions.has(platformGenesisMarkerKey("tenant-b"))).toBe(false);
    expect(w.etrade.size).toBe(0);
    expect(w.sessions.has("11111111-1111-4111-8111-111111111111")).toBe(false);
    // All instances cleared (incl. the operator's own).
    for (const login of [OP, ALICE, BOB, CAROL]) {
      expect(countRows(w.instances.get(login)!.db, "mas_events")).toBe(0);
    }
    // The audit segments were cleared, then the operation's own
    // record was appended — it is the fresh chain's surviving event.
    const events = await w.auditStore.list();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("data-lifecycle.clean-state");
    expect(out.body.audit.auditLog.ok).toBe(true);
  });

  it("export returns the pre-wipe bundle with the audit log (platform) and counts only (tenant)", async () => {
    const platform = await call(w.ctx, "/api/data-lifecycle/export?scope=platform", "GET", OP);
    expect(platform.status).toBe(200);
    expect(platform.body.scope).toBe("platform");
    expect(platform.body.auditLog.count).toBe(1);
    expect(platform.body.auditLog.truncated).toBe(false);
    const tenant = await call(w.ctx, "/api/data-lifecycle/export?scope=tenant&tenantId=tenant-a", "GET", OP);
    expect(tenant.status).toBe(200);
    expect(tenant.body.auditLog).toBeUndefined();
    expect(tenant.body.targets.length).toBe(TENANT_CLEAN_TARGETS.length);
  });
});

// ---------------------------------------------------------------------------
// Platform bootstrap
// ---------------------------------------------------------------------------

describe("platform bootstrap (#3250)", () => {
  it("check reports each element's state from its source of truth", async () => {
    const w = await makeWorld();
    const out = await call(w.ctx, "/api/data-lifecycle/bootstrap", "GET", OP);
    expect(out.status).toBe(200);
    const byId = Object.fromEntries(out.body.elements.map((e: any) => [e.id, e]));
    expect(byId["session-store-schema"].state).toBe("present");
    expect(byId["agent-db-schema"].state).toBe("present");
    expect(byId["reference-data"].state).toBe("present");
    // No marker for the IAAA tenant "primary" in the fixture.
    expect(byId["platform-genesis"].state).toBe("missing");
    expect(byId["bootstrap-admins"].state).toBe("present");
  });

  it("initialize claims genesis for a platform: bootstrap caller, then is a no-op", async () => {
    const w = await makeWorld();
    const first = await call(w.ctx, "/api/data-lifecycle/bootstrap", "POST", OP, { confirm: true });
    expect(first.status).toBe(200);
    const byId = Object.fromEntries(first.body.elements.map((e: any) => [e.id, e]));
    expect(byId["platform-genesis"].state).toBe("initialized");
    const markerRaw = w.sessions.get(platformGenesisMarkerKey("primary"));
    expect(markerRaw).toBeTruthy();
    expect(JSON.parse(markerRaw!).grantedTo).toBe(OP_ID);
    const mine = await w.membershipStore.getMembershipsByUser(OP_ID);
    const platformGrants = mine.filter((m) =>
      m.roleBindings.some((b) => b.role === "platform-admin" && b.grantedBy === "system:bootstrap-genesis"),
    );
    expect(platformGrants).toHaveLength(1);
    // Second run: all present, marker untouched, no new membership.
    const second = await call(w.ctx, "/api/data-lifecycle/bootstrap", "POST", OP, { confirm: true });
    const byId2 = Object.fromEntries(second.body.elements.map((e: any) => [e.id, e]));
    expect(byId2["platform-genesis"].state).toBe("present");
    expect(w.sessions.get(platformGenesisMarkerKey("primary"))).toBe(markerRaw);
    expect(await w.membershipStore.getMembershipsByUser(OP_ID)).toHaveLength(mine.length);
  });

  it("initialize without confirm performs nothing", async () => {
    const w = await makeWorld();
    const out = await call(w.ctx, "/api/data-lifecycle/bootstrap", "POST", OP, {});
    expect(out.status).toBe(200);
    expect(out.body.confirmRequired).toBe(true);
    expect(w.sessions.has(platformGenesisMarkerKey("primary"))).toBe(false);
    expect(w.funnel).not.toHaveBeenCalled();
  });

  it("genesis stays missing-external when the caller is not a platform: entry", async () => {
    const w = await makeWorld({}, { IAAA_BOOTSTRAP_ADMINS: "platform:someone-else" });
    const out = await call(w.ctx, "/api/data-lifecycle/bootstrap", "POST", OP, { confirm: true });
    const byId = Object.fromEntries(out.body.elements.map((e: any) => [e.id, e]));
    expect(byId["platform-genesis"].state).toBe("external");
    expect(w.sessions.has(platformGenesisMarkerKey("primary"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tenant bootstrap
// ---------------------------------------------------------------------------

describe("tenant bootstrap (#3250)", () => {
  it("preview reports per-step state and writes nothing", async () => {
    const w = await makeWorld();
    const out = await call(w.ctx, "/api/data-lifecycle/tenant-bootstrap", "POST", OP, {
      tenantId: "tenant-c",
      foundingAdminLogin: FOUNDER,
    });
    expect(out.status).toBe(200);
    expect(out.body.confirmed).toBe(false);
    const byId = Object.fromEntries(out.body.steps.map((s: any) => [s.id, s]));
    expect(byId["directory"].status).toBe("would-initialize");
    expect(byId["founding-admin"].status).toBe("would-initialize");
    expect(await w.directory.listTenantIds()).not.toContain("tenant-c");
    expect(w.funnel).not.toHaveBeenCalled();
  });

  it("confirm bootstraps a tenant end to end; re-run is a no-op report", async () => {
    const w = await makeWorld();
    const out = await call(w.ctx, "/api/data-lifecycle/tenant-bootstrap", "POST", OP, {
      tenantId: "tenant-c",
      foundingAdminLogin: FOUNDER,
      claimGenesis: true,
      confirm: true,
    });
    expect(out.status).toBe(200);
    expect(out.body.outcome).toBe("complete");
    const byId = Object.fromEntries(out.body.steps.map((s: any) => [s.id, s]));
    expect(byId["directory"].status).toBe("initialized");
    expect(byId["settings"].status).toBe("initialized");
    expect(byId["founding-admin"].status).toBe("initialized");
    expect(byId["genesis"].status).toBe("initialized");
    // Verify through the existing read paths.
    expect(await w.directory.listTenantIds()).toContain("tenant-c");
    const settings = await w.commercial.getTenantProviders("tenant-c");
    expect(settings.dataProviderId).toBeTruthy();
    const founderMemberships = await w.membershipStore.getMembershipsByUser("user-founder");
    const inTenant = founderMemberships.filter((m) => m.tenantId === "tenant-c");
    expect(inTenant.some((m) => m.roleBindings.some((b) => b.role === "tenant-admin"))).toBe(true);
    expect(inTenant.some((m) => m.roleBindings.some((b) => b.role === "platform-admin"))).toBe(true);
    const marker = w.sessions.get(platformGenesisMarkerKey("tenant-c"));
    expect(JSON.parse(marker!).grantedTo).toBe("user-founder");
    const channels = await w.channels.getTenantChannels("tenant-c");
    expect(channels).toBeTruthy();
    // Re-run: no duplication, steps report present.
    const again = await call(w.ctx, "/api/data-lifecycle/tenant-bootstrap", "POST", OP, {
      tenantId: "tenant-c",
      foundingAdminLogin: FOUNDER,
      claimGenesis: true,
      confirm: true,
    });
    expect(again.body.outcome).toBe("complete");
    const againById = Object.fromEntries(again.body.steps.map((s: any) => [s.id, s]));
    expect(againById["directory"].status).toBe("present");
    expect(againById["founding-admin"].status).toBe("present");
    expect(againById["genesis"].status).toBe("present");
    const after = await w.membershipStore.getMembershipsByUser("user-founder");
    expect(after.filter((m) => m.tenantId === "tenant-c")).toHaveLength(inTenant.length);
    expect(w.sessions.get(platformGenesisMarkerKey("tenant-c"))).toBe(marker);
  });

  it("claimGenesis without platform-admin membership leaves genesis unclaimed and reports partial truthfully", async () => {
    // op2 is a store operator but not a platform admin.
    const w = await makeWorld({
      operators: {
        listOperators: async () => [
          { login: OP, addedBy: "seed", addedAtMs: 1 },
          { login: "op2", addedBy: "seed", addedAtMs: 1 },
        ],
      },
    });
    await recordLoginAlias(w.kv, { githubLogin: "op2", internalUserId: "user-op2", nowMs: 1000 });
    const out = await call(w.ctx, "/api/data-lifecycle/tenant-bootstrap", "POST", "op2", {
      tenantId: "tenant-c",
      foundingAdminLogin: FOUNDER,
      claimGenesis: true,
      confirm: true,
    });
    expect(out.status).toBe(200);
    expect(out.body.outcome).toBe("partial");
    const byId = Object.fromEntries(out.body.steps.map((s: any) => [s.id, s]));
    expect(byId["genesis"].status).toBe("missing");
    expect(byId["genesis"].detail).toMatch(/platform-admin/);
    expect(w.sessions.has(platformGenesisMarkerKey("tenant-c"))).toBe(false);
    // The rest of the bootstrap still landed and a re-run is safe.
    expect(await w.directory.listTenantIds()).toContain("tenant-c");
  });

  it("an unresolvable founding admin is reported missing, never invented; other steps still complete", async () => {
    const w = await makeWorld();
    const out = await call(w.ctx, "/api/data-lifecycle/tenant-bootstrap", "POST", OP, {
      tenantId: "tenant-c",
      foundingAdminLogin: "ghost-login",
      claimGenesis: true,
      confirm: true,
    });
    expect(out.status).toBe(200);
    expect(out.body.outcome).toBe("partial");
    const byId = Object.fromEntries(out.body.steps.map((s: any) => [s.id, s]));
    expect(byId["founding-admin"].status).toBe("missing");
    expect(byId["genesis"].status).toBe("skipped");
    expect(byId["channels"].status).toBe("present");
    expect(await w.membershipStore.getMembershipsByUser("user-founder")).toHaveLength(0);
  });

  it("a forced step failure leaves a truthful partial report and a safe re-run (sabotage pin)", async () => {
    const failingChannels = new InMemoryTenantChannelAdapter();
    failingChannels.setTenantChannels = async () => {
      throw new Error("channel store unavailable");
    };
    const w = await makeWorld({ channels: failingChannels });
    const out = await call(w.ctx, "/api/data-lifecycle/tenant-bootstrap", "POST", OP, {
      tenantId: "tenant-c",
      foundingAdminLogin: FOUNDER,
      confirm: true,
    });
    expect(out.status).toBe(200);
    expect(out.body.outcome).toBe("partial");
    const byId = Object.fromEntries(out.body.steps.map((s: any) => [s.id, s]));
    expect(byId["channels"].status).toBe("failed");
    expect(byId["channels"].detail).toMatch(/channel store unavailable/);
    expect(byId["directory"].status).toBe("initialized");
    // Safe re-run with a healthy store completes without duplication.
    const w2ctx = { ...w.ctx, channels: new InMemoryTenantChannelAdapter() };
    const again = await call(w2ctx, "/api/data-lifecycle/tenant-bootstrap", "POST", OP, {
      tenantId: "tenant-c",
      foundingAdminLogin: FOUNDER,
      confirm: true,
    });
    expect(again.body.outcome).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// AuditLog port composition (flag-state characterization, #2435 family)
// ---------------------------------------------------------------------------

describe("audit through the AuditLog port composition (#3250)", () => {
  it("clean-state audit lands through the step-5d in-memory port adapter too", async () => {
    const portStore = createInMemoryAuditPorts();
    const w = await makeWorld({ auditStore: portStore as unknown as AuditStore });
    const preview = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, { scope: "tenant", tenantId: "tenant-a" });
    const out = await call(w.ctx, "/api/data-lifecycle/clean-state", "POST", OP, {
      scope: "tenant",
      tenantId: "tenant-a",
      confirm: true,
      auditConfirm: true,
      previewToken: preview.body.previewToken,
    });
    expect(out.status).toBe(200);
    expect(out.body.audit.auditLog.ok).toBe(true);
    const events = await portStore.list();
    expect(events.some((e) => e.action === "data-lifecycle.clean-state")).toBe(true);
  });
});
