/** @vitest-environment jsdom */
/**
 * Issue #4691 follow-up — the Billing tab strip must stay visible while
 * scrolling (sticky).
 *
 * Disappearance mode (confirmed in a real render, not guessed): SCROLL-
 * driven, not load-driven. The strip renders at first paint (see
 * tests/billing_subtab_tab_chrome_4691.test.tsx) as a normal-flow element
 * above long section content; the tab viewport (`.tab-viewport`,
 * overflow-y: auto) scrolls, so the strip scrolls out of view — and
 * because the strip is the sole tab chrome on the Billing view (no page
 * header for context), nothing says "tab" anymore once it leaves. The
 * owner confirmed other tabs' strips do NOT disappear: their content is
 * short or they keep a page header. The fix is Billing-only: a
 * Billing-scoped class on this panel's Tabs; the shared `.ui-tabs`
 * default is untouched.
 *
 * jsdom cannot scroll, so this suite pins the positioning instead: the
 * strip carries the sticky class for every sub-tab URL, from first paint
 * through full load, and the CSS rule for that class defines
 * `position: sticky`. Live scroll verification is the operator's
 * post-merge step.
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
const PRIMITIVES_CSS = join(
  HERE,
  "..",
  "src",
  "client",
  "components",
  "ui",
  "primitives.css",
);
const PANEL_SOURCE = join(HERE, "..", "src", "client", "BillingServicingPanel.tsx");
const TABS_SOURCE = join(HERE, "..", "src", "client", "components", "ui", "Tabs.tsx");

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
  "support-snapshot",
] as const;

/** The Billing-scoped sticky class — the only new class this fix adds.
 *  `ui-` prefixed, like every primitives.css class: the #3047
 *  conformance gate counts non-`ui-` className tokens as bespoke, and
 *  this is a ui-primitive class (defined in primitives.css), not a
 *  bespoke one-off. */
const STICKY_CLASS = "ui-billing-tabs-sticky";

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

function tabStrip(): HTMLElement {
  const found = container.querySelector('div[role="tablist"]');
  if (!found) throw new Error("billing tab strip not found");
  return found as HTMLElement;
}

function activeTabButton(id: string): HTMLButtonElement {
  const found = container.querySelector(`#billing-tab-${id}`);
  if (!found) throw new Error(`billing tab not found: ${id}`);
  return found as HTMLButtonElement;
}

/** The CSS declaration block for a selector, or null when absent. */
function cssRule(css: string, selector: string): string | null {
  const start = css.indexOf(selector);
  if (start === -1) return null;
  const open = css.indexOf("{", start);
  if (open === -1) return null;
  const close = css.indexOf("}", open);
  if (close === -1) return null;
  return css.slice(open + 1, close);
}

describe("Billing tab strip stays visible while scrolling (#4691 follow-up)", () => {
  it.each(EXPECTED_TABS)(
    "first paint (%s): the strip carries the sticky class and the URL tab is active",
    async (id) => {
      // A fetch that never resolves: the panel stays in its loading state.
      const hangingFetch = () => new Promise<never>(() => {});
      await renderPanelInTabHost(`/?tab=billing&view=${id}`, hangingFetch);
      const strip = tabStrip();
      expect(strip.classList.contains(STICKY_CLASS)).toBe(true);
      expect(activeTabButton(id).getAttribute("aria-selected")).toBe("true");
    },
  );

  it("full load (approved-free-quota): the strip keeps the sticky class once the long section mounts", async () => {
    await renderPanelInTabHost("/?tab=billing&view=approved-free-quota");
    const strip = tabStrip();
    expect(strip.classList.contains(STICKY_CLASS)).toBe(true);
    expect(activeTabButton("approved-free-quota").getAttribute("aria-selected")).toBe("true");
    // The section mounted below the strip after full load (its load-error
    // marker in this harness — same marker as the #4698 suite; the
    // section's data route is not stubbed here, and the strip assertion
    // is what this test pins).
    const panel = container.querySelector("#billing-panel-approved-free-quota");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("Could not load the approved-free quota.");
  });

  it("CSS: the Billing-scoped rule pins the strip (sticky, top 0, opaque background, above content)", () => {
    const css = readFileSync(PRIMITIVES_CSS, "utf8");
    const rule = cssRule(css, ".ui-tabs.ui-billing-tabs-sticky");
    expect(rule).not.toBeNull();
    expect(rule).toMatch(/position:\s*sticky/);
    expect(rule).toMatch(/top:\s*0/);
    expect(rule).toMatch(/background:\s*var\(--color-surface\)/);
    expect(rule).toMatch(/z-index:\s*10/);
  });

  it("scope: the shared .ui-tabs default is untouched and only Billing passes the sticky class", () => {
    const css = readFileSync(PRIMITIVES_CSS, "utf8");
    const baseRule = cssRule(css, ".ui-tabs {");
    expect(baseRule).not.toBeNull();
    expect(baseRule).not.toMatch(/position:/);
    // The class is applied by the Billing panel only, via the Tabs
    // className prop — the shared Tabs component hardcodes nothing.
    expect(readFileSync(PANEL_SOURCE, "utf8")).toContain(`className="${STICKY_CLASS}"`);
    expect(readFileSync(TABS_SOURCE, "utf8")).not.toContain(STICKY_CLASS);
    // The panel still mounts exactly the 10 known sub-tabs.
    expect([...BILLING_TABS]).toEqual([...EXPECTED_TABS]);
  });
});
