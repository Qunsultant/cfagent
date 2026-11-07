/** @vitest-environment jsdom */
/**
 * Issue #3090 (S4, epic #3086): strategy input auto-builds the ticket legs.
 * - The options ticket offers a strategy Select (STRATEGY_LIBRARY) plus
 *   one expiration picker; choosing a strategy REPLACES the ticket's
 *   legs with the built structure (the leg editor stays available for
 *   per-leg tweaks after the build).
 * - Mapping is lossy by design: side / optionType (STOCK -> EQ) /
 *   strike / quantity / expirationDate carry over; model prices,
 *   greeks, and IV are dropped, so the broker preview prices the
 *   built structure from live quotes, never from Black-Scholes.
 * - Refusals mirror discovery: no live quote -> the same
 *   "Quote unavailable" refusal; no expiration picked -> a prompt
 *   to pick one first; a past expiration -> refused. Nothing
 *   changes in any refusal case.
 * - No broker, approval, or preview changes: built legs flow through
 *   the existing preview/execute path unchanged.
 *
 * Harness follows tests/order_ticket_page_3088.test.tsx: react-dom
 * client in jsdom, stubbed fetch, panel rendered directly with a mock
 * model (the hub owns the real state; the panel owns the controls).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OrderTicketPanel, type OrderTicketModel } from "../src/client/OrderTicketPanel";
import { STRATEGY_LIBRARY } from "../src/client/options/strategyLibrary";
import {
  STRATEGY_AUTOBUILD_MODEL_IV,
  buildTradeLegs,
  describeTradeLeg,
  dteForExpiry,
  mapStrategyLegToTradeLeg,
} from "../src/client/trading/strategyAutobuild";
import type { ETradeQuote } from "../src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 40) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function mockFetch() {
  const fetchMock = vi.fn(async (input: any) => {
    const url = String(input);
    const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.startsWith("/api/broker/orders")) return okJson({ orders: [] });
    return okJson({});
  });
  vi.stubGlobal("fetch", fetchMock);
}

function futureDate(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pastDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const QUOTE: ETradeQuote = {
  symbol: "NVDA",
  companyName: "NVIDIA Corporation",
  lastPrice: 180,
  change: 2.5,
  changePercent: 1.41,
  bid: 179.9,
  ask: 180.1,
  volume: 1000000,
  open: 177,
  high: 182,
  low: 176,
  quoteStatus: "REALTIME",
  source: "E*TRADE",
} as ETradeQuote;

function makeModel(overrides: Partial<OrderTicketModel> = {}): {
  model: OrderTicketModel;
  setOptionLegs: ReturnType<typeof vi.fn>;
} {
  const setOptionLegs = vi.fn();
  const model: OrderTicketModel = {
    orderSymbol: "NVDA",
    orderAction: "BUY",
    orderType: "LIMIT",
    orderQuantity: 1,
    orderLimitPrice: "",
    orderQuote: QUOTE,
    quoteLoading: false,
    previewLoading: false,
    orderError: "",
    orderContext: {
      assetClass: "options",
      symbol: "NVDA",
      action: "BUY",
      quantity: 1,
      label: "Manual options",
      legs: ["BUY 1 CALL"],
      optionLegs: [
        { securityType: "OPTN", side: "BUY", quantity: 1, optionType: "CALL", strike: 180, expirationDate: futureDate(30) },
      ],
    },
    orderAssetClass: "options",
    orderLegs: [
      { securityType: "OPTN", side: "BUY", quantity: 1, optionType: "CALL", strike: 180, expirationDate: futureDate(30) },
    ],
    activeDraft: null,
    brokerId: "etrade",
    tradingType: "paper",
    brokerConnected: true,
    setOrderSymbol: vi.fn(),
    setOrderAction: vi.fn(),
    setOrderType: vi.fn(),
    setOrderQuantity: vi.fn(),
    setOrderLimitPrice: vi.fn(),
    setOrderContext: vi.fn(),
    setActiveDraft: vi.fn(),
    setLastExecutionResult: vi.fn(),
    setOrderError: vi.fn(),
    setOrderAssetClass: vi.fn(),
    fetchSymbolQuote: vi.fn(async () => {}),
    updateOptionLeg: vi.fn(),
    addOptionLeg: vi.fn(),
    removeOptionLeg: vi.fn(),
    setOptionLegs,
    setOptionNetOrderDirection: vi.fn(),
    handlePreviewOrder: vi.fn(async () => {}),
    onConnectBroker: vi.fn(async () => {}),
    sendNlqToChat: vi.fn(),
    setRiskSubject: vi.fn(),
    seedManualOptions: vi.fn(),
    ...overrides,
  };
  return { model, setOptionLegs };
}

async function renderPanel(model: OrderTicketModel) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<OrderTicketPanel ticket={model} />);
  });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  mockFetch();
  window.history.pushState(null, "", "/?tab=order&orderTab=options");
});

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.pushState(null, "", "/");
});

function strategySelect(): HTMLSelectElement {
  const el = document.querySelector('select[aria-label="Build from strategy"]');
  if (!el) throw new Error("strategy Select not found");
  return el as HTMLSelectElement;
}

function expiryInput(): HTMLInputElement {
  const el = document.querySelector('input[aria-label="Build expiration"]');
  if (!el) throw new Error("expiration input not found");
  return el as HTMLInputElement;
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("strategy auto-build mapping (issue #3090)", () => {
  it("builds a long call from spot with a single OPTN leg and no model fields", () => {
    const def = STRATEGY_LIBRARY.find((d) => d.id === "long_call")!;
    expect(def).toBeDefined();
    const { legs, dte } = buildTradeLegs(def, 180, "2026-12-18");
    expect(dte).toBeGreaterThan(0);
    expect(legs).toHaveLength(1);
    const leg = legs[0];
    expect(leg.securityType).toBe("OPTN");
    expect(leg.side).toBe("BUY");
    expect(leg.optionType).toBe("CALL");
    expect(leg.quantity).toBe(1);
    expect(leg.expirationDate).toBe("2026-12-18");
    expect(Number.isFinite(leg.strike)).toBe(true);
    expect((leg.strike as number) > 0).toBe(true);
    // Lossy by design: no model price, greeks, or IV on a ticket leg.
    expect(Object.keys(leg).sort()).toEqual(
      ["expirationDate", "optionType", "quantity", "securityType", "side", "strike"],
    );
  });

  it("maps a STOCK leg to an EQ leg with no strike or expiration", () => {
    const def = STRATEGY_LIBRARY.find((d) => {
      const built = d.buildLegs(180, 30, "2026-12-18", STRATEGY_AUTOBUILD_MODEL_IV);
      return built.some((l) => l.optionType === "STOCK");
    });
    expect(def).toBeDefined();
    const { legs } = buildTradeLegs(def!, 180, "2026-12-18");
    const eq = legs.find((l) => l.securityType === "EQ");
    expect(eq).toBeDefined();
    expect(Object.keys(eq!).sort()).toEqual(["quantity", "securityType", "side"]);
    expect(describeTradeLeg(eq!)).toMatch(/shares$/);
  });

  it("every library strategy fits the editor's 4-leg cap", () => {
    for (const def of STRATEGY_LIBRARY) {
      expect(def.legsCount).toBeLessThanOrEqual(4);
      const { legs } = buildTradeLegs(def, 180, "2026-12-18");
      expect(legs.length).toBeLessThanOrEqual(4);
    }
  });

  it("computes DTE from the expiry date", () => {
    expect(dteForExpiry(futureDate(30))).toBe(30);
    expect(dteForExpiry(futureDate(0))).toBe(0);
    expect(dteForExpiry(pastDate(5))).toBe(0);
  });

  it("maps a leg's fields and describes it", () => {
    expect(
      mapStrategyLegToTradeLeg({ side: "SELL", optionType: "PUT", strike: 170, quantity: 2, expirationDate: "2026-12-18" }),
    ).toEqual({ securityType: "OPTN", side: "SELL", quantity: 2, optionType: "PUT", strike: 170, expirationDate: "2026-12-18" });
    expect(
      describeTradeLeg({ securityType: "OPTN", side: "SELL", quantity: 2, optionType: "PUT", strike: 170, expirationDate: "2026-12-18" }),
    ).toBe("SELL 2 PUT $170 exp 2026-12-18");
  });
});

describe("strategy auto-build ticket wiring (issue #3090)", () => {
  it("choosing a strategy replaces the legs via setOptionLegs", async () => {
    const { model, setOptionLegs } = makeModel();
    await renderPanel(model);
    // The shared leg expiry pre-fills the picker; choose long_call.
    expect(expiryInput().value).toBe(futureDate(30));
    await act(async () => {
      setSelectValue(strategySelect(), "long_call");
    });
    await flush();
    expect(setOptionLegs).toHaveBeenCalledTimes(1);
    const [legs, label, legsText] = setOptionLegs.mock.calls[0];
    expect(legs).toHaveLength(1);
    expect(legs[0].securityType).toBe("OPTN");
    expect(legs[0].optionType).toBe("CALL");
    expect(legs[0].expirationDate).toBe(futureDate(30));
    expect(label).toMatch(/^Built strategy: /);
    expect(legsText).toHaveLength(1);
    expect(legsText[0]).toMatch(/BUY 1 CALL/);
  });

  it("refuses without a live quote, changing nothing", async () => {
    const { model, setOptionLegs } = makeModel({
      orderQuote: null,
      orderContext: {
        assetClass: "options",
        symbol: "NVDA",
        action: "BUY",
        quantity: 1,
        label: "Manual options",
        legs: ["BUY 1 CALL"],
        optionLegs: [
          { securityType: "OPTN", side: "BUY", quantity: 1, optionType: "CALL", strike: 180, expirationDate: futureDate(30) },
        ],
      },
    });
    await renderPanel(model);
    await act(async () => {
      setSelectValue(strategySelect(), "long_call");
    });
    await flush();
    expect(setOptionLegs).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Quote unavailable — load a live quote before choosing a strategy.");
  });

  it("refuses without an expiration picked, changing nothing", async () => {
    const legs = [
      { securityType: "OPTN" as const, side: "BUY" as const, quantity: 1, optionType: "CALL" as const, strike: 180, expirationDate: futureDate(30) },
      { securityType: "OPTN" as const, side: "SELL" as const, quantity: 1, optionType: "CALL" as const, strike: 190, expirationDate: futureDate(60) },
    ];
    const { model, setOptionLegs } = makeModel({
      orderLegs: legs,
      orderContext: {
        assetClass: "options",
        symbol: "NVDA",
        action: "BUY",
        quantity: 1,
        label: "Manual options",
        legs: ["BUY 1 CALL", "SELL 1 CALL"],
        optionLegs: legs,
      },
    });
    await renderPanel(model);
    // Legs disagree on expiry, so the picker starts empty.
    expect(expiryInput().value).toBe("");
    await act(async () => {
      setSelectValue(strategySelect(), "long_call");
    });
    await flush();
    expect(setOptionLegs).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Pick an expiration date first.");
  });

  it("refuses a past expiration, changing nothing", async () => {
    const { model, setOptionLegs } = makeModel();
    await renderPanel(model);
    await act(async () => {
      setInputValue(expiryInput(), pastDate(5));
    });
    await act(async () => {
      setSelectValue(strategySelect(), "long_call");
    });
    await flush();
    expect(setOptionLegs).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Expiration must be today or later.");
  });

  it("wires the hub's setOptionLegs and the panel's builder controls", () => {
    const hub = readFileSync(join(HERE, "..", "src", "client", "ETradeTradingHub.tsx"), "utf8");
    const panel = readFileSync(join(HERE, "..", "src", "client", "OrderTicketPanel.tsx"), "utf8");
    expect(hub).toContain("const setOptionLegs = (");
    expect(hub).toContain("setOptionLegs,");
    expect(hub).toContain("strategyNetDebit: undefined");
    expect(panel).toContain("Build from strategy");
    expect(panel).toContain("buildTradeLegs");
    expect(panel).toContain("setOptionLegs(legs");
    expect(panel).not.toContain("style={{");
  });
});
