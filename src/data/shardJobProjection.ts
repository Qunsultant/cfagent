/**
 * Issue #1676 ([AGENTIC] Slice 2, shard jobs projection) —
 * projection + reconciliation (R5). Port-only: this module
 * knows no store client, no binding, and no query language.
 * It is the single place that turns a leg outcome into a
 * versioned job row, and the single place that converges
 * rails state into the projection.
 *
 * DO-first: the durable object owns the authoritative state;
 * this module only mirrors what a run (or a reconcile pass)
 * reports. A projection failure never fails the run: the
 * projector catches, reports, and returns, and the next
 * reconcile pass converges. Reconciliation is a deliberate
 * operator/maintenance invocation only — never boot, deploy,
 * or tick logic.
 *
 * Honest limitation: inline outcomes have no durable source
 * beyond the run itself, so they are projected at completion
 * time. Reconciliation can only advance rows the projector
 * already created (submitted rows) or create version-1 rows
 * for rails jobs it can see; it cannot recover an inline
 * outcome that was never projected. That is why the run path
 * projects synchronously at completion and why a projector
 * failure is surfaced in the result, not swallowed silently.
 *
 * Privacy: a submitted row stores only the job id and
 * detail. A submission spec may carry operator identity or
 * query text, so it is never copied into resultJson — the
 * projector reads jobId and detail out of a submission
 * record and drops everything else.
 */
import type {
  LegOutcome,
  ShardJobRow,
  ShardJobStatus,
  ShardJobStore,
} from "./shardJobPorts";

/** Cap on any single resultJson summary (chars, before the marker). */
export const SHARD_JOB_RESULT_JSON_MAX = 8000;

const TRUNCATION_MARKER = "[truncated]";

function capJson(json: string): string {
  if (json.length <= SHARD_JOB_RESULT_JSON_MAX) return json;
  return json.slice(0, SHARD_JOB_RESULT_JSON_MAX) + TRUNCATION_MARKER;
}

function safeJson(value: unknown): string {
  try {
    return capJson(JSON.stringify(value ?? null));
  } catch {
    return '"[unserializable]"';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Job keys for one leg outcome. Completed legs report their
 * shard ids (one row per shard); a submitted leg reports its
 * rails job id; a failed leg has no job id, so it is keyed by
 * its step. Legs that did not run report no keys.
 */
export function jobKeysForOutcome(outcome: LegOutcome): string[] {
  if (outcome.status === "completed") {
    const record = asRecord(outcome.result);
    const shardJobIds = record?.shardJobIds;
    if (Array.isArray(shardJobIds)) {
      const ids = shardJobIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      );
      if (ids.length > 0) return ids;
    }
    return [`leg:${outcome.stepId}`];
  }
  if (outcome.status === "submitted") {
    const record = asRecord(outcome.result);
    const jobId = record ? stringField(record, "jobId") : null;
    return [jobId ?? `leg:${outcome.stepId}`];
  }
  if (outcome.status === "failed") {
    return [`leg:${outcome.stepId}`];
  }
  return [];
}

/**
 * Capped outcome summary for one leg. Completed legs keep
 * the inner result payload; submitted legs keep only job id
 * and detail (never the spec); failed legs keep the detail.
 */
export function resultJsonForOutcome(outcome: LegOutcome): string {
  const record = asRecord(outcome.result);
  if (outcome.status === "submitted") {
    return safeJson({
      jobId: record ? stringField(record, "jobId") : null,
      detail: outcome.detail,
    });
  }
  if (outcome.status === "failed") {
    return safeJson({ detail: outcome.detail });
  }
  const inner = record ? record.result : undefined;
  return safeJson(inner ?? null);
}

export interface ProjectLegOutcomesInput {
  store: ShardJobStore;
  tenantId: string;
  workspaceId: string;
  chainId: string;
  legs: LegOutcome[];
  nowMs: number;
  writer: string;
  /**
   * Issue #1737: source durable object that owns the
   * authoritative state. Defaults to "ScheduledAgent" (the
   * slice-2 caller); workflow rows pass "ScreenerWorkflow"
   * so provenance names the actual writer.
   */
  provenanceSourceDo?: string;
}

export interface ProjectLegOutcomesResult {
  /** True when at least one job was projected or replay-skipped. */
  projected: boolean;
  projectedJobs: number;
  skippedJobs: number;
  /** First projector error, when any leg failed to project. */
  error?: string;
}

/**
 * Project a run's leg outcomes. Never throws: a per-leg
 * failure is collected into `error` and the remaining legs
 * still project. Replaying an already-projected status is a
 * no-op; a status change writes version+1 and preserves the
 * first-seen timestamp.
 */
export async function projectLegOutcomes(
  input: ProjectLegOutcomesInput,
): Promise<ProjectLegOutcomesResult> {
  let projectedJobs = 0;
  let skippedJobs = 0;
  const errors: string[] = [];
  for (const outcome of input.legs) {
    try {
      const keys = jobKeysForOutcome(outcome);
      if (keys.length === 0) continue;
      const status = outcome.status as ShardJobStatus;
      const resultJson = resultJsonForOutcome(outcome);
      for (const jobKey of keys) {
        const latest = await input.store.latestJob(
          input.tenantId,
          input.chainId,
          jobKey,
        );
        // Issue #2989: replaying the same status is a no-op —
        // UNLESS the leg carries a workflow run id the row lacks
        // (a child row projected before the parent's deliver leg
        // knew the child instance id). That fill is new
        // information, not a replay, so it writes version+1.
        const needsCorrelation =
          outcome.workflowRunId !== undefined &&
          latest?.workflowRunId !== outcome.workflowRunId;
        if (latest !== null && latest.status === status && !needsCorrelation) {
          skippedJobs += 1;
          continue;
        }
        await input.store.recordJob({
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          chainId: input.chainId,
          jobKey,
          version: (latest?.version ?? 0) + 1,
          status,
          stage: outcome.stage,
          capabilityId: outcome.capabilityId,
          detail: outcome.detail,
          resultJson,
          createdAtMs: latest?.createdAtMs ?? input.nowMs,
          updatedAtMs: input.nowMs,
          provenanceWriter: input.writer,
          provenanceSourceDo: input.provenanceSourceDo ?? "ScheduledAgent",
          provenanceSourceVersion: "1",
          ...(outcome.workflowRunId ? { workflowRunId: outcome.workflowRunId } : {}),
        });
        projectedJobs += 1;
      }
    } catch (err) {
      errors.push(
        `${outcome.stepId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return {
    projected: projectedJobs + skippedJobs > 0,
    projectedJobs,
    skippedJobs,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

/** One terminal rails job state handed to reconciliation. */
export interface RailsJobState {
  jobKey: string;
  chainId: string;
  status: "completed" | "failed";
  stage: string;
  capabilityId: string;
  detail: string;
  createdAtMs: number;
  updatedAtMs: number;
  resultJson?: string;
}

export interface ReconcileShardJobsInput {
  store: ShardJobStore;
  tenantId: string;
  workspaceId: string;
  nowMs: number;
  railsStates: RailsJobState[];
}

export interface ReconcileShardJobsReport {
  checked: number;
  reconciled: number;
  alreadyCurrent: number;
  errors: string[];
}

/**
 * Converge rails state into the projection. A submitted row
 * whose rails job reached a terminal state advances to that
 * state (version+1, first-seen time preserved); a rails job
 * the projector never saw creates a version-1 row; an
 * already-current row is untouched. Per-record failures are
 * collected, never thrown.
 */
export async function reconcileShardJobs(
  input: ReconcileShardJobsInput,
): Promise<ReconcileShardJobsReport> {
  let reconciled = 0;
  let alreadyCurrent = 0;
  const errors: string[] = [];
  for (const state of input.railsStates) {
    try {
      const latest = await input.store.latestJob(
        input.tenantId,
        state.chainId,
        state.jobKey,
      );
      if (latest !== null && latest.status === state.status) {
        alreadyCurrent += 1;
        continue;
      }
      const row: ShardJobRow = {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        chainId: state.chainId,
        jobKey: state.jobKey,
        version: (latest?.version ?? 0) + 1,
        status: state.status,
        stage: state.stage,
        capabilityId: state.capabilityId,
        detail: state.detail,
        resultJson: state.resultJson ?? safeJson({ detail: state.detail }),
        createdAtMs: latest?.createdAtMs ?? state.createdAtMs,
        updatedAtMs: state.updatedAtMs,
        provenanceWriter: "orchestrator:reconcile",
        provenanceSourceDo: "Orchestrator",
        provenanceSourceVersion: "1",
      };
      await input.store.recordJob(row);
      reconciled += 1;
    } catch (err) {
      errors.push(
        `${state.jobKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return {
    checked: input.railsStates.length,
    reconciled,
    alreadyCurrent,
    errors,
  };
}
