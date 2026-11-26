/**
 * The options-chain job definition — the pure half of the chain.
 *
 * This module is a LEAF: it has no runtime imports at all (only
 * `import type`), so any module may import it without dragging a
 * server graph along. That matters because the chain's start seam
 * (startOptionsChainWorkflow in src/workflows/optionsWorkflowHost.ts)
 * needs the definition builder and the job id, and the host module
 * is imported by client code — importing the builder from the
 * step-implementation module (optionsChainPipelineJobs.ts) dragged
 * that module's whole server graph (report pipeline → Think graph's
 * workerd-only cloudflare:* imports; shard executors → the data
 * layer's transactionAspect with node:async_hooks) into the browser
 * bundle and failed the production build (PR #5142 Fast gates,
 * issue #4780). The builder and its constants live here instead;
 * the step module imports them from here, so there is still one
 * home for each name.
 */
import type { JobNodeConfig, JobRunProvenance } from "../data/jobPipelinePorts";
import type { JobRunTrigger } from "../data/jobRunRecordPorts";
import type { ShardChainContext } from "../types";

/** The chain job's kind — the job id is `options-chain:<chainId>`. */
export const OPTIONS_CHAIN_JOB_KIND = "options-chain";

/**
 * Issue #4774 — the options chain's short id (user ruling, comment
 * 6912854849, 2026-11-16): "optionsscr". The options chain shape
 * (options.runRoot / options.runStage, 8 execution stages, 4 display
 * stages) IS the options-screener family's chain, so the family's
 * short id names the chain too. The stable job kind above is
 * unchanged; the short id is the alias a run is named, traced, and
 * surfaced under.
 */
export const OPTIONS_CHAIN_SHORT_ID = "optionsscr" as const;

/** The six chain steps, one per stage. */
export const OPTIONS_CHAIN_FEED_STEP = "options-chain.feed";
export const OPTIONS_CHAIN_ASSEMBLE_STEP = "options-chain.assemble";
export const OPTIONS_CHAIN_GENERATE_STEP = "options-chain.generate";
export const OPTIONS_CHAIN_STORE_STEP = "options-chain.store";
export const OPTIONS_CHAIN_SERVE_STEP = "options-chain.serve";
export const OPTIONS_CHAIN_DELIVER_STEP = "options-chain.deliver";

/** The six chain stage kinds, in execution order. */
export const OPTIONS_CHAIN_STAGE_KINDS = [
  "options-chain.feed",
  "options-chain.assemble",
  "options-chain.generate",
  "options-chain.store",
  "options-chain.serve",
  "options-chain.deliver",
] as const;

/** The report formats the generate/store nodes shard over. */
export const OPTIONS_CHAIN_FORMATS = ["pdf", "xlsx", "csv"] as const;
export type OptionsChainFormat = (typeof OPTIONS_CHAIN_FORMATS)[number];

/** The engine job id for a chain — the chain id IS the job id. */
export function optionsChainJobId(chainId: string): string {
  return `${OPTIONS_CHAIN_JOB_KIND}:${chainId}`;
}

/**
 * Issue #6584 — the provenance a chain start hands the workflow
 * residency: the four facts the firing schedule ALREADY resolved onto
 * the chain (#3655: broker via resolveTenantBroker, data provider via
 * resolveTenantProviders, mode + mode source via
 * resolveScheduledEffectiveMode). Nothing is re-derived here and nothing
 * is inferred — this is a read of the chain's own record.
 *
 * A manual, retried or replayed start names none (null), exactly as
 * #6557's owner decision requires: only a firing schedule payload (and
 * the chain it fires) is a source, and the record then keeps explicit
 * nulls rather than a guess.
 */
export function chainRunProvenance(
  chain: ShardChainContext,
  trigger: JobRunTrigger | undefined,
): JobRunProvenance | null {
  if (trigger !== "scheduled") return null;
  const carrier: JobRunProvenance = {
    brokerId: chain.brokerId ?? null,
    dataProviderId: chain.dataProviderId ?? null,
    mode: chain.mode ?? null,
    modeSource: chain.modeSource ?? null,
  };
  const named =
    carrier.brokerId !== null ||
    carrier.dataProviderId !== null ||
    carrier.mode !== null ||
    carrier.modeSource !== null;
  return named ? carrier : null;
}

/** The chain job's root execution mode: sequential, batch, async delivery, monolith root. */
export const OPTIONS_CHAIN_ROOT_EXECUTION_MODE = {
  concurrency: "sequential",
  pacing: "batch",
  delivery: "async",
  shape: "monolith",
} as const;

/**
 * The raw job definition for one options chain: the six stages as a
 * NESTED chain — feed is the root, every later stage the single child
 * of the stage before it (the chain idiom: a stage's input is its
 * parent stage's output). The chain rides every node's params and the
 * raw config, so a step can read it back without a second store.
 * Refuses by name when the chain has no id or no symbols — a chain
 * with no feed shards is not definable.
 */
export function buildOptionsChainJobDefinition(chain: ShardChainContext): unknown {
  if (!chain.chainId || !chain.chainId.trim()) {
    throw new Error(
      "buildOptionsChainJobDefinition requires a non-empty chain.chainId — refusing to invent a job id.",
    );
  }
  const symbols = [
    ...new Set((chain.options?.symbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean)),
  ];
  if (symbols.length === 0) {
    throw new Error(
      "buildOptionsChainJobDefinition requires at least one symbol in chain.options.symbols — refusing to define a chain with no feed shards.",
    );
  }
  const jobId = optionsChainJobId(chain.chainId);
  const params = { chain };
  const stages: Array<{
    kind: string;
    step: string;
    processing?: { shards: string[] };
    executionMode?: { shape: "sharded"; concurrency: "sequential" };
  }> = [
    { kind: "options-chain.deliver", step: OPTIONS_CHAIN_DELIVER_STEP },
    { kind: "options-chain.serve", step: OPTIONS_CHAIN_SERVE_STEP },
    {
      kind: "options-chain.store",
      step: OPTIONS_CHAIN_STORE_STEP,
      processing: { shards: [...OPTIONS_CHAIN_FORMATS] },
      executionMode: { shape: "sharded", concurrency: "sequential" },
    },
    {
      kind: "options-chain.generate",
      step: OPTIONS_CHAIN_GENERATE_STEP,
      processing: { shards: [...OPTIONS_CHAIN_FORMATS] },
      executionMode: { shape: "sharded", concurrency: "sequential" },
    },
    { kind: "options-chain.assemble", step: OPTIONS_CHAIN_ASSEMBLE_STEP },
    {
      kind: "options-chain.feed",
      step: OPTIONS_CHAIN_FEED_STEP,
      processing: { shards: symbols },
      // No executionMode here: the feed node IS the root, and the
      // root mode is set below (shape follows the symbol count).
    },
  ];
  let node: JobNodeConfig | undefined;
  for (const stage of stages) {
    const next: JobNodeConfig = {
      kind: stage.kind,
      steps: [{ step: stage.step, params }],
      ...(stage.processing ? { processing: stage.processing } : {}),
      ...(stage.executionMode ? { executionMode: stage.executionMode } : {}),
      ...(node ? { children: [node] } : {}),
    };
    node = next;
  }
  const root = node!;
  // Issue #4780 (caught by the #4780 pin test): the root node IS the
  // feed node, and execNode fans out ONLY when the node's effective
  // shape is "sharded" — so the root mode's shape must follow the
  // symbol count, not the family default "monolith". The stock
  // idiom (screenerPipelineJobs.ts:436): shape = sharded when more
  // than one shard, monolith for a single symbol. A previous
  // version set shape "monolith" unconditionally here, which would
  // have run the feed monolith (one unit, shardKey null) and lost
  // the per-symbol fan-out entirely.
  root.executionMode = {
    ...OPTIONS_CHAIN_ROOT_EXECUTION_MODE,
    shape: symbols.length > 1 ? "sharded" : "monolith",
  };
  return {
    jobId,
    name: `optionsscr chain ${chain.chainId}`,
    kind: OPTIONS_CHAIN_JOB_KIND,
    root,
    chain,
  };
}
