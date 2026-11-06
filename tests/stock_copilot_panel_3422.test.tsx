/** @vitest-environment jsdom */

/**
 * Issue #3422 — Stock Copilot panel, rendered for real (react-dom).
 *
 * The stockCopilotApi module is mocked at the network boundary
 * only (the #2471 precedent): the panel's own logic — status
 * derivation display, positions/activity rendering, and the
 * pause/resume interaction — runs for real against the mocked
 * status payloads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StockCopilotStatus } from "../src/client/stockCopilotApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const apiState = vi.hoisted(() => ({
  status: null as StockCopilotStatus | null,
  failLoad: false,
}));

vi.mock("../src/client/stockCopilotApi", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    fetchStockCopilotStatus: vi.fn(async () => {
      if (apiState.failLoad || !apiState.status) throw new Error("load failed");
      return apiState.status;
    }),
    setStockCopilotPaused: vi.fn(async (paused: boolean) => {
      if (apiState.status) {
        apiState.status = {
          ...apiState.status,
          paused,
          status: paused ? "paused" : "live",
        };
      }
      return { ok: true, paused };
    }),
  };
});

import { StockCopilotPanel } from "../src/client/StockCopilotPanel";
import { setStockCopilotPaused } from "../src/client/stockCopilotApi";

const liveStatus: StockCopilotStatus = {
  flagEnabled: true,
  paused: false,
  marketOpen: true,
  status: "live",
  userLogin: "owner",
  controlUpdatedAt: null,
  openPositions: [
    {
      id: "p1",
      symbol: "TEST",
      strategy: "mean_reversion",
      quantity: 153,
      entryPrice: 98,
      stopPrice: 93.1,
      targetPrice: 107.8,
      brokerOrderRef: "alpaca-1",
      openedAt: "2026-11-04T15:00:00.000Z",
    },
  ],
  closedPositions: [
    {
      id: "p0",
      symbol: "OLD",
      strategy: "sma_crossover",
      quantity: 5,
      entryPrice: 100,
      exitPrice: 110,
      exitReason: "take_profit",
      openedAt: "2026-11-03T15:00:00.000Z",
      closedAt: "2026-11-04T14:45:00.000Z",
    },
  ],
  activity: [
    {
      id: "a1",
      cycleAt: "2026-11-04T15:00:00.000Z",
      outcome: "traded",
      entries: ["TEST"],
      exits: [],
      detail: null,
    },
    {
      id: "a2",
      cycleAt: "2026-11-04T14:30:00.000Z",
      outcome: "no_trade",
      entries: [],
      exits: [],
      detail: "no_entry_signals",
    },
  ],
};

const flush = async (times = 5) => {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

async function renderPanel() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<StockCopilotPanel />);
  });
  await flush();
  return { container, root };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn as HTMLButtonElement;
}

beforeEach(() => {
  apiState.status = liveStatus;
  apiState.failLoad = false;
  vi.clearAllMocks();
});

afterEach(async () => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("StockCopilotPanel (#3422)", () => {
  it("renders live status, the open position WITH its exit plan, closed history, and cycle activity", async () => {
    const { container, root } = await renderPanel();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("Stock Copilot");
      expect(text).toContain("Live");
      // Open position with the full exit plan visible.
      expect(text).toContain("TEST");
      expect(text).toContain("$98.00");
      expect(text).toContain("$93.10");
      expect(text).toContain("$107.80");
      // Recently closed carries its exit reason.
      expect(text).toContain("OLD");
      expect(text).toContain("Take profit");
      // Activity feed shows both outcomes.
      expect(text).toContain("Bought TEST");
      expect(text).toContain("no_entry_signals");
      // The pause control is offered.
      expect(buttonByText(container, "Pause entries")).toBeTruthy();
    } finally {
      root.unmount();
    }
  });

  it("pause: clicking Pause entries writes the control and the panel shows Paused with the exits-still-managed notice", async () => {
    const { container, root } = await renderPanel();
    try {
      const btn = buttonByText(container, "Pause entries");
      await act(async () => {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flush();
      expect(setStockCopilotPaused).toHaveBeenCalledWith(true);
      const text = container.textContent ?? "";
      expect(text).toContain("Paused");
      expect(text).toContain("still");
      expect(text).toContain("managed");
      expect(buttonByText(container, "Resume entries")).toBeTruthy();
    } finally {
      root.unmount();
    }
  });

  it("off: with the master flag off the panel says so and the pause control is disabled", async () => {
    apiState.status = { ...liveStatus, flagEnabled: false, status: "off" };
    const { container, root } = await renderPanel();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("Off");
      expect(text).toContain("master switch is off");
      expect(buttonByText(container, "Pause entries").disabled).toBe(true);
    } finally {
      root.unmount();
    }
  });

  it("load failure shows a retry, never a fabricated status", async () => {
    apiState.failLoad = true;
    const { container, root } = await renderPanel();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("could not be loaded");
      expect(text).not.toContain("Live");
      expect(buttonByText(container, "Try again")).toBeTruthy();
    } finally {
      root.unmount();
    }
  });
});
