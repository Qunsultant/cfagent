/**
 * Issue #4774 — the execution-tree ids.
 *
 * User ruling (issue #4774 comment 6912854849, 2026-11-16): chains and
 * families are named by short identifiers (stockscr, optionsscr, goalscr,
 * strategyscr, feedsrc). EXTENDED by the user (comment 6959360479,
 * 2026-11-17): the short-id system covers ALL levels of the execution
 * tree — stages, sub-stages, pipelines, chains, workflows, tasks, etc. —
 * and each transaction gets its own id: every run/transaction instance
 * carries a unique id.
 *
 * This module is the system: the level taxonomy, the qualified-id
 * formatter, the stage/step execution ids, and the OODA disambiguation.
 * It is a LEAF — no runtime imports (only `import type`, erased at
 * build) — so client-reachable modules can import it without dragging
 * in a server graph (the #4780 lesson: a definition module imported by
 * a client-reachable module must not import server-only values).
 *
 * What lives where:
 *  - Chain/family short ids: the catalogs (`workflowCatalog`,
 *    `jobDefinitionCatalog`, `chainPipelineJobs`, `optionsChainJobDefinition`).
 *  - Stage/step execution ids: REUSED from the engine's existing
 *    formats, not invented — `stageExecutionId` is the prefix of the
 *    `job-stage:` CloudEvents id (`jobPipelineEvents.ts`), and
 *    `stepExecutionId` is the journal id (`jobPipelineEngine.ts`).
 *  - OODA vs run-level stages: `ooda:*` (the candidate-level loop) vs
 *    `respipe:*` (the research pipeline's 8 run-level stages). The
 *    bare stage strings ("observe" | "orient" | "decide") are UNCHANGED
 *    — the qualified short id rides alongside them on each trace entry.
 *  - Per-instance ids: engine runs mint `run-<time>-<counter>`
 *    (`jobPipelineEngine.ts` `newRunId`); research runs mint
 *    `rsr_<time>_<rand>` (`researchPipeline.ts` `newRunId`); async jobs
 *    mint `crypto.randomUUID()`; ledger rows carry their `id` PK
 *    (`mas_transactions`). A trace step's instance id is DERIVABLE —
 *    `researchStepInstanceId(runId, shortId, index)` — not stored.
 *
 * NOT in this slice (proposed follow-ups, see the #4774 PR body):
 *  - The research run's engine onboarding (#5109, CFO lane): the
 *    engine job id (`research:<runId>`) and data ports landed (#5121,
 *    `researchDataPorts.ts`); the trigger dispatch (#5120) and the
 *    cutover flag (#5122) are recorded merged; the analyze.ooda step
 *    registration (#5118, PR #5143 open), AOP compliance (#5119,
 *    PR #5144 open), and Copilot execution (#5123, no PR) remain.
 *    The direct `runResearchPipeline` call from ResearchAgent
 *    (`research-agent.ts:541`) is the pre-cutover / rollback path,
 *    not the engine path. The `ooda:` / `respipe:` ids above are
 *    names the #5118 step registration can reuse; CLO-arsi does not
 *    build the step registration (CFO lane owns #5118).
 *  - Persisting per-step instance ids as stored fields (they are
 *    derivable today from runId + qualified step + index).
 */
import type { OodaStep, PipelineStage } from "./researchPipeline";

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
 * `run:run-m9x-1`, `job:stock-screener`. The local id is never rewritten;
 * the level prefix is what makes the same local string unambiguous
 * across levels.
 */
export function qualifyExecutionId(level: ExecutionTreeLevel, localId: string): string {
  return `${EXECUTION_TREE_LEVEL_SHORT_IDS[level]}:${localId}`;
}

/**
 * One printable id for one stage execution: `job-stage:<runId>:<stageId>:<unitId>`.
 * This is the PREFIX of the stage-action CloudEvents id
 * (`jobStageActionEvent` in `jobPipelineEvents.ts` appends
 * `:<action>:<at>:<suffix>`); the execution id is the part the action
 * events share. A stage without units carries `"-"` as the unit half,
 * matching the event format.
 */
export function stageExecutionId(runId: string, stageId: string, unitId?: string): string {
  return `job-stage:${runId}:${stageId}:${unitId ?? "-"}`;
}

/**
 * One printable id for one step execution (one journaled step invocation):
 * `job-step:<runId>:<nodePath>:<stepIndex>:<shardKey>:<itemIndex>`.
 * This is the journal id `JobPipelineEngine` passes to `journal.do`
 * (`jobPipelineEngine.ts`) — the durability key for the step's
 * exactly-once execution.
 */
export function stepExecutionId(
  runId: string,
  path: string,
  stepIndex: number,
  shardKey?: string,
  itemIndex?: number,
): string {
  return `job-step:${runId}:${path || "root"}:${stepIndex}:${shardKey ?? "-"}:${itemIndex ?? "-"}`;
}

/** The candidate-level OODA loop's short id (one loop per candidate). */
export const OODA_LOOP_SHORT_ID = "ooda" as const;

/** The research pipeline's (8 run-level stages) short id. */
export const RESEARCH_PIPELINE_SHORT_ID = "respipe" as const;

/**
 * The level-qualified id of one candidate-level OODA step:
 * `ooda:observe` | `ooda:orient` | `ooda:decide` | `ooda:act`.
 */
export function oodaStepShortId(stage: OodaStep["stage"]): string {
  return `${OODA_LOOP_SHORT_ID}:${stage}`;
}

/**
 * The level-qualified id of one run-level research-pipeline stage:
 * `respipe:configure` | `respipe:observe` | `respipe:orient` |
 * `respipe:decide` | `respipe:build-and-price` |
 * `respipe:challenge-and-gate` | `respipe:rank-and-report` |
 * `respipe:evaluate-later`.
 *
 * "observe" | "orient" | "decide" appear at BOTH levels — that is the
 * ambiguity these ids resolve: `ooda:observe` is the candidate loop's
 * step, `respipe:observe` is the run-level stage.
 */
export function researchPipelineStageShortId(stage: PipelineStage): string {
  return `${RESEARCH_PIPELINE_SHORT_ID}:${stage}`;
}

/**
 * One printable id for one trace-step instance, DERIVED (not stored):
 * `run:<runId>/<qualified-step-id>#<index>` — e.g.
 * `run:rsr_abc123/ooda:observe#2`. The index is the entry's position
 * in its trace array (`oodaTrace` / `stageTrace`); two entries with the
 * same qualified step in one run differ by index, two runs differ by
 * runId. If per-step instance ids ever need to be stored fields rather
 * than derived, that is follow-up work, not this slice.
 */
export function researchStepInstanceId(runId: string, shortId: string, index: number): string {
  return `run:${runId}/${shortId}#${index}`;
}
