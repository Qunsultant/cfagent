/** @vitest-environment jsdom */
/**
 * Issue #3246 (sub-issue of #3241), slice 2 — UpgradeOffer.
 *
 * Pins (design §9.2/§5.4): the fixed fallback message renders
 * immediately and stands alone on ANY offer failure (fetch
 * reject, 503, malformed payload, ineligible payload) — no blank
 * section, no eternal spinner; the loading line shows only while
 * the fetch is in flight; "Not now" POSTs the dismiss route with
 * the trigger and collapses to the fixed copy on success, and a
 * failed dismiss keeps the offer with a retry note; NO
 * client-side suppression storage is ever written (dismissal
 * state lives only on the server); choosing a plan or buying
 * credits navigates to checkout with the target preselected and
 * the trigger carried.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UpgradeOffer } from "../src/client/UpgradeOffer";
import type { OfferPayloadView } from "../src/client/commercialApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FALLBACK =
  "Screens require payment while monetization is on. Start the run through the payment workflow (Stock Hub → Run a new screen) — no screen has started yet.";

function eligiblePayload(): OfferPayloadView {
  return {
    trigger: "manual_402",
    eligible: true,
    family: "stock",
    current: {
      effectiveTier: "Free",
      heldPlan: null,
      includedRunsRemaining: 0,
      packRunsRemaining: 0,
      creditsUSD: 0,
      freeRunsRemaining: 0,
      segment: "default",
    },
    targets: [
      {
        productId: "prod-basic",
        name: "Basic",
        versionId: "ver-basic-1",
        priceUSD: 49.99,
        approvalStatus: "approved",
        buyable: true,
        billingPeriod: "monthly",
        includedRuns: 20,
        periodDays: 30,
        trialDays: 7,
        features: [],
        effectiveFromMs: 1700000000000,
        recommended: true,
      },
    ],
    downgradeTargets: [],
    unavailableTargets: [],
    runsPacks: [],
    mentions: { referral: null, freeAccess: null },
    perRun: { family: "stock", priceUSD: 0.02, productId: "prod-perrun-stock", versionId: "ver-pr-1" },
    topUp: { minUSD: 1, maxUSD: 500 },
  };
}

interface Call {
  url: string;
  method: string | undefined;
  body: unknown;
}

const calls: Call[] = [];
let responder: (url: string, init?: RequestInit) => Promise<unknown> = async () => ({
  ok: true,
  status: 200,
  json: async () => eligiblePayload(),
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const err = (status: number) => ({ ok: false, status, json: async () => ({ error: "typed" }) });

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const navigations: string[] = [];

async function renderOffer(props: { runRequestId?: string; trigger?: "manual_402" | "quota_exhausted" } = {}) {
  calls.length = 0;
  navigations.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return responder(url, init);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(UpgradeOffer, {
        trigger: props.trigger ?? "manual_402",
        family: "stock",
        runRequestId: props.runRequestId,
        fallback: FALLBACK,
        navigate: (href: string) => navigations.push(href),
      }),
    );
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
  responder = async () => ok(eligiblePayload());
});

function text(): string {
  return container!.textContent || "";
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return Array.from(container!.querySelectorAll("button")).filter(
    (b) => (b.textContent || "").trim() === name,
  );
}

describe("UpgradeOffer fallback pins", () => {
  it("renders the fixed fallback immediately, with a loading line while the offer loads", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    responder = () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      });
    calls.length = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return responder(url, init);
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(UpgradeOffer, {
          trigger: "manual_402",
          family: "stock",
          fallback: FALLBACK,
          navigate: () => {},
        }),
      );
    });
    // The fetch has not resolved: the fallback is already on screen
    // with the loading line, and no comparison yet.
    expect(text()).toContain(FALLBACK);
    expect(text()).toContain("Loading upgrade options…");
    expect(text()).not.toContain("Compare plans");
    await act(async () => {
      resolveFetch(ok(eligiblePayload()));
    });
    await act(async () => {});
    await act(async () => {});
    expect(text()).toContain("Compare plans");
    expect(text()).not.toContain("Loading upgrade options…");
  });

  it("renders the fixed string only when the fetch rejects", async () => {
    responder = async () => {
      throw new Error("network down");
    };
    await renderOffer();
    expect(text()).toContain(FALLBACK);
    expect(text()).not.toContain("Loading upgrade options…");
    expect(text()).not.toContain("Compare plans");
    expect(buttonsNamed("Not now")).toHaveLength(0);
  });

  it("renders the fixed string only on a 503", async () => {
    responder = async () => err(503);
    await renderOffer();
    expect(text()).toContain(FALLBACK);
    expect(text()).not.toContain("Loading upgrade options…");
    expect(text()).not.toContain("Compare plans");
  });

  it("renders the fixed string only on a malformed payload", async () => {
    responder = async () => ok({ trigger: "manual_402", eligible: true });
    await renderOffer();
    expect(text()).toContain(FALLBACK);
    expect(text()).not.toContain("Compare plans");
  });

  it("renders the fixed string only when the payload is ineligible", async () => {
    responder = async () => ok({ ...eligiblePayload(), eligible: false, reasonCode: "FAILURE_OFFER_NO_TARGET", targets: [] });
    await renderOffer();
    expect(text()).toContain(FALLBACK);
    expect(text()).not.toContain("Compare plans");
    expect(buttonsNamed("Not now")).toHaveLength(0);
  });

  it("passes the run request id to the offer fetch when present", async () => {
    await renderOffer({ runRequestId: "run-42" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/payments/agentic/commercial/offer");
    expect(calls[0].body).toEqual({ trigger: "manual_402", family: "stock", runRequestId: "run-42" });
  });
});

describe("UpgradeOffer dismiss", () => {
  it("POSTs the dismiss route with the trigger and collapses to the fixed copy on success", async () => {
    responder = async (url: string) => {
      if (url.endsWith("/offer/dismiss")) return ok({ suppressedUntilMs: 123 });
      return ok(eligiblePayload());
    };
    await renderOffer();
    expect(text()).toContain("Compare plans");
    const notNow = buttonsNamed("Not now");
    expect(notNow).toHaveLength(1);
    await act(async () => {
      notNow[0].click();
    });
    await act(async () => {});
    await act(async () => {});
    const dismissCalls = calls.filter((c) => c.url.endsWith("/offer/dismiss"));
    expect(dismissCalls).toHaveLength(1);
    expect(dismissCalls[0].body).toEqual({ trigger: "manual_402", family: "stock" });
    expect(text()).toContain(FALLBACK);
    expect(text()).not.toContain("Compare plans");
    expect(buttonsNamed("Not now")).toHaveLength(0);
  });

  it("keeps the offer with a retry note when the dismiss fails", async () => {
    responder = async (url: string) => {
      if (url.endsWith("/offer/dismiss")) return err(503);
      return ok(eligiblePayload());
    };
    await renderOffer();
    await act(async () => {
      buttonsNamed("Not now")[0].click();
    });
    await act(async () => {});
    await act(async () => {});
    expect(text()).toContain("Compare plans");
    expect(text()).toContain("could not be saved");
    expect(buttonsNamed("Not now")).toHaveLength(1);
  });

  it("writes NO client-side suppression storage through fetch and dismiss", async () => {
    const localSet = vi.spyOn(window.localStorage, "setItem");
    const sessionSet = vi.spyOn(window.sessionStorage, "setItem");
    responder = async (url: string) => {
      if (url.endsWith("/offer/dismiss")) return ok({ suppressedUntilMs: 123 });
      return ok(eligiblePayload());
    };
    await renderOffer();
    await act(async () => {
      buttonsNamed("Not now")[0].click();
    });
    await act(async () => {});
    await act(async () => {});
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
  });
});

describe("UpgradeOffer navigation", () => {
  it("choosing a plan navigates to checkout with the target preselected and the trigger carried", async () => {
    await renderOffer();
    await act(async () => {
      buttonsNamed("Choose plan")[0].click();
    });
    expect(navigations).toHaveLength(1);
    const params = new URLSearchParams(navigations[0].replace(/^\?/, ""));
    expect(params.get("tab")).toBe("checkout");
    expect(params.get("checkoutTab")).toBe("subscriptions");
    expect(params.get("plan")).toBe("ver-basic-1");
    expect(params.get("offer")).toBe("manual_402");
  });

  it("buying credits navigates to the top-up tab with the trigger carried", async () => {
    await renderOffer();
    await act(async () => {
      buttonsNamed("Buy credits")[0].click();
    });
    expect(navigations).toHaveLength(1);
    const params = new URLSearchParams(navigations[0].replace(/^\?/, ""));
    expect(params.get("tab")).toBe("checkout");
    expect(params.get("checkoutTab")).toBe("topup");
    expect(params.get("offer")).toBe("manual_402");
  });

  it("carries the quota_exhausted trigger for the quota surface", async () => {
    responder = async () => ok({ ...eligiblePayload(), trigger: "quota_exhausted" });
    await renderOffer({ trigger: "quota_exhausted" });
    expect(calls[0].body).toMatchObject({ trigger: "quota_exhausted" });
    await act(async () => {
      buttonsNamed("Choose plan")[0].click();
    });
    const params = new URLSearchParams(navigations[0].replace(/^\?/, ""));
    expect(params.get("offer")).toBe("quota_exhausted");
  });
});
