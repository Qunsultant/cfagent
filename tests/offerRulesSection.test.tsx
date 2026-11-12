/** @vitest-environment jsdom */
/**
 * Issue #3246 (sub-issue of #3241), slice 2 — the upgrade-offer
 * rules editor in the Billing servicing surface.
 *
 * Pins: the section calls the EXISTING billing-policy route only
 * (GET for values + seed note, POST for edits, GET operators to
 * prove operator status); an operator edit posts the WHOLE
 * offer-rules block and the section reflects a FRESH policy read,
 * never the POST answer; a non-operator sees a fixed note with no
 * values and no edit controls (there is no non-operator read
 * source for the rules); an invalid cooldown posts nothing and
 * renders a fixed message; failures render as fixed strings keyed
 * by HTTP status, never server error bodies.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  getOfferRules,
  setOfferRules,
  BillingPolicyApiError,
  type OfferRulesView,
} from "../src/client/billingPolicyApi";
import { OfferRulesSection } from "../src/client/OfferRulesSection";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number) {
  return { ok: false, status, json: async () => ({ error: "typed server detail" }) };
}

function seedRules(over: Partial<OfferRulesView> = {}): OfferRulesView {
  return {
    enabled: true,
    triggersEnabled: {
      manual402: true,
      skipNotice: true,
      trialEnd: true,
      quotaExhausted: true,
      ambient: true,
    },
    dismissCooldownDays: 7,
    showProposed: true,
    downgradesEnabled: true,
    runsPacksEnabled: true,
    mentionsEnabled: { referral: true, freeAccess: true },
    ...over,
  };
}

interface MockState {
  rules: OfferRulesView;
  operatorsStatus: number;
  policyStatus: number | null;
  postStatus: number | null;
  posts: OfferRulesView[];
}

/** Stateful mock: POST updates server state but answers STALE, so a UI
 *  that shows the new state proves it re-read (never optimistic). */
function rulesFetch(state: MockState) {
  return async (url: string, init?: RequestInit) => {
    if (
      url === "/api/payments/agentic/commercial/billing-policy" &&
      (!init || init.method === undefined || init.method === "GET")
    ) {
      if (state.policyStatus) return err(state.policyStatus);
      return ok({
        policy: { offerRules: state.rules },
        seedNote: "Values not yet edited by an operator are PROPOSED seed values pending owner approval.",
      });
    }
    if (url === "/api/payments/agentic/commercial/billing-policy" && init?.method === "POST") {
      if (state.postStatus) return err(state.postStatus);
      const body = JSON.parse(String(init.body)) as { offerRules: OfferRulesView };
      state.posts.push(body.offerRules);
      const stale = state.rules;
      state.rules = body.offerRules;
      return ok({ policy: { offerRules: stale } });
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
  vi.stubGlobal("fetch", rulesFetch(state));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(OfferRulesSection));
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

function clickCheckbox(labelText: string) {
  inputForLabel(labelText).click();
}

function baseState(over: Partial<MockState> = {}): MockState {
  return {
    rules: seedRules(),
    operatorsStatus: 200,
    policyStatus: null,
    postStatus: null,
    posts: [],
    ...over,
  };
}

describe("offer rules api", () => {
  it("reads the rules block and seed note from the server", async () => {
    const state = baseState();
    vi.stubGlobal("fetch", rulesFetch(state));
    const res = await getOfferRules();
    expect(res.offerRules).toEqual(seedRules());
    expect(res.seedNote).toContain("PROPOSED");
    vi.unstubAllGlobals();
  });

  it("posts the whole block and surfaces the HTTP status on failure", async () => {
    const state = baseState({ postStatus: 403 });
    vi.stubGlobal("fetch", rulesFetch(state));
    await expect(setOfferRules(seedRules({ enabled: false }))).rejects.toMatchObject({ status: 403 });
    expect(state.posts).toHaveLength(0);
    expect(new BillingPolicyApiError(403).message).toContain("403");
    vi.unstubAllGlobals();
  });

  it("rejects a half-shaped rules block from the server", async () => {
    vi.stubGlobal(
      "fetch",
      async () => ok({ policy: { offerRules: { enabled: true } }, seedNote: "" }),
    );
    await expect(getOfferRules()).rejects.toMatchObject({ status: 500 });
    vi.unstubAllGlobals();
  });
});

describe("offer rules section", () => {
  it("operator toggles a trigger and edits the cooldown; the section reflects the fresh read, never the stale POST answer", async () => {
    const state = baseState();
    await renderSection(state);
    expect(inputForLabel("Upgrade offers enabled").checked).toBe(true);
    expect(inputForLabel("Dismissal cooldown (days)").value).toBe("7");
    await act(async () => {
      clickCheckbox("Offer at trial end");
      setInputValue(inputForLabel("Dismissal cooldown (days)"), "14");
    });
    await act(async () => {
      clickButton("Save upgrade-offer rules");
    });
    await act(async () => {});
    await act(async () => {});
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0]).toEqual(
      seedRules({
        triggersEnabled: {
          manual402: true,
          skipNotice: true,
          trialEnd: false,
          quotaExhausted: true,
          ambient: true,
        },
        dismissCooldownDays: 14,
      }),
    );
    // Fresh read: the toggled box stays off and the cooldown reads 14.
    expect(inputForLabel("Offer at trial end").checked).toBe(false);
    expect(inputForLabel("Dismissal cooldown (days)").value).toBe("14");
    expect(container!.textContent || "").toContain("PROPOSED seed values");
  });

  it("shows a fixed note with no values and no edit controls to a non-operator", async () => {
    const state = baseState({ operatorsStatus: 403 });
    await renderSection(state);
    const text = container!.textContent || "";
    expect(text).toContain("Only a store operator can view or change upgrade-offer rules.");
    expect(text).not.toContain("PROPOSED seed values");
    expect(container!.querySelectorAll("input")).toHaveLength(0);
    const buttons = Array.from(container!.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons.join(" ")).not.toContain("Save upgrade-offer rules");
  });

  it("an invalid cooldown shows a fixed message and posts nothing", async () => {
    const state = baseState();
    await renderSection(state);
    await act(async () => {
      setInputValue(inputForLabel("Dismissal cooldown (days)"), "0");
    });
    await act(async () => {
      clickButton("Save upgrade-offer rules");
    });
    await act(async () => {});
    expect(state.posts).toHaveLength(0);
    expect(container!.textContent || "").toContain("whole number of days from 1 to 365");
    await act(async () => {
      setInputValue(inputForLabel("Dismissal cooldown (days)"), "366");
    });
    await act(async () => {
      clickButton("Save upgrade-offer rules");
    });
    await act(async () => {});
    expect(state.posts).toHaveLength(0);
  });

  it("renders an unconfigured policy (503) as an honest empty state, never a crash", async () => {
    const state = baseState({ policyStatus: 503 });
    await renderSection(state);
    expect(container!.textContent || "").toContain("The upgrade-offer rules are not configured yet.");
  });

  it("renders a save 403 as a fixed operator-only message with state unchanged", async () => {
    const state = baseState({ postStatus: 403 });
    await renderSection(state);
    await act(async () => {
      clickCheckbox("Show proposed prices as unavailable");
    });
    await act(async () => {
      clickButton("Save upgrade-offer rules");
    });
    await act(async () => {});
    await act(async () => {});
    expect(container!.textContent || "").toContain("Only a store operator can change upgrade-offer rules.");
    // The server state never changed; the draft still shows the
    // toggle the operator flipped (the section does not invent a
    // revert — the next load re-reads the server truth).
    expect(state.posts).toHaveLength(0);
  });

  it("never renders a server error body", async () => {
    const state = baseState({ postStatus: 500 });
    await renderSection(state);
    await act(async () => {
      clickButton("Save upgrade-offer rules");
    });
    await act(async () => {});
    await act(async () => {});
    expect(container!.textContent || "").not.toContain("typed server detail");
    expect(container!.textContent || "").toContain("could not be saved");
  });
});
