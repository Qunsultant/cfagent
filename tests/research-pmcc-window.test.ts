/**
 * Issue #353 — PMCC data window.
 *
 * The research pipeline's pmccEnabled flag was inert: getChain loaded only
 * the first four expirations (slice(0, 4)), while the PMCC branch required a
 * >=300 DTE expiry — so `leaps` was always undefined. These tests pin the fix:
 *
 * - getChain selects expirations across BOTH working windows (near 30–45 DTE
 *   band and the >=180 DTE LEAPS band), bounded per band.
 * - A chain fixture WITH a >=180 DTE expiry produces a PMCC candidate
 *   through the pipeline end-to-end (impossible before the fix).
 * - pmccEnabled=false produces none.
 * - A range_bound outlook can shortlist PMCC (catalog tags it
 *   [bullish, range_bound]; the thesis gate admits it).
 */
import { describe, it, expect } from "vitest";
import {
  runResearchPipeline,
  type ResearchDataProvider,
  type QuoteSnapshot,
  type ChainSnapshot,
  type Technicals,
  type RegimeAssessment,
} from "../src/services/researchPipeline";
import {
  RESEARCH_CONFIG_DEFAULTS,
  type ResearchConfig,
} from "../src/services/researchConfig";
import { PlatformResearchDataProvider } from "../src/services/researchProviders";
import type { Env } from "../src/types";

const NOW = Date.now();

function leg(
  optionType: "call" | "put",
  strike: number,
  dte: number,
  bid: number,
  ask: number
) {
  return {
    optionType,
    strike,
    expiry: "2027-01-01",
    dte,
    bid,
    ask,
    iv: 0.42,
    volume: 120,
    openInterest: 600,
  } as ChainSnapshot["expiries"][number]["legs"][number];
}

/** Chain fixture: near band + LEAPS band, with PMCC-eligible legs.
 *
 * The near expiry carries a single call and a single put, so none of the
 * other structures can build (bull_call_spread needs two calls,
 * bull_put_spread two puts, iron_condor four legs, butterfly a body at
 * the money) — only PMCC has the legs it needs.
 */
function pmccChain(symbol: string): ChainSnapshot {
  const near = [leg("call", 105, 35, 1.5, 1.62), leg("put", 95, 35, 1.2, 1.3)];
  const leaps = [
    // Deep ITM call for the long leg: strike < spot * 0.9, spot = 100.
    leg("call", 85, 210, 25.0, 25.6),
    leg("call", 95, 210, 16.2, 16.7),
    leg("put", 90, 210, 14.0, 14.5),
  ];
  return {
    symbol,
    underlyingPrice: 100,
    asOf: NOW - 60_000,
    provenance: "live",
    expiries: [
      { expiry: "2026-11-20", dte: 35, legs: near },
      { expiry: "2027-05-18", dte: 210, legs: leaps },
    ],
  };
}

function fixtureProvider(opts: {
  trend?: Technicals["trend"];
} = {}): ResearchDataProvider {
  const quote = (symbol: string): QuoteSnapshot => ({
    symbol,
    price: 100,
    timestamp: NOW - 60_000,
    marketCap: 10e9,
    isEtf: false,
    quoteStatus: "live",
    source: "etrade",
  });
  return {
    getUniverseSymbols: async () => ["AAA"],
    getQuote: async (s) => quote(s),
    getChain: async (symbol) => pmccChain(symbol),
    getTechnicals: async () => ({
      trend: opts.trend ?? "up",
      momentum: 0.3,
      rsi: 58,
      notes: [],
    }),
    getCatalysts: async () => null,
    getRegime: async (): Promise<RegimeAssessment> => ({
      regime: "bull",
      notes: ["Fixture regime."],
      asOf: NOW,
    }),
  };
}

function testConfig(
  overrides: Partial<ResearchConfig> = {}
): ResearchConfig {
  return {
    ...RESEARCH_CONFIG_DEFAULTS,
    maxCandidates: 4,
    maxChainsPerRun: 4,
    oodaMaxIterations: 10,
    ...overrides,
  };
}

/** Fake expiry-date rows the way E*TRADE returns them ({year, month, day}). */
function expiryDates(dtes: number[]) {
  return dtes.map((dte) => {
    const d = new Date(NOW + dte * 86_400_000);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
    };
  });
}

describe("research PMCC data window (#353)", () => {
  it("getChain selects both the near band and the LEAPS band", async () => {
    const provider = new PlatformResearchDataProvider(
      {} as Env,
      "tester"
    );
    let fetched = 0;
    // #928 same-PR pin update: the stub previously assigned `.etrade`,
    // a field getChain never reads (the platform field is `platform`), so
    // this band-selection test passed only via the now demo-gated
    // calibrated fallback. Wire the stub to `platform` so the test exercises
    // the live band selection it claims to pin; assertions unchanged.
    (provider as unknown as { platform: unknown }).platform = {
      getOptionExpireDates: async () =>
        expiryDates([7, 14, 21, 28, 35, 42, 60, 90, 180, 240, 365]),
      getOptionChains: async () => {
        fetched += 1;
        return {
          underlyingPrice: 100,
          pairs: [
            {
              call: {
                strikePrice: 100,
                bid: 4.8,
                ask: 5.0,
                impliedVolatility: 0.42,
                volume: 100,
                openInterest: 500,
              },
            },
          ],
        };
      },
    };
    const chain = await provider.getChain("AAA");
    // The old slice(0, 4) cut every expiry beyond 28 DTE — this fails there.
    expect(
      chain.expiries.some((e) => e.dte >= 180),
      "LEAPS expiry must be loaded"
    ).toBe(true);
    expect(
      chain.expiries.some((e) => e.dte >= 30 && e.dte <= 45),
      "near-band expiry must be loaded"
    ).toBe(true);
    // Bounded per band: 4 near-band max + 4 LEAPS max.
    expect(fetched).toBeLessThanOrEqual(8);
  });

  it("a >=180 DTE expiry produces a PMCC candidate end-to-end", async () => {
    const report = await runResearchPipeline(
      { provider: fixtureProvider() },
      testConfig({ pmccEnabled: true }),
      { trigger: "manual", userLogin: "tester", runId: "rsr_pmcc1", now: NOW }
    );
    const pmcc = report.ideas.filter((t) => t.structure === "pmcc");
    expect(
      pmcc.length,
      "PMCC should qualify when a >=180 DTE expiry exists"
    ).toBeGreaterThan(0);
  });

  it("pmccEnabled=false suppresses PMCC everywhere", async () => {
    const report = await runResearchPipeline(
      { provider: fixtureProvider() },
      testConfig({ pmccEnabled: false }),
      { trigger: "manual", userLogin: "tester", runId: "rsr_pmcc2", now: NOW }
    );
    expect(
      report.ideas.some((t) => t.structure === "pmcc")
    ).toBe(false);
    expect(report.watchlist.some((w) => w.structure === "pmcc")).toBe(false);
  });

  it("a range_bound outlook can shortlist PMCC", async () => {
    const report = await runResearchPipeline(
      { provider: fixtureProvider({ trend: "flat" }) },
      testConfig({ pmccEnabled: true }),
      { trigger: "manual", userLogin: "tester", runId: "rsr_pmcc3", now: NOW }
    );
    const all = [...report.ideas, ...report.watchlist];
    expect(
      all.some((t) => t.structure === "pmcc"),
      "PMCC must survive the range_bound outlook + thesis gate"
    ).toBe(true);
  });
});
