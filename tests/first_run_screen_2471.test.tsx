/** @vitest-environment jsdom */

/**
 * Issue #2471 (program #2468, Phase 1) — first-run screen + preferences
 * panel, rendered for real (react-dom, not source-text assertions).
 *
 * The firstRunApi module is mocked at the network boundary only (the
 * checkout-panel precedent): the screen's own logic — steps, read-only
 * identity display, preferences save, completion — runs for real, and
 * the completion store functions are the real ones (importActual).
 *
 * Issue #3256 (sub-issue of #3241) extended the screen from 4 steps
 * to 5 (account creation, trial, brokerage, preferences, summary):
 * step 1 now CREATES the account on entry when none exists, step 2
 * is the trial choice, step 3 connects E*TRADE for real (the old
 * "open-settings-menu" event is gone — the flow never dispatches
 * it), and step 5 is a true server-fetched summary. The tests below
 * were updated for that intentional change; the #2471 behaviors
 * (read-only identity, preferences save, completion, error-not-skip)
 * are preserved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const apiState = vi.hoisted(() => ({
  identity: null as null | {
    userLogin: string;
    tenantId: string | null;
    hasAccount: boolean;
    tier: string;
    creditsUSD: number;
    includedRunsRemaining: number;
  },
  identityError: null as null | Error,
  setupError: null as null | Error,
  preferences: { userId: "second-user", tenantId: "tenant-1", digestEnabled: false, welcomeEnabled: true, updatedAtMs: 1 },
  savedBody: null as null | Record<string, unknown>,
  setupCalls: 0,
  stateCalls: [] as Record<string, unknown>[],
  etradeAuthenticated: false,
  oauthStarted: 0,
  plans: [] as { id: string; name: string; priceUSD: number; periodDays: number; includedRuns: number; trialDays: number | null }[],
}));

vi.mock("../src/client/firstRunApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client/firstRunApi")>();
  return {
    ...actual,
    fetchPlatformIdentity: vi.fn(async () => {
      if (apiState.identityError) throw apiState.identityError;
      if (!apiState.identity) throw new Error("no mocked identity");
      return apiState.identity;
    }),
    setupAccount: vi.fn(async () => {
      apiState.setupCalls += 1;
      if (apiState.setupError) throw apiState.setupError;
      apiState.identity = {
        userLogin: "second-user",
        tenantId: "second-user",
        hasAccount: true,
        tier: "Free",
        creditsUSD: 0,
        includedRunsRemaining: 0,
      };
      return { created: true, identity: apiState.identity };
    }),
    fetchOnboardingState: vi.fn(async () => null),
    saveOnboardingState: vi.fn(async (input: Record<string, unknown>) => {
      apiState.stateCalls.push(input);
      return {
        userLogin: "second-user",
        tenantId: "second-user",
        currentStep: input.currentStep as number,
        completedAtMs: input.completed === true ? 1700000000000 : null,
        trialPlanId: null,
        trialStartedAtMs: null,
        updatedAtMs: 1700000000000,
      };
    }),
    fetchETradeStatus: vi.fn(async () => ({
      authenticated: apiState.etradeAuthenticated,
      environment: "TEST",
    })),
    startETradeOAuth: vi.fn(() => {
      apiState.oauthStarted += 1;
    }),
    fetchAccountSelf: vi.fn(async () => ({
      identity: apiState.identity,
      subscriptions: [],
    })),
    fetchNotificationPreferences: vi.fn(async () => apiState.preferences),
    saveNotificationPreferences: vi.fn(async (input: Record<string, unknown>) => {
      apiState.savedBody = input;
      return { ...apiState.preferences, digestEnabled: input.digestEnabled as boolean, welcomeEnabled: input.welcomeEnabled as boolean };
    }),
  };
});

vi.mock("../src/client/commercialApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client/commercialApi")>();
  return {
    ...actual,
    listPlans: vi.fn(async () => ({ plans: apiState.plans })),
    subscriptionTrial: vi.fn(async () => {
      throw new Error("trial not exercised in the #2471 walk");
    }),
  };
});

import { FirstRunScreen } from "../src/client/FirstRunScreen";
import { NotificationPreferencesPanel } from "../src/client/NotificationPreferencesPanel";
import { FirstRunApiError, isFirstRunComplete } from "../src/client/firstRunApi";

const flush = async (times = 5) => {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

async function renderScreen(props: { userLogin: string; onComplete?: () => void }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let completed = 0;
  await act(async () => {
    root.render(
      <FirstRunScreen
        userLogin={props.userLogin}
        onComplete={() => {
          completed += 1;
          props.onComplete?.();
        }}
      />,
    );
  });
  await flush();
  return { container, root, completed: () => completed };
}

function click(container: HTMLElement, text: string) {
  const el = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));
  if (!el) throw new Error(`no button containing ${JSON.stringify(text)}; buttons: ${[...container.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`);
  act(() => {
    el.click();
  });
}

function clickLabel(container: HTMLElement, text: string) {
  const label = [...container.querySelectorAll("label")].find((l) => (l.textContent ?? "").includes(text));
  if (!label) throw new Error(`no label containing ${JSON.stringify(text)}`);
  // Wrapper label (input inside) or FieldShell label (htmlFor sibling).
  const input =
    label.querySelector("input") ??
    (label.htmlFor ? container.querySelector(`#${label.htmlFor}`) : null);
  if (!(input instanceof HTMLInputElement)) throw new Error(`label ${JSON.stringify(text)} has no input`);
  act(() => {
    input.click();
  });
}

beforeEach(() => {
  apiState.identity = {
    userLogin: "second-user",
    tenantId: "tenant-1",
    hasAccount: true,
    tier: "Free",
    creditsUSD: 0,
    includedRunsRemaining: 3,
  };
  apiState.identityError = null;
  apiState.setupError = null;
  apiState.preferences = { userId: "second-user", tenantId: "tenant-1", digestEnabled: false, welcomeEnabled: true, updatedAtMs: 1 };
  apiState.savedBody = null;
  apiState.setupCalls = 0;
  apiState.stateCalls = [];
  apiState.etradeAuthenticated = false;
  apiState.oauthStarted = 0;
  apiState.plans = [
    { id: "plan-starter", name: "Starter", priceUSD: 10, periodDays: 30, includedRuns: 5, trialDays: 7 },
  ];
});

afterEach(async () => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("FirstRunScreen (#2471)", () => {
  it("shows identity + tier read-only on step 1, with no tier/tenant input", async () => {
    const { container, root } = await renderScreen({ userLogin: "screen-user-1" });
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("second-user");
      expect(text).toContain("Free");
      // Read-only means read-only: step 1 renders no form inputs at all.
      expect(container.querySelectorAll("input").length).toBe(0);
      expect(container.querySelectorAll("select").length).toBe(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("walks account -> trial choice -> brokerage -> preferences -> summary, saves, and marks complete", async () => {
    const { container, root, completed } = await renderScreen({ userLogin: "screen-user-2" });
    try {
      // Step 1 -> step 2 (trial choice).
      click(container, "Continue");
      await flush();
      expect(container.textContent ?? "").toContain("Step 2 of 5");
      expect(container.textContent ?? "").toContain("Starter");

      // Step 2 -> step 3: the trial is a choice, skip it here.
      click(container, "Skip trial for now");
      await flush();
      expect(container.textContent ?? "").toContain("Step 3 of 5");
      expect(container.textContent ?? "").toContain("Not connected");

      // Step 3 no longer dispatches the old Settings-menu event:
      // the flow connects for real (startETradeOAuth) or continues
      // without connecting. Continuing must fire no such event.
      const opened: Event[] = [];
      const listener = (e: Event) => opened.push(e);
      window.addEventListener("open-settings-menu", listener);
      try {
        click(container, "Continue without connecting");
      } finally {
        window.removeEventListener("open-settings-menu", listener);
      }
      expect(opened.length).toBe(0);

      // Step 3 -> step 4: preferences reflect the existing route's values.
      await flush();
      const digest = container.querySelector('input[name="digestEnabled"]') as HTMLInputElement | null;
      const welcome = container.querySelector('input[name="welcomeEnabled"]') as HTMLInputElement | null;
      expect(digest).not.toBeNull();
      expect(welcome).not.toBeNull();
      expect(digest!.checked).toBe(false);
      expect(welcome!.checked).toBe(true);

      // Toggle digest on, save, and finish from the true summary.
      clickLabel(container, "Digest");
      click(container, "Save");
      await flush();
      expect(apiState.savedBody).toEqual({
        userId: "second-user",
        tenantId: "tenant-1",
        digestEnabled: true,
        welcomeEnabled: true,
      });
      expect(container.textContent ?? "").toContain("Step 5 of 5");
      expect(container.textContent ?? "").toContain("No trial started");
      expect(container.textContent ?? "").toContain("Not connected");
      click(container, "Finish");
      await flush();
      expect(completed()).toBe(1);
      expect(isFirstRunComplete("screen-user-2")).toBe(true);
      expect(apiState.stateCalls.some((c) => c.completed === true)).toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("shows an error, not a silent skip, when identity cannot load", async () => {
    apiState.identityError = new Error("identity unavailable");
    const { container, root } = await renderScreen({ userLogin: "screen-user-3" });
    try {
      expect(container.textContent ?? "").toContain("couldn");
      expect(container.querySelectorAll("input").length).toBe(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("a coded setup timeout renders the catalog message, not the generic copy (#3309)", async () => {
    apiState.identity = {
      userLogin: "second-user",
      tenantId: null,
      hasAccount: false,
      tier: "Free",
      creditsUSD: 0,
      includedRunsRemaining: 0,
    };
    apiState.setupError = new FirstRunApiError(408, "FAILURE_ASYNC_JOB_STILL_PROCESSING");
    const { container, root } = await renderScreen({ userLogin: "screen-user-5" });
    try {
      expect(apiState.setupCalls).toBe(1);
      expect(container.textContent ?? "").toContain(
        "Your request is still being processed. It will continue in the background — try again shortly.",
      );
      expect(container.textContent ?? "").not.toContain("Your account could not be created.");
      expect(container.textContent ?? "").toContain("Try again");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("with no account, creates it on entry — preferences are then available — and still allows completion", async () => {
    apiState.identity = {
      userLogin: "second-user",
      tenantId: null,
      hasAccount: false,
      tier: "Free",
      creditsUSD: 0,
      includedRunsRemaining: 0,
    };
    const { container, root, completed } = await renderScreen({ userLogin: "screen-user-4" });
    try {
      // Step 1 created the account on entry (#3256): no dead end.
      expect(apiState.setupCalls).toBe(1);
      expect(container.textContent ?? "").toContain("Active");
      click(container, "Continue");
      await flush();
      click(container, "Skip trial for now");
      await flush();
      click(container, "Continue without connecting");
      await flush();
      // Preferences now save against the created account's tenant.
      clickLabel(container, "Digest");
      click(container, "Save");
      await flush();
      expect(apiState.savedBody).toEqual({
        userId: "second-user",
        tenantId: "second-user",
        digestEnabled: true,
        welcomeEnabled: true,
      });
      expect(container.textContent ?? "").toContain("Step 5 of 5");
      click(container, "Finish");
      await flush();
      expect(completed()).toBe(1);
      expect(isFirstRunComplete("screen-user-4")).toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});

describe("NotificationPreferencesPanel (#2471)", () => {
  it("loads toggles from the existing route and saves through it", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <NotificationPreferencesPanel
            identity={{
              userLogin: "second-user",
              tenantId: "tenant-1",
              hasAccount: true,
              tier: "Free",
              creditsUSD: 0,
              includedRunsRemaining: 3,
            }}
          />,
        );
      });
      await flush();
      const digest = container.querySelector('input[name="digestEnabled"]') as HTMLInputElement | null;
      expect(digest).not.toBeNull();
      expect(digest!.checked).toBe(false);
      clickLabel(container, "Digest");
      click(container, "Save");
      await flush();
      expect(apiState.savedBody).toEqual({
        userId: "second-user",
        tenantId: "tenant-1",
        digestEnabled: true,
        welcomeEnabled: true,
      });
      expect(container.textContent ?? "").toContain("Saved");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
