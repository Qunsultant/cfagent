// @vitest-environment node
/**
 * Issue #4780 — the options sharded chain through the one engine.
 *
 * Pins:
 *  - 4780-P01 no second chain-start path remains: scheduledTasks.ts
 *    carries no shardSubmit port, no planOptionsFeedShards call, and
 *    no planFeedStart call; shardJobs.ts exports no
 *    planOptionsFeedShards.
 *  - 4780-P02 the chain start calls startOptionsChainWorkflow (the
 *    engine seam), not a bespoke submit.
 *  - 4780-P03 the chain job definition is one nested chain — feed →
 *    assemble → generate → store → serve → deliver — with job id
 *    `options-chain:<chainId>`, the feed node sharded by symbol.
 *  - 4780-P04 a feed unit whose chain source cannot be resolved is a
 *    per-symbol FAILED outcome, never a throw (the assemble step
 *    partitions on it).
 *  - 4780-P05 a generate/store unit that cannot produce its format is
 *    a per-format FAILED outcome, never a throw (options #2599 F2/F4).
 *  - 4780-P06 the serve step assembles the run's outcome from the
 *    store units' outputs and verifies every generated format's blob
 *    reads back; the deliver step hands it to the delivery door with
 *    the `workflow:<jobId>` delivery id.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildOptionsChainJobDefinition,
  optionsChainJobId,
  OPTIONS_CHAIN_FORMATS,
} from "../src/services/optionsChainJobDefinition";
import {
  createOptionsChainStepRegistry,
  type OptionsChainStepDeps,
} from "../src/services/optionsChainPipelineJobs";
import type { ShardChainContext } from "../src/types";
import type { JobStepContext } from "../src/services/jobPipelineSteps";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", "src", rel), "utf8");

function chain(over: Partial<ShardChainContext> = {}): ShardChainContext {
  return {
    chainId: "chain-4780",
    universe: "symbols",
    userLogin: "tester",
    brokerId: "alpaca",
    mode: "paper",
    modeSource: "selection",
    trigger: "scheduled",
    timestamp: "2026-11-17T12:00:00.000Z",
    channels: [],
    options: {
      symbols: ["AAPL", "MSFT"],
      thesis: "bullish",
      targetDate: "2026-12-17",
      riskProfile: "balanced",
      eventCalendarBySymbol: { AAPL: {}, MSFT: {} },
    },
    ...over,
  };
}

function stepCtx(over: Partial<JobStepContext> = {}): JobStepContext {
  return {
    jobId: optionsChainJobId("chain-4780"),
    runId: "chain-4780",
    nodePath: "",
    kind: "options-chain.feed",
    stepIndex: 0,
    item: null,
    itemIndex: null,
    items: [],
    shardKey: null,
    params: { chain: chain() },
    input: undefined,
    now: "2026-11-17T12:00:00.000Z",
    ...over,
  };
}

function fakeDeps(over: Partial<OptionsChainStepDeps> = {}): OptionsChainStepDeps {
  return {
    env: {} as never,
    engineStores: undefined as never,
    queue: null,
    chainSourceFor: () => undefined,
    blobPut: vi.fn(async () => undefined),
    blobGet: vi.fn(async () => undefined),
    storeReport: vi.fn(async () => ({ reportId: "rep-1", created: true, fanout: "pending" })),
    deliverOutcome: vi.fn(async () => undefined),
    optionsRunStorage: undefined,
    ...over,
  };
}

function dataset(): Record<string, unknown> {
  return {
    scanned: 2,
    withTrades: 1,
    opportunities: [],
    skipped: [],
    truncatedSymbols: 0,
    assumptions: [],
    matrix: [
      {
        symbol: "AAPL",
        verdict: "pass",
        targetPrice: 205,
        targetSource: "analyst",
        targetEmUnits: 0.8,
        gateBucket: "fit",
        gateReasons: [],
        cells: [],
      },
    ],
    typeRollup: [],
    mode: "strategy_fit",
    fits: [],
    fitsTotal: 0,
    gate: { fit: 1, borderline: 0, noFit: 0 },
    borderline: [],
    gateParams: {},
    profileRef: null,
    coverage: { considered: 2, evaluated: 1, skipped: 1 },
  };
}

describe("options sharded chain on the one engine (#4780)", () => {
  it("P01: no second chain-start path remains in the scheduled service", () => {
    const scheduled = src("services/scheduledTasks.ts");
    expect(scheduled).not.toContain("shardSubmit");
    expect(scheduled).not.toContain("planOptionsFeedShards");
    expect(scheduled).not.toContain("planFeedStart");
    expect(scheduled).not.toContain("applyShardPacing");
    const shardJobs = src("services/shardJobs.ts");
    expect(shardJobs).not.toContain("export function planOptionsFeedShards");
    expect(shardJobs).not.toContain("export function applyShardPacing");
    // planFeedStart stays: its only caller is the frozen deprecated
    // module, which must keep working as the record (#4776 owns its
    // removal). The pin below is the live-caller rule.
    expect(shardJobs).toContain("export function planFeedStart");
    expect(scheduled).not.toContain("submitShardJob");
  });

  it("P02: the chain start calls the engine seam", () => {
    const scheduled = src("services/scheduledTasks.ts");
    expect(scheduled).toContain("startOptionsChainWorkflow");
    expect(scheduled).toContain("this.startOptionsChainWorkflow ?? startOptionsChainWorkflowSeam");
  });

  it("P03: the chain job is one nested chain, feed sharded by symbol", () => {
    const definition = buildOptionsChainJobDefinition(chain()) as {
      jobId: string;
      name: string;
      kind: string;
      root: {
        kind: string;
        steps: Array<{ step: string; params: { chain: ShardChainContext } }>;
        processing?: { shards?: string[] };
        executionMode?: Record<string, unknown>;
        children?: Array<{ kind: string; steps: Array<{ step: string }>; processing?: { shards?: string[] }; executionMode?: Record<string, unknown>; children?: unknown[] }>;
      };
      chain: ShardChainContext;
    };
    expect(definition.jobId).toBe("options-chain:chain-4780");
    expect(definition.kind).toBe("options-chain");
    expect(definition.chain.chainId).toBe("chain-4780");
    const kinds: string[] = [];
    let node: { kind: string; children?: Array<{ kind: string; children?: unknown[] }> } | undefined =
      definition.root;
    while (node) {
      kinds.push(node.kind);
      node = node.children?.[0] as typeof node | undefined;
    }
    expect(kinds).toEqual([
      "options-chain.feed",
      "options-chain.assemble",
      "options-chain.generate",
      "options-chain.store",
      "options-chain.serve",
      "options-chain.deliver",
    ]);
    expect(definition.root.processing?.shards).toEqual(["AAPL", "MSFT"]);
    // The root node IS the feed node: its effective shape is
    // "sharded" when more than one symbol (the stock idiom —
    // screenerPipelineJobs.ts:436), so execNode fans the feed out
    // one unit per symbol.
    expect(definition.root.executionMode).toEqual({
      delivery: "async",
      concurrency: "sequential",
      pacing: "batch",
      shape: "sharded",
    });
    // The generate/store nodes shard by format.
    const generate = definition.root.children?.[0]?.children?.[0];
    expect(generate?.kind).toBe("options-chain.generate");
    expect(generate?.processing?.shards).toEqual([...OPTIONS_CHAIN_FORMATS]);
    const store = generate?.children?.[0];
    expect(store?.kind).toBe("options-chain.store");
    expect(store?.processing?.shards).toEqual([...OPTIONS_CHAIN_FORMATS]);
  });

  it("P03b: the definition refuses a chain with no symbols", () => {
    expect(() =>
      buildOptionsChainJobDefinition(chain({ options: { symbols: [], thesis: "bullish", targetDate: "2026-12-17", riskProfile: "balanced" } })),
    ).toThrow("at least one symbol");
  });

  it("P03c: a single-symbol chain is monolith at the root (one unit, no fan-out)", () => {
    const definition = buildOptionsChainJobDefinition(
      chain({ options: { symbols: ["AAPL"], thesis: "bullish", targetDate: "2026-12-17", riskProfile: "balanced" } }),
    ) as { root: { executionMode?: Record<string, unknown>; processing?: { shards?: string[] } } };
    expect(definition.root.processing?.shards).toEqual(["AAPL"]);
    expect(definition.root.executionMode?.shape).toBe("monolith");
  });

  it("P04: a feed unit with no resolvable chain source is a failed outcome, not a throw", async () => {
    const registry = createOptionsChainStepRegistry(fakeDeps());
    const handler = registry.resolve("options-chain.feed");
    const result = await handler(stepCtx({ kind: "options-chain.feed", shardKey: "AAPL" }));
    const output = result.output as { symbol: string; status: string; error?: string };
    expect(output.symbol).toBe("AAPL");
    expect(output.status).toBe("failed");
    expect(output.error).toContain("could not be resolved");
  });

  it("P05: a generate unit that cannot run its renderer is a failed outcome, not a throw", async () => {
    const registry = createOptionsChainStepRegistry(fakeDeps());
    const handler = registry.resolve("options-chain.generate");
    // The pdf leg delegates to the real report pipeline; with no
    // REPORT_ASSET_AGENT / REPORTS_BUCKET in env it fails — and the
    // unit records the failure per format instead of throwing.
    const result = await handler(
      stepCtx({
        kind: "options-chain.generate",
        shardKey: "pdf",
        input: dataset(),
      }),
    );
    const output = result.output as { format: string; status: string; error?: string };
    expect(output.format).toBe("pdf");
    expect(output.status).toBe("failed");
    expect(output.error).toBeTruthy();
  });

  it("P05b: a store unit for a failed generate is a failed outcome, never a row for missing bytes", async () => {
    const storeReport = vi.fn(async () => ({ reportId: "rep-1", created: true, fanout: "pending" }));
    const registry = createOptionsChainStepRegistry(fakeDeps({ storeReport }));
    const handler = registry.resolve("options-chain.store");
    const result = await handler(
      stepCtx({
        kind: "options-chain.store",
        shardKey: "pdf",
        input: {
          pdf: { format: "pdf", status: "failed", error: "renderer blew up", dataset: dataset() },
        },
      }),
    );
    const output = result.output as { format: string; status: string; error?: string };
    expect(output.format).toBe("pdf");
    expect(output.status).toBe("failed");
    expect(output.error).toContain("renderer blew up");
    expect(storeReport).not.toHaveBeenCalled();
  });

  it("P06: the serve step assembles the outcome and verifies the blobs; the deliver step uses the workflow delivery id", async () => {
    const blobGet = vi.fn(async (key: string) => ({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: key.endsWith(".pdf") ? "options.pdf" : "options.xlsx",
    }));
    const storeReport = vi.fn(async () => ({ reportId: "rep-1", created: true, fanout: "pending" }));
    const deliverOutcome = vi.fn(async () => undefined);
    const deps = fakeDeps({ blobGet, storeReport, deliverOutcome });
    const registry = createOptionsChainStepRegistry(deps);
    const ds = dataset();
    // Store units first: each carries its generate outcome through.
    const storeHandler = registry.resolve("options-chain.store");
    const stored: Record<string, unknown> = {};
    for (const format of ["pdf", "xlsx"] as const) {
      const key = `options:chain-4780.${format}`;
      const result = await storeHandler(
        stepCtx({
          kind: "options-chain.store",
          shardKey: format,
          input: {
            [format]: {
              format,
              status: "generated",
              key,
              fileName: `options.${format}`,
              dataset: ds,
            },
          },
        }),
      );
      stored[format] = result.output;
    }
    const serveHandler = registry.resolve("options-chain.serve");
    const served = await serveHandler(stepCtx({ kind: "options-chain.serve", input: stored }));
    const outcome = served.output as {
      generatedFormats: string[];
      artifacts: Record<string, { status: string; key?: string }>;
    };
    expect(outcome.generatedFormats).toEqual(expect.arrayContaining(["pdf", "xlsx"]));
    expect(outcome.artifacts.pdf.status).toBe("generated");
    expect(blobGet).toHaveBeenCalled();
    const deliverHandler = registry.resolve("options-chain.deliver");
    await deliverHandler(stepCtx({ kind: "options-chain.deliver", input: outcome as never }));
    expect(deliverOutcome).toHaveBeenCalledTimes(1);
    const [payload, userLogin, deliveryId, chainId] = deliverOutcome.mock.calls[0];
    expect((payload as { kind: string }).kind).toBe("options");
    expect(userLogin).toBe("tester");
    expect(deliveryId).toBe("workflow:options-chain:chain-4780");
    expect(chainId).toBe("chain-4780");
  });
});
