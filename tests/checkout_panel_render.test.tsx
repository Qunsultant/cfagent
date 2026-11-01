/**
 * @vitest-environment jsdom
 *
 * Issue #2137 (checkout follow-ups): real render tests for the
 * merged checkout UI (CheckoutPanel — pay-per-run panel +
 * subscription panel), rendered with react-dom, not stub
 * assertions on source text.
 *
 * The commercialApi module is mocked at the network boundary
 * only (the panel's own logic — tabs, flag states, submit
 * outcomes, disclosure placement — runs for real). Covered:
 * panel renders with both tabs; the failure-policy disclosure
 * is visible BEFORE any payment; flag-OFF shows the free state
 * and no charge UI; a covered (failure-credit) submission shows
 * the no-charge outcome; a payment-required submission shows
 * the payment-started outcome with the verify step; the
 * subscription panel renders its no-auto-renew notice and plan
 * state.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CheckoutPanel } from "../src/client/CheckoutPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FAILURE_POLICY =
  "One charge per run-request. Shards, stages, retries and re-serves are free. If a paid run fails, its automatic compensation is a one-time replacement-run credit — a cash refund is never issued automatically. Cash refunds exist only as an operator-initiated action, granted only with operator approval.";

const apiState = vi.hoisted(() => ({
  monetizationEnabled: true,
  flagOn: true,
  submitResult: null as null | {
    runRequestId: string;
    workflowId?: string;
    status: string;
    creditRunId?: string;
  },
  submitBody: null as null | Record<string, unknown>,
}));

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
  getAccount: async () => ({ tenantId: "t1", tier: "Free", creditsUSD: 0, includedRunsRemaining: 0 }),
  // #2219: the panel displays the resolved identity read-only.
  getIdentity: async () => ({
    userLogin: "u1",
    tenantId: "t1",
    hasAccount: true,
    tier: "Free",
    creditsUSD: 0,
    includedRunsRemaining: 0,
  }),
  getFeatures: async () => ({ features: { monetization: apiState.flagOn } }),
  getPricing: async () => ({
    monetizationEnabled: apiState.monetizationEnabled,
    prices: { stock: 0.1, goal: 0.1, options: 0.1, strategy: 0.1 },
    // Reconciliation for the #2196 slice (stacked rebuild): the Pricing
    // shape no longer carries testnetOnly; the panel reads the derived
    // network marker. Testnet semantics preserved: sandbox, no mainnet.
    network: { stripeMode: "sandbox", x402Network: "base-sepolia", acceptsMainnet: false },
    browserPaymentScope: "card-only",
    failurePolicy: FAILURE_POLICY,
  }),
  getSubmissionStatus: async (workflowId: string) => ({ workflowId, status: "running" }),
  getSubscriptionStatus: async () => ({
    userId: "u1",
    effectiveTier: "Free",
    current: null,
    subscriptions: [],
  }),
  listPlans: async () => ({ plans: [] }),
  parseSymbols: (input: string) => input.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  submitRun: async (body: Record<string, unknown>) => {
    apiState.submitBody = body;
    return apiState.submitResult ?? { runRequestId: "run-1", status: "payment_started", workflowId: "run-1" };
  },
  subscriptionCancel: async () => ({ userId: "u1", canceled: [], accessThroughMs: null }),
  subscriptionCheckout: async () => ({ checkoutRequestId: "sub-1", checkout: {}, plan: null }),
  subscriptionPurchase: async () => ({ subscription: null, account: null, effectiveTier: "Subscribed" }),
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

async function renderPanel() {
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

function buttonWith(text: string): HTMLButtonElement {
  const button = [...container!.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(text),
  );
  expect(button, `button "${text}"`).toBeDefined();
  return button!;
}

function tabWith(text: string): HTMLButtonElement {
  const tab = [...container!.querySelectorAll('[role="tab"]')].find((t) =>
    (t.textContent ?? "").includes(text),
  );
  expect(tab, `tab "${text}"`).toBeDefined();
  return tab as HTMLButtonElement;
}

beforeEach(() => {
  apiState.monetizationEnabled = true;
  apiState.flagOn = true;
  apiState.submitResult = null;
  apiState.submitBody = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("checkout panel render (#2137)", () => {
  it("renders the pay-per-run panel with both tabs and the failure-policy disclosure before payment", async () => {
    const el = await renderPanel();
    expect(el.querySelector("h1")?.textContent).toBe("Checkout");
    expect(tabWith("Pay per run")).toBeDefined();
    expect(tabWith("Subscriptions")).toBeDefined();
    // Disclosure is on screen before any submit or payment.
    expect(el.textContent).toContain(FAILURE_POLICY);
    expect(el.textContent).toContain("Price per run-request:");
    // Nothing has been submitted yet: no outcome card.
    expect(el.textContent).not.toContain("Payment workflow started");
    expect(el.textContent).not.toContain("failure credit covered this run");
  });

  it("flag-OFF shows the free state and no charge UI", async () => {
    apiState.monetizationEnabled = false;
    apiState.flagOn = false;
    const el = await renderPanel();
    expect(el.textContent).toContain("Payments are currently off — runs submitted here are free.");
    expect(buttonWith("Run for free")).toBeDefined();
    expect(el.textContent).not.toContain("I authorize this charge");
    expect(el.textContent).not.toContain("Pay $");
    // The disclosure still shows: policy copy is not gated on the flag.
    expect(el.textContent).toContain(FAILURE_POLICY);
  });

  it("a failure-credit submission shows the covered (no-charge) outcome", async () => {
    apiState.submitResult = {
      runRequestId: "run-9",
      workflowId: "screen-1",
      status: "redeemed_started",
      creditRunId: "run-8",
    };
    const el = await renderPanel();
    setInput(inputForLabel("Symbols"), "AAPL");
    setInput(inputForLabel("Checkout contact email"), "u1@example.com");
    const authorize = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(authorize, "authorize checkbox").not.toBeNull();
    act(() => authorize!.click());
    act(() => buttonWith("Pay $0.10 and run").click());
    await flush();
    expect(apiState.submitBody).toMatchObject({
      email: "u1@example.com",
      authorizedAtSubmission: true,
    });
    // #2219: the client sends no tenantId; the server derives the tenant
    // from the resolved identity (a client value is never trusted).
    expect(apiState.submitBody).not.toHaveProperty("tenantId");
    expect(el.textContent).toContain("A failure credit covered this run — no charge.");
    expect(el.textContent).toContain("Credit run: run-8");
    expect(el.textContent).not.toContain("Payment workflow started");
  });

  it("a payment-required submission shows the payment-started outcome with the verify step", async () => {
    apiState.submitResult = { runRequestId: "run-1", workflowId: "run-1", status: "payment_started" };
    const el = await renderPanel();
    setInput(inputForLabel("Symbols"), "AAPL");
    setInput(inputForLabel("Checkout contact email"), "u1@example.com");
    const authorize = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    act(() => authorize!.click());
    act(() => buttonWith("Pay $0.10 and run").click());
    await flush();
    expect(el.textContent).toContain("Payment workflow started");
    expect(el.textContent).toContain("Run request: run-1");
    expect(buttonWith("I have paid — verify")).toBeDefined();
    expect(el.textContent).toContain("Workflow status: running");
  });

  it("the subscription panel renders its no-auto-renew notice and plan state", async () => {
    const el = await renderPanel();
    act(() => tabWith("Subscriptions").click());
    await flush();
    expect(el.textContent).toContain("Subscriptions do not auto-renew");
    expect(el.textContent).toContain("effective tier:");
    expect(el.textContent).toContain("No plans available");
  });
});
