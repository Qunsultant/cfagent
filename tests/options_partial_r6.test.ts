/**
 * Issue #1290 (#1173 R6): options qualified-partial. Mirrors the stock
 * doctrine (#462): a partial options scan publishes as a QUALIFIED
 * partial — the qualification is stamped on the scanner result at its
 * single assembly point, stated in the unified service's summary, and
 * bannered on the PDF — instead of today's console.warn-only handling
 * in the scheduled gate. Zero evaluated stays a coded failure
 * (FAILURE_SCREEN_NO_CONTRACTS_EVALUATED, pinned by the scheduled_tasks suite).
 */
import { describe, it, expect, vi} from "vitest";
// Issue #3460 slice 3: the unified service reads the broker through the
// presence-aware seam (no default). These tests drive the E*TRADE path,
// so the selection is explicit here instead of relying on the default.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    readTenantBrokerSelection: async () => ({
      status: "ok",
      brokerId: "etrade",
    }),
  };
});

import {
  optionsPartialQualification,
  type ScanCoverage,
} from "../src/trading/options/opportunityScanner";
import { optionsPartialBanner } from "../src/trading/optionsReportPdf";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { Env, ETradeOptionChain } from "../src/types";

const coverage = (over: Partial<ScanCoverage> = {}): ScanCoverage => ({
  considered: 4,
  scanned: 4,
  truncated: 0,
  evaluated: 4,
  errors: 0,
  withTrades: 0,
  eventCalendar: { covered: 4, total: 4, coveragePct: 100 },
  ...over,
});

describe("optionsPartialQualification (#1290)", () => {
  it("full coverage is not partial", () => {
    expect(optionsPartialQualification(coverage(), [])).toBeUndefined();
  });

  it("an empty universe is not partial", () => {
    expect(
      optionsPartialQualification(coverage({ considered: 0, scanned: 0, evaluated: 0 }), [])
    ).toBeUndefined();
  });

  it("gaps stamp the qualification with counts and the dominant skip reason", () => {
    const skipped = [
      { symbol: "AMD", reason: "Chain fetch failed" },
      { symbol: "INTC", reason: "Chain fetch failed" },
      { symbol: "MU", reason: "Subrequest budget exhausted: chain fetch deferred (Worker per-invocation subrequest limit)." },
    ];
    const partial = optionsPartialQualification(
      coverage({ evaluated: 1, errors: 3 }),
      skipped
    );
    expect(partial).toEqual({
      evaluatedCount: 1,
      consideredCount: 4,
      coverageErrors: 3,
      truncatedCount: 0,
      topSkipReason: "Chain fetch failed",
      topSkipCount: 2,
    });
  });

  it("truncation alone (no skips) stamps without a skip reason", () => {
    const partial = optionsPartialQualification(
      coverage({ considered: 30, scanned: 20, truncated: 10, evaluated: 20 }),
      []
    );
    expect(partial?.evaluatedCount).toBe(20);
    expect(partial?.consideredCount).toBe(30);
    expect(partial?.truncatedCount).toBe(10);
    expect(partial?.topSkipReason).toBeUndefined();
  });

  it("zero evaluated with coverage present still stamps (the gate turns it into FAILURE_SCREEN_NO_CONTRACTS_EVALUATED)", () => {
    const partial = optionsPartialQualification(
      coverage({ evaluated: 0, errors: 4 }),
      [{ symbol: "AAPL", reason: "Token Missing: No active session for user in [PROD] mode" }]
    );
    expect(partial?.evaluatedCount).toBe(0);
    expect(partial?.topSkipReason).toContain("Token Missing");
  });
});

describe("optionsPartialBanner (#1290)", () => {
  it("no qualification, no banner", () => {
    expect(optionsPartialBanner(undefined)).toBeNull();
  });

  it("the banner states counts and the top skip reason", () => {
    const lines = optionsPartialBanner({
      evaluatedCount: 1,
      consideredCount: 4,
      coverageErrors: 3,
      truncatedCount: 0,
      topSkipReason: "Chain fetch failed",
      topSkipCount: 2,
    });
    expect(lines).not.toBeNull();
    expect(lines![0]).toContain("PARTIAL SCAN");
    expect(lines![0]).toContain("QUALIFIED RESULTS");
    expect(lines![1]).toContain("1 of 4 underlyings evaluated");
    expect(lines![1]).toContain("Chain fetch failed");
  });
});

/* ------------------------------------------------------------------ */
/* Service integration — the stamp reaches the result + summary        */
/* ------------------------------------------------------------------ */

function scanChainFixture(symbol: string, spot: number, expiry: { year: number; month: number; day: number }): ETradeOptionChain {
  const legMid = (strike: number, type: "CALL" | "PUT") => {
    const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
    return Math.max(0.3, intrinsic + Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12));
  };
  const leg = (type: "CALL" | "PUT", strike: number) => {
    const mid = legMid(strike, type);
    const deltaMag = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    return {
      timeStamp: Date.now(),
      adjustedFlag: false,
      optionType: type,
      strikePrice: strike,
      symbol: `${symbol}${strike}${type === "CALL" ? "C" : "P"}`,
      bid: Math.max(0.05, mid - 0.1),
      ask: mid + 0.1,
      lastPrice: mid,
      volume: 1_000,
      openInterest: 2_000,
      delta: type === "CALL" ? deltaMag : -deltaMag,
      gamma: 0.02,
      theta: -0.03,
      impliedVolatility: 0.3,
    };
  };
  return {
    symbol,
    underlyingPrice: spot,
    selectedExpiry: expiry,
    pairs: [0.9, 0.95, 1, 1.05, 1.1].map((mult) => {
      const strike = Math.round(spot * mult * 100) / 100;
      return { call: leg("CALL", strike), put: leg("PUT", strike) };
    }),
  } as unknown as ETradeOptionChain;
}

describe("UnifiedOptionsService opportunities — partial stamping (#1290)", () => {
  it("a symbol with no chain fixture is skipped and the run is stamped partial, in result and summary", async () => {
    const expiryDateObj = new Date(Date.now() + 35 * 86_400_000);
    const expiry = { year: expiryDateObj.getUTCFullYear(), month: expiryDateObj.getUTCMonth() + 1, day: expiryDateObj.getUTCDate() };
    const targetDate = `${expiry.year}-${String(expiry.month).padStart(2, "0")}-${String(expiry.day).padStart(2, "0")}`;
    DynamicOptionsScreener.setTestChainsFixture({
      NVDA: scanChainFixture("NVDA", 250, expiry),
    });
    const service = new UnifiedOptionsService({ ETRADE_ENVIRONMENT: "sandbox" } as Env, "test_trader");
    const res = await service.execute({
      action: "opportunities",
      symbols: ["NVDA", "AMD"],
      targetDate,
    });
    expect(res.success).toBe(true);
    expect(res.data.partial).toBeDefined();
    expect(res.data.partial.evaluatedCount).toBe(1);
    expect(res.data.partial.consideredCount).toBe(2);
    expect(res.summary).toContain("Partial coverage");
    expect(res.summary).toContain("qualified partial");
  });

  it("full coverage leaves the result unstamped and the summary in its legacy shape", async () => {
    const expiryDateObj = new Date(Date.now() + 35 * 86_400_000);
    const expiry = { year: expiryDateObj.getUTCFullYear(), month: expiryDateObj.getUTCMonth() + 1, day: expiryDateObj.getUTCDate() };
    const targetDate = `${expiry.year}-${String(expiry.month).padStart(2, "0")}-${String(expiry.day).padStart(2, "0")}`;
    DynamicOptionsScreener.setTestChainsFixture({
      NVDA: scanChainFixture("NVDA", 250, expiry),
      AMD: scanChainFixture("AMD", 40, expiry),
    });
    const service = new UnifiedOptionsService({ ETRADE_ENVIRONMENT: "sandbox" } as Env, "test_trader");
    const res = await service.execute({
      action: "opportunities",
      symbols: ["NVDA", "AMD"],
      mode: "strategy_fit",
      targetDate,
    });
    expect(res.success).toBe(true);
    expect(res.data.partial).toBeUndefined();
    expect(res.summary).not.toContain("Partial coverage");
  });
});
