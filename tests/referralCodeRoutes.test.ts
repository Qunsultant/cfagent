/**
 * Issue #3307 (sub-issue of #3241), slice 1 — referral-code
 * routes R1–R10: rules (operator-only), issue (operator /
 * tenant admin), list, revoke, redeem (any verified login),
 * mine (self-service issue/list/revoke), balance read.
 *
 * Route tests run the real Drizzle adapters over a
 * MockD1Database (node:sqlite, the slice0 pattern). The
 * tenant-admin path injects an in-memory alias KV + membership
 * store through the ctx seams (production reads the
 * SessionStore KV).
 *
 * Codes confer runs only — never tier, never credits, never a
 * price, never access. The plaintext is returned once, at
 * issuance; hashes and values never leave the store.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import type { DatabaseORM } from "../src/orm";
import { createMemoryMembershipStore } from "../src/security/authorization";
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

const RULES = "/payments/agentic/commercial/referral-code-rules";
const CODES = "/payments/agentic/commercial/referral-codes";
const PRODUCT = "prod-per-run-stock";

async function upsertRule(
  ctx: AgenticPaymentsRouteContext,
  overrides: Record<string, unknown> = {},
) {
  const res = await call(ctx, "POST", RULES, "op1", {
    productId: PRODUCT,
    issuer: "platform_admin",
    runsPerCode: 5,
    reusable: false,
    expiryDays: 30,
    attributionMode: "ledger",
    maxRedemptionsPerCode: 1,
    maxRedemptionsPerLogin: 1,
    globalCap: null,
    active: true,
    ...overrides,
  });
  expect(res?.status).toBe(200);
  return (await bodyOf(res)).rule;
}

async function issueCode(
  ctx: AgenticPaymentsRouteContext,
  login: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await call(ctx, "POST", `${CODES}/issue`, login, {
    productId: PRODUCT,
    kind: "referral",
    referrerUserId: "op1",
    ...overrides,
  });
  return res;
}

/** A tenant-admin seam: login "ta1" is a tenant-admin in t1 only. */
async function withTenantAdmin(ctx: AgenticPaymentsRouteContext) {
  const aliasKv: KvLike = {
    async get(key: string) {
      if (key === "iaaa-alias:login:ta1") {
        return JSON.stringify({
          githubLogin: "ta1",
          internalUserId: "u-ta1",
          recordedAtMs: Date.now(),
          source: "wired-login",
        });
      }
      return null;
    },
    async put() {},
    async delete() {},
  };
  const membershipStore = createMemoryMembershipStore();
  await membershipStore.put({
    membershipId: "m-ta1-t1",
    internalUserId: "u-ta1",
    tenantId: "t1",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "op1" }],
  });
  ctx.referralCodeAliasKv = aliasKv;
  ctx.referralCodeMembershipStore = membershipStore;
}

describe("GET/POST /referral-code-rules (R1–R2)", () => {
  it("operator lists the seeded INACTIVE rule, activates it, and the list reflects the edit", async () => {
    const { ctx } = setup();
    const listed = await call(ctx, "GET", `${RULES}?productId=${PRODUCT}`, "op1");
    expect(listed?.status).toBe(200);
    const before = await bodyOf(listed);
    expect(before.rules).toHaveLength(1);
    expect(before.rules[0]).toMatchObject({
      productId: PRODUCT,
      issuer: "platform_admin",
      runsPerCode: 5,
      active: false,
    });
    const rule = await upsertRule(ctx);
    expect(rule.active).toBe(true);
    const after = await bodyOf(await call(ctx, "GET", `${RULES}?productId=${PRODUCT}`, "op1"));
    expect(after.rules[0].active).toBe(true);
    expect((ctx.audit as unknown as { mock: { calls: unknown[][] } }).mock.calls).toContainEqual(
      expect.arrayContaining(["commercial.referral_code.rule_upserted"]),
    );
  });

  it("non-operator gets 403, missing login gets 401, missing productId gets 400", async () => {
    const { ctx } = setup();
    expect((await call(ctx, "GET", `${RULES}?productId=${PRODUCT}`, "u1"))?.status).toBe(403);
    expect((await call(ctx, "POST", RULES, "u1", { productId: PRODUCT }))?.status).toBe(403);
    expect((await call(ctx, "GET", `${RULES}?productId=${PRODUCT}`, null))?.status).toBe(401);
    expect((await call(ctx, "GET", RULES, "op1"))?.status).toBe(400);
    const bad = await call(ctx, "POST", RULES, "op1", { productId: PRODUCT, issuer: "platform_admin", runsPerCode: 0, attributionMode: "ledger" });
    expect(bad?.status).toBe(400);
  });
});

describe("POST /referral-codes/issue (R3)", () => {
  it("operator issues a code: 200, plaintext once, no hash in the response, and the issued audit", async () => {
    const { ctx } = setup();
    await upsertRule(ctx);
    const res = await issueCode(ctx, "op1");
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.plaintext).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(body.code).toMatchObject({
      productId: PRODUCT,
      kind: "referral",
      issuerLogin: "op1",
      issuerKind: "platform_admin",
      referrerUserId: "op1",
      runs: 5,
    });
    expect(body.code).not.toHaveProperty("codeHash");
    expect(body.code).not.toHaveProperty("plaintext");
    expect((ctx.audit as unknown as { mock: { calls: unknown[][] } }).mock.calls).toContainEqual(
      expect.arrayContaining(["commercial.referral_code.issued"]),
    );
  });

  it("issue without an active rule is 409 RULE_UNAVAILABLE (fail-closed)", async () => {
    const { ctx } = setup();
    const res = await issueCode(ctx, "op1");
    expect(res?.status).toBe(409);
    const body = await bodyOf(res);
    expect(body.code).toBe("FAILURE_REFERRAL_CODE_RULE_UNAVAILABLE");
  });

  it("tenant admin issues a tenant-scoped code for their own tenant, and 403 for any other tenant", async () => {
    const { ctx } = setup();
    await withTenantAdmin(ctx);
    await upsertRule(ctx, { issuer: "tenant_admin" });
    const ok = await issueCode(ctx, "ta1", { issuer: "tenant_admin", tenantScope: "t1" });
    expect(ok?.status).toBe(200);
    const okBody = await bodyOf(ok);
    expect(okBody.code.tenantScope).toBe("t1");
    expect(okBody.code.issuerKind).toBe("tenant_admin");
    const wrongTenant = await issueCode(ctx, "ta1", { issuer: "tenant_admin", tenantScope: "t2" });
    expect(wrongTenant?.status).toBe(403);
    const noScope = await issueCode(ctx, "ta1", { issuer: "tenant_admin" });
    expect(noScope?.status).toBe(400);
  });

  it("a non-operator may not issue as platform_admin, and the user issuer never goes through /issue", async () => {
    const { ctx } = setup();
    await upsertRule(ctx);
    expect((await issueCode(ctx, "u1"))?.status).toBe(403);
    const userIssuer = await issueCode(ctx, "u1", { issuer: "user" });
    expect(userIssuer?.status).toBe(403);
  });
});

describe("GET /referral-codes + POST /referral-codes/revoke (R4–R5)", () => {
  it("operator lists codes with prefixes only, revokes idempotently, and 404s an unknown id", async () => {
    const { ctx } = setup();
    await upsertRule(ctx);
    const issued = await bodyOf(await issueCode(ctx, "op1"));
    const listed = await bodyOf(await call(ctx, "GET", `${CODES}?productId=${PRODUCT}`, "op1"));
    expect(listed.codes).toHaveLength(1);
    expect(listed.codes[0].displayPrefix).toBe(issued.code.displayPrefix);
    expect(listed.codes[0]).not.toHaveProperty("codeHash");
    const codeId = issued.code.id;
    const revoked = await call(ctx, "POST", `${CODES}/revoke`, "op1", { codeId });
    expect(revoked?.status).toBe(200);
    const revokedBody = await bodyOf(revoked);
    expect(revokedBody.code.revokedAtMs).not.toBeNull();
    const again = await call(ctx, "POST", `${CODES}/revoke`, "op1", { codeId });
    expect(again?.status).toBe(200);
    expect((await bodyOf(again)).code.revokedAtMs).toBe(revokedBody.code.revokedAtMs);
    expect((await call(ctx, "POST", `${CODES}/revoke`, "op1", { codeId: "nope" }))?.status).toBe(404);
    expect((await call(ctx, "GET", `${CODES}?productId=${PRODUCT}`, "u1"))?.status).toBe(403);
  });
});

describe("POST /referral-codes/redeem (R6)", () => {
  it("redeems end to end: balance credited, attribution stamped source=code, replay is a no-op", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    await upsertRule(ctx);
    const { plaintext } = await bodyOf(await issueCode(ctx, "op1"));
    const res = await call(ctx, "POST", `${CODES}/redeem`, "u1", { code: plaintext });
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toMatchObject({ runsGranted: 5, attributionWritten: true, replayed: false, codeRunsBalance: 5 });
    // The #2657 ledger now attributes u1 → op1 with source "code".
    const balance = await bodyOf(
      await call(ctx, "GET", "/payments/agentic/commercial/referral/balance?userId=u1", "op1"),
    );
    expect(balance.attribution).toMatchObject({ referrerUserId: "op1", referredUserId: "u1", source: "code" });
    // Replay: same redemption, balance untouched.
    const replay = await bodyOf(await call(ctx, "POST", `${CODES}/redeem`, "u1", { code: plaintext }));
    expect(replay.replayed).toBe(true);
    expect(replay.codeRunsBalance).toBe(5);
    expect((ctx.audit as unknown as { mock: { calls: unknown[][] } }).mock.calls).toContainEqual(
      expect.arrayContaining(["commercial.referral_code.redeemed"]),
    );
  });

  it("unknown and revoked codes share ONE generic 400; a tenant-scope refusal is 403 generic", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    await createAccount(ctx, "u2", "t2");
    await upsertRule(ctx);
    const { plaintext, code } = await bodyOf(await issueCode(ctx, "op1", { tenantScope: "t1" }));
    const unknown = await call(ctx, "POST", `${CODES}/redeem`, "u1", { code: "AAAA-BBBB-CCCC-DDDD" });
    expect(unknown?.status).toBe(400);
    expect((await bodyOf(unknown)).code).toBe("FAILURE_REFERRAL_CODE_INVALID");
    const wrongTenant = await call(ctx, "POST", `${CODES}/redeem`, "u2", { code: plaintext });
    expect(wrongTenant?.status).toBe(403);
    expect((await bodyOf(wrongTenant)).code).toBe("FAILURE_REFERRAL_CODE_INVALID");
    await call(ctx, "POST", `${CODES}/revoke`, "op1", { codeId: code.id });
    const revoked = await call(ctx, "POST", `${CODES}/redeem`, "u1", { code: plaintext });
    expect(revoked?.status).toBe(400);
    expect((await bodyOf(revoked)).code).toBe("FAILURE_REFERRAL_CODE_INVALID");
  });

  it("cap exhaustion is the only specific failure (409)", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    await createAccount(ctx, "u2", "t1");
    await upsertRule(ctx, { reusable: true, maxRedemptionsPerCode: 1, maxRedemptionsPerLogin: null });
    const { plaintext } = await bodyOf(await issueCode(ctx, "op1"));
    expect((await call(ctx, "POST", `${CODES}/redeem`, "u1", { code: plaintext }))?.status).toBe(200);
    const second = await call(ctx, "POST", `${CODES}/redeem`, "u2", { code: plaintext });
    expect(second?.status).toBe(409);
    expect((await bodyOf(second)).code).toBe("FAILURE_REFERRAL_CODE_CAP_EXCEEDED");
  });
});

describe("GET/POST /referral-codes/mine + POST /referral-codes/mine/revoke (R7–R9)", () => {
  it("self-service issuance is 409 until a user-issuer rule is active, then mints a fresh code each time", async () => {
    const { ctx } = setup();
    const disabled = await call(ctx, "POST", `${CODES}/mine`, "u1", { productId: PRODUCT });
    expect(disabled?.status).toBe(409);
    expect((await bodyOf(disabled)).code).toBe("FAILURE_REFERRAL_CODE_RULE_UNAVAILABLE");
    await upsertRule(ctx, { issuer: "user" });
    const first = await bodyOf(await call(ctx, "POST", `${CODES}/mine`, "u1", { productId: PRODUCT }));
    expect(first.code).toMatchObject({
      kind: "referral",
      issuerKind: "user",
      issuerLogin: "u1",
      referrerUserId: "u1",
      tenantScope: null,
    });
    expect(first.plaintext).toBeTruthy();
    const second = await bodyOf(await call(ctx, "POST", `${CODES}/mine`, "u1", { productId: PRODUCT }));
    expect(second.plaintext).not.toBe(first.plaintext);
    const mine = await bodyOf(await call(ctx, "GET", `${CODES}/mine`, "u1"));
    expect(mine.codes).toHaveLength(2);
    expect(mine.codes[0]).not.toHaveProperty("codeHash");
    // Revoke my own code; another login's code is 403 (not 404).
    const revoked = await call(ctx, "POST", `${CODES}/mine/revoke`, "u1", { codeId: first.code.id });
    expect(revoked?.status).toBe(200);
    await upsertRule(ctx);
    const others = await bodyOf(await issueCode(ctx, "op1"));
    const forbidden = await call(ctx, "POST", `${CODES}/mine/revoke`, "u1", { codeId: others.code.id });
    expect(forbidden?.status).toBe(403);
    const unknown = await call(ctx, "POST", `${CODES}/mine/revoke`, "u1", { codeId: "nope" });
    expect(unknown?.status).toBe(404);
  });
});

describe("GET /referral-codes/balance (R10)", () => {
  it("own-or-operator read; another login gets 403", async () => {
    const { ctx } = setup();
    await createAccount(ctx, "u1", "t1");
    await upsertRule(ctx);
    const { plaintext } = await bodyOf(await issueCode(ctx, "op1"));
    await call(ctx, "POST", `${CODES}/redeem`, "u1", { code: plaintext });
    const mine = await bodyOf(await call(ctx, "GET", `${CODES}/balance?userId=u1`, "u1"));
    expect(mine).toEqual({ userId: "u1", codeRunsAvailable: 5 });
    const byOperator = await bodyOf(await call(ctx, "GET", `${CODES}/balance?userId=u1`, "op1"));
    expect(byOperator.codeRunsAvailable).toBe(5);
    expect((await call(ctx, "GET", `${CODES}/balance?userId=u1`, "u2"))?.status).toBe(403);
    expect((await call(ctx, "GET", `${CODES}/balance`, "u1"))?.status).toBe(400);
  });
});

describe("referral-code routes without a store", () => {
  it("AGENT_DB unbound answers 503, never a silent pass", async () => {
    const { ctx } = setup({ AGENT_DB: undefined });
    const res = await call(ctx, "GET", `${RULES}?productId=${PRODUCT}`, "op1");
    expect(res?.status).toBe(503);
  });
});
