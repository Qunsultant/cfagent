/** @vitest-environment jsdom */
/**
 * Issue #4649 — Gap 1 of #4634: Public.com must never read "Paper".
 *
 * Pinned here:
 *  - the fact "this broker has a paper mode" is DECLARED in the broker catalog
 *    (total by type), not inferred by a surface;
 *  - the crumb (`brokerModeLabel`) never renders "Paper" for a broker with no
 *    paper account, and still renders it for the brokers that have one;
 *  - the predicates behind the Notice and the confirmation (which broker needs
 *    live, which switch needs a confirm) answer for the impossible pair only;
 *  - the dialog copy names the broker, the real-money consequence and — for a
 *    no-paper broker — why live is the only placeable mode;
 *  - the settings menu, in the impossible `public + TEST` state, SHOWS the
 *    standing Notice; selecting Public while on a paper-capable broker asks
 *    first (no POST), and confirming stores the broker AND flips the mode to
 *    PROD. Cancelling stores nothing.
 *
 * No network: every request goes through a stubbed fetch.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { brokerHasPaperMode, ROUTED_BROKER_IDS } from "../src/trading";
import { brokerCanSimulate, brokerModeLabel } from "../src/client/brokerEnvironment";
import {
  brokerRequiresLiveMode,
  liveModeConfirmCopy,
  liveOnlyNoticeCopy,
  needsLiveModeForBroker,
  requiresLiveModeConfirm,
} from "../src/client/trading/liveMode";
import { BrokerDynamicMenu } from "../src/client/BrokerDynamicMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("#4649 — the broker's paper-mode capability is declared once", () => {
  it("declares paperMode for every routed broker, and only Public has none", () => {
    for (const broker of ROUTED_BROKER_IDS) {
      expect(typeof brokerHasPaperMode(broker), broker).toBe("boolean");
    }
    expect(brokerHasPaperMode("public")).toBe(false);
    expect(brokerHasPaperMode("etrade")).toBe(true);
    expect(brokerHasPaperMode("alpaca")).toBe(true);
  });

  it("treats an unknown broker as paper-capable (never claims it is live-only)", () => {
    expect(brokerCanSimulate("not-a-broker")).toBe(true);
    expect(brokerCanSimulate(undefined)).toBe(true);
    expect(brokerRequiresLiveMode("not-a-broker")).toBe(false);
  });
});

describe("#4649 — the crumb never shows Paper for a no-paper broker", () => {
  it("renders Public.com as Live Execution in both stored modes", () => {
    for (const accountMode of ["paper", "live"] as const) {
      expect(brokerModeLabel({ broker: "public", brokerLabel: "Public.com", accountMode })).toBe(
        "Public.com / Live Execution",
      );
    }
  });

  it("keeps the paper word for brokers that really simulate", () => {
    expect(brokerModeLabel({ broker: "etrade", brokerLabel: "E*TRADE", accountMode: "paper" })).toBe(
      "E*TRADE / Paper",
    );
    expect(brokerModeLabel({ broker: "alpaca", brokerLabel: "Alpaca", accountMode: "paper" })).toBe(
      "Alpaca / Paper",
    );
    expect(brokerModeLabel({ broker: "alpaca", brokerLabel: "Alpaca", accountMode: "live" })).toBe(
      "Alpaca / Live Execution",
    );
  });

  it("keeps the old rendering for an unrecognised broker id", () => {
    expect(brokerModeLabel({ broker: "mystery", brokerLabel: "Selected broker", accountMode: "paper" })).toBe(
      "Selected broker / Paper",
    );
  });
});

describe("#4649 — the Notice and the confirmation answer for the impossible pair only", () => {
  it("needs live only for a no-paper broker while the stored mode is paper", () => {
    expect(needsLiveModeForBroker("public", "TEST")).toBe(true);
    expect(needsLiveModeForBroker("public", "PROD")).toBe(false);
    expect(needsLiveModeForBroker("etrade", "TEST")).toBe(false);
    expect(needsLiveModeForBroker("alpaca", "TEST")).toBe(false);
  });

  it("confirms only the TEST→PROD direction", () => {
    expect(requiresLiveModeConfirm("PROD", "TEST")).toBe(true);
    expect(requiresLiveModeConfirm("PROD", "PROD")).toBe(false);
    expect(requiresLiveModeConfirm("TEST", "PROD")).toBe(false);
  });

  it("names the broker, the real-money consequence, and the no-paper reason", () => {
    const publicCopy = liveModeConfirmCopy({ brokerLabel: "Public.com", broker: "public" });
    expect(publicCopy.title).toContain("Public.com");
    expect(publicCopy.body.join(" ")).toMatch(/real money/i);
    expect(publicCopy.body.join(" ")).toMatch(/no paper trading mode/i);
    expect(publicCopy.confirmLabel).toMatch(/live/i);

    const etradeCopy = liveModeConfirmCopy({ brokerLabel: "E*TRADE", broker: "etrade" });
    expect(etradeCopy.body.join(" ")).toMatch(/real money/i);
    expect(etradeCopy.body.join(" ")).not.toMatch(/no paper trading mode/i);
  });

  it("states that the standing Notice does not block preview", () => {
    const notice = liveOnlyNoticeCopy({ brokerLabel: "Public.com" });
    expect(notice.title).toContain("Public.com");
    expect(notice.body).toMatch(/preview/i);
    expect(notice.body).toMatch(/refused/i);
  });
});

describe("#4649 — the settings menu discloses and confirms", () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: { url: string; method: string; body?: string }[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    calls = [];
    window.localStorage.setItem("cfagent_tenant_broker", "public");
    window.localStorage.setItem("cfagent_tenant_data_provider", "alpaca");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
        const target = String(url);
        const method = init?.method ?? "GET";
        calls.push({ url: target, method, body: typeof init?.body === "string" ? init.body : undefined });
        // Echo the two writes this flow makes, so the client keeps its state.
        if (target.includes("/api/tenant/settings/providers") && method === "POST") {
          return { ok: true, status: 200, json: async () => JSON.parse(String(init?.body)), text: async () => "" } as unknown as Response;
        }
        if (target.includes("/api/environment/switch") && method === "POST") {
          return { ok: true, status: 200, json: async () => JSON.parse(String(init?.body)), text: async () => "" } as unknown as Response;
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => "",
          headers: { get: () => null },
        } as unknown as Response;
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement | undefined {
    return Array.from(scope.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes(text),
    ) as HTMLButtonElement | undefined;
  }

  async function click(element: HTMLButtonElement | undefined) {
    expect(element, "button not found").toBeTruthy();
    await act(async () => {
      element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  }

  it("shows the standing Notice for public+TEST, asks before selecting Public, and flips the mode on confirm", async () => {
    await act(async () => {
      root.render(<BrokerDynamicMenu initialOpen />);
      await Promise.resolve();
    });

    // 1. The impossible pair is disclosed, persistently, without blocking.
    expect(container.textContent).toContain("Public.com has no paper mode");
    expect(container.textContent).toMatch(/preview and data only/i);

    // 2. A paper-capable broker selection is stored immediately — no dialog.
    await click(buttonByText("Alpaca"));
    expect(calls.some((c) => c.url.includes("/api/tenant/settings/providers") && c.body?.includes('"alpaca"'))).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain("Public.com has no paper mode");

    // 3. Selecting Public while in paper mode asks first, and stores NOTHING yet.
    const providersBefore = calls.filter((c) => c.url.includes("/api/tenant/settings/providers")).length;
    await click(buttonByText("Public.com"));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Switch to live trading on Public.com?");
    expect(dialog!.textContent).toMatch(/real money/i);
    expect(calls.filter((c) => c.url.includes("/api/tenant/settings/providers")).length).toBe(providersBefore);
    expect(calls.some((c) => c.url.includes("/api/environment/switch"))).toBe(false);

    // 4. Confirming stores the broker AND flips the mode to PROD.
    await click(buttonByText("Switch to live trading", dialog!));
    expect(calls.some((c) => c.url.includes("/api/tenant/settings/providers") && c.body?.includes('"public"'))).toBe(true);
    expect(
      calls.some((c) => c.url.includes("/api/environment/switch") && c.body?.includes('"PROD"')),
    ).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
