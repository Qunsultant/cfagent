/** @vitest-environment jsdom */
/**
 * Issue #2667 (Monetization Phase 2.12, program #2405) — usage/billing
 * reader panel section.
 *
 * TDD RED first: this suite imports src/client/usageBillingApi.ts and
 * src/client/UsageBillingSection.tsx, which do not exist yet.
 *
 * Scope: one section in the Billing servicing surface rendering the new
 * GET /payments/agentic/commercial/usage-billing view — usage (metered
 * calls with per-row provenance, included-run balance, credit balance)
 * AND billing (subscriptions with periods, renewals, refunds with
 * per-row provenance, referral balance) together. Simulated rows render
 * as "Simulated", never as "Real". Failures render the coded catalog
 * message verbatim (`[CODE] businessMessage`, the #2573 pattern);
 * server error bodies are never rendered. ui primitives only.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  fetchUsageBilling,
  UsageBillingApiError,
  type UsageBillingView,
} from "../src/client/usageBillingApi";
import { UsageBillingSection } from "../src/client/UsageBillingSection";
import { codedMessage } from "../src/outcomes/outcomeAspects";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "/api/payments/agentic/commercial/usage-billing";
const MARKER = "typed server detail marker";

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number, code?: string) {
  return {
    ok: false,
    status,
    json: async () => (code ? { code, error: MARKER } : { error: MARKER }),
  };
}

const VIEW: UsageBillingView = {
  outcome: "SUCCESS_USAGE_BILLING_READ",
  userLogin: "owner-login",
  tier: "Subscribed",
  limit: 50,
  identity: { creditsUSD: 4.5, includedRunsRemaining: 3, hasAccount: true },
  usage: {
    receipts: [
      {
        id: "meter-1",
        kind: "meter",
        createdAt: "2026-11-01T10:00:00.000Z",
        provenance: "real",
        provenanceNote: "Metered call (verified, served)",
        receiptId: "run-1",
        amountUSD: 0.02,
        tier: "PayPerUse",
        protocol: "x402",
        gateway: null,
        status: "served",
      },
      {
        id: "tx_sim_1",
        kind: "transaction",
        createdAt: "2026-11-01T10:00:00.000Z",
        provenance: "simulated",
        provenanceNote: "Simulated ledger entry",
        receiptId: null,
        amountUSD: 0.02,
        tier: null,
        protocol: null,
        gateway: "x402",
        status: "simulated",
      },
    ],
    counts: { meter: 1, tier: 0, transaction: 1, real: 1, simulated: 1, audit: 0 },
  },
  billing: {
    effectiveTier: "Subscribed",
    current: {
      id: "sub-1",
      userId: "owner-login",
      tenantId: "t-owner-login",
      planId: "plan-pro",
      provider: "stripe",
      providerPaymentRef: "sub-draft-1",
      stripeSessionId: "cs_test_1",
      stripePaymentIntentId: "pi_test_1",
      providerSubscriptionId: "sub_prov_1",
      providerStatus: "active",
      status: "active",
      periodStartMs: 1_700_000_000_000,
      periodEndMs: 1_702_592_000_000,
      canceledAtMs: null,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      provenance: "real",
      provenanceNote: "Provider-managed subscription with a verified provider payment reference",
    },
    subscriptions: [],
    renewals: [
      {
        subscriptionId: "sub-1",
        planId: "plan-pro",
        renewsAtMs: 1_702_592_000_000,
        renewsAtISO: "2026-11-30T00:00:00.000Z",
        status: "active",
      },
    ],
    refunds: [
      {
        id: "refund-1",
        kind: "subscription",
        rail: "stripe",
        tenantId: "t-owner-login",
        userId: "owner-login",
        originalPaymentRef: "sub-1",
        subscriptionId: "sub-1",
        paymentIntentId: "pi_test_1",
        family: null,
        originalAmountUSD: 20,
        amountUSD: 20,
        originalPaidAtMs: 1_700_000_000_000,
        reason: "test refund",
        status: "executed",
        approverLogin: "op1",
        decisionNote: null,
        gatewayRefundId: "re_test_1",
        executedAtMs: 1_700_000_001_000,
        entitlementConsequence: "access revoked",
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_001_000,
        provenance: "real",
        provenanceNote: "Executed refund with a provider refund id",
      },
    ],
    referral: { redeemableUSD: 0.5, totalEarnedUSD: 0.5 },
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("usageBillingApi (#2667)", () => {
  it("fetches the usage/billing view and validates its shape", async () => {
    const fetchMock = vi.fn(async () => ok(VIEW));
    vi.stubGlobal("fetch", fetchMock);
    const view = await fetchUsageBilling();
    expect(view.userLogin).toBe("owner-login");
    expect(view.usage.receipts).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(BASE, expect.anything());
  });

  it("throws a coded error carrying the catalog code, never server detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => err(503, "FAILURE_USAGE_BILLING_STORE_UNAVAILABLE")),
    );
    const caught = await fetchUsageBilling().catch((e) => e as UsageBillingApiError);
    expect(caught).toBeInstanceOf(UsageBillingApiError);
    expect(caught.status).toBe(503);
    expect(caught.code).toBe("FAILURE_USAGE_BILLING_STORE_UNAVAILABLE");
    expect(caught.message).toBe(codedMessage("FAILURE_USAGE_BILLING_STORE_UNAVAILABLE"));
    expect(caught.message).not.toContain(MARKER);
  });

  it("throws on a malformed view instead of rendering a partial read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ userLogin: "owner-login" })));
    await expect(fetchUsageBilling()).rejects.toThrow(UsageBillingApiError);
  });
});

describe("UsageBillingSection (#2667)", () => {
  it("renders usage and billing together with per-row provenance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok(VIEW)));
    const el = mount(<UsageBillingSection />);
    await act(async () => {});
    expect(el.textContent).toContain("Usage");
    expect(el.textContent).toContain("Included runs remaining: 3");
    expect(el.textContent).toContain("Credit balance: $4.50 USD");
    expect(el.textContent).toContain("plan-pro");
    expect(el.textContent).toContain("Renewals");
    expect(el.textContent).toContain("refund-1");
    expect(el.textContent).toContain("Redeemable: $0.50 USD");
  });

  it("renders simulated rows as Simulated, never as Real", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok(VIEW)));
    const el = mount(<UsageBillingSection />);
    await act(async () => {});
    expect(el.textContent).toContain("Simulated");
    // The simulated transaction row's provenance label is Simulated;
    // the word Real appears only for the real rows (meter + sub + refund).
    const realCount = (el.textContent?.match(/Real/g) ?? []).length;
    expect(realCount).toBe(3);
  });

  it("renders the coded catalog message on failure, never server detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => err(503, "FAILURE_USAGE_BILLING_STORE_UNAVAILABLE")),
    );
    const el = mount(<UsageBillingSection />);
    await act(async () => {});
    expect(el.textContent).toContain(codedMessage("FAILURE_USAGE_BILLING_STORE_UNAVAILABLE"));
    expect(el.textContent).not.toContain(MARKER);
  });

  it("renders empty states and a retry", async () => {
    const empty: UsageBillingView = {
      ...VIEW,
      usage: { receipts: [], counts: { meter: 0, tier: 0, transaction: 0, real: 0, simulated: 0, audit: 0 } },
      billing: {
        ...VIEW.billing,
        current: null,
        subscriptions: [],
        renewals: [],
        refunds: [],
        referral: { redeemableUSD: 0, totalEarnedUSD: 0 },
      },
    };
    const fetchMock = vi.fn(async () => ok(empty));
    vi.stubGlobal("fetch", fetchMock);
    const el = mount(<UsageBillingSection />);
    await act(async () => {});
    expect(el.textContent).toContain("No usage recorded yet.");
    expect(el.textContent).toContain("No subscriptions on file.");
    expect(el.textContent).toContain("No refunds on file.");
    const retry = el.querySelector("button");
    expect(retry).not.toBeNull();
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
