/** @vitest-environment jsdom */
/**
 * Issue #2853 (gap G2): the Alpaca panel is Alpaca's.
 *
 * What these tests defend:
 *   1. Under broker=alpaca the panel renders Alpaca's label, its trading type
 *      and its own data — and no E*TRADE string anywhere in the output.
 *   2. A surface the contract refuses renders the coded, named notice instead
 *      of an empty table (exercised by withdrawing the capability from the
 *      catalog, then restoring it).
 *   3. A disabled read states FEATURE_DISABLED; a failed read states its code.
 *      Nothing renders placeholder accounts or positions.
 *
 * Harness: jsdom + a stubbed global fetch, as in
 * tests/broker_search_indicator_3089.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AlpacaBrokerPanel } from "../src/client/AlpacaBrokerPanel";
import { BrokerSurfaceGate } from "../src/client/BrokerSurfaceGate";
import { BROKER_CATALOG } from "../src/trading/brokerCatalog";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function stubFetch(payloads: Record<string, { status: number; body: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(payloads).find((path) => url.includes(path));
      const res = key ? payloads[key] : { status: 404, body: { code: "not_found" } };
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => res.body,
      } as unknown as Response;
    }),
  );
}

const ACCOUNTS = {
  status: 200,
  body: {
    broker: "alpaca",
    environment: "TEST",
    result: [{ accountId: "acct-1", accountKey: "k1", accountDesc: "Alpaca Paper", accountType: "INDIVIDUAL" }],
  },
};

const POSITIONS = {
  status: 200,
  body: {
    broker: "alpaca",
    environment: "TEST",
    result: {
      account: { accountId: "acct-1", accountKey: "k1", accountDesc: "Alpaca Paper", accountType: "INDIVIDUAL" },
      positions: [{ symbol: "AAPL", description: "Apple Inc", quantity: 3, pricePaid: 100, costBasis: 300 }],
    },
  },
};

describe("the Alpaca panel renders Alpaca (#2853)", () => {
  it("names the broker, the trading type and its own accounts", async () => {
    stubFetch({ "/broker/accounts": ACCOUNTS, "/broker/positions": POSITIONS });
    await act(async () => {
      root.render(<AlpacaBrokerPanel />);
    });
    await flush();

    const rootEl = container.querySelector('[data-broker="alpaca"]');
    expect(rootEl).toBeTruthy();
    expect(container.textContent).toContain("Alpaca");
    expect(container.textContent).toContain("Alpaca Paper");
    expect(container.textContent).toContain("Paper trading");
    expect(container.textContent).toContain("AAPL");
  });

  it("shows no E*TRADE surface or label", async () => {
    stubFetch({ "/broker/accounts": ACCOUNTS, "/broker/positions": POSITIONS });
    await act(async () => {
      root.render(<AlpacaBrokerPanel />);
    });
    await flush();
    expect(container.textContent).not.toContain("E*TRADE");
    expect(container.querySelector('[data-broker="etrade"]')).toBeNull();
  });

  it("states a disabled contract instead of an empty panel", async () => {
    stubFetch({
      "/broker/accounts": {
        status: 503,
        body: { code: "FEATURE_DISABLED", feature: "broker_panel_contract", message: "Broker panels are disabled by feature flag." },
      },
      "/broker/positions": {
        status: 503,
        body: { code: "FEATURE_DISABLED", feature: "broker_panel_contract", message: "Broker panels are disabled by feature flag." },
      },
    });
    await act(async () => {
      root.render(<AlpacaBrokerPanel />);
    });
    await flush();
    expect(container.textContent).toContain("Broker panels are disabled");
    expect(container.querySelector('[data-broker-code="FEATURE_DISABLED"]')).toBeTruthy();
    expect(container.textContent).not.toContain("No Alpaca accounts");
  });

  it("states a refused capability by name, never as an empty table", async () => {
    stubFetch({
      "/broker/accounts": { status: 501, body: { code: "provider_unsupported", broker: "alpaca", message: "Accounts are not available for the selected broker (alpaca)." } },
      "/broker/positions": POSITIONS,
    });
    await act(async () => {
      root.render(<AlpacaBrokerPanel />);
    });
    await flush();
    expect(container.textContent).toContain("provider_unsupported");
    expect(container.textContent).not.toContain("No Alpaca accounts");
  });
});

describe("the gate renders the contract's decision (#2853)", () => {
  it("renders children when the broker supports the surface", async () => {
    await act(async () => {
      root.render(
        <BrokerSurfaceGate broker="alpaca" surface="positions">
          <span>positions here</span>
        </BrokerSurfaceGate>,
      );
    });
    expect(container.textContent).toContain("positions here");
    expect(container.querySelector('[data-code]')).toBeNull();
  });

  it("renders a coded notice naming the broker when it does not", async () => {
    const original = BROKER_CATALOG.alpaca.supports.positions;
    try {
      (BROKER_CATALOG.alpaca.supports as { positions: boolean }).positions = false;
      await act(async () => {
        root.render(
          <BrokerSurfaceGate broker="alpaca" surface="positions">
            <span>positions here</span>
          </BrokerSurfaceGate>,
        );
      });
      expect(container.textContent).not.toContain("positions here");
      expect(container.textContent).toContain("Positions unavailable on Alpaca");
      expect(container.querySelector('[data-code="FAILURE_BROKER_UNAVAILABLE"]')).toBeTruthy();
      expect(container.textContent).toContain("No other broker's data");
    } finally {
      (BROKER_CATALOG.alpaca.supports as { positions: boolean }).positions = original;
    }
  });
});
