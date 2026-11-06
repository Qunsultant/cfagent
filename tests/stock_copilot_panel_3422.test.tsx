/** @vitest-environment jsdom */

/**
 * Issue #3422 — Stock Copilot panel, rendered for real (react-dom).
 *
 * The stockCopilotApi module is mocked at the network boundary
 * only (the #2471 precedent): the panel's own logic — status
 * derivation display, positions/activity rendering, and the
 * pause/resume interaction — runs for real against the mocked
 * status payloads.
 *
 * #3398 extends the pins: the trading-sessions section renders the
 * user's enabled set with the current session marked, toggling a
 * session writes the full set through the control API, and the
 * outside-enabled-sessions state is named on the badge, in a
 * notice, and in the activity feed.
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
    setStockCopilotSessions: vi.fn(async (sessions: string[]) => {
      if (apiState.status) {
        apiState.status = { ...apiState.status, enabledSessions: sessions as never };
      }
      return { ok: true, sessions };
    }),
  };
});

import { StockCopilotPanel } from "../src/client/StockCopilotPanel";
import {
  setStockCopilotPaused,
  setStockCopilotSessions,
} from "../src/client/stockCopilotApi";

const liveStatus: StockCopilotStatus = {
  flagEnabled: true,
  paused: false,
  marketOpen: true,
  currentSession: "regular",
  enabledSessions: ["regular"],
  status: "live",
  selectionResolved: true,
  activeBroker: "alpaca",
  activeMode: "paper",
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
      entrySession: "regular",
      entryOrderType: "MARKET",
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
      session: "regular",
      entries: ["TEST"],
      exits: [],
      detail: null,
    },
    {
      id: "a2",
      cycleAt: "2026-11-04T14:30:00.000Z",
      outcome: "no_trade",
      session: "regular",
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

function checkboxByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const el = [...container.querySelectorAll("label")].find((l) =>
    (l.textContent ?? "").includes(label),
  );
  const input = el?.querySelector("input[type='checkbox']");
  if (!input) throw new Error(`checkbox not found: ${label}`);
  return input as HTMLInputElement;
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

  it("shows the effective broker + mode selection from the panel menu (#3451)", async () => {
    const { container, root } = await renderPanel();
    try {
      expect(container.textContent ?? "").toContain("Alpaca · Paper");
    } finally {
      root.unmount();
    }
  });

  it("inactive broker: the panel names the state and the active selection (#3451)", async () => {
    apiState.status = {
      ...liveStatus,
      status: "inactive_broker",
      activeBroker: "etrade",
      activeMode: "paper",
    };
    const { container, root } = await renderPanel();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("Inactive broker");
      expect(text).toContain("E*TRADE · Paper");
      expect(text).toContain("stays inactive");
    } finally {
      root.unmount();
    }
  });

  it("mode unresolved: the panel says the selection could not be read (#3451)", async () => {
    apiState.status = {
      ...liveStatus,
      status: "mode_unresolved",
      selectionResolved: false,
      activeBroker: null,
      activeMode: null,
    };
    const { container, root } = await renderPanel();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("Mode unresolved");
      expect(text).toContain("could not be read");
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

  it("sessions section: all four sessions render, only the enabled ones checked, the current one marked Now (#3398)", async () => {
    const { container, root } = await renderPanel();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("Trading sessions");
      expect(text).toContain("Overnight (EXTO)");
      expect(checkboxByLabel(container, "Regular").checked).toBe(true);
      expect(checkboxByLabel(container, "Pre-market").checked).toBe(false);
      expect(checkboxByLabel(container, "After-hours").checked).toBe(false);
      expect(checkboxByLabel(container, "Overnight (EXTO)").checked).toBe(false);
      // The current session (regular, in the fixture) carries the marker.
      const regularRow = checkboxByLabel(container, "Regular").closest(".scp-feed-row");
      expect(regularRow?.textContent ?? "").toContain("Now");
    } finally {
      root.unmount();
    }
  });

  it("toggling a session writes the full enabled set through the control API (#3398)", async () => {
    const { container, root } = await renderPanel();
    try {
      const box = checkboxByLabel(container, "Overnight (EXTO)");
      await act(async () => {
        box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flush();
      expect(setStockCopilotSessions).toHaveBeenCalledWith(["regular", "exto"]);
      expect(checkboxByLabel(container, "Overnight (EXTO)").checked).toBe(true);
    } finally {
      root.unmount();
    }
  });

  it("outside enabled sessions: the badge and notice name the waiting state, not off (#3398)", async () => {
    apiState.status = {
      ...liveStatus,
      status: "outside_enabled_sessions",
      currentSession: "after_hours",
      marketOpen: false,
    };
    const { container, root } = await renderPanel();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("Outside enabled sessions");
      expect(text).toContain("after-hours session is open");
      expect(text).toContain("waiting, not off");
    } finally {
      root.unmount();
    }
  });

  it("an outside_sessions activity record renders as the named waiting state (#3398)", async () => {
    apiState.status = {
      ...liveStatus,
      activity: [
        {
          id: "a9",
          cycleAt: "2026-11-04T21:30:00.000Z",
          outcome: "outside_sessions",
          session: "after_hours",
          entries: [],
          exits: [],
          detail: "stock_copilot_outside_enabled_sessions:after_hours",
        },
      ],
    };
    const { container, root } = await renderPanel();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("Outside sessions");
      expect(text).toContain("not one of your enabled sessions");
    } finally {
      root.unmount();
    }
  });
});
