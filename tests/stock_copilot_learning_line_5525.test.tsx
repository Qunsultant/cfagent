/** @vitest-environment jsdom */

/**
 * Issue #5525 — the panel shows the learning policy that explains a quiet
 * cycle.
 *
 * #5055 made prior learnings a plan input (`plan.learningsPolicy`). The
 * status payload's `lastCycle` is the activity record, which does not carry
 * `plan`; this change puts the policy into the record's existing `detail`
 * (the field the panel already renders as the cycle's "why") and renders a
 * dedicated line for it in the Loop-status section. No schema change.
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
    setStockCopilotPaused: vi.fn(async () => ({ ok: true, paused: false })),
    setStockCopilotSessions: vi.fn(async () => ({ ok: true, sessions: [] })),
  };
});

import { StockCopilotPanel } from "../src/client/StockCopilotPanel";
import { runStockCopilotAgenticCycle } from "../src/services/stockCopilotAgenticLoop";
import {
  createInMemoryStockCopilotActivityPort,
  createInMemoryStockCopilotMemoryPort,
  createInMemoryStockCopilotPositionPort,
} from "../src/data/createStockCopilotStorePorts";

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

let mounted: Root | null = null;

beforeEach(() => {
  apiState.status = baseStatus;
  apiState.failLoad = false;
  vi.clearAllMocks();
});

afterEach(() => {
  if (mounted) {
    act(() => mounted!.unmount());
    mounted = null;
  }
  document.body.innerHTML = "";
});

describe("Issue #5525 — the loop-status line explains a quiet cycle", () => {
  it("renders the policy sentence the cycle recorded in its detail", async () => {
    apiState.status = {
      ...baseStatus,
      lastCycle: {
        id: "cycle-1",
        userLogin: "owner",
        cycleAt: "2026-11-18T15:00:00Z",
        outcome: "no_trade",
        entries: [],
        exits: [],
        detail:
          "No active pattern setup met alpha hurdle — 2 risk learning(s) in the last 2: new entries blocked until the risk lesson ages out.",
      },
    };

    const { container, root } = await renderPanel();
    mounted = root;

    expect(container.textContent).toContain("Loop status");
    expect(container.textContent).toContain("risk learning");
    expect(container.textContent).toContain("new entries blocked");
  });

  it("stays quiet when the cycle recorded no policy", async () => {
    apiState.status = {
      ...baseStatus,
      lastCycle: {
        id: "cycle-2",
        userLogin: "owner",
        cycleAt: "2026-11-18T15:00:00Z",
        outcome: "no_trade",
        entries: [],
        exits: [],
        detail: "No active pattern setup met alpha hurdle",
      },
    };

    const { container, root } = await renderPanel();
    mounted = root;

    // The generic reason still renders once (the feed), but no policy line.
    expect(container.textContent).not.toContain("risk learning");
  });

  it("records the policy in the activity detail the panel reads", async () => {
    const memory = createInMemoryStockCopilotMemoryPort();
    memory.ensureSchema();
    for (const id of ["a", "b"]) {
      memory.recordLearning({
        id,
        userLogin: "owner",
        cycleId: "2026-11-18T15:00:00Z",
        timestamp: "2026-11-18T15:00:00Z",
        category: "risk",
        insight: "CVaR bound sizing",
        sourceVerdict: "accept",
      });
    }
    const activity = createInMemoryStockCopilotActivityPort();
    const closes: number[] = [];
    for (let k = 0; k < 8; k++) closes.push(100, 98, 101);
    closes.push(100, 98);

    await runStockCopilotAgenticCycle({
      env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
      selection: {
        resolved: true,
        selection: { brokerId: "alpaca", environment: "TEST", mode: "paper" },
      },
      userLogin: "owner",
      platform: {
        platformId: "alpaca",
        name: "fake",
        async getPositions() {
          return { account: { netAccountValue: 1, totalAccountValue: 1, buyingPower: 1 }, positions: [] };
        },
        async getQuote(symbol: string) {
          return { symbol, lastPrice: 100 };
        },
        async placeOrderRemote() {
          throw new Error("no order expected while entries are blocked");
        },
      } as any,
      positions: createInMemoryStockCopilotPositionPort(),
      activity,
      memory,
      universe: ["TEST"],
      strategies: ["mean_reversion"],
      loadBars: async () => closes,
      now: () => new Date("2026-11-18T15:00:00Z"),
    });

    const [record] = activity.listActivity("owner", 1);
    expect(record.outcome).toBe("no_trade");
    expect(record.detail).toContain("risk learning");
    expect(record.detail).toContain("new entries blocked");
  });
});
