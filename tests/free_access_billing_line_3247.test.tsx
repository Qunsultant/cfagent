/** @vitest-environment jsdom */
/**
 * Issue #3247 (slice 2 of #3241) — the free-access line on the
 * billing tab (UsageBillingSection).
 *
 * Harness follows tests/usage_billing_2667.test.tsx: react-dom/client
 * in jsdom, direct component renders, stubbed fetch. The section
 * first loads the usage/billing view, then reads the caller's own
 * free-access grant through the free-access GET route; no network,
 * no key.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UsageBillingSection } from "../src/client/UsageBillingSection";
import type { UsageBillingView } from "../src/client/usageBillingApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

const VIEW: UsageBillingView = {
  outcome: "SUCCESS_USAGE_BILLING_READ",
  userLogin: "owner-login",
  tier: "Free",
  limit: 10,
  identity: { creditsUSD: 4.5, includedRunsRemaining: 3, hasAccount: true },
  usage: {
    receipts: [],
    counts: { meter: 0, tier: 0, transaction: 0, real: 0, simulated: 0, audit: 0 },
  },
  billing: {
    effectiveTier: "Free",
    current: null,
    subscriptions: [],
    renewals: [],
    refunds: [],
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

function grantRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fa1",
    login: "owner-login",
    kind: "lifetime",
    grantedBy: "op1",
    grantedAtMs: Date.UTC(2026, 10, 12),
    expiresAtMs: null,
    revokedAtMs: null,
    reason: "Owner-approved pilot",
    ...overrides,
  };
}

function stubFetch(active: Record<string, unknown> | null) {
  const fetchMock = vi.fn(async (input: any) => {
    const url = String(input);
    if (url.startsWith("/api/payments/agentic/commercial/usage-billing")) {
      return ok(VIEW);
    }
    if (url.startsWith("/api/payments/agentic/commercial/free-access")) {
      return ok({ userId: "owner-login", active, history: active ? [active] : [] });
    }
    return ok({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("free-access billing line (#3247)", () => {
  it("renders the lifetime line beside the referral balance", async () => {
    stubFetch(grantRecord());
    const el = mount(<UsageBillingSection />);
    await act(async () => {});
    expect(el.textContent).toContain("Redeemable: $0.50 USD");
    expect(el.textContent).toContain("Free access: lifetime.");
  });

  it("renders the limited line with its expiry date", async () => {
    stubFetch(grantRecord({ kind: "limited", expiresAtMs: Date.UTC(2027, 0, 1) }));
    const el = mount(<UsageBillingSection />);
    await act(async () => {});
    expect(el.textContent).toContain("Free access until 2027-01-01.");
  });

  it("renders nothing for the line when no grant exists", async () => {
    stubFetch(null);
    const el = mount(<UsageBillingSection />);
    await act(async () => {});
    expect(el.textContent).toContain("Redeemable: $0.50 USD");
    expect(el.textContent).not.toContain("Free access");
  });
});
