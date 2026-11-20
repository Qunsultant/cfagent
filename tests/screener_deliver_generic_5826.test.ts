// @vitest-environment node
/**
 * Issue #5826 (#4437 slice 5) — generic deliver carries screener
 * delivery (the orchestrator sink):
 *
 * - Parity: the same serve output through the bespoke
 *   `screener.deliver` step and through generic `deliver.apply`
 *   (screener mode) produces the same output and the same
 *   orchestrator-sink calls — same payload, same login, same
 *   `workflow:<jobId>` delivery id, same goal/delivery/stage-chain
 *   threading — for market and goal runs, monolith and sharded.
 * - The generic run's deliver stage IS the generic stage: the
 *   registry that runs it does not contain `screener.deliver` at
 *   all, and the run's definition names `deliver.apply`.
 * - The bespoke deliver rules carry over: a duplicate passes
 *   through untouched, `deliver: false` skips, a sink refusal is
 *   recorded (never a failed run), an unwired sink refuses by
 *   name, a missing userLogin refuses by name — and the screener
 *   mode never consults the channel path's stores.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { createPipelineStepRegistry } from "../src/services/enrichPipelineJobs";
import { buildFeedJobRegistry } from "../src/services/feedJobs";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import { buildDeliverJobRegistry } from "../src/services/deliverJobs";
import {
  DELIVER_APPLY_STEP,
  registerDeliverStep,
  type DeliverStepDeps,
} from "../src/services/deliverPipelineJobs";
import {
  buildScreenerJobDefinition,
  createScreenerStepRegistry,
  SCREENER_DELIVER_STEP,
  type ScreenerStepDeps,
} from "../src/services/screenerPipelineJobs";
import { ScreenerAgent } from "../src/agents/screener-agent";
import { JobStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";
import type { MarketDataResearchQuote } from "../src/types";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

class FakeStorage {
  map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

function listing(symbol: string) {
  return {
    symbol,
    companyName: `${symbol} Inc`,
    exchange: "NASDAQ" as const,
    change: 1,
    changePercent: 1,
  };
}

function marketCommand(over: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "screen-parity-5826",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "owner",
    role: "parent",
    shards: [
      { shardId: "s0", symbols: [listing("AAPL"), listing("MSFT"), listing("NVDA"), listing("AMZN")] },
    ],
    provider: "yahoo",
    deliver: true,
    ...over,
  };
}

function quote(symbol: string, price = 100): MarketDataResearchQuote {
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    price,
    lastPrice: price,
    change: 1,
    changePercent: 1,
    volume: 1_000_000,
    open: 99,
    high: 101,
    low: 98,
    previousClose: 99,
    timestamp: iso(T0),
  } as MarketDataResearchQuote;
}

function bars() {
  return [
    { timestamp: iso(T0 - 86_400_000), open: 99, high: 101, low: 98, close: 100, volume: 1_000_000 },
    { timestamp: iso(T0), open: 100, high: 102, low: 99, close: 101, volume: 1_100_000 },
  ];
}

/** One sink call: the exact args the orchestrator sink received. */
interface SinkCall {
  payload: unknown;
  userLogin: string;
  opts?: Record<string, unknown>;
}

function makeSink() {
  const calls: SinkCall[] = [];
  const sink: ScreenerStepDeps["deliverOutcome"] = async (payload, userLogin, opts) => {
    calls.push({ payload, userLogin, ...(opts ? { opts: opts as Record<string, unknown> } : {}) });
  };
  return { calls, sink };
}

/** The serve-stage output the deliver stage consumes (hand-built, realistic). */
function serveOutputFixture() {
  return {
    result: { success: true, totalScanned: 4, matchedCount: 2 },
    payload: {
      kind: "stock",
      trigger: "manual",
      success: true,
      pdfKeys: [],
      thesis: "parity fixture",
      matchedCount: 2,
      totalScanned: 4,
      allStocks: ["AAPL", "MSFT", "NVDA", "AMZN"].map((symbol) => ({ symbol })),
    },
    stored: true,
    reportId: "rep-5826",
    userLogin: "owner",
    servedReport: {
      reportId: "rep-5826",
      formats: [{ format: "pdf", key: "pdf-key", status: "generated" }],
      servedAt: iso(T0),
    },
  };
}

function stepCtx(over: Partial<JobStepContext> = {}): JobStepContext {
  return {
    jobId: "screen-parity-5826",
    runId: "run-1",
    nodePath: "0.0.0.0.0.0",
    kind: "deliver",
    stepIndex: 0,
    item: null,
    itemIndex: null,
    items: [],
    shardKey: null,
    params: { userLogin: "owner", deliver: true, screener: true },
    input: serveOutputFixture(),
    now: iso(T0),
    trigger: "manual",
    runKind: "original",
    ...over,
  };
}

/** Swap the deliver node of a screener definition onto generic deliver. */
function genericDeliverDefinition(command: WorkflowJobCommand): unknown {
  const raw = buildScreenerJobDefinition(command) as any;
  let node = raw.root;
  while (node.children?.[0]) node = node.children[0];
  expect(node.kind).toBe("deliver");
  node.steps[0].step = DELIVER_APPLY_STEP;
  node.steps[0].params = { ...node.steps[0].params, screener: true };
  return raw;
}

/** Per-run generated ids (run/task/trace ids, artifact keys) differ between two runs of the same screen; normalize them out before comparing sink calls. */
function normalizeSinkCall(call: SinkCall): unknown {
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return "<uuid>";
      if (/^stask-[0-9a-f-]{36}$/.test(value)) return "<taskId>";
      if (/^qt_[a-z0-9_]+$/.test(value)) return "<traceId>";
      if (/^screener:(csv|xlsx|pdf):[0-9a-f]+$/.test(value)) return "<artifactKey>";
      return value;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, replace(v)]),
      );
    }
    return value;
  };
  return replace(call);
}

function deliverNodeStep(definition: unknown): string {
  let node = (definition as any).root;
  while (node.children?.[0]) node = node.children[0];
  return node.steps[0].step as string;
}

interface ParityHarness {
  bespoke: { control: JobPipelineControl; runStore: InMemoryJobRunRecordStore; sink: SinkCall[] };
  generic: { control: JobPipelineControl; runStore: InMemoryJobRunRecordStore; sink: SinkCall[] };
}

async function makeParityHarness(): Promise<ParityHarness> {
  const storage = new FakeStorage();
  storage.map.set("screener:owner-login", "owner");
  const agent = new ScreenerAgent({ storage } as any, {} as any);
  const bespokeSink = makeSink();
  const genericSink = makeSink();
  const stored: unknown[] = [];
  const yahooCalls: string[] = [];
  const barsCalls: string[] = [];

  const screenerDeps: ScreenerStepDeps = {
    agentFor: () => agent as never,
    quoteDepsFor: () => ({
      yahoo: {
        fetchYahooQuote: async (symbol: string) => {
          yahooCalls.push(symbol);
          return quote(symbol);
        },
      },
    }),
    historyDepsFor: () => ({
      fetchBars: async (symbol: string) => {
        barsCalls.push(symbol);
        return bars();
      },
    }),
    storeReport: async (payload) => {
      stored.push(payload);
    },
    deliverOutcome: bespokeSink.sink,
  };

  const makeControl = (steps: JobStepRegistry) => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const messaging = new InMemoryMessagingAdapter();
    const ports: MessagingPorts = {
      producer: messaging,
      consumer: messaging,
      publisher: messaging,
      subscriber: messaging,
    };
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      publisher: ports.publisher,
      steps,
      now: () => new Date(T0),
    });
    return { control, runStore };
  };

  const bespoke = makeControl(createScreenerStepRegistry(screenerDeps));

  const deliverDeps: DeliverStepDeps = {
    registry: buildDeliverJobRegistry({}),
    generatedStore: null,
    deliveryStore: null,
    senders: {},
    screenerDeliverOutcome: genericSink.sink,
  };
  const genericSteps = createPipelineStepRegistry(
    {
      registry: buildFeedJobRegistry({}),
      providerFor: () => undefined,
      universeStore: null,
      datasetStore: null,
    },
    { registry: buildEnrichJobRegistry({}), datasetStore: null, enrichedStore: null },
    undefined,
    undefined,
    deliverDeps,
    screenerDeps,
  );
  const generic = makeControl(genericSteps);
  return { bespoke: { ...bespoke, sink: bespokeSink.calls }, generic: { ...generic, sink: genericSink.calls } };
}

describe("generic deliver carries screener delivery (#5826)", () => {
  it("market parity, full chain: same sink calls through deliver.apply as through screener.deliver", async () => {
    const h = await makeParityHarness();
    const command = marketCommand();
    await h.bespoke.control.defineJob(buildScreenerJobDefinition(command));
    await h.generic.control.defineJob(genericDeliverDefinition(command));

    // The generic registry does not contain the bespoke step at
    // all — the delivery below can only have come through
    // deliver.apply. The definitions name the two steps.
    const bespokeStatus = await h.bespoke.control.getJob(command.jobId);
    const genericStatus = await h.generic.control.getJob(command.jobId);
    expect(deliverNodeStep(bespokeStatus.definition)).toBe(SCREENER_DELIVER_STEP);
    expect(deliverNodeStep(genericStatus.definition)).toBe(DELIVER_APPLY_STEP);

    const bespokeRun = await h.bespoke.control.runJob(command.jobId);
    const genericRun = await h.generic.control.runJob(command.jobId);
    expect((await bespokeRun.completion!).state).toBe("completed");
    expect((await genericRun.completion!).state).toBe("completed");

    expect(h.generic.sink).toHaveLength(1);
    expect(h.bespoke.sink).toHaveLength(1);
    // The two runs differ only in per-run generated ids (run/task/
    // trace ids, artifact keys); the delivered outcome is the same.
    expect(normalizeSinkCall(h.generic.sink[0]!)).toEqual(
      normalizeSinkCall(h.bespoke.sink[0]!),
    );
    expect(h.generic.sink[0]?.userLogin).toBe("owner");
    expect(h.generic.sink[0]?.opts?.deliveryId).toBe(`workflow:${command.jobId}`);
  });

  it("step parity, market: same output and same sink args", async () => {
    // The bespoke side runs through the real agent stage; the
    // generic side through deliver.apply with the same sink.
    const bespokeSink = makeSink();
    const genericSink = makeSink();
    const bespokeRegistry = createScreenerStepRegistry({
      agentFor: () => new ScreenerAgent({ storage: new FakeStorage() } as any, {} as any) as never,
      storeReport: async () => {},
      deliverOutcome: bespokeSink.sink,
    });
    const genericRegistry = new JobStepRegistry();
    registerDeliverStep(genericRegistry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: genericSink.sink,
    });
    const bespokeHandler = bespokeRegistry.resolve(SCREENER_DELIVER_STEP);
    const genericHandler = genericRegistry.resolve(DELIVER_APPLY_STEP);

    const bespokeOut = await bespokeHandler(stepCtx());
    const genericOut = await genericHandler(stepCtx());
    // The outcome (the deliver output) is identical; the generic
    // result additionally carries the step descriptor.
    expect(genericOut.output).toEqual(bespokeOut.output);
    expect(genericSink.calls).toHaveLength(1);
    expect(genericSink.calls[0]).toEqual(bespokeSink.calls[0]);
  });

  it("step parity, goal: the goal branch threads goalScreen + canonicalReportId through both", async () => {
    const goalScreen = {
      scenario: { goalKind: "growth", direction: "long" },
      scenarioSource: "built",
      symbols: ["AAPL"],
    };
    const bespokeSink = makeSink();
    const genericSink = makeSink();
    const bespokeRegistry = createScreenerStepRegistry({
      agentFor: () => new ScreenerAgent({ storage: new FakeStorage() } as any, {} as any) as never,
      storeReport: async () => {},
      deliverOutcome: bespokeSink.sink,
    });
    const genericRegistry = new JobStepRegistry();
    registerDeliverStep(genericRegistry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: genericSink.sink,
    });
    const ctx = stepCtx({ params: { userLogin: "owner", deliver: true, goalScreen, screener: true } });
    const bespokeOut = await bespokeRegistry.resolve(SCREENER_DELIVER_STEP)(stepCtx({ params: { userLogin: "owner", deliver: true, goalScreen } }));
    const genericOut = await genericRegistry.resolve(DELIVER_APPLY_STEP)(ctx);
    expect(genericOut.output).toEqual(bespokeOut.output);
    expect(genericSink.calls[0]?.opts?.goalScreen).toEqual(goalScreen);
    expect(genericSink.calls[0]?.opts?.goalScreen).toEqual(bespokeSink.calls[0]?.opts?.goalScreen);
    expect(genericSink.calls[0]?.opts?.canonicalReportId).toBe("rep-5826");
    expect(genericSink.calls[0]?.opts?.canonicalReportId).toBe(
      bespokeSink.calls[0]?.opts?.canonicalReportId,
    );
  });

  it("deliver: false skips without calling the sink", async () => {
    const { calls, sink } = makeSink();
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: sink,
    });
    const out = await registry
      .resolve(DELIVER_APPLY_STEP)
      (stepCtx({ params: { userLogin: "owner", deliver: false, screener: true } }));
    expect((out.output as any)?.delivered).toBe(false);
    expect((out.output as any)?.deliverSkipped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("a scheduled duplicate passes through untouched, sink never called", async () => {
    const { calls, sink } = makeSink();
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: sink,
    });
    const dup = { ...serveOutputFixture(), duplicate: true };
    const out = await registry
      .resolve(DELIVER_APPLY_STEP)
      (stepCtx({ params: { userLogin: "owner", deliver: true, screener: true }, input: dup }));
    expect((out.output as any)?.delivered).toBe(false);
    expect((out.output as any)?.deliverSkipped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("a sharded unit reads its own shard's serve output from the per-shard map", async () => {
    const { calls, sink } = makeSink();
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: sink,
    });
    const map = { s0: serveOutputFixture(), s1: { ...serveOutputFixture(), reportId: "rep-other" } };
    const out = await registry.resolve(DELIVER_APPLY_STEP)(
      stepCtx({
        shardKey: "s0",
        params: { userLogin: "owner", deliver: true, screener: true },
        input: map,
      }),
    );
    expect((out.output as any)?.delivered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts?.canonicalReportId).toBe("rep-5826");
  });

  it("a sink refusal is recorded, never a failed run", async () => {
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: async () => {
        throw new Error("delivery down");
      },
    });
    const out = await registry
      .resolve(DELIVER_APPLY_STEP)
      (stepCtx({ params: { userLogin: "owner", deliver: true, screener: true } }));
    expect((out.output as any)?.delivered).toBe(false);
    expect((out.output as any)?.deliverError).toContain("delivery down");
  });

  it("an unwired sink refuses by name", async () => {
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
    });
    await expect(
      registry.resolve(DELIVER_APPLY_STEP)(
        stepCtx({ params: { userLogin: "owner", deliver: true, screener: true } }),
      ),
    ).rejects.toThrow(/DELIVER_SCREENER_SINK_NOT_CONFIGURED/);
  });

  it("a missing userLogin refuses by name, like the bespoke step", async () => {
    const { sink } = makeSink();
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: sink,
    });
    await expect(
      registry.resolve(DELIVER_APPLY_STEP)(
        stepCtx({ params: { deliver: true, screener: true } }),
      ),
    ).rejects.toThrow(/SCREENER_STEP_NO_USER/);
  });

  it("without the screener marker the step still resolves a deliver job (channel path unchanged)", async () => {
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
    });
    await expect(
      registry.resolve(DELIVER_APPLY_STEP)(
        stepCtx({ params: { deliverJobId: "no-such-job" } }),
      ),
    ).rejects.toThrow(/DELIVER_JOB_NOT_FOUND/);
  });
});
