/** @vitest-environment jsdom */
/**
 * Issue #3121 sub-issue #3361 — restore candidate prefill from the
 * de-hubbed schedules home.
 *
 * S2 de-hubbed `?tab=schedules`: the home renders from the shell
 * (Chat.tsx), not through the retained ETradeTradingHub, and the hub
 * owned the order-ticket prefill (hub-local order state). The home's
 * `onPreviewTrade` dropped the candidate and navigated to the order
 * tab bare, so the ticket opened unprefilled.
 *
 * The fix has two halves:
 * (1) Convert the live-result preview candidate (a StrategyCandidate)
 *     to a TradeOrderContext with the canonical field mapping — the
 *     same mapping OptionsResearchPanel.toTradeContext and
 *     ScannerPanel.matrixCellTradeContext use (symbol, action from
 *     thesis, quantity 1, legs, label, strategyNetDebit). The hub-era
 *     call passed the raw candidate straight to handleTradeOrder
 *     (hidden by the `(candidate: any)` prop type), so the ticket got
 *     symbol + limit price but no side, quantity, or legs; #3361
 *     restores the prefill as intended, not the latent mistyping.
 * (2) Carry the context to the hub without re-hosting the home in it:
 *     a shell-level handoff — Chat owns a `pendingOrderContext` state
 *     (the pendingPrompt idiom), the home's preview hands the context
 *     to the shell, and the hub consumes it through its own
 *     handleTradeOrder when the order sub-tab becomes active. The
 *     URL-carried alternative was evaluated and rejected: a trading
 *     payload does not belong in the URL/history, and the #3038
 *     one-shot precedent carries a single enum, not a payload.
 *
 * Pins:
 * - 3361-P01 the converter maps candidate → TradeOrderContext
 *   (options / equity / bearish / unbounded-max-loss / no-price).
 * - 3361-P02 the live-result preview calls onPreviewTrade with the
 *   converted context (render test, both theses).
 * - 3361-P03 the shell handoff wiring: Chat owns the pending context,
 *   the home hands the candidate through, the hub consumes it on the
 *   order sub-tab; no URL-carried context; the home stays de-hubbed.
 * - 3361-P04 the preview chain is typed TradeOrderContext end to end
 *   (the latent `(candidate: any)` mistyping is gone).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { candidateToTradeContext } from "../src/client/trading/tradeOrderContext";
import type { StrategyCandidate } from "../src/trading/options/strategyEngine";
import { LiveResultPreview } from "../src/client/scheduledOptionsManager/LiveResultPreview";

const here = join(process.cwd());
function read(rel: string): string {
  return readFileSync(join(here, rel), "utf8").replace(/\r\n/g, "\n");
}

function optionsCandidate(over: Record<string, unknown> = {}): StrategyCandidate {
  return {
    symbol: "AAPL",
    label: "Bull Call Spread",
    expirationDate: "2026-12-18",
    underlyingPrice: 250,
    netDebit: 1.25,
    maxLoss: 125,
    maxProfit: 375,
    maxProfitUnbounded: false,
    legs: [
      {
        symbol: "AAPL",
        optionType: "CALL",
        side: "BUY",
        quantity: 1,
        strike: 250,
        expirationDate: "2026-12-18",
        entryPrice: 2.5,
      },
      {
        symbol: "AAPL",
        optionType: "CALL",
        side: "SELL",
        quantity: 1,
        strike: 260,
        expirationDate: "2026-12-18",
        entryPrice: 1.25,
      },
    ],
    ...over,
  } as unknown as StrategyCandidate;
}

describe("3361-P01 candidate → TradeOrderContext mapping (#3361)", () => {
  it("maps an options candidate: symbol, BUY, quantity 1, legs, label, net debit", () => {
    const ctx = candidateToTradeContext(optionsCandidate(), "bullish", 250);
    expect(ctx.assetClass).toBe("options");
    expect(ctx.symbol).toBe("AAPL");
    expect(ctx.action).toBe("BUY");
    expect(ctx.quantity).toBe(1);
    expect(ctx.underlyingPrice).toBe(250);
    expect(ctx.label).toBe("Bull Call Spread (2026-12-18), max loss $125");
    expect(ctx.legs).toEqual(["BUY 1 AAPL @ $2.50", "SELL 1 AAPL @ $1.25"]);
    expect(ctx.optionLegs).toEqual([
      {
        securityType: "OPTN",
        side: "BUY",
        quantity: 1,
        optionType: "CALL",
        strike: 250,
        expirationDate: "2026-12-18",
      },
      {
        securityType: "OPTN",
        side: "SELL",
        quantity: 1,
        optionType: "CALL",
        strike: 260,
        expirationDate: "2026-12-18",
      },
    ]);
    expect(ctx.strategyNetDebit).toBe(1.25);
  });

  it("maps a bearish thesis to SELL_SHORT", () => {
    const ctx = candidateToTradeContext(optionsCandidate(), "bearish", 250);
    expect(ctx.action).toBe("SELL_SHORT");
  });

  it("maps an all-stock candidate to equity with EQ legs and no strike/expiry", () => {
    const ctx = candidateToTradeContext(
      optionsCandidate({
        legs: [
          {
            symbol: "AAPL",
            optionType: "STOCK",
            side: "BUY",
            quantity: 10,
            strike: 0,
            expirationDate: "",
            entryPrice: 250,
          },
        ],
      }),
      "bullish",
      250,
    );
    expect(ctx.assetClass).toBe("equity");
    expect(ctx.optionLegs).toEqual([
      { securityType: "EQ", side: "BUY", quantity: 10, optionType: undefined, strike: undefined, expirationDate: undefined },
    ]);
  });

  it("labels an unbounded max loss as unlimited, never a dollar figure", () => {
    const ctx = candidateToTradeContext(optionsCandidate({ maxLoss: null }), "bullish", 250);
    expect(ctx.label).toBe("Bull Call Spread (2026-12-18), max loss unlimited");
  });

  it("omits the underlying price when none is known — never invents one", () => {
    const ctx = candidateToTradeContext(optionsCandidate(), "bullish");
    expect(ctx.underlyingPrice).toBeUndefined();
  });
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function liveResult(candidate: StrategyCandidate, underlyingPrice = 250) {
  return {
    summary: "Live run found 1 actionable setup.",
    notifications: {},
    opportunities: [
      {
        symbol: "AAPL",
        score: 82,
        underlyingPrice,
        pick: { best: { candidate } },
      },
    ],
  };
}

describe("3361-P02 the preview hands the converted context up (#3361)", () => {
  it("bearish preview-trade calls onPreviewTrade with SELL_SHORT and the legs", async () => {
    const onPreviewTrade = vi.fn();
    await render(
      <LiveResultPreview
        liveResult={liveResult(optionsCandidate())}
        thesis="bearish"
        onPreviewTrade={onPreviewTrade}
      />,
    );
    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Preview in Order Ticket"),
    ) as HTMLElement;
    expect(button).toBeTruthy();
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onPreviewTrade).toHaveBeenCalledTimes(1);
    const ctx = onPreviewTrade.mock.calls[0][0];
    expect(ctx.assetClass).toBe("options");
    expect(ctx.symbol).toBe("AAPL");
    expect(ctx.action).toBe("SELL_SHORT");
    expect(ctx.quantity).toBe(1);
    expect(ctx.optionLegs).toHaveLength(2);
    expect(ctx.strategyNetDebit).toBe(1.25);
    expect(ctx.underlyingPrice).toBe(250);
  });

  it("bullish preview-trade calls onPreviewTrade with BUY", async () => {
    const onPreviewTrade = vi.fn();
    await render(
      <LiveResultPreview
        liveResult={liveResult(optionsCandidate())}
        thesis="bullish"
        onPreviewTrade={onPreviewTrade}
      />,
    );
    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Preview in Order Ticket"),
    ) as HTMLElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onPreviewTrade).toHaveBeenCalledTimes(1);
    expect(onPreviewTrade.mock.calls[0][0].action).toBe("BUY");
  });
});

describe("3361-P03 the shell handoff wiring (#3361)", () => {
  it("Chat owns a pending order context and hands it to the home and the hub", () => {
    const chat = read("src/client/Chat.tsx");
    expect(chat).toContain("pendingOrderContext");
    expect(chat).toContain("setPendingOrderContext");
    expect(chat).toContain("<SchedulesHome");
    expect(chat).toContain("onPreviewTrade={");
    expect(chat).toContain("pendingOrderContext={pendingOrderContext}");
    expect(chat).toContain("onConsumePendingOrderContext");
  });

  it("the hub consumes the pending context through handleTradeOrder on the order sub-tab", () => {
    const hub = read("src/client/ETradeTradingHub.tsx");
    expect(hub).toContain("pendingOrderContext");
    expect(hub).toContain("onConsumePendingOrderContext");
    expect(hub).toContain("handleTradeOrder(pendingOrderContext)");
  });

  it("the home no longer drops the candidate on preview-trade", () => {
    const home = read("src/client/SchedulesHome.tsx");
    expect(home).not.toContain('onPreviewTrade={() => navigateToTab("order")}');
    expect(home).toContain("onPreviewTrade");
  });

  it("no URL-carried order context exists anywhere on the path", () => {
    for (const rel of [
      "src/client/Chat.tsx",
      "src/client/SchedulesHome.tsx",
      "src/client/ETradeTradingHub.tsx",
      "src/client/SchedulesPanel.tsx",
      "src/client/ScheduledOptionsManager.tsx",
    ]) {
      expect(read(rel)).not.toContain("orderCtx");
    }
  });

  it("the home stays de-hubbed: the shell renders it, the hub never hosts it", () => {
    const chat = read("src/client/Chat.tsx");
    expect(chat).toContain("schedules: (");
    expect(chat).toContain("<SchedulesHome");
    const hub = read("src/client/ETradeTradingHub.tsx");
    expect(hub).not.toContain('from "./SchedulesHome"');
    expect(hub).not.toContain('from "./SchedulesPanel"');
    expect(hub).not.toContain("<SchedulesHome");
    expect(hub).not.toContain("<SchedulesPanel");
  });
});

describe("3361-P04 the preview chain is typed TradeOrderContext end to end (#3361)", () => {
  it("no (candidate: any) remains on the preview path", () => {
    for (const rel of [
      "src/client/SchedulesPanel.tsx",
      "src/client/ScheduledOptionsManager.tsx",
      "src/client/scheduledOptionsManager/types.ts",
      "src/client/scheduledOptionsManager/LiveResultPreview.tsx",
    ]) {
      expect(read(rel)).not.toContain("(candidate: any)");
    }
  });

  it("each hop types onPreviewTrade as a TradeOrderContext callback", () => {
    for (const rel of [
      "src/client/SchedulesPanel.tsx",
      "src/client/scheduledOptionsManager/types.ts",
      "src/client/scheduledOptionsManager/LiveResultPreview.tsx",
    ]) {
      expect(read(rel)).toContain("onPreviewTrade?: (ctx: TradeOrderContext) => void");
    }
  });
});
