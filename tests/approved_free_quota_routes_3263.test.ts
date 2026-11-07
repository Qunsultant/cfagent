// @vitest-environment node
/**
 * Issue #3263 (sub-issue of #3256; ownership COO-spr9) — approved-free
 * quota routes.
 *
 * GET /payments/agentic/commercial/approved-free-quota?userId= is own
 * or operator: the tenant is server-resolved from the account row —
 * no client-supplied tenantId exists. POST is operator-only and
 * sets one thing per call (a family cap, the window, or the
 * at-limit action), validated by the port asserts (400) and
 * audited. Unbound AGENT_DB fails closed with 503.
 *
 * Submission-status also surfaces the completed workflow output
 * (outcome + outcomeCode) when the binding status carries one, so
 * the CheckoutPanel poll can map quota_exhausted to the catalog
 * message; the existing {workflowId, status} shape is unchanged
 * when there is no output.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import { createCommercialAdapter } from "../src/data/createCommercialPorts";
import type { DatabaseORM } from "../src/orm";
import { approvedFreeQuotaPeriodKey } from "../src/data/approvedFreeQuotaPorts";
import { resolveOutcome } from "../src/outcomes/outcomeAspects";
import { createD1ApprovedFreeQuotaDb, ensureApprovedFreeQuotaSchema } from "../src/data/d1ApprovedFreeQuotaAdapter";
import { agentApprovedFreeQuotaCounts } from "../src/data/drizzleSchema";

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

async function setup(bindingStatus?: () => Promise<unknown>) {
  const mock = new MockD1Database();
  const db = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(db);
  const binding = {
    create: vi.fn(async ({ id }: { id: string }) => ({ id })),
    get: vi.fn(async () => ({
      status: bindingStatus ?? (async () => ({ status: "completed" })),
    })),
  };
  const screenerBinding = {
    create: vi.fn(async ({ id }: { id: string }) => ({ id })),
    get: vi.fn(async () => {
      throw new Error("not found");
    }),
  };
  const env = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
    PAYMENT_WORKFLOW: binding,
    SCREENER_WORKFLOW: screenerBinding,
  };
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  const store = createCommercialAdapter({ AGENT_DB: mock });
  return { ctx, env, binding, db, store, mock };
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

async function grantAccount(ctx: AgenticPaymentsRouteContext, userId = "u1", tenantId = "t1") {
  const created = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
    userId,
    tenantId,
    tier: "Free",
    creditsUSD: 0,
    includedRuns: 0,
    unlimitedFreeGrant: { grantedBy: "op1", reason: "Owner-approved pilot account", expiresAtMs: null },
  });
  expect(created?.status).toBe(200);
}

const CURRENT_PERIOD = approvedFreeQuotaPeriodKey(Date.now(), "month");

describe("approved-free quota routes (#3263)", () => {
  it("GET own state returns seeded settings, per-family caps, and the active grant", async () => {
    const { ctx } = await setup();
    await grantAccount(ctx);
    const res = await call(ctx, "GET", "/payments/agentic/commercial/approved-free-quota", "u1");
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      userId: string;
      tenantId: string | null;
      settings: { windowKind: string; atLimitAction: string } | null;
      period: string | null;
      families: Array<{ family: string; cap: number | null; used: number; remaining: number | null; period: string | null }>;
      grant: { active: boolean; expiresAtMs: number | null };
    };
    expect(body.userId).toBe("u1");
    expect(body.tenantId).toBe("t1");
    // Seeded PROPOSED defaults (migration 0055): 10/month, decision-4 action.
    expect(body.settings).toMatchObject({ windowKind: "month", atLimitAction: "upgrade_or_buy_credits" });
    expect(body.period).toBe(CURRENT_PERIOD);
    expect(body.families).toHaveLength(4);
    for (const row of body.families) {
      expect(row).toMatchObject({ cap: 10, used: 0, remaining: 10, period: CURRENT_PERIOD });
    }
    expect(body.grant).toEqual({ active: true, expiresAtMs: null });
  });

  it("GET as operator for another user works; another user is 403; no login is 401", async () => {
    const { ctx } = await setup();
    await grantAccount(ctx);
    const asOperator = await call(ctx, "GET", "/payments/agentic/commercial/approved-free-quota?userId=u1", "op1");
    expect(asOperator?.status).toBe(200);
    const asOther = await call(ctx, "GET", "/payments/agentic/commercial/approved-free-quota?userId=u1", "u2");
    expect(asOther?.status).toBe(403);
    const anon = await call(ctx, "GET", "/payments/agentic/commercial/approved-free-quota", null);
    expect(anon?.status).toBe(401);
  });

  it("GET for a user with no account reports no tenant, no grant, and zero usage", async () => {
    const { ctx } = await setup();
    const res = await call(ctx, "GET", "/payments/agentic/commercial/approved-free-quota", "u9");
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      tenantId: string | null;
      grant: { active: boolean };
      families: Array<{ used: number }>;
    };
    expect(body.tenantId).toBeNull();
    expect(body.grant.active).toBe(false);
    expect(body.families.every((row) => row.used === 0)).toBe(true);
  });

  it("POST setCap as operator updates the cap, is audited with code+message+login, and the GET reflects it; non-operator is 403", async () => {
    const { ctx } = await setup();
    await grantAccount(ctx);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/approved-free-quota", "op1", {
      family: "goal",
      capRuns: 2,
    });
    expect(res?.status).toBe(200);
    // AOP: the success body carries the catalog code + business
    // message, asserted FROM the catalog — never a hardcoded string.
    const code = "SUCCESS_APPROVED_FREE_QUOTA_UPDATED";
    expect(await res?.json()).toEqual({
      family: "goal",
      capRuns: 2,
      code,
      message: resolveOutcome(code).businessMessage,
    });
    // AOP (#1969): the audit record alone answers which code, what
    // happened, for which login.
    expect((ctx.audit as unknown as { mock: { calls: unknown[][] } }).mock.calls).toContainEqual([
      "commercial.approved_free_quota.set",
      "payments",
      {
        family: "goal",
        capRuns: 2,
        operator: "op1",
        outcomeCode: code,
        message: resolveOutcome(code).businessMessage,
      },
    ]);
    const after = (await (
      await call(ctx, "GET", "/payments/agentic/commercial/approved-free-quota", "u1")
    )?.json()) as { families: Array<{ family: string; cap: number | null }> };
    expect(after.families.find((row) => row.family === "goal")?.cap).toBe(2);
    const forbidden = await call(ctx, "POST", "/payments/agentic/commercial/approved-free-quota", "u1", {
      family: "goal",
      capRuns: 5,
    });
    expect(forbidden?.status).toBe(403);
  });

  it("POST validates: unknown family, negative cap, bad window, bad action, and empty body are coded 400s", async () => {
    const { ctx } = await setup();
    // AOP (#2573): the failure kind is recorded structurally at the
    // point of failure; the route maps kind to a catalog code and
    // the body carries the catalog businessMessage — asserted FROM
    // the catalog, never a hardcoded string, never raw error text.
    const cases: Array<{ body: unknown; code: string }> = [
      { body: { family: "nope", capRuns: 5 }, code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_FAMILY" },
      { body: { family: "goal", capRuns: -1 }, code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_CAP" },
      { body: { family: "goal", capRuns: 1.5 }, code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_CAP" },
      { body: { windowKind: "year" }, code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_WINDOW" },
      { body: { atLimitAction: "refund" }, code: "FAILURE_APPROVED_FREE_QUOTA_INVALID_ACTION" },
      { body: {}, code: "FAILURE_APPROVED_FREE_QUOTA_MISSING_UPDATE" },
    ];
    for (const { body, code } of cases) {
      const res = await call(ctx, "POST", "/payments/agentic/commercial/approved-free-quota", "op1", body);
      expect(res?.status).toBe(400);
      expect(await res?.json()).toEqual({
        error: resolveOutcome(code).businessMessage,
        code,
        retryable: false,
      });
    }
  });

  it("tenant isolation (#1069, tech-standards §6): a user in Tenant B cannot read or act on Tenant A's quota", async () => {
    const { ctx } = await setup();
    await grantAccount(ctx, "u1", "t1");
    await grantAccount(ctx, "u2", "t2");
    // Cross-tenant read: 403 (u2 is a different login in a different tenant).
    const read = await call(ctx, "GET", "/payments/agentic/commercial/approved-free-quota?userId=u1", "u2");
    expect(read?.status).toBe(403);
    // Cross-tenant write: 403 (operator-only, and u2 is not an operator).
    const write = await call(ctx, "POST", "/payments/agentic/commercial/approved-free-quota", "u2", {
      family: "goal",
      capRuns: 1,
    });
    expect(write?.status).toBe(403);
    // The operator CAN read across tenants (store-wide by design) —
    // and sees Tenant A's state, not Tenant B's.
    const asOperator = await call(ctx, "GET", "/payments/agentic/commercial/approved-free-quota?userId=u1", "op1");
    expect(asOperator?.status).toBe(200);
    expect(((await asOperator?.json()) as { tenantId: string | null }).tenantId).toBe("t1");
    // Tenant A's quota is untouched by the refused attempts.
    const after = (await (
      await call(ctx, "GET", "/payments/agentic/commercial/approved-free-quota", "u1")
    )?.json()) as { families: Array<{ family: string; cap: number | null }> };
    expect(after.families.find((row) => row.family === "goal")?.cap).toBe(10);
  });

  it("POST is an idempotent upsert (tech-standards §7.2): replay with identical values returns the same 200 + state", async () => {
    const { ctx } = await setup();
    await grantAccount(ctx);
    const first = await call(ctx, "POST", "/payments/agentic/commercial/approved-free-quota", "op1", {
      family: "goal",
      capRuns: 2,
    });
    const second = await call(ctx, "POST", "/payments/agentic/commercial/approved-free-quota", "op1", {
      family: "goal",
      capRuns: 2,
    });
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    expect(await second?.json()).toEqual(await first?.json());
    const after = (await (
      await call(ctx, "GET", "/payments/agentic/commercial/approved-free-quota", "u1")
    )?.json()) as { families: Array<{ family: string; cap: number | null }> };
    expect(after.families.find((row) => row.family === "goal")?.cap).toBe(2);
    // A replay with DIFFERENT values is a new operator intent and wins.
    const changed = await call(ctx, "POST", "/payments/agentic/commercial/approved-free-quota", "op1", {
      family: "goal",
      capRuns: 4,
    });
    expect(changed?.status).toBe(200);
    const afterChange = (await (
      await call(ctx, "GET", "/payments/agentic/commercial/approved-free-quota", "u1")
    )?.json()) as { families: Array<{ family: string; cap: number | null }> };
    expect(afterChange.families.find((row) => row.family === "goal")?.cap).toBe(4);
  });

  it("POST settings round-trip: window and at-limit action persist and the GET reflects them", async () => {
    const { ctx } = await setup();
    const code = "SUCCESS_APPROVED_FREE_QUOTA_UPDATED";
    const week = await call(ctx, "POST", "/payments/agentic/commercial/approved-free-quota", "op1", {
      windowKind: "week",
    });
    expect(week?.status).toBe(200);
    const weekBody = (await week?.json()) as { settings: { windowKind: string }; code: string; message: string };
    expect(weekBody.settings.windowKind).toBe("week");
    expect(weekBody.code).toBe(code);
    expect(weekBody.message).toBe(resolveOutcome(code).businessMessage);
    const stop = await call(ctx, "POST", "/payments/agentic/commercial/approved-free-quota", "op1", {
      atLimitAction: "stop",
    });
    expect(stop?.status).toBe(200);
    const after = (await (
      await call(ctx, "GET", "/payments/agentic/commercial/approved-free-quota", "op1")
    )?.json()) as { settings: { windowKind: string; atLimitAction: string }; period: string | null };
    expect(after.settings).toMatchObject({ windowKind: "week", atLimitAction: "stop" });
    expect(after.period).toBe(approvedFreeQuotaPeriodKey(Date.now(), "week"));
  });

  it("unbound AGENT_DB fails closed with a coded 503 on both routes", async () => {
    const { ctx, env } = await setup();
    const unbound = {
      ...ctx,
      env: { ...env, AGENT_DB: undefined },
    } as unknown as AgenticPaymentsRouteContext;
    const code = "FAILURE_APPROVED_FREE_QUOTA_UNAVAILABLE";
    const get = await call(unbound, "GET", "/payments/agentic/commercial/approved-free-quota", "u1");
    expect(get?.status).toBe(503);
    expect(await get?.json()).toEqual({
      error: resolveOutcome(code).businessMessage,
      code,
      retryable: true,
    });
    const post = await call(unbound, "POST", "/payments/agentic/commercial/approved-free-quota", "op1", {
      family: "goal",
      capRuns: 2,
    });
    expect(post?.status).toBe(503);
    expect(await post?.json()).toEqual({
      error: resolveOutcome(code).businessMessage,
      code,
      retryable: true,
    });
  });

  it("GET with a corrupt stored count fails closed with the coded 500, never a raw error", async () => {
    const { ctx, mock } = await setup();
    await grantAccount(ctx);
    // A count row written outside the port with an invalid value.
    const qdb = createD1ApprovedFreeQuotaDb(mock as unknown as D1Database);
    await ensureApprovedFreeQuotaSchema(qdb);
    await qdb.insert(agentApprovedFreeQuotaCounts).values({
      tenantId: "t1",
      userLogin: "u1",
      family: "goal",
      period: CURRENT_PERIOD,
      used: -1,
      updatedAtMs: 1,
    });
    const res = await call(ctx, "GET", "/payments/agentic/commercial/approved-free-quota", "u1");
    expect(res?.status).toBe(500);
    const code = "FAILURE_APPROVED_FREE_QUOTA_CORRUPT";
    expect(await res?.json()).toEqual({
      error: resolveOutcome(code).businessMessage,
      code,
      retryable: false,
    });
  });

  it("submission-status surfaces the workflow output (outcome + outcomeCode) when present", async () => {
    const { ctx, store } = await setup(async () => ({
      status: "complete",
      output: { status: "quota_exhausted", outcomeCode: "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED" },
    }));
    await store!.recordPaidSubmission({ workflowId: "wf-1", userId: "u1", runRequestId: "run-1" });
    const res = await call(ctx, "GET", "/payments/agentic/commercial/submission-status?workflowId=wf-1", "u1");
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({
      workflowId: "wf-1",
      status: "complete",
      outcome: "quota_exhausted",
      outcomeCode: "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED",
    });
  });
});
