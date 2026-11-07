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
        json: async () => ({ success: true, environment: "TEST" }),
      })) as any,
    );

    try {
      const switchPromise = switchBrokerEnvironment("TEST");
      // Current should immediately be TEST even before promise resolves
      expect(getBrokerEnvironment()).toBe("TEST");
      expect(broadcastedEnv).toBe("TEST");
      await switchPromise;
      expect(getBrokerEnvironment()).toBe("TEST");
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
