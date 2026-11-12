/**
 * Issue #4192 ([One engine] #3550 S2) — the screener collation
 * composer: the engine-path successor to the bespoke flow's
 * collation tail (`screenerWorkflowFlow.ts`, deprecated in
 * place by this slice).
 *
 * The engine has no node-level finalize step (a per-unit
 * deliver step cannot see the other shards' deliver outputs),
 * so the collation is composed ONCE, after `runJob` settles,
 * by reading the persisted stage-output artifacts + the stage
 * ledger (`control.getJob`) and calling `collateShards` —
 * the design's intent (collation from analysis outputs +
 * parent report, written as an artifact) with the correct
 * engine seam.
 *
 * The composer also does the flow's project-final tail (the
 * parent + per-shard legs into the shard-job store — the mesh
 * door / NLQ port read the collation from those rows via
 * `collationFromRows`) and the parent canonical row
 * (`storeParentReport`), both best-effort and recorded,
 * exactly like the flow. Without the project-final legs the
 * mesh door / NLQ awaits would never see a collation (they
 * poll `readJobHistory` rows; terminal status ×3 polls →
 * finish with collation null) — a regression; the composer
 * MUST project them.
 *
 * Failed-shard mapping (engine semantics, verified in
 * `executeUnit`): one failed unit throws out of its node, so
 * a failed shard fails the RUN (later nodes never run; the
 * failing node's stage-output is never written). The composer
 * therefore reads, per shard, the DEEPEST stage-output
 * artifact present (deliver → serve → store → analyze →
 * gather → feed), plus the stage ledger for failed/timed_out
 * entries (error text rides the ledger). A shard with no
 * artifact anywhere: failed (ledger entry) or failed
 * "never ran". A shard that started but never reached
 * analysis: failed "never reached analysis" — never invented
 * completed.
 */
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { projectLegOutcomes } from "../data/shardJobProjection";
import type { LegOutcome, ShardJobStore } from "../data/shardJobPorts";
import type { GoalDrivenScreenResult } from "../services/goalDrivenScreen";
import type { ScenarioDefinition } from "../services/goalScenarioEngine";
import {
  type ScreenIntentInterpreter,
  type ScreenInterpretationAuditRecord,
} from "./screenCriteriaArtifact";
import type { JobDefinition, JobPipelineStores } from "../data/jobPipelinePorts";
import {
  JobPipelineControl,
  vocabularyStageForNodeKind,
  type JobRunOutcome,
  type JobStageView,
} from "../services/jobPipelineEngine";
import { SCREENER_NODE_KINDS } from "../services/screenerPipelineJobs";
import {
  workflowIdForJob,
  type ParentScreenReportInput,
  type ParentScreenReportOutcome,
  type ScreenMode,
  type ShardOutcome,
  type StageName,
  type StageTransition,
  type WorkflowCollation,
  type WorkflowJobCommand,
  type WorkflowRunLifecycle,
} from "./workflowPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "workflows/screenerCollation",
});

/** Capability id for the screener workflow's shard-job rows. */
export const SCREENER_WORKFLOW_CAPABILITY = "screener-workflow";

/** Workspace id convention for workflow rows (matches the scheduled-agent caller). */
export const WORKFLOW_WORKSPACE_ID = "primary";

/** Provenance writer for workflow projection rows. */
export const WORKFLOW_PROVENANCE_WRITER = "screener-workflow:project";

/** The collation artifact key on a run. */
export const SCREENER_COLLATION_ARTIFACT_KEY = "screener/collation";

/** The six catalog stages, in order, as screener node kinds. */
/** A screener node kind: one of the six catalog stages. */
export type ScreenerNodeKind = (typeof SCREENER_NODE_KINDS)[number];

export const SCREENER_STAGE_KINDS: readonly ScreenerNodeKind[] = SCREENER_NODE_KINDS;

/** One-line human summary for a parent row's detail (visible in jobs/history). */
export function collationDetail(collation: WorkflowCollation): string {
  const done = collation.shards.filter((s) => s.status === "completed").length;
  const total = collation.shards.length;
  const coverage =
    collation.coverage.ratio === null
      ? "no coverage"
      : `${Math.round(collation.coverage.ratio * 100)}% coverage`;
  const qualified = collation.qualified ? ", qualified partial" : "";
  return `Workflow ${collation.lifecycle}: ${done}/${total} shards, ${coverage}${qualified}.`;
}

/**
 * Pure collation: shard outcomes → the parent summary.
 * Lifecycle: Failed when no shard completed; ReportGenerated
 * when every completed shard was stored by its child;
 * Completed otherwise (qualified when any shard failed or
 * timed out). Stored/delivered sets and error maps come
 * from the child outputs' flags — collation itself stores
 * nothing; the parent canonical row is written by
 * finalizeScreenerCollation's store-parent step from this
 * collation (issue #2910), and the parent never delivers.
 */
export function collateShards(
  jobId: string,
  workflowId: string,
  outcomes: ShardOutcome[],
  lifecycleTransitions: Array<{ lifecycle: WorkflowRunLifecycle; atMs: number }>,
  stageTransitions: StageTransition[],
): WorkflowCollation {
  const completed = outcomes.filter((o) => o.status === "completed");
  const qualified = outcomes.some((o) => o.status !== "completed");
  const evaluated = outcomes.reduce((n, o) => n + (o.totalScanned ?? 0), 0);
  const considered = outcomes.reduce((n, o) => n + (o.expectedCount ?? 0), 0);
  const storedShards = completed.filter((o) => o.stored).map((o) => o.shardId);
  const deliveredShards = completed.filter((o) => o.delivered).map((o) => o.shardId);
  const storeErrors: Record<string, string> = {};
  const deliverErrors: Record<string, string> = {};
  for (const o of outcomes) {
    if (o.storeError) storeErrors[o.shardId] = o.storeError;
    if (o.deliverError) deliverErrors[o.shardId] = o.deliverError;
  }
  const lifecycle =
    completed.length === 0
      ? "Failed"
      : completed.every((o) => o.stored)
        ? "ReportGenerated"
        : "Completed";
  const reportKeys = outcomes
    .map((o) => o.pdfKey)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
  const xlsxKeys = outcomes
    .map((o) => o.xlsxKey)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
  const csvKeys = outcomes
    .map((o) => o.csvKey)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
  return {
    jobId,
    workflowId,
    lifecycle,
    qualified,
    coverage: {
      evaluated,
      considered,
      ratio: considered > 0 ? evaluated / considered : null,
    },
    shards: outcomes,
    lifecycleTransitions,
    stageTransitions,
    reportKeys,
    ...(xlsxKeys.length > 0 ? { xlsxKeys } : {}),
    ...(csvKeys.length > 0 ? { csvKeys } : {}),
    storedShards,
    deliveredShards,
    ...(Object.keys(storeErrors).length > 0 ? { storeErrors } : {}),
    ...(Object.keys(deliverErrors).length > 0 ? { deliverErrors } : {}),
    ...(lifecycle === "Failed"
      ? {
          error:
            outcomes.map((o) => o.error).find((e) => typeof e === "string") ??
            "All shards failed.",
        }
      : {}),
  };
}

/** Stage transitions for one shard outcome (see the honesty note in the flow header). */
export function stageTransitionsForShard(
  outcome: ShardOutcome,
  atMs: number,
): StageTransition[] {
  if (outcome.status === "completed") {
    return [
      { stage: "feed", outcome: "completed", atMs },
      { stage: "gather", outcome: "completed", atMs },
      { stage: "analysis", outcome: "completed", atMs },
    ];
  }
  return [{ stage: "analysis", outcome: "failed", atMs }];
}

/**
 * The screen result one shard returns (structural subset of
 * the agent's result, plus the child's own store/deliver
 * flags). `full` is the OPAQUE full agent result: present
 * only inside the child run, where the child's store/deliver
 * steps consume it — it is STRIPPED from the child output
 * before return, so workflow outputs and the parent
 * collation never carry bulk data (claim-check: outputs
 * carry ids + summaries + flags only).
 */
export interface ShardScreenResult {
  success: boolean;
  timestamp: string;
  universe?: string;
  totalScanned: number;
  expectedCount: number;
  matchedCount: number;
  pdfKey?: string;
  /** Issue #2080: the workbook/CSV keys the child recorded. */
  xlsxKey?: string;
  csvKey?: string;
  /** Issue #2080: the run's trigger, so the canonical body records it. */
  trigger?: "manual" | "scheduled";
  error?: string;
  full?: unknown;
  stored?: boolean;
  delivered?: boolean;
  storeError?: string;
  deliverError?: string;
  /**
   * Issue #2910 (G3): the child's canonical report id, when
   * the child's store door returned one (the goal door
   * does; the market door returns void). Surfaced on the
   * child output so the parent can link its row to the
   * child's; never used for re-delivery.
   */
  reportId?: string;
}

/** Validate a value as a shard screen result (garbage becomes null, never a collation crash). */
export function asShardScreenResult(value: unknown): ShardScreenResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.success !== "boolean" ||
    typeof v.timestamp !== "string" ||
    typeof v.totalScanned !== "number" ||
    typeof v.expectedCount !== "number" ||
    typeof v.matchedCount !== "number"
  ) {
    return null;
  }
  return {
    success: v.success,
    timestamp: v.timestamp,
    ...(typeof v.universe === "string" ? { universe: v.universe } : {}),
    totalScanned: v.totalScanned,
    expectedCount: v.expectedCount,
    matchedCount: v.matchedCount,
    ...(typeof v.pdfKey === "string" ? { pdfKey: v.pdfKey } : {}),
    ...(typeof v.xlsxKey === "string" ? { xlsxKey: v.xlsxKey } : {}),
    ...(typeof v.csvKey === "string" ? { csvKey: v.csvKey } : {}),
    ...(v.trigger === "manual" || v.trigger === "scheduled" ? { trigger: v.trigger } : {}),
    ...(typeof v.error === "string" ? { error: v.error } : {}),
    ...(typeof v.stored === "boolean" ? { stored: v.stored } : {}),
    ...(typeof v.delivered === "boolean" ? { delivered: v.delivered } : {}),
    ...(typeof v.storeError === "string" ? { storeError: v.storeError } : {}),
    ...(typeof v.deliverError === "string" ? { deliverError: v.deliverError } : {}),
    ...(typeof v.reportId === "string" ? { reportId: v.reportId } : {}),
  };
}

/** Issue #2129: a projection failure never fails the run, but it
 * must leave a worker-log trace naming the chain, the stage, and
 * the cause — the silent no-op is what made vanished runs
 * untraceable from the panel's empty history. */
function warnUnprojected(chainId: string, stage: string, result: { projected: boolean; error?: string }): void {
  if (!result.projected) {
    structuredLog.warn("screener projection failed", {
      chainId,
      stage,
      error: result.error ?? "unknown",
    });
  }
}

/** Project legs best-effort (a projection failure never fails the run). */
async function projectBestEffort(
  shardStore: ShardJobStore | null,
  tenantId: string | undefined,
  chainId: string,
  legs: LegOutcome[],
  nowMs: number,
): Promise<{ projected: boolean; error?: string }> {
  // Issue #2129: name the no-op cause — a bare { projected: false }
  // left vanished runs traceless (empty history, no log line).
  if (!shardStore) return { projected: false, error: "shard store unavailable" };
  if (!tenantId) return { projected: false, error: "tenantId missing" };
  try {
    const result = await projectLegOutcomes({
      store: shardStore,
      tenantId,
      workspaceId: WORKFLOW_WORKSPACE_ID,
      chainId,
      legs,
      nowMs,
      writer: WORKFLOW_PROVENANCE_WRITER,
      provenanceSourceDo: "ScreenerWorkflow",
    });
    return { projected: result.projected, error: result.error };
  } catch (err) {
    return {
      projected: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---- engine-path mapping --------------------------------------------------

/** Node paths by kind for a per-run screener definition (the nested six-node chain). */
export function screenerNodePaths(definition: JobDefinition): Map<ScreenerNodeKind, string> {
  const paths = new Map<ScreenerNodeKind, string>();
  const walk = (node: JobDefinition["root"], path: string): void => {
    paths.set(node.kind as ScreenerNodeKind, path);
    (node.children ?? []).forEach((child, i) => walk(child, path === "" ? `${i}` : `${path}/${i}`));
  };
  walk(definition.root, "");
  return paths;
}

/** The artifact key for a node's composed stage-output map (`root` for the feed node). */
export function screenerStageOutputKey(nodePath: string): string {
  return `${nodePath === "" ? "root" : nodePath}/stage-output`;
}

type StageOutputMap = Record<string, Record<string, unknown>>;

interface LedgerEntry {
  stage: StageName;
  status: "completed" | "failed" | "timed_out" | "cancelled" | "stopped" | "skipped" | "retired";
  error?: string;
}

/** The ledger entries for one shard, from the run's stage views. */
function ledgerForShard(stages: JobStageView[], shardId: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const view of stages) {
    if (!view.kind) continue;
    const stageName = vocabularyStageForNodeKind(view.kind);
    if (stageName === null) continue;
    for (const unit of view.units) {
      if (unit.unitId !== shardId) continue;
      entries.push({
        stage: stageName,
        status: unit.status as LedgerEntry["status"],
        ...(unit.error !== undefined ? { error: unit.error } : {}),
      });
    }
  }
  return entries;
}

/**
 * A ledger status onto a shard outcome status. The ledger
 * carries terminal states the shard vocabulary does not
 * (cancelled / stopped / skipped / retired): the shard did
 * not complete, so it fails — the ledger error (or stage)
 * names the cause. Only timed_out survives as its own
 * outcome; a completed ledger entry never reaches here.
 */
function shardStatusFromLedger(status: LedgerEntry["status"]): "failed" | "timed_out" {
  return status === "timed_out" ? "timed_out" : "failed";
}

/** The worst ledger status for a shard: timed_out > failed > completed. */
function worstLedgerStatus(entries: LedgerEntry[]): LedgerEntry | null {
  const failed = entries.find((e) => e.status === "timed_out") ??
    entries.find((e) => e.status === "failed");
  if (failed) return failed;
  return entries.find((e) => e.status === "completed") ?? entries[0] ?? null;
}

function stringField(value: Record<string, unknown> | null, name: string): string | undefined {
  const v = value?.[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function formatKey(
  output: Record<string, unknown> | null,
  format: "pdf" | "xlsx" | "csv",
): string | undefined {
  const served = output?.servedReport as Record<string, unknown> | undefined;
  const formats = Array.isArray(served?.formats) ? (served.formats as Record<string, unknown>[]) : [];
  const servedKey = formats.find((f) => f.format === format)?.key;
  if (typeof servedKey === "string" && servedKey.length > 0) return servedKey;
  const result = output?.result as Record<string, unknown> | undefined;
  const resultKey = result?.[`${format}Key`];
  if (typeof resultKey === "string" && resultKey.length > 0) return resultKey;
  const goal = output?.goalResult as Record<string, unknown> | undefined;
  const goalKey = goal?.[`${format}Key`];
  if (typeof goalKey === "string" && goalKey.length > 0) return goalKey;
  return undefined;
}

/**
 * Map one shard's deepest stage-output artifact + ledger entries
 * onto its ShardOutcome. Never invents completed: a shard
 * whose screen never ran is failed, with the reason named.
 */
export function shardOutcomeFromStageOutputs(
  shardId: string,
  deepest: Record<string, unknown> | null,
  ledgerEntries: LedgerEntry[],
): ShardOutcome {
  const timestamp = stringField(deepest, "timestamp");
  const base: ShardOutcome = {
    shardId,
    status: "failed",
    ...(timestamp ? { timestamp } : {}),
  };
  const worst = worstLedgerStatus(ledgerEntries);
  // Duplicate: the feed stage passed the suppression through
  // untouched, so the deliver output carries it too.
  if (deepest?.duplicate === true) {
    const dup = deepest.dupResult as Record<string, unknown> | undefined;
    const message =
      typeof dup?.discoveryMessage === "string"
        ? dup.discoveryMessage
        : "Duplicate scheduled delivery suppressed by the (runId, destination) delivery suppression.";
    return { ...base, status: "failed", error: message };
  }
  // Goal leg: only "failed" fails the shard, loudly; "partial"
  // is success with qualification (the #462 vocabulary).
  const goal = deepest?.goalResult as Record<string, unknown> | undefined;
  if (goal && goal.status === "failed") {
    const kind = typeof goal.goalKind === "string" ? goal.goalKind : "goal";
    const outlook = typeof goal.outlook === "string" ? goal.outlook : "unknown";
    const message = typeof goal.message === "string" ? `: ${goal.message}` : ".";
    return { ...base, status: "failed", error: `Goal screen failed (${kind}/${outlook})${message}` };
  }
  const screenResult = deepest?.screenResult as Record<string, unknown> | undefined;
  const hasAnalysis = screenResult !== undefined && screenResult !== null;
  const started = deepest !== null || ledgerEntries.length > 0;
  if (!started) {
    return { ...base, status: "failed", error: "Shard never ran: no stage output and no ledger entry for this shard." };
  }
  if (!hasAnalysis) {
    // The shard started but its screen never executed: either
    // a ledger failure names the cause, or the run failed
    // before the shard reached analysis.
    if (worst && worst.status !== "completed") {
      return { ...base, status: shardStatusFromLedger(worst.status), error: worst.error ?? `Shard failed at ${worst.stage}.` };
    }
    return {
      ...base,
      status: "failed",
      error: "Shard never reached analysis: the run failed before its screen executed.",
    };
  }
  // hasAnalysis implies deepest !== null (screenResult reads
  // deepest.screenResult), but TS cannot narrow through the
  // aliased boolean — the guard below is the explicit proof.
  if (deepest === null) {
    return { ...base, status: "failed", error: "Shard never ran: no stage output and no ledger entry for this shard." };
  }
  // The screen ran: map its flags. A ledger failure AFTER
  // analysis (store/serve/deliver) still fails the shard —
  // the screen's flags are not the run's verdict.
  if (worst && worst.status !== "completed") {
    return { ...base, status: shardStatusFromLedger(worst.status), error: worst.error ?? `Shard failed at ${worst.stage}.` };
  }
  const totalScanned = screenResult.totalScanned;
  const matchedCount = screenResult.matchedCount;
  // The stage output is persisted data, not a trusted value:
  // counts that are not numbers mean the screen's output is
  // malformed — fail the shard loudly, never complete it
  // with coerced zeros (the retired flow validated the child
  // output with asShardScreenResult the same way).
  if (
    typeof totalScanned !== "number" ||
    typeof matchedCount !== "number" ||
    typeof deepest.expectedCount !== "number"
  ) {
    return {
      ...base,
      status: "failed",
      error: "Shard stage output malformed: analysis counts are not numbers.",
    };
  }
  const expectedCount = deepest.expectedCount;
  const result = deepest.result as Record<string, unknown> | undefined;
  return {
    shardId,
    status: "completed",
    ...(timestamp ? { timestamp } : {}),
    totalScanned,
    expectedCount,
    matchedCount,
    ...(formatKey(deepest, "pdf") ? { pdfKey: formatKey(deepest, "pdf")! } : {}),
    ...(formatKey(deepest, "xlsx") ? { xlsxKey: formatKey(deepest, "xlsx")! } : {}),
    ...(formatKey(deepest, "csv") ? { csvKey: formatKey(deepest, "csv")! } : {}),
    ...(typeof deepest.stored === "boolean" ? { stored: deepest.stored } : {}),
    ...(typeof deepest.delivered === "boolean" ? { delivered: deepest.delivered } : {}),
    ...(typeof deepest.storeError === "string" ? { storeError: deepest.storeError } : {}),
    ...(typeof deepest.deliverError === "string" ? { deliverError: deepest.deliverError } : {}),
    ...(stringField(deepest, "reportId") ??
      stringField(result ?? null, "reportId") ??
      stringField(goal ?? null, "reportId")
      ? {
          reportId:
            stringField(deepest, "reportId") ??
            stringField(result ?? null, "reportId") ??
            stringField(goal ?? null, "reportId"),
        }
      : {}),
  };
}

/** Stage transitions from the ledger: only stages with an entry are recorded. */
function stageTransitionsForLedger(
  entries: LedgerEntry[],
  outcome: ShardOutcome,
  atMs: number,
): StageTransition[] {
  if (entries.length === 0) {
    return stageTransitionsForShard(outcome, atMs);
  }
  const transitions: StageTransition[] = [];
  for (const kind of SCREENER_STAGE_KINDS) {
    const stage = vocabularyStageForNodeKind(kind);
    if (stage === null) continue;
    const entry = entries.find((e) => e.stage === stage);
    if (!entry) continue;
    transitions.push({
      stage,
      outcome: entry.status === "completed" ? "completed" : "failed",
      atMs,
    });
  }
  return transitions;
}

// ---- composer + finalize --------------------------------------------------

export interface ScreenerCollationDeps {
  control: JobPipelineControl;
  stores: JobPipelineStores;
  shardStore: ShardJobStore | null;
  storeParentReport?: (
    input: ParentScreenReportInput,
    userLogin: string,
  ) => Promise<ParentScreenReportOutcome>;
  nowMs: () => number;
  /**
   * Issue #2428 (Agent Mesh S17): trace hop recorder for
   * this run's projection. Optional and purely
   * observational; absent → no projection hops (the trace
   * break the registry records for unwired runners). A
   * throwing recorder never fails the finalize; call sites
   * swallow (the #1743 rule).
   */
  traceHop?: (
    command: WorkflowJobCommand,
    event: { kind: "workflow-step" | "projection"; operation: string },
  ) => Promise<void>;
}

export interface ScreenerFinalizeDeps {
  shardStore: ShardJobStore | null;
  storeParentReport?: (
    input: ParentScreenReportInput,
    userLogin: string,
  ) => Promise<ParentScreenReportOutcome>;
  stores?: JobPipelineStores;
  nowMs: () => number;
  /**
   * Issue #2428 (Agent Mesh S17): trace hop recorder for
   * this run's projection (see ScreenerCollationDeps).
   */
  traceHop?: (
    command: WorkflowJobCommand,
    event: { kind: "workflow-step" | "projection"; operation: string },
  ) => Promise<void>;
}

/**
 * Compose the collation for a settled engine run: read the
 * persisted stage-output artifacts + the stage ledger, map
 * each shard, and finalize (project-final legs + parent
 * canonical row + collation artifact).
 */

// ---- surviving flow pieces (#4192) -------------------------------------------
// The pure request/response vocabulary + request builders from the retired
// child-workflow flow (screenerWorkflowFlow.ts, deprecated 2026-11-12).
// They survive because the in-memory adapter + the goal/mesh test suites
// still drive screens through canned ScreenRunners: the vocabulary is
// the contract those fixtures speak, and the builders are pure.
// The deprecated file imports them back; nothing else imports the
// deprecated file.

/** The screen request one shard executes (structural subset of the agent's request). */
export interface ShardScreenRequest {
  trigger: "manual" | "scheduled";
  universe?: string;
  symbols?: unknown[];
  provider?: string;
  filters?: Record<string, unknown>;
  userLogin: string;
  environment?: "TEST" | "PROD";
  portfolioContext?: boolean;
  maxItems?: number;
  maxSymbols?: number;
  /**
   * Issue #2860 (Factor 14): the workflow run's W3C traceparent,
   * carried from the WorkflowJobCommand so the funnel trace_id is
   * the workflow trace-id (funnelTraceIdForRun). Absent on runs
   * that did not arrive through the workflow (manual/scheduled
   * direct runs keep a fresh UUID funnel id).
   */
  traceparent?: string;
}

/**
 * Issue #1996 (#1972 slice 1) — the goal-screen request one
 * shard executes. Mirrors the agent's runGoalScreen inputs;
 * the idempotency key is the RUN's key (the parent job id),
 * so a retried child step re-adopts the agent ledger record
 * instead of screening twice.
 */
export interface GoalShardRequest {
  scenario: ScenarioDefinition;
  scenarioSource: "built" | "stored";
  trigger: "manual" | "scheduled";
  idempotencyKey: string;
  userLogin: string;
  environment?: "TEST" | "PROD";
  assetClasses?: ("stocks" | "options")[];
  symbols?: string[];
  provider?: "yahoo";
  providerFallback?: {
    from: "etrade";
    reason: string;
  };
}

/** Executes one shard's screen (the agent stub, adapted, in production). */
export interface ScreenRunner {
  runScreen(req: ShardScreenRequest): Promise<ShardScreenResult>;
  /**
   * Issue #1996 — goal-screen execution. Optional so existing
   * market runners keep compiling; a goal command reaching a
   * runner without it FAILS CLOSED (runShardFlow throws) —
   * a goal run must never silently execute as a market screen.
   */
  runGoalScreen?(req: GoalShardRequest): Promise<ShardScreenResult>;
}

/** Dependencies the flows receive (all injected; no bindings here). */
export interface ScreenerWorkflowDeps {
  screenRunner: ScreenRunner;
  /** Projection store, or null when unbound (projection skipped, run continues). */
  shardStore: ShardJobStore | null;
  /**
   * Canonical-report persist (the route's persist, via the
   * owner's door). Payload is the OPAQUE full agent result
   * (the child's `full`, falling back to the summary when a
   * runner provides none) — the flow never inspects it.
   * Keyed by screener:<timestamp>, so a retried store step
   * overwrites the same canonical row (idempotent).
   * Issue #1997: a door MAY return the canonical report id
   * (the goal door does); the flow surfaces it on the shard
   * row so the panel can fetch the stored run by id. The
   * market door returns void (no id to surface).
   */
  storeReport: (payload: unknown, userLogin: string) => Promise<string | void>;
  /**
   * Issue #2910 (G3): the PARENT canonical row's persist
   * (the orchestrator's parent door in production). The
   * payload is the collation + linkage, never bulk data:
   * the children already stored their full rows. Optional
   * so older fakes keep compiling: when absent the parent
   * flow skips the store step and the collation simply
   * carries no parentReport outcome. A throwing store is
   * caught by the flow and recorded as a storeError — the
   * screen outcome stands, exactly like a child store
   * error. The parent store NEVER delivers.
   */
  storeParentReport?: (
    input: ParentScreenReportInput,
    userLogin: string,
  ) => Promise<ParentScreenReportOutcome>;
  /**
   * Tracked-pipeline delivery (the route's deliver decision,
   * via the owner's door). Same opaque payload. The door
   * stamps a deterministic deliveryId
   * (workflow:<jobId>:<shardId>) so re-delivery converges
   * in the outcome sink.
   */
  deliverOutcome: (payload: unknown, userLogin: string) => Promise<void>;
  nowMs: () => number;
  /**
   * Issue #2428 (Agent Mesh S17): trace hop recorder for this
   * run's steps. Optional and purely observational: called
   * AFTER a step's journaled result returns (never inside a
   * step callback, so durable replay cannot re-run it as a
   * side effect — and the recorder's deterministic spans make
   * a re-record converge in the store regardless). Absent →
   * no step hops: the trace break the registry records for
   * unwired runners. A throwing recorder must never fail a
   * step; call sites go through traceStep(), which swallows.
   */
  traceHop?: (
    command: WorkflowJobCommand,
    event: { kind: "workflow-step" | "projection"; operation: string },
  ) => Promise<void>;
  /**
   * Issue #2530 — whether the SCREENER_ND_MODE gate is open
   * in this run's environment (the workflow class resolves
   * it from env via src/config/screenerModes.ts). Consulted
   * ONLY for non-deterministic commands: absent/false refuses
   * them in the parent flow, so a direct workflow start
   * cannot bypass the flag. Deterministic runs never read it.
   */
  ndModeEnabled?: boolean;
  /**
   * Issue #2530 — the interpretation port for ND runs
   * (production: the gateway-backed interpreter the workflow
   * class builds from env; absent when no model seam is
   * configured). An ND command reaching a flow without one
   * FAILS CLOSED — the parent never invents criteria and
   * never falls back to a deterministic execution the caller
   * did not ask for.
   */
  intentInterpreter?: ScreenIntentInterpreter;
  /**
   * Issue #2530 — the mas_events audit sink for ND runs
   * (production: the orchestrator's workflow-door audit
   * method). Required for ND runs: the interpretation record
   * is a journaled step, and a run whose audit cannot be
   * recorded fails before any shard executes — no audit, no
   * execution.
   */
  auditInterpretation?: (record: ScreenInterpretationAuditRecord) => Promise<void>;
}

/** Shard row summary: what a child's row (and the parent's collation) carries. */
export interface ShardRowSummary {
  shardId: string;
  status: "completed" | "failed" | "timed_out";
  totalScanned: number;
  expectedCount: number;
  matchedCount: number;
  pdfKey?: string;
  xlsxKey?: string;
  csvKey?: string;
  error?: string;
  timestamp: string;
}

/** Build a shard row summary from a screen result. */
export function shardSummaryFromResult(
  shardId: string,
  result: ShardScreenResult,
): ShardRowSummary {
  return {
    shardId,
    status: result.success ? "completed" : "failed",
    totalScanned: result.totalScanned,
    expectedCount: result.expectedCount,
    matchedCount: result.matchedCount,
    ...(result.pdfKey ? { pdfKey: result.pdfKey } : {}),
    ...(result.xlsxKey ? { xlsxKey: result.xlsxKey } : {}),
    ...(result.csvKey ? { csvKey: result.csvKey } : {}),
    ...(result.error ? { error: result.error } : {}),
    timestamp: result.timestamp,
  };
}

/** Build a shard command from a parent command + shard descriptor. */
export function shardCommandFor(
  parent: WorkflowJobCommand,
  shard: WorkflowJobCommand["shards"][number],
): WorkflowJobCommand {
  return {
    ...parent,
    role: "shard",
    parentJobId: parent.jobId,
    shard,
    shards: [shard],
    jobId: `${parent.jobId}:shard:${shard.shardId}`,
  };
}

/** Issue #1996 — the goal-screen request one shard executes. */
export function goalShardRequest(
  command: WorkflowJobCommand,
): GoalShardRequest {
  const g = command.goalScreen;
  if (!g) {
    throw new Error("goalShardRequest called for a command without a goalScreen descriptor.");
  }
  return {
    scenario: g.scenario,
    scenarioSource: g.scenarioSource,
    trigger: command.trigger,
    idempotencyKey: command.parentJobId ?? command.jobId,
    userLogin: command.userLogin,
    ...(command.environment ? { environment: command.environment } : {}),
    ...(g.assetClasses ? { assetClasses: g.assetClasses } : {}),
    ...(g.symbols ? { symbols: g.symbols } : {}),
    ...(g.provider ? { provider: g.provider } : {}),
    ...(g.providerFallback ? { providerFallback: g.providerFallback } : {}),
  };
}

/**
 * Issue #1996 — map a goal-driven screen result onto the
 * shard result shape the parent collates. Counts: a goal run
 * scans stocks + option underlyings; hits are the matches.
 * `full` is the OPAQUE envelope the child's store/deliver
 * steps consume (task id + scenario source + trigger +
 * result); it is STRIPPED from the child output before
 * return, exactly like market results. A "partial" goal run
 * is success with qualification (the #462 vocabulary), never
 * a failure; only "failed" fails the shard, loudly.
 */
export function goalResultToShardResult(input: {
  taskId: string;
  scenarioSource: "built" | "stored";
  trigger: "manual" | "scheduled";
  result: GoalDrivenScreenResult;
  /** Issue #1998: caller run id (D2) the run's captures are keyed by. */
  idempotencyKey?: string;
  /** Issue #1571: carried so the store door can stamp it when the result lacks it. */
  provider?: "yahoo";
  providerFallback?: {
    from: "etrade";
    reason: string;
  };
}): ShardScreenResult {
  const { result } = input;
  const totalScanned =
    result.counts.stocksScanned + result.counts.optionsUnderlyingsScanned;
  return {
    success: result.status !== "failed",
    timestamp: result.completedAt,
    totalScanned,
    expectedCount: totalScanned,
    matchedCount: result.counts.hits,
    ...(result.pdfKey ? { pdfKey: result.pdfKey } : {}),
    ...(result.xlsxKey ? { xlsxKey: result.xlsxKey } : {}),
    ...(result.csvKey ? { csvKey: result.csvKey } : {}),
    ...(result.status === "failed"
      ? { error: `Goal screen failed (${result.goalKind}/${result.outlook}).` }
      : {}),
    full: {
      taskId: input.taskId,
      scenarioSource: input.scenarioSource,
      trigger: input.trigger,
      result,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.providerFallback ? { providerFallback: input.providerFallback } : {}),
    },
  };
}

/** The screen request one shard executes. */
export function shardScreenRequest(
  command: WorkflowJobCommand,
): ShardScreenRequest {
  const shard = command.shard;
  return {
    trigger: command.trigger,
    ...(shard?.universe ? { universe: shard.universe } : {}),
    ...(shard?.symbols ? { symbols: shard.symbols } : {}),
    ...(command.provider ? { provider: command.provider } : {}),
    ...(command.filters ? { filters: command.filters } : {}),
    userLogin: command.userLogin,
    ...(command.environment ? { environment: command.environment } : {}),
    ...(command.portfolioContext !== undefined
      ? { portfolioContext: command.portfolioContext }
      : {}),
    ...(command.maxItems !== undefined ? { maxItems: command.maxItems } : {}),
    ...(command.maxSymbols !== undefined ? { maxSymbols: command.maxSymbols } : {}),
    ...(command.traceparent ? { traceparent: command.traceparent } : {}),
  };
}

export async function composeScreenerCollation(
  deps: ScreenerCollationDeps,
  command: WorkflowJobCommand,
  runId: string,
  outcome: JobRunOutcome,
): Promise<WorkflowCollation> {
  const nowMs = deps.nowMs();
  const view = await deps.control.getJob(command.jobId);
  const paths = screenerNodePaths(view.definition);
  const startedAtMs = view.instance?.runStartedAt
    ? Date.parse(view.instance.runStartedAt)
    : nowMs;
  // Read each node's composed stage-output artifact; a read
  // failure is treated as absent for that node (the ledger
  // still names the failure) and recorded on the shard.
  // Shape: a sharded run writes a per-unit map keyed by unit
  // id; a monolith run writes the single unit's output FLAT
  // (top-level `timestamp`, no per-unit wrapper) — sniffed
  // per node, never assumed from the definition.
  const maps = new Map<ScreenerNodeKind, StageOutputMap>();
  const flat = new Map<ScreenerNodeKind, Record<string, unknown>>();
  const readErrors = new Map<ScreenerNodeKind, string>();
  for (const kind of SCREENER_STAGE_KINDS) {
    const path = paths.get(kind);
    if (path === undefined) continue;
    try {
      const value = await deps.stores.artifacts.getArtifact(runId, screenerStageOutputKey(path));
      if (value && typeof value === "object") {
        if (typeof (value as Record<string, unknown>).timestamp === "string") {
          flat.set(kind, value as Record<string, unknown>);
        } else {
          maps.set(kind, value as StageOutputMap);
        }
      }
    } catch (err) {
      readErrors.set(kind, err instanceof Error ? err.message : String(err));
    }
  }
  const outcomes: ShardOutcome[] = [];
  const stageTransitions: StageTransition[] = [];
  // Monolith: a definition with <= 1 shard runs ONE unit whose
  // id is engine-generated (the run id), not the shard id — so
  // neither the stage-output maps nor the ledger are keyed by
  // the shard id. When the command has exactly one shard and
  // the view carries exactly one unit id, that unit IS the
  // shard's unit. (A sharded run keeps per-shard keys.)
  const unitIds = new Set<string>();
  for (const stage of view.stages) {
    for (const unit of stage.units) unitIds.add(unit.unitId);
  }
  const monolithUnitId =
    command.shards.length === 1 && unitIds.size === 1 ? [...unitIds][0] : null;
  for (const shard of command.shards) {
    const lookupKey = monolithUnitId ?? shard.shardId;
    const entries = ledgerForShard(view.stages, lookupKey);
    let deepest: Record<string, unknown> | null = null;
    for (const kind of SCREENER_STAGE_KINDS) {
      const flatEntry = flat.get(kind);
      if (flatEntry) {
        deepest = flatEntry;
        continue;
      }
      const entry = maps.get(kind)?.[lookupKey];
      if (entry && typeof entry === "object") deepest = entry;
    }
    const shardOutcome = shardOutcomeFromStageOutputs(shard.shardId, deepest, entries);
    if (deepest === null && readErrors.size > 0 && !shardOutcome.error?.includes("never ran")) {
      // An artifact read failed and the shard has no other
      // signal: name the read failure, never a silent gap.
      const first = [...readErrors.values()][0];
      outcomes.push({ ...shardOutcome, error: `${shardOutcome.error ?? "Shard failed."} (stage-output read failed: ${first})` });
    } else {
      outcomes.push(shardOutcome);
    }
    stageTransitions.push(...stageTransitionsForLedger(entries, shardOutcome, nowMs));
  }
  const collation = await finalizeScreenerCollation(
    {
      shardStore: deps.shardStore,
      storeParentReport: deps.storeParentReport,
      stores: deps.stores,
      nowMs: deps.nowMs,
      ...(deps.traceHop ? { traceHop: deps.traceHop } : {}),
    },
    {
      command,
      outcomes,
      lifecycleTransitions: [
        { lifecycle: "Idle", atMs: startedAtMs },
        { lifecycle: "Running", atMs: startedAtMs },
      ],
      stageTransitions,
      screenMode: command.screenMode ?? "deterministic",
      startedAtMs,
      runId,
    },
  );
  // The run-level error is the fallback when no shard names
  // one (the run failed but every shard's signal is empty).
  if (collation.lifecycle === "Failed" && !collation.error && outcome.error) {
    collation.error = outcome.error;
  }
  return collation;
}

export interface ScreenerFinalizeArgs {
  command: WorkflowJobCommand;
  outcomes: ShardOutcome[];
  lifecycleTransitions: Array<{ lifecycle: WorkflowRunLifecycle; atMs: number }>;
  stageTransitions: StageTransition[];
  screenMode: ScreenMode;
  startedAtMs: number;
  /** When set, the collation is written as an artifact on this run. */
  runId?: string;
}

/**
 * The flow's tail, shared by the engine composer and the ND
 * refusal path: collate → linkage → project-final legs →
 * store-parent → (when a runId is given) collation artifact.
 * Projection and parent-store failures never fail the run:
 * a failed project or store is recorded in the result and
 * the run continues.
 */
export async function finalizeScreenerCollation(
  deps: ScreenerFinalizeDeps,
  args: ScreenerFinalizeArgs,
): Promise<WorkflowCollation> {
  const { command, outcomes, stageTransitions } = args;
  const nowMs = deps.nowMs();
  const workflowId = workflowIdForJob(command.jobId);
  const lifecycleTransitions = [...args.lifecycleTransitions];
  if (outcomes.some((o) => o.status !== "completed")) {
    lifecycleTransitions.push({ lifecycle: "BudgetConstrained", atMs: nowMs });
  }
  const collation: WorkflowCollation = collateShards(
    command.jobId,
    workflowId,
    outcomes,
    lifecycleTransitions,
    stageTransitions,
  );
  lifecycleTransitions.push({
    lifecycle: collation.lifecycle,
    atMs: nowMs,
  });
  collation.lifecycleTransitions = [...lifecycleTransitions];
  // Issue #2530: the mode the run executed in, on the run's
  // collation record (always set by the finalize tail).
  collation.screenMode = args.screenMode;
  // Issue #2910 (G3): parent/child linkage, set before
  // projection so the projected parent row carries it too.
  // Market shards link by canonical run id
  // (`screener:<timestamp>`); goal shards link by report
  // id (their rows key on `goal-screen:<taskId>`, not on a
  // timestamp, so no run id is derived for them).
  collation.childRunIds = command.goalScreen
    ? []
    : outcomes
        .map((o) => (o.timestamp ? `screener:${o.timestamp}` : null))
        .filter((id): id is string => id !== null);
  collation.childReportIds = outcomes
    .map((o) => o.reportId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  // Project the final parent row + one row per shard. The
  // collation already carries the final lifecycle (computed
  // from the child outputs' stored flags) and the error maps,
  // so this single write closes the run — no second
  // project-close step. The parent collates what the engine
  // did, and (since #2910) stores one parent canonical row
  // from that collation in the step below. It never delivers.
  const legs: LegOutcome[] = [
    {
      stepId: "parent",
      capabilityId: SCREENER_WORKFLOW_CAPABILITY,
      stage: "deliver",
      status: collation.lifecycle === "Failed" ? "failed" : "completed",
      detail: collationDetail(collation),
      result: { shardJobIds: [command.jobId], result: collation },
    },
  ];
  // One row per shard. A shard the engine already projected
  // replays as a no-op (same status); a shard with no row
  // (projection failed, errored before projection, or timed
  // out) gains its record here.
  for (const o of outcomes) {
    if (o.status === "completed") {
      legs.push({
        stepId: o.shardId,
        capabilityId: SCREENER_WORKFLOW_CAPABILITY,
        stage: "analysis",
        status: "completed",
        detail: `Shard ${o.shardId} completed.`,
        ...(o.workflowRunId ? { workflowRunId: o.workflowRunId } : {}),
        result: {
          shardJobIds: [`shard:${o.shardId}`],
          result: {
            shardId: o.shardId,
            status: "completed",
            totalScanned: o.totalScanned ?? 0,
            expectedCount: o.expectedCount ?? 0,
            matchedCount: o.matchedCount ?? 0,
            pdfKey: o.pdfKey,
            ...(o.xlsxKey ? { xlsxKey: o.xlsxKey } : {}),
            ...(o.csvKey ? { csvKey: o.csvKey } : {}),
            stored: o.stored ?? false,
            delivered: o.delivered ?? false,
            ...(o.storeError ? { storeError: o.storeError } : {}),
            ...(o.deliverError ? { deliverError: o.deliverError } : {}),
          },
        },
      });
      continue;
    }
    legs.push({
      stepId: o.shardId,
      capabilityId: SCREENER_WORKFLOW_CAPABILITY,
      stage: "analysis",
      status: "failed",
      detail:
        o.status === "timed_out"
          ? `Shard ${o.shardId} timed out: ${o.error ?? "deadline exceeded"}.`
          : `Shard ${o.shardId} failed: ${o.error ?? "screen failed"}`,
      ...(o.workflowRunId ? { workflowRunId: o.workflowRunId } : {}),
      result: {
        shardJobIds: [`shard:${o.shardId}`],
        result: {
          shardId: o.shardId,
          status: o.status,
          ...(o.status === "timed_out" ? { timedOut: true } : {}),
          totalScanned: o.totalScanned ?? 0,
          expectedCount: o.expectedCount ?? 0,
          matchedCount: o.matchedCount ?? 0,
          error: o.error,
        },
      },
    });
  }
  warnUnprojected(
    command.jobId,
    "deliver",
    await projectBestEffort(deps.shardStore, command.tenantId, command.jobId, legs, nowMs),
  );
  // Issue #2428 (Agent Mesh S17): one "projection" hop per
  // shard leg + one for the final parent leg, mirroring the
  // retired child flow's project step (project-shard, one
  // per child) and the parent flow's project-final. The
  // mesh read surface assembles one trace from these hops +
  // the rows; without them the trace breaks at projection.
  // Best-effort: a throwing recorder never fails the run.
  if (deps.traceHop) {
    for (const o of outcomes) {
      try {
        await deps.traceHop(command, { kind: "projection", operation: "project-shard" });
      } catch {
        // Tracing degrades; the run does not (the #1743 rule).
      }
    }
    try {
      await deps.traceHop(command, { kind: "projection", operation: "project-final" });
    } catch {
      // Tracing degrades; the run does not (the #1743 rule).
    }
  }

  // Issue #2910 (G3): one canonical mas_reports row for the
  // parent run (generationId = jobId), carrying the
  // collation summary, partial qualification, per-format
  // keys, and the child linkage above — summary only, no
  // bulk data, no fabricated results. Best-effort like a
  // child store: a store error is recorded on the
  // collation and the run continues; when no parent store
  // is configured the step is skipped and the collation
  // simply carries no parentReport outcome. The parent
  // store never delivers (children own delivery).
  if (deps.storeParentReport) {
    try {
      collation.parentReport = await deps.storeParentReport(
        {
          jobId: command.jobId,
          userLogin: command.userLogin,
          trigger: command.trigger,
          goalScreen: Boolean(command.goalScreen),
          collation,
          childRunIds: collation.childRunIds ?? [],
          childReportIds: collation.childReportIds ?? [],
          createdAt: new Date(nowMs).toISOString(),
        },
        command.userLogin,
      );
    } catch (err) {
      collation.parentReport = {
        stored: false,
        storeError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (args.runId && deps.stores) {
    await deps.stores.artifacts.putArtifact(args.runId, SCREENER_COLLATION_ARTIFACT_KEY, collation);
  }
  return collation;
}

/**
 * Announce: the parent row exists from the start, so
 * jobs/history shows progress while the run executes. The
 * submitted leg keys on result.jobId (the projector's
 * submitted rule); the final leg keys on shardJobIds —
 * both resolve to the parent job id, so announce and
 * final are versions of ONE row, not two rows.
 */
export async function projectScreenerAnnounce(
  deps: { shardStore: ShardJobStore | null; nowMs: () => number },
  command: WorkflowJobCommand,
  screenMode: ScreenMode = "deterministic",
): Promise<{ projected: boolean; error?: string }> {
  const result = await projectBestEffort(
    deps.shardStore,
    command.tenantId,
    command.jobId,
    [
      {
        stepId: "parent",
        capabilityId: SCREENER_WORKFLOW_CAPABILITY,
        stage: "feed",
        status: "submitted",
        detail: `Workflow started: ${command.shards.length} shard(s), trigger ${command.trigger}, mode ${screenMode}.`,
        result: { jobId: command.jobId },
      },
    ],
    deps.nowMs(),
  );
  warnUnprojected(command.jobId, "feed", result);
  return result;
}
