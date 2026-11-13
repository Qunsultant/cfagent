/**
 * Issue #4359 — the Workflow Runs stage read's one knob.
 *
 * The page asks the job-status surface for the engine stages of the job
 * ids it just read. That is one batch call, but its size still must not
 * be unbounded: a page reads at most `limit x 2` rows and a deployment
 * may widen that, so the batch is capped here rather than in a literal.
 *
 *   WORKFLOW_RUNS_STAGE_READ_LIMIT   the most job ids one page asks about
 *
 * A blank, non-numeric, or non-positive value falls back to the built-in
 * default (the same resolution idiom as the schedule list's config seam).
 */

export const WORKFLOW_RUNS_STAGE_READ_LIMIT_ENV_VAR = "WORKFLOW_RUNS_STAGE_READ_LIMIT";

/** The built-in cap: comfortably above one 100-row page's id count. */
export const DEFAULT_WORKFLOW_RUNS_STAGE_READ_LIMIT = 200;

export interface WorkflowRunsStageReadEnv {
  WORKFLOW_RUNS_STAGE_READ_LIMIT?: string;
}

/** The resolved cap; never NaN, never zero, never negative. */
export function resolveWorkflowRunsStageReadLimit(
  env: WorkflowRunsStageReadEnv = {},
): number {
  const raw = env[WORKFLOW_RUNS_STAGE_READ_LIMIT_ENV_VAR];
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_WORKFLOW_RUNS_STAGE_READ_LIMIT;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WORKFLOW_RUNS_STAGE_READ_LIMIT;
  return parsed;
}
