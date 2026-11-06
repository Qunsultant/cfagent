/** @vitest-environment jsdom */
/**
 * Issue #3523 (2.14 follow-up): the cancel UI renders outcome-catalog messages.
 *
 * The panel renders the coded message the route returns — the success message comes FROM the
 * catalog (asserted via `resolveOutcome(code).entry.businessMessage`, never a hardcoded string),
 * failures render `[CODE] message` (the #2573 error pattern), and a legacy raw error body is
 * never rendered (generic coded fallback instead). Harness follows
 * tests/checkout_ui_native_panel.test.tsx: react-dom/client in jsdom, stubbed fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CheckoutPanel } from "../src/client/CheckoutPanel";
import { CommercialApiError, subscriptionCancel } from "../src/client/commercialApi";
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

function clickButton(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === text,
  );
  if (!button) throw new Error(`No button found with text: ${text}`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function clickBodyButton(text: string) {
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === text,
  );
  if (!button) throw new Error(`No body button found with text: ${text}`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

const SUB_END_MS = Date.now() + 30 * 24 * 3600 * 1000;

function subscriptionStatusFixture() {
  const row = (id: string, providerSubscriptionId: string | null) => ({
    id,
    planId: "p1",
    status: "active",
    periodStartMs: Date.now() - 86_400_000,
    periodEndMs: SUB_END_MS,
    providerSubscriptionId,
    canceledAtMs: null,
  });
  return {
    userId: "u1",
    effectiveTier: "Subscribed",
    current: row("s1", "sub_stripe_1"),
    subscriptions: [row("s1", "sub_stripe_1"), row("s2", null)],
  };
}

/** Fetch stub for the panel's initial load + a configurable cancel response. */
function mockFetch(cancelResponse: { ok: boolean; status: number; body: unknown }) {
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/payments/agentic/commercial/pricing") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          monetizationEnabled: false,
          prices: { stock: 0.02, goal: 0.1, options: 0.05, strategy: 0.1 },
          network: { stripeMode: "unconfigured", x402Network: null, acceptsMainnet: false },
          browserPaymentScope: "card-only",
          failurePolicy: "One charge per run-request.",
        }),
      } as any;
    }
    if (url === "/api/features") {
      return { ok: true, status: 200, json: async () => ({ features: { monetization: false } }) } as any;
    }
    if (url.startsWith("/api/payments/agentic/commercial/account")) {
      return { ok: true, status: 200, json: async () => ({ tenantId: "t1", tier: "Free" }) } as any;
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
          creditsUSD: 0,
          includedRunsRemaining: 0,
        }),
      } as any;
    }
    if (url.startsWith("/api/payments/agentic/commercial/subscription?")) {
      return { ok: true, status: 200, json: async () => subscriptionStatusFixture() } as any;
    }
    if (url === "/api/payments/agentic/commercial/subscription/cancel" && method === "POST") {
      return {
        ok: cancelResponse.ok,
        status: cancelResponse.status,
        json: async () => cancelResponse.body,
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
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openSubscriptionsTab() {
  await render(<CheckoutPanel userLogin="u1" />);
  await act(async () => {
    clickButton("Subscriptions");
  });
  await flush();
}

async function confirmCancel() {
  await act(async () => {
    clickButton("Cancel subscription…");
  });
  await flush();
  await act(async () => {
    clickBodyButton("Yes, cancel subscriptions");
  });
  await flush();
}

describe("cancel UI renders catalog-coded outcomes (#3523)", () => {
  it("coded period-end success renders the catalog businessMessage + the canceled plans", async () => {
    const code = "SUCCESS_SUBSCRIPTION_CANCELED_PERIOD_END";
    const fixture = subscriptionStatusFixture();
    mockFetch({
      ok: true,
      status: 200,
      body: {
        userId: "u1",
        code,
        message: resolveOutcome(code).entry!.businessMessage,
        canceled: fixture.subscriptions,
        remaining: [],
        accessThroughMs: SUB_END_MS,
        downgradeTiming: "period_end",
      },
    });
    await openSubscriptionsTab();
    await confirmCancel();
    const text = container.textContent || "";
    // The rendered message is the catalog's businessMessage for the returned code.
    expect(text).toContain(resolveOutcome(code).entry!.businessMessage);
    // The detail names what was cancelled (plan ids) and the access-through date.
    expect(text).toContain("Canceled: p1");
    expect(text).toContain("access through");
  });

  it("coded 409 none-active renders [CODE] message, never a hand-written variant", async () => {
    const code = "FAILURE_SUBSCRIPTION_CANCEL_NONE_ACTIVE";
    mockFetch({
      ok: false,
      status: 409,
      body: { code, message: resolveOutcome(code).entry!.businessMessage, retryable: false, canceled: [], remaining: [] },
    });
    await openSubscriptionsTab();
    await confirmCancel();
    const text = container.textContent || "";
    expect(text).toContain(codedMessage(code));
    expect(text).toContain("No active subscription was found to cancel.");
  });

  it("coded 503 provider failure renders the coded failure message", async () => {
    const code = "FAILURE_SUBSCRIPTION_CANCEL_FAILED";
    mockFetch({
      ok: false,
      status: 503,
      body: {
        code,
        message: resolveOutcome(code).entry!.businessMessage,
        retryable: true,
        canceled: [],
        remaining: subscriptionStatusFixture().subscriptions,
      },
    });
    await openSubscriptionsTab();
    await confirmCancel();
    const text = container.textContent || "";
    expect(text).toContain(codedMessage(code));
    expect(text).toContain("failed partway");
  });

  it("legacy raw error body renders the generic coded fallback, never the raw string", async () => {
    mockFetch({
      ok: false,
      status: 503,
      body: { error: "Billing cancel failed: Stripe boom card_declined_internal_xyz" },
    });
    await openSubscriptionsTab();
    await confirmCancel();
    const text = container.textContent || "";
    expect(text).not.toContain("Stripe boom");
    expect(text).not.toContain("card_declined_internal_xyz");
    expect(text).toContain("The payment service is temporarily unavailable. Try again later.");
  });
});

describe("commercialApi carries catalog codes (#3523)", () => {
  it("a coded error body rejects with the code and the coded message", async () => {
    const code = "FAILURE_SUBSCRIPTION_CANCEL_NONE_ACTIVE";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ code, message: resolveOutcome(code).entry!.businessMessage }),
      })),
    );
    const err = await subscriptionCancel().catch((e) => e);
    expect(err).toBeInstanceOf(CommercialApiError);
    expect((err as CommercialApiError).status).toBe(409);
    expect((err as CommercialApiError).code).toBe(code);
    expect(err.message).toBe(codedMessage(code));
  });

  it("a legacy raw error body rejects with the fixed per-status message and no code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: "Billing cancel failed: Stripe boom" }),
      })),
    );
    const err = await subscriptionCancel().catch((e) => e);
    expect(err).toBeInstanceOf(CommercialApiError);
    expect((err as CommercialApiError).code).toBeUndefined();
    expect(err.message).toBe("The payment service is temporarily unavailable. Try again later.");
    expect(err.message).not.toContain("Stripe boom");
  });
});
