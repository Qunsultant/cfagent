// @vitest-environment node
/**
 * Issue #2667 (Monetization Phase 2.12, program #2405) — usage/billing reader.
 *
 * TDD RED first: this suite imports src/services/usageBillingSurface.ts,
 * which does not exist yet, and calls a route that does not exist yet.
 *
 * Pins:
 * - GET /payments/agentic/commercial/usage-billing is session-bound and
 *   self-only: no userId param, the subject is always commercialLogin().
 *   Without a session it refuses with a typed coded 401, never an
 *   asserted identity.
 * - One surface: usage (metered calls via readReceipts, included-run
 *   balance + credit balance via the identity) AND billing (subscriptions
 *   with periods, renewals derived from active periods, refunds,
 *   referral balance) together — all from existing ports, no new tables.
 * - Per-row provenance, derived never asserted: meter rows real by
 *   construction (receiptSurface); subscription rows real iff
 *   provider-managed with a provider payment reference, else audit;
 *   refund rows real iff executed with a gateway refund id, else audit.
 *   Simulated rows are never presented as real.
 * - Tenant isolation: another user's meter rows, subscriptions, refunds,
 *   and referral earnings are unreachable from this session (negative
 *   tests on every cross-tenant path).
 * - No money totals across mixed provenance: counts by kind + by
 *   provenance only; per-row amounts stay per-row.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ensureSharedTable } from "../src/data/ormSchema";
import { createCanonicalReportStorePorts } from "../src/data/createCanonicalReportStorePorts";
import { ensureMasRetentionIndexes } from "../src/data/masRetentionIndexSchema";
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
  createD1BillingPolicyDb,
  ensureBillingPolicySchema,
} from "../src/data/d1BillingPolicyAdapter";
import {
  createD1BillingCustomerDb,
  ensureBillingCustomerSchema,
} from "../src/data/d1BillingCustomerAdapter";
import {
  createD1RefundDb,
  D1RefundAdapter,
  ensureRefundSchema,
} from "../src/data/d1RefundAdapter";
import {
  createD1LifecycleDb,
  D1LifecycleAdapter,
  ensureLifecycleSchema,
} from "../src/data/d1LifecycleAdapter";
import { agentReferralEarnings } from "../src/data/drizzleSchema";
import {
  readUsageBilling,
  resolveSubscriptionProvenance,
  resolveRefundProvenance,
  deriveRenewals,
} from "../src/services/usageBillingSurface";
import { codedMessage, resolveOutcome } from "../src/outcomes/outcomeAspects";
import type { DatabaseORM as DatabaseORMType } from "../src/orm";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

const NOW = Date.now();
const PERIOD_START = NOW - 24 * 3600 * 1000;
const PERIOD_END = NOW + 29 * 24 * 3600 * 1000;
const OWNER = "owner-login";
const OTHER = "other-login";

async function setup() {
  const mock = new MockD1Database();
  await ensureCommercialSchema(createD1CommercialDb(mock as unknown as D1Database));
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subsDb);
  await ensureJournalSchema(createD1JournalDb(mock as unknown as D1Database));
  await ensureBillingPolicySchema(createD1BillingPolicyDb(mock as unknown as D1Database));
  await ensureBillingCustomerSchema(createD1BillingCustomerDb(mock as unknown as D1Database));
  const refundDb = createD1RefundDb(mock as unknown as D1Database);
  await ensureRefundSchema(refundDb);
  const lifecycleDb = createD1LifecycleDb(mock as unknown as D1Database);
  await ensureLifecycleSchema(lifecycleDb);
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
  };
  // DO-SQLite side (receipts): real ORM over the mock storage.
  const sql = new MockSqlStorage() as any;
  const orm = new DatabaseORM(sql);
  ensureSharedTable(sql, "mas_events");
  ensureSharedTable(sql, "mas_transactions");
  createCanonicalReportStorePorts(sql).usage.ensureSchema();
  ensureMasRetentionIndexes(sql);
  const ctx = {
    env,
    getOrm: () => orm as unknown as DatabaseORMType,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  const subs = new D1SubscriptionAdapter(subsDb);
  const refunds = new D1RefundAdapter(refundDb);
  const commercial = new D1CommercialAdapter(createD1CommercialDb(mock as unknown as D1Database));
  const lifecycle = new D1LifecycleAdapter(lifecycleDb);
  return { ctx, env, subs, refunds, commercial, lifecycle, orm, sql, mock };
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

function seedMeter(
  sql: any,
  row: { id: string; userLogin: string; runId: string; category: string; createdAt: string; detail: unknown },
) {
  sql.exec(
    "INSERT INTO usage_events (id, user_login, run_id, category, created_at, detail_json) VALUES (?, ?, ?, ?, ?, ?)",
    row.id,
    row.userLogin,
    row.runId,
    row.category,
    row.createdAt,
    typeof row.detail === "string" ? row.detail : JSON.stringify(row.detail),
  );
}

function seedTx(orm: any, row: Record<string, unknown>) {
  orm.transactions.create({
    id: row.id,
    sessionId: row.sessionId ?? "session-1",
    action: row.action ?? "charge",
    amount: row.amount ?? 0.05,
    currency: "USD",
    customer: row.customer ?? OWNER,
    gateway: row.gateway ?? "stripe",
    gatewayRef: row.gatewayRef ?? "",
    status: row.status ?? "completed",
    checkoutUrl: "",
    proposerDid: "did:agent:openaimp:payments",
    authorizerDid: undefined,
    proofSignature: row.proofSignature ?? "0xsig",
    note: row.note ?? "",
    createdAt: row.createdAt ?? "2026-11-01T10:00:00.000Z",
    updatedAt: row.createdAt ?? "2026-11-01T10:00:00.000Z",
  });
}

async function seedAccount(
  s: Awaited<ReturnType<typeof setup>>,
  userId: string,
  extra: Record<string, unknown> = {},
) {
  await s.commercial.upsertAccount({
    userId,
    tenantId: `t-${userId}`,
    tier: "Subscribed",
    tierSource: "subscription",
    creditsUSD: 4.5,
    includedRuns: 3,
    ...extra,
  });
}

async function seedSubscription(
  s: Awaited<ReturnType<typeof setup>>,
  extra: Record<string, unknown> = {},
) {
  await s.subs.createPlan({ id: "plan-pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 0 });
  await s.subs.createSubscription({
    id: "sub-1",
    userId: OWNER,
    tenantId: `t-${OWNER}`,
    planId: "plan-pro",
    provider: "stripe",
    providerPaymentRef: "sub-draft-1",
    stripeSessionId: "cs_test_1",
    stripePaymentIntentId: "pi_test_1",
    providerSubscriptionId: "sub_prov_1",
    providerStatus: "active",
    periodStartMs: PERIOD_START,
    periodEndMs: PERIOD_END,
    ...extra,
  });
}

async function seedRefund(
  s: Awaited<ReturnType<typeof setup>>,
  extra: Record<string, unknown> = {},
) {
  const now = Date.now();
  await s.refunds.createRefund({
    id: "refund-1",
    kind: "subscription",
    rail: "card",
    tenantId: `t-${OWNER}`,
    userId: OWNER,
    originalPaymentRef: "sub-1",
    subscriptionId: "sub-1",
    paymentIntentId: "pi_test_1",
    family: null,
    originalAmountUSD: 20,
    amountUSD: 20,
    originalPaidAtMs: now - 1000,
    reason: "test refund",
    status: "executed",
    approverLogin: "op1",
    decisionNote: null,
    gatewayRefundId: "re_test_1",
    executedAtMs: now,
    entitlementConsequence: "access revoked",
    createdAtMs: now,
    updatedAtMs: now,
    ...extra,
  } as any);
}

describe("usage/billing reader route (#2667)", () => {
  it("refuses without a signed-in session with a coded 401", async () => {
    const s = await setup();
    const res = await call(s.ctx, "GET", "/payments/agentic/commercial/usage-billing", null);
    expect(res?.status).toBe(401);
    const body = await bodyOf(res);
    expect(body.code).toBe("FAILURE_USAGE_BILLING_NOT_SIGNED_IN");
    expect(body.message).toBe(codedMessage("FAILURE_USAGE_BILLING_NOT_SIGNED_IN"));
  });

  it("rejects an invalid limit with a coded 400 and caps at 100", async () => {
    const s = await setup();
    const bad = await call(s.ctx, "GET", "/payments/agentic/commercial/usage-billing?limit=0", OWNER);
    expect(bad?.status).toBe(400);
    expect((await bodyOf(bad)).code).toBe("FAILURE_USAGE_BILLING_INVALID_LIMIT");
    const capped = await call(s.ctx, "GET", "/payments/agentic/commercial/usage-billing?limit=500", OWNER);
    expect(capped?.status).toBe(200);
    expect((await bodyOf(capped)).limit).toBe(100);
  });

  it("returns an empty view for an account with no rows, never a default", async () => {
    const s = await setup();
    const res = await call(s.ctx, "GET", "/payments/agentic/commercial/usage-billing", OWNER);
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.outcome).toBe("SUCCESS_USAGE_BILLING_READ");
    expect(body.userLogin).toBe(OWNER);
    expect(body.identity.hasAccount).toBe(false);
    expect(body.identity.creditsUSD).toBe(0);
    expect(body.identity.includedRunsRemaining).toBe(0);
    expect(body.usage.receipts).toEqual([]);
    expect(body.billing.subscriptions).toEqual([]);
    expect(body.billing.refunds).toEqual([]);
    expect(body.billing.renewals).toEqual([]);
    expect(body.billing.referral.redeemableUSD).toBe(0);
    expect(body.billing.referral.totalEarnedUSD).toBe(0);
  });

  it("returns the caller's usage AND billing together, with per-row provenance", async () => {
    const s = await setup();
    await seedAccount(s, OWNER);
    await seedSubscription(s);
    await seedRefund(s);
    seedMeter(s.sql, {
      id: "meter-1",
      userLogin: OWNER,
      runId: "run-1",
      category: "stock",
      createdAt: "2026-11-01T10:00:00.000Z",
      detail: { receiptId: "run-1", priceUSD: 0.02, tier: "PayPerUse", protocol: "x402" },
    });
    seedTx(s.orm, {
      id: "tx_sim_1",
      customer: OWNER,
      gateway: "x402",
      status: "simulated",
      amount: 0.02,
      proofSignature: "SIMULATED",
      note: "SIMULATED test payment",
    });
    // Vested referral earning, seeded directly (recordEarning vests 7 days out).
    await s.lifecycle.db
      .insert(agentReferralEarnings)
      .values({
        id: "earn-1",
        referrerUserId: OWNER,
        referredUserId: "referred-1",
        tenantId: `t-${OWNER}`,
        amountUSD: 0.5,
        redeemedAmountUSD: 0,
        earnedAtMs: NOW - 10 * 24 * 3600 * 1000,
        vestedAtMs: NOW - 3 * 24 * 3600 * 1000,
        redeemedByRunId: null,
        redeemedAtMs: null,
      });
    const res = await call(s.ctx, "GET", "/payments/agentic/commercial/usage-billing", OWNER);
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.identity.creditsUSD).toBe(4.5);
    expect(body.identity.includedRunsRemaining).toBe(3);
    const meter = body.usage.receipts.find((r: any) => r.kind === "meter");
    expect(meter).toBeDefined();
    expect(meter.provenance).toBe("real");
    expect(meter.amountUSD).toBe(0.02);
    const simulated = body.usage.receipts.find((r: any) => r.kind === "transaction");
    expect(simulated).toBeDefined();
    expect(simulated.provenance).toBe("simulated");
    const sub = body.billing.subscriptions[0];
    expect(sub.id).toBe("sub-1");
    expect(sub.provenance).toBe("real");
    expect(sub.periodEndMs).toBe(PERIOD_END);
    expect(body.billing.current?.id).toBe("sub-1");
    expect(body.billing.renewals).toHaveLength(1);
    expect(body.billing.renewals[0]).toMatchObject({
      subscriptionId: "sub-1",
      planId: "plan-pro",
      renewsAtMs: PERIOD_END,
    });
    const refund = body.billing.refunds[0];
    expect(refund.id).toBe("refund-1");
    expect(refund.provenance).toBe("real");
    expect(body.billing.referral.redeemableUSD).toBe(0.5);
    expect(body.billing.referral.totalEarnedUSD).toBe(0.5);
    expect(body.usage.counts.simulated).toBeGreaterThanOrEqual(1);
  });

  it("never returns another user's rows (meter, subscription, refund, referral)", async () => {
    const s = await setup();
    await seedAccount(s, OWNER);
    await seedAccount(s, OTHER, { creditsUSD: 9, includedRuns: 9 });
    await seedSubscription(s);
    await s.subs.createSubscription({
      id: "sub-other",
      userId: OTHER,
      tenantId: `t-${OTHER}`,
      planId: "plan-pro",
      provider: "stripe",
      providerPaymentRef: "sub-draft-other",
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
    });
    await seedRefund(s);
    await s.refunds.createRefund({
      id: "refund-other",
      kind: "subscription",
      rail: "card",
      tenantId: `t-${OTHER}`,
      userId: OTHER,
      originalPaymentRef: "sub-other",
      subscriptionId: "sub-other",
      paymentIntentId: null,
      family: null,
      originalAmountUSD: 20,
      amountUSD: 20,
      originalPaidAtMs: NOW - 1000,
      reason: "other refund",
      status: "requested",
      approverLogin: null,
      decisionNote: null,
      gatewayRefundId: null,
      executedAtMs: null,
      entitlementConsequence: null,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    } as any);
    seedMeter(s.sql, {
      id: "meter-other",
      userLogin: OTHER,
      runId: "run-other",
      category: "stock",
      createdAt: "2026-11-01T10:00:00.000Z",
      detail: { receiptId: "run-other", priceUSD: 0.02, tier: "PayPerUse", protocol: "x402" },
    });
    await s.lifecycle.db.insert(agentReferralEarnings).values({
      id: "earn-other",
      referrerUserId: OTHER,
      referredUserId: "referred-other",
      tenantId: `t-${OTHER}`,
      amountUSD: 0.5,
      redeemedAmountUSD: 0,
      earnedAtMs: NOW - 10 * 24 * 3600 * 1000,
      vestedAtMs: NOW - 3 * 24 * 3600 * 1000,
      redeemedByRunId: null,
      redeemedAtMs: null,
    });
    const res = await call(s.ctx, "GET", "/payments/agentic/commercial/usage-billing", OWNER);
    expect(res?.status).toBe(200);
    const raw = await res?.text();
    expect(raw).not.toContain("sub-other");
    expect(raw).not.toContain("refund-other");
    expect(raw).not.toContain("run-other");
    expect(raw).not.toContain("meter-other");
    const body = JSON.parse(raw ?? "{}");
    expect(body.identity.creditsUSD).toBe(4.5);
    expect(body.billing.referral.totalEarnedUSD).toBe(0);
    expect(body.billing.subscriptions.map((r: any) => r.id)).toEqual(["sub-1"]);
  });

  it("fails closed with a coded 503 when the store is unbound", async () => {
    const s = await setup();
    const noDbCtx = {
      env: {},
      getOrm: () => s.orm as unknown as DatabaseORMType,
      audit: vi.fn(),
    } as unknown as AgenticPaymentsRouteContext;
    const res = await call(noDbCtx, "GET", "/payments/agentic/commercial/usage-billing", OWNER);
    expect(res?.status).toBe(503);
    const body = await bodyOf(res);
    expect(body.code).toBe("FAILURE_USAGE_BILLING_STORE_UNAVAILABLE");
    expect(body.message).toBe(codedMessage("FAILURE_USAGE_BILLING_STORE_UNAVAILABLE"));
  });
});

describe("usage/billing provenance derivation (#2667)", () => {
  it("subscription rows: real iff provider-managed with a provider payment reference, else audit", () => {
    const base: any = {
      id: "sub-x",
      userId: OWNER,
      tenantId: "t",
      planId: "plan-pro",
      provider: "stripe",
      providerPaymentRef: "sub-draft-x",
      stripeSessionId: null,
      stripePaymentIntentId: null,
      providerSubscriptionId: null,
      providerStatus: null,
      status: "active",
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      canceledAtMs: null,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    };
    expect(resolveSubscriptionProvenance({ ...base, stripePaymentIntentId: "pi_1" }).provenance).toBe("real");
    expect(
      resolveSubscriptionProvenance({ ...base, providerSubscriptionId: "sub_prov_9" }).provenance,
    ).toBe("real");
    const audit = resolveSubscriptionProvenance(base);
    expect(audit.provenance).toBe("audit");
    expect(audit.provenanceNote.length).toBeGreaterThan(0);
  });

  it("refund rows: real iff executed with a gateway refund id, else audit", () => {
    const base: any = {
      id: "refund-x",
      kind: "subscription",
      rail: "card",
      tenantId: "t",
      userId: OWNER,
      originalPaymentRef: "sub-1",
      subscriptionId: "sub-1",
      paymentIntentId: "pi_1",
      family: null,
      originalAmountUSD: 20,
      amountUSD: 20,
      originalPaidAtMs: NOW - 1000,
      reason: "r",
      status: "requested",
      approverLogin: null,
      decisionNote: null,
      gatewayRefundId: null,
      executedAtMs: null,
      entitlementConsequence: null,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    };
    expect(resolveRefundProvenance(base).provenance).toBe("audit");
    expect(
      resolveRefundProvenance({ ...base, status: "executed", gatewayRefundId: "re_1", executedAtMs: NOW })
        .provenance,
    ).toBe("real");
  });

  it("renewals derive only from active, unexpired, uncanceled subscriptions", () => {
    const base: any = {
      id: "sub-r",
      userId: OWNER,
      tenantId: "t",
      planId: "plan-pro",
      provider: "stripe",
      providerPaymentRef: "sub-draft-r",
      stripeSessionId: null,
      stripePaymentIntentId: "pi_1",
      providerSubscriptionId: "sub_prov_r",
      providerStatus: "active",
      status: "active",
      periodStartMs: PERIOD_START,
      periodEndMs: PERIOD_END,
      canceledAtMs: null,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    };
    expect(deriveRenewals([base], NOW)).toHaveLength(1);
    expect(deriveRenewals([{ ...base, canceledAtMs: NOW }], NOW)).toHaveLength(0);
    expect(deriveRenewals([{ ...base, periodEndMs: NOW - 1000 }], NOW)).toHaveLength(0);
    expect(deriveRenewals([{ ...base, status: "canceled" }], NOW)).toHaveLength(0);
  });
});

describe("usage/billing outcome catalog (#2667)", () => {
  it("pins the four new entries with exact fields", () => {
    const cases: Array<[string, string, number, string]> = [
      ["SUCCESS_USAGE_BILLING_READ", "success", 200, "commercial"],
      ["FAILURE_USAGE_BILLING_NOT_SIGNED_IN", "failure", 401, "auth"],
      ["FAILURE_USAGE_BILLING_INVALID_LIMIT", "failure", 400, "commercial"],
      ["FAILURE_USAGE_BILLING_STORE_UNAVAILABLE", "failure", 503, "system"],
    ];
    for (const [code, outcome, httpStatus, category] of cases) {
      const resolved = resolveOutcome(code);
      expect(resolved.resolved).toBe(true);
      expect(resolved.entry?.outcome).toBe(outcome);
      expect(resolved.entry?.httpStatus).toBe(httpStatus);
      expect(resolved.entry?.category).toBe(category);
      expect((resolved.entry?.businessMessage ?? "").length).toBeGreaterThan(0);
      expect(codedMessage(code)).toContain(`[${code}]`);
    }
  });
});
