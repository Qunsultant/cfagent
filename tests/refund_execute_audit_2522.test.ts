/**
 * Issue #2522 (slice 3, #2405 Phase 1.3) — refund-execute audit
 * carries previous → new effective tier.
 *
 * This is also the FIRST route-level coverage for the refund
 * routes (request → approve → execute): no refund route test
 * existed before this slice. The gateway is stubbed at fetch
 * (Stripe POST /v1/refunds); the DID attestation runs unkeyed
 * (no DID_ATTESTATION_KEY), as in production when unset.
 *
 * Setup mirrors a real subscription purchase: the stored account
 * tier is Free with tierSource "subscription" (activation keeps
 * the old stored tier) and Subscribed comes from the unexpired
 * row — so a full-refund revoke drops the effective tier to
 * Free. An operator-granted stored Subscribed tier would
 * survive the revoke by design and is NOT what this test seeds.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import {
  createD1JournalDb,
  ensureJournalSchema,
} from "../src/data/d1JournalAdapter";
import {
  createD1RefundDb,
  ensureRefundSchema,
} from "../src/data/d1RefundAdapter";
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

async function setup() {
  const mock = new MockD1Database();
  await ensureCommercialSchema(createD1CommercialDb(mock as unknown as D1Database));
  await ensureSubscriptionSchema(createD1SubscriptionDb(mock as unknown as D1Database));
  await ensureJournalSchema(createD1JournalDb(mock as unknown as D1Database));
  await ensureRefundSchema(createD1RefundDb(mock as unknown as D1Database));
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
    MONETIZATION_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_stub",
  };
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  const store = new D1CommercialAdapter(createD1CommercialDb(mock as unknown as D1Database));
  const subs = new D1SubscriptionAdapter(createD1SubscriptionDb(mock as unknown as D1Database));
  return { ctx, store, subs };
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

function stubStripeRefund() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      if (String(url) === "https://api.stripe.com/v1/refunds" && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ id: "re_test_1", amount: 500 }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refund execute audit (#2522)", () => {
  it("full-refund execute revokes the subscription and audits Subscribed → Free", async () => {
    const { ctx, store, subs } = await setup();
    stubStripeRefund();
    const now = Date.now();
    await store.upsertAccount({
      userId: "u1", tenantId: "t1", tier: "Free", tierSource: "subscription", creditsUSD: 0, includedRuns: 10,
    });
    const plan = await subs.createPlan({ name: "P", priceUSD: 5, periodDays: 30, includedRuns: 10 });
    await subs.createSubscription({
      id: "sub-1",
      userId: "u1",
      tenantId: "t1",
      planId: plan.id,
      provider: "stripe",
      providerPaymentRef: "sub-pay-1",
      stripeSessionId: "cs_test_1",
      stripePaymentIntentId: "pi_test_1",
      periodStartMs: now - 24 * 60 * 60 * 1000,
      periodEndMs: now + 29 * 24 * 60 * 60 * 1000,
    });

    // Issue #2662: approve the subscription kind's policy first; the
    // audit test tests execution auditing, not the approval gate.
    const policyApproved = await call(ctx, "POST", "/payments/agentic/commercial/refund-policy/approve", "op1", {
      kind: "subscription",
      approved: true,
    });
    expect(policyApproved?.status).toBe(200);

    const requested = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/refunds", "op1", {
      kind: "subscription", originalPaymentRef: "sub-pay-1", amountUSD: 5, reason: "test full refund",
    }));
    expect(requested.refund.status).toBe("requested");
    const refundId = requested.refund.id as string;

    const approved = await call(ctx, "POST", "/payments/agentic/commercial/refunds/approve", "op1", {
      refundId, decision: "approve",
    });
    expect(approved?.status).toBe(200);

    const executed = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/refunds/execute", "op1", { refundId }));
    expect(executed.refund.gatewayRefundId).toBe("re_test_1");
    const revoked = await subs.getSubscription("sub-1");
    expect(revoked?.status).toBe("canceled");
    expect(revoked?.periodEndMs).toBeLessThanOrEqual(Date.now());

    const executeAudit = (ctx.audit as any).mock.calls.find(([t]: [string]) => t === "commercial.refund.executed");
    expect(executeAudit).toBeDefined();
    expect(executeAudit[2].refundId).toBe(refundId);
    expect(executeAudit[2].gatewayRefundId).toBe("re_test_1");
    expect(executeAudit[2].amountUSD).toBe(5);
    expect(executeAudit[2].entitlementConsequence).toContain("subscription_revoked");
    expect(executeAudit[2].previousEffectiveTier).toBe("Subscribed");
    expect(executeAudit[2].newEffectiveTier).toBe("Free");
  });
});
