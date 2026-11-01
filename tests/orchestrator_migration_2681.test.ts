/**
 * Issue #2681 — shared-orchestrator address migration.
 *
 * The rename of SHARED_ORCHESTRATOR_INSTANCE away from "default_trader"
 * must not orphan live state. The migration routes (new
 * src/agents/routes/orchestratorMigration.ts) export SDK schedules,
 * paused_schedules, all KV keys, and user SQL tables from a source
 * instance and import them into the target instance, with schedule
 * fingerprint dedupe so a re-run never double-arms. In-flight
 * mas_async_jobs rows (queued/running) are deliberately NOT copied:
 * they drain on the source instance. SDK tables (cf_agents_*,
 * cf_ai_*) are out of scope by design (queue internals, chat session).
 *
 * RED FIRST: the module does not exist yet.
 */
import { describe, it, expect, vi } from "vitest";
import {
  handleOrchestratorMigrationRoutes,
  type OrchestratorMigrationContext,
  type MigrationSchedule,
} from "../src/agents/routes/orchestratorMigration";
import {
  createMemoryMembershipStore,
  type Membership,
} from "../src/security/authorization";
import { IAAA_ALIAS_KEY_PREFIX } from "../src/security/iaaaMigration";
import type { KvLike } from "../src/security/kvResilience";

const EXPORT = "/admin/orchestrator-migration/export";
const IMPORT = "/admin/orchestrator-migration/import";
const MIGRATE = "/admin/orchestrator-migration/migrate";

const ADMIN_LOGIN = "admin-user";
const ADMIN_ID = "admin-id-1";

function mapKv(seed: Record<string, string> = {}): KvLike {
  const map = new Map(Object.entries(seed));
  return {
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
  } as unknown as KvLike;
}

function aliasSeed(login: string, internalUserId: string): Record<string, string> {
  return {
    [`${IAAA_ALIAS_KEY_PREFIX}login:${login}`]: JSON.stringify({
      githubLogin: login,
      internalUserId,
      recordedAtMs: 1,
      source: "wired-login",
    }),
  };
}

function platformAdminMembership(userId: string): Membership {
  return {
    membershipId: `m-platform-admin-${userId}`,
    internalUserId: userId,
    tenantId: "primary",
    roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

/** Minimal in-memory DO storage: KV map + SQL tables. */
class FakeStorage {
  kv = new Map<string, unknown>();
  tables = new Map<string, Array<Record<string, unknown>>>();

  async get(key: string): Promise<unknown> {
    return this.kv.has(key) ? this.kv.get(key) : null;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.kv.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.kv.delete(key);
  }
  async list(opts: { limit?: number; startAfter?: string } = {}): Promise<Map<string, unknown>> {
    const keys = [...this.kv.keys()].sort();
    let start = 0;
    if (opts.startAfter !== undefined) {
      const idx = keys.indexOf(opts.startAfter);
      start = idx >= 0 ? idx + 1 : keys.length;
    }
    const slice = opts.limit === undefined ? keys.slice(start) : keys.slice(start, start + opts.limit);
    const out = new Map<string, unknown>();
    for (const k of slice) out.set(k, this.kv.get(k));
    return out;
  }

  exec(sql: string, ...args: unknown[]): Iterable<Record<string, unknown>> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    const masterMatch = normalized.match(/FROM sqlite_master WHERE type = 'table' AND name = '([^']+)'/);
    if (masterMatch) {
      const name = masterMatch[1];
      return this.tables.has(name) ? [{ name }] : [];
    }
    const allTablesMatch = normalized.match(/FROM sqlite_master WHERE type = 'table'/);
    if (allTablesMatch) {
      return [...this.tables.keys()].map((name) => ({ name }));
    }
    const selectMatch = normalized.match(/SELECT \* FROM ([A-Za-z0-9_]+)/);
    if (selectMatch) {
      const rows = this.tables.get(selectMatch[1]) ?? [];
      return rows.map((r) => ({ ...r }));
    }
    const insertMatch = normalized.match(/INSERT OR REPLACE INTO ([A-Za-z0-9_]+) \(([^)]+)\) VALUES/);
    if (insertMatch) {
      const table = insertMatch[1];
      const cols = insertMatch[2].split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        row[c] = args[i];
      });
      const rows = this.tables.get(table) ?? [];
      const pk = ["id", "job_id", "schedule_id"].find((k) => row[k] !== undefined);
      if (pk !== undefined) {
        const idx = rows.findIndex((r) => r[pk] === row[pk]);
        if (idx >= 0) rows[idx] = row;
        else rows.push(row);
      } else {
        rows.push(row);
      }
      this.tables.set(table, rows);
      return [];
    }
    throw new Error(`FakeStorage: unsupported SQL: ${sql}`);
  }
}

interface FakeAgent {
  storage: FakeStorage;
  schedules: MigrationSchedule[];
  scheduled: Array<{ when: unknown; callback: string; payload: unknown }>;
}

function makeAgent(): FakeAgent {
  return { storage: new FakeStorage(), schedules: [], scheduled: [] };
}

function makeCtx(
  agent: FakeAgent,
  opts: {
    callerMemberships?: Membership[];
    aliasLogin?: string | null;
    fetchInstance?: OrchestratorMigrationContext["fetchInstance"];
  } = {},
): { ctx: OrchestratorMigrationContext; audit: ReturnType<typeof vi.fn> } {
  const store = createMemoryMembershipStore();
  for (const m of opts.callerMemberships ?? [platformAdminMembership(ADMIN_ID)]) {
    void store.put(m);
  }
  const audit = vi.fn();
  const aliasLogin = opts.aliasLogin === undefined ? ADMIN_LOGIN : opts.aliasLogin;
  const ctx = {
    env: {},
    audit,
    membershipStore: store,
    aliasKv: mapKv(aliasLogin ? aliasSeed(aliasLogin, ADMIN_ID) : {}),
    storage: {
      get: (k: string) => agent.storage.get(k),
      put: (k: string, v: unknown) => agent.storage.put(k, v),
      delete: (k: string) => agent.storage.delete(k),
      list: (o?: { limit?: number; startAfter?: string }) => agent.storage.list(o),
      sql: { exec: (sql: string, ...args: unknown[]) => agent.storage.exec(sql, ...args) },
    },
    listSchedules: async () => [...agent.schedules],
    schedule: async (when: Date | string, callback: string, payload?: unknown) => {
      agent.scheduled.push({ when, callback, payload });
      const created: MigrationSchedule = {
        id: `new-${agent.scheduled.length}`,
        callback,
        payload,
        type: typeof when === "string" ? "cron" : "scheduled",
        time: typeof when === "string" ? 0 : Math.floor(when.getTime() / 1000),
        ...(typeof when === "string" ? { cron: when } : {}),
      };
      agent.schedules.push(created);
      return created;
    },
    scheduleEvery: async (intervalSeconds: number, callback: string, payload?: unknown) => {
      agent.scheduled.push({ when: `every:${intervalSeconds}`, callback, payload });
      const created: MigrationSchedule = {
        id: `new-${agent.scheduled.length}`,
        callback,
        payload,
        type: "interval",
        time: 0,
        intervalSeconds,
      };
      agent.schedules.push(created);
      return created;
    },
    fetchInstance: opts.fetchInstance,
  } as unknown as OrchestratorMigrationContext;
  return { ctx, audit };
}

async function call(
  ctx: OrchestratorMigrationContext,
  path: string,
  login: string | null,
  body?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  if (login !== null) headers["x-user-login"] = login;
  const req = new Request(`https://agent.test${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleOrchestratorMigrationRoutes(
    req,
    new URL(`https://agent.test${path}`),
    path,
    "session-1",
    ctx,
  );
  if (res === null) return { status: null, body: null as Record<string, unknown> | null };
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function seedSource(agent: FakeAgent): void {
  agent.storage.kv.set("screener:execution-context", { userLogin: "owner-1", environment: "TEST" });
  agent.storage.kv.set("options:scheduled:last-slot:thesis-a", { slot: "09:30" });
  agent.storage.tables.set("paused_schedules", [
    { id: "paused-1", callback: "screen", payload_json: "{}", timing_json: "{}" },
  ]);
  agent.storage.tables.set("mas_messages", [
    { id: "msg-1", body: "hello" },
    { id: "msg-2", body: "world" },
  ]);
  agent.storage.tables.set("mas_async_jobs", [
    { job_id: "job-done", status: "completed", payload_json: "{}" },
    { job_id: "job-queued", status: "queued", payload_json: "{}" },
    { job_id: "job-running", status: "running", payload_json: "{}" },
  ]);
  agent.schedules.push(
    { id: "sched-1", callback: "screen", payload: { t: "a" }, type: "cron", time: 0, cron: "0 * * * *" },
    { id: "sched-2", callback: "report", payload: { t: "b" }, type: "scheduled", time: 1_900_000_000 },
  );
}

describe("issue #2681: migration export/import", () => {
  it("exports KV, tables (in-flight jobs excluded), and schedules", async () => {
    const agent = makeAgent();
    seedSource(agent);
    const { ctx } = makeCtx(agent);

    const kv = await call(ctx, EXPORT, ADMIN_LOGIN, { section: "kv" });
    expect(kv.status).toBe(200);
    const entries = kv.body!.entries as Array<{ key: string }>;
    expect(entries.map((e) => e.key).sort()).toEqual([
      "options:scheduled:last-slot:thesis-a",
      "screener:execution-context",
    ]);

    const tables = await call(ctx, EXPORT, ADMIN_LOGIN, { section: "tables" });
    expect(tables.status).toBe(200);
    const tableMap = tables.body!.tables as Record<string, Array<Record<string, unknown>>>;
    expect(tableMap["mas_messages"]).toHaveLength(2);
    expect(tableMap["paused_schedules"]).toHaveLength(1);
    // In-flight rows never leave the source instance.
    expect(tableMap["mas_async_jobs"].map((r) => r.job_id)).toEqual(["job-done"]);

    const schedules = await call(ctx, EXPORT, ADMIN_LOGIN, { section: "schedules" });
    expect(schedules.status).toBe(200);
    expect((schedules.body!.schedules as Array<unknown>)).toHaveLength(2);
  });

  it("import writes KV + rows and re-arms schedules with fingerprint dedupe", async () => {
    const source = makeAgent();
    seedSource(source);
    const { ctx: srcCtx } = makeCtx(source);
    const target = makeAgent();
    const { ctx: tgtCtx } = makeCtx(target);

    const kv = await call(srcCtx, EXPORT, ADMIN_LOGIN, { section: "kv" });
    const tables = await call(srcCtx, EXPORT, ADMIN_LOGIN, { section: "tables" });
    const schedules = await call(srcCtx, EXPORT, ADMIN_LOGIN, { section: "schedules" });

    const imp1 = await call(tgtCtx, IMPORT, ADMIN_LOGIN, {
      kv: kv.body!.entries,
      tables: tables.body!.tables,
      schedules: schedules.body!.schedules,
    });
    expect(imp1.status).toBe(200);
    expect(imp1.body!.kvImported).toBe(2);
    expect(imp1.body!.schedulesRearmed).toBe(2);
    expect(target.storage.kv.get("screener:execution-context")).toEqual({
      userLogin: "owner-1",
      environment: "TEST",
    });
    expect((target.storage.tables.get("mas_messages") ?? [])).toHaveLength(2);

    // A re-run is idempotent: no duplicate schedules, no duplicate rows.
    const imp2 = await call(tgtCtx, IMPORT, ADMIN_LOGIN, {
      kv: kv.body!.entries,
      tables: tables.body!.tables,
      schedules: schedules.body!.schedules,
    });
    expect(imp2.body!.schedulesRearmed).toBe(0);
    expect(imp2.body!.schedulesSkipped).toBe(2);
    expect((target.storage.tables.get("mas_messages") ?? [])).toHaveLength(2);
  });

  it("migrate driver copies source to target, verifies counts, and writes a receipt", async () => {
    const source = makeAgent();
    seedSource(source);
    const { ctx: srcCtx } = makeCtx(source);
    const target = makeAgent();
    const fetchInstance = (address: string) => ({
      fetch: async (req: Request) => {
        expect(address).toBe("default_trader");
        const url = new URL(req.url);
        const res = await handleOrchestratorMigrationRoutes(
          req,
          url,
          url.pathname,
          "session-1",
          srcCtx,
        );
        return res ?? new Response("Not found", { status: 404 });
      },
    });
    const { ctx: tgtCtx, audit } = makeCtx(target, { fetchInstance });

    const res = await call(tgtCtx, MIGRATE, ADMIN_LOGIN, { sourceAddress: "default_trader" });
    expect(res.status).toBe(200);
    expect(res.body!.sourceAddress).toBe("default_trader");
    expect(res.body!.kvKeys).toBe(2);
    expect(res.body!.schedulesRearmed).toBe(2);
    expect(res.body!.tables["mas_messages"]).toBe(2);
    expect(res.body!.tables["mas_async_jobs"]).toBe(1);
    expect(target.storage.kv.get("orchestrator-migration:receipt:default_trader")).toBeDefined();
    expect(audit).toHaveBeenCalledWith(
      "orchestrator_migration.completed",
      "orchestrator",
      expect.objectContaining({ sourceAddress: "default_trader" }),
    );
  });

  it("gates migration routes: 401 without login, 403 for non-admin and token callers", async () => {
    const agent = makeAgent();
    const { ctx } = makeCtx(agent, { callerMemberships: [], aliasLogin: ADMIN_LOGIN });
    const noLogin = await call(ctx, EXPORT, null, { section: "kv" });
    expect(noLogin.status).toBe(401);
    const nonAdmin = await call(ctx, EXPORT, ADMIN_LOGIN, { section: "kv" });
    expect(nonAdmin.status).toBe(403);
    const { ctx: ctx2 } = makeCtx(agent);
    const tokenCaller = await call(ctx2, EXPORT, ADMIN_LOGIN, { section: "kv" }, { "x-principal-kind": "service-token" });
    expect(tokenCaller.status).toBe(403);
  });

  it("unknown migration paths return null", async () => {
    const agent = makeAgent();
    const { ctx } = makeCtx(agent);
    const res = await call(ctx, "/admin/orchestrator-migration/nope", ADMIN_LOGIN, {});
    expect(res.status).toBeNull();
  });
});
