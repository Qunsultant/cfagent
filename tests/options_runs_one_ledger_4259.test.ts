/**
 * Issue #4259 (FOLD — options runs in the one ledger): the scan-runs
 * store (mas_opportunity_scans) is a payload attachment to the ledger
 * row, not a second run store. The verdict, with the evidence that
 * forced it:
 *
 *  1. An options screen run writes BOTH a ledger row (the engine's
 *     recordTerminal → recordLedgerRun, workflowId = run id) AND a
 *     scan row (the scanner leg's persist stage) for the same run.
 *  2. Neither merged read joined on the #3314 linkage:
 *     mergeRunSummaries deduped scans only against canonical REPORT
 *     claims (body scanRunId), and the Workflow Runs route likewise
 *     — so a ledger row + its scan row rendered as two rows.
 *  3. The scan store holds no outcome of its own (status is derived
 *     "completed" on read); its run-metadata fields are exactly the
 *     §4 join keys + trigger. It is a payload attachment in shape
 *     already; only the read path treated it as a run list.
 *
 * Pinned here:
 *  1. Write side: the scanner leg's persist stage stamps the §4
 *     linkage onto the scan row at save time — workflowId = the
 *     producing run's id (the ledger row's workflowId), scheduleId /
 *     asyncJobId explicit nulls (schedule threading stays #4198).
 *  2. Backfill: the scheduled-path backfill preserves a stamped
 *     workflowId/asyncJobId instead of clobbering it with null
 *     (resolveScanBackfillLinkage); the #3314 adapter contract
 *     (overwrite incl. poisoned→null) is unchanged.
 *  3. Mappers: runSummaryFromScanRun + runSummaryFromJobRunRecord
 *     carry the §4 linkage onto the one Runs shape (null when the
 *     home store records none).
 *  4. Merge: mergeRunSummaries folds a scan row into its ledger row
 *     on an EXACT run-identity join (shared non-null asyncJobId or
 *     workflowId, or scan id == ledger workflowId). The ledger row
 *     wins as the record (id, runId, trigger, createdAt, status);
 *     it inherits the scan's payload refs (scanRunId, pdf/xlsx/csv,
 *     reportUrl, resultCount) + kind/title so kind-filtered reads
 *     keep showing the run. scheduleId alone NEVER folds (it names
 *     a schedule, not a run — many firings share it).
 *  5. Workflow Runs: a scan row claimed by a ledger row's linkage
 *     shows once, as the ledger run, with the scan's documents
 *     attached; an unclaimed scan still shows as its own run.
 *  6. Detail: /api/runs/details resolves an absorbed run by its
 *     scan id, so the old deep link keeps working. Issue #6101
 *     (D1-only): the scan store is gone — the scan id now rides the
 *     canonical report row in D1 (its body carries scanRunId),
 *     seeded directly through the D1 audit adapter, and the detail
 *     handler still matches scanRunId over the D1 lists; the twin
 *     D1 job-run-record row is absorbed into the report, so the
 *     detail resolves to the ledger-backed report row.
 */
import { describe, expect, it } from "vitest";
import { buildJobRunRecord, type JobRunRecord } from "../src/services/jobRunRecords";
import {
  mergeRunSummaries,
  runSummaryFromJobRunRecord,
  runSummaryFromScanRun,
  scanRunMatchesLedgerRow,
  type RunSummary,
} from "../src/services/runSummaries";
import { resolveScanBackfillLinkage } from "../src/data/scanRunPorts";
import type { ScanRunSummary } from "../src/data/scanRunPorts";
import { MockSqlStorage } from "./mock-sql";
import { MockD1Database } from "./mock-d1";
import { handleReportsRoutes } from "../src/agents/routes/reports";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";
import { d1JobRunRecordId } from "../src/services/jobRunRecordReads";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
} from "../src/data/d1JobRunRecordAdapter";
import { createAuditReportAdapter } from "../src/data/createAuditReportPorts";
import { ensureAuditReportSchema } from "../src/data/d1AuditReportAdapter";
import { storeReportAtGeneration } from "../src/services/scheduledReports";
import { OpportunityScanner, type ScanRequestTemplate } from "../src/trading/options/opportunityScanner";
import { OptionsDataAgent } from "../src/trading/options/optionsDataAgent";
import { StrategyRiskAgent } from "../src/trading/options/strategyRiskAgent";
import { RecommendationAgent } from "../src/trading/options/recommendationAgent";
import type { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, OptionScreenResult, ScreenedOptionContractItem } from "../src/types";
import { runOptionsScreenWorkflow } from "../src/workflows/optionsScreenWorkflow";
import { createScannerScreenPorts } from "../src/workflows/strategyScreenPorts";
import { optionsArtifactKey } from "../src/workflows/optionsScreenPorts";
import type { ScanRunStore } from "../src/data/scanRunPorts";

/* ------------------------------------------------------------------ */
/* Shared fixtures                                                     */
/* ------------------------------------------------------------------ */

function ledgerRecord(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return buildJobRunRecord({
    system: "job-pipeline",
    jobId: "options-screen",
    operation: "job",
    started: "2026-11-11T10:00:00.000Z",
    finished: "2026-11-11T10:02:30.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    trigger: "scheduled",
    scheduleId: "sched-4259",
    asyncJobId: null,
    workflowId: "run-4259",
    ...overrides,
  });
}

function scanSummary(overrides: Partial<ScanRunSummary> = {}): ScanRunSummary {
  return {
    id: "scan-4259",
    generatedAt: "2026-11-11T10:00:00.000Z",
    mode: "best_trade",
    modelVersion: "1.1.2",
    gate: { fit: 3, borderline: 2, noFit: 5 },
    coverage: {
      considered: 10,
      scanned: 10,
      truncated: 0,
      evaluated: 10,
      errors: 0,
      withTrades: 4,
      eventCalendar: { covered: 0, total: 0, coveragePct: 0 },
    },
    profileRef: { id: "p1", name: "Growth", version: 2 },
    trigger: "scheduled",
    broker: "etrade",
    userLogin: "analyst",
    pdfKey: "pdf-4259",
    xlsxKey: "xlsx-4259",
    csvKey: "csv-4259",
    scheduleId: "sched-4259",
    asyncJobId: null,
    workflowId: "run-4259",
    ...overrides,
  } as ScanRunSummary;
}

/* ------------------------------------------------------------------ */
/* 1. Write side: persist stamps workflowId = run id                  */
/* ------------------------------------------------------------------ */

const expiryDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const NOW = new Date("2026-11-05T00:00:00.000Z");

function baseTemplate(overrides: Partial<ScanRequestTemplate> = {}): ScanRequestTemplate {
  return {
    thesis: "bullish",
    targetDate: expiryDate,
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 5_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call"],
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

function makeContracts(symbol: string, spot: number): ScreenedOptionContractItem[] {
  const now = NOW.getTime();
  return [0.95, 1, 1.05].flatMap((mult) => {
    const strike = Math.round(spot * mult * 100) / 100;
    const callMid = legMid(spot, strike, "CALL");
    const putMid = legMid(spot, strike, "PUT");
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    const base = {
      underlyingSymbol: symbol,
      underlyingPrice: spot,
      daysToExpiration: 30,
      expirationDate: expiryDate,
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
      impliedVolatility: 0.3,
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

function fakeScreener(): DynamicOptionsScreener {
  return {
    screenOptions: async (filter: { underlyingSymbols?: string[] }) => {
      const symbol = filter.underlyingSymbols?.[0] ?? "AAA";
      const contracts = makeContracts(symbol, 100);
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

function memoryStorage() {
  const map = new Map<string, unknown>();
  return {
    store: map,
    storage: {
      get: async <T>(key: string) => map.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        map.set(key, value);
      },
    },
  };
}

describe("persist stamps the run linkage (#4259 write side)", () => {
  it("saves the scan row with workflowId = the producing run id", async () => {
    const { storage } = memoryStorage();
    const saves: Array<{ result: unknown; options: Record<string, unknown> }> = [];
    const scanRunStore = {
      save: async (result: unknown, options: Record<string, unknown> = {}) => {
        saves.push({ result, options });
        return { id: "scan-4259-write" };
      },
    } as unknown as ScanRunStore;
    const agents = {
      data: new OptionsDataAgent(fakeScreener()),
      risk: new StrategyRiskAgent(),
      recommender: new RecommendationAgent(),
    };
    const runId = "fold-4259-run-1";
    const outcome = await runOptionsScreenWorkflow(
      {
        runId,
        userLogin: "tester",
        request: {
          assetClass: "options",
          trigger: "scheduled",
          classInput: { scan: { symbols: ["AAA"], template: baseTemplate(), options: { now: NOW } } },
        } as never,
      },
      {
        stages: createScannerScreenPorts({ agents, storage, scanRunStore }),
        claims: { has: () => false, add: () => undefined },
        queue: null,
      },
    );
    expect(outcome.outcome).toBe("completed");
    expect(saves).toHaveLength(1);
    expect(saves[0].options.linkage).toEqual({
      scheduleId: null,
      asyncJobId: null,
      workflowId: runId,
    });
  });
});

/* ------------------------------------------------------------------ */
/* 2. Backfill preserves a stamped workflowId                         */
/* ------------------------------------------------------------------ */

describe("resolveScanBackfillLinkage (#4259 backfill)", () => {
  it("keeps a stamped workflowId/asyncJobId and takes the arming scheduleId", () => {
    expect(
      resolveScanBackfillLinkage(
        { scheduleId: null, asyncJobId: "job-7", workflowId: "run-7" },
        "sched-4259",
      ),
    ).toEqual({ scheduleId: "sched-4259", asyncJobId: "job-7", workflowId: "run-7" });
  });

  it("records explicit nulls when the row carries no linkage", () => {
    expect(resolveScanBackfillLinkage(null, "sched-4259")).toEqual({
      scheduleId: "sched-4259",
      asyncJobId: null,
      workflowId: null,
    });
  });

  it("a poisoned stored id reads as an explicit null, never a stamped id", () => {
    expect(
      resolveScanBackfillLinkage(
        { scheduleId: null, asyncJobId: null, workflowId: "undefined" },
        "sched-4259",
      ),
    ).toEqual({ scheduleId: "sched-4259", asyncJobId: null, workflowId: null });
  });
});

/* ------------------------------------------------------------------ */
/* 3. Mappers carry the linkage                                       */
/* ------------------------------------------------------------------ */

describe("RunSummary mappers carry the §4 linkage (#4259)", () => {
  it("runSummaryFromScanRun carries the scan row's linkage", () => {
    const row = runSummaryFromScanRun(scanSummary());
    expect(row.scheduleId).toBe("sched-4259");
    expect(row.asyncJobId).toBeNull();
    expect(row.workflowId).toBe("run-4259");
  });

  it("runSummaryFromJobRunRecord carries the ledger row's linkage", () => {
    const row = runSummaryFromJobRunRecord(ledgerRecord());
    expect(row.scheduleId).toBe("sched-4259");
    expect(row.asyncJobId).toBeNull();
    expect(row.workflowId).toBe("run-4259");
  });

  it("absent linkage reads as null, never an invented id", () => {
    const scanRow = runSummaryFromScanRun(scanSummary({ scheduleId: undefined, asyncJobId: undefined, workflowId: undefined }));
    expect(scanRow.scheduleId ?? null).toBeNull();
    expect(scanRow.workflowId ?? null).toBeNull();
    const ledgerRow = runSummaryFromJobRunRecord(
      ledgerRecord({ scheduleId: undefined, asyncJobId: undefined, workflowId: undefined }),
    );
    expect(ledgerRow.scheduleId ?? null).toBeNull();
    expect(ledgerRow.workflowId ?? null).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 4. The exact join predicate                                        */
/* ------------------------------------------------------------------ */

describe("scanRunMatchesLedgerRow (#4259 exact join)", () => {
  it("matches on a shared non-null workflowId", () => {
    expect(scanRunMatchesLedgerRow(scanSummary(), ledgerRecord())).toBe(true);
  });

  it("matches on a shared non-null asyncJobId", () => {
    expect(
      scanRunMatchesLedgerRow(
        scanSummary({ asyncJobId: "job-9", workflowId: null }),
        ledgerRecord({ asyncJobId: "job-9", workflowId: null }),
      ),
    ).toBe(true);
  });

  it("matches when the scan id is the ledger row's workflowId (run-id identity)", () => {
    expect(
      scanRunMatchesLedgerRow(
        scanSummary({ id: "run-4259", workflowId: null }),
        ledgerRecord(),
      ),
    ).toBe(true);
  });

  it("never matches on scheduleId alone — a schedule is not a run", () => {
    expect(
      scanRunMatchesLedgerRow(
        scanSummary({ workflowId: "run-other", asyncJobId: null }),
        ledgerRecord({ workflowId: "run-4259" }),
      ),
    ).toBe(false);
  });

  it("never matches when either side records no run-scoped id", () => {
    expect(
      scanRunMatchesLedgerRow(
        scanSummary({ workflowId: null, asyncJobId: null }),
        ledgerRecord({ workflowId: null, asyncJobId: null }),
      ),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 5. mergeRunSummaries folds the scan into its ledger row            */
/* ------------------------------------------------------------------ */

describe("mergeRunSummaries folds a scan into its ledger row (#4259)", () => {
  function merged(scan: ScanRunSummary, record: JobRunRecord): RunSummary[] {
    return mergeRunSummaries(
      [[runSummaryFromJobRunRecord(record)], [runSummaryFromScanRun(scan)]],
      100,
    );
  }

  it("one run = one row: the ledger row wins and inherits the payload", () => {
    const rows = merged(scanSummary(), ledgerRecord());
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(d1JobRunRecordId(ledgerRecord()));
    expect(row.runId).toBe(d1JobRunRecordId(ledgerRecord()));
    expect(row.kind).toBe("options_scanner");
    expect(row.source).toBe("job-pipeline");
    expect(row.scanRunId).toBe("scan-4259");
    expect(row.title).toBe("Options scan — best_trade (Growth)");
    expect(row.status).toBe("completed");
    expect(row.trigger).toBe("scheduled");
    expect(row.pdfKey).toBe("pdf-4259");
    expect(row.reportUrl).toBe("/api/options/report.pdf?key=pdf-4259");
    expect(row.xlsxKey).toBe("xlsx-4259");
    expect(row.xlsxUrl).toBe("/api/options/report.xlsx?key=xlsx-4259");
    expect(row.csvKey).toBe("csv-4259");
    expect(row.csvUrl).toBe("/api/options/report.csv?key=csv-4259");
    expect(row.resultCount).toBe(10);
  });

  it("a failed ledger outcome stays failed — the scan's derived status never overwrites it", () => {
    const rows = merged(
      scanSummary(),
      ledgerRecord({ outcome: "failure", error: "FEED_DOWN: feed job not configured" }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].scanRunId).toBe("scan-4259");
  });

  it("scheduleId alone does not fold — two firings of one schedule stay two rows", () => {
    const rows = merged(
      scanSummary({ workflowId: "run-other", asyncJobId: null }),
      ledgerRecord(),
    );
    expect(rows).toHaveLength(2);
  });

  it("different run-scoped ids do not fold", () => {
    const rows = merged(
      scanSummary({ workflowId: "run-other", asyncJobId: "job-other" }),
      ledgerRecord({ workflowId: "run-4259", asyncJobId: "job-4259" }),
    );
    expect(rows).toHaveLength(2);
  });

  it("an unlinked scan survives as its own row (pre-fold rows lose nothing)", () => {
    const rows = merged(
      scanSummary({ scheduleId: null, asyncJobId: null, workflowId: null }),
      ledgerRecord({ scheduleId: null, asyncJobId: null, workflowId: null }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(["options_scanner", "report"]);
  });

  it("an unlinked ledger row survives unchanged", () => {
    const rows = mergeRunSummaries([[runSummaryFromJobRunRecord(ledgerRecord())]], 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("report");
    expect(rows[0].scanRunId).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 6. Workflow Runs: one row, documents attached                      */
/* ------------------------------------------------------------------ */

describe("GET /workflow-runs folds a scan into its ledger row (#4259)", () => {
  it("lists one run — the ledger run with the scan's documents", async () => {
    const sql = new MockSqlStorage();
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sql as any,
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [ledgerRecord()],
        scanRunReader: async () => [scanSummary()],
      } as any,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    const ledgerId = d1JobRunRecordId(ledgerRecord());
    const matches = data.runs.filter((r: any) => r.runId === ledgerId || r.runId === "scan-4259");
    expect(matches).toHaveLength(1);
    expect(matches[0].runId).toBe(ledgerId);
    expect(matches[0].family).toBe("options");
    expect(matches[0].documents?.pdfUrl).toBe("/api/options/report.pdf?key=pdf-4259");
    expect(matches[0].documents?.xlsxUrl).toBe("/api/options/report.xlsx?key=xlsx-4259");
    expect(matches[0].documents?.csvUrl).toBe("/api/options/report.csv?key=csv-4259");
  });

  it("an unlinked scan still shows as its own run", async () => {
    const sql = new MockSqlStorage();
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sql as any,
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [ledgerRecord()],
        scanRunReader: async () => [scanSummary({ workflowId: "run-other", asyncJobId: null })],
      } as any,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.runs.some((r: any) => r.runId === "scan-4259")).toBe(true);
    expect(data.runs.some((r: any) => r.runId === d1JobRunRecordId(ledgerRecord()))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 7. Detail resolves an absorbed run by its scan id (D1-only #6103) */
/* ------------------------------------------------------------------ */

/** Minimal D1Database stand-in over node:sqlite (the J1 suite's double). */

describe("GET /api/runs/details resolves an absorbed run by scan id (#4259, D1-only #6101)", () => {
  it("finds the ledger-backed detail when asked for the scan id", async () => {
    // Issue #6101 — the #6099 projector is deleted, so there is
    // no projection path to seed through: the D1 rows are seeded
    // directly — the ledger row through the D1 store, the
    // canonical report through the D1 audit adapter's
    // recordReport, carrying the twin link (linkedJobRunId) the
    // projector used to resolve. The scan store is gone: the
    // scan id rides the report body's scanRunId, and the detail
    // handler still matches scanRunId over the D1 lists, so the
    // old deep link resolves to the ledger-backed report detail.
    const mock = new MockD1Database();
    const sql = new MockSqlStorage();
    const jobDb = createD1JobRunRecordDb(mock as never);
    await ensureJobRunRecordsSchema(jobDb);
    await new D1JobRunRecordStore(jobDb).record(ledgerRecord());
    // #6101 step 8: seed through the D1 seam (the old
    // storeReportAtGeneration(sql, input) shape is gone; the
    // seam writes the v1 row into D1 directly).
    const env = { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" };
    const stored = await storeReportAtGeneration({
      runId: "options-screen",
      generationId: "options-screen",
      title: "Options scan — best_trade (Growth)",
      source: "options_scanner",
      summary: "Gate: 3 fit, 2 borderline, 5 no fit across 10 evaluated.",
      userLogin: "alice",
      body: {
        trigger: "scheduled",
        success: true,
        pdfKey: "pdf-4259",
        xlsxKey: "xlsx-4259",
        csvKey: "csv-4259",
        report: {
          result: {
            scanRunId: "scan-4259",
            withTrades: 4,
            pdfKey: "pdf-4259",
            xlsxKey: "xlsx-4259",
            csvKey: "csv-4259",
          },
        },
      },
      createdAt: "2026-11-11T10:00:00.000Z",
    }, env);
    expect(stored).not.toBeNull();
    const nowMs = Date.now();
    const audit = createAuditReportAdapter({ AGENT_DB: mock as never })!;
    await ensureAuditReportSchema(audit.db);
    await audit.recordReport({
      tenantId: "primary",
      workspaceId: "primary",
      reportId: stored!.reportId,
      runId: "options-screen",
      generationId: "options-screen",
      title: "Options scan — best_trade (Growth)",
      source: "options_scanner",
      summary: "Gate: 3 fit, 2 borderline, 5 no fit across 10 evaluated.",
      body: JSON.stringify({
        trigger: "scheduled",
        success: true,
        pdfKey: "pdf-4259",
        xlsxKey: "xlsx-4259",
        csvKey: "csv-4259",
        report: {
          result: {
            scanRunId: "scan-4259",
            withTrades: 4,
            pdfKey: "pdf-4259",
            xlsxKey: "xlsx-4259",
            csvKey: "csv-4259",
          },
        },
      }),
      createdAtMs: Date.parse("2026-11-11T10:00:00.000Z"),
      updatedAtMs: nowMs,
      version: 2,
      provenanceWriter: "test:#6101",
      provenanceSourceDo: "Orchestrator",
      provenanceSourceVersion: "1",
      linkedJobRunId: d1JobRunRecordId(ledgerRecord()),
      userLogin: "alice",
      bodyR2Key: null,
    });
    // The D1 report carries the twin link: the ledger row is
    // absorbed into the report, one run one row.
    const projected = await audit.listReports("primary", { limit: 10 });
    expect(projected).toHaveLength(1);
    expect(projected[0].linkedJobRunId).toBe(d1JobRunRecordId(ledgerRecord()));
    const res = await handleReportsRoutes(
      new Request("https://x/api/runs/details?runId=scan-4259", {
        headers: { "x-user-login": "alice" },
      }),
      new URL("https://x/api/runs/details?runId=scan-4259"),
      "/api/runs/details",
      null,
      {
        ensureTables: () => sql as any,
        env: env as never,
      } as any,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.detail.runId).toBe("options-screen");
    // The detail is the projected report's detail now (the
    // "job-pipeline" detail died with the scan store + merged view).
    expect(data.detail.store).toBe("mas_reports");
    // The absorbed scan id stays addressable: it rides the lineage
    // capture ids, so the old deep link resolves to the ledger row.
    expect(data.detail.lineage.captureIds).toContain("scan-4259");
    expect(data.detail.formats.some((f: any) => f.url === "/api/options/report.pdf?key=pdf-4259")).toBe(true);
  });
});
