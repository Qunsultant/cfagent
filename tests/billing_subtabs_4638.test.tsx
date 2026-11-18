/** @vitest-environment jsdom */
/**
 * Issue #4638 — sub-tabs for each section of the Billing page.
 *
 * TDD RED first: `?tab=billing` renders one BillingServicingPanel with
 * zero tabs — 10 sections stacked in one long scrolling page. This suite
 * pins the ProductHub/StockHub shape: URL-synced sub-tabs on `view`
 * (useUrlSyncedTabs + Tabs/TabPanel + visitedTabs gating), Overview as
 * the default first tab, one tab per section, deep links in the billing
 * nav sub-menu, just one of everything, access rules unchanged.
 *
 * The section mounts are asserted on their fixed load-failure strings
 * (unknown section APIs 404 in the mock): the tab test verifies tabs,
 * mounting, and navigation — section behaviour itself is covered by
 * the sections' own suites.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  BillingServicingPanel,
  BILLING_TABS,
} from "../src/client/BillingServicingPanel";
import { deepLinkForNavNode, deepLinkHref } from "../src/client/deepLinks";
import navData from "../src/client/nav-config.json";
import { SUB_MENU_CONFIGS } from "../src/client/navConfig";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;

const EXPECTED_TABS = [
  "overview",
  "refund-policy",
  "refund-flow",
  "usage-billing",
  "referral-codes",
  "approved-free-quota",
  "top-up-limits",
  "offer-rules",
  "plan-stripe-price",
  "billing-policy",
  "support-snapshot",
] as const;

const EXPECTED_LABELS = [
  "Overview",
  "Refund policy",
  "Refund flow",
  "Usage billing",
  "Referral codes",
  "Approved free quota",
  "Top-up limits",
  "Offer rules",
  "Plan Stripe Price mappings",
  "Billing policy",
  "Support snapshot",
];

// One distinctive marker per tab, present exactly once when mounted.
// Markers must not collide with the tab labels themselves (the tab row
// is part of textContent): the referral-codes marker is the redeem form
// heading, the support-snapshot marker is the card's account line, and
// the operator-gated sections render their fixed non-operator note when
// the operator list does not contain the login (the mock 404s it).
const TAB_MARKERS: Record<string, string> = {
  overview: "Current tier:",
  "refund-policy": "The refund policy could not be loaded.",
  "refund-flow": "Your refunds could not be loaded.",
  "usage-billing": "Usage and billing",
  "referral-codes": "Redeem a code",
  "approved-free-quota": "Approved-free quota",
  "top-up-limits": "The top-up limits could not be loaded.",
  "offer-rules": "Only a store operator can view or change upgrade-offer rules",
  "plan-stripe-price": "Only a store operator can view or change plan Stripe Price mappings",
  "billing-policy": "Only a store operator can view or change billing policy.",
  "support-snapshot": "Account: owner",
};

const subMenus = navData.subMenus as Record<string, { id: string }[]>;

let container: HTMLDivElement;
let root: Root | null = null;

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState(null, "", "/");
});

function billingFetch() {
  const impl = async (url: string) => {
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const err = (status: number) => ({ ok: false, status, json: async () => ({ error: "typed" }) });
    if (url === "/api/payments/agentic/commercial/identity") {
      return ok({ userLogin: "owner", tenantId: null, hasAccount: true, tier: "Subscribed", creditsUSD: 0, includedRunsRemaining: 0 });
    }
    if (url.startsWith("/api/payments/agentic/commercial/subscription?")) {
      return ok({ userId: "owner", effectiveTier: "Subscribed", current: { periodEndMs: NOW + 30 * 24 * 3600 * 1000 }, subscriptions: [{}] });
    }
    if (url === "/api/payments/receipts") {
      return ok({ receipts: [{ id: "r1", kind: "meter", createdAt: "2026-11-01T00:00:00Z", provenance: "real", amountUSD: 0.05 }] });
    }
    if (url === "/api/payments/agentic/commercial/plans") {
      return ok({ plans: [{ id: "pro", name: "Pro", priceUSD: 10, periodDays: 30 }] });
    }
    if (url.startsWith("/api/payments/agentic/commercial/referral/balance?")) {
      return ok({ userId: "owner", redeemableUSD: 1.5, totalEarnedUSD: 2.0, attribution: { referrerUserId: "referrer-1" }, rules: { earnAmountUSD: 0.5, vestingDelayMs: 604800000, redemptionScope: "pay-per-run" } });
    }
    if (url === "/api/payments/agentic/commercial/usage-billing") {
      return ok({
        outcome: "SUCCESS_USAGE_BILLING_READ",
        userLogin: "owner",
        tier: "Subscribed",
        limit: 50,
        identity: { creditsUSD: 0, includedRunsRemaining: 0, hasAccount: true },
        usage: { receipts: [], counts: { meter: 0, tier: 0, transaction: 0, real: 0, simulated: 0, audit: 0 } },
        billing: {
          effectiveTier: "Subscribed",
          current: null,
          subscriptions: [],
          renewals: [],
          refunds: [],
          referral: { redeemableUSD: 0, totalEarnedUSD: 0 },
        },
      });
    }
    return err(404);
  };
  return impl;
}

async function renderPanel(search = "/?tab=billing") {
  window.history.pushState(null, "", search);
  vi.stubGlobal("fetch", vi.fn(billingFetch()));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(BillingServicingPanel));
  });
  await flush();
}

function billingTabButton(id: string): HTMLButtonElement {
  const found = container.querySelector(`#billing-tab-${id}`);
  if (!found) throw new Error(`billing tab not found: ${id}`);
  return found as HTMLButtonElement;
}

function billingTabLabels(): string[] {
  return Array.from(
    container.querySelectorAll('button[role="tab"][id^="billing-tab-"]'),
  ).map((b) => (b.textContent ?? "").trim());
}

function text(): string {
  return container.textContent ?? "";
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("Billing sub-tabs (#4638)", () => {
  it("has exactly eleven tabs in order, Overview first", async () => {
    expect(BILLING_TABS).toEqual([...EXPECTED_TABS]);
    await renderPanel();
    expect(billingTabLabels()).toEqual([...EXPECTED_LABELS]);
  });

  it("defaults to the Overview tab; no other section is mounted", async () => {
    await renderPanel();
    expect(billingTabButton("overview").getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Current tier:");
    expect(text()).toContain("Active plans");
    // No other section is mounted yet (visitedTabs gating).
    for (const id of EXPECTED_TABS.slice(1)) {
      expect(text()).not.toContain(TAB_MARKERS[id]);
    }
  });

  it("clicking a tab switches it and writes ?tab=billing&view=<id>", async () => {
    await renderPanel();
    for (const id of EXPECTED_TABS.slice(1)) {
      await act(async () => {
        billingTabButton(id).click();
      });
      await flush();
      expect(billingTabButton(id).getAttribute("aria-selected")).toBe("true");
      expect(window.location.search).toContain(`view=${id}`);
      expect(text()).toContain(TAB_MARKERS[id]);
    }
  });

  it.each([...EXPECTED_TABS].map((id) => [id, TAB_MARKERS[id]]))(
    "a ?tab=billing&view=%s URL opens that tab on mount",
    async (id, marker) => {
      await renderPanel(`/?tab=billing&view=${id}`);
      expect(billingTabButton(id).getAttribute("aria-selected")).toBe("true");
      expect(text()).toContain(marker);
    },
  );

  it("an unknown view falls back to the Overview tab", async () => {
    await renderPanel("/?tab=billing&view=not-a-tab");
    expect(billingTabButton("overview").getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Current tier:");
  });

  it("every section appears exactly once after visiting all tabs", async () => {
    await renderPanel();
    for (const id of EXPECTED_TABS.slice(1)) {
      await act(async () => {
        billingTabButton(id).click();
      });
      await flush();
    }
    const body = text();
    for (const id of EXPECTED_TABS) {
      expect(countOccurrences(body, TAB_MARKERS[id])).toBe(1);
    }
  });

  it("the billing sub-menu carries one entry per section tab plus Revenue Analytics", () => {
    expect(subMenus["billing"].map((i) => i.id)).toEqual([
      ...EXPECTED_TABS,
      "revenue",
    ]);
    expect(SUB_MENU_CONFIGS.billing.map((s) => s.id)).toEqual([
      ...EXPECTED_TABS,
      "revenue",
    ]);
  });

  it("every billing section sub-item deep-links to its tab", () => {
    for (const id of EXPECTED_TABS) {
      expect(deepLinkHref(deepLinkForNavNode("billing", id))).toBe(
        `?tab=billing&view=${id}`,
      );
    }
    expect(deepLinkHref(deepLinkForNavNode("billing", "revenue"))).toBe(
      "?tab=revenue",
    );
  });
});
