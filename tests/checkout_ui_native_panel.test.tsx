/** @vitest-environment jsdom */
/**
 * Issue #2196 (sub-issue of #2012, slice 3 of #2146): the checkout
 * panel renders the SERVER-DERIVED network marker and browser scope,
 * the native failure-policy disclosure, the native card checkoutUrl,
 * and the x402 challenge flow — without hardcoding a network and
 * without inventing a link.
 *
 * Harness follows tests/approvals_panel.test.tsx: react-dom/client
 * in jsdom, direct component renders, stubbed fetch. The panel's
 * initial load (pricing, features, account, subscription, plans) and
 * the pay/subscription actions are all stubbed; no network, no key.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CheckoutPanel } from "../src/client/CheckoutPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
}

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function inputForLabel(labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find((l) =>
    (l.textContent || "").includes(labelText),
  );
  if (!label) throw new Error(`No label found for: ${labelText}`);
  const id = label.getAttribute("for") || (label as HTMLLabelElement).htmlFor;
  const input = (id ? document.getElementById(id) : label.querySelector("input")) as HTMLInputElement | null;
  if (!input) throw new Error(`No input found for label: ${labelText}`);
  return input;
}

function clickButton(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === text,
  );
  if (!button) throw new Error(`No button found with text: ${text}`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function pricingVariant(over: Record<string, unknown> = {}) {
  return {
    monetizationEnabled: false,
    prices: { stock: 0.02, goal: 0.1, options: 0.05, strategy: 0.1 },
    network: { stripeMode: "unconfigured", x402Network: null, acceptsMainnet: false },
    browserPaymentScope: "card-only",
    failurePolicy:
      "One charge per run-request. Shards, stages, retries and re-serves are free. If a paid run fails, its automatic compensation is a one-time replacement-run credit — a cash refund is never issued automatically. Cash refunds exist only as an operator-initiated action, granted only with operator approval. A payment success page is never proof of payment; payment is confirmed only by re-reading provider state.",
    ...over,
  };
}

function mockFetch(opts: {
  pricing?: Record<string, unknown>;
  submit?: Record<string, unknown>;
  checkPayment?: Record<string, unknown>;
  subscriptionCheckout?: Record<string, unknown>;
}) {
  const pricing = opts.pricing ?? pricingVariant();
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/payments/agentic/commercial/pricing") {
      return { ok: true, status: 200, json: async () => pricing } as any;
    }
    if (url === "/api/features") {
      return { ok: true, status: 200, json: async () => ({ features: { monetization: false } }) } as any;
    }
    if (url.startsWith("/api/payments/agentic/commercial/account")) {
      return { ok: true, status: 200, json: async () => ({ tenantId: "t1", tier: "Free" }) } as any;
    }
    // #2219: the panel reads the resolved identity (read-only display).
    if (url === "/api/payments/agentic/commercial/identity") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          userLogin: "u1",
          tenantId: "t1",
          hasAccount: true,
          tier: "Free",
          creditsUSD: 0,
          includedRunsRemaining: 0,
        }),
      } as any;
    }
    if (url.startsWith("/api/payments/agentic/commercial/subscription?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ userId: "u1", effectiveTier: "Free", current: null, subscriptions: [] }),
      } as any;
    }
    if (url === "/api/payments/agentic/commercial/plans") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plans: [{ id: "p1", name: "Starter", priceUSD: 5, periodDays: 30, includedRuns: 10 }],
        }),
      } as any;
    }
    if (url === "/api/payments/agentic/commercial/submit" && method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () => opts.submit ?? { runRequestId: "run-1", workflowId: "wf-1", status: "payment_started" },
      } as any;
    }
    if (url === "/api/payments/agentic/commercial/submission/check-payment" && method === "POST") {
      return { ok: true, status: 200, json: async () => opts.checkPayment ?? { runRequestId: "run-1", paid: false } } as any;
    }
    if (url === "/api/payments/agentic/commercial/subscription/checkout" && method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () =>
          opts.subscriptionCheckout ?? {
            checkoutRequestId: "sub-cs_1",
            checkoutUrl: "https://checkout.stripe.com/pay/sub_cs_1",
            checkoutSessionId: "sub_cs_1",
            plan: { id: "p1", name: "Starter", priceUSD: 5, periodDays: 30, includedRuns: 10 },
          },
      } as any;
    }
    if (url.startsWith("/api/payments/agentic/commercial/submission-status")) {
      return { ok: true, status: 200, json: async () => ({ workflowId: "wf-1", status: "running" }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function drivePayFlow() {
  await act(async () => {
    setInputValue(inputForLabel("Symbols (comma-separated, required)"), "AAPL");
  });
  await act(async () => {
    setInputValue(inputForLabel("Checkout contact email"), "u1@example.com");
  });
  await act(async () => {
    clickButton("Run for free");
  });
  await flush();
  await act(async () => {
    clickButton("I have paid — verify");
  });
  await flush();
}

describe("checkout panel native marker, scope, and disclosure (#2196)", () => {
  it("renders the derived testnet presentation, the card-only scope note, and the failure policy", async () => {
    mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    const text = container.textContent || "";
    expect(text).toContain("Test-network build");
    expect(text).toContain("Card is the browser payment rail.");
    expect(text).toContain("One charge per run-request");
    expect(text).toContain("replacement-run credit");
    expect(text).not.toContain("cfpay");
    await act(async () => {
      clickButton("Subscriptions");
    });
    await flush();
    expect(container.textContent || "").toContain("Testnet only");
  });

  it("renders the mainnet presentation and the widened scope when the server says so", async () => {
    mockFetch({
      pricing: pricingVariant({
        network: { stripeMode: "live", x402Network: "Base", acceptsMainnet: true },
        browserPaymentScope: "card-and-x402",
      }),
    });
    await render(<CheckoutPanel userLogin="u1" />);
    const text = container.textContent || "";
    expect(text).not.toContain("Test-network build");
    expect(text).toContain("Crypto (x402) is enabled for API/agent callers");
    await act(async () => {
      clickButton("Subscriptions");
    });
    await flush();
    expect(container.textContent || "").not.toContain("Testnet only");
  });
});

describe("checkout panel native payment presentation (#2196)", () => {
  it("presents the native card checkoutUrl as a link and never mentions cfpay", async () => {
    mockFetch({
      checkPayment: {
        runRequestId: "run-1",
        paid: false,
        state: "open",
        paymentUrl: "https://checkout.stripe.com/pay/cs_test_run-1",
        rail: "stripe",
      },
    });
    await render(<CheckoutPanel userLogin="u1" />);
    await drivePayFlow();
    const link = container.querySelector('a[href="https://checkout.stripe.com/pay/cs_test_run-1"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Complete payment");
    expect(container.textContent || "").toContain("native checkout link for this checkout");
    expect(container.textContent || "").not.toContain("cfpay");
  });

  it("presents the x402 challenge flow with details and no link", async () => {
    const recipient = "0x1111111111111111111111111111111111111111";
    mockFetch({
      checkPayment: {
        runRequestId: "run-1",
        paid: false,
        state: "awaiting_proof",
        paymentUrl: null,
        rail: "x402",
        challengeFlow: {
          network: "Base Sepolia",
          amountUSD: 0.02,
          currency: "USDC",
          recipient,
          note: "Crypto payments have no link: complete the 402 payment with your wallet or agent, then verify with your payment proof.",
        },
      },
    });
    await render(<CheckoutPanel userLogin="u1" />);
    await drivePayFlow();
    const text = container.textContent || "";
    expect(text).toContain("Crypto (x402) payment for this run");
    expect(text).toContain("Base Sepolia");
    expect(text).toContain(recipient);
    expect(container.querySelectorAll("a").length).toBe(0);
  });

  it("presents the native checkoutUrl for a subscription buy when the server provides one", async () => {
    mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    await act(async () => {
      clickButton("Subscriptions");
    });
    await flush();
    await act(async () => {
      setInputValue(inputForLabel("Checkout contact email"), "u1@example.com");
    });
    await act(async () => {
      clickButton("Buy");
    });
    await flush();
    const link = container.querySelector('a[href="https://checkout.stripe.com/pay/sub_cs_1"]');
    expect(link).not.toBeNull();
    expect(container.textContent || "").toContain("native checkout link for this subscription checkout");
  });
});
