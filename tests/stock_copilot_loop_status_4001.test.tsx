/** @vitest-environment jsdom */

/**
 * Issue #4001 (follow-up) — the cycle fires but the panel shows no loop
 * status: no `lastCycle`, no firing attempt, no never-executed state as a
 * field.
 *
 * RED pins (TDD, written against main before the fix — each must FAIL
 * there and pass after):
 *
 * The 13:05 and 14:05 firings ran cleanly, but the #4024 probe marker
 * was not observed on any UI surface: `src/client/StockCopilotPanel.tsx`
 * contains zero references to `lastCycle` or `lastCycleFiringAttempt`,
 * and the copilot chat page has no loop-status panel. The status API
 * already returns both fields — the gap is surfacing only.
 *
 * Fix: render a Loop status section on the Stock Copilot panel (existing
 * primitives and classes only, no new styles) showing the last recorded
 * cycle, the last firing attempt the handler entered, and the
 * never-executed state when nothing has ever been recorded.
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

const baseStatus: StockCopilotStatus = {
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
  openPositions: [],
  closedPositions: [],
  activity: [],
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

beforeEach(() => {
  apiState.status = baseStatus;
  apiState.failLoad = false;
  vi.clearAllMocks();
});

afterEach(async () => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("StockCopilotPanel loop status (#4001 follow-up)", () => {
  it("shows the last recorded cycle and the last firing attempt", async () => {
    apiState.status = {
      ...baseStatus,
      neverExecuted: false,
      lastCycle: {
        id: "a9",
        cycleAt: "2026-11-10T19:05:10.000Z",
        outcome: "no_trade",
        session: "regular",
        entries: [],
        exits: [],
        detail: "no_entry_signals",
      },
      lastCycleFiringAttempt: {
        taskId: "stock-copilot-paper-cycle",
        scheduledFor: Date.parse("2026-11-10T19:05:08.000Z"),
        occurrenceKey: "4001-test-1",
        receivedAt: "2026-11-10T19:05:10.000Z",
      },
      lastCycleNotDeclared: null,
      activity: [
        {
          id: "a9",
          cycleAt: "2026-11-10T19:05:10.000Z",
          outcome: "no_trade",
          session: "regular",
          entries: [],
          exits: [],
          detail: "no_entry_signals",
        },
      ],
    };
    const { container, root } = await renderPanel();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("Loop status");
      expect(text).toContain("Last cycle");
      expect(text).toContain("No trade");
      expect(text).toContain("Last firing");
      expect(text).toContain("stock-copilot-paper-cycle");
    } finally {
      root.unmount();
    }
  });

  it("names the never-executed state when no cycle and no firing are recorded", async () => {
    apiState.status = {
      ...baseStatus,
      status: "never_executed",
      neverExecuted: true,
      lastCycle: null,
      lastCycleFiringAttempt: null,
      lastCycleNotDeclared: null,
      activity: [],
    };
    const { container, root } = await renderPanel();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("Loop status");
      expect(text).toContain("No cycle recorded yet");
      expect(text).toContain("No firing recorded yet");
    } finally {
      root.unmount();
    }
  });

  it("names the not-declared reason when the task was last not declared", async () => {
    apiState.status = {
      ...baseStatus,
      status: "never_executed",
      neverExecuted: true,
      lastCycle: null,
      lastCycleFiringAttempt: null,
      lastCycleNotDeclared: {
        cause: "no_login_context",
        atMs: Date.parse("2026-11-10T18:05:08.000Z"),
      },
      activity: [],
    };
    const { container, root } = await renderPanel();
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("Loop status");
      expect(text).toContain("Not declared");
      expect(text).toContain("no_login_context");
    } finally {
      root.unmount();
    }
  });
});
