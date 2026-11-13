/**
 * Issue #4289 — the shared options step-port rebuild: decode a stored
 * dispatch request's shape and rebuild the eight stages' ports for one
 * invocation, from the request alone.
 *
 * Two consumers rebuild the same ports from the same stored request:
 * per-stage control (#4066, optionsStageControl.ts — a chat/MCP turn
 * re-running one stage of a run dispatched elsewhere) and the durable
 * workflow host (#4289 — the resolving steps rebuild the ports on
 * every invocation, because a workflow replay runs in a fresh process
 * with no closures to close over). One module owns the shape contract
 * and the rebuild, so the two can never drift: the shape decode, the
 * per-shape port construction, and the named refusals for shapes and
 * stages that cannot be rebuilt.
 *
 * Shapes (the classInput key decides, exactly as #4066 decoded it):
 * - strategyRequest → panel (strategy ports, all eight stages)
 * - scan → scanner ports, all eight stages
 * - request → manual (manual ports; shapeReport/deliver refuse —
 *   the delivery builders need getScreenerAgent, which neither a
 *   chat/MCP turn nor a workflow residency binds)
 * - goalPlan → goal: the ports are rebuildable, but the goal leg's
 *   job record is not addressable from a foreign host (decided-not-to,
 *   #4274) — refuse stage_port_unavailable; the goal-screen host is
 *   #4290.
 * - comparisonRequest → comparison: a single engine step, not a
 *   staged pipeline (#4276) — refuse stage_port_unavailable.
 *
 * The rebuild's claims are fresh in-memory (a claim is per-dispatch
 * idempotency; an explicit re-run or a resumed invocation IS a new
 * execution — the engine's checkpoint is the resume mechanism) and
 * the queue is null unless the caller supplies one (no publishing on
 * a rebuild by default). The storage is caller-supplied: the control
 * passes the original leg's store; the host passes the artifact-store
 * adapter, so a resumed invocation reads the earlier stages'
 * artifacts from the durable store.
 *
 * Refusals throw OptionsStepPortsError, a JobPipelineError — the
 * engine rethrows a JobPipelineError from a step handler with its
 * code intact (anything else becomes job_step_failed), and control's
 * asControlError maps JobPipelineError codes onto its own error, so
 * the same named code is thrown on both surfaces (the run record
 * carries the message).
 */
import { JobPipelineError } from "../services/jobPipelineConfig";
import type { ScanRunStore } from "../data/scanRunPorts";
import type { Env } from "../types";
import { DynamicOptionsScreener } from "../trading";
import type { OptionsScreenStepDeps } from "./optionsScreenEngine";
import {
  createOptionsScreenPorts,
  type OptionsStageStorage,
} from "./optionsScreenPorts";
import {
  memoryStageClaims,
  type OptionsScreenWorkflowDeps,
} from "./optionsScreenWorkflow";
import {
  createScannerScreenPorts,
  createStrategyScreenAgents,
  createStrategyScreenPorts,
} from "./strategyScreenPorts";
import { createManualOptionsCanonicalLeg } from "./optionsCanonicalLeg";
import {
  createManualOptionsRecordBuilder,
  type ManualOptionsScreenCtx,
} from "./manualOptionsRecordBuilder";

/** The shapes whose stage ports can be rebuilt from the stored request. */
export type OptionsRequestShape = "manual" | "panel" | "scan";

/**
 * The shape a stored request decodes to — including the goal leg,
 * which a caller can name but cannot drive an execution op for (its
 * job record is not addressable from a foreign host — decided-not-to,
 * #4274), and the comparison leg, which a caller can name but cannot
 * drive a stage op for (a comparison run is a single engine step,
 * not a staged pipeline — #4276).
 */
export type OptionsDecodedRequestShape =
  | OptionsRequestShape
  | "goal"
  | "comparison";

/**
 * A named rebuild refusal. `code` is the contract (one of the
 * stage_* codes); the message names the run, the stage, and the
 * reason. A JobPipelineError, so the engine preserves the code.
 */
export type OptionsStepPortsCode =
  | "stage_request_missing"
  | "stage_request_unrecognized"
  | "stage_port_unavailable"
  | "job_not_found";

export class OptionsStepPortsError extends JobPipelineError {
  constructor(code: OptionsStepPortsCode, message: string) {
    super(code, message);
    this.name = "OptionsStepPortsError";
  }
}

/**
 * Decode a stored dispatch request's shape from its classInput.
 * Throws stage_request_unrecognized when the shape cannot be
 * determined — the run cannot be rebuilt, so it must be
 * re-dispatched, never guessed.
 */
export function decodeOptionsRequestShape(
  request: unknown,
  runId: string,
): OptionsDecodedRequestShape {
  const classInput = (
    request as { classInput?: Record<string, unknown> } | null
  )?.classInput;
  if (!classInput || typeof classInput !== "object") {
    throw new OptionsStepPortsError(
      "stage_request_unrecognized",
      `options run ${runId}: the stored request has no classInput — the run's shape cannot be determined, so no stage can be rebuilt; re-dispatch the screen`,
    );
  }
  if (classInput.strategyRequest !== undefined) return "panel";
  if (classInput.scan !== undefined) return "scan";
  if (classInput.request !== undefined) return "manual";
  if (classInput.goalPlan !== undefined) return "goal";
  if (classInput.comparisonRequest !== undefined) return "comparison";
  throw new OptionsStepPortsError(
    "stage_request_unrecognized",
    `options run ${runId}: the stored request's classInput carries none of strategyRequest / scan / request / goalPlan / comparisonRequest — the run's shape cannot be determined, so no stage can be rebuilt; re-dispatch the screen`,
  );
}

/**
 * Refuse, by name, a stage that cannot be rebuilt for this shape —
 * before any execution. The goal and comparison shapes refuse for
 * every stage; the manual shape refuses shapeReport/deliver only
 * (the delivery builders need getScreenerAgent, which neither a
 * chat/MCP turn nor a workflow residency binds — re-dispatch from
 * the manual route instead). The plain defaults stand in during the
 * rebuild so the other six stages' ports can still be built; they
 * are never invoked for the refused stages because this guard runs
 * first.
 */
export function assertOptionsStageRebuildable(
  shape: OptionsDecodedRequestShape,
  stageId: string,
  runId: string,
): asserts shape is OptionsRequestShape {
  if (shape === "goal") {
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `options run ${runId}: the goal leg's job record is not addressable from this host (decided-not-to, #4274) — the goal leg runs over in-memory engine stores on the ScreenerAgent DO, so no durable job exists in this host; a goal-leg stage cannot run here; the goal-screen host is #4290`,
    );
  }
  if (shape === "comparison") {
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `options run ${runId}: a comparison run is a single engine step, not an eight-stage pipeline — stage ${stageId} has no ports to rebuild, so it cannot run; re-dispatch the comparison`,
    );
  }
  if (shape === "manual" && (stageId === "shapeReport" || stageId === "deliver")) {
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `options run ${runId}: stage ${stageId} of a manual-shape run needs the manual route's delivery builders (PDF/XLSX/CSV via getScreenerAgent), which this host cannot bind — re-dispatch the screen from the manual route`,
    );
  }
}

/** What one port rebuild needs: the run's identity + request, the shape, and the seams. */
export interface RebuildOptionsStepDepsInput {
  runId: string;
  userLogin?: string;
  request: unknown;
  shape: OptionsRequestShape;
  /** The stage storage the stages read/write artifacts through (the original leg's store, or the host's artifact-store adapter). */
  storage: OptionsStageStorage;
  /** The Worker env — the manual leg's canonical leg needs it. */
  env?: Env;
  /** The chain source the stages fetch through (the turn's broker client, or the workflow residency's). */
  chainSource?: ConstructorParameters<typeof DynamicOptionsScreener>[0];
  /** The scan-run store, when the caller has one (scanner-shape persist re-runs). */
  scanRunStore?: ScanRunStore;
  /** The stage-message queue. Absent, null: a rebuild publishes nothing. */
  queue?: OptionsScreenWorkflowDeps["queue"];
}

/**
 * Rebuild the step's ports for one request shape. The holders are
 * fresh (the caller reads the outcome from the engine's own record,
 * not from a per-dispatch holder); the claims are fresh in-memory;
 * the queue is null unless supplied.
 */
export function rebuildOptionsStepDeps(
  input: RebuildOptionsStepDepsInput,
): OptionsScreenStepDeps {
  const { shape, storage } = input;
  const stages =
    shape === "panel"
      ? createStrategyScreenPorts({
          agents: createStrategyScreenAgents(input.chainSource),
          storage,
        })
      : shape === "scan"
        ? createScannerScreenPorts({
            agents: createStrategyScreenAgents(input.chainSource),
            storage,
            ...(input.scanRunStore ? { scanRunStore: input.scanRunStore } : {}),
          })
        : createOptionsScreenPorts({
            screener: new DynamicOptionsScreener(input.chainSource),
            storage,
            ...(input.env
              ? {
                  canonicalLeg: createManualOptionsCanonicalLeg(input.env),
                  // The record builder reads only ctx.env (the tenant
                  // provider context); the rest of the ctx (getOrm /
                  // getScreenerAgent) is never touched by the builder.
                  record: createManualOptionsRecordBuilder({
                    env: input.env,
                  } as ManualOptionsScreenCtx),
                }
              : {}),
            // Plain defaults: the manual route's shapeReport/deliver
            // are not rebuildable here (see
            // assertOptionsStageRebuildable), and those two stages
            // refuse before execution. The defaults exist so the
            // other six stages' ports can still be built — they are
            // never invoked for them.
            shapeReport: async ({ screen }) => screen,
            deliver: async () => ({
              terminal: "completed",
              deliveryState: "deferred-to-caller",
            }),
          });
  return {
    runId: input.runId,
    ...(input.userLogin ? { userLogin: input.userLogin } : {}),
    request: input.request,
    workflow: {
      stages,
      claims: memoryStageClaims(),
      queue: input.queue ?? null,
    },
    stageRecords: [],
    published: [],
  };
}
