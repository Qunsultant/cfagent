/**
 * Issue #6208 — the overnight options-chain run failed because
 * `fetchAlpacaOptionSnapshots` sent every contract symbol for the
 * expiry in a single `symbols=` parameter. Alpaca documents the
 * multi-contract snapshots endpoint's `symbols` limit as 100, so an
 * expiry with 100–400 contracts is rejected with HTTP 400.
 *
 * These tests pin the fix: the snapshots fetch chunks into
 * ≤100-symbol requests and merges the results, and a 400 body is
 * logged server-side while the caller still gets the short message.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assembleAlpacaOptionChain,
  fetchAlpacaOptionSnapshots,
} from "../src/trading/alpaca/optionsData";
import type { AlpacaOptionsConfig } from "../src/trading/alpaca/optionsData";

const ALPACA_CFG: AlpacaOptionsConfig = {
  tradingUrl: "https://paper-api.alpaca.markets",
  dataUrl: "https://data.alpaca.markets",
  headers: {},
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Expiry 40 days out, relative to today so the fixture never rots. */
function expiry40d(): { year: number; month: number; day: number; iso: string } {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 40));
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { year, month, day, iso };
}

function contractRow(symbol: string, iso: string, strike: number, type: "call" | "put") {
  return {
    symbol,
    underlying_symbol: "AAPL",
    expiration_date: iso,
    strike_price: strike,
    type,
  };
}

function snapshotRow() {
  return { latestQuote: { bp: 1, ap: 2 }, latestTrade: { p: 1.5 } };
}

/** N contracts on one expiry, distinct strikes, alternating call/put. */
function chainFixture(count: number) {
  const { year, month, day, iso } = expiry40d();
  const yymmdd = iso.slice(2).replaceAll("-", "");
  const contracts: unknown[] = [];
  const snapshots: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const strike = 100 + i;
    const type = i % 2 === 0 ? "call" : "put";
    const symbol = `AAPL${yymmdd}${type === "call" ? "C" : "P"}${String(strike).padStart(8, "0")}`;
    contracts.push(contractRow(symbol, iso, strike, type));
    snapshots[symbol] = snapshotRow();
  }
  return { expiry: { expiryYear: year, expiryMonth: month, expiryDay: day }, contracts, snapshots };
}

function symbolsParam(href: string): string[] {
  const symbols = new URL(href).searchParams.get("symbols") ?? "";
  return symbols.length > 0 ? symbols.split(",") : [];
}

describe("Alpaca option snapshots chunking (#6208)", () => {
  it("fetches >100 symbols in ≤100-symbol requests and merges the results", async () => {
    const snapshotUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const href = String(url);
        if (href.includes("/v1beta1/options/snapshots")) {
          snapshotUrls.push(href);
          const wanted = symbolsParam(href);
          const snapshots: Record<string, unknown> = {};
          for (const symbol of wanted) snapshots[symbol] = snapshotRow();
          return { ok: true, json: async () => ({ snapshots }) };
        }
        throw new Error(`unexpected Alpaca fetch in test: ${href}`);
      }),
    );
    const symbols = Array.from({ length: 250 }, (_, i) => `AAPL260101C${String(100 + i).padStart(8, "0")}`);
    const out = await fetchAlpacaOptionSnapshots(ALPACA_CFG, "AAPL", symbols);
    expect(out.size).toBe(250);
    expect(snapshotUrls).toHaveLength(3);
    for (const href of snapshotUrls) expect(symbolsParam(href).length).toBeLessThanOrEqual(100);
  });

  it("assembles a 150-contract expiry through chunked snapshot fetches", async () => {
    const { expiry, contracts, snapshots } = chainFixture(150);
    const snapshotUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const href = String(url);
        if (href.includes("/v2/options/contracts")) {
          return { ok: true, json: async () => ({ option_contracts: contracts }) };
        }
        if (href.includes("/v1beta1/options/snapshots")) {
          snapshotUrls.push(href);
          return { ok: true, json: async () => ({ snapshots }) };
        }
        throw new Error(`unexpected Alpaca fetch in test: ${href}`);
      }),
    );
    const fetchUnderlyingQuote = async () => ({ symbol: "AAPL", lastPrice: 175 });
    const chain = await assembleAlpacaOptionChain(
      ALPACA_CFG,
      { symbol: "AAPL", ...expiry },
      fetchUnderlyingQuote,
    );
    expect(chain).not.toBeNull();
    expect(chain!.pairs).toHaveLength(150);
    expect(snapshotUrls).toHaveLength(2);
    for (const href of snapshotUrls) expect(symbolsParam(href).length).toBeLessThanOrEqual(100);
  });

  it("logs the upstream 400 body server-side and keeps the short caller message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const href = String(url);
        if (href.includes("/v1beta1/options/snapshots")) {
          return {
            ok: false,
            status: 400,
            text: async () => '{"code":40010000,"message":"symbols exceeds maximum of 100"}',
          };
        }
        throw new Error(`unexpected Alpaca fetch in test: ${href}`);
      }),
    );
    await expect(fetchAlpacaOptionSnapshots(ALPACA_CFG, "AAPL", ["AAPL260101C00100000"])).rejects.toThrow(
      "Alpaca option snapshots unavailable [HTTP 400].",
    );
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("symbols exceeds maximum of 100");
  });
});
