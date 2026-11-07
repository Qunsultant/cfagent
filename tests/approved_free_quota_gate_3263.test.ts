// @vitest-environment node
/**
 * Issue #3263 (sub-issue of #3256; ownership COO-spr9) — gate
 * enforcement of the approved-free per-service quota.
 *
 * Defaults (owner direction 2026-11-06, PROPOSED): 10 runs per
 * service per month, monthly window, at-limit per #3241 decision 4
 * (upgrade or buy credits). With no operator override the default
 * applies — the grant is capped, never unlimited.
 *
 * Tenant scoping (#1069 §10): quota counts are keyed
 * (tenant_id, login, family, period); cross-tenant isolation is
 * tested explicitly below.
 */
import { describe, expect, it } from "vitest";
import { NativeMonetizationGate, type NativeCommercialAccount } from "../src/services/nativeMonetization";
import { StripeCheckoutAdapter, type StripeCheckoutClient } from "../src/services/stripeCheckoutAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryFreeRunCounterAdapter } from "../src/data/inMemoryFreeRunCounterAdapter";
import { InMemoryApprovedFreeQuotaAdapter } from "../src/data/inMemoryApprovedFreeQuotaAdapter";
import type { PriceFamily } from "../src/data/priceCataloguePorts";
import type { CheckoutPorts } from "../src/services/checkoutPorts";
import type {
  ApprovedFreeQuota,
  ApprovedFreeQuotaAtLimitAction,
  ApprovedFreeQuotaWindowKind,
} from "../src/data/approvedFreeQuotaPorts";

const NOV = Date.UTC(2026, 10, 15, 12, 0, 0);
const NOV_16 = Date.UTC(2026, 10, 16, 0, 0, 0);
const DEC = Date.UTC(2026, 11, 1, 0, 0, 0);

function account(overrides: Partial<NativeCommercialAccount> = {}): NativeCommercialAccount {
  return {
    userId: "u1",
    email: "u1@example.com",
    tenantId: "t1",
    tier: "Free",
    creditsUSD: 0,
    includedRunsRemaining: 0,
    ...overrides,
  };
}

function grantedAccount(overrides: Partial<NativeCommercialAccount> = {}): NativeCommercialAccount {
  return account({
    unlimitedFreeGrant: { grantedBy: "op1", reason: "Owner-approved pilot account", expiresAtMs: null },
    ...overrides,
  });
}

function quotaGate(opts: {
  caps?: Partial<Record<PriceFamily, number>>;
  windowKind?: ApprovedFreeQuotaWindowKind;
  atLimitAction?: ApprovedFreeQuotaAtLimitAction;
  wireQuota?: boolean;
  withSettings?: boolean;
  quota?: ApprovedFreeQuota;
} = {}) {
  const creates: Array<{ draftId: string; amount: number }> = [];
  const client: StripeCheckoutClient = {
    async createCheckout(params) {
      creates.push({ draftId: params.draftId, amount: params.amount });
      return {
        success: true,
        checkoutUrl: `https://checkout.example/session/${params.draftId}`,
        gatewayRef: `cs_test_${params.draftId}`,
      };
    },
    async retrieveSession(sessionId) {
      return {
        id: sessionId,
        status: "complete",
        payment_status: "paid",
        amount_total: 10,
        client_reference_id: "run-1",
        payment_intent: "pi_test_run-1",
      };
    },
  };
  const ports: CheckoutPorts = { card: new StripeCheckoutAdapter(client), x402: null };
  const quota =
    opts.quota ??
    new InMemoryApprovedFreeQuotaAdapter({
      caps: opts.caps ?? { stock: 10, goal: 10, options: 10, strategy: 10 },
      ...(opts.withSettings === false
        ? {}
        : {
            settings: {
              windowKind: opts.windowKind ?? "month",
              atLimitAction: opts.atLimitAction ?? "upgrade_or_buy_credits",
            },
          }),
    });
  const counter = new InMemoryFreeRunCounterAdapter({ stock: 10, goal: 10, options: 10, strategy: 10 });
  const gate = new NativeMonetizationGate({
    monetizationEnabled: true,
    priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
    checkout: ports,
    freeRunCounter: counter,
    ...(opts.wireQuota === false ? {} : { approvedFreeQuota: quota }),
  });
  return { gate, creates, quota, counter };
}

describe("approved-free quota: gate enforcement (#3263)", () => {
  it("a grant run under the quota is allowed at price 0, counted against the quota, never the free-run counter", async () => {
    const { gate, creates, quota, counter } = quotaGate();
    const decision = await gate.check({
      id: "run-1",
      family: "goal",
      trigger: "manual",
      nowMs: NOV,
      account: grantedAccount(),
    });
    expect(decision).toEqual({
      allowed: true,
      status: "paid",
      runRequestId: "run-1",
      priceUSD: 0,
      paidVia: "approved_free_quota",
      outcomeCode: "SUCCESS_APPROVED_FREE_QUOTA_COVERED",
    });
    expect(creates).toHaveLength(0);
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-11" })).toBe(1);
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(0);
  });

  it("10 grant runs are allowed; the 11th is refused with the decision-4 outcome, no checkout, uncounted", async () => {
    const { gate, creates, quota, counter } = quotaGate();
    for (let i = 1; i <= 10; i++) {
      const d = await gate.check({
        id: `run-${i}`,
        family: "goal",
        trigger: "manual",
        nowMs: NOV,
        account: grantedAccount(),
      });
      expect(d.allowed).toBe(true);
    }
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-11" })).toBe(10);
    const eleventh = await gate.check({
      id: "run-11",
      family: "goal",
      trigger: "manual",
      nowMs: NOV,
      account: grantedAccount(),
    });
    expect(eleventh).toMatchObject({
      allowed: false,
      status: "approved_free_quota_exhausted",
      httpStatus: 402,
      priceUSD: 0,
      family: "goal",
      outcomeCode: "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED",
      nextStep: "upgrade_or_buy_credits",
    });
    expect(creates).toHaveLength(0);
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-11" })).toBe(10);
    // No fall-through to the Free counter: the quota is the bound.
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(0);
  });

  it("at-limit with the stop action carries the stop outcome code and no purchase prompt", async () => {
    const { gate } = quotaGate({ atLimitAction: "stop" });
    for (let i = 1; i <= 10; i++) {
      await gate.check({ id: `run-${i}`, family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() });
    }
    const eleventh = await gate.check({
      id: "run-11",
      family: "goal",
      trigger: "manual",
      nowMs: NOV,
      account: grantedAccount(),
    });
    expect(eleventh).toMatchObject({
      allowed: false,
      status: "approved_free_quota_exhausted",
      outcomeCode: "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED_STOP",
      nextStep: "stop",
    });
  });

  it("the quota is per service: goal at the cap still leaves stock open", async () => {
    const { gate, quota } = quotaGate();
    for (let i = 1; i <= 10; i++) {
      await gate.check({ id: `run-g${i}`, family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() });
    }
    expect(
      (
        await gate.check({ id: "run-g11", family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() })
      ).allowed,
    ).toBe(false);
    const stock = await gate.check({
      id: "run-s1",
      family: "stock",
      trigger: "manual",
      nowMs: NOV,
      account: grantedAccount(),
    });
    expect(stock).toMatchObject({ allowed: true, paidVia: "approved_free_quota" });
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "stock", period: "2026-11" })).toBe(1);
  });

  it("the quota resets monthly: December starts at 0 while November stays at the cap", async () => {
    const { gate, quota } = quotaGate();
    for (let i = 1; i <= 10; i++) {
      await gate.check({ id: `nov-${i}`, family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() });
    }
    expect(
      (
        await gate.check({ id: "nov-11", family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() })
      ).allowed,
    ).toBe(false);
    const dec = await gate.check({ id: "dec-1", family: "goal", trigger: "manual", nowMs: DEC, account: grantedAccount() });
    expect(dec).toMatchObject({ allowed: true, paidVia: "approved_free_quota" });
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-12" })).toBe(1);
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-11" })).toBe(10);
  });

  it("weekly window: the cap resets on Monday, not on the month boundary", async () => {
    const { gate, quota } = quotaGate({ windowKind: "week" });
    for (let i = 1; i <= 10; i++) {
      await gate.check({ id: `w46-${i}`, family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() });
    }
    expect(
      (
        await gate.check({ id: "w46-11", family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() })
      ).allowed,
    ).toBe(false);
    const monday = await gate.check({
      id: "w47-1",
      family: "goal",
      trigger: "manual",
      nowMs: NOV_16,
      account: grantedAccount(),
    });
    expect(monday).toMatchObject({ allowed: true, paidVia: "approved_free_quota" });
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-W47" })).toBe(1);
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-W46" })).toBe(10);
  });

  it("an expired grant lapses to the normal gate (Free counter), and the quota is untouched", async () => {
    const { gate, quota, counter } = quotaGate();
    const expired = grantedAccount({
      unlimitedFreeGrant: { grantedBy: "op1", reason: "Pilot", expiresAtMs: NOV - 1000 },
    });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", nowMs: NOV, account: expired });
    expect(decision).toMatchObject({ allowed: true, paidVia: "free_run_allowance" });
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-11" })).toBe(0);
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(1);
  });

  it("a scheduled grant run under the quota is allowed; at the cap it is quota-exhausted, not coverage_required", async () => {
    const { gate, creates } = quotaGate();
    const scheduled = await gate.check({
      id: "run-sched-1",
      family: "goal",
      trigger: "scheduled",
      nowMs: NOV,
      account: grantedAccount(),
    });
    expect(scheduled).toMatchObject({ allowed: true, paidVia: "approved_free_quota" });
    for (let i = 2; i <= 10; i++) {
      await gate.check({ id: `run-sched-${i}`, family: "goal", trigger: "scheduled", nowMs: NOV, account: grantedAccount() });
    }
    const eleventh = await gate.check({
      id: "run-sched-11",
      family: "goal",
      trigger: "scheduled",
      nowMs: NOV,
      account: grantedAccount(),
    });
    expect(eleventh).toMatchObject({ allowed: false, status: "approved_free_quota_exhausted", httpStatus: 402 });
    expect(creates).toHaveLength(0);
  });

  it("re-checking the same run id does not double-count", async () => {
    const { gate, quota } = quotaGate();
    await gate.check({ id: "run-1", family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() });
    const again = await gate.check({ id: "run-1", family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() });
    expect(again).toMatchObject({ allowed: true, status: "already_paid", paidVia: "approved_free_quota" });
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-11" })).toBe(1);
  });

  it("an operator-lowered cap (2) caps the period at 2", async () => {
    const { gate, quota } = quotaGate();
    await quota.setCap({ family: "goal", capRuns: 2 });
    for (let i = 1; i <= 2; i++) {
      expect(
        (await gate.check({ id: `run-${i}`, family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() }))
          .allowed,
      ).toBe(true);
    }
    expect(
      (await gate.check({ id: "run-3", family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() }))
        .allowed,
    ).toBe(false);
  });

  it("with no quota port wired, the grant falls through to the Free allowance (fail-closed: never beyond it)", async () => {
    const { gate, counter } = quotaGate({ wireQuota: false });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() });
    expect(decision).toMatchObject({ allowed: true, paidVia: "free_run_allowance" });
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(1);
  });

  it("with no settings row, the grant falls through to the Free allowance", async () => {
    const { gate, counter } = quotaGate({ withSettings: false });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() });
    expect(decision).toMatchObject({ allowed: true, paidVia: "free_run_allowance" });
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(1);
  });

  it("a quota store failure degrades safely (tech-standards §13): the run falls through to the normal gate, never fails, never grants an unverified free run", async () => {
    // A store blip on the quota read: getSettings throws.
    class ThrowingQuotaAdapter extends InMemoryApprovedFreeQuotaAdapter {
      override async getSettings(): Promise<null> {
        throw new Error("D1 blip");
      }
    }
    const throwing = new ThrowingQuotaAdapter({
      caps: { stock: 10, goal: 10, options: 10, strategy: 10 },
      settings: { windowKind: "month", atLimitAction: "upgrade_or_buy_credits" },
    });
    const { gate, counter } = quotaGate({ quota: throwing });
    const decision = await gate.check({ id: "run-1", family: "goal", trigger: "manual", nowMs: NOV, account: grantedAccount() });
    // Fail-closed AND non-failing: the Free allowance (the normal
    // gate) covers the run; the quota itself is untouched.
    expect(decision).toMatchObject({ allowed: true, paidVia: "free_run_allowance" });
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(1);
    expect(await throwing.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-11" })).toBe(0);
  });

  it("an unapproved account is unchanged (402 checkout, no quota touch)", async () => {
    const { gate, creates, quota } = quotaGate();
    // The Free-run allowance (#3305) covers the first 10 runs for a
    // Free account; only after it is exhausted does the normal paid
    // path mint a checkout. The quota must not touch either leg.
    for (let i = 1; i <= 10; i++) {
      const d = await gate.check({ id: `run-${i}`, family: "goal", trigger: "manual", nowMs: NOV, account: account() });
      expect(d).toMatchObject({ allowed: true, paidVia: "free_run_allowance" });
    }
    const decision = await gate.check({ id: "run-11", family: "goal", trigger: "manual", nowMs: NOV, account: account() });
    expect(decision).toMatchObject({ allowed: false, status: "payment_required", httpStatus: 402 });
    expect(creates).toEqual([{ draftId: "run-11", amount: 0.1 }]);
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-11" })).toBe(0);
  });
});

describe("approved-free quota: tenant isolation at the gate (#1069)", () => {
  it("the same login in Tenant B has its own quota: Tenant A usage never leaks or spends", async () => {
    const { gate, quota } = quotaGate();
    const inA = grantedAccount();
    const inB = grantedAccount({ tenantId: "t2" });
    for (let i = 1; i <= 10; i++) {
      await gate.check({ id: `a-${i}`, family: "goal", trigger: "manual", nowMs: NOV, account: inA });
    }
    expect(
      (await gate.check({ id: "a-11", family: "goal", trigger: "manual", nowMs: NOV, account: inA })).allowed,
    ).toBe(false);
    // Tenant B starts at 0 for the same login and family.
    const firstInB = await gate.check({ id: "b-1", family: "goal", trigger: "manual", nowMs: NOV, account: inB });
    expect(firstInB).toMatchObject({ allowed: true, paidVia: "approved_free_quota" });
    expect(await quota.getUsed({ tenantId: "t2", login: "u1", family: "goal", period: "2026-11" })).toBe(1);
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-11" })).toBe(10);
  });

  it("a run whose tenant does not match the verified account tenant is refused before any quota read", async () => {
    const { gate, quota } = quotaGate();
    await expect(
      gate.check({
        id: "run-x",
        family: "goal",
        trigger: "manual",
        tenantId: "t2",
        nowMs: NOV,
        account: grantedAccount(),
      }),
    ).rejects.toThrow(/Tenant mismatch/);
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-11" })).toBe(0);
    expect(await quota.getUsed({ tenantId: "t2", login: "u1", family: "goal", period: "2026-11" })).toBe(0);
  });
});
