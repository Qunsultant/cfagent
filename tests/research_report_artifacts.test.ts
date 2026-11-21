/**
 * Issue #2167: options research runs produce PDF + XLSX + CSV at parity.
 *
 * Pins (TDD red first — the workbook/CSV renderers and the storage seam are new):
 *  - the research row model: ideas (economics, falsification, legs), legs,
 *    watchlist, rejected, run summary;
 *  - the CSV idea table and the XLSX five tabs, both from the same model;
 *  - the shared leg line (side from the quantity sign, contract from
 *    strike/expiry/type, price from the mid) — the PDF uses it too, so a
 *    research leg never renders blanks;
 *  - ResearchAgent.generateAndStoreResearchArtifacts: the research key
 *    family, per-format statuses, and per-format failure isolation;
 *  - the artifact-link mapping onto /api/research/report.*;
 *  - the run-summary read side: an `options_research` row's keys resolve to
 *    the research routes, so Docs and Reports shows all three downloads.
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import {
  researchIdeaRows,
  researchLegLine,
  researchLegRows,
  researchReportArtifactLinks,
  researchReportFileName,
} from "../src/trading/researchReportData";
import { generateResearchReportCsv } from "../src/trading/researchReportCsv";
import { generateResearchReportXlsx } from "../src/trading/researchReportXlsx";
import { ResearchAgent } from "../src/agents/research-agent";
import { runSummaryFromReport } from "../src/services/runSummaries";
import { scheduledReportPdfUrl } from "../src/services/scheduledReports";
import type { ResearchReport } from "../src/services/researchPipeline";

class FakeStorage {
  map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

class XlsxFailingStorage extends FakeStorage {
  async put(key: string, value: unknown): Promise<void> {
    if (String(key).includes(":xlsx:")) throw new Error("r2 unavailable");
    return super.put(key, value);
  }
}

class CsvFailingStorage extends FakeStorage {
  async put(key: string, value: unknown): Promise<void> {
    if (String(key).includes(":csv:")) throw new Error("r2 unavailable");
    return super.put(key, value);
  }
}

function leg(over: Record<string, unknown> = {}) {
  return {
    optionType: "call",
    strike: 180,
    expiry: "2026-11-20",
    dte: 23,
    bid: 5.2,
    ask: 5.3,
    quantity: 1,
    iv: 0.42,
    volume: 1200,
    openInterest: 8000,
    ...over,
  };
}

function idea(over: Record<string, unknown> = {}) {
  return {
    rank: 1,
    symbol: "NVDA",
    outlook: "bullish",
    thesis: "Momentum intact, above the 20-day",
    supportingEvidence: ["Above the 20-day", "Sector strength"],
    contradictingEvidence: ["IV is elevated"],
    falsification: {
      whyMarketWrong: "Positioning is crowded",
      resolutionTrigger: "Close above 182",
      horizon: "3 weeks",
      invalidation: "Close below 170",
      whyThisStructure: "Defined risk into earnings",
    },
    falsificationWarnings: [],
    premortem: {},
    structure: "call_debit_spread",
    legs: [leg(), leg({ optionType: "call", strike: 190, quantity: -1, bid: 1.1, ask: 1.2 })],
    economics: {
      structure: "call_debit_spread",
      legs: [],
      netDebit: 4.15,
      netCredit: 0,
      maxLoss: 415,
      maxGain: 585,
      breakevens: [184.15],
      derivationNotes: [],
    },
    contractualMaxLoss: 415,
    scenarios: [],
    entryCondition: "On a close above 180",
    invalidation: "Below 170",
    feesNote: "",
    limitations: ["Liquidity is thin after hours"],
    sources: ["E*TRADE"],
    score: 82.5,
    ...over,
  };
}

function report(over: Partial<ResearchReport> = {}): ResearchReport {
  return {
    runId: "run-1",
    generationId: "research:manual:2026-10-28T19:00:00.000Z",
    trigger: "manual",
    userLogin: "tester",
    createdAt: "2026-10-28T19:00:00.000Z",
    rulesVersion: "v1",
    configSnapshot: { universe: "watchlist", minScore: 60 } as any,
    regime: { regime: "risk_on", notes: ["Breadth improving"] } as any,
    summary: "1 qualified idea, 1 on watch.",
    ideas: [idea()] as any,
    watchlist: [
      {
        symbol: "AMD",
        outlook: "neutral",
        thesis: "Range-bound",
        structure: "iron_condor",
        reason: "Waiting for the range to hold",
        triggerCondition: "Range holds for 3 sessions",
      },
    ] as any,
    rejected: [
      { symbol: "TSLA", outlook: "bearish", structure: "put_debit_spread", gate: "liquidity", reason: "Spreads too wide" },
    ] as any,
    stats: {
      universeSize: 10,
      quotesRetrieved: 9,
      candidatesEvaluated: 12,
      chainsFetched: 9,
      chainsCalibrated: 8,
      qualified: 1,
      watchlist: 1,
      rejected: 1,
      unverified: 0,
      oodaIterations: 2,
      durationMs: 5400,
    } as any,
    oodaTrace: [] as any,
    stageTrace: [] as any,
    brokerId: "alpaca",
    mode: "paper",
    assetType: "options",
    symbolEvaluations: [
      {
        symbol: "NVDA", outcome: "evaluated", reason: "chain pulled", outlook: "bullish", selectedStrategy: "call_debit_spread",
        quote: { price: 180, timestamp: 1, quoteStatus: "live", source: "alpaca" },
        chain: { outcome: "retrieved", source: "alpaca", provenance: "live", asOf: 2, expiryCount: 2, legCount: 12 },
        strategies: [{ strategy: "call_debit_spread", outcome: "qualified", legs: [] as any }],
      },
    ],
    ...over,
  };
}

describe("research report row model (#2167)", () => {
  it("projects ideas with economics, falsification and leg text", () => {
    const rows = researchIdeaRows(report());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rank: 1,
      symbol: "NVDA",
      outlook: "bullish",
      structure: "call_debit_spread",
      score: 82.5,
      net_debit: 4.15,
      net_credit: 0,
      max_loss: 415,
      max_gain: 585,
      contractual_max_loss: 415,
      breakevens: "184.15",
    });
    expect(rows[0].legs).toContain("BUY 1 CALL 180 2026-11-20 @ 5.25");
    expect(rows[0].legs).toContain("SELL 1 CALL 190 2026-11-20 @ 1.15");
  });

  it("projects legs with the side from the quantity sign and the mid price", () => {
    const legs = researchLegRows(report());
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({
      idea_rank: 1,
      symbol: "NVDA",
      side: "BUY",
      quantity: 1,
      option_type: "CALL",
      strike: 180,
      expiry: "2026-11-20",
      mid: 5.25,
    });
    expect(legs[1]).toMatchObject({ side: "SELL", quantity: 1, strike: 190, mid: 1.15 });
  });

  it("renders an unbounded max gain as null, never a fake number", () => {
    const rows = researchIdeaRows(
      report({ ideas: [idea({ economics: { ...idea().economics, maxGain: null } })] as any }),
    );
    expect(rows[0].max_gain).toBeNull();
  });

  it("projects every symbol's quote, chain and strategy outcome", () => {
    const csv = generateResearchReportCsv(report());
    expect(csv).toContain("symbol_evaluation");
    expect(csv).toContain("alpaca");
    expect(csv).toContain("call_debit_spread");
    const wb = XLSX.read(generateResearchReportXlsx(report()), { type: "buffer" });
    const evaluations = XLSX.utils.sheet_to_json(wb.Sheets["Symbol Evaluations"]) as Array<Record<string, unknown>>;
    expect(evaluations[0]).toMatchObject({ symbol: "NVDA", outcome: "evaluated", quote_source: "alpaca", chain_provenance: "live", selected_strategy: "call_debit_spread" });
  });

  it("survives a report with no ideas, watchlist or rejects", () => {
    const rows = researchIdeaRows(report({ ideas: [] as any, watchlist: [] as any, rejected: [] as any }));
    expect(rows).toEqual([]);
    expect(researchLegRows(report({ ideas: [] as any }))).toEqual([]);
  });
});

describe("research leg line (#2167)", () => {
  it("renders the real leg fields, not blanks", () => {
    expect(researchLegLine(leg() as any)).toBe("BUY 1 CALL 180 2026-11-20 @ 5.25");
    expect(researchLegLine(leg({ quantity: -2, optionType: "put" }) as any)).toBe("SELL 2 PUT 180 2026-11-20 @ 5.25");
  });

  it("states a missing quote instead of inventing one", () => {
    expect(researchLegLine(leg({ bid: null, ask: null }) as any)).toContain("@ —");
  });
});

describe("research report renderers (#2167)", () => {
  it("CSV carries the idea table with the run's values", () => {
    const csv = generateResearchReportCsv(report());
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("record_type,rank,symbol,outlook,structure,score");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("idea,1,NVDA");
    expect(lines[1]).toContain("call_debit_spread");
    expect(lines[1]).toContain("82.5");
    expect(lines[1]).toContain("184.15");
    expect(lines[2]).toContain("symbol_evaluation");
  });

  it("XLSX has idea, outcome, symbol evaluation and run provenance tabs", () => {
    const wb = XLSX.read(generateResearchReportXlsx(report()), { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Ideas", "Legs", "Trade Cards", "Watchlist", "Rejected", "Symbol Evaluations", "Run Summary"]);

    const ideas = XLSX.utils.sheet_to_json(wb.Sheets.Ideas) as Array<Record<string, unknown>>;
    expect(ideas).toHaveLength(1);
    expect(ideas[0].symbol).toBe("NVDA");
    expect(ideas[0].max_gain).toBe(585);

    const legs = XLSX.utils.sheet_to_json(wb.Sheets.Legs) as Array<Record<string, unknown>>;
    expect(legs).toHaveLength(2);
    expect(legs[0].side).toBe("BUY");

    const watchlist = XLSX.utils.sheet_to_json(wb.Sheets.Watchlist) as Array<Record<string, unknown>>;
    expect(watchlist[0].symbol).toBe("AMD");

    const rejected = XLSX.utils.sheet_to_json(wb.Sheets.Rejected) as Array<Record<string, unknown>>;
    expect(rejected[0].gate).toBe("liquidity");

    const summary = XLSX.utils.sheet_to_json(wb.Sheets["Run Summary"], { header: 1 }) as unknown[][];
    const byField = new Map(summary.map((row) => [String(row[0]), row[1]]));
    expect(byField.get("run_id")).toBe("run-1");
    expect(byField.get("qualified")).toBe(1);
    expect(byField.get("regime")).toBe("risk_on");
    expect(byField.get("broker")).toBe("alpaca");
    expect(byField.get("mode")).toBe("paper");
  });

  it("names the workbook and CSV after the run, like the PDF", () => {
    expect(researchReportFileName(report(), "xlsx")).toMatch(/^research_manual_\d{4}-\d{2}-\d{2}T.*Z_run-1\.xlsx$/);
    expect(researchReportFileName(report(), "csv")).toMatch(/\.csv$/);
  });

  it("maps stored keys onto the research download routes", () => {
    expect(
      researchReportArtifactLinks({
        pdfKey: "report:pdf:research:1",
        pdfStatus: "generated",
        xlsxKey: "report:xlsx:research:1",
        xlsxStatus: "generated",
        csvKey: "report:csv:research:1",
        csvStatus: "generated",
      }),
    ).toEqual({
      pdfKey: "report:pdf:research:1",
      reportUrl: "/api/research/report.pdf?key=report%3Apdf%3Aresearch%3A1",
      xlsxKey: "report:xlsx:research:1",
      xlsxUrl: "/api/research/report.xlsx?key=report%3Axlsx%3Aresearch%3A1",
      csvKey: "report:csv:research:1",
      csvUrl: "/api/research/report.csv?key=report%3Acsv%3Aresearch%3A1",
    });
    expect(
      researchReportArtifactLinks({ pdfStatus: "failed", xlsxStatus: "failed", csvStatus: "failed" }),
    ).toEqual({});
  });
});

describe("ResearchAgent research artifact storage (#2167)", () => {
  function makeAgent(storage: FakeStorage): ResearchAgent {
    return new ResearchAgent({ storage } as any, {} as any);
  }

  it("stores the workbook and CSV under the research report family", async () => {
    const storage = new FakeStorage();
    const outcome = await makeAgent(storage).generateAndStoreResearchArtifacts(report());

    expect(outcome.xlsxStatus).toBe("generated");
    expect(outcome.xlsxKey).toMatch(/^report:xlsx:research:[0-9a-f]{8}$/);
    expect(outcome.csvStatus).toBe("generated");
    expect(outcome.csvKey).toMatch(/^report:csv:research:[0-9a-f]{8}$/);

    const csv = storage.map.get(outcome.csvKey!) as { fileName: string; base64: string };
    expect(csv.fileName).toMatch(/^research_manual_.*\.csv$/);
    const text = Buffer.from(csv.base64, "base64").toString("utf8");
    expect(text.split("\n")[0]).toContain("net_debit");
    expect(text).toContain("NVDA");

    const xlsx = storage.map.get(outcome.xlsxKey!) as { fileName: string; base64: string };
    expect(xlsx.fileName).toMatch(/^research_manual_.*\.xlsx$/);
    expect(Buffer.from(xlsx.base64, "base64").subarray(0, 2).toString()).toBe("PK");
  });

  it("records a failed workbook without losing the CSV", async () => {
    const outcome = await makeAgent(new XlsxFailingStorage()).generateAndStoreResearchArtifacts(report());
    expect(outcome.xlsxStatus).toBe("failed");
    expect(outcome.xlsxKey).toBeUndefined();
    expect(outcome.xlsxError).toContain("r2 unavailable");
    expect(outcome.xlsxError).toContain("FAILURE_REPORT_XLSX_GENERATION");
    expect(outcome.csvStatus).toBe("generated");
    expect(outcome.csvKey).toBeTruthy();
  });

  it("records a failed CSV from the catalog without losing the workbook (#2255)", async () => {
    const outcome = await makeAgent(new CsvFailingStorage()).generateAndStoreResearchArtifacts(report());
    expect(outcome.csvStatus).toBe("failed");
    expect(outcome.csvKey).toBeUndefined();
    expect(outcome.csvError).toContain("FAILURE_REPORT_CSV_GENERATION");
    expect(outcome.xlsxStatus).toBe("generated");
    expect(outcome.xlsxKey).toBeTruthy();
  });
});

describe("options_research in the Runs read surface (#2167)", () => {
  const body = JSON.stringify({
    trigger: "manual",
    summary: "1 qualified idea.",
    pdfKey: "report:pdf:research:1",
    pdfStatus: "generated",
    xlsxKey: "report:xlsx:research:1",
    xlsxStatus: "generated",
    csvKey: "report:csv:research:1",
    csvStatus: "generated",
  });

  const hit = {
    id: "options_research:run-1",
    runId: "options_research:run-1",
    title: "Options research — 2026-10-28 (manual)",
    summary: "1 qualified idea.",
    source: "options_research",
    createdAt: "2026-10-28T19:00:00.000Z",
    body,
  };

  it("maps all three keys to the research download URLs", () => {
    const summary = runSummaryFromReport(hit as any);
    expect(summary.reportUrl).toBe("/api/research/report.pdf?key=report%3Apdf%3Aresearch%3A1");
    expect(summary.xlsxUrl).toBe("/api/research/report.xlsx?key=report%3Axlsx%3Aresearch%3A1");
    expect(summary.csvUrl).toBe("/api/research/report.csv?key=report%3Acsv%3Aresearch%3A1");
    expect(summary.pdfStatus).toBe("generated");
  });

  it("scheduledReportPdfUrl serves a research PDF from the research route", () => {
    expect(scheduledReportPdfUrl("options_research", body)).toBe(
      "/api/research/report.pdf?key=report%3Apdf%3Aresearch%3A1",
    );
  });
});
