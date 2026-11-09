/**
 * @vitest-environment jsdom
 *
 * Issue #3728: Platform-wide mode synchronization and search bar UI cleanup.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  getBrokerEnvironment,
  switchBrokerEnvironment,
  BROKER_ENV_CHANGED_EVENT,
} from "../src/client/brokerEnvironment";
import { StockSearchBar } from "../src/client/components/StockSearchBar";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Issue #3728: Platform-wide mode sync and optimistic broadcast", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("switchBrokerEnvironment optimistically updates current and broadcasts event", async () => {
    let broadcastedEnv: string | null = null;
    const handleEvent = (e: Event) => {
      broadcastedEnv = (e as CustomEvent).detail?.env;
    };
    window.addEventListener(BROKER_ENV_CHANGED_EVENT, handleEvent);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, environment: "PROD" }),
      })) as any,
    );

    try {
      // Issue #3857: TEST is now the default, so switching to TEST is a
      // no-op (no broadcast). The optimistic-update behaviour is pinned
      // by switching to PROD instead. The switch leaves PROD behind;
      // this file's other tests do not read the environment.
      const switchPromise = switchBrokerEnvironment("PROD");
      // Current should immediately be PROD even before promise resolves
      expect(getBrokerEnvironment()).toBe("PROD");
      expect(broadcastedEnv).toBe("PROD");
      await switchPromise;
      expect(getBrokerEnvironment()).toBe("PROD");
    } finally {
      window.removeEventListener(BROKER_ENV_CHANGED_EVENT, handleEvent);
      vi.unstubAllGlobals();
    }
  });
});

describe("Issue #3728: StockSearchBar UI cleanup (no redundant broker badge next to Ctrl+K)", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    if (root) root.unmount();
    if (container) container.remove();
    vi.unstubAllGlobals();
  });

  it("does not render broker badge next to the search input button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any,
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<StockSearchBar onSelectTab={() => {}} onAskAgent={() => {}} />);
    });

    // The trigger container should have the search button and kbd, but not a separate broker badge
    const trigger = container.querySelector(".stock-search-trigger-btn");
    expect(trigger).not.toBeNull();
    const kbd = container.querySelector(".stock-search-kbd");
    expect(kbd).not.toBeNull();

    // No badge next to the search trigger
    const badges = container.querySelectorAll(".stock-search-trigger-container .badge");
    expect(badges.length).toBe(0);
  });
});
