// @vitest-environment node
/**
 * Issue #5909 — a total data outage must not read as "no qualifying
 * opportunities".
 *
 * Pins:
 *  - 5909-P01 a non-empty universe with zero quotes yields a
 *    `research_data_unavailable` refusal on the report and says so in the
 *    summary (the 2026-11-20 j-stack run's exact shape);
 *  - 5909-P02 a run that fetched quotes carries no refusal;
 *  - 5909-P03 the refusal does not throw: the report is still produced — it is
 *    the evidence, and the caller decides the run's outcome from it.
 */
import { describe, it, expect } from "vitest";
import {
  runResearchPipeline,
  type QuoteSnapshot,
  type ResearchDataProvider,
} from "../src/services/researchPipeline";
import { RESEARCH_CONFIG_DEFAULTS, type ResearchConfig } from "../src/services/researchConfig";

const config: ResearchConfig = {
  ...RESEARCH_CONFIG_DEFAULTS,
  universe: "NASDAQ100",
  oodaMaxIterations: 4,
} as ResearchConfig;

function provider(quotes: Record<string, QuoteSnapshot | null>): ResearchDataProvider {
  return {
    getRegime: async () => {
      throw new Error("SPY quote unavailable");
    },
    getUniverseSymbols: async () => Object.keys(quotes),
    getQuote: async (symbol: string) => quotes[symbol] ?? null,
    getTechnicals: async () => null,
    getCatalysts: async () => null,
    getChain: async () => {
      throw new Error("no chain");
    },
  } as unknown as ResearchDataProvider;
}

const quote = (symbol: string): QuoteSnapshot => ({
  symbol,
  price: 100,
  timestamp: Date.parse("2026-11-20T17:35:00.000Z"),
  marketCap: 1e12,
  isEtf: false,
  quoteStatus: "live",
  source: "etrade",
});

describe("5909-P01 zero quotes for a non-empty universe is an outage", () => {
  it("carries research_data_unavailable and names the counts", async () => {
    const report = await runResearchPipeline(
      { provider: provider({ AAPL: null, MSFT: null }) },
      config,
      { trigger: "manual", userLogin: "spr9s", now: Date.parse("2026-11-20T17:35:02Z") },
    );

    expect(report.dataRefusal?.code).toBe("research_data_unavailable");
    expect(report.dataRefusal?.message).toContain("No quotes retrieved");
    expect(report.dataRefusal?.message).toContain("2-symbol universe");
    expect(report.stats.quotesRetrieved).toBe(0);
    expect(report.stats.universeSize).toBe(2);
    // The per-symbol rejections still tell the operator what each symbol did.
    expect(report.rejected).toHaveLength(2);
    expect(report.summary).toBe(report.dataRefusal?.message);
  });
});

describe("5909-P02 a run that fetched quotes carries no refusal", () => {
  it("stays a normal report when data arrived", async () => {
    const report = await runResearchPipeline(
      { provider: provider({ AAPL: quote("AAPL"), MSFT: quote("MSFT") }) },
      config,
      { trigger: "manual", userLogin: "spr9s", now: Date.parse("2026-11-20T17:35:02Z") },
    );

    expect(report.dataRefusal).toBeUndefined();
    expect(report.stats.quotesRetrieved).toBe(2);
  });
});
