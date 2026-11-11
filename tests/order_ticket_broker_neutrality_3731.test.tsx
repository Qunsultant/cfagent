/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeNumberFormat, safePriceFormat } from "../src/client/formatters";
import { OrderTicketPanel, type OrderTicketModel } from "../src/client/OrderTicketPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 50) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** The quote peek Card: locate it from the company name it renders
 *  (the bespoke `.order-quote-peek` wrapper is gone after #3051). */
function quotePeekCard(): Element {
  const company = [...container.querySelectorAll("strong")].find(
    (el) => el.textContent === "Apple Inc.",
  );
  const card = company?.closest(".ui-card");
  if (!card) throw new Error("quote peek not rendered");
  return card;
}

function makeTicketModel(overrides: Partial<OrderTicketModel> = {}): OrderTicketModel {
  const noop = () => {};
  const noopAsync = async () => {};
  return {
    orderSymbol: "AAPL",
    orderAction: "BUY",
    orderType: "LIMIT",
    orderQuantity: 10,
    orderLimitPrice: "",
    orderQuote: null,
    quoteLoading: false,
    previewLoading: false,
    orderError: "",
    orderContext: null,
    orderAssetClass: "equity",
    orderLegs: [],
    activeDraft: null,
    brokerId: "alpaca",
    tradingType: "paper",
    brokerConnected: true,
    activeEnv: "TEST",
    setOrderSymbol: noop,
    setOrderAction: noop,
    setOrderType: noop,
    setOrderQuantity: noop,
    setOrderLimitPrice: noop,
    setOrderContext: noop,
    setActiveDraft: noop,
    setLastExecutionResult: noop,
    setOrderError: noop,
    setOrderAssetClass: noop,
    fetchSymbolQuote: noopAsync,
    updateOptionLeg: noop,
    addOptionLeg: noop,
    removeOptionLeg: noop,
    setOptionNetOrderDirection: noop,
    handlePreviewOrder: async (e: React.FormEvent) => {
      e.preventDefault();
    },
    onConnectBroker: noopAsync,
    sendNlqToChat: noop,
    setRiskSubject: noop,
    seedManualOptions: noop,
    ...overrides,
  };
}

describe("Issue #3731: Order Ticket Crash & Broker Neutrality", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  describe("safeNumberFormat and safePriceFormat helpers", () => {
    it("formats finite numbers correctly", () => {
      expect(safeNumberFormat(123.456, 2)).toBe("123.46");
      expect(safeNumberFormat(0, 2)).toBe("0.00");
      expect(safeNumberFormat(-45.678, 2)).toBe("-45.68");
      expect(safePriceFormat(123.456)).toBe("$123.46");
      expect(safePriceFormat(0)).toBe("$0.00");
      expect(safePriceFormat(-12.5)).toBe("$-12.50");
    });

    it("guards against undefined, null, NaN, and Infinity without throwing", () => {
      expect(safeNumberFormat(undefined)).toBe("—");
      expect(safeNumberFormat(null)).toBe("—");
      expect(safeNumberFormat(NaN)).toBe("—");
      expect(safeNumberFormat(Infinity)).toBe("—");
      expect(safeNumberFormat(-Infinity)).toBe("—");
      expect(safeNumberFormat("", 2, "N/A")).toBe("N/A");

      expect(safePriceFormat(undefined)).toBe("—");
      expect(safePriceFormat(null)).toBe("—");
      expect(safePriceFormat(NaN)).toBe("—");
      expect(safePriceFormat(undefined, 2, "Unavailable")).toBe("Unavailable");
    });

    it("handles string representations of numbers", () => {
      expect(safeNumberFormat("42.5")).toBe("42.50");
      expect(safePriceFormat("99.99")).toBe("$99.99");
      expect(safeNumberFormat("invalid-number")).toBe("—");
    });
  });

  describe("OrderTicketPanel graceful rendering with undefined quote/price fields", () => {
    it("renders Alpaca paper mode without crashing when orderQuote fields are undefined", async () => {
      const partialQuote: any = {
        symbol: "AAPL",
        companyName: "Apple Inc.",
        // undefined quote prices (typical in off-hours or incomplete broker responses)
        lastPrice: undefined,
        change: undefined,
        changePercent: undefined,
        bid: undefined,
        ask: undefined,
        quoteStatus: "OFF_HOURS",
      };

      const model = makeTicketModel({
        brokerId: "alpaca",
        tradingType: "paper",
        activeEnv: "TEST",
        orderQuote: partialQuote,
      });

      await act(async () => {
        root.render(
          <ToastProvider>
            <OrderTicketPanel ticket={model} />
          </ToastProvider>
        );
      });
      await flush();

      const text = container.textContent || "";
      expect(text).toContain("Alpaca");
      expect(text).toContain("PAPER TRADING");
      expect(text).not.toContain("E*TRADE");
      expect(text).not.toContain("LIVE TRADING");

      // Verify that quote peek displayed fallback "—" without throwing.
      // The quote peek is a Card after the #3051 primitives migration —
      // the bespoke `.order-quote-peek` / `.quote-price` / `.quote-bidask`
      // classes are gone; the company name, the price in a <strong>, and
      // the bid/ask in a ui-meta span are the new anchors.
      const peek = quotePeekCard();
      const priceStrong = [...peek.querySelectorAll("strong")].find(
        (el) => el.textContent === "—",
      );
      expect(priceStrong?.textContent).toBe("—");

      const bidAskElem = [...peek.querySelectorAll("span.ui-meta")].find((el) =>
        (el.textContent || "").includes("Bid:"),
      );
      expect(bidAskElem?.textContent).toContain("Bid: —");
      expect(bidAskElem?.textContent).toContain("Ask: —");
    });

    it("renders activeDraft with undefined commission and estimated price without throwing", async () => {
      const partialDraft: any = {
        action: "BUY",
        orderType: "MARKET",
        quantity: 5,
        symbol: "TSLA",
        limitPrice: null,
        estimatedPrice: undefined,
        estimatedCommission: undefined,
        estimatedTotal: 1250,
      };

      const model = makeTicketModel({
        brokerId: "alpaca",
        tradingType: "paper",
        orderSymbol: "TSLA",
        activeDraft: partialDraft,
        orderContext: {
          assetClass: "equity",
          label: "Equity Order",
          legs: ["BUY 5 TSLA"],
          optionLegs: [],
        } as any,
      });

      await act(async () => {
        root.render(
          <ToastProvider>
            <OrderTicketPanel ticket={model} />
          </ToastProvider>
        );
      });
      await flush();

      const text = container.textContent || "";
      expect(text).toContain("Alpaca");
      expect(text).not.toContain("E*TRADE");
    });
  });

  describe("Chat.tsx ErrorBoundary and Broker Neutrality", () => {
    it("does not hardcode 'E*TRADE Hub' in ErrorBoundary label", () => {
      const chatCode = readFileSync(join(__dirname, "../src/client/Chat.tsx"), "utf8");
      expect(chatCode).not.toContain('<ErrorBoundary label="E*TRADE Hub">');
      expect(chatCode).toContain("<ErrorBoundary label={`${selectedBrokerLabel} Trading Hub`}>");
      expect(chatCode).toContain("sourceTab || `${selectedBrokerLabel} Brokerage`");
    });
  });

  describe("Documentation of /assets", () => {
    it("docs/architecture/client-assets.md exists and documents bundle lifecycle and triage", () => {
      const doc = readFileSync(join(__dirname, "../docs/architecture/client-assets.md"), "utf8");
      expect(doc).toContain("/assets");
      expect(doc).toContain("index-lWjLEYmK.js");
      expect(doc).toContain("npm run build");
      expect(doc).toContain("Cloudflare Workers");
      expect(doc).toContain("ASSETS");
      expect(doc).toContain("Cache-Control");
    });
  });
});

