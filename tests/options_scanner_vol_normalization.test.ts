/**
 * Issue #25: volatility-normalized scan targets and scoring.
 *
 * Before #25, cross-name comparisons mixed units: the bullish thesis
 * target was spot × 1.05 for every name — a small move for a high-IV
 * name, a huge one for a low-IV name — and the composite's capital-
 * efficiency lens divided by a flat $100 floor, an absolute-dollar term
 * that penalized cheap names only. Now:
 *
 *  - Thesis targets are derived in expected-move units: target =
 *    spot × (1 + multiple × EM%), EM% = IV × sqrt(days/365) from the
 *    most-ATM contract of the name's OWN chain (estimateExpectedMovePct).
 *    The same thesis therefore asks for a statistically equivalent move
 *    on every name, and target R/R is ranked relative to that unit.
 *  - Explicit targets (stated / absolute / percent) never move — they
 *    are absolute by definition — but every resolved target also reports
 *    its distance in EM units (targetEmUnits) when an estimate exists.
 *  - A per-name override can itself be stated in EM units
 *    ({ kind: "em", multiple }), completing the #23 deferral.
 *  - Symbols whose chains yield no estimate keep the legacy percentage
 *    derivation and are named in a fallback disclosure; the EM basis is
 *    disclosed whenever at least one symbol used it.
 *  - The engine's capital-efficiency floor is 1% of per-contract
 *    notional (spot-relative), pinned separately below.
 *
 * Determinism: every expectation that depends on days-to-expiry is
 * computed from an injected `now` / explicit emPct — never the wall
 * clock. (The fixture expiry is set 30 days out from test start so the
 * engine's own target-date math sees the same horizon the estimate
 * does; the day count works out to exactly 30 either way.)
 */
import { describe, expect, it } from "vitest";
import {
  OpportunityScanner,
  SCAN_MODEL_VERSION,
  estimateExpectedMovePct,
  resolveScanTarget,
  type ExpectedMoveContract,
  type ScanRequestTemplate,
} from "../src/trading/options/opportunityScanner";
import { parseOptionsStrategyIntent, runOptionsStrategyAction } from "../src/agents/nlqOptionsStrategy";
import { blackScholesGreeks } from "../src/shared/riskMath";
import type { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, OptionScreenResult, ScreenedOptionContractItem } from "../src/types";

const EM_DISCLOSURE =
  "Thesis-derived targets are expressed in expected-move units (bullish +0.6 EM, bearish -0.6 EM, large_move +1.2 EM, range_bound 0 EM; 1 EM = the 1-sigma move to expiry implied by each name's own chain).";

/** EM% for IV / days, the estimate's own formula. */
const emPctFor = (iv: number, days: number) => iv * Math.sqrt(days / 365);

// ---------------------------------------------------------------------------
// estimateExpectedMovePct (pure)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-16T12:00:00.000Z");
const EXPIRY_30D = "2026-11-15"; // 30 calendar days after NOW's date

function contract(overrides: Partial<ExpectedMoveContract> = {}): ExpectedMoveContract {
  return {
    symbol: "XXX100C",
    strikePrice: 100,
    impliedVolatility: 0.3,
    expirationDate: EXPIRY_30D,
    ...overrides,
  };
}

describe("estimateExpectedMovePct (issue #25)", () => {
  it("reads IV × sqrt(days/365) off the most-ATM contract", () => {
    const pct = estimateExpectedMovePct(
      [
        contract({ symbol: "XXX90C", strikePrice: 90, impliedVolatility: 0.2 }),
        contract({ symbol: "XXX100C", strikePrice: 100, impliedVolatility: 0.3 }),
        contract({ symbol: "XXX110C", strikePrice: 110, impliedVolatility: 0.25 }),
      ],
      100,
      NOW,
    );
    // Expiry is 29.5 days after NOW (noon) → ceil → 30 days.
    expect(pct).toBeCloseTo(emPctFor(0.3, 30), 10);
  });

  it("counts days from the injected now, not the wall clock", () => {
    const atMidnight = new Date("2026-10-16T00:00:00.000Z");
    expect(estimateExpectedMovePct([contract()], 100, atMidnight)).toBeCloseTo(emPctFor(0.3, 30), 10);
    // One day later the same chain is a 29-day chain.
    const nextDay = new Date("2026-10-17T00:00:00.000Z");
    expect(estimateExpectedMovePct([contract()], 100, nextDay)).toBeCloseTo(emPctFor(0.3, 29), 10);
  });

  it("breaks ATM ties by earliest expiry, then lowest strike, then symbol", () => {
    // Same distance (0): the earlier expiry wins even at a different IV.
    expect(
      estimateExpectedMovePct(
        [
          contract({ symbol: "XXX100C", expirationDate: "2026-12-15", impliedVolatility: 0.5 }),
          contract({ symbol: "XXX100P", expirationDate: EXPIRY_30D, impliedVolatility: 0.3 }),
        ],
        100,
        NOW,
      ),
    ).toBeCloseTo(emPctFor(0.3, 30), 10);
    // Equidistant strikes, same expiry: the lowest strike wins.
    expect(
      estimateExpectedMovePct(
        [
          contract({ symbol: "XXX105C", strikePrice: 105, impliedVolatility: 0.2 }),
          contract({ symbol: "XXX95C", strikePrice: 95, impliedVolatility: 0.4 }),
        ],
        100,
        NOW,
      ),
    ).toBeCloseTo(emPctFor(0.4, 30), 10);
    // Identical strike and expiry: symbol ascending decides.
    expect(
      estimateExpectedMovePct(
        [
          contract({ symbol: "ZZZ100C", impliedVolatility: 0.5 }),
          contract({ symbol: "AAA100C", impliedVolatility: 0.3 }),
        ],
        100,
        NOW,
      ),
    ).toBeCloseTo(emPctFor(0.3, 30), 10);
  });

  it("returns null when no contract can anchor an estimate", () => {
    expect(estimateExpectedMovePct([], 100, NOW)).toBeNull();
    // IV missing or zero everywhere.
    expect(estimateExpectedMovePct([contract({ impliedVolatility: 0 })], 100, NOW)).toBeNull();
    expect(estimateExpectedMovePct([contract({ impliedVolatility: undefined })], 100, NOW)).toBeNull();
    // Unparseable expiry.
    expect(estimateExpectedMovePct([contract({ expirationDate: "not-a-date" })], 100, NOW)).toBeNull();
    // Expiry today (midnight is already past at NOW) and in the past.
    expect(estimateExpectedMovePct([contract({ expirationDate: "2026-10-16" })], 100, NOW)).toBeNull();
    expect(estimateExpectedMovePct([contract({ expirationDate: "2026-10-01" })], 100, NOW)).toBeNull();
    // No spot to measure against.
    expect(estimateExpectedMovePct([contract()], 0, NOW)).toBeNull();
  });

  it("ignores unusable contracts when a usable one exists", () => {
    const pct = estimateExpectedMovePct(
      [
        contract({ symbol: "XXX100C", impliedVolatility: 0 }),
        contract({ symbol: "XXX100P", impliedVolatility: 0.3 }),
      ],
      100,
      NOW,
    );
    expect(pct).toBeCloseTo(emPctFor(0.3, 30), 10);
  });
});

// ---------------------------------------------------------------------------
// resolveScanTarget with an EM estimate (pure)
// ---------------------------------------------------------------------------

function baseTemplate(overrides: Partial<ScanRequestTemplate> = {}): ScanRequestTemplate {
  return {
    thesis: "bullish",
    targetDate: EXPIRY_30D,
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 5_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call", "call_debit_spread", "put_credit_spread"],
    minDte: 14,
    maxDte: 60,
    contractLimit: 500,
    candidateLimit: 10,
    maxStrikesPerSide: 12,
    maxIronCondors: 100,
    maxQuoteAgeSeconds: 60,
    eventPolicy: "warn",
    ...overrides,
  };
}

describe("resolveScanTarget with an expected-move estimate (issue #25)", () => {
  it("puts high-IV and low-IV names at the SAME EM distance with different % targets", () => {
    const highIv = { pct: emPctFor(0.6, 30) }; // EM ≈ 17.20% of spot
    const lowIv = { pct: emPctFor(0.15, 30) }; // EM ≈ 4.30% of spot
    const high = resolveScanTarget(baseTemplate(), "HIV", 100, undefined, highIv);
    const low = resolveScanTarget(baseTemplate(), "LIV", 100, undefined, lowIv);

    // +0.6 EM: 100 × (1 + 0.6 × 0.17202) ≈ 110.32 vs 100 × (1 + 0.6 × 0.04300) ≈ 102.58.
    expect(high).toMatchObject({ targetPrice: 110.32, source: "thesis" });
    expect(low).toMatchObject({ targetPrice: 102.58, source: "thesis" });
    expect(high.targetPrice).not.toBe(low.targetPrice); // different % moves…
    expect(high.targetEmUnits).toBeCloseTo(0.6, 3); // …the same statistical distance
    expect(low.targetEmUnits).toBeCloseTo(0.6, 3);
  });

  it("derives every thesis in EM units (bearish negative, large_move 1.2, range_bound 0)", () => {
    const em = { pct: emPctFor(0.3, 30) };
    const bearish = resolveScanTarget(baseTemplate({ thesis: "bearish" }), "ANY", 200, undefined, em);
    expect(bearish.targetPrice).toBe(189.68); // 200 × (1 − 0.6 × 0.08601)
    expect(bearish.targetEmUnits).toBeCloseTo(-0.6, 3);
    const largeMove = resolveScanTarget(baseTemplate({ thesis: "large_move" }), "ANY", 200, undefined, em);
    expect(largeMove.targetPrice).toBe(220.64); // 200 × (1 + 1.2 × 0.08601)
    expect(largeMove.targetEmUnits).toBeCloseTo(1.2, 3);
    const rangeBound = resolveScanTarget(baseTemplate({ thesis: "range_bound" }), "ANY", 200, undefined, em);
    expect(rangeBound.targetPrice).toBe(200);
    expect(rangeBound.targetEmUnits).toBe(0);
  });

  it("never moves an explicit target, but reports its EM distance", () => {
    const em = { pct: emPctFor(0.3, 30) };
    const template = baseTemplate({ statedTarget: { price: 260, symbol: "EXP" } });
    const stated = resolveScanTarget(template, "EXP", 250, undefined, em);
    const statedNoEm = resolveScanTarget(template, "EXP", 250);
    expect(stated.targetPrice).toBe(260);
    expect(stated.targetPrice).toBe(statedNoEm.targetPrice);
    expect(stated.source).toBe("stated");
    expect(stated.targetEmUnits).toBeCloseTo((260 - 250) / (250 * em.pct), 3);
    expect(statedNoEm.targetEmUnits).toBeNull();

    const pct = resolveScanTarget(baseTemplate(), "EXP", 250, { target: { kind: "percent", pct: 10 } }, em);
    expect(pct).toMatchObject({ targetPrice: 275, source: "percent" });
    expect(pct.targetEmUnits).toBeCloseTo((275 - 250) / (250 * em.pct), 3);
    const abs = resolveScanTarget(baseTemplate(), "EXP", 250, { target: { kind: "absolute", price: 300 } }, em);
    expect(abs).toMatchObject({ targetPrice: 300, source: "stated" });
    expect(abs.targetEmUnits).toBeCloseTo((300 - 250) / (250 * em.pct), 3);
  });

  it("without an estimate the thesis derivation is the legacy factor, exactly", () => {
    expect(resolveScanTarget(baseTemplate(), "ANY", 200, undefined, null))
      .toEqual({ targetPrice: 210, source: "thesis", targetEmUnits: null });
    expect(resolveScanTarget(baseTemplate(), "ANY", 200, undefined, { pct: 0 }))
      .toEqual({ targetPrice: 210, source: "thesis", targetEmUnits: null });
  });

  it("resolves an em override against the estimate, and falls back without one", () => {
    const em = { pct: emPctFor(0.3, 30) };
    const resolved = resolveScanTarget(baseTemplate(), "ANY", 200, { target: { kind: "em", multiple: 0.8 } }, em);
    expect(resolved.source).toBe("em");
    expect(resolved.targetPrice).toBe(213.76); // 200 × (1 + 0.8 × 0.08601)
    expect(resolved.targetEmUnits).toBeCloseTo(0.8, 3);
    // No estimate: the em override cannot resolve — the symbol falls
    // back to its thesis derivation (legacy factor, no EM context),
    // honoring a thesis override attached to the same per-name entry.
    const fallback = resolveScanTarget(baseTemplate(), "ANY", 200, { target: { kind: "em", multiple: 0.8 } });
    expect(fallback).toEqual({ targetPrice: 210, source: "thesis", targetEmUnits: null });
    const fallbackBearish = resolveScanTarget(baseTemplate(), "ANY", 200, { thesis: "bearish", target: { kind: "em", multiple: 0.8 } }, null);
    expect(fallbackBearish).toEqual({ targetPrice: 190, source: "thesis", targetEmUnits: null });
  });
});

// ---------------------------------------------------------------------------
// Scan-level fixtures
// ---------------------------------------------------------------------------

const scanNow = new Date();
const scanExpiryDate = new Date(scanNow.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);

function scanTemplate(overrides: Partial<ScanRequestTemplate> = {}): ScanRequestTemplate {
  return {
    thesis: "bullish",
    targetDate: scanExpiryDate,
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 5_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call", "call_debit_spread", "put_credit_spread"],
    minDte: 14,
    maxDte: 60,
    contractLimit: 500,
    candidateLimit: 10,
    maxStrikesPerSide: 12,
    maxIronCondors: 100,
    maxQuoteAgeSeconds: 60,
    eventPolicy: "warn",
    ...overrides,
  };
}

function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

/** Fixture chains in the style of tests/options_scanner.test.ts, with a
 *  parameterizable IV (0 → no usable IV anywhere in the chain). */
function makeContracts(symbol: string, spot: number, iv: number): ScreenedOptionContractItem[] {
  const now = Date.now();
  return [0.9, 0.95, 1, 1.05, 1.1].flatMap((mult) => {
    const strike = Math.round(spot * mult * 100) / 100;
    const callMid = legMid(spot, strike, "CALL");
    const putMid = legMid(spot, strike, "PUT");
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    const base = {
      underlyingSymbol: symbol,
      underlyingPrice: spot,
      daysToExpiration: 30,
      expirationDate: scanExpiryDate,
      moneyness: "ATM" as const,
      strikeDistancePct: (Math.abs(strike - spot) / spot) * 100,
      spreadPct: 8,
      quoteAgeSeconds: 0,
      quoteTimestamp: new Date(now).toISOString(),
      quoteFreshness: "FRESH" as const,
      lastPrice: 2.5,
      volume: 1_000,
      openInterest: 2_000,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      impliedVolatility: iv,
      adjustedFlag: false,
      technicalSignal: "fixture",
      highlightReason: "fixture",
    };
    return [
      { ...base, optionType: "CALL" as const, symbol: `${symbol}${strike}C`, osiKey: `${symbol}-${strike}C`, strikePrice: strike, bid: callMid - 0.1, ask: callMid + 0.1, delta },
      { ...base, optionType: "PUT" as const, symbol: `${symbol}${strike}P`, osiKey: `${symbol}-${strike}P`, strikePrice: strike, bid: putMid - 0.1, ask: putMid + 0.1, delta: -delta },
    ];
  });
}

function fakeScreener(chains: Record<string, ScreenedOptionContractItem[]>): DynamicOptionsScreener {
  return {
    screenOptions: async (filter: { underlyingSymbols?: string[] }) => {
      const symbol = filter.underlyingSymbols?.[0] ?? "";
      const contracts = chains[symbol] ?? [];
      return {
        contracts,
        matchedCount: contracts.length,
        totalContractsEvaluated: contracts.length,
        totalUnderlyingsScanned: 1,
        scannedAt: new Date().toISOString(),
        rejections: [],
      } as unknown as OptionScreenResult;
    },
  } as unknown as DynamicOptionsScreener;
}

describe("OpportunityScanner EM wiring (issue #25)", () => {
  it("stamps targetEmUnits on opportunity and matrix rows, snapshots the multiples, discloses the basis", async () => {
    const scanner = new OpportunityScanner(fakeScreener({
      NVDA: makeContracts("NVDA", 250, 0.3),
      AMD: makeContracts("AMD", 40, 0.3),
    }));
    const result = await scanner.scan(["NVDA", "AMD"], scanTemplate({
      statedTarget: { price: 260, symbol: "NVDA" },
    }), { now: scanNow });

    expect(result.modelVersion).toBe("1.2.1");
    expect(SCAN_MODEL_VERSION).toBe("1.2.1");
    expect(result.configSnapshot.targetEmMultiples).toEqual({
      bullish: 0.6, bearish: -0.6, large_move: 1.2, range_bound: 0,
    });
    expect(result.configSnapshot.targetFactors.bullish).toBe(1.05); // legacy factors still snapshotted

    const nvda = result.opportunities.find((o) => o.symbol === "NVDA")!;
    expect(nvda.targetPrice).toBe(260); // stated target never moves
    expect(nvda.targetEmUnits).toBeCloseTo(0.4651, 3); // (260−250) / (250 × 0.08601)
    const amd = result.opportunities.find((o) => o.symbol === "AMD")!;
    expect(amd.targetPrice).toBe(42.06); // EM-derived thesis target
    expect(amd.targetEmUnits).toBeCloseTo(0.6, 2);

    const amdMatrix = result.matrix.find((m) => m.symbol === "AMD")!;
    expect(amdMatrix.targetEmUnits).toBeCloseTo(0.6, 2);
    const nvdaMatrix = result.matrix.find((m) => m.symbol === "NVDA")!;
    expect(nvdaMatrix.targetEmUnits).toBeCloseTo(0.4651, 3);

    expect(result.assumptions).toContain(EM_DISCLOSURE);
    expect(result.assumptions.some((a) => a.startsWith("Expected-move estimate unavailable"))).toBe(false);
  });

  it("falls back to legacy percentage targets — disclosed by name — when a chain has no usable IV", async () => {
    const scanner = new OpportunityScanner(fakeScreener({
      NOIV: makeContracts("NOIV", 100, 0),
      HIV: makeContracts("HIV", 100, 0.3),
    }));
    const result = await scanner.scan(["NOIV", "HIV"], scanTemplate(), { now: scanNow });

    const noiv = result.matrix.find((m) => m.symbol === "NOIV")!;
    expect(noiv.targetPrice).toBe(105); // legacy 100 × 1.05 bullish factor
    expect(noiv.targetSource).toBe("thesis");
    expect(noiv.targetEmUnits).toBeNull();
    const hiv = result.matrix.find((m) => m.symbol === "HIV")!;
    expect(hiv.targetPrice).toBe(105.16); // EM-derived
    expect(hiv.targetEmUnits).toBeCloseTo(0.6, 2);

    // Both disclosures appear, EM basis first, the fallback naming only NOIV.
    expect(result.assumptions).toEqual([
      EM_DISCLOSURE,
      "Expected-move estimate unavailable for NOIV; legacy percentage targets were used for those names.",
    ]);
  });

  it("resolves an em override end to end, and falls back (disclosed) on a chain without IV", async () => {
    const scanner = new OpportunityScanner(fakeScreener({
      HIV: makeContracts("HIV", 200, 0.3),
      NOIV: makeContracts("NOIV", 200, 0),
    }));
    const result = await scanner.scan(["HIV", "NOIV"], scanTemplate({
      perSymbol: {
        HIV: { target: { kind: "em", multiple: 0.8 } },
        NOIV: { target: { kind: "em", multiple: 0.8 } },
      },
    }), { now: scanNow });

    const hiv = result.matrix.find((m) => m.symbol === "HIV")!;
    expect(hiv.targetSource).toBe("em");
    expect(hiv.targetPrice).toBe(213.76); // 200 × (1 + 0.8 × 0.08601)
    expect(hiv.targetEmUnits).toBeCloseTo(0.8, 2);
    const noiv = result.matrix.find((m) => m.symbol === "NOIV")!;
    expect(noiv.targetSource).toBe("thesis"); // em override could not resolve
    expect(noiv.targetPrice).toBe(210); // legacy bullish factor
    expect(noiv.targetEmUnits).toBeNull();

    expect(result.assumptions).toContain("Per-name overrides applied: HIV (target +0.8 EM); NOIV (target +0.8 EM).");
    expect(result.assumptions).toContain(
      "Expected-move estimate unavailable for NOIV; legacy percentage targets were used for those names.",
    );
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE (issue #25): a $40 and a $700 name with equal signal quality
// and equal expected-move-relative targets score comparably.
// ---------------------------------------------------------------------------

/** Black-Scholes-priced chain on a moneyness grid: premiums, deltas and
 *  thetas scale with spot (BS is homogeneous of degree 1 in spot/strike),
 *  so the two names carry identical RELATIVE structure — the only
 *  asymmetries left are the equal-dollar per-contract fees. */
function bsContracts(symbol: string, spot: number, iv: number): ScreenedOptionContractItem[] {
  const t = 30 / 365;
  const now = Date.now();
  return [0.9, 0.95, 1, 1.05, 1.1].flatMap((mult) => {
    const strike = Math.round(spot * mult * 100) / 100;
    const halfSpread = spot * 0.005; // proportional: 1% of spot round trip
    const base = {
      underlyingSymbol: symbol,
      underlyingPrice: spot,
      daysToExpiration: 30,
      expirationDate: scanExpiryDate,
      moneyness: "ATM" as const,
      strikeDistancePct: (Math.abs(strike - spot) / spot) * 100,
      spreadPct: 5,
      quoteAgeSeconds: 0,
      quoteTimestamp: new Date(now).toISOString(),
      quoteFreshness: "FRESH" as const,
      volume: 1_000,
      openInterest: 2_000,
      impliedVolatility: iv,
      adjustedFlag: false,
      technicalSignal: "fixture",
      highlightReason: "fixture",
    };
    return (["CALL", "PUT"] as const).map((optionType) => {
      const g = blackScholesGreeks(spot, strike, t, iv, 0.04, 0, optionType);
      return {
        ...base,
        optionType,
        symbol: `${symbol}${strike}${optionType === "CALL" ? "C" : "P"}`,
        osiKey: `${symbol}-${strike}${optionType === "CALL" ? "C" : "P"}`,
        strikePrice: strike,
        bid: Math.max(0.05, g.price - halfSpread),
        ask: g.price + halfSpread,
        lastPrice: g.price,
        delta: g.delta,
        gamma: g.gamma,
        theta: g.theta,
        vega: g.vega,
      };
    });
  });
}

describe("acceptance: $40 vs $700 at equal EM-relative targets (issue #25)", () => {
  it("scores the two names comparably, with equal targetEmUnits and different dollar targets", async () => {
    const scanner = new OpportunityScanner(fakeScreener({
      CHEAP: bsContracts("CHEAP", 40, 0.35),
      EXPENSIVE: bsContracts("EXPENSIVE", 700, 0.35),
    }));
    // The risk cap is set high enough to be non-binding for BOTH names'
    // analog structures. That isolates the #25 variables: maxPlannedLoss
    // is the user's own dollar budget, applied uniformly — the
    // recommender's capitalSafety component (maxLoss vs that cap) and
    // the cap's candidate filter legitimately differentiate names whose
    // structures consume different shares of one shared budget. That is
    // a budget constraint doing its job, not a comparison unit; with it
    // non-binding, the only remaining asymmetry is the equal-dollar
    // per-contract fee weighing ~17× more on the $40 name's P&L.
    const result = await scanner.scan(
      ["CHEAP", "EXPENSIVE"],
      scanTemplate({ maxPlannedLoss: 100_000 }),
      { now: scanNow },
    );

    const cheap = result.opportunities.find((o) => o.symbol === "CHEAP");
    const expensive = result.opportunities.find((o) => o.symbol === "EXPENSIVE");
    expect(cheap).toBeDefined();
    expect(expensive).toBeDefined();

    // Same EM-relative target (+0.6 EM at IV 0.35 / 30d ≈ +6.02%)…
    expect(cheap!.targetEmUnits).toBeCloseTo(0.6, 2);
    expect(expensive!.targetEmUnits).toBeCloseTo(0.6, 2);
    expect(cheap!.targetEmUnits).toBeCloseTo(expensive!.targetEmUnits!, 2);
    // …at very different absolute targets.
    expect(cheap!.targetPrice).toBe(42.41); // 40 × 1.06021
    expect(expensive!.targetPrice).toBe(742.14); // 700 × 1.06021

    // Both names pick the SAME relative structure (the 0.95/1.05 call
    // debit spread) — pre-#25 the $700 name's winner was a different
    // structure, because its fixed-% target and the $100 capital-
    // efficiency floor were not the same yardstick as the $40 name's.
    expect(cheap!.pick.best!.candidate.legs.map((l) => l.strike)).toEqual([38, 42]);
    expect(expensive!.pick.best!.candidate.legs.map((l) => l.strike)).toEqual([665, 735]);

    // Comparable composite scores and the same gate verdict (exact
    // equality is not expected — the fee asymmetry above).
    expect(Math.abs(cheap!.score - expensive!.score)).toBeLessThanOrEqual(3);
    expect(cheap!.gateBucket).toBe(expensive!.gateBucket);
  });
});

// ---------------------------------------------------------------------------
// NLQ display (issue #25 acceptance: output shows both units)
// ---------------------------------------------------------------------------

function chainFor(symbol: string, spot: number, expiry: { year: number; month: number; day: number }): ETradeOptionChain {
  const quoteTimestamp = Date.now();
  const leg = (type: "CALL" | "PUT", strike: number) => {
    const mid = legMid(spot, strike, type);
    const deltaMag = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    return {
      timeStamp: quoteTimestamp,
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

describe("NLQ scan rows show the target in dollars and EM units (issue #25)", () => {
  it("formats each opportunity row's target as $X (+N.NN EM)", async () => {
    const intent = parseOptionsStrategyIntent("Best bullish option trades for NVDA and AMD max loss $5000");
    expect(intent?.action).toBe("options_opportunities");

    const expiryDateObj = new Date(Date.now() + 30 * 86_400_000);
    const expiry = { year: expiryDateObj.getUTCFullYear(), month: expiryDateObj.getUTCMonth() + 1, day: expiryDateObj.getUTCDate() };
    const spots: Record<string, number> = { NVDA: 250, AMD: 40 };
    const client = {
      getOptionExpireDates: async () => [expiry],
      getOptionChains: async (args: { symbol: string }) => chainFor(args.symbol, spots[args.symbol] ?? 100, expiry),
    };
    const etrade = {
      client: client as never,
      fetchQuoteRemote: async () => ({ lastPrice: 0 }),
      getWatchlists: async () => [],
      screenMarketsAsync: async () => ({ stocks: [] }),
    };

    const out = await runOptionsStrategyAction(etrade as never, intent!.action, intent!.filters);
    expect(out.status).toBe("ranked_opportunities");
    expect(out.rows.length).toBeGreaterThan(0);
    for (const row of out.rows) {
      expect(row.target).toMatch(/^\$\d+\.\d{2} \([+-]\d+\.\d{2} EM\)$/);
    }
    const nvda = out.rows.find((r) => r.symbol === "NVDA")!;
    expect(nvda.target).toBe("$262.90 (+0.60 EM)"); // EM-derived thesis target at IV 0.3 / 30d
  });
});
