// @vitest-environment node
/**
 * Issue #2549 — refund doctrine reconciliation (owner decision
 * 2026-10-31: BOTH mechanisms stand).
 *
 * The doctrine pinned here:
 * - Automatic failure compensation for a paid run is a one-time
 *   replacement-run credit (deduped, never cash). The payment
 *   workflow's failure path issues that credit and has no cash
 *   channel at all.
 * - Cash refunds stand as the OPERATOR-INITIATED path (#2204):
 *   requested, operator-approved, operator-executed, audited —
 *   never automatic.
 * - Both gates' disclosures (and the refund policy copy) describe
 *   BOTH mechanisms truthfully; neither claims credit-only.
 * - Per failure, compensation is XOR: a run that already received
 *   its automatic replacement-run credit must not also be
 *   cash-refunded. executeRefund enforces this at the money gate
 *   via an injected failure-credit lookup, and refuses
 *   pay-per-run execution entirely when the lookup is not wired
 *   (fail closed rather than unchecked).
 * - The executed refund record states the entitlement
 *   consequences for a pay-per-run run, including whether a
 *   failure credit was issued for it.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAYMENT_DISCLOSURE,
  CfPayMonetizationGate,
  type CfPayCheckoutClient,
  type CommercialAccount,
} from "../src/services/cfpayMonetization";
import { NATIVE_PAYMENT_DISCLOSURE } from "../src/services/nativeMonetization";
import { REFUND_POLICY_COPY } from "../src/data/refundPorts";
import {
  createSubscriptionPaymentResolver,
  decideRefund,
  executeRefund,
  requestRefund,
  type FailureCreditLookup,
} from "../src/services/refundService";
import {
  InMemoryRefundAdapter,
  InMemoryRefundPolicyAdapter,
} from "../src/data/inMemoryRefundAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import {
  runPaymentWorkflowFlow,
  type PaymentWorkflowDeps,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
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
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import {
  createD1RefundDb,
  D1RefundAdapter,
  ensureRefundSchema,
} from "../src/data/d1RefundAdapter";
import { createNativeLedgerAdapter, ensureNativeLedgerSchema } from "../src/data/createNativeLedgerPorts";
import { cfpayLedgerSessionId } from "../src/services/cfpayLedger";
import type { DatabaseORM } from "../src/orm";

describe("disclosures describe both mechanisms (#2549)", () => {
  const disclosures: Array<[string, string]> = [
    ["cfpay PAYMENT_DISCLOSURE", PAYMENT_DISCLOSURE],
    ["native NATIVE_PAYMENT_DISCLOSURE", NATIVE_PAYMENT_DISCLOSURE],
  ];
  for (const [name, text] of disclosures) {
    it(`${name}: automatic compensation is the replacement-run credit`, () => {
      expect(text).toContain("replacement-run credit");
      expect(text).toMatch(/automatic compensation is a one-time replacement-run credit/);
    });
    it(`${name}: cash refunds are named as operator-initiated, never automatic`, () => {
      expect(text).toMatch(/cash refund is never issued automatically/);
      expect(text).toMatch(/operator-initiated/);
      expect(text).toMatch(/operator approval/);
    });
    it(`${name}: no credit-only claim remains`, () => {
      expect(text).not.toContain("Automated refunds are not available");
      expect(text).not.toContain("never a cash refund");
    });
  }
  it("REFUND_POLICY_COPY states refunds are never automatic and names the credit as the automatic compensation", () => {
    expect(REFUND_POLICY_COPY).toContain("require operator approval");
    expect(REFUND_POLICY_COPY).toMatch(/never automatic/);
    expect(REFUND_POLICY_COPY).toContain("replacement-run credit");
  });
});

describe("automatic failure path issues a credit and has no cash channel (#2549)", () => {
  function stubCfpay(status = "fulfilled"): CfPayCheckoutClient {
    return {
      createCheckout: async () => ({ checkoutId: "chk-1" }),
      checkoutStatus: async () => ({ status }),
    };
  }
  const fakeStep: PaymentWorkflowStep = {
    async waitForEvent(name: string) {
      if (name.includes("approval")) return { payload: { approved: true } };
      return { payload: { claimTxHash: "0xabc" } };
    },
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
  const account: CommercialAccount = {
    userId: "u1",
    email: "u1@example.com",
    tenantId: "t1",
    tier: "PayPerUse",
    creditsUSD: 0,
    includedRunsRemaining: 0,
  };
  const params: PaymentWorkflowParams = {
    runRequestId: "run-auto-1",
    family: "goal",
    trigger: "manual",
    tenantId: "t1",
    userId: "u1",
    email: "u1@example.com",
  };

  it("a paid run whose screener fails gets exactly one failure credit via the credit dep", async () => {
    const gate = new CfPayMonetizationGate(stubCfpay(), {
      monetizationEnabled: true,
      network: "base-sepolia",
      priceCatalogue: new InMemoryPriceCatalogueAdapter(),
    });
    const creditCalls: Array<{ runRequestId: string; priceUSD: number }> = [];
    const events: Array<{ type: string }> = [];
    const deps: PaymentWorkflowDeps = {
      gate,
      account,
      startScreener: async () => {
        throw new Error("screener boom");
      },
      recordEvent: async (e) => {
        events.push({ type: e.type });
      },
      issueFailureCredit: async (runRequestId, priceUSD) => {
        creditCalls.push({ runRequestId, priceUSD });
      },
    };
    const out = await runPaymentWorkflowFlow(params, deps, fakeStep);
    expect(out.status).toBe("screener_failed_credit_issued");
    expect(creditCalls).toEqual([{ runRequestId: "run-auto-1", priceUSD: 0.1 }]);
    expect(events.some((e) => e.type === "payment.failure_credit_issued")).toBe(true);
  });

  it("structural pin: the flow and both gates hold no refund-execution capability", () => {
    for (const file of [
      "workflows/paymentWorkflowFlow.ts",
      "services/cfpayMonetization.ts",
      "services/nativeMonetization.ts",
    ]) {
      const text = readFileSync(resolve(__dirname, `../src/${file}`), "utf8");
      expect(text, file).not.toContain("refundService");
      expect(text, file).not.toContain("executeRefund");
    }
  });
});

describe("credit XOR refund at the execute gate (#2549)", () => {
  function gatewayStub() {
    const calls: any[] = [];
    return {
      calls,
      gateway: {
        executeRefund: async (params: any) => {
          calls.push(params);
          return { success: true, refundId: "re_xor_1", amountRefunded: params.amount, message: "ok" };
        },
      },
    };
  }

  async function approvedPayPerRun() {
    const policy = new InMemoryRefundPolicyAdapter();
    const store = new InMemoryRefundAdapter();
    const record = await requestRefund(
      { policyStore: policy, refundStore: store },
      {
        kind: "pay_per_run",
        originalPaymentRef: "run-xor-1",
        amountUSD: 0.1,
        originalAmountUSD: 0.1,
        originalPaidAtMs: Date.now() - 1000,
        tenantId: "t1",
        rail: "card",
        family: "goal",
        reason: "run failed",
        requesterLogin: "u1",
        isOperator: false,
      },
    );
    // Simulate the #2194 run->PI wiring the service header
    // anticipates: the record carries a resolvable payment
    // intent, so execution can proceed to the money gate.
    await store.updateRefund(record.id, { paymentIntentId: "pi_run_1" });
    await decideRefund(
      { refundStore: store },
      { refundId: record.id, decision: "approve", approverLogin: "op1" },
    );
    return { policy, store, record };
  }

  it("refuses execution when the run already received its failure credit — gateway untouched", async () => {
    const { policy, store, record } = await approvedPayPerRun();
    const { calls, gateway } = gatewayStub();
    const failureCreditLookup: FailureCreditLookup = {
      hasFailureCredit: async (runRequestId) => runRequestId === "run-xor-1",
    };
    await expect(
      executeRefund(
        { policyStore: policy, refundStore: store, gateway, monetizationEnabled: true, failureCreditLookup },
        { refundId: record.id },
      ),
    ).rejects.toThrow(/already received its automatic replacement-run credit/);
    expect(calls).toEqual([]);
    expect((await store.getRefund(record.id))?.status).toBe("approved");
  });

  it("executes when no failure credit exists and the record states failure_credit_issued:no", async () => {
    const { policy, store, record } = await approvedPayPerRun();
    const { calls, gateway } = gatewayStub();
    const failureCreditLookup: FailureCreditLookup = { hasFailureCredit: async () => false };
    const executed = await executeRefund(
      { policyStore: policy, refundStore: store, gateway, monetizationEnabled: true, failureCreditLookup },
      { refundId: record.id },
    );
    expect(executed.status).toBe("executed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ gateway: "stripe", gatewayRef: "pi_run_1", amount: 0.1 });
    expect(executed.entitlementConsequence).toContain("run_already_delivered");
    expect(executed.entitlementConsequence).toContain("failure_credit_issued:no");
  });

  it("fails closed when the failure-credit lookup is not wired — gateway untouched", async () => {
    const { policy, store, record } = await approvedPayPerRun();
    const { calls, gateway } = gatewayStub();
    await expect(
      executeRefund(
        { policyStore: policy, refundStore: store, gateway, monetizationEnabled: true },
        { refundId: record.id },
      ),
    ).rejects.toThrow(/failure-credit lookup/);
    expect(calls).toEqual([]);
    expect((await store.getRefund(record.id))?.status).toBe("approved");
  });

  it("a failing lookup refuses execution before any gateway call", async () => {
    const { policy, store, record } = await approvedPayPerRun();
    const { calls, gateway } = gatewayStub();
    const failureCreditLookup: FailureCreditLookup = {
      hasFailureCredit: async () => {
        throw new Error("ledger unavailable");
      },
    };
    await expect(
      executeRefund(
        { policyStore: policy, refundStore: store, gateway, monetizationEnabled: true, failureCreditLookup },
        { refundId: record.id },
      ),
    ).rejects.toThrow(/ledger unavailable/);
    expect(calls).toEqual([]);
  });

  it("subscription refunds do not consult the failure-credit lookup", async () => {
    const policy = new InMemoryRefundPolicyAdapter();
    const store = new InMemoryRefundAdapter();
    const subs = new InMemorySubscriptionAdapter();
    const plan = await subs.createPlan({ id: "plan-pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10 });
    const now = Date.now();
    await subs.createSubscription({
      id: "sub-row-1",
      userId: "u1",
      tenantId: "t1",
      planId: plan.id,
      provider: "stripe",
      providerPaymentRef: "sub-draft-1",
      stripeSessionId: "cs_test_1",
      stripePaymentIntentId: "pi_test_1",
      periodStartMs: now,
      periodEndMs: now + 30 * 86_400_000,
    });
    const { gateway } = gatewayStub();
    const record = await requestRefund(
      { policyStore: policy, refundStore: store, sourceResolver: createSubscriptionPaymentResolver(subs) },
      {
        kind: "subscription",
        originalPaymentRef: "sub-row-1",
        amountUSD: 20,
        reason: "changed mind",
        requesterLogin: "u1",
        isOperator: false,
      },
    );
    await decideRefund({ refundStore: store }, { refundId: record.id, decision: "approve", approverLogin: "op1" });
    let consulted = false;
    const executed = await executeRefund(
      {
        policyStore: policy,
        refundStore: store,
        sourceResolver: createSubscriptionPaymentResolver(subs),
        subscriptionStore: subs,
        gateway,
        monetizationEnabled: true,
        failureCreditLookup: {
          hasFailureCredit: async () => {
            consulted = true;
            return true;
          },
        },
      },
      { refundId: record.id },
    );
    expect(executed.status).toBe("executed");
    expect(consulted).toBe(false);
  });
});

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors refund_ports). */
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

describe("refund routes: operator gate + XOR wiring (#2549)", () => {
  const req = (method: string, path: string, login: string | null, body?: unknown) =>
    new Request(`https://agent.internal${path}`, {
      method,
      headers: {
        ...(login ? { "x-user-login": login } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const call = (ctx: AgenticPaymentsRouteContext, path: string, login: string | null, body?: unknown) => {
    const url = new URL(`https://agent.internal${path}`);
    return handleAgenticPaymentsRoutes(req("POST", path, login, body), url, url.pathname, "sess-1", ctx);
  };

  const bodyOf = async (res: Response | null) => (await res?.json()) as any;

  let stripeCalls: any[] = [];
  function stubStripe() {
    stripeCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        const href = String(url);
        if (href === "https://api.stripe.com/v1/refunds" && init?.method === "POST") {
          stripeCalls.push(init);
          const params = new URLSearchParams(String(init.body));
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: "re_route_xor", amount: Number(params.get("amount") ?? 0) }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function setup(opts: { creditRunIds?: string[]; nativeCreditRunIds?: string[] } = {}) {
    const mock = new MockD1Database();
    const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(commercialDb);
    const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
    await ensureSubscriptionSchema(subsDb);
    const refundDb = createD1RefundDb(mock as unknown as D1Database);
    await ensureRefundSchema(refundDb);
    const refundStore = new D1RefundAdapter(refundDb);
    const now = Date.now();
    const seedApprovedPayPerRun = async (runRequestId: string) => {
      return refundStore.createRefund({
        id: `refund-${runRequestId}`,
        kind: "pay_per_run",
        rail: "card",
        tenantId: "t1",
        userId: "u1",
        originalPaymentRef: runRequestId,
        subscriptionId: null,
        paymentIntentId: "pi_run_1",
        family: "goal",
        originalAmountUSD: 0.1,
        amountUSD: 0.1,
        originalPaidAtMs: now - 1000,
        reason: "run failed",
        status: "approved",
        approverLogin: "op1",
        decisionNote: "verified",
        gatewayRefundId: null,
        executedAtMs: null,
        entitlementConsequence: null,
        createdAtMs: now,
        updatedAtMs: now,
      });
    };
    // Native-ledger credit rows (D1) for the runs named.
    const native = createNativeLedgerAdapter({ AGENT_DB: mock as unknown as D1Database });
    if (native && opts.nativeCreditRunIds?.length) {
      await ensureNativeLedgerSchema(native.db);
      for (const runRequestId of opts.nativeCreditRunIds) {
        await native.recordRow({
          kind: "credit",
          runRequestId,
          tenantId: "t1",
          userId: "u1",
          family: "goal",
          priceUSD: 0.1,
          rail: "stripe",
        });
      }
    }
    // cfpay-ledger credit rows live in mas_transactions (the ORM).
    const ormRows = (opts.creditRunIds ?? []).map((runRequestId) => ({
      id: `tx-credit-${runRequestId}`,
      sessionId: cfpayLedgerSessionId(runRequestId),
      action: "credit",
      amount: 0.1,
      currency: "USD",
      customer: "u1",
      gateway: "stripe",
      status: "completed",
      proposerDid: "did:web:agent.openaimp.com:orchestrator",
      runRequestId,
    }));
    const env: Record<string, unknown> = {
      AGENT_DB: mock,
      COMMERCIAL_STORE_OPERATORS: "op1",
      STRIPE_SECRET_KEY: "sk_test_stub",
      MONETIZATION_ENABLED: "true",
    };
    const audit = vi.fn();
    const ctx = {
      env,
      getOrm: () => ({ transactions: { findMany: () => ormRows } }),
      audit,
    } as unknown as AgenticPaymentsRouteContext;
    return { ctx, audit, seedApprovedPayPerRun };
  }

  it("execute is operator-only: a non-operator gets 403 and no money moves", async () => {
    const { ctx, seedApprovedPayPerRun } = await setup();
    stubStripe();
    const record = await seedApprovedPayPerRun("run-route-1");
    const res = await call(ctx, "/payments/agentic/commercial/refunds/execute", "u1", { refundId: record.id });
    expect(res?.status).toBe(403);
    expect(stripeCalls).toEqual([]);
  });

  it("XOR: a cfpay-ledger failure credit for the run refuses the cash refund (422), Stripe untouched", async () => {
    const { ctx, seedApprovedPayPerRun } = await setup({ creditRunIds: ["run-xor-route"] });
    stubStripe();
    const record = await seedApprovedPayPerRun("run-xor-route");
    const res = await call(ctx, "/payments/agentic/commercial/refunds/execute", "op1", { refundId: record.id });
    expect(res?.status).toBe(422);
    expect((await bodyOf(res)).error).toContain("already received its automatic replacement-run credit");
    expect(stripeCalls).toEqual([]);
  });

  it("XOR: a native-ledger failure credit for the run refuses the cash refund (422), Stripe untouched", async () => {
    const { ctx, seedApprovedPayPerRun } = await setup({ nativeCreditRunIds: ["run-xor-native"] });
    stubStripe();
    const record = await seedApprovedPayPerRun("run-xor-native");
    const res = await call(ctx, "/payments/agentic/commercial/refunds/execute", "op1", { refundId: record.id });
    expect(res?.status).toBe(422);
    expect((await bodyOf(res)).error).toContain("already received its automatic replacement-run credit");
    expect(stripeCalls).toEqual([]);
  });

  it("no failure credit: the operator execution proceeds, is audited, and the record states failure_credit_issued:no", async () => {
    const { ctx, audit, seedApprovedPayPerRun } = await setup();
    stubStripe();
    const record = await seedApprovedPayPerRun("run-clean-1");
    const res = await call(ctx, "/payments/agentic/commercial/refunds/execute", "op1", { refundId: record.id });
    expect(res?.status).toBe(200);
    const done = (await bodyOf(res)).refund;
    expect(done.status).toBe("executed");
    expect(done.entitlementConsequence).toContain("failure_credit_issued:no");
    expect(stripeCalls).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(
      "commercial.refund.executed",
      "payments",
      expect.objectContaining({ refundId: record.id }),
    );
  });
});
