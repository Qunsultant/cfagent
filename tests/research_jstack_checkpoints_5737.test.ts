import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resolveResearchEngineAdapters } from "../src/workflows/researchScreenEngine";
import { handleScreenerResearchRoutes } from "../src/agents/routes/screenerResearch";

const CORE_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/server/routes/core.ts"),
  "utf8",
);
const ORCH_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/agents/orchestrator.ts"),
  "utf8",
);

describe("Issue #5737 / #5597 — OODA research runs on J-stack with durable SQLite+D1 checkpoints", () => {
  it("routes /research/* as immediate J-stack dispatch instead of wrapping in 0/1 http.request", () => {
    const coreMatch = CORE_SRC.match(/const isImmediateSync = (\/[^;]+\/[a-z]*)\.test/);
    const orchMatch = ORCH_SRC.match(/const isImmediateEndpoint = (\/[^;]+\/[a-z]*)\.test/);
    expect(coreMatch).not.toBeNull();
    expect(orchMatch).not.toBeNull();

    const isImmediateSync = eval(coreMatch![1]) as RegExp;
    const isImmediateEndpoint = eval(orchMatch![1]) as RegExp;

    expect(isImmediateSync.test("/research/run")).toBe(true);
    expect(isImmediateSync.test("/research/evaluate")).toBe(true);
    expect(isImmediateEndpoint.test("/research/run")).toBe(true);
    expect(isImmediateEndpoint.test("/api/research/run")).toBe(true);
    expect(isImmediateEndpoint.test("/research/evaluate")).toBe(true);
  });

  it("POST /research/run returns engineJobId, 6 stages, cutoverMode, storageMode, and guards throwing getOrm (#5597)", async () => {
    const res = await handleScreenerResearchRoutes(
      new Request("https://agent.internal/research/run", {
        method: "POST",
        headers: { "x-user-login": "OpenAIMP" },
      }),
      new URL("https://agent.internal/research/run"),
      "/research/run",
      "OpenAIMP",
      {
        getScreenerAgent: () => ({} as any),
        getScreenerExecutionContext: async () => undefined,
        // Issue #6355 — the feed/enrich stages now run for real (their
        // steps carry userLogin), so the fixture provides the agent the
        // production route always has. A null agent fails loudly at feed
        // with research_stage_unavailable instead of silently completing
        // the stages as not_configured.
        getResearchAgent: () =>
          ({
            runFeedStage: async (input: { runId?: string }) => ({
              runId: input.runId ?? "r1",
              asOf: new Date().toISOString(),
              regime: null,
              universe: "nasdaq100",
              universeError: null,
              symbols: [],
              quotes: [],
              universeSize: 0,
              quotesRetrieved: 0,
            }),
            runEnrichStage: async (feed: unknown, input: { runId?: string }) => ({
              runId: input.runId ?? "r1",
              asOf: new Date().toISOString(),
              feed,
              bySymbol: {},
            }),
          }) as any,
        runResearchAndPublish: async () => ({
          success: true,
          reportId: "rep_jstack_1",
          report: { runId: "r1" },
        }),
        getOrm: () => {
          throw new Error("unused in this pin");
        },
        readSettingRaw: () => null,
        writeSetting: () => {},
        env: {},
      },
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(String(body.engineJobId)).toMatch(/^research:/);
    expect(body.cutoverMode).toBe("engine");
    expect(body.trigger).toBe("manual");
    expect(Array.isArray(body.stages)).toBe(true);
    expect(body.stages.map((s: any) => s.stageId)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
      "evaluate",
    ]);
  });

  it("resolveResearchEngineAdapters records run records to D1 only when both sql and d1 are present", async () => {
    const sqlExec = vi.fn(() => ({ toArray: () => [], one: () => null, raw: () => [], columnNames: [], rowsRead: 0, rowsWritten: 0 }));
    const d1Run = vi.fn(async () => ({ success: true, meta: {} }));
    // The D1 store's prune runs a fielded select, which drizzle
    // serves through the statement's raw() — the mock needs it
    // (the old two-legged test never noticed: its D1 mirror call
    // swallowed the missing-method error as "best-effort").
    const d1Bind = vi.fn(() => ({ run: d1Run, all: vi.fn(async () => ({ results: [] })), first: vi.fn(async () => null), raw: vi.fn(async () => []) }));
    const d1Prepare = vi.fn(() => ({ bind: d1Bind, run: d1Run }));

    const adapters = resolveResearchEngineAdapters({
      sql: { exec: sqlExec } as any,
      d1: { prepare: d1Prepare, batch: vi.fn(async () => []) } as any,
      storageMode: "durable",
    });

    expect(adapters.storageMode).toBe("durable");
    expect(adapters.ephemeralFallback).toBe(false);

    await adapters.runRecorder.recordRun({
      system: "job-pipeline",
      jobId: "research:test-1",
      operation: "research.run",
      triggeredBy: "manual",
      outcome: "success",
      started: "2026-11-19T11:00:00.000Z",
      finished: "2026-11-19T11:00:01.000Z",
    });

    // Issue #6101 — the DO leg is gone: the run record goes to D1
    // only, and the DO SQLite handle is never written for it (the
    // pipeline stores still live there; the run recorder does not).
    expect(sqlExec).not.toHaveBeenCalled();
    expect(d1Prepare).toHaveBeenCalled();
  });
});
