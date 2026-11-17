/**
 * Issue #4774 — the execution-tree ids, under the ADOPTED uniform
 * convention (#5175).
 *
 * User rulings:
 *  - 2026-11-16 (issue #4774 comment 6912854849): chains and families
 *    are named by short identifiers (stockscr, optionsscr, goalscr,
 *    strategyscr, feedsrc). EXTENDED 2026-11-17 (comment 6959360479):
 *    the short-id system covers ALL levels of the execution tree —
 *    stages, sub-stages, pipelines, chains, workflows, tasks, etc. —
 *    and each transaction gets its own id: every run/transaction
 *    instance carries a unique id.
 *  - 2026-11-17 (#5175): the UNIFORM convention is adopted — every
 *    generated id is colon-separated segments, the first segment is
 *    the type, no body ever contains `:`. Fixed arity per type. The
 *    short id is the body; the system id is `<type>:<body>`. The
 *    research family's short id is `resrch` (OODA is one research
 *    type within the family); trading is one family, `tradrun`;
 *    `payrun`; `sagarun`; the `sched:` schedule-id form is confirmed.
 *  - 2026-11-17 (#5175): `respipe:` is RETIRED. Run-level research
 *    stages are plain `stage:` ids — the hierarchy scopes them, so no
 *    separate namespace is needed. Only the candidate-level OODA loop
 *    keeps a qualified short id (`ooda:*`).
 *
 * This module is the system: the level taxonomy, the qualified-id
 * formatter, the stage/step/event execution ids, and the OODA loop
 * ids. It is a LEAF — no runtime imports (only `import type`, erased
 * at build) — so client-reachable modules can import it without
 * dragging in a server graph (the #4780 lesson: a definition module
 * imported by a client-reachable module must not import server-only
 * values).
 *
 * What lives where:
 *  - Chain/family short ids: the catalogs (`workflowCatalog`,
 *    `jobDefinitionCatalog`, `chainPipelineJobs`, `optionsChainJobDefinition`).
 *  - Stage/step/event execution ids: the engine's formats, owned here
 *    — `stageExecutionId` (`stage:`), `stepExecutionId` (`step:`, the
 *    journal id in `jobPipelineEngine.ts`), `stageActionEventId`
 *    (`event:`, the CloudEvents id in `jobPipelineEvents.ts`).
 *    Composite ids embed BODIES, never full ids: a stage id embeds the
 *    run body (`m9x-1`), not the run id (`run:m9x-1`), and the stage
 *    body (`feed`), not the qualified node id (`job:feed`). That is
 *    what keeps every id's arity fixed.
 *  - OODA loop: `ooda:*` (the candidate-level loop). Run-level stages
 *    carry no loop qualifier — see `stageExecutionId`.
 *  - Per-instance ids: engine runs mint `run:<time>-<counter>`
 *    (`jobPipelineEngine.ts` `newRunId`); async jobs mint
 *    `crypto.randomUUID()`; ledger rows carry their `id` PK
 *    (`mas_transactions`). A trace step's instance id is DERIVABLE —
 *    `traceStepInstanceId(runId, shortId, index)` — not stored.
 *
 * NOT in this slice (legacy, pending #5175 migration — the uniform
 * convention's migration slices, not this rework):
 *  - Research runs still mint `rsr_<time>_<rand>`
 *    (`researchPipeline.ts` `newRunId`); the research job id
 *    (`research:<runId>`), checkpoint keys, and generation ids still
 *    embed the full research run id; the options-chain `chainId` is
 *    still a bare UUID. Those minters and their consumers move in
 *    #5175's migration slices (CFO lane owns the research surfaces).
 *  - Persisting per-step instance ids as stored fields (they are
 *    derivable today from runId + qualified step + index).
 */
import type { OodaStep } from "./researchPipeline";

/** Every level of the execution tree, with its short id. */
export const EXECUTION_TREE_LEVEL_SHORT_IDS = {
  chain: "chain",
  pipeline: "pipe",
  workflow: "wf",
  job: "job",
  stage: "stage",
  /** Sub-stage: one execution unit inside a stage (one shard key). */
  unit: "unit",
  task: "task",
  run: "run",
  /** Transaction: one ledger / transaction-aspect unit. */
  txn: "txn",
} as const;

export type ExecutionTreeLevel = keyof typeof EXECUTION_TREE_LEVEL_SHORT_IDS;

/**
 * One printable id for one instance at one level:
 * `<level-short-id>:<local-id>` — e.g. `chain:feedsrc`,
 * `run:m9x-1`, `job:stock-screener`. The local id is the BODY, never a
 * full id; the level prefix is what makes the same local string
 * unambiguous across levels.
 */
export function qualifyExecutionId(level: ExecutionTreeLevel, localId: string): string {
  return `${EXECUTION_TREE_LEVEL_SHORT_IDS[level]}:${localId}`;
}

/**
 * The body of a run id: the part after the `run:` type prefix.
 * Lenient by design — an id without the prefix (an injected test id
 * such as `run-1`, or a legacy `rsr_*` research run id) is returned
 * unchanged, so callers that mint their own ids keep working and the
 * legacy research format stays resolvable until #5175 migrates it.
 */
export function runIdBody(runId: string): string {
  return runId.startsWith("run:") ? runId.slice("run:".length) : runId;
}

/**
 * The body of a stage / node id: the part after the `job:` type
 * prefix (`job:feed` → `feed`). Stage ids and node paths share the
 * `job:<nodePath>` namespace; composite ids embed the body, never the
 * qualified id — that is what keeps every id's arity fixed. Lenient
 * like `runIdBody`: a bare name passes through unchanged.
 */
export function stageIdBody(stageId: string): string {
  return stageId.startsWith("job:") ? stageId.slice("job:".length) : stageId;
}

/**
 * One printable id for one stage execution:
 * `stage:<runBody>:<stageId>:<unitId>` — e.g. `stage:m9x-1:feed:-`.
 * The run body (not the run id) and the stage body (not the qualified
 * `job:<nodePath>`) are embedded, so the id is always 4 segments.
 * A stage without units carries `"-"` as the unit half.
 *
 * The event id (`stageActionEventId`) shares the run body + stage +
 * unit segments with this id — that segment equality, not a string
 * prefix, is the link between a stage execution and its events.
 */
export function stageExecutionId(runId: string, stageId: string, unitId?: string): string {
  return `stage:${runIdBody(runId)}:${stageIdBody(stageId)}:${unitId ?? "-"}`;
}

/**
 * One printable id for one step execution (one journaled step invocation):
 * `step:<runBody>:<nodePath>:<stepIndex>:<shardKey>:<itemIndex>` —
 * e.g. `step:m9x-1:feed:0:AAPL:0`. This is the journal id
 * `JobPipelineEngine` passes to `journal.do` (`jobPipelineEngine.ts`)
 * — the durability key for the step's exactly-once execution. It is
 * derived deterministically from the same tuple as before, so a retry
 * computes the same id; only the prefix and the embedded bodies
 * changed (the uniform convention).
 */
export function stepExecutionId(
  runId: string,
  path: string,
  stepIndex: number,
  shardKey?: string | null,
  itemIndex?: number | null,
): string {
  return `step:${runIdBody(runId)}:${stageIdBody(path) || "root"}:${stepIndex}:${shardKey ?? "-"}:${itemIndex ?? "-"}`;
}

/**
 * One printable id for one stage-action CloudEvents event:
 * `event:<runBody>:<stageId>:<unitId>:<action>:<atMillis>:<suffix>` —
 * e.g. `event:m9x-1:feed:-:start:1763419200000:abc123`. The `<at>` is
 * epoch millis, not ISO — an ISO timestamp contains `:`, so it cannot
 * appear in a body. The first three segments after the type are the
 * stage execution's segments (run body, stage, unit): the event id
 * shares them with `stageExecutionId`, which is how an event resolves
 * to its stage.
 */
export function stageActionEventId(
  runId: string,
  stageId: string,
  unitId: string | undefined,
  action: string,
  atMillis: number,
  suffix: string,
): string {
  return `event:${runIdBody(runId)}:${stageIdBody(stageId)}:${unitId ?? "-"}:${action}:${atMillis}:${suffix}`;
}

/** The candidate-level OODA loop's short id (one loop per candidate). */
export const OODA_LOOP_SHORT_ID = "ooda" as const;

/**
 * The level-qualified id of one candidate-level OODA step:
 * `ooda:observe` | `ooda:orient` | `ooda:decide` | `ooda:act`.
 */
export function oodaStepShortId(stage: OodaStep["stage"]): string {
  return `${OODA_LOOP_SHORT_ID}:${stage}`;
}

/**
 * One printable id for one trace-step instance, DERIVED (not stored):
 * `trace:<runBody>:<loop>:<step>:<index>` — e.g.
 * `trace:m9x-1:ooda:observe:2`. The index is the entry's position in
 * its trace array (`oodaTrace`); two entries with the same qualified
 * step in one run differ by index, two runs differ by run body. The
 * qualified step splits on `:` into its loop and step halves. If
 * per-step instance ids ever need to be stored fields rather than
 * derived, that is follow-up work, not this slice.
 */
export function traceStepInstanceId(runId: string, shortId: string, index: number): string {
  const [loop, step] = shortId.split(":");
  if (step === undefined) {
    throw new Error(
      `traceStepInstanceId: expected a qualified step id "<loop>:<step>", got "${shortId}" (#4774)`,
    );
  }
  return `trace:${runIdBody(runId)}:${loop}:${step}:${index}`;
}
