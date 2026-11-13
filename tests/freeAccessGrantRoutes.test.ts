/**
 * Issue #3247 (sub-issue of #3241), slice 1 — free-access grant
 * routes: operator grant/revoke, own-or-operator read.
 *
 * A grant is the durable, revocable record of free ACCESS for
 * one login — no tier, no included runs, no free runs. The
 * target must have an account row (400 otherwise); the audit
 * tenant comes from the target's account row, never from a
 * client-supplied tenantId; grantedBy is the session-verified
 * operator login, never a client-supplied value. The routes
 * are not gated on the monetization flag (a grant is operator
 * data, not a purchase) and write no money artifacts.
 *
 * Route tests run the real Drizzle adapters over a MockD1Database
 * (node:sqlite, the slice0 pattern).
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function setup(envOverrides: Record<string, unknown> = {}) {
  const mock = new MockD1Database();
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
    ...envOverrides,
  };
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  return { ctx, env };
}

const req = (method: string, path: string, login: string | null, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

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

const bodyOf = async (res: Response | null) => (await res?.json()) as any;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function createAccount(ctx: AgenticPaymentsRouteContext, userId: string, tenantId: string) {
  const res = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
    userId,
    tenantId,
    tier: "Free",
    creditsUSD: 0,
    includedRuns: 0,
  });
  expect(res?.status).toBe(200);
  return (await bodyOf(res)).record;
}

const GRANT = "/payments/agentic/commercial/free-access/grant";
const REVOKE = "/payments/agentic/commercial/free-access/revoke";
const READ = "/payments/agentic/commercial/free-access";

describe("POST /free-access/grant (#3247)", () => {
  it("grants a lifetime grant: 200, the record, and the granted audit with the account-row tenant", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    const res = await call(ctx, "POST", GRANT, "op1", {
      userId: "u1",
      kind: "lifetime",
      reason: "Owner-approved pilot account",
    });
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.replaced).toBeNull();
    expect(body.granted).toMatchObject({
      login: "u1",
      kind: "lifetime",
      grantedBy: "op1",
      expiresAtMs: null,
      revokedAtMs: null,
      reason: "Owner-approved pilot account",
    });
    const grantedCalls = (ctx.audit as any).mock.calls as unknown[][];
    expect(grantedCalls).toContainEqual([
      "commercial.free_access.granted",
      "payments",
      expect.objectContaining({
        userId: "u1",
        tenantId: "t1",
        grantedBy: "op1",
        kind: "lifetime",
        reason: "Owner-approved pilot account",
        expiresAtMs: null,
      }),
    ]);
  });

  it("grants a limited grant with a future expiry", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    const expiresAtMs = Date.now() + 86_400_000;
    const res = await call(ctx, "POST", GRANT, "op1", {
      userId: "u1",
      kind: "limited",
      expiresAtMs,
      reason: "30-day pilot",
    });
    expect(res?.status).toBe(200);
    expect((await bodyOf(res)).granted).toMatchObject({ kind: "limited", expiresAtMs });
  });

  it("ignores client-supplied grantedBy and tenantId: session login and account row win", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    const res = await call(ctx, "POST", GRANT, "op1", {
      userId: "u1",
      kind: "lifetime",
      reason: "Pilot",
      grantedBy: "mallory",
      tenantId: "evil-tenant",
    });
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.granted.grantedBy).toBe("op1");
    const grantedCalls = (ctx.audit as any).mock.calls as unknown[][];
    expect(grantedCalls).toContainEqual([
      "commercial.free_access.granted",
      "payments",
      expect.objectContaining({ tenantId: "t1", grantedBy: "op1" }),
    ]);
  });

  it("granting over an active grant replaces it: revoked audit first, then granted", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    const first = await call(ctx, "POST", GRANT, "op1", {
      userId: "u1",
      kind: "lifetime",
      reason: "First",
    });
    expect(first?.status).toBe(200);
    const firstId = (await bodyOf(first)).granted.id;
    (ctx.audit as any).mockClear();
    const second = await call(ctx, "POST", GRANT, "op1", {
      userId: "u1",
      kind: "limited",
      expiresAtMs: Date.now() + 86_400_000,
      reason: "Corrected",
    });
    expect(second?.status).toBe(200);
    const body = await bodyOf(second);
    expect(body.replaced).toMatchObject({ id: firstId, kind: "lifetime" });
    expect(body.replaced.revokedAtMs).not.toBeNull();
    expect(body.granted.kind).toBe("limited");
    const calls = (ctx.audit as any).mock.calls as unknown[][];
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe("commercial.free_access.revoked");
    expect(calls[0][2]).toMatchObject({ userId: "u1", tenantId: "t1", revokedBy: "op1", kind: "lifetime" });
    expect(calls[1][0]).toBe("commercial.free_access.granted");
  });

  it("401 without a verified login, 403 for a non-operator", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    const anon = await call(ctx, "POST", GRANT, null, { userId: "u1", kind: "lifetime", reason: "x" });
    expect(anon?.status).toBe(401);
    const other = await call(ctx, "POST", GRANT, "u1", { userId: "u1", kind: "lifetime", reason: "x" });
    expect(other?.status).toBe(403);
    expect((await bodyOf(other)).error).toMatch(/store operator required/);
  });

  it("400s: missing userId, bad kind, lifetime with expiry, limited without/future expiry, empty reason", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    const cases: Array<[string, unknown]> = [
      ["missing userId", { kind: "lifetime", reason: "x" }],
      ["bad kind", { userId: "u1", kind: "forever", reason: "x" }],
      ["lifetime with expiry", { userId: "u1", kind: "lifetime", expiresAtMs: Date.now() + 1000, reason: "x" }],
      ["limited without expiry", { userId: "u1", kind: "limited", reason: "x" }],
      ["limited with past expiry", { userId: "u1", kind: "limited", expiresAtMs: Date.now() - 1000, reason: "x" }],
      ["empty reason", { userId: "u1", kind: "lifetime", reason: "  " }],
    ];
    for (const [label, body] of cases) {
      const res = await call(ctx, "POST", GRANT, "op1", body);
      expect(res?.status, label).toBe(400);
    }
    // Nothing was granted by the refused calls.
    const read = await call(ctx, "GET", `${READ}?userId=u1`, "op1");
    expect((await bodyOf(read)).active).toBeNull();
  });

  it("400 when the target has no account row (the operator creates the account first)", async () => {
    const { ctx } = setup();
    const res = await call(ctx, "POST", GRANT, "op1", {
      userId: "ghost",
      kind: "lifetime",
      reason: "x",
    });
    expect(res?.status).toBe(400);
    expect((await bodyOf(res)).error).toMatch(/No commercial account/);
  });

  it("503 when the store is unbound", async () => {
    const { ctx } = setup({ AGENT_DB: undefined });
    const res = await call(ctx, "POST", GRANT, "op1", {
      userId: "u1",
      kind: "lifetime",
      reason: "x",
    });
    expect(res?.status).toBe(503);
  });
});

describe("POST /free-access/revoke (#3247)", () => {
  it("revokes the active grant: 200, the revoked row, and the revoked audit", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    await call(ctx, "POST", GRANT, "op1", { userId: "u1", kind: "lifetime", reason: "Pilot" });
    (ctx.audit as any).mockClear();
    const res = await call(ctx, "POST", REVOKE, "op1", { userId: "u1", reason: "Pilot ended" });
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.revoked).toMatchObject({ login: "u1", kind: "lifetime" });
    expect(body.revoked.revokedAtMs).not.toBeNull();
    const revokedCalls = (ctx.audit as any).mock.calls as unknown[][];
    expect(revokedCalls).toContainEqual([
      "commercial.free_access.revoked",
      "payments",
      expect.objectContaining({
        userId: "u1",
        tenantId: "t1",
        revokedBy: "op1",
        kind: "lifetime",
        reason: "Pilot ended",
      }),
    ]);
    const readBody = await bodyOf(await call(ctx, "GET", `${READ}?userId=u1`, "op1"));
    expect(readBody.active).toBeNull();
    expect(readBody.history).toHaveLength(1);
  });

  it("404 when no active grant exists (stale UI), 400 without an account row", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    const res = await call(ctx, "POST", REVOKE, "op1", { userId: "u1" });
    expect(res?.status).toBe(404);
    const ghost = await call(ctx, "POST", REVOKE, "op1", { userId: "ghost" });
    expect(ghost?.status).toBe(400);
  });

  it("401 without a verified login, 403 for a non-operator, 400 for a missing userId or non-string reason", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    expect((await call(ctx, "POST", REVOKE, null, { userId: "u1" }))?.status).toBe(401);
    expect((await call(ctx, "POST", REVOKE, "u1", { userId: "u1" }))?.status).toBe(403);
    expect((await call(ctx, "POST", REVOKE, "op1", {}))?.status).toBe(400);
    expect((await call(ctx, "POST", REVOKE, "op1", { userId: "u1", reason: 42 }))?.status).toBe(400);
  });

  it("503 when the store is unbound", async () => {
    const { ctx } = setup({ AGENT_DB: undefined });
    const res = await call(ctx, "POST", REVOKE, "op1", { userId: "u1" });
    expect(res?.status).toBe(503);
  });
});

describe("GET /free-access (#3247)", () => {
  it("returns { userId, active, history } for the owner and for an operator, with no audit on read", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    await call(ctx, "POST", GRANT, "op1", { userId: "u1", kind: "lifetime", reason: "Pilot" });
    await call(ctx, "POST", REVOKE, "op1", { userId: "u1" });
    await call(ctx, "POST", GRANT, "op1", {
      userId: "u1",
      kind: "limited",
      expiresAtMs: Date.now() + 86_400_000,
      reason: "Second",
    });
    (ctx.audit as any).mockClear();
    const self = await call(ctx, "GET", `${READ}?userId=u1`, "u1");
    expect(self?.status).toBe(200);
    const selfBody = await bodyOf(self);
    expect(selfBody.userId).toBe("u1");
    expect(selfBody.active).toMatchObject({ kind: "limited", reason: "Second" });
    expect(selfBody.history).toHaveLength(2);
    expect(selfBody.history[0].kind).toBe("limited");
    expect(selfBody.history[1].kind).toBe("lifetime");
    expect(selfBody.history[1].revokedAtMs).not.toBeNull();
    const operator = await call(ctx, "GET", `${READ}?userId=u1`, "op1");
    expect(operator?.status).toBe(200);
    expect(await bodyOf(operator)).toEqual(selfBody);
    expect((ctx.audit as any).mock.calls).toHaveLength(0);
  });

  it("401 without a verified login, 400 without userId, 403 for another non-operator login", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    expect((await call(ctx, "GET", `${READ}?userId=u1`, null))?.status).toBe(401);
    expect((await call(ctx, "GET", READ, "op1"))?.status).toBe(400);
    const other = await call(ctx, "GET", `${READ}?userId=u1`, "u2");
    expect(other?.status).toBe(403);
  });

  it("503 when the store is unbound", async () => {
    const { ctx } = setup({ AGENT_DB: undefined });
    const res = await call(ctx, "GET", `${READ}?userId=op1`, "op1");
    expect(res?.status).toBe(503);
  });
});
