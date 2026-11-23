/**
 * Issue #2680 — store operator management routes.
 *
 * Harness mirrors tests/price_catalogue_ports.test.ts: the
 * commercial handler invoked directly over a MockD1Database
 * backed by node:sqlite. Pins: add/remove flows, the
 * last-operator guard, the self-lockout guard, env-union
 * behavior, non-operator 403 on all three routes, audit rows,
 * and the unbound-AGENT_DB env-only fallback.
 *
 * Issue #6180 — add/remove now mint and revoke store-operator
 * MEMBERSHIPS through the grant route's machinery, not store
 * rows. The granter must hold grant power (a tenant-admin); a
 * bare store-operator cannot mint or revoke operators. The test
 * world therefore wires aliases + a tenant-admin granter through
 * the route context's membership seams.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import type { DatabaseORM } from "../src/orm";
import { createKvMembershipStore } from "../src/security/iaaaMembershipStore";
import { createMembership } from "../src/security/authorization";
import { recordLoginAlias } from "../src/security/iaaaMigration";
import type { KvLike } from "../src/security/kvResilience";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
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
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

function req(method: string, path: string, login: string | null, body?: unknown) {
  return new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(login ? { "x-user-login": login } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const call = (
  ctx: AgenticPaymentsRouteContext,
  method: string,
  path: string,
  login: string | null,
  body?: unknown,
) => {
  const url = new URL(`https://agent.internal${path}`);
  return handleAgenticPaymentsRoutes(req(method, path, login, body), url, url.pathname, "sess-1", ctx);
};

function ctxWith(env: Record<string, unknown>) {
  return {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
}

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

/**
 * #6180 test world: aliases for op1/op2/op3, op1 holding
 * tenant-admin in the platform tenant (the granter), and the
 * membership seams injected into the route context. The sessions
 * map backs the membership-entry listing seam.
 */
async function worldWith(env: Record<string, unknown>) {
  const sessions = new Map<string, string>();
  const kv = makeKv(sessions);
  const membershipStore = createKvMembershipStore(kv);
  for (const [login, id] of [
    ["op1", "user-op1"],
    ["op2", "user-op2"],
    ["op3", "user-op3"],
  ] as const) {
    await recordLoginAlias(kv, { githubLogin: login, internalUserId: id, nowMs: 1000 });
  }
  const granter = await createMembership(membershipStore, {
    internalUserId: "user-op1",
    tenantId: "primary",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "seed" }],
    createdBy: "seed",
    nowMs: 1000,
  });
  if (!granter.ok) throw new Error(`granter seed failed: ${granter.error}`);
  const listMembershipEntries = async () =>
    [...sessions.entries()]
      .filter(([k]) => k.startsWith("iaaa-membership:"))
      .map(([key, value]) => ({ key, value }));
  const ctx = ctxWith({ IAAA_TENANT_ID: "primary", ...env });
  ctx.storeOperatorAliasKv = kv;
  ctx.storeOperatorMembershipStore = membershipStore;
  ctx.listMembershipEntries = listMembershipEntries;
  return { ctx, kv, membershipStore, sessions, listMembershipEntries };
}

function attachSeams(
  ctx: AgenticPaymentsRouteContext,
  world: Awaited<ReturnType<typeof worldWith>>,
) {
  ctx.storeOperatorAliasKv = world.kv;
  ctx.storeOperatorMembershipStore = world.membershipStore;
  ctx.listMembershipEntries = world.listMembershipEntries;
  return ctx;
}

async function bodyOf(res: Response | null): Promise<any> {
  if (!res) return null;
  return res.json().catch(() => null);
}

describe("store operator management routes (#2680)", () => {
  it("list/add/remove flow with audit rows; a bare store-operator cannot grant (403)", async () => {
    const mock = new MockD1Database();
    const world = await worldWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    const { ctx } = world;
    const list0 = await call(ctx, "GET", "/payments/agentic/commercial/operators", "op1");
    expect(list0?.status).toBe(200);
    expect((await bodyOf(list0)).operators).toEqual([
      { login: "op1", source: "env", addedBy: null, addedAtMs: null },
    ]);

    const added = await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op2" });
    expect(added?.status).toBe(200);
    const addedOperator = (await bodyOf(added)).operator;
    expect(addedOperator).toMatchObject({
      login: "op2",
      source: "membership",
      internalUserId: "user-op2",
    });
    expect(typeof addedOperator.expiresAtMs).toBe("number");
    expect(ctx.audit).toHaveBeenCalledWith(
      "commercial.operator.added",
      "payments",
      expect.objectContaining({ operatorLogin: "op2", addedBy: "op1", via: "membership" }),
    );

    const list1 = await call(ctx, "GET", "/payments/agentic/commercial/operators", "op1");
    expect((await bodyOf(list1)).operators).toEqual([
      { login: "op1", source: "env", addedBy: null, addedAtMs: null },
      expect.objectContaining({ login: "op2", source: "membership", internalUserId: "user-op2" }),
    ]);

    // op2 holds the membership, so op2 can list — but op2 holds no
    // grant power, so op2 cannot add op3 (403, not the old 200).
    const listByOp2 = await call(ctx, "GET", "/payments/agentic/commercial/operators", "op2");
    expect(listByOp2?.status).toBe(200);
    const deniedAdd = await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op2", { login: "op3" });
    expect(deniedAdd?.status).toBe(403);

    const removed = await call(ctx, "POST", "/payments/agentic/commercial/operators/remove", "op1", { login: "op2" });
    expect(removed?.status).toBe(200);
    expect(ctx.audit).toHaveBeenCalledWith(
      "commercial.operator.removed",
      "payments",
      expect.objectContaining({ operatorLogin: "op2", addedBy: "op1", via: "membership" }),
    );

    for (const [method, path, body] of [
      ["GET", "/payments/agentic/commercial/operators", undefined],
      ["POST", "/payments/agentic/commercial/operators/add", { login: "op3" }],
      ["POST", "/payments/agentic/commercial/operators/remove", { login: "op1" }],
    ] as const) {
      const denied = await call(ctx, method, path, "u1", body);
      expect(denied?.status).toBe(403);
      const anon = await call(ctx, method, path, null, body);
      expect(anon?.status).toBe(403);
    }
  });

  it("env-managed rows are not removable via the remove route; unknown logins 404", async () => {
    const mock = new MockD1Database();
    const world = await worldWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    const { ctx } = world;
    await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op2" });
    // op1 is env-only: there is no membership and no store row to remove.
    const envRemove = await call(ctx, "POST", "/payments/agentic/commercial/operators/remove", "op1", { login: "op1" });
    expect(envRemove?.status).toBe(404);
    const ghost = await call(ctx, "POST", "/payments/agentic/commercial/operators/remove", "op1", { login: "ghost" });
    expect(ghost?.status).toBe(404);
  });

  it("last-operator guard: removing the sole effective operator is refused (409), including self-removal", async () => {
    const mock = new MockD1Database();
    // Bootstrap via env: op1 (env) adds op2 (membership).
    const world = await worldWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    const { ctx } = world;
    await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op2" });
    // op1 (env) removes op2 (membership): allowed, op1 remains.
    expect((await call(ctx, "POST", "/payments/agentic/commercial/operators/remove", "op1", { login: "op2" }))?.status).toBe(200);
    // Now re-add op2, drop op1 from env, and op2 (sole membership
    // holder, sole effective operator) cannot remove itself. op2
    // also holds tenant-admin in this world, so op2 can attempt
    // the removal — the guard, not grant power, refuses it.
    await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op2" });
    const seeded = await createMembership(world.membershipStore, {
      internalUserId: "user-op2",
      tenantId: "primary",
      roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "seed" }],
      createdBy: "seed",
      nowMs: 1000,
    });
    expect(seeded.ok).toBe(true);
    const ctx3 = attachSeams(ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "" }), world);
    const selfRemove = await call(ctx3, "POST", "/payments/agentic/commercial/operators/remove", "op2", { login: "op2" });
    expect(selfRemove?.status).toBe(409);
    const list = await call(ctx3, "GET", "/payments/agentic/commercial/operators", "op2");
    expect((await bodyOf(list)).operators.map((o: any) => o.login)).toEqual(["op2"]);
  });

  it("env-union: an env operator stays effective after a membership removal of a different login", async () => {
    const mock = new MockD1Database();
    const world = await worldWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    const { ctx } = world;
    await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op2" });
    await call(ctx, "POST", "/payments/agentic/commercial/operators/remove", "op1", { login: "op2" });
    const list = await call(ctx, "GET", "/payments/agentic/commercial/operators", "op1");
    expect(list?.status).toBe(200);
    expect((await bodyOf(list)).operators.map((o: any) => o.login)).toEqual(["op1"]);
    // And the prices route still honors the env operator.
    const price = await call(ctx, "POST", "/payments/agentic/commercial/prices", "op1", { family: "goal", priceUSD: 0.2 });
    expect(price?.status).toBe(200);
  });

  it("unbound AGENT_DB: env-only fallback — gate works, list is env-only, add/remove are 503", async () => {
    const ctx = ctxWith({ COMMERCIAL_STORE_OPERATORS: "op1" });
    const list = await call(ctx, "GET", "/payments/agentic/commercial/operators", "op1");
    expect(list?.status).toBe(200);
    expect((await bodyOf(list)).operators).toEqual([
      { login: "op1", source: "env", addedBy: null, addedAtMs: null },
    ]);
    const add = await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op2" });
    expect(add?.status).toBe(503);
    const remove = await call(ctx, "POST", "/payments/agentic/commercial/operators/remove", "op1", { login: "op1" });
    expect(remove?.status).toBe(503);
    const denied = await call(ctx, "GET", "/payments/agentic/commercial/operators", "u1");
    expect(denied?.status).toBe(403);
  });

  it("blank login is 400; adding an env login is 409", async () => {
    const mock = new MockD1Database();
    const world = await worldWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    const { ctx } = world;
    expect((await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "  " }))?.status).toBe(400);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/operators/remove", "op1", { login: "" }))?.status).toBe(400);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op1" }))?.status).toBe(409);
  });

  it("add/remove work through memberships when AGENT_DB is unbound", async () => {
    // #6180 — add/remove no longer touch the store table at all;
    // the membership store is the write target, so an unbound
    // AGENT_DB no longer blocks them.
    const world = await worldWith({ COMMERCIAL_STORE_OPERATORS: "op1" });
    const { ctx } = world;
    const added = await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op2" });
    expect(added?.status).toBe(200);
    expect((await bodyOf(added)).operator).toMatchObject({
      login: "op2",
      source: "membership",
    });
    const removed = await call(ctx, "POST", "/payments/agentic/commercial/operators/remove", "op1", { login: "op2" });
    expect(removed?.status).toBe(200);
  });

  it("add of a login with no wired identity is 400; self-grant is 403", async () => {
    const mock = new MockD1Database();
    const world = await worldWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    const { ctx } = world;
    const unwired = await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "ghost" });
    expect(unwired?.status).toBe(400);
    // op2 holds store-operator + tenant-admin: op2 adding themself
    // hits SELF_GRANT (403) — op2 is not env-listed, so the env
    // check does not fire first.
    await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op2" });
    const seeded = await createMembership(world.membershipStore, {
      internalUserId: "user-op2",
      tenantId: "primary",
      roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "seed" }],
      createdBy: "seed",
      nowMs: 1000,
    });
    expect(seeded.ok).toBe(true);
    const self = await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op2", { login: "op2" });
    expect(self?.status).toBe(403);
  });
});
