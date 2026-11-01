/**
 * Issue #2625 — Goal Screen end-to-end execution:
 * 1. Underlying ThinkWorkflow (ScreenerScreenWorkflow) orchestration for goal-screen runs.
 * 2. Complete artifact generation and storage (PDF, XLSX, CSV) in blob storage.
 * 3. Persistence of canonical reports and job outcomes with report references.
 * 4. Serving all three artifact formats via /api/screening/goal-screen/report.{pdf,xlsx,csv}.
 */
import { describe, expect, it, vi } from "vitest";
import { ThinkWorkflow } from "@cloudflare/think/workflows";
import * as XLSX from "@e965/xlsx";
import { ScreenerScreenWorkflow } from "../src/workflows/screenerWorkflow";
import {
  runShardFlow,
  collateShards,
  goalResultToShardResult,
  type ScreenerWorkflowDeps,
  type ScreenerWorkflowStep,
} from "../src/workflows/screenerWorkflowFlow";
import { buildGoalScreenCommand } from "../src/services/goalScreenWorkflowSubmission";
import { buildScenario } from "../src/services/goalScenarioEngine";
import {
  generateAndStoreGoalScreenArtifacts,
  generateGoalScreenCsv,
  generateGoalScreenPdf,
  generateGoalScreenXlsx,
} from "../src/services/goalScreenReports";
import { persistWorkflowGoalScreenReport } from "../src/agents/orchestrator/goalScreenDispatch";
import { handleScreenerResearchRoutes } from "../src/agents/routes/screenerResearch";
import { getScheduledReportById } from "../src/services/scheduledReports";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { GoalDrivenScreenResult } from "../src/services/goalDrivenScreen";
import { STOCK_SCREENING_PROVIDER_ID } from "../src/trading/screeningProvider";

function sampleGoalResult(overrides: Partial<GoalDrivenScreenResult> = {}): GoalDrivenScreenResult {
  return {
    goalKind: "income",
    outlook: "bullish",
    plan: {
      goalKind: "income",
      outlook: "bullish",
      structures: ["cash_secured_put"],
      stockFilter: {},
      optionsFilter: {},
    },
    status: "complete",
    hits: [
      {
        assetClass: "stocks",
        providerId: STOCK_SCREENING_PROVIDER_ID,
        symbol: "AAPL",
      },
      {
        assetClass: "options",
        providerId: "dynamic-options",
        symbol: "MSFT",
        structures: ["cash_secured_put"],
      },
    ],
    counts: {
      stocksScanned: 100,
      stocksMatched: 1,
      optionsUnderlyingsScanned: 50,
      optionsContractsMatched: 1,
      hits: 2,
    },
    completedAt: "2026-11-01T06:00:00.000Z",
    ...overrides,
  };
}

class InMemoryBlobStorage {
  private readonly store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }
}

describe("Goal Screen ThinkWorkflow & Reports End-to-End (#2625)", () => {
  it("ScreenerScreenWorkflow extends ThinkWorkflow", () => {
    expect(ScreenerScreenWorkflow.prototype instanceof ThinkWorkflow).toBe(true);
  });

  it("produces valid PDF, XLSX, and CSV artifacts with matching schemas", async () => {
    const result = sampleGoalResult();

    // 1. PDF
    const pdfBytes = await generateGoalScreenPdf(result);
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    const pdfHeader = String.fromCharCode(...pdfBytes.subarray(0, 4));
    expect(pdfHeader).toBe("%PDF");

    // 2. XLSX
    const xlsxBytes = generateGoalScreenXlsx(result);
    expect(xlsxBytes).toBeInstanceOf(Uint8Array);
    const wb = XLSX.read(xlsxBytes, { type: "array" });
    expect(wb.SheetNames).toContain("Hits");
    expect(wb.SheetNames).toContain("Summary");
    const hitRows = XLSX.utils.sheet_to_json(wb.Sheets["Hits"], { header: 1 }) as string[][];
    expect(hitRows[0]).toEqual(["symbol", "asset_class", "provider_id", "structures"]);
    expect(hitRows.length).toBe(3); // header + 2 hits

    // 3. CSV
    const csvText = generateGoalScreenCsv(result);
    const csvLines = csvText.trim().split("\n");
    expect(csvLines[0]).toBe("symbol,asset_class,provider_id,structures");
    expect(csvLines.length).toBe(3);
    expect(csvLines[1]).toContain("AAPL");
    expect(csvLines[2]).toContain("MSFT");
  });

  it("orchestrates goal screen via ThinkWorkflow shard flow and produces all reports", async () => {
    const blobStorage = new InMemoryBlobStorage();
    const env = { REPORTS_BUCKET: undefined };
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);

    const scenario = buildScenario({
      goalKind: "income",
      portfolioRef: { kind: "hypothetical" },
    });

    const command = buildGoalScreenCommand({
      jobId: "goal-screen:manual:alice:income:2026-11-01T06:00:00.000Z",
      source: "manual",
      trigger: "manual",
      userLogin: "alice",
      tenantId: "tenant-alice",
      scenario,
      scenarioSource: "built",
      assetClasses: ["stocks", "options"],
    });

    const shardCommand = {
      ...command,
      role: "shard" as const,
      shard: { shardId: "goal" },
    };

    // Step mock recording execution order
    const executedSteps: string[] = [];
    const step: ScreenerWorkflowStep = {
      do: async (name, fn) => {
        executedSteps.push(name);
        return fn();
      },
      sleep: async () => {},
    };

    const runnerGoalScreen = vi.fn(async () => {
      const res = sampleGoalResult();
      const artifacts = await generateAndStoreGoalScreenArtifacts(
        env,
        blobStorage,
        res,
      );
      Object.assign(res, artifacts);
      return goalResultToShardResult({
        taskId: "task-goal-123",
        scenarioSource: "built",
        trigger: "manual",
        result: res,
        idempotencyKey: command.jobId,
      });
    });

    let storedReportId = "";
    const deps: ScreenerWorkflowDeps = {
      screenRunner: {
        runScreen: vi.fn(),
        runGoalScreen: runnerGoalScreen,
      },
      shardStore: {
        recordShardOutcome: vi.fn(async () => {}),
      },
      storeReport: async (payload, userLogin) => {
        const id = await persistWorkflowGoalScreenReport(
          { env, getOrm: () => orm },
          payload as any,
          userLogin,
        );
        storedReportId = id;
        return id;
      },
      deliverOutcome: async () => {},
      nowMs: () => Date.now(),
    };

    // 1. Execute shard flow
    const shardResult = await runShardFlow(shardCommand, step, deps);

    expect(executedSteps).toContain("execute-goal-screen");
    expect(executedSteps).toContain("store-shard");
    expect(shardResult.success).toBe(true);
    expect(shardResult.pdfKey).toMatch(/^goal_screen:pdf:/);
    expect(shardResult.xlsxKey).toMatch(/^goal_screen:xlsx:/);
    expect(shardResult.csvKey).toMatch(/^goal_screen:csv:/);

    // 2. Verify artifacts exist in blob storage
    expect(blobStorage.has(shardResult.pdfKey!)).toBe(true);
    expect(blobStorage.has(shardResult.xlsxKey!)).toBe(true);
    expect(blobStorage.has(shardResult.csvKey!)).toBe(true);

    // 3. Verify canonical report in ORM via getScheduledReportById
    const storedReport = getScheduledReportById(sql as any, storedReportId);
    expect(storedReport).not.toBeNull();
    const body = typeof storedReport!.body === "string" ? JSON.parse(storedReport!.body) : storedReport!.body;
    expect(body.pdfKey).toBe(shardResult.pdfKey);
    expect(body.xlsxKey).toBe(shardResult.xlsxKey);
    expect(body.csvKey).toBe(shardResult.csvKey);

    // 4. Verify parent collation surfaces all three keys and lifecycle ReportGenerated
    const shardOutcome = {
      shardId: "goal",
      status: "completed" as const,
      totalScanned: shardResult.totalScanned,
      expectedCount: shardResult.expectedCount,
      matchedCount: shardResult.matchedCount,
      pdfKey: shardResult.pdfKey,
      xlsxKey: shardResult.xlsxKey,
      csvKey: shardResult.csvKey,
      stored: true,
      delivered: false,
    };

    const collation = collateShards(
      command.jobId,
      "workflow-instance-123",
      [shardOutcome],
      [{ lifecycle: "ReportGenerated", atMs: Date.now() }],
      [],
    );

    expect(collation.lifecycle).toBe("ReportGenerated");
    expect(collation.reportKeys).toEqual([shardResult.pdfKey]);
    expect(collation.xlsxKeys).toEqual([shardResult.xlsxKey]);
    expect(collation.csvKeys).toEqual([shardResult.csvKey]);
  });

  it("serves PDF, XLSX, and CSV reports through /api/screening/goal-screen/report.* endpoints", async () => {
    const blobStorage = new InMemoryBlobStorage();
    const env = { REPORTS_BUCKET: undefined };
    const res = sampleGoalResult();
    const artifacts = await generateAndStoreGoalScreenArtifacts(
      env,
      blobStorage,
      res,
    );

    const screenerAgent = {
      getGoalScreenArtifactByKey: vi.fn(async (key: string) => {
        const { isGoalScreenArtifactKey } = await import("../src/services/goalScreenReports");
        if (!isGoalScreenArtifactKey(key)) return null;
        const { getReportPdf } = await import("../src/services/reportBlobStore");
        return getReportPdf(env, blobStorage, key);
      }),
    };

    const ctx = {
      getScreenerAgent: vi.fn(() => screenerAgent),
      getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
      getResearchAgent: vi.fn(() => null),
      runResearchAndPublish: vi.fn(),
      getOrm: vi.fn(),
      readSettingRaw: vi.fn(),
      env,
    };

    // 1. PDF endpoint
    const pdfPath = "/screening/goal-screen/report.pdf";
    const pdfUrlStr = `https://agent.internal/api${pdfPath}?key=${encodeURIComponent(artifacts.pdfKey!)}`;
    const pdfReq = new Request(pdfUrlStr, {
      method: "GET",
      headers: { "x-user-login": "alice" },
    });
    const pdfResp = await handleScreenerResearchRoutes(
      pdfReq,
      new URL(pdfUrlStr),
      pdfPath,
      "session-1",
      ctx as any,
    );
    expect(pdfResp).not.toBeNull();
    expect(pdfResp!.status).toBe(200);
    expect(pdfResp!.headers.get("Content-Type")).toBe("application/pdf");
    expect(pdfResp!.headers.get("Content-Disposition")).toContain("attachment; filename=");

    // 2. XLSX endpoint
    const xlsxPath = "/screening/goal-screen/report.xlsx";
    const xlsxUrlStr = `https://agent.internal/api${xlsxPath}?key=${encodeURIComponent(artifacts.xlsxKey!)}`;
    const xlsxReq = new Request(xlsxUrlStr, {
      method: "GET",
      headers: { "x-user-login": "alice" },
    });
    const xlsxResp = await handleScreenerResearchRoutes(
      xlsxReq,
      new URL(xlsxUrlStr),
      xlsxPath,
      "session-1",
      ctx as any,
    );
    expect(xlsxResp).not.toBeNull();
    expect(xlsxResp!.status).toBe(200);
    expect(xlsxResp!.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(xlsxResp!.headers.get("Content-Disposition")).toContain(".xlsx");

    // 3. CSV endpoint
    const csvPath = "/screening/goal-screen/report.csv";
    const csvUrlStr = `https://agent.internal/api${csvPath}?key=${encodeURIComponent(artifacts.csvKey!)}`;
    const csvReq = new Request(csvUrlStr, {
      method: "GET",
      headers: { "x-user-login": "alice" },
    });
    const csvResp = await handleScreenerResearchRoutes(
      csvReq,
      new URL(csvUrlStr),
      csvPath,
      "session-1",
      ctx as any,
    );
    expect(csvResp).not.toBeNull();
    expect(csvResp!.status).toBe(200);
    expect(csvResp!.headers.get("Content-Type")).toBe("text/csv");
    expect(csvResp!.headers.get("Content-Disposition")).toContain(".csv");

    // 4. Foreign key rejected
    const foreignPath = "/screening/goal-screen/report.pdf";
    const foreignUrlStr = `https://agent.internal/api${foreignPath}?key=screener:pdf:foreign`;
    const foreignReq = new Request(foreignUrlStr, {
      method: "GET",
      headers: { "x-user-login": "alice" },
    });
    const foreignResp = await handleScreenerResearchRoutes(
      foreignReq,
      new URL(foreignUrlStr),
      foreignPath,
      "session-1",
      ctx as any,
    );
    expect(foreignResp!.status).toBe(404);
  });

  it("handles direct goal screen submission producing result with all 3 artifact keys", async () => {
    const blobStorage = new InMemoryBlobStorage();
    const env = { REPORTS_BUCKET: undefined };
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);

    const agent = {
      runGoalScreen: vi.fn(async () => {
        const res = sampleGoalResult();
        const artifacts = await generateAndStoreGoalScreenArtifacts(
          env,
          blobStorage,
          res,
        );
        Object.assign(res, artifacts);
        return {
          task: { id: "task-direct-1", status: "completed" },
          executed: true,
          result: res,
        };
      }),
    };

    const ctx = {
      getScreenerAgent: vi.fn(() => agent),
      getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
      getResearchAgent: vi.fn(() => null),
      runResearchAndPublish: vi.fn(),
      getOrm: vi.fn(() => orm),
      readSettingRaw: vi.fn(() => null),
      env,
    };

    const path = "/screening/goal-screen";
    const urlStr = `https://agent.internal/api${path}`;
    const req = new Request(urlStr, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-login": "alice" },
      body: JSON.stringify({ goalKind: "income", async: false }),
    });

    const resp = await handleScreenerResearchRoutes(
      req,
      new URL(urlStr),
      path,
      "session-1",
      ctx as any,
    );

    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);
    const body = (await resp!.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.result).toBeDefined();
    expect(body.result.pdfKey).toMatch(/^goal_screen:pdf:/);
    expect(body.result.xlsxKey).toMatch(/^goal_screen:xlsx:/);
    expect(body.result.csvKey).toMatch(/^goal_screen:csv:/);
    expect(blobStorage.has(body.result.pdfKey)).toBe(true);
    expect(blobStorage.has(body.result.xlsxKey)).toBe(true);
    expect(blobStorage.has(body.result.csvKey)).toBe(true);
  });
});
