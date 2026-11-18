/** @vitest-environment jsdom */
/**
 * Issue #5230 — operator UI for the remaining billing-policy fields
 * in the Billing servicing surface (new "Billing policy" sub-tab).
 *
 * TDD RED first: this suite imports src/client/billingPolicyApi.ts
 * (getBillingPolicyFields / setBillingPolicyFields) and
 * src/client/BillingPolicySection.tsx.
 *
 * Scope: a fields editor over the EXISTING billing-policy route only
 * — GET billing-policy (operator-only) for the fields + seed note,
 * POST billing-policy (operator-only) for a partial update, GET
 * operators (operator-only, proves the viewer is an operator). The
 * nine fields with no surface before this slice (grace period,
 * dunning schedule, proration, downgrade timing, billing period
 * default/allowed, annual discount, repurchase migration, cfpay
 * channel fixed price) plus the bundle Stripe Price mapping.
 * Top-up limits, offer rules, and the plan Stripe Price mapping
 * already have their own sub-tabs and are NOT repeated here. Edits
 * are reflected from a FRESH policy read (never an optimistic
 * assertion). Failures render as fixed strings; server error bodies
 * are never rendered. ui primitives only.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  getBillingPolicyFields,
  setBillingPolicyFields,
  BillingPolicyApiError,
  type BillingPolicyFieldsView,
} from "../src/client/billingPolicyApi";
import { BillingPolicySection } from "../src/client/BillingPolicySection";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number) {
  return { ok: false, status, json: async () => ({ error: "typed server detail" }) };
}

interface MockState {
  fields: BillingPolicyFieldsView;
  operatorsStatus: number;
  policyStatus: number | null;
  postStatus: number | null;
  posts: Array<Record<string, unknown>>;
}

/** Stateful mock: POST updates server state but answers STALE, so a UI
 *  that shows the new state proves it re-read (never optimistic). */
function billingFetch(state: MockState) {
  return async (url: string, init?: RequestInit) => {
    if (
      url === "/api/payments/agentic/commercial/billing-policy" &&
      (!init || init.method === undefined || init.method === "GET")
    ) {
      if (state.policyStatus) return err(state.policyStatus);
      return ok({
        policy: { ...state.fields },
        seedNote: "Values not yet edited by an operator are PROPOSED seed values pending owner approval.",
      });
    }
    if (url === "/api/payments/agentic/commercial/billing-policy" && init?.method === "POST") {
      if (state.postStatus) return err(state.postStatus);
      const body = JSON.parse(String(init.body)) as Partial<BillingPolicyFieldsView>;
      state.posts.push({ ...body });
      const stale = { ...state.fields };
      state.fields = { ...state.fields, ...body };
      return ok({ policy: stale });
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
  vi.stubGlobal("fetch", billingFetch(state));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(BillingPolicySection));
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

function selectForLabel(labelText: string): HTMLSelectElement {
  const label = Array.from(container!.querySelectorAll("label")).find((l) =>
    (l.textContent || "").includes(labelText),
  );
  if (!label) throw new Error(`No label found for: ${labelText}`);
  const id = label.getAttribute("for") || (label as HTMLLabelElement).htmlFor;
  const select = id
    ? (container!.querySelector(`#${id}`) as HTMLSelectElement | null)
    : (label.querySelector("select") as HTMLSelectElement | null);
  if (!select) throw new Error(`No select found for label: ${labelText}`);
  return select;
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
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

function baseFields(): BillingPolicyFieldsView {
  return {
    billingPeriodDefault: "monthly",
    billingPeriodsAllowed: ["monthly", "annual"],
    dunningRetryDelayDays: [1, 3, 7],
    gracePeriodDays: 7,
    downgradeTiming: "period_end",
    prorationBehavior: "none",
    repurchaseMigration: "grandfather",
    stripePriceByBundle: { "bundle-starter": "price_bundle_1" },
    cfpayChannelFixedPriceUSD: null,
    annualDiscountPct: 15,
  };
}

function baseState(overrides: Partial<MockState> = {}): MockState {
  return {
    fields: baseFields(),
    operatorsStatus: 200,
    policyStatus: null,
    postStatus: null,
    posts: [],
    ...overrides,
  };
}

describe("billingPolicyApi billing-policy fields (#5230)", () => {
  it("getBillingPolicyFields returns the fields plus the seed note", async () => {
    const state = baseState();
    vi.stubGlobal("fetch", billingFetch(state));
    const result = await getBillingPolicyFields();
    expect(result.fields.gracePeriodDays).toBe(7);
    expect(result.fields.dunningRetryDelayDays).toEqual([1, 3, 7]);
    expect(result.fields.annualDiscountPct).toBe(15);
    expect(result.fields.cfpayChannelFixedPriceUSD).toBeNull();
    expect(result.seedNote).toContain("PROPOSED");
    vi.unstubAllGlobals();
  });

  it("setBillingPolicyFields posts the partial and returns the POST answer (stale by design)", async () => {
    const state = baseState();
    vi.stubGlobal("fetch", billingFetch(state));
    const result = await setBillingPolicyFields({ gracePeriodDays: 14, annualDiscountPct: 20 });
    expect(state.posts).toEqual([{ gracePeriodDays: 14, annualDiscountPct: 20 }]);
    // The API returns the POST answer as-is (here the mock answers
    // STALE by design); callers must re-read and render only the
    // fresh read, never this return.
    expect(result.gracePeriodDays).toBe(7);
    expect(state.fields.gracePeriodDays).toBe(14);
    expect(state.fields.annualDiscountPct).toBe(20);
    vi.unstubAllGlobals();
  });

  it("setBillingPolicyFields rejects a half-shaped policy", async () => {
    const state = baseState();
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/api/payments/agentic/commercial/billing-policy" && init?.method === "POST") {
        return ok({ policy: { gracePeriodDays: "a week" } });
      }
      return err(404);
    });
    await expect(setBillingPolicyFields({ gracePeriodDays: 14 })).rejects.toBeInstanceOf(
      BillingPolicyApiError,
    );
    vi.unstubAllGlobals();
  });
});

describe("BillingPolicySection (#5230)", () => {
  it("operator: renders the current fields", async () => {
    const state = baseState();
    await renderSection(state);
    expect(text()).toContain("Billing policy");
    expect(inputForLabel("Grace period").value).toBe("7");
    expect(inputForLabel("Dunning schedule").value).toBe("1, 3, 7");
    expect(inputForLabel("Annual discount").value).toBe("15");
    expect(inputForLabel("cfpay channel fixed price").value).toBe("");
    expect(selectForLabel("Proration on subscription updates").value).toBe("none");
    expect(selectForLabel("Downgrade timing").value).toBe("period_end");
    // Bundle mapping values live in inputs, not in textContent.
    expect(inputForLabel("Bundle id").value).toBe("bundle-starter");
    expect(inputForLabel("Stripe Price id").value).toBe("price_bundle_1");
    expect(text()).toContain("Save billing policy");
  });

  it("operator: editing fields posts the partial and re-reads (stale POST answer)", async () => {
    const state = baseState();
    await renderSection(state);
    setInputValue(inputForLabel("Grace period"), "14");
    setInputValue(inputForLabel("Annual discount"), "20");
    setSelectValue(selectForLabel("Proration on subscription updates"), "create_prorations");
    await act(async () => {
      buttonByText("Save billing policy").click();
    });
    await act(async () => {});
    await act(async () => {});
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0]).toMatchObject({
      gracePeriodDays: 14,
      annualDiscountPct: 20,
      prorationBehavior: "create_prorations",
    });
    // The POST answer was the stale fields; the re-read shows the new ones.
    expect(inputForLabel("Grace period").value).toBe("14");
    expect(inputForLabel("Annual discount").value).toBe("20");
    expect(selectForLabel("Proration on subscription updates").value).toBe("create_prorations");
  });

  it("operator: setting the cfpay fixed price posts the value", async () => {
    const state = baseState();
    await renderSection(state);
    setInputValue(inputForLabel("cfpay channel fixed price"), "0.05");
    await act(async () => {
      buttonByText("Save billing policy").click();
    });
    await act(async () => {});
    await act(async () => {});
    expect(state.posts[0]).toMatchObject({ cfpayChannelFixedPriceUSD: 0.05 });
    expect(inputForLabel("cfpay channel fixed price").value).toBe("0.05");
  });

  it("operator: an invalid grace period shows a fixed string and posts nothing", async () => {
    const state = baseState();
    await renderSection(state);
    setInputValue(inputForLabel("Grace period"), "-1");
    await act(async () => {
      buttonByText("Save billing policy").click();
    });
    await act(async () => {});
    expect(state.posts).toEqual([]);
    expect(text()).toContain("The grace period is invalid: enter a whole number of days, 0 or more.");
  });

  it("operator: a 403 on save shows a fixed string", async () => {
    const state = baseState({ postStatus: 403 });
    await renderSection(state);
    setInputValue(inputForLabel("Grace period"), "14");
    await act(async () => {
      buttonByText("Save billing policy").click();
    });
    await act(async () => {});
    expect(text()).toContain("Only a store operator can change billing policy.");
  });

  it("non-operator: fixed note, no values, no edit controls", async () => {
    const state = baseState({ operatorsStatus: 403 });
    await renderSection(state);
    expect(text()).toContain("Only a store operator can view or change billing policy.");
    expect(text()).not.toContain("Save billing policy");
  });
});
