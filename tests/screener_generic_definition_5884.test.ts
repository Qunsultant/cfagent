// @vitest-environment node
/**
 * Issue #5884 (#4437 slice 6b3 — the flip): the screener
 * definition builds the five generic nodes, with the family
 * job ids computed per command — never a static spec literal
 * (a static literal would pin one provider for every run, a
 * broker substitution forbidden by #5517).
 *
 * - Five nodes, 1:1 with the v2 "screener" spec: feed
 *   `feed.pull`, enrich `enrich.screener`, analyze
 *   `analyze.screener`, generate `generate.apply`, deliver
 *   `deliver.apply` (flipped in 6c #5885; bespoke
 *   `screener.deliver` no longer rides the market
 *   definition).
 * - Job ids derive per command: provider =
 *   `command.provider ?? DEFAULT_TENANT_PROVIDERS.dataProviderId`
 *   (the #5517 default — since #5516 the externalized
 *   vocabulary block, currently alpaca); feed
 *   job `<provider>-nasdaq100-quotes`, validated against
 *   FEED_PIPELINE_CATALOG (an unknown provider refuses by
 *   name, never a guessed job); derived ids
 *   `<feed>-enrich` → `<feed>-enrich-analyze` →
 *   `<feed>-enrich-analyze-generate` (the chain lineage).
 * - Analyze carries `ruleSets: ["screen","factors"]` +
 *   `inputMode: "handOff"`; generate carries
 *   `reports: ["screener-report"]` (the spec's static
 *   per-node params). Shards ride every node.
 * - Goal commands still build the untouched "goalScreen"
 *   spec (3b #5873); the market definition carries no
 *   `goalScreen` param on any node — a goal param on a
 *   market definition is refused by construction, never
 *   silently dropped.
 */
import { describe, expect, it } from "vitest";
import { jobDefinitionSpec } from "../src/config/jobDefinitionCatalog";
import { FEED_PULL_STEP } from "../src/services/feedPipelineJobs";
import { ENRICH_SCREENER_STEP } from "../src/services/enrichPipelineJobs";
import { ANALYZE_SCREENER_STEP } from "../src/services/analyzePipelineJobs";
import { GENERATE_APPLY_STEP } from "../src/services/generatePipelineJobs";
import { DELIVER_APPLY_STEP } from "../src/services/deliverPipelineJobs";
import {
  buildScreenerJobDefinition,
  GOAL_COMPOSITION_STEPS,
} from "../src/services/screenerPipelineJobs";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";

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
    jobId: "screen-generic-5884",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "owner",
    role: "parent",
    shards: [
      { shardId: "s0", symbols: [listing("AAPL"), listing("MSFT"), listing("NVDA"), listing("AMZN")] },
    ],
    provider: "yahoo",
    deliver: false,
    ...over,
  };
}

function goalCommand(over: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return marketCommand({
    jobId: "goal-5884",
    shards: [{ shardId: "goal", symbols: [listing("AAPL")] }],
    goalScreen: {
      scenario: { goalKind: "growth", direction: "long" } as any,
      scenarioSource: "built",
      symbols: ["AAPL"],
    },
    ...over,
  });
}

interface NodeView {
  kind: string;
  step: string;
  steps: string[];
  params: Record<string, unknown>;
  shards: unknown;
}

function nodesOf(raw: unknown): NodeView[] {
  const out: NodeView[] = [];
  let node: any = (raw as any).root;
  while (node) {
    out.push({
      kind: node.kind,
      step: node.steps?.[0]?.step,
      steps: (node.steps ?? []).map((s: any) => s.step),
      params: node.steps?.[0]?.params ?? {},
      shards: node.processing?.shards,
    });
    node = node.children?.[0];
  }
  return out;
}

describe("generic definition builder (#5884)", () => {
  it("builds five generic nodes, 1:1 with the v2 screener spec", () => {
    const spec = jobDefinitionSpec("screener");
    expect(spec.version).toBe(2);
    const nodes = nodesOf(buildScreenerJobDefinition(marketCommand()));
    expect(nodes.map((n) => n.kind)).toEqual(["feed", "enrich", "analyze", "generate", "deliver"]);
    expect(nodes.map((n) => n.step)).toEqual([
      FEED_PULL_STEP,
      ENRICH_SCREENER_STEP,
      ANALYZE_SCREENER_STEP,
      GENERATE_APPLY_STEP,
      // Issue #5885 (6c): the deliver node is flipped onto
      // generic deliver.apply — the bespoke screener.deliver
      // step no longer rides the market definition.
      DELIVER_APPLY_STEP,
    ]);
    expect(nodes.map((n) => n.kind)).toEqual(spec.stages.map((s) => s.kind));
    expect(nodes.map((n) => n.step)).toEqual(spec.stages.map((s) => s.step));
  });

  it("injects the per-command family job ids (default provider alpaca)", () => {
    const nodes = nodesOf(
      buildScreenerJobDefinition(marketCommand({ provider: undefined })),
    );
    const byKind = new Map(nodes.map((n) => [n.kind, n.params]));
    expect(byKind.get("feed")).toEqual(expect.objectContaining({ feedJobId: "alpaca-nasdaq100-quotes" }));
    expect(byKind.get("enrich")).toEqual(
      expect.objectContaining({ enrichJobId: "alpaca-nasdaq100-quotes-enrich" }),
    );
    expect(byKind.get("analyze")).toEqual(
      expect.objectContaining({
        analyzeJobId: "alpaca-nasdaq100-quotes-enrich-analyze",
        ruleSets: ["screen", "factors"],
        inputMode: "handOff",
      }),
    );
    expect(byKind.get("generate")).toEqual(
      expect.objectContaining({
        generateJobId: "alpaca-nasdaq100-quotes-enrich-analyze-generate",
        reports: ["screener-report"],
      }),
    );
    // Issue #5885 (6c): the deliver node is flipped onto
    // generic deliver.apply with the screener marker — and
    // still no family job id rides it (deliver.apply's
    // screener application names no deliver job).
    expect(byKind.get("deliver")).toEqual(expect.objectContaining({ screener: true }));
    expect(byKind.get("deliver")).not.toHaveProperty("deliverJobId");
  });

  it.each([
    ["yahoo", "yahoo-nasdaq100-quotes"],
    ["etrade", "etrade-nasdaq100-quotes"],
    ["public", "public-nasdaq100-quotes"],
  ])("resolves the %s lineage from the command provider", (provider, feedJobId) => {
    const nodes = nodesOf(buildScreenerJobDefinition(marketCommand({ provider })));
    const byKind = new Map(nodes.map((n) => [n.kind, n.params]));
    expect(byKind.get("feed")).toEqual(expect.objectContaining({ feedJobId }));
    expect(byKind.get("enrich")).toEqual(expect.objectContaining({ enrichJobId: `${feedJobId}-enrich` }));
    expect(byKind.get("analyze")).toEqual(
      expect.objectContaining({ analyzeJobId: `${feedJobId}-enrich-analyze` }),
    );
    expect(byKind.get("generate")).toEqual(
      expect.objectContaining({ generateJobId: `${feedJobId}-enrich-analyze-generate` }),
    );
  });

  it("refuses an unknown provider by name, never a guessed job id", () => {
    expect(() =>
      buildScreenerJobDefinition(marketCommand({ provider: "nasdaq" })),
    ).toThrow(/SCREENER_FEED_JOB_UNKNOWN.*nasdaq-nasdaq100-quotes/);
  });

  it("carries the command shard ids as processing.shards on every node", () => {
    const nodes = nodesOf(
      buildScreenerJobDefinition(
        marketCommand({
          shards: [
            { shardId: "s0", symbols: [listing("AAPL"), listing("NVDA")] },
            { shardId: "s1", symbols: [listing("MSFT"), listing("AMZN")] },
          ],
        }),
      ),
    );
    expect(nodes).toHaveLength(5);
    for (const node of nodes) {
      expect(node.shards).toEqual(["s0", "s1"]);
    }
  });

  it("carries the run's single universe on the feed node; multi-universe commands omit it", () => {
    const single = nodesOf(
      buildScreenerJobDefinition(
        marketCommand({ shards: [{ shardId: "nasdaq100", universe: "nasdaq100" }] }),
      ),
    );
    expect(single[0]?.params).toEqual(expect.objectContaining({ universe: "nasdaq100" }));
    const multi = nodesOf(
      buildScreenerJobDefinition(
        marketCommand({
          shards: [
            { shardId: "nasdaq100", universe: "nasdaq100" },
            { shardId: "sp500", universe: "sp500" },
          ],
        }),
      ),
    );
    // Per-shard universes govern per unit (6b1); no node-level
    // universe may override them.
    expect(multi[0]?.params).not.toHaveProperty("universe");
  });

  it("the market definition carries no goalScreen param on any node", () => {
    const nodes = nodesOf(buildScreenerJobDefinition(marketCommand()));
    for (const node of nodes) {
      expect(node.params).not.toHaveProperty("goalScreen");
    }
  });

  it("a goal command still builds the goalScreen spec (analyze node is the 6d-a composition)", () => {
    const spec = jobDefinitionSpec("goalScreen");
    // Issue #6072 — the goal spec is v2: the analyze node runs the
    // goal composition (the flip's "untouched" pin ends here; the
    // other five nodes are still the 3b bespoke steps). Issue
    // #6073 — the bespoke nodes' params now carry the family job
    // ids + the leg kit (the stock leg runs the generic chain);
    // the spec shape is unchanged.
    expect(spec.version).toBe(2);
    const nodes = nodesOf(buildScreenerJobDefinition(goalCommand()));
    expect(nodes.map((n) => n.kind)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "store",
      "serve",
      "deliver",
    ]);
    expect(nodes.map((n) => n.step)).toEqual([
      "screener.feed",
      "screener.gather",
      "goal.quota",
      "screener.store",
      "screener.serve",
      "screener.deliver",
    ]);
    expect(nodes.find((n) => n.kind === "analyze")?.steps).toEqual(
      GOAL_COMPOSITION_STEPS,
    );
    // Issue #6073 — the goal path is no longer byte-identical to
    // 3b: the family job ids ride the goal definition now (the
    // stock leg runs the generic chain), with the leg kit on the
    // analyze node. The spec shape is unchanged (v2, same six
    // kinds/steps, composition on analyze); only the bespoke
    // nodes' params gained the ids. Symbols mode needs no
    // universe anywhere.
    const paramsByKind = new Map(nodes.map((n) => [n.kind, n.params]));
    expect(paramsByKind.get("feed")!.feedJobId).toBe("yahoo-nasdaq100-quotes");
    expect(paramsByKind.get("feed")!.universe).toBeUndefined();
    expect(paramsByKind.get("enrich")!.enrichJobId).toBe(
      "yahoo-nasdaq100-quotes-enrich",
    );
    expect(paramsByKind.get("analyze")!.feedJobId).toBe("yahoo-nasdaq100-quotes");
    expect(paramsByKind.get("analyze")!.enrichJobId).toBe(
      "yahoo-nasdaq100-quotes-enrich",
    );
    expect(paramsByKind.get("analyze")!.analyzeJobId).toBe(
      "yahoo-nasdaq100-quotes-enrich-analyze",
    );
    expect(paramsByKind.get("analyze")!.generateJobId).toBe(
      "yahoo-nasdaq100-quotes-enrich-analyze-generate",
    );
    expect(paramsByKind.get("analyze")!.stockLegAnalyzeParams).toEqual({
      ruleSets: ["screen", "factors"],
      inputMode: "handOff",
    });
    expect(paramsByKind.get("analyze")!.stockLegGenerateParams).toEqual({
      reports: ["screener-report"],
    });
    expect(paramsByKind.get("analyze")!.stockLegUniverse).toBeUndefined();
    // The store/serve/deliver nodes carry no family job ids (the
    // leg kit rides feed/enrich/analyze only — the goal spec has
    // no generate node; the generate job id rides the analyze
    // node's kit, asserted above).
    for (const kind of ["store", "serve", "deliver"]) {
      expect(paramsByKind.get(kind)!).not.toHaveProperty("feedJobId");
      expect(paramsByKind.get(kind)!).not.toHaveProperty("enrichJobId");
      expect(paramsByKind.get(kind)!).not.toHaveProperty("analyzeJobId");
      expect(paramsByKind.get(kind)!).not.toHaveProperty("generateJobId");
    }
  });
});
