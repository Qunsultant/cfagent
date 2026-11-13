/**
 * Issue #1571: goal-screen runs lack the #1527 Yahoo fallback when
 * E*TRADE auth is dead. The goal-screen path (autonomousGoalScreen)
 * does NOT go through autonomousMarketScreen's guard, so it has no
 * fallback coverage.
 *
 * Verified auth-dead behavior in-tree (before the fix): the goal
 * stock leg (DynamicMarketScreener.screenLive → acquireUniverse
 * "all-listings") reads the Nasdaq listings feed, not the broker —
 * so it is the guard + the Yahoo stock engine that are missing, not
 * a broker call inside the leg. The options leg
 * (DynamicOptionsScreener over etrade.client) IS broker-dependent
 * and fails per-class on auth-dead; it is unchanged by this slice
 * (stocks only, per the 2026-10-25 ruling).
 *
 * Contract pins (same semantics as #1527):
 * - A guard-blocked goal-screen run with stocks requested completes
 *   via Yahoo (the agent runs the stock leg on the Yahoo engine)
 *   instead of failing/partial-failing silently.
 * - The fallback run carries an explicit providerFallback marker on
 *   the agent request, the returned data, the run_completed audit,
 *   and the stage-chain bridge payload — and the goal PDF provenance
 *   names it as a Yahoo fallback, not plain Yahoo and never
 *   E*TRADE live.
 * - A fallback completion emits NO failure notice (no
 *   goal_screen.run_failed audit); the fallback labeling is the
 *   signal. The guard's deduped episode alert already fired inside
 *   the guard.
 * - A fallback that itself fails goes through the normal failure
 *   path (run_failed audit naming the fallback).
 * - E*TRADE-live runs and options-only runs are unchanged: no
 *   marker, and the guard is not even consulted for options-only
 *   runs (no stock leg to fall back).
 *
 * Issue #4279 (#3550 S4): the unchained scheduled path no longer
 * runs the agent inline — it submits the goal command to the one
 * engine. The guard + fallback still run first, and the fallback
 * rides the submission (provider "yahoo" + the marker) into the
 * engine job; a run failure now lives on the engine job, not on
 * the tick. S5 #4280 removed the direct path for chain mode too:
 * the chained test below pins the submission, like the rest.
 */
import { describe, it, expect, vi } from "vitest";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";
import type { GoalDrivenScreenResult } from "../src/services/goalDrivenScreen";
import {
  createYahooStockScreener,
  executeGoalScreenRun,
} from "../src/services/screeningRuntime";
import { generateGoalScreenPdf } from "../src/services/goalScreenReports";
import { STOCK_SCREENING_PROVIDER_ID } from "../src/trading/screeningProvider";

vi.mock("../src/services/goalScreenWorkflowSubmission", () => ({
  buildGoalScreenCommand: vi.fn(() => ({ __cannedGoalCommand: true })),
  startGoalScreenWorkflow: vi.fn(),
}));

import {
  buildGoalScreenCommand,
  startGoalScreenWorkflow,
} from "../src/services/goalScreenWorkflowSubmission";

const mockedBuild = vi.mocked(buildGoalScreenCommand);
const mockedStart = vi.mocked(startGoalScreenWorkflow);

const HANDLE = {
  workflowId: "screen-goal-screen-scheduled-test_trader-income-2026-11-12T00-00-00-000Z",
  jobId: "goal-screen:scheduled:test_trader:income:2026-11-12T00:00:00.000Z",
  status: "queued" as const,
  existing: false,
  statusUrl: "/api/jobs/history?chainId=goal-screen%3Ascheduled%3Atest_trader%3Aincome%3A2026-11-12T00%3A00%3A00.000Z",
};

const FALLBACK_MARKER = { from: "etrade", reason: "etrade-auth-dead" } as const;

function fakeGoalResult(overrides: Partial<GoalDrivenScreenResult> = {}): GoalDrivenScreenResult {
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
      { assetClass: "stocks", providerId: STOCK_SCREENING_PROVIDER_ID, symbol: "AAPL" },
    ],
    counts: { stocksScanned: 100, stocksMatched: 1, optionsUnderlyingsScanned: 0, optionsContractsMatched: 0, hits: 1 },
    completedAt: "2026-10-25T12:00:00.000Z",
    ...overrides,
  };
}

function goalService(opts: {
  blocked: boolean;
  agentResult: () => GoalDrivenScreenResult;
  followupScheduler?: any;
}) {
  const mockEnv = {
    ETRADE_ENVIRONMENT: "sandbox",
    // #2051: goal_workflow is default-ON. The chained test pins
    // the DIRECT fallback path (chain mode keeps it until S5
    // #4280); the unchained tests pin the workflow submission.
    // The flag no longer gates either entry (#4279).
    FEATURE_FLAGS: JSON.stringify({ goal_workflow: false }),
  } as unknown as Env;
  const mockOrm = new DatabaseORM(new MockSqlStorage() as any);
  const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
  const audit = vi.fn(() => {});
  const guard = vi.fn(async () => (opts.blocked
    ? { blocked: true as const, error: "⚠️ [FAILURE_AUTH_NO_SESSION] E*TRADE connection missing — scheduled screen is blocked." }
    : { blocked: false as const }));
  const runGoalScreen = vi.fn(async (req: any) => {
    // Faithful stub of the agent contract: the agent echoes the
    // fallback marker onto the result it returns.
    const result = opts.agentResult();
    return {
      task: { id: "task-1", status: "completed" },
      executed: true,
      result: req.providerFallback ? { ...result, providerFallback: req.providerFallback } : result,
    };
  });
  (service as any).audit = audit;
  (service as any).guardScheduledAuth = guard;
  (service as any).getScreenerAgent = () => ({ runGoalScreen });
  if (opts.followupScheduler) (service as any).followupScheduler = opts.followupScheduler;
  return { service, audit, guard, runGoalScreen };
}

describe("goal-screen Yahoo fallback (#1571)", () => {
  it("a guard-blocked run with stocks requested submits to the engine carrying the Yahoo fallback marker (#4280: chain mode rides the workflow now)", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const bridge = vi.fn(async () => {});
    const { service, audit, guard, runGoalScreen } = goalService({
      blocked: true,
      agentResult: () => fakeGoalResult(),
      followupScheduler: bridge,
    });
    const result = await service.autonomousGoalScreen({
      goalKind: "income",
      stageChain: {} as any,
    });
    expect(result.success).toBe(true);
    expect((result as any).data.status).toBe("queued");
    // The guard is consulted for the stock leg, exactly once.
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard.mock.calls[0][2]).toBe("stock");
    // The direct agent is never consulted — the fallback rides the
    // submission into the engine job, where the stock leg runs it.
    expect(runGoalScreen).not.toHaveBeenCalled();
    expect(mockedBuild).toHaveBeenCalledTimes(1);
    const submitted = mockedBuild.mock.calls[0][0] as Record<string, unknown>;
    expect(submitted.provider).toBe("yahoo");
    expect(submitted.providerFallback).toEqual({ ...FALLBACK_MARKER });
    expect(submitted.stageChain).toEqual({});
    // No failure notice on fallback submission success; the run's
    // failure, if any, lives on the engine job.
    expect(audit.mock.calls.find((c) => c[0] === "goal_screen.run_failed")).toBeUndefined();
    // The bridge lives in the deliver stage now, not on this path.
    expect(bridge).not.toHaveBeenCalled();
  });

  it("a fallback that itself fails is submitted to the engine carrying the marker (#4279: the run failure now lives on the engine job, not the tick)", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const { service, audit, runGoalScreen } = goalService({
      blocked: true,
      agentResult: () => fakeGoalResult({ status: "failed", hits: [], counts: { stocksScanned: 0, stocksMatched: 0, optionsUnderlyingsScanned: 0, optionsContractsMatched: 0, hits: 0 } }),
    });
    const result = await service.autonomousGoalScreen({ goalKind: "income" });
    expect(result.success).toBe(true);
    expect((result as any).data.status).toBe("queued");
    // The direct agent is never consulted on the unchained path.
    expect(runGoalScreen).not.toHaveBeenCalled();
    // The fallback rides the submission into the engine job.
    expect(mockedBuild).toHaveBeenCalledTimes(1);
    const submitted = mockedBuild.mock.calls[0][0] as Record<string, unknown>;
    expect(submitted.provider).toBe("yahoo");
    expect(submitted.providerFallback).toEqual({ ...FALLBACK_MARKER });
    // No tick-level failure audit: the run's failure, if any, is
    // the engine job's (the goal result carries the marker there).
    expect(audit.mock.calls.find((c) => c[0] === "goal_screen.run_failed")).toBeUndefined();
  });

  it("an E*TRADE-live run is unchanged: no marker anywhere (#4279: the submission carries no provider override)", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const { service, audit, guard, runGoalScreen } = goalService({
      blocked: false,
      agentResult: () => fakeGoalResult(),
    });
    const result = await service.autonomousGoalScreen({ goalKind: "income" });
    expect(result.success).toBe(true);
    expect((result as any).data.status).toBe("queued");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(runGoalScreen).not.toHaveBeenCalled();
    const submitted = mockedBuild.mock.calls[0][0] as Record<string, unknown>;
    expect(submitted.provider).toBeUndefined();
    expect(submitted.providerFallback).toBeUndefined();
    expect((result as any).data.providerFallback).toBeUndefined();
    const submitted_audit = audit.mock.calls.find((c) => c[0] === "goal_screen.workflow_submitted");
    expect(submitted_audit).toBeDefined();
    expect((submitted_audit[1] as Record<string, unknown>).providerFallback).toBeUndefined();
  });

  it("an options-only run never consults the guard and carries no marker (#4279)", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const { service, guard, runGoalScreen } = goalService({
      blocked: true,
      agentResult: () => fakeGoalResult(),
    });
    const result = await service.autonomousGoalScreen({
      goalKind: "income",
      assetClasses: ["options"],
    });
    expect(result.success).toBe(true);
    expect((result as any).data.status).toBe("queued");
    expect(guard).not.toHaveBeenCalled();
    expect(runGoalScreen).not.toHaveBeenCalled();
    const submitted = mockedBuild.mock.calls[0][0] as Record<string, unknown>;
    expect(submitted.provider).toBeUndefined();
    expect(submitted.providerFallback).toBeUndefined();
  });

  it("executeGoalScreenRun stamps the marker onto the recorded result when the agent did not", async () => {
    const mockOrm = new DatabaseORM(new MockSqlStorage() as any);
    const agent = {
      runGoalScreen: vi.fn(async () => ({
        task: { id: "task-9", status: "completed" },
        executed: true,
        result: fakeGoalResult(),
      })),
    };
    const out = await executeGoalScreenRun({
      agent: agent as any,
      orm: mockOrm as any,
      env: {},
      userLogin: "alice",
      scenario: { goalKind: "income", direction: "bullish", portfolioRef: { kind: "hypothetical" } } as any,
      scenarioSource: "built",
      trigger: "scheduled",
      idempotencyKey: "goal-screen:test:1571:stamp",
      provider: "yahoo",
      providerFallback: { ...FALLBACK_MARKER },
    } as any);
    expect(out.executed).toBe(true);
    expect((out.result as any)?.providerFallback).toEqual({ ...FALLBACK_MARKER });
    expect((out as any).providerFallback).toEqual({ ...FALLBACK_MARKER });
  });

  it("the Yahoo stock screener screens live Yahoo quotes, not the listings feed", async () => {
    const yahooDeps = {
      fetchYahooQuote: async (symbol: string) => ({
        symbol,
        provenance: "live",
        price: symbol === "AAPL" ? 200 : 100,
        previousClose: symbol === "AAPL" ? 190 : 100,
        companyName: symbol,
      }),
      fetchYahooBatchQuotes: async (symbols: string[]) => symbols.map((symbol) => ({
        symbol,
        provenance: "live",
        price: symbol === "AAPL" ? 200 : 100,
        previousClose: symbol === "AAPL" ? 190 : 100,
        companyName: symbol,
      })),
    };
    const screener = createYahooStockScreener(yahooDeps as any);
    const result = await screener.screenMarkets({});
    // Both Yahoo symbols screened; AAPL's +5.26% move passes the
    // default screen while the flat symbol does not dominate — the
    // point is the quotes came from the injected Yahoo deps, not
    // from any listings fixture or broker.
    expect(result.totalScanned).toBeGreaterThan(0);
    expect(result.stocks.map((s: any) => s.symbol)).toContain("AAPL");
  });

  it("the goal PDF provenance names a fallback run as a Yahoo fallback, never as E*TRADE live", async () => {
    // pdf-lib draws text as hex strings inside Flate-compressed
    // content streams: inflate every stream, decode the hex runs,
    // and search the decoded text. This asserts on the PDF's actual
    // rendered content, not on its byte layout.
    const { inflateSync } = await import("node:zlib");
    function pdfText(bytes: Uint8Array): string {
      const buf = Buffer.from(bytes);
      const text = buf.toString("latin1");
      const dictRe = /<<[^>]*?\/Length (\d+)[^>]*?>>\s*stream\r?\n/g;
      const parts: string[] = [];
      let dm: RegExpExecArray | null;
      while ((dm = dictRe.exec(text)) !== null) {
        const len = parseInt(dm[1], 10);
        const start = dm.index + dm[0].length;
        const raw = buf.subarray(start, start + len);
        let out: string;
        try {
          out = inflateSync(raw).toString("latin1");
        } catch {
          out = raw.toString("latin1");
        }
        out = out.replace(/<([0-9A-Fa-f]+)>/g, (_m, hex: string) =>
          Buffer.from(hex, "hex").toString("latin1")
        );
        parts.push(out);
      }
      return parts.join("\n");
    }
    const text = pdfText(
      await generateGoalScreenPdf(
        fakeGoalResult({ providerFallback: { ...FALLBACK_MARKER } } as any)
      )
    );
    expect(text).toMatch(/Yahoo/);
    expect(text).toMatch(/fallback/i);
    expect(text).not.toMatch(/E\*TRADE live/);
    // Control: a plain run carries no fallback line.
    const plain = pdfText(await generateGoalScreenPdf(fakeGoalResult()));
    expect(plain).not.toMatch(/fallback/i);
  });
});
