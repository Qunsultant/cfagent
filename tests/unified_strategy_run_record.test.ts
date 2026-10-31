/**
 * Unified run record for options strategy screens: one record, one
 * stage trace, read identically by Docs Run Details and Workflow
 * Runs for the same runId. Pins (failing case: TSLA, manual,
 * bullish, 0 ranked, scanned 0, matched 0):
 *  - the recorder stores input.* request fields, provenance, feed
 *    evidence (including fetchErrors), and a stage trace;
 *  - Docs Run Details uses the stored stages (plus a recording
 *    stage derived from the written row) and surfaces
 *    RUN_EMPTY_RESULT, and RUN_PROVIDER_FETCH_FAILED when the
 *    feed failed with provider errors — never a gate claim for an
 *    empty feed slice with no provider error;
 *  - Workflow Runs overlays the same record onto the outcome twin,
 *    so stage count / scanned / matched / artifact statuses agree
 *    with Docs, and status stays the recorded outcome verb;
 *  - legacy runs (no stored stages, no input) still render
 *    unknown, never guessed, and keep an outcome-only view.
 */
import { describe, it, expect, vi } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  buildUnifiedStrategyStages,
  recordStrategyScreenRun,
} from "../src/services/optionsServeRecord";
import { buildRunDetail } from "../src/services/runDetails";
import { buildWorkflowRuns, runFromOutcome } from "../src/services/workflowRuns";
import { unifiedRecordsFromCanonicalReports } from "../src/agents/routes/workflowRuns";
import type { RunSummary } from "../src/services/runSummaries";

const TSLA_SCREEN = {
  scannedAt: "2026-10-31T19:47:49.363Z",
  underlyingsScanned: 1,
  contractsEvaluated: 0,
  contractsMatched: 0,
  fetchErrors: [{ symbol: "TSLA", reason: "E*TRADE OAuth Token Missing: No active session for user in [PROD] mode." }],
  warnings: [],
};

function tslaInput(over: Record<string, unknown> = {}) {
  return {
    userLogin: "OpenAIMP",
    symbol: "TSLA",
    trigger: "manual" as const,
    mode: "strategies" as const,
    ranked: [],
    screenedOut: [],
    screen: TSLA_SCREEN,
    contracts: [],
    dataSource: "live",
    thesis: "bullish",
    strategyMode: "thesis" as const,
    targetDate: "2026-11-20",
    riskProfile: "balanced",
    allowedStrategies: ["all"],
    dteMin: 7,
    dteMax: 90,
    pdfKey: "options:pdf:strategy:tsla",
    pdfStatus: "generated" as const,
    createdAt: "2026-10-31T19:47:50.395Z",
    ...over,
  };
}

function detailSummary(body: unknown, over: Partial<RunSummary> = {}): RunSummary & { body?: unknown } {
  return {
    kind: "options_scanner",
    id: "rep-tsla",
    runId: "options_strategy:strategies:TSLA:2026-10-31T19:47:50.395Z",
    title: "Strategy screen — TSLA (manual)",
    summary: "Strategy screen for TSLA: 0 ranked strategies.",
    trigger: "manual",
    createdAt: "2026-10-31T19:47:50.395Z",
    status: "completed",
    resultCount: 0,
    pdfKey: "options:pdf:strategy:tsla",
    reportUrl: null,
    xlsxKey: null,
    xlsxUrl: null,
    csvKey: null,
    csvUrl: null,
    pdfStatus: "generated",
    pdfError: null,
    xlsxStatus: null,
    xlsxError: null,
    csvStatus: null,
    csvError: null,
    reportId: "rep-tsla",
    scanRunId: null,
    discoveryRunId: null,
    source: "options_strategy",
    body,
    ...over,
  } as RunSummary & { body?: unknown };
}

describe("unified strategy stages", () => {
  it("marks feed failed with provider evidence when fetch errors leave 0 contracts", () => {
    const stages = buildUnifiedStrategyStages(tslaInput(), 0);
    const feed = stages.find((s) => s.stage === "feed")!;
    expect(feed.status).toBe("failed");
    expect(feed.errorCode).toBe("RUN_PROVIDER_FETCH_FAILED");
    expect(feed.evidence.contractsEvaluated).toBe(0);
    expect(feed.evidence.fetchErrorCount).toBe(1);
    expect(feed.evidence.connector).toBe("E*TRADE");
    expect(stages.find((s) => s.stage === "analysis")?.evidence.rankedCount).toBe(0);
    expect(stages.find((s) => s.stage === "delivery")?.status).toBe("skipped");
    expect(stages.find((s) => s.stage === "delivery")?.reason).toBe("no delivery channel requested for this panel run");
  });

  it("marks feed completed, not failed, for an empty slice with no provider error", () => {
    const stages = buildUnifiedStrategyStages(
      tslaInput({ screen: { underlyingsScanned: 1, contractsEvaluated: 0, contractsMatched: 0, fetchErrors: [], warnings: [] } }),
      0,
    );
    expect(stages.find((s) => s.stage === "feed")?.status).toBe("completed");
    expect(stages.find((s) => s.stage === "feed")?.errorCode).toBeNull();
  });
});

describe("recordStrategyScreenRun unified record", () => {
  it("stores input, provenance, feed evidence, and stages in the canonical body", () => {
    const sql = new MockSqlStorage();
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "strategy-tsla", created: true })),
      getSql: () => sql,
    };
    const stored = recordStrategyScreenRun(orm as any, tslaInput());
    expect(stored).toMatchObject({ reportId: "strategy-tsla" });
    const body = orm.storeCanonicalReport.mock.calls[0][0].body as Record<string, any>;
    expect(body.input).toMatchObject({ symbols: ["TSLA"], thesis: "bullish", strategyMode: "thesis", dteMin: 7, dteMax: 90 });
    expect(body.jobType).toBe("options-strategy-panel");
    expect(body.provenance).toMatchObject({ jobType: "options-strategy-panel", submittedVia: expect.stringContaining("options-strategy-panel") });
    expect(body.feed).toMatchObject({ connector: "E*TRADE", contractsEvaluated: 0 });
    expect(body.feed.fetchErrors).toHaveLength(1);
    expect(body.stages.map((s: any) => s.stage)).toEqual(["feed", "analysis", "generation", "delivery"]);
    expect(body.stages[0].status).toBe("failed");
  });
});

describe("Docs Run Details reads the unified record", () => {
  it("shows recorded request fields, stored stages, and empty + provider reasons for the TSLA shape", () => {
    const sql = new MockSqlStorage();
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "strategy-tsla", created: true })),
      getSql: () => sql,
    };
    recordStrategyScreenRun(orm as any, tslaInput());
    const body = orm.storeCanonicalReport.mock.calls[0][0].body;
    const detail = buildRunDetail(detailSummary(body));
    expect(detail.request.find((f) => f.field === "thesis")?.value).toBe("bullish");
    expect(detail.request.find((f) => f.field === "thesis")?.source).toBe("recorded");
    expect(detail.request.find((f) => f.field === "symbols")?.value).toBe('["TSLA"]');
    expect(detail.request.find((f) => f.field === "strategyMode")?.value).toBe("thesis");
    expect(detail.provenance.jobType).toBe("options-strategy-panel");
    expect(detail.stages.map((s) => s.stage)).toEqual(["feed", "analysis", "generation", "delivery", "recording"]);
    expect(detail.stages.find((s) => s.stage === "feed")?.status).toBe("failed");
    expect(detail.stages.find((s) => s.stage === "recording")?.evidence.reportId).toBe("rep-tsla");
    expect(detail.reasons.some((r) => r.code === "RUN_EMPTY_RESULT")).toBe(true);
    expect(detail.reasons.some((r) => r.code === "RUN_PROVIDER_FETCH_FAILED")).toBe(true);
  });

  it("legacy strategy bodies without stages or input still render unknown, never guessed", () => {
    const detail = buildRunDetail(detailSummary({ symbol: "TSLA", mode: "strategies", trigger: "manual", ranked: [], screen: TSLA_SCREEN }));
    expect(detail.request.find((f) => f.field === "thesis")?.source).toBe("unknown");
    expect(detail.request.find((f) => f.field === "thesis")?.value).toBeNull();
    expect(detail.stages.map((s) => s.stage)).toEqual(["feed", "gather", "analysis", "generation", "recording", "delivery"]);
    expect(detail.reasons.some((r) => r.code === "RUN_PROVIDER_FETCH_FAILED")).toBe(false);
  });
});

describe("Workflow Runs reads the same unified record", () => {
  const outcome = {
    id: "options_strategy:strategies:TSLA:2026-10-31T19:47:50.395Z",
    kind: "options",
    trigger: "manual",
    status: "completed",
    scanned: 0,
    matched: 0,
    codedError: null,
    reportUrl: null,
    pdfKey: "options:pdf:strategy:tsla",
    xlsxKey: null,
    csvKey: null,
    deliveryStates: {},
    origin: "options-strategy-screener",
    createdAt: "2026-10-31T19:47:50.395Z",
  };

  it("overlays canonical stages onto the outcome twin, agreeing with Docs", () => {
    const sql = new MockSqlStorage();
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "strategy-tsla", created: true })),
      getSql: () => sql,
    };
    recordStrategyScreenRun(orm as any, tslaInput());
    const body = orm.storeCanonicalReport.mock.calls[0][0].body;
    const [unified] = unifiedRecordsFromCanonicalReports([
      { id: "strategy-tsla", runId: outcome.id, title: "Strategy screen — TSLA (manual)", body },
    ]);
    expect(unified).toBeDefined();
    const runs = buildWorkflowRuns({ jobs: [], outcomes: [outcome], transitions: [], unifiedRecords: [unified] });
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe(outcome.id);
    expect(runs[0].stageCount).toBe(5);
    expect(runs[0].failedStages).toBe(1);
    expect(runs[0].stages[0].stage).toBe("feed");
    expect(runs[0].stages[0].status).toBe("failed");
    expect(runs[0].stages[0].recordedBy).toBe("unified-record");
    expect(runs[0].status).toBe("completed");
    expect((runs[0].outputs as any).scanned).toBe(0);
    expect((runs[0].outputs as any).matched).toBe(0);
    expect((runs[0].inputs as any).thesis).toBe("bullish");
  });

  it("without a unified record, an outcome twin keeps its outcome-only view", () => {
    const run = runFromOutcome(outcome, []);
    expect(run.stageCount).toBe(0);
    expect(run.stages).toEqual([]);
  });

  it("skips canonical rows without a stored stage trace", () => {
    expect(unifiedRecordsFromCanonicalReports([
      { id: "legacy-1", runId: outcome.id, title: "Strategy screen — TSLA (manual)", body: { symbol: "TSLA", mode: "strategies" } },
    ])).toEqual([]);
  });
});
