/** @vitest-environment jsdom */
/**
 * Issue #5229 (slice 2.31) — referral credit rules management UI.
 *
 * The section reads GET /referral/rules + GET /operators, renders
 * values read-only for non-operators, and lets an operator save a
 * new rule row (earn amount, vesting days, expiry days) with a fresh
 * re-read after the POST. Fetch is stubbed; no server involved.
 */
import React from "react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReferralCreditRulesSection } from "../src/client/ReferralCreditRulesSection";

const DAY_MS = 86400000;
const SEED = {
  earnAmountUSD: 0.5,
  vestingDelayMs: 7 * DAY_MS,
  redemptionScope: "pay-per-run",
  expiryPeriodMs: 90 * DAY_MS,
  // Issue #6141: the trial-extension rule values, seeded defaults.
  extensionDays: 7,
  referredTrialDays: 14,
  maxExtensionsPerDay: 3,
  maxExtensionsPerMonth: 10,
  referralTrialPlanId: null,
  shareMessageTemplate:
    "Join me on OpenAIMP — sign up with my link and get a {trialDays}-day free trial of the paid tier, plus free runs every month: {link}",
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number) {
  return { ok: false, status, json: async () => ({ error: "typed" }) };
}

describe("ReferralCreditRulesSection (#5229)", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  async function renderSection(
    impl: (url: string, init?: RequestInit) => Promise<unknown>,
  ) {
    const prev = (globalThis as any).fetch;
    (globalThis as any).fetch = vi.fn(impl);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(ReferralCreditRulesSection));
    });
    await act(async () => {});
    return () => {
      (globalThis as any).fetch = prev;
    };
  }

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  it("renders the seeded rules and lets an operator save a new expiry (fresh re-read)", async () => {
    let current = { ...SEED };
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const restore = await renderSection(async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (url === "/api/payments/agentic/commercial/referral/rules" && (init?.method ?? "GET") === "POST") {
        current = JSON.parse(init!.body as string);
        return ok({ code: "SUCCESS_REFERRAL_RULES_UPDATED", rules: current });
      }
      if (url === "/api/payments/agentic/commercial/referral/rules") {
        return ok({ code: "SUCCESS_REFERRAL_RULES_READ", rules: current });
      }
      if (url === "/api/payments/agentic/commercial/operators") {
        return ok({ operators: [{ login: "owner", source: "env" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    expect(container!.textContent).toContain("$0.50");
    expect(container!.textContent).toContain("90 days after they are earned");
    expect(container!.textContent).toContain("Save referral rules");
    // Change the expiry from 90 to 30 days and save.
    const inputs = container!.querySelectorAll("input");
    // Issue #6141: 8 text inputs now (earn, vesting, expiry, extension
    // days, referred trial days, both caps, share template) + 1 select.
    expect(inputs).toHaveLength(8);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(inputs[2], "30");
      inputs[2].dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Save referral rules",
    );
    expect(save).toBeDefined();
    await act(async () => {
      save!.click();
    });
    await act(async () => {});
    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    const posted = JSON.parse(post!.body!);
    expect(posted.expiryPeriodMs).toBe(30 * DAY_MS);
    expect(posted.earnAmountUSD).toBe(0.5);
    expect(posted.vestingDelayMs).toBe(7 * DAY_MS);
    expect(posted.redemptionScope).toBe("pay-per-run");
    // Issue #6141: the save carries the extension values through.
    expect(posted.extensionDays).toBe(7);
    expect(posted.referredTrialDays).toBe(14);
    expect(posted.maxExtensionsPerDay).toBe(3);
    expect(posted.maxExtensionsPerMonth).toBe(10);
    expect(posted.referralTrialPlanId).toBeNull();
    expect(posted.shareMessageTemplate).toBe(SEED.shareMessageTemplate);
    expect(container!.textContent).toContain("30 days after they are earned");
    expect(container!.textContent).toContain("Referral rules saved.");
    restore();
  });

  it("renders read-only for a non-operator (no save button)", async () => {
    const restore = await renderSection(async (url) => {
      if (url === "/api/payments/agentic/commercial/referral/rules") {
        return ok({ code: "SUCCESS_REFERRAL_RULES_READ", rules: SEED });
      }
      if (url === "/api/payments/agentic/commercial/operators") {
        return err(403);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    expect(container!.textContent).toContain("$0.50");
    expect(container!.textContent).toContain("Only a store operator can change referral rules.");
    expect(container!.querySelectorAll("input")).toHaveLength(0);
    expect(container!.querySelectorAll("button")).toHaveLength(0);
    restore();
  });

  it("renders a fixed error when the rules cannot be loaded", async () => {
    const restore = await renderSection(async (url) => {
      if (url === "/api/payments/agentic/commercial/referral/rules") {
        return err(503);
      }
      if (url === "/api/payments/agentic/commercial/operators") {
        return err(403);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    expect(container!.textContent).toContain("The referral rules are not configured yet.");
    restore();
  });
});
