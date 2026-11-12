/**
 * Issue #4278 ([One engine] #3550 S3) — stock entry routing.
 *
 * Every direct ScreenerAgent.runScreen / runSharded call site drives the
 * engine-routed workflow through the ONE shared seam
 * (src/workflows/runStockScreenViaEngine.ts): start via the broker's
 * spec -> command machinery, pre-start gates (in-flight probe, quota
 * charge), awaited collation, and assembly back to ScreenerRunResult.
 * No direct agent call remains in production code outside the agent's
 * own internals and the documented test/in-memory seams.
 *
 * Pins:
 *  - Seam: command built by the broker's builder; gates run in order
 *    (ND backstop -> in-flight probe -> quota charge -> start); a
 *    start failure answers the caller's coded failure (no silent
 *    direct fallback, no invented result); in-flight refuses by name
 *    with the running run's id; quota refusal propagates; dup
 *    collation synthesizes the skippedDuplicate result; return shape
 *    identical (full ScreenerRunResult incl. pdf/xlsx keys).
 *  - Sites: etrade sync + ALL, market-data sync + ALL, premium sync
 *    (symbols command), NLQ port, scheduled monolithic, A2A
 *    run_screen — each through the seam, each keeping its return
 *    contract, persist/deliver finalizers intact (workflow-owned
 *    store/deliver for successes; route finalizers only for failures
 *    the workflow never stored).
 *  - Allow list: no .runScreen( / .runSharded( remains in the routed
 *    files; only the agent internals, the port call in NLQ execution,
 *    and the documented test/in-memory seams keep the call.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  aggregateShardResults,
  runStockScreenViaEngine,
  type EngineScreenRunOutcome,
} from "../src/workflows/runStockScreenViaEngine";
import type { ScreenerRunResult } from "../src/agents/screener-agent";
import { ScreenAlreadyRunningError } from "../src/services/screenInFlight";
import { UserRequestQuotaExceededError } from "../src/security/userRequestQuota";
import { WorkflowError, type WorkflowCollation, type WorkflowJobCommand } from "../src/workflows/workflowPorts";
import { shardableUniverses } from "../src/trading";

function cannedResult(overrides: Partial<ScreenerRunResult> = {}): ScreenerRunResult {
  return {
    timestamp: "2026-11-12T10:00:00.000Z",
    trigger: "manual",
    provider: "etrade",
    universe: "TECH",
    sector: "ALL",
    success: true,
    totalScanned: 10,
    expectedCount: 10,
    matchedCount: 2,
    opportunities: [{ symbol: "AAPL" } as never],
    allStocks: [{ symbol: "AAPL", companyName: "Apple", lastPrice: 100, changePercent: 1, source: "etrade" } as never],
    discoveryMessage: "2 matches",
    filterSummary: "test",
    pdfKey: "pdf-1",
    pdfStatus: "generated",
    xlsxKey: "xlsx-1",
    xlsxStatus: "generated",
    ...overrides,
  } as ScreenerRunResult;
}

function collationRow(jobId: string, collation: WorkflowCollation) {
  return { jobKey: jobId, resultJson: JSON.stringify(collation) } as never;
}

function collationFor(jobId: string, shards: Array<{ shardId: string; pdfKey?: string; error?: string; status?: "completed" | "failed" | "timed_out"; totalScanned?: number; matchedCount?: number }>): WorkflowCollation {
  return {
    jobId,
    workflowId: `wf-${jobId}`,
    lifecycle: shards.every((s) => s.status !== "failed" && s.status !== "timed_out") ? "Completed" : "Failed",
    qualified: false,
    coverage: { evaluated: 10, considered: 10, ratio: 1 },
    shards: shards.map((s) => ({
      shardId: s.shardId,
      status: s.status ?? "completed",
      totalScanned: s.totalScanned ?? 10,
      matchedCount: s.matchedCount ?? 2,
      ...(s.pdfKey ? { pdfKey: s.pdfKey } : {}),
      ...(s.error ? { error: s.error } : {}),
    })),
    lifecycleTransitions: [],
    stageTransitions: [],
    reportKeys: shards.map((s) => s.pdfKey).filter((k): k is string => Boolean(k)),
    storedShards: shards.map((s) => s.shardId),
    deliveredShards: shards.map((s) => s.shardId),
  };
}

interface SeamHarness {
  started: WorkflowJobCommand[];
  startCalls: number;
  charges: Array<{ userLogin: string; runId: string }>;
  probes: Array<{ userLogin: string; universe: string }>;
  port: {
    start: (...args: unknown[]) => Promise<unknown>;
    status: (...args: unknown[]) => Promise<unknown>;
  };
  history: ScreenerRunResult[];
  /** Read-history call counter (lives on the harness: seamInput is a separate scope). */
  rowCall: number;
  opts: {
    probeRunning?: { startedAt: number; runId: string };
    chargeThrows?: Error;
    startThrows?: Error;
    portNull?: boolean;
    statusSequence?: string[];
    rowsSequence?: Array<unknown[] | null>;
  };
}

function makeHarness(opts: SeamHarness["opts"] = {}): SeamHarness {
  const started: WorkflowJobCommand[] = [];
  const charges: SeamHarness["charges"] = [];
  const probes: SeamHarness["probes"] = [];
  const statusSequence = opts.statusSequence ?? [];
  let statusCall = 0;
  const harness: SeamHarness = {
    started,
    startCalls: 0,
    charges,
    probes,
    port: {
      start: async (command: unknown) => {
        if (opts.startThrows) throw opts.startThrows;
        harness.startCalls += 1;
        started.push(command as WorkflowJobCommand);
        return {
          workflowId: `wf-${(command as WorkflowJobCommand).jobId}`,
          jobId: (command as WorkflowJobCommand).jobId,
          status: "queued" as const,
          existing: false,
          statusUrl: `/api/jobs/history?chainId=${encodeURIComponent((command as WorkflowJobCommand).jobId)}`,
        };
      },
      status: async () => {
        const status = statusSequence[statusCall] ?? "complete";
        statusCall += 1;
        return { workflowId: "wf-1", status };
      },
    },
    history: [],
    rowCall: 0,
    opts,
  };
  return harness;
}

function seamInput(harness: SeamHarness, overrides: Record<string, unknown> = {}) {
  return {
    env: {} as never,
    spec: {
      source: "etrade" as const,
      trigger: "manual" as const,
      deliver: true,
      filters: { minPrice: 10 },
      universe: "TECH",
      asyncRequested: false,
      delivery: {},
      userLogin: "alice",
    },
    userLogin: "alice",
    agent: {
      isScreenRunning: async (universe: string, userLogin: string) => {
        harness.probes.push({ userLogin, universe });
        if (harness.opts.probeRunning) {
          return {
            running: true,
            startedAt: harness.opts.probeRunning.startedAt,
            runId: harness.opts.probeRunning.runId,
            status: "running" as const,
          };
        }
        return { running: false, startedAt: null, runId: null, status: "idle" as const };
      },
      chargeScreenQuota: async (input: { userLogin: string; runId: string }) => {
        if (harness.opts.chargeThrows) throw harness.opts.chargeThrows;
        harness.charges.push(input);
      },
      getHistory: async () => harness.history,
    },
    ...(harness.opts.portNull ? { workflowPort: null } : { workflowPort: harness.port as never }),
    readWorkflowJobHistory: async (_tenantId: string, jobId: string) => {
      const seq = harness.opts.rowsSequence ?? [];
      const rows = seq[harness.rowCall] ?? seq[seq.length - 1] ?? null;
      harness.rowCall += 1;
      return rows as never;
    },
    sleep: async () => {},
    nowMs: () => 1_000_000,
    awaitDeadlineMs: 600_000,
    pollIntervalMs: 1,
    ...overrides,
  } as never;
}

describe("seam: start via the broker's command machinery (#4278)", () => {
  it("starts the broker-built command and assembles the full stored result", async () => {
    const harness = makeHarness();
    const jobId = "screener:manual:TECH:2026-11-12T10:00:00.000Z";
    const collation = collationFor(jobId, [{ shardId: "TECH", pdfKey: "pdf-1" }]);
    harness.opts.rowsSequence = [[collationRow(jobId, collation)]];
    harness.history = [cannedResult()];
    const out: EngineScreenRunOutcome = await runStockScreenViaEngine(
      seamInput(harness, { spec: { source: "etrade", trigger: "manual", deliver: true, filters: { minPrice: 10 }, universe: "TECH", asyncRequested: false, delivery: {}, userLogin: "alice", jobId } }),
    );
    expect(harness.startCalls).toBe(1);
    const command = harness.started[0];
    expect(command.type).toBe("run-screen");
    expect(command.jobId).toBe(jobId);
    expect(command.role).toBe("parent");
    expect(command.userLogin).toBe("alice");
    expect(command.shards).toEqual([{ shardId: "TECH", universe: "TECH" }]);
    expect(command.filters).toEqual({ minPrice: 10 });
    expect(command.deliver).toBe(true);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].pdfKey).toBe("pdf-1");
    expect(out.results[0].xlsxKey).toBe("xlsx-1");
    expect(out.results[0].provider).toBe("etrade");
    expect(out.results[0].opportunities).toEqual([{ symbol: "AAPL" }]);
    expect(out.collation.lifecycle).toBe("Completed");
    expect(out.jobId).toBe(jobId);
  });

  it("probes in-flight first, then charges quota once per shard, then starts", async () => {
    const harness = makeHarness();
    const jobId = "screener:manual:TECH:2026-11-12T10:00:00.000Z";
    harness.opts.rowsSequence = [[collationRow(jobId, collationFor(jobId, [{ shardId: "TECH", pdfKey: "pdf-1" }]))]];
    harness.history = [cannedResult()];
    const order: string[] = [];
    const input = seamInput(harness, {
      spec: { source: "etrade", trigger: "manual", deliver: true, filters: {}, universe: "TECH", asyncRequested: false, delivery: {}, userLogin: "alice", jobId },
    });
    const origProbe = input.agent.isScreenRunning;
    input.agent.isScreenRunning = async (...a: [string, string]) => { order.push("probe"); return origProbe(...a); };
    const origCharge = input.agent.chargeScreenQuota;
    input.agent.chargeScreenQuota = async (...a: [{ userLogin: string; runId: string }]) => { order.push("charge"); return origCharge(...a); };
    const origStart = harness.port.start;
    harness.port.start = async (...a: unknown[]) => { order.push("start"); return origStart(...a); };
    await runStockScreenViaEngine(input);
    expect(order).toEqual(["probe", "charge", "start"]);
    expect(harness.probes).toEqual([{ userLogin: "alice", universe: "TECH" }]);
    expect(harness.charges).toHaveLength(1);
    expect(harness.charges[0].runId).toBe(`${jobId}:TECH`);
    expect(harness.charges[0].userLogin).toBe("alice");
  });

  it("fans ALL out to every shardable universe, in shard order", async () => {
    const harness = makeHarness();
    const jobId = "screener:manual:ALL:2026-11-12T10:00:00.000Z";
    const universes = shardableUniverses();
    expect(universes.length).toBeGreaterThan(1);
    const collation = collationFor(
      jobId,
      universes.map((u) => ({ shardId: u, pdfKey: `pdf-${u}` })),
    );
    harness.opts.rowsSequence = [[collationRow(jobId, collation)]];
    harness.history = universes.map((u) => cannedResult({ universe: u as never, pdfKey: `pdf-${u}` }));
    const out = await runStockScreenViaEngine(
      seamInput(harness, {
        spec: { source: "etrade", trigger: "manual", deliver: true, filters: {}, universe: "ALL", asyncRequested: false, delivery: {}, userLogin: "alice", jobId },
      }),
    );
    expect(harness.started[0].shards.map((s) => s.shardId)).toEqual(universes);
    expect(out.results.map((r) => r.universe)).toEqual(universes);
    expect(harness.probes.map((p) => p.universe)).toEqual(universes);
    expect(harness.charges).toHaveLength(universes.length);
  });

  it("carries command overrides: symbols shard, maxItems/maxSymbols, jobId, broker/mode", async () => {
    const harness = makeHarness();
    const jobId = "screener:manual:symbols:2026-11-12T10:00:00.000Z";
    const listings = [{ symbol: "NVDA", companyName: "NVIDIA", exchange: "nasdaq", change: 0, changePercent: 0 }];
    const collation = collationFor(jobId, [{ shardId: "symbols", pdfKey: "pdf-1" }]);
    harness.opts.rowsSequence = [[collationRow(jobId, collation)]];
    harness.history = [cannedResult({ universe: "TECH" })];
    await runStockScreenViaEngine(
      seamInput(harness, {
        spec: { source: "market-data", trigger: "manual", deliver: false, filters: {}, universe: "TECH", asyncRequested: false, delivery: {}, userLogin: "alice", provider: "yahoo" },
        commandOverrides: {
          jobId,
          shards: [{ shardId: "symbols", symbols: listings }],
          maxItems: 1,
          maxSymbols: 1,
          broker: "etrade",
          mode: "paper",
          modeSource: "selection",
        },
      }),
    );
    const command = harness.started[0];
    expect(command.jobId).toBe(jobId);
    expect(command.shards).toEqual([{ shardId: "symbols", symbols: listings }]);
    expect(command.maxItems).toBe(1);
    expect(command.maxSymbols).toBe(1);
    expect(command.provider).toBe("yahoo");
    expect(command.broker).toBe("etrade");
    expect(command.mode).toBe("paper");
    expect(command.modeSource).toBe("selection");
  });
});

describe("seam: failure and recovery (#4278)", () => {
  it("an in-flight run refuses by name with the running run's id — no start, no charge", async () => {
    const harness = makeHarness({
      probeRunning: { startedAt: 999_000, runId: "screen:alice:TECH:999000" },
    });
    const input = seamInput(harness, {
      spec: { source: "etrade", trigger: "manual", deliver: true, filters: {}, universe: "TECH", asyncRequested: false, delivery: {}, userLogin: "alice" },
    });
    await expect(runStockScreenViaEngine(input)).rejects.toBeInstanceOf(ScreenAlreadyRunningError);
    await expect(runStockScreenViaEngine(input)).rejects.toThrow("already running");
    await expect(runStockScreenViaEngine(input)).rejects.toThrow("screen:alice:TECH:999000");
    expect(harness.startCalls).toBe(0);
    expect(harness.charges).toHaveLength(0);
  });

  it("a quota refusal propagates — no start", async () => {
    const quotaErr = new UserRequestQuotaExceededError({
      window: "daily",
      limit: 10,
      usage: 10,
      resetAtMs: Date.parse("2026-11-13T00:00:00.000Z"),
      runId: "screen:alice:TECH:1",
    });
    const harness = makeHarness({ chargeThrows: quotaErr });
    await expect(
      runStockScreenViaEngine(
        seamInput(harness, {
          spec: { source: "etrade", trigger: "manual", deliver: true, filters: {}, universe: "TECH", asyncRequested: false, delivery: {}, userLogin: "alice" },
        }),
      ),
    ).rejects.toThrow("quota exceeded");
    expect(harness.startCalls).toBe(0);
  });

  it("an unavailable workflow port is a coded failure — no direct fallback", async () => {
    const harness = makeHarness({ portNull: true });
    const input = seamInput(harness, {
      spec: { source: "etrade", trigger: "manual", deliver: true, filters: {}, universe: "TECH", asyncRequested: false, delivery: {}, userLogin: "alice" },
    });
    await expect(runStockScreenViaEngine(input)).rejects.toBeInstanceOf(WorkflowError);
    await expect(runStockScreenViaEngine(input)).rejects.toThrow("unavailable");
    expect(harness.startCalls).toBe(0);
  });

  it("a start failure is a coded failure — no invented result, no second start", async () => {
    const harness = makeHarness({ startThrows: new Error("binding create failed") });
    await expect(
      runStockScreenViaEngine(
        seamInput(harness, {
          spec: { source: "etrade", trigger: "manual", deliver: true, filters: {}, universe: "TECH", asyncRequested: false, delivery: {}, userLogin: "alice" },
        }),
      ),
    ).rejects.toBeInstanceOf(WorkflowError);
    expect(harness.startCalls).toBe(0);
  });

  it("an ND command with the gate closed refuses before probe, charge, or start", async () => {
    const harness = makeHarness();
    const input = seamInput(harness, {
      env: { SCREENER_ND_MODE: "off" } as never,
      spec: {
        source: "etrade",
        trigger: "manual",
        deliver: true,
        filters: {},
        universe: "TECH",
        asyncRequested: false,
        delivery: {},
        userLogin: "alice",
        screenMode: "non-deterministic",
        screenIntent: "find momentum leaders",
      },
    });
    await expect(runStockScreenViaEngine(input)).rejects.toBeInstanceOf(WorkflowError);
    await expect(runStockScreenViaEngine(input)).rejects.toThrow("Non-deterministic screen command refused");
    expect(harness.probes).toHaveLength(0);
    expect(harness.charges).toHaveLength(0);
    expect(harness.startCalls).toBe(0);
  });

  it("a failed collation returns a failed result (no throw) naming the shard error", async () => {
    const harness = makeHarness();
    const jobId = "screener:manual:TECH:2026-11-12T10:00:00.000Z";
    harness.opts.rowsSequence = [
      [collationRow(jobId, collationFor(jobId, [{ shardId: "TECH", status: "failed", error: "E*TRADE unavailable" }]))],
    ];
    harness.history = [];
    const out = await runStockScreenViaEngine(
      seamInput(harness, {
        spec: { source: "etrade", trigger: "manual", deliver: true, filters: {}, universe: "TECH", asyncRequested: false, delivery: {}, userLogin: "alice", jobId },
      }),
    );
    expect(out.results).toHaveLength(1);
    expect(out.results[0].success).toBe(false);
    expect(out.results[0].error).toBe("E*TRADE unavailable");
    expect(out.collation.lifecycle).toBe("Failed");
  });

  it("a duplicate-scheduled collation synthesizes the skippedDuplicate result", async () => {
    const harness = makeHarness();
    const jobId = "screener:scheduled:TECH:2026-11-12T10:00:00.000Z";
    const dupMessage = "Duplicate scheduled delivery suppressed for this account, environment, universe, and minute.";
    harness.opts.rowsSequence = [
      [collationRow(jobId, collationFor(jobId, [{ shardId: "TECH", status: "failed", error: dupMessage }]))],
    ];
    harness.history = [];
    const out = await runStockScreenViaEngine(
      seamInput(harness, {
        spec: { source: "market-data", trigger: "scheduled", deliver: false, filters: {}, universe: "TECH", asyncRequested: false, delivery: {}, userLogin: "alice", jobId },
      }),
    );
    expect(out.results[0].skippedDuplicate).toBe(true);
    expect(out.results[0].success).toBe(false);
    expect(out.results[0].discoveryMessage).toBe(dupMessage);
  });

  it("an await deadline returns an honest still-running failure with the status URL — no second start", async () => {
    const harness = makeHarness({ rowsSequence: [null], statusSequence: ["running", "running", "running", "running"] });
    const jobId = "screener:manual:TECH:2026-11-12T10:00:00.000Z";
    let now = 1_000_000;
    const out = await runStockScreenViaEngine(
      seamInput(harness, {
        spec: { source: "etrade", trigger: "manual", deliver: true, filters: {}, universe: "TECH", asyncRequested: false, delivery: {}, userLogin: "alice", jobId },
        nowMs: () => {
          now += 300_000;
          return now;
        },
        awaitDeadlineMs: 600_000,
        sleep: async () => {},
      }),
    );
    expect(harness.startCalls).toBe(1);
    expect(out.results[0].success).toBe(false);
    expect(out.results[0].error).toContain("did not complete within the engine await window");
    expect(out.results[0].error).toContain(`/api/jobs/history?chainId=${encodeURIComponent(jobId)}`);
  });

  it("a terminal workflow status without projection assembles after the grace polls", async () => {
    const harness = makeHarness({ rowsSequence: [null], statusSequence: ["complete", "complete", "complete"] });
    const jobId = "screener:manual:TECH:2026-11-12T10:00:00.000Z";
    const out = await runStockScreenViaEngine(
      seamInput(harness, {
        spec: { source: "etrade", trigger: "manual", deliver: true, filters: {}, universe: "TECH", asyncRequested: false, delivery: {}, userLogin: "alice", jobId },
      }),
    );
    expect(out.results[0].success).toBe(false);
    expect(out.results[0].error).toContain('ended with workflow status "complete"');
  });
});

describe("seam: shard aggregation (#4278)", () => {
  it("aggregates per-shard results into one ALL result: counts sum, rows concat, success iff any shard succeeded", () => {
    const shards = [
      cannedResult({ universe: "TECH", totalScanned: 10, matchedCount: 2, opportunities: [{ symbol: "AAPL" } as never], allStocks: [{ symbol: "AAPL" } as never] }),
      cannedResult({ universe: "SP500", success: false, error: "Yahoo unavailable", totalScanned: 0, matchedCount: 0, opportunities: [], allStocks: [] }),
    ];
    const agg = aggregateShardResults(shards, "ALL");
    expect(agg.universe).toBe("ALL");
    expect(agg.success).toBe(true);
    expect(agg.totalScanned).toBe(10);
    expect(agg.matchedCount).toBe(2);
    expect(agg.allStocks).toHaveLength(1);
    expect(agg.error).toBeUndefined();
  });

  it("an all-failed aggregation is a failure naming the first error", () => {
    const shards = [
      cannedResult({ universe: "TECH", success: false, error: "E*TRADE unavailable", totalScanned: 0, matchedCount: 0, opportunities: [], allStocks: [] }),
    ];
    const agg = aggregateShardResults(shards, "ALL");
    expect(agg.success).toBe(false);
    expect(agg.error).toBe("E*TRADE unavailable");
  });
});

/* ------------------------------------------------------------------ */
/* Site routing: each entry through the seam, contract preserved.      */
/* ------------------------------------------------------------------ */

import { executeEtradeScreen } from "../src/agents/routes/etradeBrokerScreen";
import { handleMarketDataCompareScreenRoutes } from "../src/agents/routes/marketDataResearch";
import { nlqStockScreenPort } from "../src/agents/orchestrator/nlqPorts";
import { dispatchScreenerA2A } from "../src/agents/screenerA2aDispatch";

function seamFake(outcome: EngineScreenRunOutcome | Error) {
  return async (input: unknown) => {
    (seamFake as unknown as { calls: unknown[] }).calls.push(input);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
}
(seamFake as unknown as { calls: unknown[] }).calls = [];
function seamCalls() {
  return (seamFake as unknown as { calls: unknown[] }).calls as Array<Record<string, unknown>>;
}

const throwingAgent = {
  runScreen: async () => {
    throw new Error("direct agent.runScreen must not run on a routed entry");
  },
  runSharded: async () => {
    throw new Error("direct agent.runSharded must not run on a routed entry");
  },
} as never;

function etradeCtx(seam: unknown) {
  const persisted: unknown[] = [];
  const bridged: unknown[] = [];
  const audits: string[] = [];
  return {
    persisted,
    bridged,
    audits,
    ctx: {
      env: {},
      readSettingRaw: () => null,
      audit: (type: string) => {
        audits.push(type);
      },
      persistScreenerReportCanonical: async (r: unknown) => {
        persisted.push(r);
      },
      scheduleScreenerFollowups: async (o: unknown) => {
        bridged.push(o);
      },
      runStockScreenViaEngine: seam,
    } as never,
  };
}

describe("site: etrade broker screen (#4278)", () => {
  it("sync single routes through the seam and returns the identical shape — no agent call, no re-persist/deliver on success", async () => {
    (seamFake as unknown as { calls: unknown[] }).calls = [];
    const result = cannedResult();
    const { persisted, bridged, audits, ctx } = etradeCtx(
      seamFake({ results: [result], collation: collationFor("job-1", [{ shardId: "TECH", pdfKey: "pdf-1" }]), jobId: "job-1", workflowId: "wf-1" }),
    );
    const res = await executeEtradeScreen({
      ctx,
      sessionId: "s1",
      requestedEnv: "TEST",
      userLogin: "alice",
      agent: throwingAgent,
      universe: "TECH",
      validatedFilters: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.universe).toBe("TECH");
    expect(body.totalScanned).toBe(10);
    expect(body.matchedCount).toBe(2);
    expect(body.opportunities).toEqual([{ symbol: "AAPL" }]);
    expect(body.stocks).toEqual(result.allStocks);
    expect(body.discoveryMessage).toBe("2 matches");
    expect(body.pdfKey).toBe("pdf-1");
    expect(body.reportUrl).toBe("/api/screener/report.pdf?key=pdf-1");
    expect(audits).toContain("etrade.screened");
    // The workflow's store + deliver steps own the finished run;
    // the route must not persist/deliver it a second time.
    expect(persisted).toHaveLength(0);
    expect(bridged).toHaveLength(0);
    expect(seamCalls()).toHaveLength(1);
    expect((seamCalls()[0].spec as { universe: string }).universe).toBe("TECH");
  });

  it("sync ALL routes through the seam; only the failed shard re-persists/delivers", async () => {
    (seamFake as unknown as { calls: unknown[] }).calls = [];
    const ok = cannedResult({ universe: "TECH" });
    const failed = cannedResult({ universe: "SP500", success: false, error: "Yahoo unavailable", totalScanned: 0, matchedCount: 0, opportunities: [], allStocks: [] });
    const { persisted, bridged, ctx } = etradeCtx(
      seamFake({ results: [ok, failed], collation: collationFor("job-1", [{ shardId: "TECH" }, { shardId: "SP500", status: "failed", error: "Yahoo unavailable" }]), jobId: "job-1", workflowId: "wf-1" }),
    );
    const res = await executeEtradeScreen({
      ctx,
      sessionId: "s1",
      requestedEnv: "TEST",
      userLogin: "alice",
      agent: throwingAgent,
      universe: "ALL",
      validatedFilters: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sharded).toBe(true);
    expect((body.universes as Array<{ universe: string }>).map((u) => u.universe)).toEqual(["TECH", "SP500"]);
    // Only the failed shard (never stored by the workflow) goes
    // through the route's persist-then-deliver finalizer.
    expect(persisted).toHaveLength(1);
    expect((persisted[0] as { universe: string }).universe).toBe("SP500");
    expect(bridged).toHaveLength(1);
  });

  it("a failed single result persists/delivers and answers 502", async () => {
    const failed = cannedResult({ success: false, error: "E*TRADE unavailable", totalScanned: 0, matchedCount: 0, opportunities: [], allStocks: [] });
    const { persisted, bridged, ctx } = etradeCtx(
      seamFake({ results: [failed], collation: collationFor("job-1", [{ shardId: "TECH", status: "failed", error: "E*TRADE unavailable" }]), jobId: "job-1", workflowId: "wf-1" }),
    );
    const res = await executeEtradeScreen({
      ctx,
      sessionId: "s1",
      requestedEnv: "TEST",
      userLogin: "alice",
      agent: throwingAgent,
      universe: "TECH",
      validatedFilters: {},
    });
    expect(res.status).toBe(502);
    expect(persisted).toHaveLength(1);
    expect(bridged).toHaveLength(1);
  });

  it("a seam already-running refusal answers 429 with the run id", async () => {
    const { ctx } = etradeCtx(
      seamFake(new ScreenAlreadyRunningError("alice", "TECH", 999_000, 1_000_000)),
    );
    const res = await executeEtradeScreen({
      ctx,
      sessionId: "s1",
      requestedEnv: "TEST",
      userLogin: "alice",
      agent: throwingAgent,
      universe: "TECH",
      validatedFilters: {},
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Screen already running");
    expect(body.retryable).toBe(true);
    expect(body.runId).toBe("screen:alice:TECH:999000");
    expect(body.status).toBe("running");
  });

  it("a seam quota refusal answers 429 with limit, usage, and reset", async () => {
    const { ctx } = etradeCtx(
      seamFake(
        new UserRequestQuotaExceededError({
          window: "daily",
          limit: 10,
          usage: 10,
          resetAtMs: Date.parse("2026-11-13T00:00:00.000Z"),
          runId: "job-1:TECH",
        }),
      ),
    );
    const res = await executeEtradeScreen({
      ctx,
      sessionId: "s1",
      requestedEnv: "TEST",
      userLogin: "alice",
      agent: throwingAgent,
      universe: "TECH",
      validatedFilters: {},
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Request quota exceeded");
    expect(body.limit).toBe(10);
    expect(body.usage).toBe(10);
    expect(body.resetAt).toBe("2026-11-13T00:00:00.000Z");
  });
});

describe("site: market-data research screen (#4278)", () => {
  function marketCtx(seam: unknown) {
    const persisted: unknown[] = [];
    const audits: string[] = [];
    return {
      persisted,
      audits,
      ctx: {
        env: {},
        audit: (type: string) => {
          audits.push(type);
        },
        getScreenerAgent: () => throwingAgent,
        persistScreenerReportCanonical: async (r: unknown) => {
          persisted.push(r);
        },
        runStockScreenViaEngine: seam,
      } as never,
    };
  }

  it("sync single routes through the seam — identical shape, no re-persist on success", async () => {
    const result = cannedResult({ provider: "yahoo" });
    const { persisted, audits, ctx } = marketCtx(
      seamFake({ results: [result], collation: collationFor("job-1", [{ shardId: "TECH", pdfKey: "pdf-1" }]), jobId: "job-1", workflowId: "wf-1" }),
    );
    const url = new URL("https://x/market-data/screen?universe=TECH");
    const req = new Request(url, { headers: { "x-user-login": "alice" } });
    const res = await handleMarketDataCompareScreenRoutes(req, url, "/market-data/screen", "s1", ctx);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.provider).toBe("yahoo");
    expect(body.totalScanned).toBe(10);
    expect(body.stocks).toEqual(result.allStocks);
    expect(audits).toContain("market_data.screener.executed");
    expect(persisted).toHaveLength(0);
  });

  it("a failed single result persists and answers 502", async () => {
    const failed = cannedResult({ provider: "yahoo", success: false, error: "Yahoo Finance unavailable", totalScanned: 0, matchedCount: 0, opportunities: [], allStocks: [] });
    const { persisted, ctx } = marketCtx(
      seamFake({ results: [failed], collation: collationFor("job-1", [{ shardId: "TECH", status: "failed", error: "Yahoo Finance unavailable" }]), jobId: "job-1", workflowId: "wf-1" }),
    );
    const url = new URL("https://x/market-data/screen?universe=TECH");
    const req = new Request(url, { headers: { "x-user-login": "alice" } });
    const res = await handleMarketDataCompareScreenRoutes(req, url, "/market-data/screen", "s1", ctx);
    expect(res?.status).toBe(502);
    expect(persisted).toHaveLength(1);
  });

  it("a seam already-running refusal answers 429 with the run id", async () => {
    const { ctx } = marketCtx(seamFake(new ScreenAlreadyRunningError("alice", "TECH", 999_000, 1_000_000)));
    const url = new URL("https://x/market-data/screen?universe=TECH");
    const req = new Request(url, { headers: { "x-user-login": "alice" } });
    const res = await handleMarketDataCompareScreenRoutes(req, url, "/market-data/screen", "s1", ctx);
    expect(res?.status).toBe(429);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.runId).toBe("screen:alice:TECH:999000");
  });
});

describe("site: NLQ stock-screen port (#4278)", () => {
  function portCtx(overrides: Record<string, unknown> = {}) {
    return {
      schedule: async () => ({}),
      scheduleEvery: async () => ({}),
      cancelSchedule: async () => true,
      listSchedules: async () => [],
      getScreenerAgent: () => throwingAgent,
      getSocialBriefStore: () => null,
      env: {},
      ensureTables: () => {
        throw new Error("unused");
      },
      monetizationOn: async () => false,
      ...overrides,
    } as never;
  }

  it("with no workflow binding the port refuses coded — no direct agent fallback", async () => {
    const port = nlqStockScreenPort(portCtx({ workflowPort: null }));
    await expect(port.runScreen({ filters: { minPrice: 10 }, userLogin: "alice" })).rejects.toThrow(
      /workflow/i,
    );
  });

  it("a workflow start failure refuses coded — no direct agent fallback", async () => {
    const port = nlqStockScreenPort(
      portCtx({
        workflowPort: {
          start: async () => {
            throw new Error("binding create failed");
          },
          status: async () => null,
        },
      }),
    );
    await expect(port.runScreen({ filters: { minPrice: 10 }, userLogin: "alice" })).rejects.toThrow(
      /workflow start failed/i,
    );
  });
});

describe("site: A2A screener.run_screen (#4278)", () => {
  function a2aExecutor() {
    return {
      runScreen: async () => {
        throw new Error("direct executor.runScreen must not run on a routed entry");
      },
      runGoalScreen: async () => {
        throw new Error("unused");
      },
      getLatest: async () => null,
      getHistory: async () => [],
      listScreenerTasks: async () => [],
      isScreenRunning: async () => ({ running: false, startedAt: null, runId: null, status: "idle" as const }),
      chargeScreenQuota: async () => {},
    };
  }

  it("run_screen routes through the seam and returns the engine result", async () => {
    const result = cannedResult();
    const out = await dispatchScreenerA2A(
      { SERVICE_USER_LOGIN: "svc" } as never,
      { operation: "screener.run_screen", universe: "TECH", filters: { minPrice: 10 } },
      {
        executor: a2aExecutor() as never,
        runStockScreenViaEngine: seamFake({
          results: [result],
          collation: collationFor("job-1", [{ shardId: "TECH", pdfKey: "pdf-1" }]),
          jobId: "job-1",
          workflowId: "wf-1",
        }) as never,
      },
    );
    expect(out.ok).toBe(true);
    expect((out.result as { universe: string }).universe).toBe("TECH");
    expect((out.result as { totalScanned: number }).totalScanned).toBe(10);
    expect((out.result as { pdfKey: string }).pdfKey).toBe("pdf-1");
  });

  it("run_screen with universe ALL aggregates the shards into one result", async () => {
    const shards = [
      cannedResult({ universe: "TECH", totalScanned: 10, matchedCount: 2 }),
      cannedResult({ universe: "SP500", totalScanned: 5, matchedCount: 1 }),
    ];
    const out = await dispatchScreenerA2A(
      { SERVICE_USER_LOGIN: "svc" } as never,
      { operation: "screener.run_screen", universe: "ALL", filters: {} },
      {
        executor: a2aExecutor() as never,
        runStockScreenViaEngine: seamFake({
          results: shards,
          collation: collationFor("job-1", [{ shardId: "TECH" }, { shardId: "SP500" }]),
          jobId: "job-1",
          workflowId: "wf-1",
        }) as never,
      },
    );
    expect(out.ok).toBe(true);
    expect((out.result as { universe: string }).universe).toBe("ALL");
    expect((out.result as { totalScanned: number }).totalScanned).toBe(15);
    expect((out.result as { matchedCount: number }).matchedCount).toBe(3);
  });

  it("a seam already-running refusal surfaces as an honest A2A failure naming the run", async () => {
    const out = await dispatchScreenerA2A(
      { SERVICE_USER_LOGIN: "svc" } as never,
      { operation: "screener.run_screen", universe: "TECH" },
      {
        executor: a2aExecutor() as never,
        runStockScreenViaEngine: seamFake(
          new ScreenAlreadyRunningError("svc", "TECH", 999_000, 1_000_000),
        ) as never,
      },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("already running");
    expect(out.error).toContain("screen:svc:TECH:999000");
  });
});

describe("allow list: no direct runScreen/runSharded remains in routed files (#4278)", () => {
  it("the routed production files contain no direct agent call", () => {
    const routed = [
      "agents/routes/etradeBrokerScreen.ts",
      "agents/routes/marketDataResearch.ts",
      "agents/routes/premium.ts",
      "agents/orchestrator/nlqPorts.ts",
      "services/scheduledTasks.ts",
      "agents/screenerA2aDispatch.ts",
    ];
    for (const file of routed) {
      const text = readFileSync(join("src", file), "utf8");
      expect(text).not.toMatch(/\.runScreen\(/);
      expect(text).not.toMatch(/\.runSharded\(/);
    }
  });

  it("the documented seams keep the call, each with its role named", () => {
    const seams: Array<[string, string]> = [
      ["workflows/inMemoryWorkflowAdapter.ts", "in-memory/test seam"],
      ["workflows/screenerWorkflowFlow.deprecated.ts", "retired flow internals"],
      ["agents/screener-agent.ts", "agent internals"],
    ];
    for (const [file] of seams) {
      const text = readFileSync(join("src", file), "utf8");
      expect(text).toMatch(/\.runScreen\(/);
    }
    // NLQ execution calls the PORT, not the agent.
    expect(readFileSync(join("src", "agents/nlq/execution.ts"), "utf8")).toMatch(
      /stockScreenPort\.runScreen\(/,
    );
    expect(readFileSync(join("src", "agents/nlq/execution.ts"), "utf8")).not.toMatch(
      /agent\.runScreen\(/,
    );
  });

  it("the seam module itself starts workflows, never the agent", () => {
    const text = readFileSync(join("src", "workflows/runStockScreenViaEngine.ts"), "utf8");
    expect(text).not.toMatch(/\.runScreen\(/);
    expect(text).not.toMatch(/\.runSharded\(/);
    expect(text).toContain("createWorkflowPorts");
    expect(text).toContain("buildStockScreenWorkflowCommand");
  });
});
