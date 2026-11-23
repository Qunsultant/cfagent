import { describe, it, expect } from "vitest";
import {
  generateResearchPdf,
  researchPdfFileName,
} from "../src/trading/researchReportPdf";
import type { ResearchReport } from "../src/services/researchPipeline";

function fixtureReport(overrides: Partial<ResearchReport> = {}): ResearchReport {
  return {
    runId: "run-335-test",
    generationId: "gen-1",
    trigger: "scheduled",
    userLogin: "tester",
    createdAt: "2026-10-20T12:00:00.000Z",
    rulesVersion: "v1",
    configSnapshot: { minScore: 20, maxIdeas: 5 } as any,
    regime: { regime: "chop", notes: ["mixed signals"], asOf: 0 },
    summary: "Test run summary.",
    ideas: [
      {
        rank: 1,
        symbol: "AVGO",
        outlook: "bullish",
        thesis: "Uptrend with support.",
        supportingEvidence: ["RSI 55"],
        contradictingEvidence: ["High IV"],
        falsification: {
          thesis: "t",
          whyMarketWrong: "w",
          resolutionTrigger: "r",
          horizon: "30d",
          contradictingEvidence: ["c"],
          invalidation: "i",
          whyThisStructure: "y",
        },
        falsificationWarnings: [],
        premortem: {} as any,
        structure: "bull_put_spread",
        legs: [],
        economics: {
          structure: "bull_put_spread",
          legs: [],
          netDebit: 0,
          netCredit: 75,
          maxLoss: 425,
          maxGain: 75,
        } as any,
        scenarios: [],
        entryCondition: "open",
        invalidation: "close below short",
        contractualMaxLoss: 425,
        feesNote: "fees",
        limitations: [],
        sources: [],
        quoteTimestamp: 0,
        entrySpot: 300,
        chainProvenance: {} as any,
        score: 28.5,
        status: "qualified",
      } as any,
    ],
    watchlist: [
      {
        symbol: "MRVL",
        outlook: "bullish",
        thesis: "t",
        structure: "s",
        reason: "r",
        triggerCondition: "breakout",
      },
    ],
    rejected: [
      {
        symbol: "AAPL",
        outlook: "bullish",
        structure: "s",
        gate: "earnings",
        reason: "earnings in window",
      },
    ],
    stats: {
      universeSize: 101,
      quotesRetrieved: 100,
      candidatesEvaluated: 50,
      chainsFetched: 10,
      chainsCalibrated: 10,
      qualified: 1,
      watchlist: 1,
      rejected: 1,
      unverified: 0,
      oodaIterations: 2,
      durationMs: 1000,
    },
    oodaTrace: [],
    ...overrides,
  };
}

describe("#335 research report PDF", () => {
  it("generates a valid PDF from the canonical report", async () => {
    const bytes = await generateResearchPdf(fixtureReport());
    expect(bytes.length).toBeGreaterThan(1000);
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
  });

  it("handles an empty run without throwing", async () => {
    const bytes = await generateResearchPdf(
      fixtureReport({ ideas: [], watchlist: [], rejected: [], summary: "" })
    );
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
  });

  it("follows the #297 naming convention", () => {
    const name = researchPdfFileName(fixtureReport());
    expect(name).toBe("research_scheduled_2026-10-20T12-00-00Z_run-335-test.pdf");
  });

  it("sanitizes trigger and run id in the filename", () => {
    const name = researchPdfFileName(
      fixtureReport({ trigger: "manual run!" as any, runId: "a/b:c" })
    );
    expect(name).not.toContain("/");
    expect(name).not.toContain(":");
    expect(name).not.toContain(" ");
    expect(name.endsWith(".pdf")).toBe(true);
  });

  it("generates a PDF when report text carries non-WinAnsi characters (#5109)", async () => {
    const base = fixtureReport();
    const bytes = await generateResearchPdf(
      fixtureReport({
        rejected: [
          {
            symbol: "AAPL",
            outlook: "bullish",
            structure: "s",
            gate: "quote_quality",
            reason:
              "Alpaca returned 3 expiration(s) for AAPL, but none were in the configured near-term (30–45 DTE) or LEAPS (≥180 DTE) bands.",
          },
        ],
        symbolEvaluations: [
          {
            symbol: "AAPL",
            outcome: "rejected",
            quote: null,
            chain: null,
            strategies: [],
            reason:
              "Alpaca returned 3 expiration(s) for AAPL, but none were in the configured near-term (30–45 DTE) or LEAPS (≥180 DTE) bands.",
          } as any,
        ],
        ideas: [
          {
            ...base.ideas[0],
            falsificationWarnings: ["⚠ IV is elevated vs history"],
          } as any,
        ],
      })
    );
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
