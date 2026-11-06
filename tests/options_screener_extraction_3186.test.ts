/**
 * Issue #3186 step 3a - engine extraction: the options screen's monolith
 * splits along its real seams so the pipeline stages can wrap the same
 * functions (same results, only the path changes).
 *
 *   fetchChains(filter) - the fetch half of screenOptions: sanitize,
 *   validate, resolve underlyings, fetch chains per symbol (with the
 *   #915 retry pass and the #1204 deferral accounting), flatten +
 *   diagnostics. Validation failures throw OptionsValidationError
 *   carrying the sanitized filter + warnings, so screenOptions can
 *   build the exact error result it builds today.
 *   evaluateContracts(chains, filter) - the per-contract filter +
 *   enrich pass (evaluateContract per contract).
 *   aggregateScreenResult(outcomes, chains, filter, total, diagnostics)
 *   - the aggregation tail of evaluateChains (summary, sort, limit,
 *   quote quality, status).
 *   evaluateChains stays exactly as it is (same signature, same
 *   results) - it becomes evaluateContracts + aggregateScreenResult.
 *   screenOptions stays exactly as it is - it becomes fetchChains +
 *   evaluateChains. The existing screener suites are the behavior pins.
 */
import { describe, expect, it, afterEach } from "vitest";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import {
  DynamicOptionsScreener,
  aggregateScreenResult,
  evaluateContracts,
  OptionsValidationError,
} from "../src/trading/optionsScreener";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function makeChain(symbol: string): ETradeOptionChain {
  const expiry = expiryAtDte(30);
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

const FILTER = { underlyingSymbols: ["AAPL"] };

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
});

function withoutScannedAt(result: Record<string, unknown>): Record<string, unknown> {
  const { scannedAt: _scannedAt, ...rest } = result;
  return rest;
}

describe("options engine extraction (#3186 step 3a)", () => {
  it("fetchChains returns the fetched chains + diagnostics", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const screener = new DynamicOptionsScreener();
    const fetched = await screener.fetchChains(FILTER);
    expect(fetched.symbols).toEqual(["AAPL"]);
    expect(fetched.chains).toHaveLength(1);
    expect(fetched.chains[0]?.symbol).toBe("AAPL");
    expect(fetched.fetchErrors).toEqual([]);
    expect(fetched.deferredSymbols).toEqual([]);
    expect(fetched.expirationsTruncated).toBe(0);
  });

  it("fetchChains throws the sector validation with filter + warnings attached", async () => {
    const screener = new DynamicOptionsScreener();
    await expect(
      screener.fetchChains({ underlyingSymbols: ["AAPL"], sector: "technology" }),
    ).rejects.toBeInstanceOf(OptionsValidationError);
    await expect(
      screener.fetchChains({ underlyingSymbols: ["AAPL"], sector: "technology" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("sector"),
    });
  });

  it("fetchChains throws when no underlyings are specified", async () => {
    const screener = new DynamicOptionsScreener();
    await expect(screener.fetchChains({})).rejects.toBeInstanceOf(OptionsValidationError);
  });

  it("fetchChains + evaluateChains compose to screenOptions", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const screener = new DynamicOptionsScreener();
    const fetched = await screener.fetchChains(FILTER);
    const viaSplit = screener.evaluateChains(fetched.chains, fetched.filter, fetched.symbols.length, {
      fetchErrors: fetched.fetchErrors,
      warnings: fetched.warnings,
    });
    const viaScreen = await screener.screenOptions(FILTER);
    expect(withoutScannedAt(viaSplit as unknown as Record<string, unknown>)).toEqual(
      withoutScannedAt(viaScreen as unknown as Record<string, unknown>),
    );
  });

  it("evaluateContracts + aggregateScreenResult compose to evaluateChains", () => {
    const screener = new DynamicOptionsScreener();
    const chainItems = [{ symbol: "AAPL", chain: makeChain("AAPL") }];
    const outcomes = evaluateContracts(chainItems, { underlyingSymbols: ["AAPL"] }, screener.config);
    const viaSplit = aggregateScreenResult(
      outcomes,
      chainItems,
      { underlyingSymbols: ["AAPL"] },
      1,
      {},
      screener.config,
    );
    const viaMethod = screener.evaluateChains(chainItems, { underlyingSymbols: ["AAPL"] }, 1, {});
    expect(withoutScannedAt(viaSplit as unknown as Record<string, unknown>)).toEqual(
      withoutScannedAt(viaMethod as unknown as Record<string, unknown>),
    );
    expect(outcomes.totalContractsEvaluated).toBe(2);
    expect(outcomes.passedContracts).toHaveLength(2);
  });
});
