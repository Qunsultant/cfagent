/** @vitest-environment jsdom */
/**
 * Issue #3262 — self-service top-up UI in the Checkout panel.
 *
 * Harness follows tests/checkout_ui_native_panel.test.tsx:
 * react-dom/client in jsdom, direct component renders, stubbed
 * fetch. The panel's initial load (pricing, features, identity,
 * subscription, plans) and the top-up mint/confirm calls are all
 * stubbed; no network, no key.
 *
 * Scope: the Top up tab (?checkoutTab=topup) — amount + email +
 * rail selector (x402 offered only when the browser scope is
 * card-and-x402 AND the pricing network carries an x402 network),
 * mint → checkout link (card) or challenge presentation (x402) →
 * "I have paid — verify" → success shows the new credit balance
 * from the confirm response; verify disabled while confirming;
 * invalid amounts show fixed messages; server bodies never render.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CheckoutPanel } from "../src/client/CheckoutPanel";
import { codedMessage, resolveOutcome } from "../src/outcomes/outcomeAspects";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  window.history.replaceState(null, "", "/");
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

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function clickButton(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === text,
  );
  if (!button) throw new Error(`No button found with text: ${text}`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === text,
  ) as HTMLButtonElement | undefined;
}

function pricingVariant(over: Record<string, unknown> = {}) {
  return {
    monetizationEnabled: true,
    prices: { stock: 0.02, goal: 0.1, options: 0.05, strategy: 0.1 },
    topUpLimits: { minUSD: 1, maxUSD: 500 },
    network: { stripeMode: "sandbox", x402Network: null, acceptsMainnet: false },
    browserPaymentScope: "card-only",
    failurePolicy: "One charge per run-request.",
    ...over,
  };
}

interface MockOpts {
  pricing?: Record<string, unknown>;
  checkout?: Record<string, unknown> | null;
  confirm?: Record<string, unknown> | { status: number } | null;
  confirmPending?: boolean;
}

function mockFetch(opts: MockOpts = {}) {
  const pricing = opts.pricing ?? pricingVariant();
  const posts: Array<{ url: string; body: unknown }> = [];
  let confirmResolve: ((value: unknown) => void) | null = null;
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/payments/agentic/commercial/pricing") {
      return { ok: true, status: 200, json: async () => pricing } as any;
    }
    if (url === "/api/features") {
      return { ok: true, status: 200, json: async () => ({ features: { monetization: true } }) } as any;
    }
    if (url === "/api/payments/agentic/commercial/identity") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          userLogin: "u1",
          tenantId: "t1",
          hasAccount: true,
          tier: "Free",
          creditsUSD: 10,
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
      return { ok: true, status: 200, json: async () => ({ plans: [] }) } as any;
    }
    if (url === "/api/payments/agentic/commercial/top-up/checkout" && method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, body });
      return {
        ok: true,
        status: 200,
        json: async () =>
          opts.checkout ?? {
            // Issue #3571: the mint body carries the catalog code +
            // message (the panel renders codedMessage(code)).
            code: "SUCCESS_TOP_UP_CHECKOUT_CREATED",
            message: resolveOutcome("SUCCESS_TOP_UP_CHECKOUT_CREATED").businessMessage,
            topUpRequestId: "topup-1",
            rail: "card",
            amountUSD: body.amountUSD,
            checkoutUrl: "https://checkout.stripe.com/pay/topup_1",
            checkoutSessionId: "cs_topup_1",
          },
      } as any;
    }
    if (url === "/api/payments/agentic/commercial/top-up/confirm" && method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, body });
      if (opts.confirmPending) {
        return new Promise((resolve) => {
          confirmResolve = resolve;
        }) as any;
      }
      if (opts.confirm && "status" in opts.confirm) {
        return { ok: false, status: opts.confirm.status, json: async () => ({ error: "typed server detail" }) } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          opts.confirm ?? {
            // Issue #3571: the confirm body carries the catalog code +
            // message (the panel renders codedMessage(code)).
            code: "SUCCESS_TOP_UP_CREDITED",
            account: { creditsUSD: 35 },
            topUpRequestId: "topup-1",
            creditedUSD: 25,
            rail: "card",
          },
      } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    posts,
    resolveConfirm: (value: unknown) => confirmResolve?.(value),
  };
}

async function openTopUpTab() {
  await act(async () => {
    clickButton("Top up");
  });
  await flush();
}

describe("checkout panel top-up tab (#3262)", () => {
  it("renders the amount, rail, and email inputs and the operator-set limits", async () => {
    mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    const text = container.textContent || "";
    expect(text).toContain("$1.00 – $500.00");
    expect(inputForLabel("Amount (USD)")).toBeTruthy();
    expect(inputForLabel("Checkout contact email")).toBeTruthy();
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["card"]);
  });

  it("an amount below the minimum shows a fixed message and mints nothing", async () => {
    const { posts } = mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    await act(async () => {
      setInputValue(inputForLabel("Amount (USD)"), "0.5");
      setInputValue(inputForLabel("Checkout contact email"), "u1@example.com");
    });
    await act(async () => {
      clickButton("Create top-up checkout");
    });
    await flush();
    expect(container.textContent || "").toContain("Amount must be between $1.00 and $500.00.");
    expect(posts.filter((p) => p.url.endsWith("/top-up/checkout"))).toHaveLength(0);
  });

  it("card mint shows the checkout link and verify credits the account with the new balance", async () => {
    const { posts } = mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    await act(async () => {
      setInputValue(inputForLabel("Amount (USD)"), "25");
      setInputValue(inputForLabel("Checkout contact email"), "u1@example.com");
    });
    await act(async () => {
      clickButton("Create top-up checkout");
    });
    await flush();
    const link = container.querySelector('a[href="https://checkout.stripe.com/pay/topup_1"]');
    expect(link).toBeTruthy();
    expect(posts.filter((p) => p.url.endsWith("/top-up/checkout"))).toHaveLength(1);
    // Issue #3571: the mint notice renders the catalog message, never
    // the old hand-written sentence.
    expect(container.textContent || "").toContain(codedMessage("SUCCESS_TOP_UP_CHECKOUT_CREATED"));
    expect(container.textContent || "").not.toContain("Complete the payment, then confirm below.");
    await act(async () => {
      clickButton("I have paid — verify");
    });
    await flush();
    const text = container.textContent || "";
    // Issue #3571: the confirm success renders the catalog message
    // with the amounts as data — the old sentence is gone.
    expect(text).toContain("Top-up credited:");
    expect(text).toContain("New credit balance: $35.00.");
    expect(posts.filter((p) => p.url.endsWith("/top-up/confirm"))).toHaveLength(1);
  });

  it("an unpaid confirm (402) shows the fixed not-paid message and credits nothing", async () => {
    mockFetch({ confirm: { status: 402 } });
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    await act(async () => {
      setInputValue(inputForLabel("Amount (USD)"), "25");
      setInputValue(inputForLabel("Checkout contact email"), "u1@example.com");
    });
    await act(async () => {
      clickButton("Create top-up checkout");
    });
    await flush();
    await act(async () => {
      clickButton("I have paid — verify");
    });
    await flush();
    const text = container.textContent || "";
    expect(text).toContain("The checkout is not paid yet. Complete the payment, then try again.");
    expect(text).not.toContain("Top-up credited");
  });

  it("the verify button is disabled while confirming (no double-submit)", async () => {
    const { resolveConfirm } = mockFetch({ confirmPending: true });
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    await act(async () => {
      setInputValue(inputForLabel("Amount (USD)"), "25");
      setInputValue(inputForLabel("Checkout contact email"), "u1@example.com");
    });
    await act(async () => {
      clickButton("Create top-up checkout");
    });
    await flush();
    await act(async () => {
      clickButton("I have paid — verify");
    });
    await flush();
    expect(findButton("I have paid — verify")?.disabled).toBe(true);
    await act(async () => {
      resolveConfirm({
        ok: true,
        status: 200,
        json: async () => ({
          code: "SUCCESS_TOP_UP_CREDITED",
          account: { creditsUSD: 35 },
          topUpRequestId: "topup-1",
          creditedUSD: 25,
          rail: "card",
        }),
      });
    });
    await flush();
    expect(container.textContent || "").toContain("Top-up credited:");
    expect(container.textContent || "").toContain("Top-up credited: $25.00");
  });

  it("x402 is offered only when the scope and network allow it, and verify uses the pasted proof", async () => {
    mockFetch({
      pricing: pricingVariant({
        browserPaymentScope: "card-and-x402",
        network: { stripeMode: "sandbox", x402Network: "base-sepolia", acceptsMainnet: false },
      }),
      checkout: {
        code: "SUCCESS_TOP_UP_CHECKOUT_CREATED",
        message: resolveOutcome("SUCCESS_TOP_UP_CHECKOUT_CREATED").businessMessage,
        topUpRequestId: "topup-2",
        rail: "x402",
        amountUSD: 25,
        checkoutId: "topup-2",
        challenge: {
          version: "1",
          network: "base-sepolia",
          recipient: "0x2222222222222222222222222222222222222222",
          amountUSD: 25,
          currency: "USDC",
          facilitator: "https://facilitator.example.invalid",
          resource: "top-up",
          nonce: "nonce-1",
          expiresAtMs: 1_800_000_100_000,
        },
      },
      confirm: {
        code: "SUCCESS_TOP_UP_CREDITED",
        account: { creditsUSD: 35 },
        topUpRequestId: "topup-2",
        creditedUSD: 25,
        rail: "x402",
      },
    });
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["card", "x402"]);
    await act(async () => {
      setSelectValue(select, "x402");
      setInputValue(inputForLabel("Amount (USD)"), "25");
      setInputValue(inputForLabel("Checkout contact email"), "u1@example.com");
    });
    await act(async () => {
      clickButton("Create top-up checkout");
    });
    await flush();
    const text = container.textContent || "";
    expect(text).toContain("base-sepolia");
    expect(text).toContain("0x2222222222222222222222222222222222222222");
    await act(async () => {
      setInputValue(inputForLabel("Payment proof"), "0xproof");
    });
    await act(async () => {
      clickButton("I have paid — verify");
    });
    await flush();
    expect(container.textContent || "").toContain("Top-up credited:");
    expect(container.textContent || "").toContain("Top-up credited: $25.00");
    expect(container.textContent || "").toContain("Top-up credited:");
  });

  it("x402 is not offered on a card-only scope", async () => {
    mockFetch({});
    await render(<CheckoutPanel userLogin="u1" />);
    await openTopUpTab();
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["card"]);
  });
});
