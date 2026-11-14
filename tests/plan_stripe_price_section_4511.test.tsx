/** @vitest-environment jsdom */
/**
 * Issue #4511 — operator UI to map a plan to its Stripe Price id
 * (stripePriceByPlan) in the Billing servicing surface.
 *
 * TDD RED first: this suite imports src/client/billingPolicyApi.ts
 * (getStripePriceByPlan / setStripePriceByPlan) and
 * src/client/PlanStripePriceSection.tsx.
 *
 * Scope: an operator mapping editor over the EXISTING billing-policy
 * route only — GET billing-policy (operator-only) for the mapping +
 * seed note, POST billing-policy (operator-only) for edits (the whole
 * stripePriceByPlan block is replaced on update, the same wholesale
 * discipline as offerRules), GET plans for the plan list, GET operators
 * (operator-only, proves the viewer is an operator). Edits are
 * reflected from a FRESH policy read (never an optimistic assertion).
 * Failures render as fixed strings; server error bodies are never
 * rendered. The checkout reads stripePriceByPlan[plan.id] only — this
 * UI is the only operator path to set it. ui primitives only.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  getStripePriceByPlan,
  setStripePriceByPlan,
  BillingPolicyApiError,
} from "../src/client/billingPolicyApi";
import { PlanStripePriceSection } from "../src/client/PlanStripePriceSection";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number) {
  return { ok: false, status, json: async () => ({ error: "typed server detail" }) };
}

interface MockState {
  mapping: Record<string, string>;
  plans: Array<{ id: string; name: string; priceUSD: number; periodDays: number; includedRuns: number }>;
  operatorsStatus: number;
  policyStatus: number | null;
  postStatus: number | null;
  plansStatus: number | null;
  posts: Array<Record<string, string>>;
}

/** Stateful mock: POST updates server state but answers STALE, so a UI
 *  that shows the new state proves it re-read (never optimistic). */
function mappingFetch(state: MockState) {
  return async (url: string, init?: RequestInit) => {
    if (
      url === "/api/payments/agentic/commercial/billing-policy" &&
      (!init || init.method === undefined || init.method === "GET")
    ) {
      if (state.policyStatus) return err(state.policyStatus);
      return ok({
        policy: { stripePriceByPlan: { ...state.mapping } },
        seedNote: "Values not yet edited by an operator are PROPOSED seed values pending owner approval.",
      });
    }
    if (url === "/api/payments/agentic/commercial/billing-policy" && init?.method === "POST") {
      if (state.postStatus) return err(state.postStatus);
      const body = JSON.parse(String(init.body)) as { stripePriceByPlan: Record<string, string> };
      state.posts.push({ ...body.stripePriceByPlan });
      const stale = { ...state.mapping };
      state.mapping = { ...body.stripePriceByPlan };
      return ok({ policy: { stripePriceByPlan: stale } });
    }
    if (url === "/api/payments/agentic/commercial/plans") {
      if (state.plansStatus) return err(state.plansStatus);
      return ok({ plans: state.plans });
    }
    if (url === "/api/payments/agentic/commercial/operators") {
      if (state.operatorsStatus !== 200) return err(state.operatorsStatus);
      return ok({ operators: [{ login: "op1", source: "env", addedBy: null, addedAtMs: null }] });
    }
    return err(404);
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderSection(state: MockState) {
  vi.stubGlobal("fetch", mappingFetch(state));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(PlanStripePriceSection));
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
  const input = id
    ? (container!.querySelector(`#${id}`) as HTMLInputElement | null)
    : (label.querySelector("input") as HTMLInputElement | null);
  if (!input) throw new Error(`No input found for label: ${labelText}`);
  return input;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container!.querySelectorAll("button")).find((b) =>
    (b.textContent || "").includes(text),
  );
  if (!button) throw new Error(`No button found with text: ${text}`);
  return button as HTMLButtonElement;
}

function text(): string {
  return container!.textContent || "";
}

const basePlans = [
  { id: "plan-test-subs", name: "Test-Subs", priceUSD: 1, periodDays: 30, includedRuns: 0 },
  { id: "plan-basic", name: "Basic", priceUSD: 49.99, periodDays: 30, includedRuns: 10 },
];

function baseState(overrides: Partial<MockState> = {}): MockState {
  return {
    mapping: { "plan-basic": "price_basic_live" },
    plans: basePlans,
    operatorsStatus: 200,
    policyStatus: null,
    postStatus: null,
    plansStatus: null,
    posts: [],
    ...overrides,
  };
}

describe("billingPolicyApi stripePriceByPlan (#4511)", () => {
  it("getStripePriceByPlan returns the mapping plus the seed note", async () => {
    const state = baseState();
    vi.stubGlobal("fetch", mappingFetch(state));
    const result = await getStripePriceByPlan();
    expect(result.stripePriceByPlan).toEqual({ "plan-basic": "price_basic_live" });
    expect(result.seedNote).toContain("PROPOSED");
    vi.unstubAllGlobals();
  });

  it("setStripePriceByPlan posts the whole mapping wholesale", async () => {
    const state = baseState();
    vi.stubGlobal("fetch", mappingFetch(state));
    const result = await setStripePriceByPlan({
      "plan-basic": "price_basic_live",
      "plan-test-subs": "price_test_123",
    });
    expect(state.posts).toEqual([
      { "plan-basic": "price_basic_live", "plan-test-subs": "price_test_123" },
    ]);
    // The API returns the POST answer as-is (here the mock answers
    // STALE by design, mirroring the top-up pattern); callers must
    // re-read and render only the fresh read, never this return.
    expect(result).toEqual({ "plan-basic": "price_basic_live" });
    vi.unstubAllGlobals();
  });

  it("setStripePriceByPlan rejects a non-string mapping value", async () => {
    const state = baseState();
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/api/payments/agentic/commercial/billing-policy" && init?.method === "POST") {
        return ok({ policy: { stripePriceByPlan: { "plan-basic": 42 } } });
      }
      return err(404);
    });
    await expect(setStripePriceByPlan({ "plan-basic": "price_basic_live" })).rejects.toBeInstanceOf(
      BillingPolicyApiError,
    );
    vi.unstubAllGlobals();
  });
});

describe("PlanStripePriceSection (#4511)", () => {
  it("operator: renders each plan with its current mapping or Not mapped", async () => {
    const state = baseState();
    await renderSection(state);
    expect(text()).toContain("Plan Stripe Price mappings");
    expect(text()).toContain("Test-Subs");
    expect(text()).toContain("Basic");
    // Basic is mapped; Test-Subs is not.
    expect(text()).toContain("price_basic_live");
    expect(text()).toContain("Not mapped");
    expect(text()).toContain("Save plan Stripe Price mappings");
  });

  it("operator: setting a mapping posts the whole mapping and re-reads (stale POST answer)", async () => {
    const state = baseState();
    await renderSection(state);
    const input = inputForLabel("Stripe Price id for Test-Subs");
    setInputValue(input, "price_test_123");
    await act(async () => {
      buttonByText("Save plan Stripe Price mappings").click();
    });
    await act(async () => {});
    await act(async () => {});
    // The POST carried the whole mapping (existing Basic mapping kept).
    expect(state.posts).toEqual([
      { "plan-basic": "price_basic_live", "plan-test-subs": "price_test_123" },
    ]);
    // The UI shows the fresh read (the new mapping), not the stale POST answer.
    expect(text()).toContain("price_test_123");
    expect(text()).toContain("price_basic_live");
  });

  it("operator: clearing a mapping removes it on save", async () => {
    const state = baseState();
    await renderSection(state);
    const input = inputForLabel("Stripe Price id for Basic");
    setInputValue(input, "");
    await act(async () => {
      buttonByText("Save plan Stripe Price mappings").click();
    });
    await act(async () => {});
    await act(async () => {});
    expect(state.posts).toEqual([{}]);
    expect(text()).toContain("Not mapped");
  });

  it("non-operator: fixed note, no values, no edit controls", async () => {
    const state = baseState({ operatorsStatus: 403 });
    await renderSection(state);
    expect(text()).toContain("Only a store operator can view or change plan Stripe Price mappings.");
    expect(text()).not.toContain("price_basic_live");
    expect(text()).not.toContain("Save plan Stripe Price mappings");
    expect(container!.querySelector("input")).toBeNull();
  });

  it("load failure (503): fixed string plus Retry", async () => {
    const state = baseState({ policyStatus: 503 });
    await renderSection(state);
    expect(text()).toContain("The plan Stripe Price mappings are not configured yet.");
    expect(text()).toContain("Retry");
  });

  it("save failure (400): fixed invalid string, mapping unchanged", async () => {
    const state = baseState({ postStatus: 400 });
    await renderSection(state);
    const input = inputForLabel("Stripe Price id for Test-Subs");
    setInputValue(input, "price_test_123");
    await act(async () => {
      buttonByText("Save plan Stripe Price mappings").click();
    });
    await act(async () => {});
    await act(async () => {});
    expect(text()).toContain("The Stripe Price mapping is invalid");
    expect(state.posts).toEqual([]);
    expect(state.mapping).toEqual({ "plan-basic": "price_basic_live" });
  });

  it("save failure (403): fixed operator-only string", async () => {
    const state = baseState({ postStatus: 403 });
    await renderSection(state);
    const input = inputForLabel("Stripe Price id for Test-Subs");
    setInputValue(input, "price_test_123");
    await act(async () => {
      buttonByText("Save plan Stripe Price mappings").click();
    });
    await act(async () => {});
    await act(async () => {});
    expect(text()).toContain("Only a store operator can change plan Stripe Price mappings.");
  });

  it("save failure (503): fixed unavailable string", async () => {
    const state = baseState({ postStatus: 503 });
    await renderSection(state);
    const input = inputForLabel("Stripe Price id for Test-Subs");
    setInputValue(input, "price_test_123");
    await act(async () => {
      buttonByText("Save plan Stripe Price mappings").click();
    });
    await act(async () => {});
    await act(async () => {});
    expect(text()).toContain("The billing service is temporarily unavailable. Try again later.");
  });
});
