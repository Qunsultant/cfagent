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
 * - request → manual (manual ports; shapeReport/deliver rebuild
 *   in the residency from env + the stored request + the stage
 *   storage — createManualOptionsResidencyDelivery, #4450, supplied
 *   to the rebuild as an injected factory by the resolving steps,
 *   because the residency module's graph reaches the report
 *   pipeline and this module is reachable from the client bundle.
 *   The delivery builders need no agent handle in the residency:
 *   the report pipeline is env-only, XLSX/CSV generate through the
 *   pure generators and write through the blob store, and delivery
 *   rides the A2A path. Chat control supplies no factory and still
 *   refuses manual shapeReport/deliver through its own inline
 *   guard: a turn binds neither the residency env nor the artifact
 *   store.)
 * - goalPlan → goal: the goal leg's ports are rebuildable through
 *   the workflow host (#4290) — the leg's shapeReport/deliver are
 *   pure functions of their inputs (createGoalOptionsLegDelivery),
 *   rebuilt per invocation from the goal run id the goal seam
 *   stamps on the stored request. Chat control still refuses the
 *   goal shape through its own inline guard (decided-not-to,
 *   #4274): the guard below does not refuse it, because the guard
 *   serves the host path, and the host path's job record IS
 *   addressable (the start seam defines it in the D1 residency).
 * - comparisonRequest → comparison: a single engine step, not a
 *   staged pipeline (#4276) — refuse stage_port_unavailable for
 *   STAGE ops. The comparison itself executes in the residency
 *   through the resolving `comparison.run` step (#4451,
 *   optionsPipelineJobs.ts), which rebuilds the whole comparison
 *   per invocation; this guard refuses only the eight-stage
 *   vocabulary applied to a comparison run.
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
 * Issue #4473 — the universe stage input: a run may carry a
 * serializable universe descriptor on classInput.universeDeps
 * (UniverseDepsStageInput, decoded by decodeUniverseDepsStageInput,
 * stamped by the start seams). The live deps are a function-valued
 * seam and can never be stored, so the resolving steps rebuild
 * them per invocation from the descriptor (the residency factory,
 * universeDepsResidency.ts, bound as universeDepsFor) and hand
 * them to the rebuild, which constructs every screener with them.
 * The control path hands none: a control re-run of a discovery-mode
 * stage keeps the #1378 refusal, as it has no residency to resolve
 * over. #3960 mirrors this contract for broker selection with a
 * sibling classInput key.
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
import { DynamicOptionsScreener, type NasdaqUniverseDeps } from "../trading";
import type { OptionsScreenStepDeps } from "./optionsScreenEngine";
import {
  createOptionsScreenPorts,
  type OptionsDeliverFn,
  type OptionsShapeReportFn,
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
import { createGoalOptionsLegDelivery } from "./goalOptionsLeg";
// Type-only: the residency delivery factory's input shape. The
// shared rebuild must NOT import the residency module's values —
// its graph reaches the report pipeline (workerd-only modules),
// which breaks the client bundle this module is reachable from
// (#4066). The factory crosses the seam as an injected value from
// the server-only caller (the resolving steps, #4450).
import type { ManualOptionsResidencyInput } from "./manualOptionsResidency";
import {
  createManualOptionsRecordBuilder,
  type ManualOptionsScreenCtx,
} from "./manualOptionsRecordBuilder";

/**
 * The shapes whose stage ports can be rebuilt from the stored
 * request. The goal shape joined in #4290: its ports rebuild
 * through the workflow host from the stamped goal run id (chat
 * control still refuses it through its own guard — #4274).
 */
export type OptionsRequestShape = "manual" | "panel" | "scan" | "goal";

/**
 * The shape a stored request decodes to — including the comparison
 * leg, which a caller can name but cannot drive a stage op for (a
 * comparison run is a single engine step, not a staged pipeline —
 * #4276).
 */
export type OptionsDecodedRequestShape = OptionsRequestShape | "comparison";

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
 * before any execution. Only the comparison shape refuses (for
 * every stage: a comparison run is a single engine step, not an
 * eight-stage pipeline). The manual shape passes every stage: its
 * delivery builders rebuild in the residency (#4450), refusing at
 * invocation with the same code when no environment is bound. The
 * goal shape passes: its ports rebuild through the host (#4290),
 * and the rebuild itself refuses a goal request that carries no
 * stamped goal run id.
 *
 * This guard serves the host path only. Chat control refuses the
 * goal shape and manual shapeReport/deliver through its own inline
 * guards (decided-not-to, #4274; the turn binds neither the
 * residency env nor the artifact store) before ever reaching the
 * shared rebuild — this guard passing those shapes does not weaken
 * those refusals.
 */
export function assertOptionsStageRebuildable(
  shape: OptionsDecodedRequestShape,
  stageId: string,
  runId: string,
): asserts shape is OptionsRequestShape {
  if (shape === "comparison") {
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `options run ${runId}: a comparison run is a single engine step, not an eight-stage pipeline — stage ${stageId} has no ports to rebuild, so it cannot run; re-dispatch the comparison`,
    );
  }
}

/**
 * The classInput key carrying the universe descriptor. One constant
 * for every writer (the start seams) and the one reader (decode),
 * so the key cannot drift between them.
 */
export const UNIVERSE_DEPS_STAGE_INPUT_KEY = "universeDeps";

/**
 * The universe descriptor a run carries as a stage input (#4473).
 * It is serializable dispatch data, not the deps themselves: the
 * live {@link NasdaqUniverseDeps} are a function-valued seam and
 * can never be stored, so the run carries this descriptor and the
 * resolving step rebuilds live deps from it per invocation (the
 * residency factory in `./universeDepsResidency`).
 *
 * The provider is the nasdaq screen-universe provider — the only
 * universe source the screener consumes today
 * (`nasdaqUniverseProviderFromRoute` requires the route to name
 * nasdaq and refuses any substitution). The tenant rides along
 * because the bundle's run context is tenant-scoped; absent, the
 * bundle defaults it to `"default"`, as the call-site builders do.
 *
 * This is the seam #3960 mirrors for provider/broker selection: a
 * sibling classInput key carrying a (broker, mode) descriptor, a
 * sibling decoder, and a sibling factory on the resolving steps.
 * That slice is distinct and owns its own key; nothing here reads
 * or writes it.
 */
export interface UniverseDepsStageInput {
  provider: "nasdaq";
  tenantId?: string;
}

/**
 * Validate a caller-supplied universe descriptor. A malformed
 * descriptor refuses by name at the seam that received it — the
 * decoder never guesses a provider or a tenant.
 */
export function validateUniverseDepsStageInput(
  value: unknown,
  runId: string,
): UniverseDepsStageInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OptionsStepPortsError(
      "stage_request_unrecognized",
      `options run ${runId}: the universe stage input is not an object — refusing to guess the universe provider`,
    );
  }
  const candidate = value as { provider?: unknown; tenantId?: unknown };
  if (candidate.provider !== "nasdaq") {
    throw new OptionsStepPortsError(
      "stage_request_unrecognized",
      `options run ${runId}: the universe stage input names an unrecognized provider ${JSON.stringify(candidate.provider)} — only "nasdaq" is a universe source today`,
    );
  }
  if (
    candidate.tenantId !== undefined &&
    (typeof candidate.tenantId !== "string" || candidate.tenantId.trim() === "")
  ) {
    throw new OptionsStepPortsError(
      "stage_request_unrecognized",
      `options run ${runId}: the universe stage input carries a non-string or empty tenantId — refusing to guess the tenant`,
    );
  }
  return {
    provider: "nasdaq",
    ...(typeof candidate.tenantId === "string" ? { tenantId: candidate.tenantId } : {}),
  };
}

/**
 * Decode the universe descriptor from a stored dispatch request.
 * Absent (no classInput, or no key) decodes to `undefined`: runs
 * dispatched before #4473, and runs that carry no universe input,
 * are untouched. Present-but-malformed refuses by name.
 */
export function decodeUniverseDepsStageInput(
  request: unknown,
  runId: string,
): UniverseDepsStageInput | undefined {
  const classInput = (
    request as { classInput?: Record<string, unknown> } | null | undefined
  )?.classInput;
  const value = classInput?.[UNIVERSE_DEPS_STAGE_INPUT_KEY];
  if (value === undefined) return undefined;
  return validateUniverseDepsStageInput(value, runId);
}

/**
 * Stamp a validated universe descriptor onto a copy of a dispatch
 * request. The caller's request is never mutated (the goal seam's
 * goalRunId stamp has the same copy semantics).
 */
export function stampUniverseDepsStageInput(
  request: unknown,
  universe: UniverseDepsStageInput,
): unknown {
  const req = (
    request && typeof request === "object" && !Array.isArray(request) ? request : {}
  ) as Record<string, unknown>;
  const classInput = (req.classInput as Record<string, unknown> | undefined) ?? {};
  return {
    ...req,
    classInput: { ...classInput, [UNIVERSE_DEPS_STAGE_INPUT_KEY]: universe },
  };
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
  /**
   * The manual delivery factory (#4450): builds the manual shape's
   * shapeReport/deliver for one invocation from env + the stored
   * request + the stage storage. Supplied by the host path (the
   * resolving steps); the control path supplies none, and the
   * manual stages then refuse at invocation (its inline guard
   * refuses them first, so the refusal never fires there). The
   * factory is injected rather than imported because the residency
   * module's graph reaches the report pipeline, which the client
   * bundle this module is reachable from cannot hold (#4066).
   */
  manualDeliveryFactory?: (input: ManualOptionsResidencyInput) => {
    shapeReport: OptionsShapeReportFn;
    deliver: OptionsDeliverFn;
  };
  /**
   * Resolved universe deps for this invocation (#4473). The
   * resolving step rebuilds them from the run's universe stage
   * input (when the run carries one) and hands them here; the
   * rebuild constructs every screener with them, so a stage
   * resolves its universe from the run inputs, never from
   * call-site construction. Absent, the screener is constructed
   * without deps and discovery-mode legs throw the #1378 error
   * at the screen stage, as they always have.
   */
  universeDeps?: NasdaqUniverseDeps;
}

/**
 * The composing goal run's id from a goal-shape request — stamped
 * on classInput.goalPlan.goalRunId by the goal seam
 * (startGoalOptionsLegWorkflow, #4290). The leg's report section
 * and delivery handoff stamp it, so a goal request without it
 * cannot rebuild: refuse by name rather than attribute the leg's
 * contribution to the wrong run (or none).
 */
function goalRunIdFromGoalRequest(request: unknown, runId: string): string {
  const goalRunId = (
    request as { classInput?: { goalPlan?: { goalRunId?: unknown } } } | null
  )?.classInput?.goalPlan?.goalRunId;
  if (typeof goalRunId !== "string" || goalRunId.length === 0) {
    throw new OptionsStepPortsError(
      "stage_port_unavailable",
      `options run ${runId}: a goal-shape run carries no goal run id on classInput.goalPlan.goalRunId — the leg's report section and delivery handoff cannot stamp the composing run; dispatch through the goal seam (startGoalOptionsLegWorkflow, #4290), which stamps it`,
    );
  }
  return goalRunId;
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
  // The manual leg's canonical leg, built once and shared by the
  // persist stage and the shapeReport re-record (one transport for
  // the row, #4060) — only for the manual shape, only when an env
  // is bound. A pure closure over env; building it performs no I/O.
  const manualCanonicalLeg =
    shape === "manual" && input.env
      ? createManualOptionsCanonicalLeg(input.env)
      : undefined;
  const stages =
    shape === "panel"
      ? createStrategyScreenPorts({
          agents: createStrategyScreenAgents(input.chainSource, input.universeDeps),
          storage,
        })
      : shape === "scan"
        ? createScannerScreenPorts({
            agents: createStrategyScreenAgents(input.chainSource, input.universeDeps),
            storage,
            ...(input.scanRunStore ? { scanRunStore: input.scanRunStore } : {}),
          })
        : shape === "goal"
          ? createOptionsScreenPorts({
              // The goal leg's ports, rebuilt per invocation from
              // the stored request (#4290): the leg's delivery
              // builders are pure functions of the stamped goal run
              // id, and the screener is constructed with the
              // resolved universe deps when the run carries a
              // universe stage input (#4473) — discovery-mode legs
              // then discover through them; without the input the
              // screener has no deps and discovery-mode legs fail
              // at the screen stage with the #1378 error, and the
              // goal seam refuses them earlier, by name.
              // No canonical store, matching the production leg's
              // decided omission (#4060, #783): the composing goal
              // run's row is the single canonical home.
              screener: new DynamicOptionsScreener(
                input.chainSource,
                undefined,
                input.universeDeps,
              ),
              storage,
              ...createGoalOptionsLegDelivery({
                goalRunId: goalRunIdFromGoalRequest(input.request, input.runId),
              }),
            })
          : createOptionsScreenPorts({
            // The manual leg's screener, constructed with the
            // resolved universe deps when the run carries a
            // universe stage input (#4473), as the goal shape
            // above; without the input, discovery-mode screens
            // fail at the screen stage with the #1378 error.
            screener: new DynamicOptionsScreener(
              input.chainSource,
              undefined,
              input.universeDeps,
            ),
            storage,
            ...(input.env
              ? {
                  canonicalLeg: manualCanonicalLeg,
                  // The record builder reads only ctx.env (the tenant
                  // provider context); the rest of the ctx (getOrm /
                  // getScreenerAgent) is never touched by the builder.
                  record: createManualOptionsRecordBuilder({
                    env: input.env,
                  } as ManualOptionsScreenCtx),
                }
              : {}),
            // #4450: the manual route's shapeReport/deliver rebuild
            // in the residency from env + the stored request
            // envelope + the stage storage, through the factory the
            // caller injected — the guard no longer refuses them.
            // No factory ⇒ the stages refuse at invocation with
            // stage_port_unavailable (the control path, whose inline
            // guard refuses them first), so the other six stages'
            // ports still build.
            ...(input.manualDeliveryFactory
              ? input.manualDeliveryFactory({
                  ...(input.env ? { env: input.env } : {}),
                  storage,
                  request: (
                    input.request as { classInput?: { request?: unknown } } | null
                  )?.classInput?.request,
                  ...(manualCanonicalLeg ? { canonicalLeg: manualCanonicalLeg } : {}),
                })
              : {
                  shapeReport: async () => {
                    throw new OptionsStepPortsError(
                      "stage_port_unavailable",
                      `options run ${input.runId}: stage shapeReport of a manual-shape run needs the residency delivery builders, and this rebuild carries no delivery factory — dispatch through the manual route, or rebuild through the workflow host`,
                    );
                  },
                  deliver: async () => {
                    throw new OptionsStepPortsError(
                      "stage_port_unavailable",
                      `options run ${input.runId}: stage deliver of a manual-shape run needs the residency delivery builders, and this rebuild carries no delivery factory — dispatch through the manual route, or rebuild through the workflow host`,
                    );
                  },
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
