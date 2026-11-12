/**
 * Issue #4069 (Option B for options — two ledgers, surfaces merge):
 * the scanner's scan-run rows (mas_opportunity_scans) become readable
 * on Workflow Runs, joining the #3946 D1 merge — scanner legs write
 * no canonical mas_reports row, so without this the scan ledger is
 * invisible here (ReportsPanel and detail already merge it).
 *
 * Pinned here:
 *  1. Mapping: runFromScanRun maps a scan row to a WorkflowRun
 *     (family options, source report, status completed, honest empty
 *     stage list, documents from the row's own keys, broker from the
 *     row's broker, absent stays absent).
 *  2. Partial coverage rides the gate summary in outputs — status
 *     stays completed, never a second status.
 *  3. Route: /workflow-runs lists scan runs via the injected reader.
 *  4. Dedup: a scan row a canonical row already claims (its body
 *     scanRunId — the same exact join mergeRunSummaries uses) shows
 *     once, as the canonical run.
 *  5. Reader: a failing scan read is named in storeErrors and never
 *     hides the other ledgers; without a userLogin the store is
 *     skipped and named, never read unscoped.
 *  6. Decision record (Q2, kept by design): the goal leg's omitted
 *     canonical store makes the persist stage record created:false
 *     with no canonical row — the composing goal run's row is the
 *     single home (#783).
 */
import { describe, it, expect } from "vitest";

import type { ScanRunSummary } from "../src/data/scanRunPorts";
import { runFromScanRun } from "../src/services/workflowRuns";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";
import { createOptionsScreenPorts, optionsArtifactKey } from "../src/workflows/optionsScreenPorts";
import { memoryStageStorage } from "../src/workflows/optionsScreenWorkflow";
import { MockSqlStorage } from "./mock-sql";
import {
  ensureScheduledReportsTable,
  persistScheduledReportSql,
} from "../src/services/scheduledReports";

function scanSummary(overrides: Partial<ScanRunSummary> = {}): ScanRunSummary {
  return {
    id: "scan-1",
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
    trigger: "manual",
    broker: "etrade",
    userLogin: "analyst",
    ...overrides,
  } as ScanRunSummary;
}

describe("runFromScanRun (#4069)", () => {
  it("maps a scan row to a WorkflowRun with an honest empty stage list", () => {
    const run = runFromScanRun(scanSummary());
    expect(run.id).toBe("scan-1");
    expect(run.runId).toBe("scan-1");
    expect(run.family).toBe("options");
    expect(run.workflow).toBe("Options research workflow");
    expect(run.source).toBe("report");
    expect(run.status).toBe("completed");
    expect(run.lifecycle).toBe("done");
    expect(run.title).toBe("Options scan — best_trade (Growth)");
    expect(run.trigger).toBe("manual");
    expect(run.triggeredBy).toBe("analyst");
    expect(run.stages).toEqual([]);
    expect(run.stageCount).toBe(0);
    expect(run.startedAt).toBe("2026-11-11T10:00:00.000Z");
    expect(run.brokerId).toBe("etrade");
    expect(run.error).toBeNull();
    const outputs = run.outputs as Record<string, unknown>;
    expect(outputs.gate).toEqual({ fit: 3, borderline: 2, noFit: 5 });
    expect(outputs.evaluated).toBe(10);
  });

  it("carries the row's own document keys and no invented stages", () => {
    const run = runFromScanRun(
      scanSummary({ pdfKey: "options:pdf:k1", xlsxKey: "options:xlsx:k1", csvKey: "options:csv:k1" }),
    );
    expect(run.documents?.family).toBe("options");
    expect(run.documents?.pdfUrl).toBe("/api/options/report.pdf?key=options%3Apdf%3Ak1");
    expect(run.documents?.pdfStatus).toBe("generated");
    expect(run.documents?.xlsxUrl).toBe("/api/options/report.xlsx?key=options%3Axlsx%3Ak1");
    expect(run.documents?.csvUrl).toBe("/api/options/report.csv?key=options%3Acsv%3Ak1");
    // The RunDetail fetch resolves by scan id through /api/runs/details.
    expect(run.documents?.reportId).toBe("scan-1");
  });

  it("keeps partial coverage in outputs and status completed", () => {
    const run = runFromScanRun(
      scanSummary({
        partial: {
          evaluatedCount: 6,
          consideredCount: 10,
          coverageErrors: 2,
          truncatedCount: 2,
        } as ScanRunSummary["partial"],
      }),
    );
    expect(run.status).toBe("completed");
    const outputs = run.outputs as Record<string, unknown>;
    expect(outputs.partial).toEqual({
      evaluatedCount: 6,
      consideredCount: 10,
      coverageErrors: 2,
      truncatedCount: 2,
    });
  });

  it("leaves documents null-valued and broker absent when the row carries neither", () => {
    const run = runFromScanRun(
      scanSummary({ pdfKey: undefined, xlsxKey: undefined, csvKey: undefined, broker: undefined }),
    );
    expect(run.documents?.pdfUrl).toBeNull();
    expect(run.documents?.xlsxUrl).toBeNull();
    expect(run.documents?.csvUrl).toBeNull();
    expect(run.brokerId).toBeUndefined();
  });
});

describe("GET /workflow-runs merges scan runs (#4069)", () => {
  it("lists a scan run as an options report run", async () => {
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
        scanRunReader: async () => [scanSummary()],
      } as any,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    const run = data.runs.find((r: any) => r.runId === "scan-1");
    expect(run).toBeDefined();
    expect(run.family).toBe("options");
    expect(run.source).toBe("report");
    expect(run.status).toBe("completed");
    expect(run.title).toContain("best_trade");
  });

  it("drops a scan row a canonical row already claims (same run, once)", async () => {
    const sql = new MockSqlStorage();
    ensureScheduledReportsTable(sql as any);
    persistScheduledReportSql(sql as any, {
      runId: "options_scanner:unified:2026-11-11T10:00:00.000Z:mixed",
      generationId: "options_scanner:unified:2026-11-11T10:00:00.000Z:mixed",
      userLogin: "analyst",
      title: "Options scan — mixed",
      source: "options_scanner",
      summary: "Gate: 3 fit.",
      body: { report: { result: { scanRunId: "scan-1" } }, trigger: "manual" },
      createdAt: "2026-11-11T10:00:00.000Z",
    });
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sql as any,
        userLogin: "analyst",
        env: {},
        scanRunReader: async () => [scanSummary()],
      } as any,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    const scanRuns = data.runs.filter((r: any) => r.runId === "scan-1");
    expect(scanRuns).toHaveLength(0);
    // The canonical run itself still shows — once.
    const canonical = data.runs.filter(
      (r: any) => r.runId === "options_scanner:unified:2026-11-11T10:00:00.000Z:mixed",
    );
    expect(canonical).toHaveLength(1);
  });

  it("names a failing scan read in storeErrors and still renders the other ledgers", async () => {
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
        scanRunReader: async () => {
          throw new Error("scan store unavailable");
        },
      } as any,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.storeErrors.scanRuns).toContain("scan store unavailable");
    expect(data.runs.filter((r: any) => r.runId === "scan-1")).toEqual([]);
    expect(data.runs.length).toBeGreaterThan(0);
  });

  it("skips the scan store without a userLogin and names the skip", async () => {
    const sql = new MockSqlStorage();
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sql as any,
        userLogin: "",
        env: {},
        scanRunReader: async () => [scanSummary()],
      } as any,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.storeErrors.scanRuns).toMatch(/skipped/);
    expect(data.runs.filter((r: any) => r.runId === "scan-1")).toEqual([]);
  });
});

describe("goal leg omits the canonical store (#4069 Q2)", () => {
  it("persist records created:false with no canonical row", async () => {
    const storage = memoryStageStorage();
    await storage.put(optionsArtifactKey("goal-screen:key-1:options", "screen"), {
      terminal: "completed",
      result: { filterSummary: "2 matches", matchedCount: 2, totalUnderlyingsScanned: 5 },
    });
    const ports = createOptionsScreenPorts({
      screener: {} as never,
      storage,
      shapeReport: async () => ({ terminal: "completed" }),
      deliver: async () => ({ terminal: "completed" }),
    });
    const output = await ports.persistCanonicalResults.execute({
      runId: "goal-screen:key-1:options",
      userLogin: "analyst",
      stageId: "persistCanonicalResults",
      artifactKeys: [],
      request: {
        assetClass: "options",
        runIdentity: { runId: "goal-screen:key-1:options" },
        trigger: "manual",
        classInput: { goalPlan: { goalId: "goal-1" } },
      },
    } as never);
    expect((output as { created: boolean }).created).toBe(false);
    expect((output as { reportId: string | null }).reportId).toBeNull();
  });
});
