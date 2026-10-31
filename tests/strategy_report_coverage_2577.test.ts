/**
 * Issue #2577: the strategy report states its scope and its coverage.
 *
 * The report used to answer "why only three strategies?" with silence: it
 * rendered whatever rows it was handed and never named the wanted set.
 * These tests pin the coverage contract — wanted, reported, and a reason
 * per absent strategy — and that it reaches the workbook and the PDF
 * without changing the CSV contract.
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import { PDFDocument } from "pdf-lib";
import {
  buildStrategyReportCoverage,
  buildStrategyReportInput,
  generateStrategyReportCsv,
  generateStrategyReportPdf,
  generateStrategyReportXlsx,
} from "../src/trading/strategyReport";
import { resolveOptionsReportScope } from "../src/trading/optionsReportScope";

function candidate(over: Record<string, any> = {}) {
  return {
    id: "c-1",
    type: "long_call",
    label: "Long Call",
    symbol: "NVDA",
    expirationDate: "2026-11-20",
    legs: [
      {
        symbol: "NVDA  261120C00180000",
        optionType: "CALL",
        side: "BUY",
        quantity: 1,
        strike: 180,
        expirationDate: "2026-11-20",
        entryPrice: 5.25,
        impliedVolatility: 0.42,
        delta: 0.51,
        openInterest: 12000,
        volume: 3400,
      },
    ],
    netDebit: 5.25,
    maxProfit: 475,
    maxProfitUnbounded: false,
    maxLoss: 525,
    breakevens: [185.25],
    targetRewardRisk: 0.9,
    modelImpliedProbabilityOfProfit: 0.61,
    rationale: "Momentum intact above the 20-day.",
    explanations: ["Above the 20-day"],
    ...over,
  };
}

function ranked(id: string, rank: number, over: Record<string, any> = {}) {
  return { candidate: candidate({ id, ...over }), rank, compositeScore: 90 - rank, components: {} } as any;
}

describe("strategy report coverage (#2577)", () => {
  it("names every wanted strategy the report does not carry, with a reason", () => {
    const scope = resolveOptionsReportScope({
      thesis: "bullish",
      strategies: ["long_call", "put_credit_spread", "iron_condor"],
    });
    const coverage = buildStrategyReportCoverage({
      scope,
      reported: ["long_call", "put_credit_spread"],
      evaluations: [{ id: "long_call" }, { id: "put_credit_spread" }, { id: "iron_condor" }],
    });
    expect(coverage.wantedStrategyIds).toEqual(["long_call", "put_credit_spread", "iron_condor"]);
    expect(coverage.reportedStrategyIds).toEqual(["long_call", "put_credit_spread"]);
    const missing = coverage.notReported.find((entry) => entry.id === "iron_condor");
    expect(missing).toBeTruthy();
    expect(missing!.label).toBe("Iron Condor");
    expect(missing!.reason).toContain("not thesis-aligned");
    expect(coverage.theses).toEqual(["bullish"]);
    expect(coverage.scope).toContain("bullish");
  });

  it("distinguishes 'evaluated but not ranked' from 'never evaluated'", () => {
    const scope = resolveOptionsReportScope({ strategies: ["long_call", "long_put"] });
    const coverage = buildStrategyReportCoverage({
      scope,
      reported: ["long_call"],
      evaluations: [{ id: "long_call" }, { id: "long_put" }],
    });
    expect(coverage.notReported[0].reason).toContain("evaluated, but no ranked candidate");
  });

  it("names the horizon gap instead of blaming the chain", () => {
    const scope = resolveOptionsReportScope({
      strategies: ["leaps_call", "long_call"],
      dte: { maxDte: 60 },
    });
    const coverage = buildStrategyReportCoverage({ scope, reported: ["long_call"] });
    expect(coverage.notReported[0].id).toBe("leaps_call");
    expect(coverage.notReported[0].reason).toContain("requires expiries beyond");
  });

  it("derives coverage from the request when the caller passes none", () => {
    const input = buildStrategyReportInput({
      action: "strategies",
      request: { symbol: "NVDA", thesis: "bullish", allowedStrategies: ["long_call", "iron_condor"] },
      data: { ranked: [ranked("c-1", 1)] },
      symbol: "NVDA",
    });
    expect(input.coverage).toBeTruthy();
    expect(input.coverage!.wantedStrategyIds.sort()).toEqual(["iron_condor", "long_call"]);
    expect(input.coverage!.reportedStrategyIds).toEqual(["long_call"]);
  });

  it("renders a Coverage sheet and a coverage summary in the workbook", () => {
    const input = buildStrategyReportInput({
      action: "strategies",
      request: { symbol: "NVDA", thesis: "bullish", allowedStrategies: ["long_call", "iron_condor"] },
      data: { ranked: [ranked("c-1", 1)] },
      symbol: "NVDA",
    });
    const wb = XLSX.read(generateStrategyReportXlsx(input), { type: "buffer" });
    expect(wb.SheetNames).toContain("Coverage");
    expect(wb.SheetNames).toContain("Coverage Summary");
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets.Coverage);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.strategy === "iron_condor")?.reported).toBe("no");
    expect(rows.find((row) => row.strategy === "long_call")?.reported).toBe("yes");
  });

  it("keeps the CSV contract unchanged (no coverage columns)", () => {
    const input = buildStrategyReportInput({
      action: "strategies",
      request: { symbol: "NVDA", thesis: "bullish", allowedStrategies: ["long_call"] },
      data: { ranked: [ranked("c-1", 1)] },
      symbol: "NVDA",
    });
    const csv = generateStrategyReportCsv(input);
    expect(csv.split("\n")[0]).toBe(
      "rank,strategy,label,symbol,expiration,legs,net_debit,max_profit,max_loss,breakevens,reward_risk,probability_of_profit,composite_score,ai_rank,ai_score,ai_rationale",
    );
  });

  it("produces a valid PDF with the coverage section", async () => {
    const input = buildStrategyReportInput({
      action: "strategies",
      request: { symbol: "NVDA", thesis: "bullish", allowedStrategies: ["long_call", "iron_condor"] },
      data: { ranked: [ranked("c-1", 1)] },
      symbol: "NVDA",
    });
    const bytes = await generateStrategyReportPdf(input);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });
});
