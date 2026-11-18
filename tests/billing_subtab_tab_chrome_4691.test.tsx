/** @vitest-environment jsdom */
/**
 * Issue #4691 — Billing sub-tab deep links must render as a tab, not a
 * page (tab → page morph).
 *
 * TDD RED first: `?tab=billing&view=approved-free-quota` (and every
 * Billing sub-tab deep link) renders inside the full Billing page shell
 * — h1 "Billing" + scope description above the tab strip, and each
 * section re-titles itself inside its Card (h2/h3/paragraph) — so a
 * deep link to a tab delivers a page, not a tab.
 *
 * The fix follows the #3125 contract (see tests/order_risk_tab_3125.test.tsx):
 * the host applies `PageChromeContext` value "tab" around the unchanged
 * panel; each section owns its title through PageShell, so the title
 * collapses to content-only under tab chrome and stays an h1 under
 * page chrome. No panel reads the context, no panel prop, no branch
 * inside a panel.
 *
 * This suite pins the HOSTED rendering (Chat mounts BillingServicingPanel
 * under the tab provider): for every one of the 10 sub-tab URLs, from
 * first paint (loading) through full load — tab strip is the navigation,
 * the tab label is the title, no page-level h1 / scope note /
 * description above the tab content, section as tabpanel content with
 * no own page-like heading. It also pins the page host is preserved
 * (standalone render keeps the Billing shell) and the contract in source.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BillingServicingPanel,
  BILLING_TABS,
} from "../src/client/BillingServicingPanel";
import { PageChromeContext } from "../src/client/components/ui/PageShell";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = __dirname;
const CLIENT_DIR = join(HERE, "..", "src", "client");

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

// One distinctive CONTENT marker per tab — never the section title
// itself (the title collapses under tab chrome; the tab label is the
// title). Each marker is inside the section's Card/body, so it proves
// the section mounted as tabpanel content.
const TAB_MODE_MARKERS: Record<string, string> = {
  overview: "Current tier:",
  "refund-policy": "The refund policy could not be loaded.",
  "refund-flow": "Your refunds could not be loaded.",
  "usage-billing": "Included runs remaining:",
  "referral-codes": "Redeem a code",
  "approved-free-quota": "Could not load the approved-free quota.",
  "top-up-limits": "The top-up limits could not be loaded.",
  "offer-rules": "Only a store operator can view or change upgrade-offer rules",
  "plan-stripe-price": "Only a store operator can view or change plan Stripe Price mappings",
  "billing-policy": "Only a store operator can view or change billing policy.",
  "support-snapshot": "Account: owner",
};

const BILLING_DESCRIPTION =
  "Your subscription, receipts, plans, and referral-credit balance";

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

/** Render the panel the way Chat hosts it: under tab chrome. */
async function renderPanelInTabHost(search = "/?tab=billing", fetchImpl: (url: string) => Promise<unknown> = billingFetch()) {
  window.history.pushState(null, "", search);
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(
        PageChromeContext.Provider,
        { value: "tab" },
        React.createElement(BillingServicingPanel),
      ),
    );
  });
  await flush();
}

/** Render the panel standalone (page chrome) — the preserved host. */
async function renderPanelStandalone(search = "/?tab=billing") {
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

function activePanel(id: string): HTMLElement | null {
  return container.querySelector(`#billing-panel-${id}`);
}

function text(): string {
  return container.textContent ?? "";
}

describe("Billing sub-tabs render as a tab, not a page (#4691)", () => {
  it("tab host: the tab strip is the navigation from first paint, with no page chrome while loading", async () => {
    // A fetch that never resolves: the panel stays in its loading state.
    const hangingFetch = () => new Promise<never>(() => {});
    window.history.pushState(null, "", "/?tab=billing&view=approved-free-quota");
    vi.stubGlobal("fetch", vi.fn(hangingFetch));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(
          PageChromeContext.Provider,
          { value: "tab" },
          React.createElement(BillingServicingPanel),
        ),
      );
    });
    // First paint: the tab strip is already there with the URL's tab
    // selected, and there is no page-level header above it.
    expect(billingTabLabels()).toEqual([...EXPECTED_LABELS]);
    expect(billingTabButton("approved-free-quota").getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Loading billing view");
    expect(container.querySelector("h1")).toBeNull();
    expect(text()).not.toContain(BILLING_DESCRIPTION);
  });

  it.each([...EXPECTED_TABS].map((id) => [id, TAB_MODE_MARKERS[id]]))(
    "tab host: ?tab=billing&view=%s renders as a tab through full load",
    async (id, marker) => {
      await renderPanelInTabHost(`/?tab=billing&view=${id}`);
      expect(billingTabButton(id).getAttribute("aria-selected")).toBe("true");
      // No page-level header anywhere: the tab label is the title.
      expect(container.querySelector("h1")).toBeNull();
      expect(container.querySelector(".ui-page-shell")).toBeNull();
      expect(text()).not.toContain(BILLING_DESCRIPTION);
      // The section mounts as tabpanel content, with no own page-like
      // heading duplicating the tab label.
      const panel = activePanel(id);
      expect(panel).not.toBeNull();
      expect(panel!.textContent).toContain(marker);
      expect(panel!.querySelector("h2")).toBeNull();
      expect(panel!.querySelector("h3")).toBeNull();
    },
  );

  it("tab host: switching tabs never morphs into a page", async () => {
    await renderPanelInTabHost("/?tab=billing");
    expect(billingTabButton("overview").getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      billingTabButton("approved-free-quota").click();
    });
    await flush();
    expect(billingTabButton("approved-free-quota").getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toContain("view=approved-free-quota");
    expect(container.querySelector("h1")).toBeNull();
    expect(text()).not.toContain(BILLING_DESCRIPTION);
    const panel = activePanel("approved-free-quota");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain(TAB_MODE_MARKERS["approved-free-quota"]);
    expect(panel!.querySelector("h2")).toBeNull();
  });

  it("page host preserved: the standalone render keeps the Billing shell", async () => {
    await renderPanelStandalone("/?tab=billing");
    expect(container.querySelector("h1")?.textContent).toBe("Billing");
    expect(text()).toContain(BILLING_DESCRIPTION);
    expect(billingTabLabels()).toEqual([...EXPECTED_LABELS]);
    expect(BILLING_TABS).toEqual([...EXPECTED_TABS]);
  });

  it("pins host-applied chrome: the host provides it, the panels never read it", () => {
    const chat = readFileSync(join(CLIENT_DIR, "Chat.tsx"), "utf8");
    const panel = readFileSync(join(CLIENT_DIR, "BillingServicingPanel.tsx"), "utf8");
    // The Chat billing entry mounts the panel under tab chrome.
    expect(chat).toContain("PageChromeContext.Provider");
    expect(chat).toContain('value="tab"');
    expect(chat).toContain("BillingServicingPanel");
    expect(chat).toContain('import { PageChromeContext } from "./components/ui/PageShell"');
    // The panel keeps its shell (title + scope note + section) and never
    // branches on its host; the servicing description is the shell's
    // scope note now, not a PageSection description above the tabs.
    expect(panel).toContain("<PageShell");
    expect(panel).toContain('title="Billing"');
    expect(panel).toContain(BILLING_DESCRIPTION);
    expect(panel).toContain("<PageSection");
    expect(panel).not.toContain("useContext(PageChromeContext)");
    expect(panel).not.toContain("PageChromeContext.Provider");
    expect(panel).not.toContain('description="Your subscription');
    // The inline support-snapshot card no longer re-titles itself with
    // the tab label.
    expect(panel).not.toContain("<p>Support snapshot</p>");
  });

  it.each([
    ["RefundPolicySection", "Refund policy", "<p>Refund policy</p>"],
    ["RefundFlowSection", "Refund flow", "<p>Refund flow</p>"],
    ["UsageBillingSection", "Usage and billing", "<h3>Usage and billing</h3>"],
    ["ReferralCodesSection", "Referral codes", "<h3>Referral codes</h3>"],
    ["ApprovedFreeQuotaSection", "Approved-free quota", "<h2>Approved-free quota</h2>"],
    ["TopUpLimitsSection", "Top-up limits", "<p>Top-up limits</p>"],
    ["OfferRulesSection", "Upgrade-offer rules", "<p>Upgrade-offer rules</p>"],
    ["PlanStripePriceSection", "Plan Stripe Price mappings", "<p>Plan Stripe Price mappings</p>"],
    ["BillingPolicySection", "Billing policy", "<p>Billing policy</p>"],
  ])(
    "pins the %s title lives in PageShell, not a hand-rolled heading",
    (file, title, oldHeading) => {
      const src = readFileSync(join(CLIENT_DIR, `${file}.tsx`), "utf8");
      expect(src).toContain("<PageShell");
      expect(src).toContain(`title="${title}"`);
      expect(src).not.toContain("useContext(PageChromeContext)");
      expect(src).not.toContain("PageChromeContext.Provider");
      expect(src).not.toContain(oldHeading);
    },
  );
});
