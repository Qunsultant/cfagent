/**
 * @vitest-environment jsdom
 *
 * Issue #3246 (sub-issue of #3241), slice 2 — CheckoutPanel offer
 * wiring: the `?plan=<versionId>&offer=<trigger>` deep-link
 * preselection, the ambient compare's Choose action, the
 * acceptance audit context on the existing mint routes, and the
 * quota-exhausted offer in the pay tab.
 *
 * Pins: preselection marks ONLY a fetched effective plan (an
 * unknown or superseded id is ignored, never highlighted);
 * acceptance calls the EXISTING mint routes with offerContext
 * present, plain checkout without it, and the context is cleared
 * after the mint (a re-mint is not from the offer); no new
 * purchase route is called; the quota-exhausted outcome surfaces
 * the upgrade offer for the submitted family.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  CheckoutPanel,
  matchPreselectedPlan,
  parseOfferTriggerParam,
} from "../src/client/CheckoutPanel";
import { resolveOutcome } from "../src/outcomes/outcomeAspects";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FAILURE_POLICY = "One charge per run-request.";

const apiState = vi.hoisted(() => ({
  submitResult: null as null | { runRequestId: string; workflowId?: string; status: string },
  submissionStatus: null as null | { workflowId: string; status: string; outcome?: string; outcomeCode?: string },
  checkoutBodies: [] as Array<Record<string, unknown>>,
  topUpBodies: [] as Array<Record<string, unknown>>,
  comparePayload: null as unknown,
  offerPayload: null as unknown,
  offerCalls: [] as Array<Record<string, unknown>>,
}));

const PLANS = [
  { id: "plan-basic", name: "Basic", priceUSD: 49.99, periodDays: 30, includedRuns: 20, trialDays: 7, features: [] },
  { id: "plan-premium", name: "Premium", priceUSD: 59.99, periodDays: 30, includedRuns: 30, trialDays: 7, features: [] },
];

function comparePayload() {
  return {
    trigger: "ambient",
    eligible: true,
    current: {
      effectiveTier: "Free",
      heldPlan: null,
      includedRunsRemaining: 0,
      packRunsRemaining: 0,
      creditsUSD: 0,
      freeRunsRemaining: 0,
      segment: "default",
    },
    targets: [
      {
        productId: "prod-premium",
        name: "Premium",
        versionId: "plan-premium",
        priceUSD: 59.99,
        approvalStatus: "approved",
        buyable: true,
        billingPeriod: "monthly",
        includedRuns: 30,
        periodDays: 30,
        trialDays: 7,
        features: [],
        effectiveFromMs: 1700000000000,
        recommended: true,
      },
      {
        productId: "prod-stale",
        name: "Stale",
        versionId: "plan-stale",
        priceUSD: 99.99,
        approvalStatus: "approved",
        buyable: true,
        billingPeriod: "monthly",
        includedRuns: 99,
        periodDays: 30,
        trialDays: null,
        features: [],
        effectiveFromMs: 1700000000000,
        recommended: false,
      },
    ],
    downgradeTargets: [],
    unavailableTargets: [],
    runsPacks: [],
    mentions: { referral: null, freeAccess: null },
    perRun: null,
    topUp: null,
  };
}

vi.mock("../src/client/commercialApi", () => ({
  CommercialApiError: class extends Error {
    readonly status: number;
    constructor(status: number) {
      super(`commercial api error ${status}`);
      this.status = status;
    }
  },
  buildGoalCommand: async () => ({ screenerCommand: { jobId: "job-1" } }),
  buildNonGoalCommand: (jobId: string, family: string, symbols: string[]) => ({
    jobId,
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    role: "parent",
    shards: [{ shardId: family, symbols }],
  }),
  checkPayment: async () => ({ runRequestId: "run-1", paid: false, state: "pending" }),
  formatPeriodEnd: (ms: number | null | undefined) => (ms ? String(ms) : "—"),
  formatUSD: (value: number) => `$${value.toFixed(2)}`,
  getFeatures: async () => ({ features: { monetization: true } }),
  getIdentity: async () => ({
    userLogin: "u1",
    tenantId: "t1",
    hasAccount: true,
    tier: "Free",
    creditsUSD: 0,
    includedRunsRemaining: 0,
  }),
  getOfferCompare: async () => {
    if (apiState.comparePayload === null) throw new Error("no compare");
    return apiState.comparePayload;
  },
  getPricing: async () => ({
    monetizationEnabled: true,
    prices: { stock: 0.1, goal: 0.1, options: 0.1, strategy: 0.1 },
    network: { stripeMode: "sandbox", x402Network: "base-sepolia", acceptsMainnet: false },
    browserPaymentScope: "card-only",
    failurePolicy: FAILURE_POLICY,
    topUpLimits: { minUSD: 1, maxUSD: 500 },
  }),
  getSubmissionStatus: async (workflowId: string) =>
    apiState.submissionStatus ?? { workflowId, status: "running" },
  getSubscriptionStatus: async () => ({
    userId: "u1",
    effectiveTier: "Free",
    current: null,
    subscriptions: [],
  }),
  isOfferPayloadView: (v: unknown) =>
    !!v &&
    typeof v === "object" &&
    typeof (v as { eligible: unknown }).eligible === "boolean" &&
    Array.isArray((v as { targets: unknown }).targets) &&
    !!(v as { current: unknown }).current,
  isOfferTrigger: (v: unknown) =>
    ["manual_402", "skip_notice", "trial_end", "quota_exhausted", "ambient"].includes(v as string),
  listPlans: async () => ({ plans: PLANS }),
  parseSymbols: (input: string) => input.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  postOffer: async (body: Record<string, unknown>) => {
    apiState.offerCalls.push(body);
    if (apiState.offerPayload === null) throw new Error("no offer");
    return apiState.offerPayload;
  },
  postOfferDismiss: async () => ({ suppressedUntilMs: 123 }),
  submitRun: async () =>
    apiState.submitResult ?? { runRequestId: "run-1", status: "payment_started", workflowId: "run-1" },
  subscriptionCancel: async () => ({ userId: "u1", canceled: [], accessThroughMs: null }),
  subscriptionCheckout: async (body: Record<string, unknown>) => {
    apiState.checkoutBodies.push(body);
    return { checkoutRequestId: "sub-1", checkoutUrl: "https://x", checkoutSessionId: "s1", plan: PLANS[0] };
  },
  subscriptionPurchase: async () => ({ subscription: null, account: null, effectiveTier: "Subscribed" }),
  topUpCheckout: async (body: Record<string, unknown>) => {
    apiState.topUpBodies.push(body);
    return { topUpRequestId: "t1", rail: "card" };
  },
  topUpConfirm: async () => ({ creditedUSD: 10, account: { creditsUSD: 10 } }),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function renderPanel(url: string) {
  window.history.pushState({}, "", url);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<CheckoutPanel userLogin="u1" />);
  });
  await flush();
  return container;
}

function inputForLabel(labelText: string): HTMLInputElement {
  const label = [...container!.querySelectorAll("label")].find((l) =>
    (l.textContent ?? "").includes(labelText),
  );
  expect(label, `label "${labelText}"`).toBeDefined();
  const input = document.getElementById(label!.htmlFor) as HTMLInputElement | null;
  expect(input, `input for "${labelText}"`).not.toBeNull();
  return input!;
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonsNamed(text: string): HTMLButtonElement[] {
  return [...container!.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === text);
}

function buttonWith(text: string): HTMLButtonElement {
  const button = [...container!.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(text),
  );
  expect(button, `button "${text}"`).toBeDefined();
  return button!;
}

beforeEach(() => {
  apiState.submitResult = null;
  apiState.submissionStatus = null;
  apiState.checkoutBodies = [];
  apiState.topUpBodies = [];
  apiState.comparePayload = null;
  apiState.offerPayload = null;
  apiState.offerCalls = [];
  window.history.pushState({}, "", "/");
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  window.history.pushState({}, "", "/");
});

describe("offer deep-link helpers", () => {
  it("matchPreselectedPlan matches only a fetched plan id", () => {
    expect(matchPreselectedPlan(PLANS as never, "plan-premium")?.id).toBe("plan-premium");
    expect(matchPreselectedPlan(PLANS as never, "plan-nope")).toBeNull();
    expect(matchPreselectedPlan(PLANS as never, null)).toBeNull();
    expect(matchPreselectedPlan(PLANS as never, "")).toBeNull();
  });

  it("parseOfferTriggerParam accepts only known triggers", () => {
    expect(parseOfferTriggerParam("manual_402")).toBe("manual_402");
    expect(parseOfferTriggerParam("ambient")).toBe("ambient");
    expect(parseOfferTriggerParam("bogus")).toBeNull();
    expect(parseOfferTriggerParam(null)).toBeNull();
  });
});

describe("offer deep-link preselection", () => {
  it("marks the matching fetched plan and carries the trigger on the next mint only", async () => {
    const el = await renderPanel(
      "/?tab=checkout&checkoutTab=subscriptions&plan=plan-premium&offer=manual_402",
    );
    expect(el.textContent).toContain("Selected from your plan comparison");
    setInput(inputForLabel("Checkout contact email"), "u1@example.com");
    const buys = buttonsNamed("Buy");
    expect(buys).toHaveLength(2);
    act(() => buys[1].click());
    await flush();
    expect(apiState.checkoutBodies).toHaveLength(1);
    expect(apiState.checkoutBodies[0]).toMatchObject({
      planId: "plan-premium",
      offerContext: { trigger: "manual_402" },
    });
    expect(apiState.checkoutBodies[0].offerContext).not.toHaveProperty("shownAtMs");
    // A re-mint is not from the offer: the context is cleared.
    act(() => buttonsNamed("Buy")[0].click());
    await flush();
    expect(apiState.checkoutBodies).toHaveLength(2);
    expect(apiState.checkoutBodies[1]).not.toHaveProperty("offerContext");
    expect(el.textContent).not.toContain("Selected from your plan comparison");
  });

  it("ignores an unknown plan id: no marker, but the valid trigger still rides the mint", async () => {
    const el = await renderPanel(
      "/?tab=checkout&checkoutTab=subscriptions&plan=plan-nope&offer=trial_end",
    );
    expect(el.textContent).not.toContain("Selected from your plan comparison");
    setInput(inputForLabel("Checkout contact email"), "u1@example.com");
    act(() => buttonsNamed("Buy")[0].click());
    await flush();
    expect(apiState.checkoutBodies).toHaveLength(1);
    expect(apiState.checkoutBodies[0]).toMatchObject({ offerContext: { trigger: "trial_end" } });
  });

  it("ignores an unknown trigger: no context on the mint", async () => {
    await renderPanel("/?tab=checkout&checkoutTab=subscriptions&plan=plan-basic&offer=bogus");
    setInput(inputForLabel("Checkout contact email"), "u1@example.com");
    act(() => buttonsNamed("Buy")[0].click());
    await flush();
    expect(apiState.checkoutBodies).toHaveLength(1);
    expect(apiState.checkoutBodies[0]).not.toHaveProperty("offerContext");
  });

  it("plain checkout sends no offerContext", async () => {
    await renderPanel("/?tab=checkout&checkoutTab=subscriptions");
    setInput(inputForLabel("Checkout contact email"), "u1@example.com");
    act(() => buttonsNamed("Buy")[0].click());
    await flush();
    expect(apiState.checkoutBodies).toHaveLength(1);
    expect(apiState.checkoutBodies[0]).toEqual({ planId: "plan-basic", email: "u1@example.com" });
  });
});

describe("ambient compare actions", () => {
  it("choosing a plan in the compare marks the row and records the shown instant for the mint", async () => {
    apiState.comparePayload = comparePayload();
    const el = await renderPanel("/?tab=checkout&checkoutTab=subscriptions");
    expect(el.textContent).toContain("Compare plans");
    const chooses = buttonsNamed("Choose plan");
    expect(chooses).toHaveLength(2);
    act(() => chooses[0].click());
    await flush();
    expect(el.textContent).toContain("Selected from your plan comparison");
    setInput(inputForLabel("Checkout contact email"), "u1@example.com");
    act(() => buttonsNamed("Buy")[1].click());
    await flush();
    expect(apiState.checkoutBodies).toHaveLength(1);
    expect(apiState.checkoutBodies[0]).toMatchObject({
      planId: "plan-premium",
      offerContext: { trigger: "ambient" },
    });
    const ctx = apiState.checkoutBodies[0].offerContext as { shownAtMs: unknown };
    expect(typeof ctx.shownAtMs).toBe("number");
    expect(ctx.shownAtMs as number).toBeGreaterThan(0);
  });

  it("choosing a version that matches no fetched plan marks nothing and records nothing", async () => {
    apiState.comparePayload = comparePayload();
    const el = await renderPanel("/?tab=checkout&checkoutTab=subscriptions");
    const chooses = buttonsNamed("Choose plan");
    act(() => chooses[1].click());
    await flush();
    expect(el.textContent).not.toContain("Selected from your plan comparison");
    setInput(inputForLabel("Checkout contact email"), "u1@example.com");
    act(() => buttonsNamed("Buy")[0].click());
    await flush();
    expect(apiState.checkoutBodies).toHaveLength(1);
    expect(apiState.checkoutBodies[0]).not.toHaveProperty("offerContext");
  });

  it("a failed compare fetch leaves the subscriptions tab working", async () => {
    const el = await renderPanel("/?tab=checkout&checkoutTab=subscriptions");
    expect(el.textContent).not.toContain("Compare plans");
    expect(buttonsNamed("Buy")).toHaveLength(2);
  });
});

describe("quota-exhausted offer", () => {
  it("surfaces the upgrade offer for the submitted family when the poller sees quota_exhausted", async () => {
    apiState.submitResult = { runRequestId: "run-1", workflowId: "run-1", status: "payment_started" };
    apiState.submissionStatus = {
      workflowId: "run-1",
      status: "complete",
      outcome: "quota_exhausted",
      outcomeCode: "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED",
    };
    apiState.offerPayload = { ...comparePayload(), trigger: "quota_exhausted" };
    const el = await renderPanel("/?tab=checkout&checkoutTab=pay");
    setInput(inputForLabel("Symbols"), "AAPL");
    setInput(inputForLabel("Checkout contact email"), "u1@example.com");
    const authorize = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    act(() => authorize!.click());
    act(() => buttonWith("Pay $0.10 and run").click());
    await flush();
    await flush();
    expect(apiState.offerCalls).toHaveLength(1);
    expect(apiState.offerCalls[0]).toMatchObject({ trigger: "quota_exhausted", family: "stock" });
    expect(el.textContent).toContain(
      resolveOutcome("FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED").businessMessage,
    );
    expect(el.textContent).toContain("Compare plans");
    expect(buttonsNamed("Not now")).toHaveLength(1);
    expect(el.textContent).not.toContain("Workflow status: running");
  });
});
