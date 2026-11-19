// @vitest-environment node
/**
 * Issue #5227 (Monetization Phase 2.29, program #2405, Goal 3) —
 * bundle refunds under the decided policy.
 *
 * Owner decision (2026-11-17): bundles ARE refundable, with BOTH a
 * window and proration — window 30 days from purchase (the operator
 * refund-policy row, never hardcoded); proration by the unused
 * portion, computed by the policy from the remaining entitlement
 * period (bundle run-consumption tracking does not exist yet, so the
 * basis is the remaining-period fraction, stated in code + PR body).
 * The prorated amount is computed, not chosen: a supplied amount
 * that differs from the computed amount is refused. A fully-used
 * bundle (no unused remainder) has nothing refundable. Executing a
 * bundle refund revokes the purchase (remaining access ends).
 *
 * Service-level tests over the in-memory adapters + stub billing
 * port; route-level flow lives in tests/bundle_routes_2781.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  assertApprovedKinds,
  assertRefundKind,
  computeBundleProratedRefund,
  validateRefundRequest,
  type RefundPaymentSource,
} from "../src/data/refundPorts";
import { createBundlePaymentResolver } from "../src/services/refundPaymentIntent";
import {
  buildRefundJournalEntries,
  decideRefund,
  executeRefund,
  requestRefund,
} from "../src/services/refundService";
import {
  InMemoryRefundAdapter,
  InMemoryRefundPolicyAdapter,
} from "../src/data/inMemoryRefundAdapter";
import { InMemoryProductBundleAdapter } from "../src/data/inMemoryProductBundleAdapter";
import type {
  BundlePurchaseRecord,
  ProductBundleRecord,
  ProductBundleStore,
} from "../src/data/productBundles";
import type { BillingPort } from "../src/services/billingPorts";

const DAY = 86_400_000;
const NOW = 1_780_000_000_000;

function bundlePurchase(overrides: Partial<BundlePurchaseRecord> = {}): BundlePurchaseRecord {
  return {
    id: "bp-1",
    userId: "u1",
    tenantId: "t1",
    bundleId: "bnd-1",
    provider: "stripe",
    providerPaymentRef: "bbnd-test-1",
    stripeSessionId: "cs_test_1",
    stripePaymentIntentId: null,
    providerSubscriptionId: "sub_1",
    providerStatus: "active",
    status: "active",
    periodStartMs: NOW,
    periodEndMs: NOW + 30 * DAY,
    canceledAtMs: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides,
  };
}

function stubBundleStore(
  purchase: BundlePurchaseRecord | null,
  priceUSD: number,
): ProductBundleStore {
  const bundle = { id: "bnd-1", priceUSD } as unknown as ProductBundleRecord;
  return {
    findBundlePurchaseByPaymentRef: async (ref: string) =>
      purchase && purchase.providerPaymentRef === ref ? purchase : null,
    getBundle: async () => bundle,
  } as unknown as ProductBundleStore;
}

function stubBilling(invoicePi: string | null, opts: { throw?: boolean } = {}) {
  const calls: string[] = [];
  const billing = {
    retrieveFirstInvoicePaymentIntent: async (id: string) => {
      calls.push(id);
      if (opts.throw) throw new Error("Stripe Billing request failed: HTTP 402 (card declined).");
      return invoicePi;
    },
  } as Pick<BillingPort, "retrieveFirstInvoicePaymentIntent">;
  return { billing, calls };
}

async function makeService(opts: {
  approveBundle?: boolean;
  purchase?: BundlePurchaseRecord | null;
  priceUSD?: number;
  invoicePi?: string | null;
  billingThrow?: boolean;
} = {}) {
  const policy = new InMemoryRefundPolicyAdapter();
  if (opts.approveBundle !== false) await policy.setKindApproval("bundle", true, "op1");
  const refunds = new InMemoryRefundAdapter();
  const store = stubBundleStore(opts.purchase === undefined ? bundlePurchase() : opts.purchase, opts.priceUSD ?? 30);
  const { billing, calls } = stubBilling(opts.invoicePi !== undefined ? opts.invoicePi : "pi_first_1", { throw: opts.billingThrow });
  const resolver = createBundlePaymentResolver(store, billing);
  return { policy, refunds, resolver, calls };
}

function requestBundle(
  deps: Awaited<ReturnType<typeof makeService>>,
  overrides: { nowMs?: number; amountUSD?: unknown; requesterLogin?: string; isOperator?: boolean; ref?: string } = {},
) {
  return requestRefund(
    {
      policyStore: deps.policy,
      refundStore: deps.refunds,
      sourceResolver: deps.resolver,
      nowMs: overrides.nowMs ?? NOW,
    },
    {
      kind: "bundle",
      originalPaymentRef: overrides.ref ?? "bbnd-test-1",
      amountUSD: overrides.amountUSD,
      reason: "changed my mind",
      requesterLogin: overrides.requesterLogin ?? "u1",
      isOperator: overrides.isOperator ?? false,
    },
  );
}

describe("bundle proration is the remaining-period fraction (#5227)", () => {
  it("day 0 refunds in full, the midpoint refunds half, after the period ends nothing", () => {
    const period = { originalAmountUSD: 30, periodStartMs: NOW, periodEndMs: NOW + 30 * DAY };
    expect(computeBundleProratedRefund(period, NOW)).toBe(30);
    expect(computeBundleProratedRefund(period, NOW + 15 * DAY)).toBe(15);
    expect(computeBundleProratedRefund(period, NOW + 30 * DAY)).toBe(0);
    expect(computeBundleProratedRefund(period, NOW + 31 * DAY)).toBe(0);
  });

  it("rounds to cents and clamps a request before the period starts to the full amount", () => {
    const period = { originalAmountUSD: 10, periodStartMs: NOW, periodEndMs: NOW + 30 * DAY };
    expect(computeBundleProratedRefund(period, NOW + 10 * DAY)).toBe(6.67);
    expect(computeBundleProratedRefund(period, NOW - DAY)).toBe(10);
  });

  it("a degenerate period refunds nothing (fail closed, never a division by zero)", () => {
    expect(
      computeBundleProratedRefund({ originalAmountUSD: 30, periodStartMs: NOW, periodEndMs: NOW }, NOW),
    ).toBe(0);
  });
});

describe("bundle kind is a first-class refund kind (#5227)", () => {
  it("assertRefundKind and assertApprovedKinds accept bundle", () => {
    expect(assertRefundKind("bundle")).toBe("bundle");
    expect(assertApprovedKinds(["bundle"])).toEqual(["bundle"]);
    expect(assertApprovedKinds(["subscription", "bundle", "pay_per_run"])).toEqual([
      "subscription",
      "bundle",
      "pay_per_run",
    ]);
  });

  it("validateRefundRequest skips the full-only equality check for bundle (policy-computed amount), keeps it for the other kinds", async () => {
    const policy = await new InMemoryRefundPolicyAdapter().getPolicy();
    if (!policy) throw new Error("seed policy missing");
    const input = { rail: "card" as const, amountUSD: 15, originalAmountUSD: 30, originalPaidAtMs: NOW };
    expect(() => validateRefundRequest(policy, input, NOW + 15 * DAY, "bundle")).not.toThrow();
    expect(() => validateRefundRequest(policy, input, NOW + 15 * DAY, "subscription")).toThrowError(expect.objectContaining({ code: "FAILURE_REFUND_POLICY_REFUSAL" })); // #5606 (G-3)
    expect(() => validateRefundRequest(policy, input, NOW + 15 * DAY)).toThrowError(expect.objectContaining({ code: "FAILURE_REFUND_POLICY_REFUSAL" })); // #5606 (G-3)
    // The window still applies to bundles.
    expect(() => validateRefundRequest(policy, input, NOW + 31 * DAY, "bundle")).toThrowError(expect.objectContaining({ code: "FAILURE_REFUND_POLICY_REFUSAL" })); // #5606 (G-3)
  });
});

describe("bundle payment resolver (#5227)", () => {
  it("a stored payment-intent id wins and the invoice lookup is never consulted", async () => {
    const deps = await makeService({ purchase: bundlePurchase({ stripePaymentIntentId: "pi_stored_1" }) });
    const source = await deps.resolver.resolve("bbnd-test-1");
    expect(source?.paymentIntentId).toBe("pi_stored_1");
    expect(deps.calls).toEqual([]);
    expect(source?.rail).toBe("card");
    expect(source?.originalAmountUSD).toBe(30);
    expect(source?.originalPaidAtMs).toBe(NOW);
    expect(source?.userId).toBe("u1");
    expect(source?.tenantId).toBe("t1");
    expect(source?.subscriptionId).toBeNull();
    expect(source?.bundlePeriodStartMs).toBe(NOW);
    expect(source?.bundlePeriodEndMs).toBe(NOW + 30 * DAY);
  });

  it("no stored id resolves through the provider subscription's first invoice", async () => {
    const deps = await makeService({ invoicePi: "pi_first_1" });
    const source = await deps.resolver.resolve("bbnd-test-1");
    expect(source?.paymentIntentId).toBe("pi_first_1");
    expect(deps.calls).toEqual(["sub_1"]);
  });

  it("no stored id and no provider subscription id leaves the payment intent unresolved (never guessed)", async () => {
    const deps = await makeService({ purchase: bundlePurchase({ providerSubscriptionId: null }) });
    const source = await deps.resolver.resolve("bbnd-test-1");
    expect(source?.paymentIntentId).toBeNull();
    expect(source?.rail).toBe("card");
    expect(deps.calls).toEqual([]);
  });

  it("a failing invoice lookup leaves the payment intent unresolved (fail closed)", async () => {
    const deps = await makeService({ billingThrow: true });
    const source = await deps.resolver.resolve("bbnd-test-1");
    expect(source?.paymentIntentId).toBeNull();
  });

  it("an unknown payment ref resolves to null", async () => {
    const deps = await makeService({ purchase: null });
    expect(await deps.resolver.resolve("bbnd-missing")).toBeNull();
  });

  it("a non-stripe provider resolves with a null rail so the service refuses it", async () => {
    const deps = await makeService({
      purchase: bundlePurchase({ provider: "cfpay", stripePaymentIntentId: "pi_cfpay_1" }),
    });
    const source: RefundPaymentSource | null = await deps.resolver.resolve("bbnd-test-1");
    expect(source?.paymentIntentId).toBe("pi_cfpay_1");
    expect(source?.rail).toBeNull();
  });
});

describe("bundle refund request (#5227)", () => {
  it("no amount computes the prorated remainder; the record carries the resolved source", async () => {
    const deps = await makeService();
    const record = await requestBundle(deps, { nowMs: NOW + 15 * DAY });
    expect(record.kind).toBe("bundle");
    expect(record.status).toBe("requested");
    expect(record.amountUSD).toBe(15);
    expect(record.originalAmountUSD).toBe(30);
    expect(record.paymentIntentId).toBe("pi_first_1");
    expect(record.userId).toBe("u1");
    expect(record.tenantId).toBe("t1");
    expect(record.subscriptionId).toBeNull();
  });

  it("a supplied amount equal to the computed amount is accepted", async () => {
    const deps = await makeService();
    const record = await requestBundle(deps, { nowMs: NOW + 15 * DAY, amountUSD: 15 });
    expect(record.amountUSD).toBe(15);
  });

  it("a supplied amount different from the computed amount is refused (the amount is policy-computed, not chosen)", async () => {
    const deps = await makeService();
    await expect(requestBundle(deps, { nowMs: NOW + 15 * DAY, amountUSD: 3 })).rejects.toMatchObject({ code: "FAILURE_COMMERCIAL_REQUEST_INVALID" }); // #5606 (G-3)
    await expect(requestBundle(deps, { nowMs: NOW + 15 * DAY, amountUSD: 30 })).rejects.toMatchObject({ code: "FAILURE_COMMERCIAL_REQUEST_INVALID" }); // #5606 (G-3)
  });

  it("an unapproved bundle kind is refused before any record is created", async () => {
    const deps = await makeService({ approveBundle: false });
    await expect(requestBundle(deps)).rejects.toMatchObject({ code: "FAILURE_REFUND_POLICY_REFUSAL" }); // #5606 (G-3)
    expect(await deps.refunds.listRefunds("u1")).toEqual([]);
  });

  it("an unknown bundle ref is refused", async () => {
    const deps = await makeService();
    await expect(requestBundle(deps, { ref: "bbnd-missing" })).rejects.toMatchObject({ code: "FAILURE_COMMERCIAL_REQUEST_INVALID" }); // #5606 (G-3)
  });

  it("a non-owner non-operator is refused", async () => {
    const deps = await makeService();
    await expect(requestBundle(deps, { requesterLogin: "u2" })).rejects.toMatchObject({ code: "FAILURE_COMMERCIAL_REQUEST_INVALID" }); // #5606 (G-3)
  });

  it("an operator may request for the owner", async () => {
    const deps = await makeService();
    const record = await requestBundle(deps, { requesterLogin: "op1", isOperator: true });
    expect(record.userId).toBe("u1");
  });

  it("a crypto-railed bundle is refused as non-refundable", async () => {
    const deps = await makeService({
      purchase: bundlePurchase({ provider: "x402", stripePaymentIntentId: "pi_x_1" }),
    });
    await expect(requestBundle(deps)).rejects.toMatchObject({ code: "FAILURE_REFUND_POLICY_REFUSAL" }); // #5606 (G-3)
  });

  it("an unresolvable payment intent is refused at request time, not queued", async () => {
    const deps = await makeService({ invoicePi: null });
    await expect(requestBundle(deps)).rejects.toMatchObject({ code: "FAILURE_COMMERCIAL_REQUEST_INVALID" }); // #5606 (G-3)
  });

  it("outside the window is refused even when an unused remainder exists (90-day period, day 31)", async () => {
    const deps = await makeService({
      purchase: bundlePurchase({ periodEndMs: NOW + 90 * DAY }),
    });
    await expect(requestBundle(deps, { nowMs: NOW + 31 * DAY })).rejects.toMatchObject({ code: "FAILURE_REFUND_POLICY_REFUSAL" }); // #5606 (G-3)
  });

  it("a fully-used bundle has nothing refundable", async () => {
    const deps = await makeService();
    await expect(requestBundle(deps, { nowMs: NOW + 30 * DAY + 1 })).rejects.toMatchObject({ code: "FAILURE_REFUND_POLICY_REFUSAL" }); // #5606 (G-3)
  });
});

describe("bundle refund execution revokes the purchase (#5227)", () => {
  async function makeRealBundleStore() {
    const bundles = new InMemoryProductBundleAdapter();
    await bundles.createBundle({
      id: "bnd-1",
      name: "Stock + Options",
      memberProductIds: ["stock:PayPerUse", "options:PayPerUse"],
      priceUSD: 30,
      periodDays: 30,
      includedRunsPerMember: 10,
    });
    await bundles.approveBundle("bnd-1", "op1");
    const { purchase } = await bundles.createBundlePurchaseAtomic({
      purchase: {
        id: "bp-1",
        userId: "u1",
        tenantId: "t1",
        bundleId: "bnd-1",
        providerPaymentRef: "bbnd-test-1",
        stripePaymentIntentId: null,
        providerSubscriptionId: "sub_1",
        providerStatus: "active",
        periodStartMs: NOW,
        periodEndMs: NOW + 30 * DAY,
      },
      entitlements: [
        { productId: "stock:PayPerUse", includedRuns: 10, periodStartMs: NOW, periodEndMs: NOW + 30 * DAY },
        { productId: "options:PayPerUse", includedRuns: 10, periodStartMs: NOW, periodEndMs: NOW + 30 * DAY },
      ],
      nowMs: NOW,
    });
    return { bundles, purchase };
  }

  it("request -> approve -> execute settles the prorated amount and revokes the purchase + entitlements", async () => {
    const { bundles, purchase } = await makeRealBundleStore();
    const policy = new InMemoryRefundPolicyAdapter();
    await policy.setKindApproval("bundle", true, "op1");
    const refunds = new InMemoryRefundAdapter();
    const { billing } = stubBilling("pi_first_1");
    const resolver = createBundlePaymentResolver(bundles, billing);
    const deps = { policyStore: policy, refundStore: refunds, sourceResolver: resolver };
    const requested = await requestRefund({ ...deps, nowMs: NOW + 15 * DAY }, {
      kind: "bundle",
      originalPaymentRef: "bbnd-test-1",
      reason: "changed my mind",
      requesterLogin: "u1",
      isOperator: false,
    });
    expect(requested.amountUSD).toBe(15);
    const approved = await decideRefund(
      { refundStore: refunds, nowMs: NOW + 15 * DAY },
      { refundId: requested.id, decision: "approve", approverLogin: "op1" },
    );
    expect(approved.status).toBe("approved");
    const gateway = {
      executeRefund: async () => ({ success: true, refundId: "re_test_1", amountRefunded: 15, message: "ok" }),
    };
    const executed = await executeRefund(
      {
        policyStore: policy,
        refundStore: refunds,
        sourceResolver: resolver,
        bundleStore: bundles,
        gateway,
        monetizationEnabled: true,
        nowMs: NOW + 16 * DAY,
      },
      { refundId: requested.id },
    );
    expect(executed.status).toBe("executed");
    expect(executed.gatewayRefundId).toBe("re_test_1");
    expect(executed.amountUSD).toBe(15);
    expect(executed.entitlementConsequence).toMatch(/bundle_revoked/);
    const after = await bundles.getBundlePurchase(purchase.id);
    expect(after?.status).toBe("canceled");
    expect((await bundles.listBundleEntitlements("u1")).every((e) => e.status === "canceled")).toBe(true);
    // The journal attributes the refund to the bundle family.
    expect(buildRefundJournalEntries(executed)[0]?.family).toBe("bundle");
  });

  it("execution without a bundle store records the honest consequence instead of claiming a revocation", async () => {
    const deps = await makeService();
    const requested = await requestBundle(deps, { nowMs: NOW });
    await decideRefund(
      { refundStore: deps.refunds, nowMs: NOW },
      { refundId: requested.id, decision: "approve", approverLogin: "op1" },
    );
    const gateway = {
      executeRefund: async () => ({ success: true, refundId: "re_test_1", amountRefunded: 30, message: "ok" }),
    };
    const executed = await executeRefund(
      {
        policyStore: deps.policy,
        refundStore: deps.refunds,
        sourceResolver: deps.resolver,
        gateway,
        monetizationEnabled: true,
        nowMs: NOW,
      },
      { refundId: requested.id },
    );
    expect(executed.status).toBe("executed");
    expect(executed.entitlementConsequence).toMatch(/bundle_store_unavailable:entitlement_unchanged/);
  });
});
