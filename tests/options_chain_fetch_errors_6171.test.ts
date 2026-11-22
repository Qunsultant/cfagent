/**
 * Issue #6171 — the AAPL options run failed with "All 3 expiration fetches
 * returned no data" although the quotes exist, and the failure named no cause.
 *
 * RCA (on origin/main): the screener swallows every chain-fetch rejection
 * (`request.catch(() => null)` in `fetchChainsForSymbol`), and the failure
 * reason then depends entirely on `client.lastError` — a channel that is
 * empty by construction for the Alpaca path (the platform has no
 * `getLastError()`) and for any failure outside the E*TRADE client's own
 * try block (adapter/facade/capture layers). `assembleAlpacaOptionChain`
 * also returns null silently when no contracts are listed or no contract
 * has a two-sided quote, recording the reason nowhere.
 *
 * These tests pin the fix: a failed chain fetch must name its cause
 * (provider + reason) in the run's fetchErrors, and the Alpaca assembly
 * must throw a named error instead of returning null silently.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { assembleAlpacaOptionChain } from "../src/trading/alpaca/optionsData";
import type { AlpacaOptionsConfig } from "../src/trading/alpaca/optionsData";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { platformChainSource } from "../src/trading/optionChainSource";
import type { OptionChainSource } from "../src/trading/optionChainSource";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

const EXPIRIES = [expiryAtDte(30), expiryAtDte(37), expiryAtDte(44)];
const FILTER = { underlyingSymbols: ["AAPL"] };
const GENERIC_REASON = "All 3 expiration fetches returned no data.";

function fakeSource(overrides: {
  getOptionChains: OptionChainSource["getOptionChains"];
  lastError?: string;
}): OptionChainSource {
  return {
    supportsOptionRequestBudget: true,
    get lastError() {
      return overrides.lastError;
    },
    getOptionExpireDates: async () => EXPIRIES,
    getOptionChains: overrides.getOptionChains,
  };
}

const ALPACA_CFG: AlpacaOptionsConfig = {
  tradingUrl: "https://paper-api.alpaca.markets",
  dataUrl: "https://data.alpaca.markets",
  headers: {},
};

const EXPIRY_2026_12_18 = { expiryYear: 2026, expiryMonth: 12, expiryDay: 18 };

afterEach(() => {
  vi.unstubAllGlobals();
  DynamicOptionsScreener.clearTestChainsFixture();
});

describe("options chain fetch errors (#6171)", () => {
  it("names a rejected chain fetch instead of the generic 'returned no data'", async () => {
    const source = fakeSource({
      getOptionChains: async () => {
        throw new Error("Alpaca option snapshots unavailable [HTTP 503].");
      },
    });
    const screener = new DynamicOptionsScreener(source);
    const fetched = await screener.fetchChains(FILTER);
    expect(fetched.chains).toHaveLength(0);
    expect(fetched.fetchErrors).toHaveLength(1);
    expect(fetched.fetchErrors[0]?.symbol).toBe("AAPL");
    expect(fetched.fetchErrors[0]?.reason).toContain("Alpaca option snapshots unavailable [HTTP 503]");
    expect(fetched.fetchErrors[0]?.reason).not.toBe(GENERIC_REASON);
  });

  it("keeps the client lastError as the reason when the fetch returns null with one set", async () => {
    const source = fakeSource({
      lastError: "E*TRADE Option Chains API Error [HTTP 401]: Unauthorized",
      getOptionChains: async () => null,
    });
    const screener = new DynamicOptionsScreener(source);
    const fetched = await screener.fetchChains(FILTER);
    expect(fetched.chains).toHaveLength(0);
    expect(fetched.fetchErrors).toHaveLength(1);
    expect(fetched.fetchErrors[0]?.reason).toBe(
      "E*TRADE Option Chains API Error [HTTP 401]: Unauthorized",
    );
  });

  it("keeps the generic reason only when no error was captured anywhere", async () => {
    const source = fakeSource({
      getOptionChains: async () => null,
    });
    const screener = new DynamicOptionsScreener(source);
    const fetched = await screener.fetchChains(FILTER);
    expect(fetched.chains).toHaveLength(0);
    expect(fetched.fetchErrors).toHaveLength(1);
    expect(fetched.fetchErrors[0]?.reason).toBe(GENERIC_REASON);
  });

  it("names a rejected fallback fetch when no expirations are listed", async () => {
    const source: OptionChainSource = {
      supportsOptionRequestBudget: true,
      getOptionExpireDates: async () => [],
      getOptionChains: async () => {
        throw new Error("E*TRADE Option Chains API Error [HTTP 500]: upstream failure");
      },
    };
    const screener = new DynamicOptionsScreener(source);
    const fetched = await screener.fetchChains(FILTER);
    expect(fetched.chains).toHaveLength(0);
    expect(fetched.fetchErrors).toHaveLength(1);
    expect(fetched.fetchErrors[0]?.reason).toContain(
      "E*TRADE Option Chains API Error [HTTP 500]: upstream failure",
    );
  });
});

describe("Alpaca option chain assembly (#6171)", () => {
  function stubAlpacaFetch(contracts: unknown[], snapshots: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const href = String(url);
        if (href.includes("/v2/options/contracts")) {
          return { ok: true, json: async () => ({ option_contracts: contracts }) };
        }
        if (href.includes("/v1beta1/options/snapshots")) {
          return { ok: true, json: async () => ({ snapshots }) };
        }
        throw new Error(`unexpected Alpaca fetch in test: ${href}`);
      }),
    );
  }

  const fetchUnderlyingQuote = async () => ({ symbol: "AAPL", lastPrice: 250 });

  it("throws a named error when no contracts are listed for the expiry", async () => {
    stubAlpacaFetch([], {});
    await expect(
      assembleAlpacaOptionChain(ALPACA_CFG, { symbol: "AAPL", ...EXPIRY_2026_12_18 }, fetchUnderlyingQuote),
    ).rejects.toThrow(/AAPL.*2026-12-18.*no contracts/i);
  });

  it("throws a named error when no contract has a two-sided quote", async () => {
    stubAlpacaFetch(
      [
        {
          symbol: "AAPL261218C00250000",
          underlying_symbol: "AAPL",
          expiration_date: "2026-12-18",
          strike_price: 250,
          type: "call",
        },
      ],
      {
        // A snapshot with no bid, no ask and no last trade: no displayable price.
        AAPL261218C00250000: { latestQuote: {}, latestTrade: {} },
      },
    );
    await expect(
      assembleAlpacaOptionChain(ALPACA_CFG, { symbol: "AAPL", ...EXPIRY_2026_12_18 }, fetchUnderlyingQuote),
    ).rejects.toThrow(/AAPL.*2026-12-18.*two-sided quote/i);
  });

  it("the Alpaca platform records the assembly failure in getLastError and returns null", async () => {
    stubAlpacaFetch([], {});
    const platform = new AlpacaTradingPlatform(
      { ALPACA_API_KEY: "test-key", ALPACA_SECRET_KEY: "test-secret" } as never,
      undefined,
      "test-user",
    );
    const chain = await platform.getOptionChains({ symbol: "AAPL", ...EXPIRY_2026_12_18 });
    expect(chain).toBeNull();
    expect(platform.getLastError()).toMatch(/AAPL.*2026-12-18.*no contracts/i);
  });

  it("platformChainSource surfaces the Alpaca platform's lastError", async () => {
    stubAlpacaFetch([], {});
    const platform = new AlpacaTradingPlatform(
      { ALPACA_API_KEY: "test-key", ALPACA_SECRET_KEY: "test-secret" } as never,
      undefined,
      "test-user",
    );
    const source = platformChainSource(platform);
    expect(source).not.toBeNull();
    const chain = await source!.getOptionChains({ symbol: "AAPL", ...EXPIRY_2026_12_18 });
    expect(chain).toBeNull();
    expect(source!.lastError).toMatch(/AAPL.*2026-12-18.*no contracts/i);
  });
});
