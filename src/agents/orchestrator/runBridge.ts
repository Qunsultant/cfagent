/**
 * Issue #3787 (sub-issue of incident #3781) — the run bridge:
 * mas_async_jobs rows for runs that do NOT execute as async
 * jobs (ScreenerScreenWorkflow runs started by the mesh screen
 * door, J1–J7 pipeline-chain runs started through the mesh
 * doors).
 *
 * The ONLY stuck mechanism in src/ is the #3784 sweep over
 * mas_async_jobs rows (sweepStaleAsyncJobs: 30-min stuck alert,
 * 2h reap). WorkflowPort runs and pipeline-chain runs had no
 * stuck detection at all — a stalled run sat in its last state
 * indefinitely with no alert. The bridge closes that gap
 * WITHOUT a second sweep and WITHOUT a new substrate: the
 * door inserts a row for the run at start, claims it to
 * `running`, and settles it (complete/fail) when the run's
 * terminal state is observed. A run whose await never settles
 * leaves its row `running`, so the sweep alerts at 30 min and
 * reaps at 2h.
 *
 * Rules the bridge keeps:
 * - Best-effort, never failing the run: every function catches
 *   its own failures and reports them as a return value (false
 *   / 0 rows), never a throw. A bridge that cannot write must
 *   not fail a screen or a chain run.
 * - No execution is ever scheduled for a bridge row: the row
 *   is inserted + claimed directly through the queue port, NOT
 *   through submitAsyncJob (which would arm executeAsyncJob
 *   for a run the door already owns). The insert→claim pair
 *   runs with no await between them, so the row is never
 *   visible as `queued` to the recovery re-arm.
 * - No `chain` key in the payload: the already-running gate
 *   (hasActiveChain) matches payloads with a `.chain`
 *   {userLogin, universe} — a bridge payload must never trip
 *   it, or a running screen would block scheduled screens.
 * - Retention rides the existing submit-time prune
 *   (pruneTerminalToCap, 500 terminal rows per session): the
 *   bridge adds no retention machinery of its own.
 */
import { createAsyncJobPorts, type AsyncJobPorts } from "../../data/createAsyncJobPorts";
import type { AgentContext } from "agents";

/** Compose the async-job ports over a storage handle. */
export function createRunBridgePorts(
  sql: AgentContext["storage"]["sql"],
): AsyncJobPorts {
  return createAsyncJobPorts(sql as never);
}

/** The bridge's row identity: the run's own id is the row id. */
export interface BridgeRunStartInput {
  /** The run's id (screener job id / chain bridge id). */
  jobId: string;
  /** The mas_async_jobs session (the orchestrator instance id). */
  sessionId: string;
  /** "screener.run" for screen runs, "pipeline.chain" for chains. */
  capability: string;
  displayName: string;
  userLogin: string;
  trigger: "manual" | "scheduled";
  /** The workflow / chain job the run belongs to, when known. */
  workflowId?: string | null;
  chainJobId?: string | null;
  /**
   * Issue #4357 — the async job (wrapper row) that dispatched this
   * run; stamped as the bridge row's parent so the pair groups as
   * one run. Null → unlinked (today's behavior).
   */
  parentJobId?: string | null;
  nowIso?: string;
}

/**
 * Insert + claim a `running` row for a run that executes
 * elsewhere. Returns true iff this caller owns the row (the
 * row is `running`); false when the row already exists, the
 * claim lost, or the store failed — the run proceeds either
 * way.
 */
export function bridgeRunStart(
  ports: AsyncJobPorts,
  input: BridgeRunStartInput,
): boolean {
  try {
    ports.queue.ensureSchema();
    const nowIso = input.nowIso ?? new Date().toISOString();
    ports.queue.insertQueued({
      jobId: input.jobId,
      sessionId: input.sessionId,
      capability: input.capability,
      displayName: input.displayName,
      payloadJson: JSON.stringify({
        bridge: input.capability === "pipeline.chain" ? "pipeline-chain-run" : "screener-run",
        userLogin: input.userLogin,
        trigger: input.trigger,
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        ...(input.chainJobId ? { chainJobId: input.chainJobId } : {}),
      }),
      nowIso,
      // Issue #4357 — the join key; null keeps today's unlinked rows.
      parentJobId: input.parentJobId ?? null,
      jobKind: "main",
      channel: null,
      notBefore: null,
      stage: null,
      chainId: null,
    });
    return ports.queue.claim(input.jobId, input.sessionId, nowIso);
  } catch {
    return false;
  }
}

/**
 * Settle a bridged run completed. Returns rows written (0 when
 * the row is unknown or already terminal — the guarded
 * transition, never a throw).
 */
export function bridgeRunComplete(
  ports: AsyncJobPorts,
  jobId: string,
  resultJson: string,
  nowIso: string = new Date().toISOString(),
): number {
  try {
    return ports.queue.complete(jobId, resultJson, null, nowIso);
  } catch {
    return 0;
  }
}

/**
 * Settle a bridged run failed with the named error. Returns
 * rows written (0 when the row is unknown or already terminal).
 */
export function bridgeRunFail(
  ports: AsyncJobPorts,
  jobId: string,
  error: string,
  nowIso: string = new Date().toISOString(),
): number {
  try {
    return ports.queue.failRunning(jobId, error, nowIso);
  } catch {
    return 0;
  }
}
