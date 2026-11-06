/**
 * Issue #2219 (program #2218, slice 1) — automatic read-only
 * platform identity on the payment workflow screen.
 *
 * Server side, tested through handleAgenticPaymentsRoutes: the
 * self-only identity endpoint, and tenant derivation on the
 * paid-submission and subscription checkout/purchase routes —
 * resolved identity wins over any client-supplied tenantId, even
 * on mismatch; session scope is always (the free path never reads
 * a client tenantId, and the screener command's tenant is stamped
 * from the session); pay-per-run submit with no resolved account
 * fails closed, while subscription checkout/purchase
 * auto-provision the account row at activation. D1 setup mirrors
 * the commercial/subscription route tests (node:sqlite
 * MockD1Database, migrations 0007 + 0008).
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import {
  NO_ACCOUNT_PAID_MESSAGE,
  resolvePlatformIdentity,
} from "../src/services/platformIdentity";
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

async function setup(opts: { monetization?: boolean; stripe?: boolean } = {}) {
  const mock = new MockD1Database();
  await ensureCommercialSchema(createD1CommercialDb(mock as unknown as D1Database));
  await ensureSubscriptionSchema(createD1SubscriptionDb(mock as unknown as D1Database));
  let capturedParams: any = null;
  const binding = {
    create: vi.fn(async ({ id, params }: { id: string; params?: unknown }) => {
      capturedParams = params;
      return { workflowId: id };
    }),
    get: vi.fn(async () => ({ status: async () => ({ status: "completed" }) })),
  };
  const screenerBinding = {
    create: vi.fn(async ({ id }: { id: string }) => ({ id })),
    get: vi.fn(async () => {
      throw new Error("not found");
    }),
  };
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
    PAYMENT_WORKFLOW: binding,
    SCREENER_WORKFLOW: screenerBinding,
  };
  if (opts.monetization) env.MONETIZATION_ENABLED = "true";
  if (opts.stripe) env.STRIPE_SECRET_KEY = "sk_test_stub";
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  return { ctx, env, binding, captured: () => capturedParams };
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

const screenerCommand = {
  jobId: "job-1",
  type: "run-screen",
  source: "test",
  trigger: "manual",
  userLogin: "u1",
  shards: [{ shardId: "goal" }],
  role: "parent",
};

async function upsertAccount(ctx: AgenticPaymentsRouteContext, userId: string, tenantId: string, tier = "Free") {
  const res = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
    userId,
    tenantId,
    tier,
    creditsUSD: 5,
    includedRuns: 2,
  });
  expect(res?.status).toBe(200);
}

/**
 * Stub fetch as the Stripe REST API (the route's native card rail after
 * #2198): POST /v1/checkout/sessions mints a session; GET returns
 * complete + paid + amount/reference-matched evidence for it.
 */
function stubStripe() {
  const sessions = new Map<string, { draft: string; amount: number }>();
  let counter = 0;
  const mock = vi.fn(async (url: string, init: any) => {
    const href = String(url);
    if (href === "https://api.stripe.com/v1/checkout/sessions" && init?.method === "POST") {
      const params = new URLSearchParams(String(init.body));
      const draft = params.get("client_reference_id") ?? "";
      const amount = Number(params.get("line_items[0][price_data][unit_amount]") ?? 0);
      counter += 1;
      const id = `cs_test_${counter}`;
      sessions.set(id, { draft, amount });
      return { ok: true, status: 200, json: async () => ({ id, url: `https://checkout.stripe.com/pay/${id}` }) };
    }
    const m = href.match(/^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/([^/]+)$/);
    if (m && init?.method === "GET") {
      const session = sessions.get(decodeURIComponent(m[1]));
      if (!session) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: decodeURIComponent(m[1]),
          status: "complete",
          payment_status: "paid",
          amount_total: session.amount,
          client_reference_id: session.draft,
          payment_intent: "pi_test_1",
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("platform identity endpoint (#2219)", () => {
  it("returns the session user's resolved identity; anonymous is 401; unbound store is 503", async () => {
    const { ctx } = await setup();
    await upsertAccount(ctx, "u1", "t1", "PayPerUse");
    const res = await call(ctx, "GET", "/payments/agentic/commercial/identity", "u1");
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.userLogin).toBe("u1");
    expect(body.tenantId).toBe("t1");
    expect(body.hasAccount).toBe(true);
    expect(body.tier).toBe("PayPerUse");
    expect(body.creditsUSD).toBe(5);
    expect(body.includedRunsRemaining).toBe(2);
    expect(body).not.toHaveProperty("stored");
    expect((await call(ctx, "GET", "/payments/agentic/commercial/identity", null))?.status).toBe(401);
    const noDbCtx = {
      ...ctx,
      env: { ...(ctx.env as Record<string, unknown>), AGENT_DB: undefined },
    } as unknown as AgenticPaymentsRouteContext;
    expect((await call(noDbCtx, "GET", "/payments/agentic/commercial/identity", "u1"))?.status).toBe(503);
  });

  it("is self-only by construction: a userId query param cannot fetch another user's identity", async () => {
    const { ctx } = await setup();
    await upsertAccount(ctx, "u1", "t1");
    await upsertAccount(ctx, "u2", "t2");
    const body = await bodyOf(
      await call(ctx, "GET", "/payments/agentic/commercial/identity?userId=u2", "u1"),
    );
    expect(body.userLogin).toBe("u1");
    expect(body.tenantId).toBe("t1");
  });

  it("a missing row resolves to hasAccount false with a null tenant, not an error", async () => {
    const { ctx } = await setup();
    const body = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/identity", "u1"));
    expect(body.hasAccount).toBe(false);
    expect(body.tenantId).toBeNull();
    expect(body.tier).toBe("Free");
    expect(body.creditsUSD).toBe(0);
    expect(body.includedRunsRemaining).toBe(0);
  });
});

describe("platform identity resolution unit (#2219)", () => {
  it("fails closed on an unbound store and on a subscription-read failure", async () => {
    await expect(
      resolvePlatformIdentity({ commercial: null, subscriptions: null }, { userId: "u1", nowMs: 0 }),
    ).rejects.toThrow(/unavailable/);
    const commercial = { getAccount: async () => null } as any;
    const subscriptions = {
      listSubscriptions: async () => {
        throw new Error("db down");
      },
    } as any;
    await expect(
      resolvePlatformIdentity({ commercial, subscriptions }, { userId: "u1", nowMs: 0 }),
    ).rejects.toThrow(/Subscription state unavailable/);
  });
});

describe("submit route tenant derivation (#2219)", () => {
  const submitBody = {
    family: "goal",
    email: "u1@example.com",
    screenerCommand,
  };

  it("resolved identity wins over a mismatched client tenantId (flag OFF)", async () => {
    const { ctx, captured } = await setup();
    await upsertAccount(ctx, "u1", "t2", "PayPerUse");
    const res = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", {
      ...submitBody,
      tenantId: "t1",
    });
    expect(res?.status).toBe(200);
    expect(((await bodyOf(res)) as { status: string }).status).toBe("payment_started");
    expect((captured() as any).tenantId).toBe("t2");
    expect((captured() as any).account.tenantId).toBe("t2");
  });

  it("paid path (flag ON) with no resolved account fails closed with the account-setup message", async () => {
    const { ctx, binding } = await setup({ monetization: true });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", {
      ...submitBody,
      tenantId: "t1",
    });
    expect(res?.status).toBe(403);
    expect(((await bodyOf(res)) as { error: string }).error).toBe(NO_ACCOUNT_PAID_MESSAGE);
    expect(binding.create).not.toHaveBeenCalled();
  });

  it("paid path (flag ON) with a resolved account ignores a mismatched client tenantId", async () => {
    const { ctx, captured } = await setup({ monetization: true });
    await upsertAccount(ctx, "u1", "t2", "PayPerUse");
    const res = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", {
      ...submitBody,
      tenantId: "t1",
    });
    expect(res?.status).toBe(200);
    expect((captured() as any).tenantId).toBe("t2");
  });

  it("free path (flag OFF) with no resolved account and no client tenant proceeds under the login scope", async () => {
    const { ctx, captured } = await setup();
    const res = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", submitBody);
    expect(res?.status).toBe(200);
    expect((captured() as any).tenantId).toBe("u1");
  });

  it("free path (flag OFF) ignores a mismatched client tenantId AND a client tenantId inside screenerCommand", async () => {
    const { ctx, captured } = await setup();
    const res = await call(ctx, "POST", "/payments/agentic/commercial/submit", "u1", {
      ...submitBody,
      tenantId: "attacker-tenant",
      screenerCommand: { ...screenerCommand, tenantId: "attacker-tenant" },
    });
    expect(res?.status).toBe(200);
    expect((captured() as any).tenantId).toBe("u1");
    expect((captured() as any).account.tenantId).toBe("u1");
    expect((captured() as any).screenerCommand.tenantId).toBe("u1");
    expect((captured() as any).screenerCommand.userLogin).toBe("u1");
  });
});

describe("subscription tenant derivation (#2219, native card checkout)", () => {
  it("checkout ignores a mismatched client tenantId and audits the resolved tenant", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubStripe();
    await upsertAccount(ctx, "u1", "t1");
    const plan = (
      await bodyOf(
        await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
          name: "P",
          priceUSD: 5,
          periodDays: 30,
          includedRuns: 0,
        }),
      )
    ).plan;
    // Issue #3357: new plans land PROPOSED — approve before charging (the gate working as designed).
    const approved = await call(ctx, "POST", "/payments/agentic/commercial/plans/approve", "op1", { planId: plan.id });
    expect(approved?.status).toBe(200);
    const checkout = await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", {
      planId: plan.id,
      tenantId: "t2",
      email: "u1@example.com",
    });
    expect(checkout?.status).toBe(200);
    const body = await bodyOf(checkout);
    expect(body.checkoutRequestId).toMatch(/^sub-/);
    expect(body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const auditCalls = (ctx.audit as unknown as { mock: { calls: Array<[string, string, Record<string, unknown>]> } }).mock.calls;
    const created = auditCalls.find(([t]) => t === "commercial.subscription.checkout_created");
    expect(created?.[2].tenantId).toBe("t1");
  });

  it("checkout with no resolved account mints under the session login scope and creates no row", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubStripe();
    const plan = (
      await bodyOf(
        await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
          name: "P",
          priceUSD: 5,
          periodDays: 30,
          includedRuns: 0,
        }),
      )
    ).plan;
    // Issue #3357: new plans land PROPOSED — approve before charging (the gate working as designed).
    const approved = await call(ctx, "POST", "/payments/agentic/commercial/plans/approve", "op1", { planId: plan.id });
    expect(approved?.status).toBe(200);
    const checkout = await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", {
      planId: plan.id,
      tenantId: "attacker-tenant",
      email: "u1@example.com",
    });
    expect(checkout?.status).toBe(200);
    expect(((await bodyOf(checkout)) as { checkoutRequestId: string }).checkoutRequestId).toMatch(/^sub-/);
    const auditCalls = (ctx.audit as unknown as { mock: { calls: Array<[string, string, Record<string, unknown>]> } }).mock.calls;
    const created = auditCalls.find(([t]) => t === "commercial.subscription.checkout_created");
    expect(created?.[2].tenantId).toBe("u1");
    // No row was created by checkout: identity still reports no account.
    const identity = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/identity", "u1"));
    expect(identity.hasAccount).toBe(false);
    expect(identity.tenantId).toBeNull();
  });

  it("first subscription purchase auto-creates the account row (tenant = session login) and identity then finds it", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubStripe();
    const plan = (
      await bodyOf(
        await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
          name: "P",
          priceUSD: 5,
          periodDays: 30,
          includedRuns: 3,
        }),
      )
    ).plan;
    // Issue #3357: new plans land PROPOSED — approve before charging (the gate working as designed).
    const approved = await call(ctx, "POST", "/payments/agentic/commercial/plans/approve", "op1", { planId: plan.id });
    expect(approved?.status).toBe(200);
    const checkout = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", {
        planId: plan.id,
        email: "u1@example.com",
      }),
    );
    expect(checkout.checkoutRequestId).toMatch(/^sub-/);
    const purchase = await call(ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
      planId: plan.id,
      tenantId: "attacker-tenant",
      checkoutRequestId: checkout.checkoutRequestId,
      checkoutSessionId: checkout.checkoutSessionId,
    });
    expect(purchase?.status).toBe(200);
    const purchased = await bodyOf(purchase);
    expect(purchased.account.tenantId).toBe("u1");
    expect(purchased.subscription.tenantId).toBe("u1");
    expect(purchased.effectiveTier).toBe("Subscribed");
    const identity = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/identity", "u1"));
    expect(identity.hasAccount).toBe(true);
    expect(identity.tenantId).toBe("u1");
    expect(identity.tier).toBe("Subscribed");
    expect(identity.includedRunsRemaining).toBe(3);
  });
});

describe("CheckoutPanel has no tenant input (#2219)", () => {
  it("source pin: no tenant-id TextInput and no tenant-id validation message remain", () => {
    const src = readFileSync("src/client/CheckoutPanel.tsx", "utf8");
    expect(src).not.toContain('label="Tenant id"');
    expect(src).not.toContain("Enter your tenant id");
    expect(src).not.toContain("setTenantId");
    expect(src).toContain("getIdentity()");
    expect(src).toContain("No account on file");
  });
});
