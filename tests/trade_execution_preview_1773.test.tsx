/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  buildExecutePayload,
  buildTradeExecutionPreview,
  type TradeExecutionDraft,
} from "../src/client/tradeExecutionPreviewModel";
import { TradeExecutionPreview } from "../src/client/TradeExecutionPreview";

/**
 * OWASP ASI-02 action transparency (Qunsultant/cfagent#1773, item 6):
 * before a trade executes, the approval surface must show the EXACT
 * execution payload, the fees, and the slippage limits — not a
 * summary. The exact payload is the body
 * ETradeTradingHub.handleExecuteDraft POSTs to /api/broker/order/execute
 * (orderId, draftId, decision, symbol, action, quantity, orderType,
 * limitPrice, previewId); execution itself is driven by the stored
 * draft (src/agents/routes/brokerOrders.ts), so the preview also
 * restates the draft terms the server will execute. Fees: the draft
 * carries exactly one fee field (estimatedCommission) — the preview
 * states that and does not invent other fees. Slippage: a LIMIT
 * bounds the fill at the limit price; a MARKET order has no bound
 * and the preview must say so, never imply one.
 */

const EQUITY_LIMIT: TradeExecutionDraft = {
  orderId: "ord_abc123",
  symbol: "NVDA",
  action: "BUY",
  orderAction: "BUY",
  orderType: "LIMIT",
  quantity: 10,
  estimatedPrice: 125.5,
  limitPrice: 125.5,
  term: "GOOD_FOR_DAY",
  estimatedCommission: 0,
  estimatedTotal: 1255,
  status: "previewed",
  proposerDid: "did:agent:openaimp:trading",
  authorizerDid: "did:user:github:alice",
  proofSignature: "sig_0x1234",
  previewMessage: "preview",
  previewId: "p123",
};

const MARKET: TradeExecutionDraft = {
  ...EQUITY_LIMIT,
  orderId: "ord_mkt9",
  orderType: "MARKET",
  limitPrice: undefined,
  previewId: undefined,
};

const OPTIONS: TradeExecutionDraft = {
  ...EQUITY_LIMIT,
  orderId: "ord_opt7",
  brokerOrderType: "SPREADS",
  optionLegs: [
    { underlyingSymbol: "NVDA", securityType: "OPTN", side: "BUY", quantity: 10, optionType: "CALL", strike: 130, expirationDate: "2026-12-18" },
    { underlyingSymbol: "NVDA", securityType: "OPTN", side: "SELL", quantity: 10, optionType: "CALL", strike: 140, expirationDate: "2026-12-18" },
  ],
  strategyNetDebit: 250,
  estimatedCommission: 13,
};

describe("buildExecutePayload (#1773, ASI-02)", () => {
  it("equals the exact body handleExecuteDraft sends for an equity LIMIT draft", () => {
    expect(buildExecutePayload(EQUITY_LIMIT)).toEqual({
      orderId: "ord_abc123",
      draftId: "ord_abc123",
      decision: "approved",
      symbol: "NVDA",
      action: "BUY",
      quantity: 10,
      orderType: "LIMIT",
      limitPrice: 125.5,
      previewId: "p123",
    });
  });

  it("omits limitPrice and previewId for a MARKET draft without them, like JSON.stringify does", () => {
    const payload = buildExecutePayload(MARKET);
    expect(payload).not.toHaveProperty("limitPrice");
    expect(payload).not.toHaveProperty("previewId");
    expect(payload.orderType).toBe("MARKET");
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("never sends a decision other than approved from the preview builder", () => {
    expect(buildExecutePayload(OPTIONS).decision).toBe("approved");
  });
});

describe("buildTradeExecutionPreview fees (#1773, ASI-02)", () => {
  it("states the commission exactly as the draft states it, including $0.00 equity", () => {
    const preview = buildTradeExecutionPreview(EQUITY_LIMIT);
    expect(preview.fees.join(" ")).toContain("$0.00");
  });

  it("states the options commission and the estimated total", () => {
    const preview = buildTradeExecutionPreview(OPTIONS);
    expect(preview.fees.join(" ")).toContain("$13.00");
    expect(preview.fees.join(" ")).toContain("$1,255.00");
  });

  it("admits other fees are not itemized by the preview instead of inventing them", () => {
    const preview = buildTradeExecutionPreview(EQUITY_LIMIT);
    expect(preview.fees.join(" ")).toMatch(/not itemized/i);
  });
});

describe("buildTradeExecutionPreview slippage (#1773, ASI-02)", () => {
  it("bounds a LIMIT fill at the limit price", () => {
    const preview = buildTradeExecutionPreview(EQUITY_LIMIT);
    expect(preview.slippage.bounded).toBe(true);
    expect(preview.slippage.limit).toContain("$125.50");
  });

  it("states plainly that a MARKET order has no slippage limit", () => {
    const preview = buildTradeExecutionPreview(MARKET);
    expect(preview.slippage.bounded).toBe(false);
    expect(preview.slippage.limit).toMatch(/no slippage limit/i);
  });

  it("restates the draft terms the server will execute, including option legs", () => {
    const preview = buildTradeExecutionPreview(OPTIONS);
    expect(preview.terms.join(" ")).toContain("BUY 10");
    expect(preview.terms.join(" ")).toContain("CALL $130");
    expect(preview.terms.join(" ")).toContain("CALL $140");
    expect(preview.terms.join(" ")).toContain("2026-12-18");
  });

  it("warns when the pricing quote is not live", () => {
    const preview = buildTradeExecutionPreview({ ...EQUITY_LIMIT, pricingQuoteStatus: "STATIC_FALLBACK" });
    expect(preview.warnings.join(" ")).toMatch(/non-live/i);
  });

  it("never renders undefined for a partial voice-surface draft", () => {
    const preview = buildTradeExecutionPreview({
      orderId: "ord_voice1",
      symbol: "NVDA",
      action: "BUY",
      orderAction: "BUY",
      orderType: "LIMIT",
      quantity: 10,
      limitPrice: 125.5,
      estimatedCommission: 0,
    } as TradeExecutionDraft);
    const text = [...preview.terms, ...preview.fees, preview.slippage.limit, ...preview.warnings].join(" ");
    expect(text).not.toContain("undefined");
    expect(text).toContain("term not stated by this draft");
  });

  it("warns when there is no broker preview id", () => {
    const preview = buildTradeExecutionPreview(MARKET);
    expect(preview.warnings.join(" ")).toMatch(/no broker preview/i);
  });
});

describe("TradeExecutionPreview render (#1773, ASI-02)", () => {
  it("renders payload, fees, and slippage before any approve action", () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(<TradeExecutionPreview draft={EQUITY_LIMIT} />);
    });
    try {
      const text = container.textContent ?? "";
      expect(text).toMatch(/execution preview/i);
      expect(text).toContain("ord_abc123");
      expect(text).toContain("$0.00");
      expect(text).toContain("$125.50");
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
      document.body.innerHTML = "";
    }
  });

  it("renders the MARKET no-limit warning", () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(<TradeExecutionPreview draft={MARKET} />);
    });
    try {
      expect(container.textContent ?? "").toMatch(/no slippage limit/i);
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
      document.body.innerHTML = "";
    }
  });
});
