/** @vitest-environment jsdom */
/**
 * Issue #3246 (sub-issue of #3241), slice 2 — PlanCompare and
 * AmbientOfferCompare.
 *
 * Pins (design §9.2): render-verbatim (every number equals the
 * payload; no annual row without annualOption; held and current
 * prices carry distinct labels); unavailable targets render the
 * proposed label + price with ZERO buy buttons; the downgrade
 * group is ambient-only with the disclosure, Billing-managed
 * targets disabled with the Billing copy, and NO downgrade group
 * on interruptive triggers; mentions render verbatim or are
 * absent when null; the referral mention links to the Billing
 * tab (never the marketplace referrals tab); an ineligible
 * payload renders nothing; the ambient wrapper renders nothing
 * on any fetch failure or malformed payload.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlanCompare, AmbientOfferCompare, type PlanChoice } from "../src/client/PlanCompare";
import type { OfferPayloadView, OfferTargetView } from "../src/client/commercialApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function target(over: Partial<OfferTargetView> = {}): OfferTargetView {
  return {
    productId: "prod-basic",
    name: "Basic",
    versionId: "ver-basic-1",
    priceUSD: 49.99,
    approvalStatus: "approved",
    buyable: true,
    billingPeriod: "monthly",
    includedRuns: 20,
    periodDays: 30,
    trialDays: 7,
    features: ["Priority screening", "Email reports"],
    effectiveFromMs: 1700000000000,
    recommended: false,
    ...over,
  };
}

function payload(over: Partial<OfferPayloadView> = {}): OfferPayloadView {
  return {
    trigger: "manual_402",
    eligible: true,
    family: "stock",
    current: {
      effectiveTier: "Free",
      heldPlan: null,
      includedRunsRemaining: 0,
      packRunsRemaining: 0,
      creditsUSD: 3.5,
      freeRunsRemaining: 0,
      segment: "default",
    },
    targets: [target({ recommended: true })],
    downgradeTargets: [],
    unavailableTargets: [],
    runsPacks: [],
    mentions: { referral: null, freeAccess: null },
    perRun: { family: "stock", priceUSD: 0.02, productId: "prod-perrun-stock", versionId: "ver-pr-1" },
    topUp: { minUSD: 1, maxUSD: 500 },
    ...over,
  };
}

function heldPayload(over: Partial<OfferPayloadView> = {}): OfferPayloadView {
  const base = payload(over);
  return {
    ...base,
    current: {
      ...base.current,
      effectiveTier: "Subscribed",
      heldPlan: {
        planId: "plan-basic-1",
        productId: "prod-basic",
        name: "Basic",
        heldPriceUSD: 44.99,
        billingPeriod: "monthly",
        includedRuns: 20,
        periodEndMs: 1790000000000,
        billingManaged: false,
      },
      includedRunsRemaining: 5,
      freeRunsRemaining: null,
    },
    targets:
      over.targets ??
      [target({ productId: "prod-premium", name: "Premium", versionId: "ver-prem-1", priceUSD: 59.99, includedRuns: 30, recommended: true })],
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderCompare(p: OfferPayloadView, props: { onChoosePlan?: (c: PlanChoice) => void; onBuyCredits?: () => void } = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(PlanCompare, { payload: p, ...props }));
  });
  await act(async () => {});
}

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function text(): string {
  return container!.textContent || "";
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container!.querySelectorAll("button"));
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return buttons().filter((b) => (b.textContent || "").trim() === name);
}

describe("PlanCompare render-verbatim", () => {
  it("renders the current position and every target number exactly as the payload carries it", async () => {
    await renderCompare(heldPayload());
    expect(text()).toContain("Your price $44.99 / month");
    expect(text()).toContain("5 of 20 remaining");
    expect(text()).toContain("Credits: $3.50");
    expect(text()).toContain("$59.99 / month");
    expect(text()).toContain("30 days");
    expect(text()).toContain("7 days");
    expect(text()).toContain("Priority screening, Email reports");
    expect(text()).toContain("Recommended");
    expect(text()).toContain("$0.02 per stock run");
  });

  it("labels the held price distinctly from target prices: 'Your price' appears exactly once", async () => {
    await renderCompare(heldPayload());
    expect(text().match(/Your price/g)).toHaveLength(1);
  });

  it("renders no annual row and no annual action without annualOption", async () => {
    await renderCompare(payload());
    expect(text()).not.toContain("Annual option");
    expect(buttonsNamed("Choose annual")).toHaveLength(0);
    expect(buttonsNamed("Choose plan")).toHaveLength(1);
  });

  it("renders the annual option with its own action and savings when annualOption exists", async () => {
    const choices: PlanChoice[] = [];
    await renderCompare(
      payload({
        targets: [
          target({
            annualOption: { versionId: "ver-basic-annual", priceUSD: 509.9, savingsVsMonthlyUSD: 89.98 },
          }),
        ],
      }),
      { onChoosePlan: (c) => choices.push(c) },
    );
    expect(text()).toContain("Annual option: $509.90 per year (saves $89.98 vs monthly)");
    const annual = buttonsNamed("Choose annual");
    expect(annual).toHaveLength(1);
    await act(async () => {
      annual[0].click();
    });
    expect(choices).toEqual([
      { versionId: "ver-basic-annual", name: "Basic", priceUSD: 509.9, billingPeriod: "annual" },
    ]);
  });

  it("the primary Choose action passes the target's own version and price", async () => {
    const choices: PlanChoice[] = [];
    await renderCompare(payload(), { onChoosePlan: (c) => choices.push(c) });
    await act(async () => {
      buttonsNamed("Choose plan")[0].click();
    });
    expect(choices).toEqual([
      { versionId: "ver-basic-1", name: "Basic", priceUSD: 49.99, billingPeriod: "monthly" },
    ]);
  });

  it("renders the stacking disclosure only when a plan is held, and never says switch", async () => {
    await renderCompare(heldPayload());
    expect(text()).toContain("adds its period to your current subscription and adds its included runs");
    // The offer never frames buying as switching plans: the action
    // is Choose, and the disclosure states the stacking semantics.
    expect(text()).not.toMatch(/switch/i);
    expect(buttons().map((b) => b.textContent || "").join(" ")).not.toMatch(/switch/i);
    if (root) root.unmount();
    container!.remove();
    await renderCompare(payload());
    expect(text()).not.toContain("adds its period to your current subscription");
  });

  it("renders the Buy credits action only when top-up is available", async () => {
    await renderCompare(payload({ topUp: null }));
    expect(buttonsNamed("Buy credits")).toHaveLength(0);
    if (root) root.unmount();
    container!.remove();
    const bought: number[] = [];
    await renderCompare(payload(), { onBuyCredits: () => bought.push(1) });
    const buy = buttonsNamed("Buy credits");
    expect(buy).toHaveLength(1);
    await act(async () => {
      buy[0].click();
    });
    expect(bought).toHaveLength(1);
  });

  it("renders nothing for an ineligible payload", async () => {
    await renderCompare(payload({ eligible: false, reasonCode: "FAILURE_OFFER_NO_TARGET", targets: [] }));
    expect(text()).toBe("");
  });
});

describe("PlanCompare unavailable targets", () => {
  it("renders the proposed label + price with ZERO buy buttons", async () => {
    await renderCompare(
      payload({
        targets: [],
        unavailableTargets: [
          target({
            productId: "prod-premium",
            name: "Premium",
            versionId: "ver-prem-1",
            priceUSD: 59.99,
            approvalStatus: "proposed",
            buyable: false,
            unavailableReason: "proposed",
          }),
        ],
      }),
    );
    expect(text()).toContain("Proposed price — not yet approved, not buyable");
    expect(text()).toContain("$59.99 / month");
    expect(buttonsNamed("Choose plan")).toHaveLength(0);
    expect(buttonsNamed("Choose annual")).toHaveLength(0);
    const row = container!.querySelector('tr[aria-disabled="true"]');
    expect(row).not.toBeNull();
  });
});

describe("PlanCompare downgrade group", () => {
  const downgrade = target({
    productId: "prod-basic",
    name: "Basic",
    versionId: "ver-basic-1",
    priceUSD: 49.99,
    includedRuns: 20,
  });

  it("renders the downgrade group with the disclosure on the ambient trigger only", async () => {
    await renderCompare(
      heldPayload({ trigger: "ambient", downgradeTargets: [downgrade], targets: [] }),
    );
    expect(text()).toContain("Lower plans");
    expect(text()).toContain("starts its period when your current paid-through period ends");
    expect(text()).toContain("not canceled and is not refunded");
  });

  it("renders NO downgrade group on an interruptive trigger even when the payload carries targets", async () => {
    await renderCompare(
      heldPayload({ trigger: "manual_402", downgradeTargets: [downgrade] }),
    );
    expect(text()).not.toContain("Lower plans");
    expect(text()).not.toContain("starts its period when your current paid-through period ends");
  });

  it("disables Billing-managed downgrade targets with the Billing copy", async () => {
    await renderCompare(
      heldPayload({
        trigger: "ambient",
        downgradeTargets: [
          { ...downgrade, buyable: false, unavailableReason: "billing_managed" },
        ],
        targets: [],
      }),
    );
    expect(text()).toContain("managed through Stripe Billing");
    expect(text()).toContain("would not change that subscription");
    const choose = buttonsNamed("Choose plan");
    expect(choose).toHaveLength(1);
    expect(choose[0].disabled).toBe(true);
  });
});

describe("PlanCompare mentions", () => {
  it("renders the referral mention verbatim with a link to the Billing tab, never the referrals tab", async () => {
    await renderCompare(
      payload({
        mentions: {
          referral: {
            redeemableUSD: 1.5,
            totalEarnedUSD: 2.0,
            earnAmountUSD: 0.5,
            vestingDelayMs: 604800000,
            attributedReferrer: "referrer-1",
          },
          freeAccess: null,
        },
      }),
    );
    expect(text()).toContain("You have $1.50 in referral credit ($2.00 earned in total)");
    expect(text()).toContain("Referrals earn $0.50 per referred user");
    expect(text()).toContain("Referred by referrer-1.");
    const link = container!.querySelector('a[href="?tab=billing"]');
    expect(link).not.toBeNull();
    expect(container!.querySelector('a[href="?tab=referrals"]')).toBeNull();
    expect(container!.innerHTML).not.toContain("tab=referrals");
  });

  it("renders nothing for null mentions", async () => {
    await renderCompare(payload());
    expect(text()).not.toContain("referral credit");
    expect(text()).not.toContain("free lifetime access");
    expect(text()).not.toContain("free access");
  });

  it("renders the free-access mention for lifetime and limited grants", async () => {
    await renderCompare(payload({ mentions: { referral: null, freeAccess: { kind: "lifetime", expiresAtMs: null } } }));
    expect(text()).toContain("You have free lifetime access.");
    if (root) root.unmount();
    container!.remove();
    await renderCompare(
      payload({ mentions: { referral: null, freeAccess: { kind: "limited", expiresAtMs: 1790000000000 } } }),
    );
    expect(text()).toContain("You have free access until");
  });
});

describe("AmbientOfferCompare", () => {
  async function renderAmbient(
    fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>,
    props: { onChoosePlan?: (c: PlanChoice, shownAtMs: number) => void; onBuyCredits?: () => void } = {},
  ) {
    vi.stubGlobal("fetch", fetchImpl);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(AmbientOfferCompare, { ...props }));
    });
    await act(async () => {});
    await act(async () => {});
  }

  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const err = (status: number) => ({ ok: false, status, json: async () => ({ error: "typed" }) });

  it("fetches the ambient compare and renders the comparison", async () => {
    const urls: string[] = [];
    await renderAmbient(async (url: string) => {
      urls.push(url);
      return ok(payload({ trigger: "ambient" }));
    });
    expect(urls).toEqual(["/api/payments/agentic/commercial/offer/compare"]);
    expect(text()).toContain("Compare plans");
    expect(text()).toContain("$49.99 / month");
  });

  it("renders nothing on a fetch failure", async () => {
    await renderAmbient(async () => {
      throw new Error("network down");
    });
    expect(text()).toBe("");
  });

  it("renders nothing on a 503", async () => {
    await renderAmbient(async () => err(503));
    expect(text()).toBe("");
  });

  it("renders nothing on a malformed payload", async () => {
    await renderAmbient(async () => ok({ trigger: "ambient", eligible: true }));
    expect(text()).toBe("");
  });

  it("renders nothing on an ineligible payload", async () => {
    await renderAmbient(async () => ok(payload({ trigger: "ambient", eligible: false, targets: [] })));
    expect(text()).toBe("");
  });

  it("passes the shown instant through the Choose action", async () => {
    const seen: Array<{ choice: PlanChoice; shownAtMs: number }> = [];
    await renderAmbient(async () => ok(payload({ trigger: "ambient" })), {
      onChoosePlan: (choice, shownAtMs) => seen.push({ choice, shownAtMs }),
    });
    await act(async () => {
      buttonsNamed("Choose plan")[0].click();
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].choice.versionId).toBe("ver-basic-1");
    expect(typeof seen[0].shownAtMs).toBe("number");
    expect(seen[0].shownAtMs).toBeGreaterThan(0);
  });
});
