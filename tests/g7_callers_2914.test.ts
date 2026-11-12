/**
 * Issue #2914 (G7) — must-fix private/direct callers.
 *
 * Pins (grep/source level — a new direct caller in a new
 * file fails, it does not slip past a behavior test):
 *  - NLQ + mesh parent commands come from the broker's one
 *    command builder: nlqPorts.ts and meshScreenDoor.ts
 *    contain no `type: "run-screen"` literal any more.
 *  - The NLQ direct fallback goes through spec + broker +
 *    planner: nlqPorts.ts consults startStockScreenWorkflowOrNull
 *    before its sync run (broker null = the sync branch, per
 *    the broker's own contract — asyncRequested false -> null,
 *    caller runs sync).
 *  - Scheduled sharded starts through the broker: the broker
 *    owns the chain start (planFeedStart + shardSubmit), so
 *    scheduledTasks.ts contains no planFeedStart. The literal
 *    workflow-start migration is NOT claimed here: the chain
 *    is the stage pipeline (stageChain has no workflow
 *    equivalent) and the chain run model (chain_id) is read
 *    by workflowRuns — see the broker header note.
 *  - Direct ScreenerAgent.runScreen lives only in the
 *    allow-listed files, each with its role named (broker
 *    sync branch, broker-consulted fallback, workflow runner
 *    seam, agent internals, paid-fulfillment sync exception).
 *  - persistRun is delivery cache, not a recorder: its body
 *    writes LATEST/HISTORY + artifact keys and no canonical
 *    row; the capability inventory names the cache entry.
 *  - Goal execution stays goal-owned by dated decision
 *    (2026-11-03, recorded in the inventory entry): the
 *    goal engine screens thesis legs internally, goal
 *    reports + delivery are goal-owned surfaces, and the
 *    broker guard (null for goal specs) is the routing
 *    decision, not a gap.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildParentScreenCommand,
  shardsForUniverse,
  startScheduledShardedChain,
  startStockScreenWorkflowOrNull,
} from "../src/workflows/screenExecutionBroker";
import { nlqStockScreenPort } from "../src/agents/orchestrator/nlqPorts";

const read = (p: string) => readFileSync(join("src", p), "utf8");

describe("one parent command builder (#2914)", () => {
  it("builds the broker's REST command shape exactly (deliver/provider/refs ride, absent stays absent)", () => {
    const command = buildParentScreenCommand({
      jobId: "screener:manual:NASDAQ100:2026-11-03T12:00:00.000Z",
      source: "manual",
      trigger: "manual",
      userLogin: "alice",
      tenantId: "tenant-1",
      shards: [{ shardId: "NASDAQ100", universe: "NASDAQ100" }],
      filters: { minPrice: 10 },
      deliver: false,
      provider: "yahoo",
    });
    expect(command).toEqual({
      jobId: "screener:manual:NASDAQ100:2026-11-03T12:00:00.000Z",
      type: "run-screen",
      source: "manual",
      trigger: "manual",
      userLogin: "alice",
      role: "parent",
      tenantId: "tenant-1",
      shards: [{ shardId: "NASDAQ100", universe: "NASDAQ100" }],
      filters: { minPrice: 10 },
      deliver: false,
      provider: "yahoo",
    });
  });

  it("carries NLQ extras (specTrigger, maxItems, pollIntervalMs, traceparent) and mesh extras (screenMode/intent)", () => {
    const nlq = buildParentScreenCommand({
      jobId: "screener:chat:TECH:2026-11-03T12:00:00.000Z:abcd1234",
      source: "nlq-chat",
      trigger: "manual",
      specTrigger: "nlq",
      userLogin: "alice",
      tenantId: "tenant-1",
      shards: shardsForUniverse("TECH"),
      filters: { minPrice: 5 },
      maxItems: 10,
      pollIntervalMs: 5000,
      traceparent: "00-abc-def-01",
    });
    expect(nlq.source).toBe("nlq-chat");
    expect(nlq.specTrigger).toBe("nlq");
    expect(nlq.maxItems).toBe(10);
    expect(nlq.pollIntervalMs).toBe(5000);
    expect(nlq.traceparent).toBe("00-abc-def-01");
    expect("deliver" in nlq).toBe(false);
    const mesh = buildParentScreenCommand({
      jobId: "screener:chat:TECH:2026-11-03T12:00:00.000Z:abcd1234",
      source: "mesh-door",
      trigger: "manual",
      specTrigger: "mesh",
      userLogin: "alice",
      tenantId: "tenant-1",
      shards: shardsForUniverse("TECH"),
      filters: {},
      maxItems: 10,
      pollIntervalMs: 5000,
      screenMode: "non-deterministic",
      screenIntent: "find momentum leaders",
    });
    expect(mesh.source).toBe("mesh-door");
    expect(mesh.specTrigger).toBe("mesh");
    expect(mesh.screenMode).toBe("non-deterministic");
    expect(mesh.screenIntent).toBe("find momentum leaders");
  });

  it("the broker start sends exactly the builder's command (no drift between builder and start)", async () => {
    const starter = vi.fn(async (_env: unknown, _command: unknown) => ({
      workflowId: "wf-1",
      jobId: "screener:manual:TECH:2026-11-03T12:00:00.000Z",
      status: "running" as const,
      existing: false,
      statusUrl: "/status/wf-1",
    }));
    const spec = {
      source: "etrade" as const,
      trigger: "manual" as const,
      deliver: true,
      filters: { minPrice: 10 },
      universe: "TECH",
      asyncRequested: true,
      delivery: {},
      userLogin: "alice",
      environment: "TEST" as const,
      portfolioContext: true,
    };
    const result = await startStockScreenWorkflowOrNull({
      env: {} as never,
      spec,
      userLogin: "alice",
      environment: "TEST",
      portfolioContext: true,
      starter: starter as never,
    });
    expect(result).not.toBeNull();
    const sent = starter.mock.calls[0][1] as Record<string, unknown>;
    const built = buildParentScreenCommand({
      jobId: result!.jobId,
      source: "manual",
      trigger: "manual",
      specTrigger: "manual",
      userLogin: "alice",
      tenantId: sent["tenantId"] as string,
      shards: [{ shardId: "TECH", universe: "TECH" }],
      filters: { minPrice: 10 },
      deliver: true,
      environment: "TEST",
      portfolioContext: true,
    });
    expect(sent).toEqual(built);
  });
});

describe("scheduled sharded start through the broker (#2914)", () => {
  it("the broker's chain start submits the feed-start submission through the injected port", async () => {
    const submitted: unknown[] = [];
    const result = await startScheduledShardedChain({
      chain: {
        chainId: "chain-1",
        universe: "TECH",
        userLogin: "alice",
        trigger: "scheduled",
        timestamp: "2026-11-03T12:00:00.000Z",
        channels: ["slack"],
      },
      submit: async (s: unknown) => {
        submitted.push(s);
        return { jobId: "job-1" };
      },
    });
    expect(result.jobId).toBe("job-1");
    expect(submitted).toHaveLength(1);
    const sub = submitted[0] as { payload: { chain: { chainId: string; universe: string } } };
    expect(sub.payload.chain.chainId).toBe("chain-1");
    expect(sub.payload.chain.universe).toBe("TECH");
  });
});

describe("NLQ fallback via spec/broker/planner (#2914)", () => {
  it("with no workflow binding, the fallback still returns the sync run (planner universe, maxItems 10)", async () => {
    const agentCalls: Array<Record<string, unknown>> = [];
    const ctx = {
      schedule: async () => ({}),
      scheduleEvery: async () => ({}),
      cancelSchedule: async () => true,
      listSchedules: async () => [],
      getScreenerAgent: () => ({
        runScreen: async (req: Record<string, unknown>) => {
          agentCalls.push(req);
          return { success: true, universe: req["universe"], totalScanned: 5, matchedCount: 1, opportunities: [], allStocks: [] };
        },
      }),
      getSocialBriefStore: () => null,
      env: {},
      ensureTables: () => {
        throw new Error("unused");
      },
    } as never;
    const port = nlqStockScreenPort(ctx);
    const out = await port.runScreen({ filters: { minPrice: 10 }, userLogin: "alice" });
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]["universe"]).toBe("TECH");
    expect(agentCalls[0]["maxItems"]).toBe(10);
    expect((out as { success?: boolean }).success).toBe(true);
  });
});

describe("caller pins (#2914)", () => {
  it("NLQ + mesh build no parent command by hand", () => {
    for (const file of ["agents/orchestrator/nlqPorts.ts", "agents/orchestrator/meshScreenDoor.ts"]) {
      expect(read(file)).not.toContain('type: "run-screen"');
    }
  });

  it("the NLQ fallback consults the broker before its sync run", () => {
    expect(read("agents/orchestrator/nlqPorts.ts")).toContain("startStockScreenWorkflowOrNull");
  });

  it("scheduledTasks no longer starts the sharded chain by hand", () => {
    expect(read("services/scheduledTasks.ts")).not.toContain("planFeedStart");
  });

  it("direct ScreenerAgent.runScreen lives only in allow-listed files", () => {
    const allowed = new Map<string, string>([
      // Broker sync branch: broker returned null, caller runs sync.
      ["src/agents/routes/etradeBrokerScreen.ts", "REST sync after broker null"],
      ["src/agents/routes/marketDataResearch.ts", "market-data sync after broker null"],
      ["src/services/scheduledTasks.ts", "scheduled monolithic sync after broker null"],
      // Broker-consulted fallback: spec + broker + planner, then sync.
      ["src/agents/orchestrator/nlqPorts.ts", "NLQ fallback via spec/broker/planner"],
      // Paid fulfillment sync: async attempt first, sync on unbound — out of G7 scope (own jobId scheme, own tests), named here not silently passed.
      ["src/agents/routes/premium.ts", "paid fulfillment sync exception"],
      // The agent's own internals: definition, wiring, runSharded fan-out.
      ["src/agents/screener-agent.ts", "agent internals"],
      // Port calls, not agent calls: NLQ executor binds the port; A2A dispatches through an injected executor.
      ["src/agents/nlq/execution.ts", "port call (stockScreenPort)"],
      ["src/agents/screenerA2aDispatch.ts", "port call (injected executor)"],
      // Workflow execution seams: the adapter's canned steps
      // drive the injected runner (the test-only seam); the
      // retired flow stays listed while frozen.
      ["src/workflows/inMemoryWorkflowAdapter.ts", "workflow runner seam"],
      ["src/workflows/screenerWorkflowFlow.deprecated.ts", "workflow runner seam"],
    ]);
    const offenders: string[] = [];
    /** Issue #4247 — allow-list keys use "/", the walk yields "\" on Windows. */
    const posixPath = (p: string): string => p.split(/[\\/]/).join("/");
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(path, "utf8");
          if (/\.runScreen\(/.test(text) && !/runScreenInner/.test(text.split(".runScreen(")[0].slice(-40))) {
            // Count only genuine .runScreen( sites (runScreenInner excluded by name).
            const sites = (text.match(/(?<!Inner)\.runScreen\(/g) ?? []).length;
            const rel = posixPath(path);
            if (sites > 0 && !allowed.has(rel)) offenders.push(`${rel} (${sites})`);
          }
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });

  it("persistRun is delivery cache, not a recorder", () => {
    const text = read("agents/screener-agent.ts");
    const start = text.indexOf("private async persistRun");
    const end = text.indexOf("private async", start + 1);
    const body = text.slice(start, end === -1 ? undefined : end);
    expect(body).toContain("LATEST_KEY");
    expect(body).toContain("HISTORY_KEY");
    expect(body).not.toContain("mas_reports");
    expect(body).not.toContain("storeReportAtGeneration");
  });

  it("the capability inventory reconciles the cache and records the goal decision", () => {
    const inv = read("workflows/stockScreenCapability.ts");
    expect(inv).toContain("screener-delivery-cache");
    expect(inv).toContain("delivery cache (not a recorder)");
    expect(inv).toContain("2026-11-03");
    expect(inv).toContain("stays goal-owned");
    expect(inv).toContain("buildParentScreenCommand");
    expect(inv).toContain("Broker-owned chain start");
  });
});
