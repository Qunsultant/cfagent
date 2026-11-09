/** @vitest-environment jsdom */

/**
 * Issue #3256 (sub-issue of #3241) — Signup → Trial onboarding flow,
 * rendered for real (react-dom, not source-text assertions).
 *
 * The firstRunApi and commercialApi modules are mocked at the network
 * boundary only (the checkout-panel precedent): the screen's own
 * logic — five steps, real account creation, trial start-or-skip,
 * live brokerage status, preferences save, and a summary re-fetched
 * from the server — runs for real, and the completion store
 * functions are the real ones (importActual).
 *
 * Governing rule, tested here: REAL, not fluff. The summary claims
 * a trial, a brokerage connection, or saved preferences ONLY when
 * the server said so; it never mentions per-service quotas (#3263,
 * not built) and never claims a connection that was skipped.
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
  setupCalls: 0,
  stateCalls: [] as Record<string, unknown>[],
  savedState: null as null | {
    userLogin: string;
    tenantId: string | null;
    currentStep: number;
    completedAtMs: number | null;
    trialPlanId: string | null;
    trialStartedAtMs: number | null;
    updatedAtMs: number;
  },
  stateError: null as null | Error,
  etradeAuthenticated: false,
  oauthStarted: 0,
  plans: [] as { id: string; name: string; priceUSD: number; periodDays: number; includedRuns: number; trialDays: number | null }[],
  plansError: null as null | Error,
  trialCalls: [] as string[],
  trialError: null as null | Error,
  preferences: { userId: "second-user", tenantId: "tenant-1", digestEnabled: false, welcomeEnabled: true, updatedAtMs: 1 },
  savedBody: null as null | Record<string, unknown>,
  accountSelf: null as null | {
    identity: {
      userLogin: string;
      tenantId: string | null;
      hasAccount: boolean;
      tier: string;
      creditsUSD: number;
      includedRunsRemaining: number;
    };
    subscriptions: {
      id: string;
      planId: string;
      provider: string;
      providerStatus: string | null;
      status: string;
      periodStartMs: number;
      periodEndMs: number;
      canceledAtMs: number | null;
    }[];
  },
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
    fetchOnboardingState: vi.fn(async () => {
      if (apiState.stateError) throw apiState.stateError;
      return apiState.savedState;
    }),
    saveOnboardingState: vi.fn(async (input: Record<string, unknown>) => {
      apiState.stateCalls.push(input);
      apiState.savedState = {
        userLogin: "second-user",
        tenantId: "second-user",
        currentStep: input.currentStep as number,
        completedAtMs: input.completed === true ? 1700000000000 : null,
        trialPlanId: (input.trialPlanId as string | undefined) ?? apiState.savedState?.trialPlanId ?? null,
        trialStartedAtMs: (input.trialPlanId as string | undefined) ? 1700000000000 : (apiState.savedState?.trialStartedAtMs ?? null),
        updatedAtMs: 1700000000000,
      };
      return apiState.savedState;
    }),
    fetchETradeStatus: vi.fn(async () => ({
      authenticated: apiState.etradeAuthenticated,
      environment: "TEST",
    })),
    startETradeOAuth: vi.fn(() => {
      apiState.oauthStarted += 1;
    }),
    fetchAccountSelf: vi.fn(async () => {
      if (!apiState.accountSelf) throw new Error("no mocked account self view");
      return apiState.accountSelf;
    }),
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
    listPlans: vi.fn(async () => {
      if (apiState.plansError) throw apiState.plansError;
      return { plans: apiState.plans };
    }),
    subscriptionTrial: vi.fn(async (body: { planId: string }) => {
      if (apiState.trialError) throw apiState.trialError;
      apiState.trialCalls.push(body.planId);
      const plan = apiState.plans.find((p) => p.id === body.planId);
      apiState.identity = {
        userLogin: "second-user",
        tenantId: "tenant-1",
        hasAccount: true,
        tier: "Subscribed",
        creditsUSD: 0,
        includedRunsRemaining: plan?.includedRuns ?? 0,
      };
      apiState.accountSelf = {
        identity: apiState.identity,
        subscriptions: [
          {
            id: "sub-trial-1",
            planId: body.planId,
            provider: "trial",
            providerStatus: "trialing",
            status: "trialing",
            periodStartMs: 1700000000000,
            periodEndMs: 1700604800000,
            canceledAtMs: null,
          },
        ],
      };
      return {
        subscription: apiState.accountSelf.subscriptions[0],
        account: { userId: "second-user", tier: "Subscribed", includedRunsRemaining: plan?.includedRuns ?? 0 },
        effectiveTier: "Subscribed",
        trialEndsAtMs: 1700604800000,
        message: `Your free trial started.`,
      };
    }),
  };
});

import { FirstRunScreen } from "../src/client/FirstRunScreen";
import { FirstRunGate } from "../src/client/FirstRunGate";
import { isFirstRunComplete } from "../src/client/firstRunApi";
import { setTenantProvidersStateForTest } from "../src/client/tenantProviders";

const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

function renderInto(container: HTMLElement, node: React.ReactNode) {
  const root = createRoot(container);
  return { root };
}

async function renderScreen(props: {
  userLogin: string;
  initialStep?: number;
  onComplete?: () => void;
  onOpenCheckout?: () => void;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let completed = 0;
  let checkoutOpened = 0;
  await act(async () => {
    root.render(
      <FirstRunScreen
        userLogin={props.userLogin}
        initialStep={props.initialStep}
        onComplete={() => {
          completed += 1;
          props.onComplete?.();
        }}
        onOpenCheckout={() => {
          checkoutOpened += 1;
          props.onOpenCheckout?.();
        }}
      />,
    );
  });
  await flush();
  return { container, root, completed: () => completed, checkoutOpened: () => checkoutOpened };
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
  const input =
    label.querySelector("input") ??
    (label.htmlFor ? container.querySelector(`#${label.htmlFor}`) : null);
  if (!(input instanceof HTMLInputElement)) throw new Error(`label ${JSON.stringify(text)} has no input`);
  act(() => {
    input.click();
  });
}

beforeEach(() => {
  // Issue #3812: the platform default broker is Alpaca; this suite walks
  // the E*TRADE OAuth connect step, so the selection is explicit.
  setTenantProvidersStateForTest({ dataProviderId: "etrade", brokerId: "etrade" });
  apiState.identity = {
    userLogin: "second-user",
    tenantId: "tenant-1",
    hasAccount: true,
    tier: "Free",
    creditsUSD: 0,
    includedRunsRemaining: 3,
  };
  apiState.identityError = null;
  apiState.setupCalls = 0;
  apiState.stateCalls = [];
  apiState.savedState = null;
  apiState.stateError = null;
  apiState.etradeAuthenticated = false;
  apiState.oauthStarted = 0;
  apiState.plans = [
    { id: "plan-starter", name: "Starter", priceUSD: 10, periodDays: 30, includedRuns: 5, trialDays: 7 },
    { id: "plan-basic", name: "Basic", priceUSD: 5, periodDays: 30, includedRuns: 2, trialDays: null },
  ];
  apiState.plansError = null;
  apiState.trialCalls = [];
  apiState.trialError = null;
  apiState.preferences = { userId: "second-user", tenantId: "tenant-1", digestEnabled: false, welcomeEnabled: true, updatedAtMs: 1 };
  apiState.savedBody = null;
  apiState.accountSelf = {
    identity: {
      userLogin: "second-user",
      tenantId: "tenant-1",
      hasAccount: true,
      tier: "Free",
      creditsUSD: 0,
      includedRunsRemaining: 3,
    },
    subscriptions: [],
  };
});

afterEach(async () => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals?.();
});

describe("FirstRunScreen — signup → trial onboarding (#3256)", () => {
  it("step 1 creates the account on entry when none exists, then advances only on real success", async () => {
    apiState.identity = {
      userLogin: "second-user",
      tenantId: null,
      hasAccount: false,
      tier: "Free",
      creditsUSD: 0,
      includedRunsRemaining: 0,
    };
    const { container, root } = await renderScreen({ userLogin: "onb-screen-1" });
    try {
      expect(apiState.setupCalls).toBe(1);
      const text = container.textContent ?? "";
      expect(text).toContain("second-user");
      expect(text).toContain("Free");
      expect(text).toContain("Step 1 of 5");
      click(container, "Continue");
      await flush();
      expect(container.textContent ?? "").toContain("Step 2 of 5");
      expect(container.textContent ?? "").toContain("free trial");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("step 1 does not call setup when the account already exists", async () => {
    const { container, root } = await renderScreen({ userLogin: "onb-screen-1b" });
    try {
      expect(apiState.setupCalls).toBe(0);
      expect(container.textContent ?? "").toContain("Step 1 of 5");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("walks all five steps: trial start grants runs, brokerage status is live, preferences save, summary is re-fetched and true", async () => {
    const { container, root, completed } = await renderScreen({ userLogin: "onb-screen-2" });
    try {
      // Step 1 -> step 2.
      click(container, "Continue");
      await flush();
      expect(container.textContent ?? "").toContain("Step 2 of 5");
      expect(container.textContent ?? "").toContain("Starter");
      expect(container.textContent ?? "").toContain("7 days");
      expect(container.textContent ?? "").toContain("5 included runs");

      // Step 2: start the trial (real subscriptionTrial call).
      click(container, "Start free trial");
      await flush();
      expect(apiState.trialCalls).toEqual(["plan-starter"]);
      expect(container.textContent ?? "").toContain("Step 3 of 5");

      // Step 3: live status says not connected; the Connect button
      // starts the real OAuth flow, and the state is saved first so
      // the flow resumes after the callback.
      expect(container.textContent ?? "").toContain("Not connected");
      click(container, "Connect E*TRADE");
      expect(apiState.oauthStarted).toBe(1);
      expect(apiState.stateCalls.some((c) => c.currentStep === 3)).toBe(true);

      // Continue without connecting is the explicit honest path.
      click(container, "Continue without connecting");
      await flush();
      expect(container.textContent ?? "").toContain("Step 4 of 5");

      // Step 4: save preferences (toggle digest on first).
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

      // Step 5: true summary, re-fetched from the server.
      const summary = container.textContent ?? "";
      expect(summary).toContain("second-user");
      expect(summary).toContain("Subscribed");
      expect(summary).toContain("5");
      expect(summary).toContain("Starter");
      expect(summary).toContain("Not connected");
      expect(summary).toContain("saved");
      expect(summary.toLowerCase()).not.toContain("quota");

      click(container, "Finish");
      await flush();
      expect(completed()).toBe(1);
      expect(isFirstRunComplete("onb-screen-2")).toBe(true);
      expect(apiState.stateCalls.some((c) => c.completed === true)).toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("trial is a choice: skipping advances without starting one, and the summary says so honestly", async () => {
    const { container, root } = await renderScreen({ userLogin: "onb-screen-3" });
    try {
      click(container, "Continue");
      await flush();
      click(container, "Skip trial for now");
      await flush();
      expect(apiState.trialCalls).toEqual([]);
      expect(container.textContent ?? "").toContain("Step 3 of 5");
      click(container, "Continue without connecting");
      await flush();
      // Continue without saving preferences: the summary must not
      // claim they were saved.
      click(container, "Continue without saving");
      await flush();
      const summary = container.textContent ?? "";
      expect(summary).toContain("Step 5 of 5");
      expect(summary).toContain("No trial started");
      expect(summary).toContain("Not connected");
      expect(summary).not.toContain("Preferences saved");
      expect(summary.toLowerCase()).not.toContain("quota");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("offers checkout from the trial step and the summary step", async () => {
    const { container, root, checkoutOpened } = await renderScreen({ userLogin: "onb-screen-4" });
    try {
      click(container, "Continue");
      await flush();
      click(container, "See subscription plans");
      expect(checkoutOpened()).toBe(1);
      click(container, "Skip trial for now");
      await flush();
      click(container, "Continue without connecting");
      await flush();
      click(container, "Continue without saving");
      await flush();
      click(container, "Sign up for a subscription");
      expect(checkoutOpened()).toBe(2);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("resumes at the saved step when initialStep is given", async () => {
    apiState.etradeAuthenticated = true;
    const { container, root } = await renderScreen({ userLogin: "onb-screen-5", initialStep: 3 });
    try {
      expect(container.textContent ?? "").toContain("Step 3 of 5");
      expect(container.textContent ?? "").toContain("Connected");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("shows an error, not a silent skip, when identity cannot load", async () => {
    apiState.identityError = new Error("identity unavailable");
    const { container, root } = await renderScreen({ userLogin: "onb-screen-6" });
    try {
      expect(container.textContent ?? "").toContain("couldn");
      expect(container.querySelectorAll("input").length).toBe(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});

describe("FirstRunGate — server onboarding state (#3256)", () => {
  async function renderGate(userLogin: string) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<FirstRunGate userLogin={userLogin} />);
    });
    await flush();
    return { container, root };
  }

  it("hides the screen when the server says completed, even with no localStorage flag", async () => {
    apiState.savedState = {
      userLogin: "onb-gate-1",
      tenantId: "onb-gate-1",
      currentStep: 5,
      completedAtMs: 1700000000000,
      trialPlanId: null,
      trialStartedAtMs: null,
      updatedAtMs: 1700000000000,
    };
    expect(isFirstRunComplete("onb-gate-1")).toBe(false);
    const { container, root } = await renderGate("onb-gate-1");
    try {
      expect(document.body.textContent ?? "").not.toContain("first-run setup");
      expect(container.textContent ?? "").toBe("");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("shows the screen at the saved step when the server says not completed", async () => {
    apiState.savedState = {
      userLogin: "onb-gate-2",
      tenantId: "onb-gate-2",
      currentStep: 3,
      completedAtMs: null,
      trialPlanId: "plan-starter",
      trialStartedAtMs: 1700000000000,
      updatedAtMs: 1700000000000,
    };
    const { container, root } = await renderGate("onb-gate-2");
    try {
      expect(document.body.textContent ?? "").toContain("Step 3 of 5");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("falls back to the localStorage flag when the server state route fails — never bricks the hub", async () => {
    apiState.stateError = new Error("state unavailable");
    // No local flag: the screen shows (server unknown, nothing completed).
    const first = await renderGate("onb-gate-3");
    try {
      expect(document.body.textContent ?? "").toContain("first-run setup");
    } finally {
      await act(async () => {
        first.root.unmount();
      });
    }
    document.body.innerHTML = "";
    // Local flag set: the screen hides even though the server failed.
    const { markFirstRunComplete } = await import("../src/client/firstRunApi");
    markFirstRunComplete("onb-gate-3");
    const second = await renderGate("onb-gate-3");
    try {
      expect(second.container.textContent ?? "").toBe("");
    } finally {
      await act(async () => {
        second.root.unmount();
      });
    }
  });

  it("shows the screen on a fresh login with no server state and no local flag (cross-device: a new device re-shows until completed)", async () => {
    apiState.savedState = null;
    const { container, root } = await renderGate("onb-gate-4");
    try {
      expect(document.body.textContent ?? "").toContain("Step 1 of 5");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
