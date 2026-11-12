/**
 * Issue #2369 (Agent Mesh S8, #2225 G2) — a chat screen is a
 * ScreenerScreenWorkflow run.
 *
 * The chat stock-screen surface is the NLQ async job; its
 * executor binds `nlqStockScreenPort`. These tests drive THAT
 * port (the chat path's dispatch point) with the workflow
 * faked only at the binding seam: an InMemoryWorkflowAdapter
 * running the real parent/shard flows, an in-memory shard-job
 * store standing in for the D1 projection, the real canonical
 * store seam (persistScreenerReportCanonical) writing into a
 * MockSqlStorage mas_reports, and a fake ScreenerAgent runner
 * behind the flow deps (the agent stub is the workflow's own
 * seam — the run itself is never mocked away).
 *
 * Programme acceptance (#2225): start the real workflow from
 * the chat path; assert the run carries the acting identity +
 * screen parameters, that outcome reads come from the
 * workflow status surface (instance status + D1 collation),
 * and that full results are read back from mas_reports.
 */
import { describe, expect, it, vi } from "vitest";
import {
  nlqStockScreenPort,
  type NlqPortsContext,
} from "../src/agents/orchestrator/nlqPorts";
import {
  persistScreenerReportCanonical,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import type {
  ScreenerWorkflowDeps,
  ShardScreenResult,
} from "../src/workflows/screenerCollation";
import type {
  WorkflowJobCommand,
  WorkflowPort,
} from "../src/workflows/workflowPorts";
import { shardableUniverses } from "../src/trading";
import { MockSqlStorage } from "./mock-sql";

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

const LOGIN = "alice";

function fullResult(universe: string, overrides: Record<string, unknown> = {}) {
  return {
    timestamp: new Date().toISOString(),
    trigger: "manual",
    provider: "etrade",
    universe,
    sector: "Technology",
    success: true,
    totalScanned: 100,
    matchedCount: 2,
    opportunities: [
      { symbol: "NVDA", companyName: "NVIDIA", lastPrice: 190, changePercent: 2.1 },
      { symbol: "AMD", companyName: "AMD", lastPrice: 160, changePercent: 1.2 },
    ],
    allStocks: [
      { symbol: "NVDA", companyName: "NVIDIA", sector: "Technology", lastPrice: 190, changePercent: 2.1, source: "etrade" },
      { symbol: "AMD", companyName: "AMD", sector: "Technology", lastPrice: 160, changePercent: 1.2, source: "etrade" },
    ],
    discoveryMessage: `Discovered listings for ${universe}`,
    filterSummary: "minPrice >= 10",
    rejections: [{ symbol: "XYZ", reason: "below min price" }],
    pdfKey: `screener/${universe}/report.pdf`,
    userLogin: LOGIN,
    ...overrides,
  };
}

interface Harness {
  ctx: NlqPortsContext;
  sql: MockSqlStorage;
  shardStore: InMemoryShardJobAdapter;
  startedCommands: WorkflowJobCommand[];
  delivered: unknown[];
  agentCalls: Array<Record<string, unknown>>;
  adapter: InMemoryWorkflowAdapter;
}

/**
 * Build the chat port context. `runScreenImpl` is the fake
 * ScreenerAgent runner the workflow children execute through;
 * `agentImpl` is the legacy direct-call agent (fallback path).
 */
function makeHarness(opts: {
  runScreenImpl?: ScreenerWorkflowDeps["screenRunner"]["runScreen"];
  agentImpl?: (req: Record<string, unknown>) => Promise<unknown>;
  workflowPort?: WorkflowPort | null;
  withWorkflow?: boolean;
} = {}): Harness {
  const sql = new MockSqlStorage();
  const shardStore = new InMemoryShardJobAdapter();
  const startedCommands: WorkflowJobCommand[] = [];
  const delivered: unknown[] = [];
  const agentCalls: Array<Record<string, unknown>> = [];

  const reportCtx = {
    env: {},
    ensureTables: () => sql,
  } as unknown as ReportDispatchContext;

  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      runScreen:
        opts.runScreenImpl ??
        (async (req) => {
          const full = fullResult(req.universe ?? "TECH");
          const summary: ShardScreenResult = {
            success: full.success,
            timestamp: full.timestamp,
            universe: full.universe,
            totalScanned: full.totalScanned,
            expectedCount: full.totalScanned,
            matchedCount: full.matchedCount,
            pdfKey: full.pdfKey,
            trigger: "manual",
            full,
          };
          return summary;
        }),
    },
    shardStore,
    // The production door (OrchestratorAgent.recordWorkflowScreenReport)
    // is exactly this seam call — the real canonical store.
    storeReport: async (payload) => {
      await persistScreenerReportCanonical(
        reportCtx,
        payload as Parameters<typeof persistScreenerReportCanonical>[1],
      );
    },
    deliverOutcome: async (payload) => {
      delivered.push(payload);
    },
    nowMs: () => Date.now(),
  };
  const adapter = new InMemoryWorkflowAdapter(deps);
  const recordingPort: WorkflowPort = {
    start: async (command) => {
      startedCommands.push(command);
      return adapter.start(command);
    },
    status: (workflowId) => adapter.status(workflowId),
  };

  const withWorkflow = opts.withWorkflow ?? true;
  const ctx: NlqPortsContext = {
    schedule: async () => ({}),
    scheduleEvery: async () => ({}),
    cancelSchedule: async () => true,
    listSchedules: async () => [],
    getScreenerAgent: () => {
      if (!opts.agentImpl) {
        throw new Error("direct ScreenerAgent path must not be used when the workflow port is available");
      }
      return {
        runScreen: async (req: Record<string, unknown>) => {
          agentCalls.push(req);
          return opts.agentImpl(req);
        },
      } as never;
    },
    getSocialBriefStore: () => null,
    env: {} as NlqPortsContext["env"],
    ensureTables: () => sql as never,
    ...(opts.workflowPort !== undefined
      ? { workflowPort: opts.workflowPort }
      : withWorkflow
        ? { workflowPort: recordingPort }
        : {}),
    readWorkflowJobHistory: (tenantId, chainId) =>
      shardStore.listJobsForChain(tenantId, chainId),
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 60_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
  };
  return { ctx, sql, shardStore, startedCommands, delivered, agentCalls, adapter };
}

function storedReportBodies(sql: MockSqlStorage): Array<Record<string, unknown>> {
  const rows = Array.from(
    sql.exec("SELECT body FROM mas_reports WHERE source = ?", "screener"),
  ) as Array<{ body: string }>;
  return rows.map((r) => JSON.parse(r.body) as Record<string, unknown>);
}

/* ------------------------------------------------------------------ */
/* Acceptance: the real workflow, started from the chat port           */
/* ------------------------------------------------------------------ */

describe("issue #2369 — chat screen as a ScreenerScreenWorkflow run", () => {
  it("starts the real workflow from the chat port and returns its stored result", async () => {
    const h = makeHarness();
    const port = nlqStockScreenPort(h.ctx);
    const result = await port.runScreen({
      filters: { universe: "NASDAQ100", minPrice: 10 } as never,
      userLogin: LOGIN,
    });

    // The run started through the workflow port, carrying the
    // acting identity + screen parameters (never a tool argument).
    expect(h.startedCommands).toHaveLength(1);
    const command = h.startedCommands[0];
    expect(command.type).toBe("run-screen");
    expect(command.role).toBe("parent");
    expect(command.source).toBe("nlq-chat");
    expect(command.userLogin).toBe(LOGIN);
    expect(command.maxItems).toBe(10);
    expect(command.filters).toMatchObject({ universe: "NASDAQ100", minPrice: 10 });
    expect(command.shards).toEqual([{ shardId: "NASDAQ100", universe: "NASDAQ100" }]);
    expect(command.jobId.startsWith("screener:chat:NASDAQ100:")).toBe(true);

    // The workflow instance actually ran to completion.
    const status = await h.adapter.status(`screen-${command.jobId.replace(/[^A-Za-z0-9_-]/g, "-")}`);
    expect(status?.status).toBe("complete");

    // The D1 projection carries the parent collation for the run.
    const rows = await h.shardStore.listJobsForChain(command.tenantId ?? "", command.jobId);
    const parent = rows.find((r) => r.jobKey === command.jobId);
    expect(parent).toBeDefined();
    const collation = JSON.parse(parent!.resultJson) as { lifecycle: string };
    expect(collation.lifecycle).toBe("ReportGenerated");

    // The result returned to the NLQ layer is the workflow run's
    // own stored result, read back from mas_reports.
    expect(result.success).toBe(true);
    expect(result.universe).toBe("NASDAQ100");
    expect(result.totalScanned).toBe(100);
    expect(result.matchedCount).toBe(2);
    expect(result.allStocks.map((s) => s.symbol)).toEqual(["NVDA", "AMD"]);
    expect(result.opportunities.map((o) => o.symbol)).toEqual(["NVDA", "AMD"]);
    expect(result.pdfKey).toBe("screener/NASDAQ100/report.pdf");
    expect(result.discoveryMessage).toBe("Discovered listings for NASDAQ100");
    expect(result.filterSummary).toBe("minPrice >= 10");
    expect(result.rejections).toEqual([{ symbol: "XYZ", reason: "below min price" }]);

    // Exactly one canonical row was stored — by the workflow's
    // store step (the port itself stores nothing).
    const bodies = storedReportBodies(h.sql);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].universe).toBe("NASDAQ100");
  });

  it("fails closed on a missing or synthetic acting identity — before any start, before any fallback", async () => {
    const h = makeHarness({
      agentImpl: async () => {
        throw new Error("fallback must not run without identity either");
      },
    });
    const port = nlqStockScreenPort(h.ctx);
    await expect(
      port.runScreen({ filters: {} as never, userLogin: "" }),
    ).rejects.toThrow(/identity|login/i);
    await expect(
      port.runScreen({ filters: {} as never, userLogin: "default" }),
    ).rejects.toThrow(/identity|login/i);
    await expect(
      port.runScreen({ filters: {} as never, userLogin: "   " }),
    ).rejects.toThrow(/identity|login/i);
    expect(h.startedCommands).toHaveLength(0);
    expect(h.agentCalls).toHaveLength(0);
  });

  it("surfaces a shard stage failure as a failed result carrying the error — never a fabricated success", async () => {
    const h = makeHarness({
      runScreenImpl: async (req) => {
        const full = fullResult(req.universe ?? "TECH", {
          success: false,
          totalScanned: 0,
          matchedCount: 0,
          opportunities: [],
          allStocks: [],
          error: "E*TRADE quotes unavailable for this universe.",
          pdfKey: undefined,
        });
        return {
          success: false,
          timestamp: full.timestamp,
          universe: full.universe,
          totalScanned: 0,
          expectedCount: 0,
          matchedCount: 0,
          error: "E*TRADE quotes unavailable for this universe.",
          trigger: "manual",
          full,
        } as ShardScreenResult;
      },
    });
    const port = nlqStockScreenPort(h.ctx);
    const result = await port.runScreen({
      filters: { universe: "SP100" } as never,
      userLogin: LOGIN,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("E*TRADE quotes unavailable");
    expect(result.allStocks).toEqual([]);
    expect(result.matchedCount).toBe(0);
  });

  it("requests no delivery step for a chat screen (the NLQ request shape carries no delivery request)", async () => {
    const h = makeHarness();
    const port = nlqStockScreenPort(h.ctx);
    await port.runScreen({
      filters: { universe: "NASDAQ100" } as never,
      userLogin: LOGIN,
    });
    expect(h.startedCommands[0].deliver).toBeUndefined();
    expect(h.delivered).toHaveLength(0);
  });

  it("aggregates a multi-shard ALL run from the per-shard stored reports", async () => {
    // The canonical seam is idempotent by generation
    // (screener:<run timestamp>) — real shard runs start at
    // distinct times, so the fake stamps distinct timestamps.
    let tick = 0;
    const h = makeHarness({
      runScreenImpl: async (req) => {
        const full = fullResult(req.universe ?? "TECH", {
          timestamp: new Date(Date.now() + tick++ * 1_000).toISOString(),
          totalScanned: 10,
          matchedCount: 1,
          opportunities: [{ symbol: `${req.universe}-PICK` }],
          allStocks: [
            { symbol: `${req.universe}-PICK`, companyName: "Pick", sector: "Technology", lastPrice: 10, changePercent: 1, source: "etrade" },
          ],
          pdfKey: `screener/${req.universe}/report.pdf`,
        });
        return {
          success: true,
          timestamp: full.timestamp,
          universe: full.universe,
          totalScanned: 10,
          expectedCount: 10,
          matchedCount: 1,
          pdfKey: full.pdfKey,
          trigger: "manual",
          full,
        } as ShardScreenResult;
      },
    });
    const port = nlqStockScreenPort(h.ctx);
    const result = await port.runScreen({
      filters: { universe: "ALL" } as never,
      userLogin: LOGIN,
    });
    const universes = shardableUniverses();
    expect(h.startedCommands[0].shards.map((s) => s.shardId)).toEqual(universes);
    expect(result.success).toBe(true);
    expect(result.universe).toBe("ALL");
    expect(result.totalScanned).toBe(10 * universes.length);
    expect(result.matchedCount).toBe(universes.length);
    expect(result.allStocks).toHaveLength(universes.length);
    expect(storedReportBodies(h.sql)).toHaveLength(universes.length);
  });

  it("falls back to the direct ScreenerAgent call when the workflow port is unavailable (route precedent)", async () => {
    const direct = fullResult("NASDAQ100");
    const h = makeHarness({
      withWorkflow: false,
      agentImpl: async () => direct,
    });
    const port = nlqStockScreenPort(h.ctx);
    const result = await port.runScreen({
      filters: { universe: "NASDAQ100" } as never,
      userLogin: LOGIN,
    });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.agentCalls[0]).toMatchObject({
      trigger: "manual",
      universe: "NASDAQ100",
      userLogin: LOGIN,
      maxItems: 10,
    });
    expect(result.success).toBe(true);
    expect(result.allStocks.map((s) => s.symbol)).toEqual(["NVDA", "AMD"]);
  });

  it("returns an honest tracked failure when the workflow never reaches a terminal state in the await window", async () => {
    const hangingPort: WorkflowPort = {
      start: async (command) => ({
        workflowId: "screen-hanging",
        jobId: command.jobId,
        status: "running",
        existing: false,
        statusUrl: `/api/jobs/history?chainId=${encodeURIComponent(command.jobId)}`,
      }),
      status: async () => ({ workflowId: "screen-hanging", status: "running" }),
    };
    const h = makeHarness({ workflowPort: hangingPort });
    h.ctx.workflowAwaitDeadlineMs = 5;
    const port = nlqStockScreenPort(h.ctx);
    const result = await port.runScreen({
      filters: { universe: "NASDAQ100" } as never,
      userLogin: LOGIN,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("screener:chat:NASDAQ100:");
    expect(result.error).toContain("/api/jobs/history?chainId=");
    expect(h.agentCalls).toHaveLength(0);
  });
});
