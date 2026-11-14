/** @vitest-environment jsdom */
/**
 * Issue #3239: the stock-hub new-screen run under monetization ON.
 * The run must go through the payment workflow (async submission with
 * a checkout email) and a 402 must never surface as a raw server code.
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { StockHub } from "../src/client/StockHub";
import {
  resetTenantProvidersStateForTest,
  setTenantProvidersStateForTest,
} from "../src/client/tenantProviders";

let container: HTMLDivElement;
let root: Root;
const realFetch = globalThis.fetch;

type ScreenStub = (body: Record<string, unknown>) => Response;

function installFetch(opts: {
  monetization: boolean | "fail";
  screen: ScreenStub;
  /** Issue #2373 (S1b): the offer-compare payload for the free-run balance line, or undefined for the default `{}`. */
  offerCompare?: Record<string, unknown>;
}): { screenBodies: Array<Record<string, unknown>> } {
  const screenBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/payments/agentic/commercial/pricing")) {
      if (opts.monetization === "fail") return new Response("not found", { status: 404 });
      return Response.json({ monetizationEnabled: opts.monetization });
    }
    if (url.includes("/offer/compare")) {
      return Response.json(opts.offerCompare ?? {});
    }
    if (url.includes("/api/etrade/screen")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      screenBodies.push(body);
      return opts.screen(body);
    }
    if (url.includes("/api/screener/latest")) return Response.json({ runs: [] });
    return Response.json({});
  }) as typeof fetch;
  return { screenBodies };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renderNewScreen() {
  await act(async () => {
    root.render(<StockHub activeEnv="PROD" userLogin="tester" initialTab="new-screen" />);
  });
  await flush();
  await flush();
}

async function submitForm() {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.includes("Run stock screen"),
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await flush();
  await flush();
  await flush();
}

beforeEach(() => {
  // Issue #4430 (S1a): these tests exercise the paid run through the
  // hub's screen endpoint, so they run under a hub-variant tenant
  // provider (etrade -> the "etrade" variant the fetch stub serves).
  // A no-variant tenant (the platform default, alpaca) resolves to no
  // selection and the run is blocked before any POST — the paid-flow
  // paths would never be exercised.
  setTenantProvidersStateForTest({ dataProviderId: "etrade" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  globalThis.fetch = realFetch;
  resetTenantProvidersStateForTest();
  vi.restoreAllMocks();
});

describe("stock-hub new-screen paid run (#3239)", () => {
  it("sends async + checkout email and shows payment state on 202 payment_started", async () => {
    installFetch({
      monetization: true,
      screen: () =>
        Response.json(
          { status: "payment_started", runRequestId: "req-1", workflowId: "wf-1" },
          { status: 202 },
        ),
    });
    await renderNewScreen();
    const checkout = container.querySelector(
      'input[placeholder="Payment contact email"]',
    ) as HTMLInputElement | null;
    expect(checkout).not.toBeNull();
    setInputValue(checkout!, "buyer@firm.com");
    await submitForm();
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const screenCall = calls.find((c) => String(c[0]).includes("/api/etrade/screen"));
    expect(screenCall).toBeDefined();
    const sent = JSON.parse(String(screenCall![1]?.body ?? "{}")) as Record<string, unknown>;
    expect(sent.async).toBe(true);
    expect(sent.email).toBe("buyer@firm.com");
    expect(container.textContent).toContain("req-1");
    expect(container.textContent).toContain("Payment started");
    expect(container.textContent).not.toContain("payment_started");
  });

  it("maps a 402 to a payment message with a retry action, never the raw code", async () => {
    installFetch({
      monetization: "fail",
      screen: (body) =>
        body.async === true
          ? Response.json(
              { status: "payment_started", runRequestId: "req-2", workflowId: "wf-2" },
              { status: 202 },
            )
          : Response.json(
              {
                error: "monetization_enabled_workflow_required",
                detail: "Monetization is on: stock screens must go through the payment workflow.",
              },
              { status: 402 },
            ),
    });
    await renderNewScreen();
    await submitForm();
    expect(container.textContent).not.toContain("monetization_enabled_workflow_required");
    expect(container.textContent).toMatch(/payment workflow/i);
    const retry = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Start payment workflow"),
    );
    expect(retry).toBeDefined();
    const checkout = container.querySelector(
      'input[placeholder="Payment contact email"]',
    ) as HTMLInputElement | null;
    expect(checkout).not.toBeNull();
    setInputValue(checkout!, "buyer@firm.com");
    await act(async () => {
      retry!.click();
    });
    await flush();
    await flush();
    await flush();
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const screenCalls = calls.filter((c) => String(c[0]).includes("/api/etrade/screen"));
    const paidCall = screenCalls[screenCalls.length - 1];
    const sent = JSON.parse(String(paidCall![1]?.body ?? "{}")) as Record<string, unknown>;
    expect(sent.async).toBe(true);
    expect(sent.email).toBe("buyer@firm.com");
    expect(container.textContent).toContain("req-2");
    expect(container.textContent).toContain("Payment started");
  });

  it("keeps the sync run unchanged when monetization is OFF", async () => {
    installFetch({
      monetization: false,
      screen: () =>
        Response.json({ stocks: [], totalScanned: 0, matchedCount: 0, scannedAt: new Date().toISOString() }),
    });
    await renderNewScreen();
    expect(
      container.querySelector('input[placeholder="Payment contact email"]'),
    ).toBeNull();
    await submitForm();
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const screenCall = calls.find((c) => String(c[0]).includes("/api/etrade/screen"));
    expect(screenCall).toBeDefined();
    const sent = JSON.parse(String(screenCall![1]?.body ?? "{}")) as Record<string, unknown>;
    expect("async" in sent).toBe(false);
    expect("email" in sent).toBe(false);
    expect(container.textContent).not.toContain("Payment started");
  });
});

describe("stock-hub new-screen paid run, gate-before-email (#2373 S1b)", () => {
  it("runs with NO email when monetization is ON — the gate decides coverage first, and a covered run starts", async () => {
    const { screenBodies } = installFetch({
      monetization: true,
      screen: () =>
        Response.json(
          { status: "payment_started", runRequestId: "req-9", workflowId: "wf-9" },
          { status: 202 },
        ),
    });
    await renderNewScreen();
    // No email filled: the run must still go out (async, no email),
    // and the 202 payment state shows — the client never blocks on
    // a checkout email the gate has not asked for.
    await submitForm();
    expect(screenBodies).toHaveLength(1);
    expect(screenBodies[0].async).toBe(true);
    expect("email" in screenBodies[0]).toBe(false);
    expect(container.textContent).toContain("req-9");
    expect(container.textContent).toContain("Payment started");
  });

  it("a 400 checkout_email_required shows the email prompt and the checkout input (the gate asked for payment)", async () => {
    installFetch({
      monetization: true,
      screen: () =>
        Response.json(
          {
            error: "email (checkout contact) is required when monetization is on.",
            code: "checkout_email_required",
          },
          { status: 400 },
        ),
    });
    await renderNewScreen();
    await submitForm();
    expect(container.textContent).toMatch(/Enter a checkout email/i);
    expect(
      container.querySelector('input[placeholder="Payment contact email"]'),
    ).not.toBeNull();
    const retry = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Start payment workflow"),
    );
    expect(retry).toBeDefined();
  });

  it("shows the remaining free runs while monetization is on", async () => {
    installFetch({
      monetization: true,
      screen: () =>
        Response.json(
          { status: "payment_started", runRequestId: "req-10", workflowId: "wf-10" },
          { status: 202 },
        ),
      offerCompare: {
        trigger: "ambient",
        eligible: true,
        current: {
          effectiveTier: "Free",
          heldPlan: null,
          includedRunsRemaining: 0,
          packRunsRemaining: 0,
          creditsUSD: 0,
          freeRunsRemaining: 7,
          segment: "default",
        },
        targets: [],
        downgradeTargets: [],
        unavailableTargets: [],
        runsPacks: [],
        mentions: { referral: null, freeAccess: null },
        perRun: null,
        topUp: null,
      },
    });
    await renderNewScreen();
    expect(container.textContent).toContain("7 free runs remaining this month");
  });

  it("hides the free-run line when the compare read fails", async () => {
    installFetch({
      monetization: true,
      screen: () =>
        Response.json(
          { status: "payment_started", runRequestId: "req-11", workflowId: "wf-11" },
          { status: 202 },
        ),
    });
    await renderNewScreen();
    expect(container.textContent).not.toContain("free runs remaining this month");
  });
});
