/** @vitest-environment jsdom */
/**
 * Issue #3262 — top-up limits editor in the Billing servicing surface.
 *
 * TDD RED first: this suite imports src/client/billingPolicyApi.ts
 * and src/client/TopUpLimitsSection.tsx.
 *
 * Scope: an operator min/max editor over the EXISTING billing-policy
 * route only — GET billing-policy (operator-only) for values + seed
 * note, POST billing-policy (operator-only) for edits, GET operators
 * (operator-only, proves the viewer is an operator), GET pricing
 * (any verified login) so non-operators still see the current
 * limits. Edits are reflected from a FRESH policy read (never an
 * optimistic assertion). Failures render as fixed strings; server
 * error bodies are never rendered. ui primitives only.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  getBillingPolicy,
  setTopUpLimits,
  BillingPolicyApiError,
} from "../src/client/billingPolicyApi";
import { TopUpLimitsSection } from "../src/client/TopUpLimitsSection";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number) {
  return { ok: false, status, json: async () => ({ error: "typed server detail" }) };
}

interface MockState {
  minUSD: number;
  maxUSD: number;
  operatorsStatus: number;
  policyStatus: number | null;
  postStatus: number | null;
  pricingLimits: { minUSD: number; maxUSD: number } | null;
  posts: Array<{ topUpMinUSD: number; topUpMaxUSD: number }>;
}

/** Stateful mock: POST updates server state but answers STALE, so a UI
 *  that shows the new state proves it re-read (never optimistic). */
function limitsFetch(state: MockState) {
  return async (url: string, init?: RequestInit) => {
    if (url === "/api/payments/agentic/commercial/billing-policy" && (!init || init.method === undefined || init.method === "GET")) {
      if (state.policyStatus) return err(state.policyStatus);
      return ok({
        policy: { topUpMinUSD: state.minUSD, topUpMaxUSD: state.maxUSD },
        seedNote: "Values not yet edited by an operator are PROPOSED seed values pending owner approval.",
      });
    }
    if (url === "/api/payments/agentic/commercial/billing-policy" && init?.method === "POST") {
      if (state.postStatus) return err(state.postStatus);
      const body = JSON.parse(String(init.body)) as { topUpMinUSD: number; topUpMaxUSD: number };
      state.posts.push(body);
      const stale = { topUpMinUSD: state.minUSD, topUpMaxUSD: state.maxUSD };
      state.minUSD = body.topUpMinUSD;
      state.maxUSD = body.topUpMaxUSD;
      return ok({ policy: stale });
    }
    if (url === "/api/payments/agentic/commercial/operators") {
      if (state.operatorsStatus !== 200) return err(state.operatorsStatus);
      return ok({ operators: [{ login: "op1", source: "env", addedBy: null, addedAtMs: null }] });
    }
    if (url === "/api/payments/agentic/commercial/pricing") {
      return ok({
        monetizationEnabled: true,
        prices: { stock: 0.02, goal: 0.1, options: 0.05, strategy: 0.1 },
        topUpLimits: state.pricingLimits,
        network: { stripeMode: "sandbox", x402Network: null, acceptsMainnet: false },
        browserPaymentScope: "card-only",
        failurePolicy: "One charge per run-request.",
      });
    }
    return err(404);
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderSection(state: MockState) {
  vi.stubGlobal("fetch", limitsFetch(state));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(TopUpLimitsSection));
  });
  await act(async () => {});
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function inputForLabel(labelText: string): HTMLInputElement {
  const label = Array.from(container!.querySelectorAll("label")).find((l) =>
    (l.textContent || "").includes(labelText),
  );
  if (!label) throw new Error(`No label found for: ${labelText}`);
  const id = label.getAttribute("for") || (label as HTMLLabelElement).htmlFor;
  const input = (id ? document.getElementById(id) : label.querySelector("input")) as HTMLInputElement | null;
  if (!input) throw new Error(`No input found for label: ${labelText}`);
  return input;
}

function clickButton(text: string) {
  const button = Array.from(container!.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === text,
  );
  if (!button) throw new Error(`No button found with text: ${text}`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function baseState(over: Partial<MockState> = {}): MockState {
  return {
    minUSD: 1,
    maxUSD: 500,
    operatorsStatus: 200,
    policyStatus: null,
    postStatus: null,
    pricingLimits: { minUSD: 1, maxUSD: 500 },
    posts: [],
    ...over,
  };
}

describe("billing policy api (top-up limits)", () => {
  it("reads the limits and seed note from the server", async () => {
    const state = baseState();
    vi.stubGlobal("fetch", limitsFetch(state));
    const res = await getBillingPolicy();
    expect(res.limits).toEqual({ topUpMinUSD: 1, topUpMaxUSD: 500 });
    expect(res.seedNote).toContain("PROPOSED");
    vi.unstubAllGlobals();
  });

  it("posts exactly the two limits and surfaces the HTTP status on failure", async () => {
    const state = baseState({ postStatus: 403 });
    vi.stubGlobal("fetch", limitsFetch(state));
    await expect(setTopUpLimits(5, 100)).rejects.toMatchObject({ status: 403 });
    expect(state.posts).toHaveLength(0);
    expect(new BillingPolicyApiError(403).message).toContain("403");
    vi.unstubAllGlobals();
  });
});

describe("top-up limits section", () => {
  it("operator edits min/max and the section reflects the fresh read, never the stale POST answer", async () => {
    const state = baseState();
    await renderSection(state);
    expect(container!.textContent || "").toContain("Current limits: $1.00 – $500.00 per top-up.");
    await act(async () => {
      setInputValue(inputForLabel("Minimum top-up (USD)"), "5");
      setInputValue(inputForLabel("Maximum top-up (USD)"), "100");
    });
    await act(async () => {
      clickButton("Save top-up limits");
    });
    await act(async () => {});
    await act(async () => {});
    expect(state.posts).toEqual([{ topUpMinUSD: 5, topUpMaxUSD: 100 }]);
    expect(container!.textContent || "").toContain("Current limits: $5.00 – $100.00 per top-up.");
  });

  it("shows no edit controls to a non-operator; limits read-only from pricing", async () => {
    const state = baseState({ operatorsStatus: 403 });
    await renderSection(state);
    const text = container!.textContent || "";
    expect(text).toContain("Current limits: $1.00 – $500.00 per top-up.");
    expect(text).toContain("Only a store operator can change top-up limits.");
    const buttons = Array.from(container!.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons.join(" ")).not.toContain("Save top-up limits");
  });

  it("invalid limits (minimum above maximum) show a fixed message and post nothing", async () => {
    const state = baseState();
    await renderSection(state);
    await act(async () => {
      setInputValue(inputForLabel("Minimum top-up (USD)"), "600");
      setInputValue(inputForLabel("Maximum top-up (USD)"), "100");
    });
    await act(async () => {
      clickButton("Save top-up limits");
    });
    await act(async () => {});
    expect(state.posts).toHaveLength(0);
    expect(container!.textContent || "").toContain("minimum must be a positive amount no greater than the maximum");
    expect(container!.textContent || "").toContain("Current limits: $1.00 – $500.00 per top-up.");
  });

  it("renders an unconfigured policy (503) as an honest empty state, never a crash", async () => {
    const state = baseState({ policyStatus: 503, pricingLimits: null });
    await renderSection(state);
    expect(container!.textContent || "").toContain("The top-up limits are not configured yet.");
  });

  it("renders a save 403 as a fixed operator-only message with state unchanged", async () => {
    const state = baseState({ postStatus: 403 });
    await renderSection(state);
    await act(async () => {
      setInputValue(inputForLabel("Minimum top-up (USD)"), "5");
      setInputValue(inputForLabel("Maximum top-up (USD)"), "100");
    });
    await act(async () => {
      clickButton("Save top-up limits");
    });
    await act(async () => {});
    await act(async () => {});
    expect(container!.textContent || "").toContain("Only a store operator can change top-up limits.");
    expect(container!.textContent || "").toContain("Current limits: $1.00 – $500.00 per top-up.");
  });

  it("offers no top-up action", async () => {
    const state = baseState();
    await renderSection(state);
    const buttons = Array.from(container!.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons.join(" ")).not.toContain("Top up");
    expect(buttons.join(" ")).not.toContain("Create top-up checkout");
  });
});
