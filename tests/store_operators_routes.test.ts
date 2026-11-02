/**
 * Issue #2680 — store operator management routes.
 *
 * Harness mirrors tests/price_catalogue_ports.test.ts: the
 * commercial handler invoked directly over a MockD1Database
 * backed by node:sqlite. Pins: add/remove flows, the
 * last-operator guard, the self-lockout guard, env-union
 * behavior, non-operator 403 on all three routes, audit rows,
 * and the unbound-AGENT_DB env-only fallback.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import type { DatabaseORM } from "../src/orm";

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

async function bodyOf(res: Response | null): Promise<any> {
  if (!res) return null;
  return res.json().catch(() => null);
}

describe("store operator management routes (#2680)", () => {
  it("list/add/remove flow with audit rows; non-operators get 403 on all three", async () => {
    const mock = new MockD1Database();
    const ctx = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    const list0 = await call(ctx, "GET", "/payments/agentic/commercial/operators", "op1");
    expect(list0?.status).toBe(200);
    expect((await bodyOf(list0)).operators).toEqual([
      { login: "op1", source: "env", addedBy: null, addedAtMs: null },
    ]);

    const added = await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op2" });
    expect(added?.status).toBe(200);
    expect((await bodyOf(added)).operator.login).toBe("op2");
    expect(ctx.audit).toHaveBeenCalledWith(
      "commercial.operator.added",
      "payments",
      expect.objectContaining({ operatorLogin: "op2", addedBy: "op1" }),
    );

    const list1 = await call(ctx, "GET", "/payments/agentic/commercial/operators", "op1");
    expect((await bodyOf(list1)).operators).toEqual([
      { login: "op1", source: "env", addedBy: null, addedAtMs: null },
      expect.objectContaining({ login: "op2", source: "store", addedBy: "op1" }),
    ]);

    // A store-added operator is now an effective operator: they
    // can list, and they can add others.
    const listByOp2 = await call(ctx, "GET", "/payments/agentic/commercial/operators", "op2");
    expect(listByOp2?.status).toBe(200);

    const removed = await call(ctx, "POST", "/payments/agentic/commercial/operators/remove", "op1", { login: "op2" });
    expect(removed?.status).toBe(200);
    expect(ctx.audit).toHaveBeenCalledWith(
      "commercial.operator.removed",
      "payments",
      expect.objectContaining({ operatorLogin: "op2", addedBy: "op1" }),
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
    const ctx = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op2" });
    // op1 is env-only: there is no store row to remove.
    const envRemove = await call(ctx, "POST", "/payments/agentic/commercial/operators/remove", "op1", { login: "op1" });
    expect(envRemove?.status).toBe(404);
    const ghost = await call(ctx, "POST", "/payments/agentic/commercial/operators/remove", "op1", { login: "ghost" });
    expect(ghost?.status).toBe(404);
  });

  it("last-operator guard: removing the sole effective operator is refused (409), including self-removal", async () => {
    const mock = new MockD1Database();
    // Bootstrap via env: op1 (env) adds op2 (store).
    const ctx2 = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    await call(ctx2, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op2" });
    // op1 (env) removes op2 (store): allowed, op1 remains.
    expect((await call(ctx2, "POST", "/payments/agentic/commercial/operators/remove", "op1", { login: "op2" }))?.status).toBe(200);
    // Now re-add op2, drop op1 from env, and op2 (sole store
    // operator, sole effective operator) cannot remove itself.
    await call(ctx2, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op2" });
    const ctx3 = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "" });
    const selfRemove = await call(ctx3, "POST", "/payments/agentic/commercial/operators/remove", "op2", { login: "op2" });
    expect(selfRemove?.status).toBe(409);
    // And op2 cannot remove the last operator by any other path:
    // with only op2 effective, any removal attempt is the same guard.
    const list = await call(ctx3, "GET", "/payments/agentic/commercial/operators", "op2");
    expect((await bodyOf(list)).operators.map((o: any) => o.login)).toEqual(["op2"]);
  });

  it("env-union: an env operator stays effective after a store removal of a different login", async () => {
    const mock = new MockD1Database();
    const ctx = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
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
    const ctx = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "  " }))?.status).toBe(400);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/operators/remove", "op1", { login: "" }))?.status).toBe(400);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/operators/add", "op1", { login: "op1" }))?.status).toBe(409);
  });
});
