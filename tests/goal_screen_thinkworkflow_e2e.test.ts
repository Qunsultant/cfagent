/**
 * Issue #2625 — Goal Screen end-to-end execution:
 * 1. Underlying ThinkWorkflow (ScreenerScreenWorkflow) orchestration for goal-screen runs.
 * 2. Complete artifact generation and storage (PDF, XLSX, CSV) in blob storage.
 * 3. Persistence of canonical reports and job outcomes with report references.
 * 4. Serving all three artifact formats via /api/screening/goal-screen/report.{pdf,xlsx,csv}.
 *
 * #4192: the child-workflow shard flow (runShardFlow + fake
 * ScreenerWorkflowStep + virtual clock) is retired — goal
 * screens run through the one engine now. The orchestration
 * test below drives the same journey through
 * InMemoryWorkflowAdapter (the engine path with a canned goal
 * runner) and reads the collation back from the parent
 * canonical row, the way tests/screener_workflows.test.ts
 * does. No child workflows, no poll loop, no virtual clock.
 */
import { describe, expect, it, vi } from "vitest";
import { ThinkWorkflow } from "@cloudflare/think/workflows";
import * as XLSX from "@e965/xlsx";
import { ScreenerScreenWorkflow } from "../src/workflows/screenerWorkflow";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import {
  collateShards,
  goalResultToShardResult,
  type ScreenerWorkflowDeps,
  type ShardOutcome,
} from "../src/workflows/screenerCollation";
import type {
  ParentScreenReportInput,
  WorkflowCollation,
} from "../src/workflows/workflowPorts";
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

// Issue #4279 (#3550 S4): the route test below pins the workflow
// submission, so only the start is mocked — the real command
// builder stays, because the orchestration test above builds its
// command through it.
vi.mock("../src/services/goalScreenWorkflowSubmission", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/goalScreenWorkflowSubmission")>();
  return { ...original, startGoalScreenWorkflow: vi.fn() };
});

import { startGoalScreenWorkflow } from "../src/services/goalScreenWorkflowSubmission";

const mockedStart = vi.mocked(startGoalScreenWorkflow);

const HANDLE = {
  workflowId: "screen-goal-screen-manual-alice-income-2026-11-12T00-00-00-000Z",
  jobId: "goal-screen:manual:alice:income:2026-11-12T00:00:00.000Z",
  status: "queued" as const,
  existing: false,
  statusUrl: "/api/jobs/history?chainId=goal-screen%3Amanual%3Aalice%3Aincome%3A2026-11-12T00%3A00%3A00.000Z",
};

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

  it("orchestrates goal screen through the engine and produces all reports", async () => {
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

    // #4192: no fake step, no virtual clock — the engine
    // owns pacing and fan-out. The trace hops record which
    // engine steps executed, in place of the old step mock's
    // execution-order list.
    const executedSteps: string[] = [];
    const shardStore = new InMemoryShardJobAdapter();
    const parentStored: ParentScreenReportInput[] = [];

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
        // A goal command must never fall back to the market
        // runner: the adapter fails closed without
        // runGoalScreen, and this throw proves the market
        // runner is never reached.
        runScreen: vi.fn(async () => {
          throw new Error("market runner must not run for a goal command");
        }),
        runGoalScreen: runnerGoalScreen,
      },
      shardStore,
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
      storeParentReport: async (input) => {
        parentStored.push(input);
        return { stored: true, reportId: "parent-1" };
      },
      traceHop: async (_cmd, event) => {
        executedSteps.push(event.operation);
      },
      nowMs: () => Date.now(),
    };

    // 1. Execute the goal screen through the engine.
    const adapter = new InMemoryWorkflowAdapter(deps);
    const handle = await adapter.start(command);
    expect(handle.status).toBe("complete");
    expect(handle.existing).toBe(false);
    expect(await adapter.status(handle.workflowId)).toMatchObject({
      jobId: command.jobId,
      status: "complete",
    });

    expect(runnerGoalScreen).toHaveBeenCalledTimes(1);
    expect(executedSteps).toContain("execute-goal-screen");
    expect(executedSteps).toContain("store-shard");

    // The collation is the parent row's read-back, the way
    // the mesh door / NLQ port read it.
    const parentRow = await shardStore.latestJob("tenant-alice", command.jobId, command.jobId);
    expect(parentRow).not.toBeNull();
    expect(parentRow?.status).toBe("completed");
    const collation = JSON.parse(parentRow?.resultJson ?? "{}") as WorkflowCollation;
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect(collation.shards).toHaveLength(1);
    const shard = collation.shards[0]!;
    expect(shard.status).toBe("completed");
    expect(shard.shardId).toBe("goal");
    expect(shard.pdfKey).toMatch(/^goal_screen:pdf:/);
    expect(shard.xlsxKey).toMatch(/^goal_screen:xlsx:/);
    expect(shard.csvKey).toMatch(/^goal_screen:csv:/);
    expect(shard.stored).toBe(true);
    // The goal door returned a report id: it surfaces on
    // the shard outcome and links the parent row to the
    // child's canonical report.
    expect(shard.reportId).toBe(storedReportId);
    expect(collation.reportKeys).toEqual([shard.pdfKey]);
    expect(collation.xlsxKeys).toEqual([shard.xlsxKey]);
    expect(collation.csvKeys).toEqual([shard.csvKey]);
    expect(collation.childReportIds).toEqual([storedReportId]);
    expect(collation.childRunIds).toEqual([]);

    // The parent canonical row was stored once, carrying the
    // collation (goal parents link by report id, never by
    // screener:<timestamp>).
    expect(parentStored).toHaveLength(1);
    expect(parentStored[0]?.collation.lifecycle).toBe("ReportGenerated");
    expect(parentStored[0]?.goalScreen).toBe(true);
    expect(parentStored[0]?.jobId).toBe(command.jobId);

    // The per-shard row was projected alongside the parent row.
    const rows = await shardStore.listJobsForChain("tenant-alice", command.jobId);
    expect(rows.map((r) => r.jobKey).sort()).toEqual(
      [command.jobId, "shard:goal"].sort(),
    );
    expect(rows.find((r) => r.jobKey === "shard:goal")?.status).toBe("completed");

    // 2. Verify artifacts exist in blob storage
    expect(blobStorage.has(shard.pdfKey!)).toBe(true);
    expect(blobStorage.has(shard.xlsxKey!)).toBe(true);
    expect(blobStorage.has(shard.csvKey!)).toBe(true);

    // 3. Verify canonical report in ORM via getScheduledReportById
    const storedReport = getScheduledReportById(sql as any, storedReportId);
    expect(storedReport).not.toBeNull();
    const body = typeof storedReport!.body === "string" ? JSON.parse(storedReport!.body) : storedReport!.body;
    expect(body.pdfKey).toBe(shard.pdfKey);
    expect(body.xlsxKey).toBe(shard.xlsxKey);
    expect(body.csvKey).toBe(shard.csvKey);

    // 4. The pure collation helper agrees with the engine
    // collation on the same shard outcome: lifecycle
    // ReportGenerated with all three keys.
    const shardOutcome: ShardOutcome = {
      shardId: "goal",
      status: "completed",
      totalScanned: shard.totalScanned ?? 0,
      expectedCount: shard.expectedCount ?? 0,
      matchedCount: shard.matchedCount ?? 0,
      pdfKey: shard.pdfKey,
      xlsxKey: shard.xlsxKey,
      csvKey: shard.csvKey,
      stored: true,
      delivered: false,
    };
    const pureCollation = collateShards(
      command.jobId,
      handle.workflowId,
      [shardOutcome],
      [{ lifecycle: "ReportGenerated", atMs: Date.now() }],
      [],
    );
    expect(pureCollation.lifecycle).toBe("ReportGenerated");
    expect(pureCollation.reportKeys).toEqual([shard.pdfKey]);
    expect(pureCollation.xlsxKeys).toEqual([shard.xlsxKey]);
    expect(pureCollation.csvKeys).toEqual([shard.csvKey]);
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

  it("submits a goal screen from the route and answers 202 with the run handle (#4279: the direct submission is retired; the engine path produces the artifacts — see the orchestration test above)", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
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
    expect(resp!.status).toBe(202);
    expect(mockedStart).toHaveBeenCalledTimes(1);
    // The direct agent is never consulted: the artifacts are
    // produced by the engine job's analysis stage, not the route.
    expect(agent.runGoalScreen).not.toHaveBeenCalled();
    const body = (await resp!.json()) as Record<string, any>;
    expect(body.workflowId).toBe(HANDLE.workflowId);
    expect(body.jobId).toBe(HANDLE.jobId);
    expect(body.result).toBeUndefined();
  });
});
