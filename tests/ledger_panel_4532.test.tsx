/** @vitest-environment jsdom */
/**
 * Order execution ledger — overview + per-broker tabs, broker column,
 * sortable columns (slice 1 of the ledger enhancement).
 *
 * Pins:
 *  - the Overview tab shows every loaded row; each broker tab shows
 *    only that broker's rows;
 *  - the broker column names every row's broker, and a row recorded
 *    before the broker stamp resolves to the legacy broker, never
 *    blank and never a guessed name for an unknown id;
 *  - every data column sorts: each header is a button, the active
 *    column carries `aria-sort`, clicking toggles asc/desc, and
 *    choosing a new column starts from its natural direction;
 *  - sorting is honest: rows with no recorded value sort last in
 *    either direction, never invented;
 *  - the default order is unchanged: newest first;
 *  - the Risk action column is an action, not data: its header is
 *    not a sort control, and the Risk button behavior is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  LEDGER_SORT_DEFAULT,
  ledgerBrokerId,
  ledgerBrokerLabel,
  ledgerBrokerTabs,
  nextLedgerSort,
  sortLedgerRows,
} from "../src/client/ledgerTable";
import { LedgerPanel } from "../src/client/LedgerPanel";
import type { TradeRecord } from "../src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function order(over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: "ord-1",
    sessionId: "sess-1",
    symbol: "AAPL",
    action: "BUY",
    orderType: "MARKET",
    quantity: 10,
    price: 150,
    totalValue: 1500,
    status: "executed",
    orderRef: "ref-1",
    proposerDid: "did:agent:openaimp:proposer-1",
    proofSignature: "sig-1",
    createdAt: "2026-11-14T10:00:00.000Z",
    updatedAt: "2026-11-14T10:00:00.000Z",
    ...over,
  };
}

// --- pure broker resolution -------------------------------------------------

describe("ledgerBrokerId / ledgerBrokerLabel / ledgerBrokerTabs", () => {
  it("resolves a recorded broker to itself", () => {
    expect(ledgerBrokerId(order({ broker: "alpaca" }))).toBe("alpaca");
    expect(ledgerBrokerLabel(order({ broker: "alpaca" }))).toBe("Alpaca");
  });

  it("resolves a row with no recorded broker to the legacy broker, never blank", () => {
    expect(ledgerBrokerId(order({ broker: undefined }))).toBe("etrade");
    expect(ledgerBrokerId(order({ broker: "" }))).toBe("etrade");
    expect(ledgerBrokerLabel(order({ broker: undefined }))).toBe("E*TRADE");
  });

  it("never dresses an unknown id up as a broker", () => {
    expect(ledgerBrokerLabel(order({ broker: "not-a-broker" }))).toBe("Selected broker");
  });

  it("derives one tab per broker present, in display-name order, legacy rows folded in", () => {
    const tabs = ledgerBrokerTabs([
      order({ id: "a", broker: undefined }),
      order({ id: "b", broker: "alpaca" }),
      order({ id: "c", broker: "alpaca" }),
      order({ id: "d", broker: "etrade" }),
    ]);
    expect(tabs).toEqual([
      { id: "alpaca", label: "Alpaca" },
      { id: "etrade", label: "E*TRADE" },
    ]);
  });

  it("derives no broker tabs from no rows", () => {
    expect(ledgerBrokerTabs([])).toEqual([]);
  });
});

// --- pure sorting ------------------------------------------------------------

describe("sortLedgerRows", () => {
  it("defaults to newest first and does not mutate the input", () => {
    const rows = [
      order({ id: "old", createdAt: "2026-11-13T10:00:00.000Z" }),
      order({ id: "new", createdAt: "2026-11-14T10:00:00.000Z" }),
    ];
    const sorted = sortLedgerRows(rows, LEDGER_SORT_DEFAULT);
    expect(sorted.map((r) => r.id)).toEqual(["new", "old"]);
    expect(rows.map((r) => r.id)).toEqual(["old", "new"]);
  });

  it("sorts every data column in both directions", () => {
    const rows = [
      order({ id: "b", symbol: "MSFT", action: "SELL", quantity: 5, price: 200, totalValue: 1000, status: "submitted", broker: "etrade", orderRef: "ref-b", proposerDid: "did:agent:openaimp:zebra", createdAt: "2026-11-13T10:00:00.000Z" }),
      order({ id: "a", symbol: "AAPL", action: "BUY", quantity: 20, price: 100, totalValue: 2000, status: "executed", broker: "alpaca", orderRef: "ref-a", proposerDid: "did:agent:openaimp:apple", createdAt: "2026-11-14T10:00:00.000Z" }),
    ];
    const by = (key: Parameters<typeof sortLedgerRows>[1]["key"], dir: "asc" | "desc") =>
      sortLedgerRows(rows, { key, dir }).map((r) => r.id);
    expect(by("id", "asc")).toEqual(["a", "b"]);
    expect(by("id", "desc")).toEqual(["b", "a"]);
    expect(by("symbol", "asc")).toEqual(["a", "b"]);
    expect(by("symbol", "desc")).toEqual(["b", "a"]);
    expect(by("action", "asc")).toEqual(["a", "b"]);
    expect(by("action", "desc")).toEqual(["b", "a"]);
    expect(by("quantity", "asc")).toEqual(["b", "a"]);
    expect(by("quantity", "desc")).toEqual(["a", "b"]);
    expect(by("price", "asc")).toEqual(["a", "b"]);
    expect(by("price", "desc")).toEqual(["b", "a"]);
    expect(by("totalValue", "asc")).toEqual(["b", "a"]);
    expect(by("totalValue", "desc")).toEqual(["a", "b"]);
    expect(by("status", "asc")).toEqual(["a", "b"]);
    expect(by("status", "desc")).toEqual(["b", "a"]);
    // Broker sorts by display label: Alpaca before E*TRADE.
    expect(by("broker", "asc")).toEqual(["a", "b"]);
    expect(by("broker", "desc")).toEqual(["b", "a"]);
    expect(by("orderRef", "asc")).toEqual(["a", "b"]);
    expect(by("orderRef", "desc")).toEqual(["b", "a"]);
    expect(by("proposerDid", "asc")).toEqual(["a", "b"]);
    expect(by("proposerDid", "desc")).toEqual(["b", "a"]);
    expect(by("createdAt", "asc")).toEqual(["b", "a"]);
    expect(by("createdAt", "desc")).toEqual(["a", "b"]);
  });

  it("sorts numbers numerically, not lexically", () => {
    const rows = [
      order({ id: "hundred", quantity: 100 }),
      order({ id: "nine", quantity: 9 }),
      order({ id: "fifty", quantity: 50 }),
    ];
    expect(sortLedgerRows(rows, { key: "quantity", dir: "asc" }).map((r) => r.id)).toEqual([
      "nine",
      "fifty",
      "hundred",
    ]);
  });

  it("keeps rows with no recorded value last in either direction", () => {
    const rows = [
      order({ id: "no-ref", orderRef: undefined }),
      order({ id: "has-ref", orderRef: "ref-1" }),
    ];
    expect(sortLedgerRows(rows, { key: "orderRef", dir: "asc" }).map((r) => r.id)).toEqual([
      "has-ref",
      "no-ref",
    ]);
    expect(sortLedgerRows(rows, { key: "orderRef", dir: "desc" }).map((r) => r.id)).toEqual([
      "has-ref",
      "no-ref",
    ]);
    const badDates = [
      order({ id: "bad-date", createdAt: "not-a-date" }),
      order({ id: "good-date", createdAt: "2026-11-14T10:00:00.000Z" }),
    ];
    expect(sortLedgerRows(badDates, { key: "createdAt", dir: "asc" }).map((r) => r.id)).toEqual([
      "good-date",
      "bad-date",
    ]);
    expect(sortLedgerRows(badDates, { key: "createdAt", dir: "desc" }).map((r) => r.id)).toEqual([
      "good-date",
      "bad-date",
    ]);
  });

  it("breaks ties deterministically: newest first, then row id descending", () => {
    const rows = [
      order({ id: "a", symbol: "SAME", createdAt: "2026-11-14T10:00:00.000Z" }),
      order({ id: "b", symbol: "SAME", createdAt: "2026-11-14T10:00:00.000Z" }),
      order({ id: "c", symbol: "SAME", createdAt: "2026-11-13T10:00:00.000Z" }),
    ];
    expect(sortLedgerRows(rows, { key: "symbol", dir: "asc" }).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("maps the default direction of each column sensibly", () => {
    expect(nextLedgerSort(LEDGER_SORT_DEFAULT, "createdAt")).toEqual({ key: "createdAt", dir: "asc" });
    expect(nextLedgerSort({ key: "symbol", dir: "asc" }, "symbol")).toEqual({ key: "symbol", dir: "desc" });
    expect(nextLedgerSort({ key: "symbol", dir: "asc" }, "price")).toEqual({ key: "price", dir: "desc" });
    expect(nextLedgerSort({ key: "symbol", dir: "asc" }, "quantity")).toEqual({ key: "quantity", dir: "desc" });
    expect(nextLedgerSort({ key: "symbol", dir: "asc" }, "broker")).toEqual({ key: "broker", dir: "asc" });
    expect(nextLedgerSort({ key: "symbol", dir: "asc" }, "createdAt")).toEqual({ key: "createdAt", dir: "desc" });
  });
});

// --- render harness ----------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPanel(orders: TradeRecord[], over: { ordersLoading?: boolean } = {}) {
  const fetchOrders = vi.fn(async () => {});
  const setRiskSubject = vi.fn();
  root = createRoot(container);
  await act(async () => {
    root.render(
      <LedgerPanel
        orders={orders}
        ordersLoading={over.ordersLoading ?? false}
        fetchOrders={fetchOrders}
        setRiskSubject={setRiskSubject}
      />,
    );
  });
  await flush();
  return { fetchOrders, setRiskSubject };
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

function rowIds(): string[] {
  return [...container.querySelectorAll("tbody tr")].map((tr) => (tr.children[0]?.textContent ?? "").trim());
}

function headerButton(label: string): HTMLButtonElement {
  const headers = [...container.querySelectorAll("th")];
  for (const th of headers) {
    if ((th.textContent ?? "").includes(label)) {
      const button = th.querySelector("button");
      if (button) return button as HTMLButtonElement;
    }
  }
  throw new Error(`sortable header not found: ${label}`);
}

function headerCell(label: string): HTMLTableCellElement {
  const headers = [...container.querySelectorAll("th")];
  const header = headers.find((th) => (th.textContent ?? "").includes(label));
  if (!header) throw new Error(`header not found: ${label}`);
  return header as HTMLTableCellElement;
}

function tabByLabel(label: string): HTMLButtonElement {
  const tabs = [...container.querySelectorAll('[role="tab"]')];
  const tab = tabs.find((t) => (t.textContent ?? "").trim() === label);
  if (!tab) throw new Error(`tab not found: ${label}`);
  return tab as HTMLButtonElement;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
});

describe("LedgerPanel tabs", () => {
  const rows = [
    order({ id: "ord-alpaca", symbol: "AAPL", broker: "alpaca", createdAt: "2026-11-14T10:00:00.000Z" }),
    order({ id: "ord-legacy", symbol: "MSFT", broker: undefined, createdAt: "2026-11-13T10:00:00.000Z" }),
    order({ id: "ord-etrade", symbol: "TSLA", broker: "etrade", createdAt: "2026-11-12T10:00:00.000Z" }),
  ];

  it("renders Overview plus one tab per broker present, and only one table", async () => {
    await renderPanel(rows);
    const labels = [...container.querySelectorAll('[role="tab"]')].map((t) => (t.textContent ?? "").trim());
    expect(labels).toEqual(["Overview", "Alpaca", "E*TRADE"]);
    expect(container.querySelectorAll("table")).toHaveLength(1);
  });

  it("shows every row on Overview, newest first", async () => {
    await renderPanel(rows);
    expect(rowIds()).toEqual(["ord-alpaca", "ord-legacy", "ord-etrade"]);
  });

  it("shows only that broker's rows on a broker tab, legacy rows included", async () => {
    await renderPanel(rows);
    await click(tabByLabel("Alpaca"));
    expect(rowIds()).toEqual(["ord-alpaca"]);
    expect(tabByLabel("Alpaca").getAttribute("aria-selected")).toBe("true");
    await click(tabByLabel("E*TRADE"));
    expect(rowIds()).toEqual(["ord-legacy", "ord-etrade"]);
    await click(tabByLabel("Overview"));
    expect(rowIds()).toEqual(["ord-alpaca", "ord-legacy", "ord-etrade"]);
  });

  it("shows the broker column on every tab, legacy rows named", async () => {
    await renderPanel(rows);
    const brokerCells = () =>
      [...container.querySelectorAll("tbody tr")].map((tr) => (tr.children[7]?.textContent ?? "").trim());
    expect(headerCell("Broker").textContent ?? "").toContain("Broker");
    expect(brokerCells()).toEqual(["Alpaca", "E*TRADE", "E*TRADE"]);
    await click(tabByLabel("Alpaca"));
    expect(brokerCells()).toEqual(["Alpaca"]);
  });

  it("falls back to Overview when the selected broker tab disappears", async () => {
    const { fetchOrders } = await renderPanel(rows);
    await click(tabByLabel("Alpaca"));
    expect(rowIds()).toEqual(["ord-alpaca"]);
    await act(async () => {
      root.render(
        <LedgerPanel
          orders={[rows[1]]}
          ordersLoading={false}
          fetchOrders={fetchOrders}
          setRiskSubject={vi.fn()}
        />,
      );
    });
    await flush();
    expect([...container.querySelectorAll('[role="tab"]')].map((t) => (t.textContent ?? "").trim())).toEqual([
      "Overview",
      "E*TRADE",
    ]);
    expect(rowIds()).toEqual(["ord-legacy"]);
  });
});

describe("LedgerPanel sorting", () => {
  const rows = [
    order({ id: "ord-msft", symbol: "MSFT", quantity: 5, createdAt: "2026-11-14T10:00:00.000Z" }),
    order({ id: "ord-aapl", symbol: "AAPL", quantity: 20, createdAt: "2026-11-13T10:00:00.000Z" }),
  ];

  it("renders newest first by default with aria-sort on the date column", async () => {
    await renderPanel(rows);
    expect(rowIds()).toEqual(["ord-msft", "ord-aapl"]);
    expect(headerCell("Date & Time").getAttribute("aria-sort")).toBe("descending");
    expect(headerCell("Symbol").getAttribute("aria-sort")).toBeNull();
  });

  it("toggles direction on repeated header clicks and moves aria-sort to the new column", async () => {
    await renderPanel(rows);
    await click(headerButton("Symbol"));
    expect(rowIds()).toEqual(["ord-aapl", "ord-msft"]);
    expect(headerCell("Symbol").getAttribute("aria-sort")).toBe("ascending");
    expect(headerCell("Date & Time").getAttribute("aria-sort")).toBeNull();
    await click(headerButton("Symbol"));
    expect(rowIds()).toEqual(["ord-msft", "ord-aapl"]);
    expect(headerCell("Symbol").getAttribute("aria-sort")).toBe("descending");
    await click(headerButton("Shares"));
    expect(rowIds()).toEqual(["ord-aapl", "ord-msft"]);
    expect(headerCell("Shares").getAttribute("aria-sort")).toBe("descending");
    expect(headerCell("Symbol").getAttribute("aria-sort")).toBeNull();
  });

  it("keeps the sort when switching tabs", async () => {
    const mixed = [
      order({ id: "ord-z", symbol: "ZZZZ", broker: "alpaca", createdAt: "2026-11-14T10:00:00.000Z" }),
      order({ id: "ord-a", symbol: "AAAA", broker: "alpaca", createdAt: "2026-11-13T10:00:00.000Z" }),
      order({ id: "ord-m", symbol: "MMMM", broker: "etrade", createdAt: "2026-11-12T10:00:00.000Z" }),
    ];
    await renderPanel(mixed);
    await click(headerButton("Symbol"));
    expect(rowIds()).toEqual(["ord-a", "ord-m", "ord-z"]);
    await click(tabByLabel("Alpaca"));
    expect(rowIds()).toEqual(["ord-a", "ord-z"]);
  });

  it("leaves the Risk action column unsorted and the Risk button working", async () => {
    const { setRiskSubject } = await renderPanel(rows);
    const headers = [...container.querySelectorAll("th")];
    const actionHeader = headers[headers.length - 1];
    expect((actionHeader.textContent ?? "").trim()).toBe("Action");
    expect(actionHeader.querySelector("button")).toBeNull();
    expect(actionHeader.getAttribute("aria-sort")).toBeNull();
    const riskButton = [...container.querySelectorAll("tbody tr button")].find((b) =>
      (b.textContent ?? "").includes("Risk"),
    );
    if (!riskButton) throw new Error("Risk button not found");
    await click(riskButton);
    expect(setRiskSubject).toHaveBeenCalledTimes(1);
    expect(setRiskSubject).toHaveBeenCalledWith(
      expect.objectContaining({ title: "BUY 5x MSFT", underlyingSymbol: "MSFT" }),
    );
  });
});

describe("LedgerPanel chrome", () => {
  it("keeps the refresh button, and refreshes on click", async () => {
    const { fetchOrders } = await renderPanel([order()]);
    const refresh = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Refresh Ledger"),
    );
    if (!refresh) throw new Error("Refresh button not found");
    await click(refresh);
    expect(fetchOrders).toHaveBeenCalledTimes(1);
  });

  it("shows the loading state while loading and the empty state with no rows", async () => {
    await renderPanel([], { ordersLoading: true });
    expect(container.querySelector('[role="status"][aria-label="Loading orders ledger"]')).not.toBeNull();
  });

  it("shows the empty state with no rows once loaded", async () => {
    await renderPanel([]);
    expect(container.textContent ?? "").toContain("No trade orders recorded yet.");
    expect([...container.querySelectorAll('[role="tab"]')].map((t) => (t.textContent ?? "").trim())).toEqual([
      "Overview",
    ]);
  });
});
