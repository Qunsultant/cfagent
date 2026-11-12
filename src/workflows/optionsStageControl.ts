/**
 * Issue #4066 — per-stage chat control of options stages.
 *
 * The Options Copilot turn (NLQ + the `run_options_strategy_screen`
 * mesh door) dispatches an options screen through the engine-routed
 * workflow, and the engine records the run durably in the host DO
 * (definitions + instance + artifacts) when the leg has a SQL handle.
 * This module is the other half of that record: given (runId, stageId)
 * it drives ONE stage of that run through the engine's own control
 * plane (`*ByVocabulary`, #4061 / #3945) — run / re-run / stop /
 * resume / cancel, with the pinned meanings — and surfaces failures
 * with the stage + reason (the #2810 discipline), never as an
 * absence.
 *
 * How it works:
 * - The job id is `options-screen:<runId>` for an options screen and
 *   `strategy-screen:<runId>` for a strategy screen (one job per run,
 *   #4068 / #4271), so the run is addressed by its own id — no engine
 *   run id is ever passed (the engine's run id is not the options run
 *   id; passing the options id as `opts.runId` would trip
 *   `stage_run_mismatch`). The control resolves which job a run
 *   defined (resolveScreenJobId) — a strategy run stays controllable
 *   under its new job.
 * - The stage must be one of the 8 addressable stages (#4067 pin);
 *   display ids (feed/store/serve) refuse `stage_vocabulary_unknown`.
 * - The dispatch request rides the job definition's rawConfig
 *   (persisted by defineJob, #4066). A run dispatched before #4066
 *   carries no request, so run / re-run / resume refuse
 *   `stage_request_missing` by name — re-dispatch the screen.
 * - The step's ports are rebuilt from the request's shape
 *   (strategyRequest → panel ports; scan → scanner ports;
 *   request/filter → manual ports) with the SAME stage storage the
 *   original leg used, so a re-run reads the earlier stages'
 *   artifacts from the keys the original run wrote. The claims store
 *   is fresh in-memory: a claim is per-dispatch idempotency, and an
 *   explicit re-run IS a new execution (the engine's checkpoint is
 *   what `rerunStage` reset). The queue is null: a control re-run
 *   publishes no stage-boundary messages.
 * - The manual route's shapeReport / deliver are NOT rebuildable in
 *   a chat/MCP turn: the delivery builders need `getScreenerAgent`
 *   (PDF/XLSX/CSV generation), which no MCP context binds. Those two
 *   stages refuse `stage_port_unavailable` for a manual-shape run
 *   (re-dispatch from the manual route instead); the plain defaults
 *   stand in so the other six stages' ports can still be built.
 *   Panel/scanner shapes build their own shapeReport/deliver, so
 *   all eight stages are controllable for them.
 * - The goal leg's ports cannot be rebuilt here either (the goal run
 *   lives on the ScreenerAgent DO, not the chat host's) — a goal
 *   shape refuses `stage_port_unavailable`.
 * - Runs on other DOs, and in-memory paid-screen runs, have no
 *   durable record in this DO: the control refuses them by name
 *   (`job_not_found`), never by pretending they ran here.
 */

import { JobPipelineControl } from "../services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../services/jobPipelineSteps";
import { JobPipelineError } from "../services/jobPipelineConfig";
import type { SqlStorage } from "../orm";
import type { Env } from "../types";
import { DynamicOptionsScreener } from "../trading";
import type { ScanRunStore } from "../data/scanRunPorts";
import {
  OPTIONS_ADDRESSABLE_STAGES,
  type OptionsPipelineStage,
} from "./stageRuntimeIds";
import {
  optionsEngineStoresFromSql,
  optionsScreenJobId,
  registerOptionsScreenStep,
  strategyScreenJobId,
  type OptionsScreenStepDeps,
} from "./optionsScreenEngine";
import {
  createOptionsScreenPorts,
  type OptionsStageStorage,
} from "./optionsScreenPorts";
import {
  memoryStageClaims,
  memoryStageStorage,
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

export type OptionsStageControlOperation =
  | "run"
  | "rerun"
  | "stop"
  | "resume"
  | "cancel";

export type OptionsStageControlRequestShape = "manual" | "panel" | "scan";

/**
 * The shape a stored request decodes to — including the goal leg,
 * which a control action can name but cannot rebuild ports for
 * (its ports live on the ScreenerAgent DO), and "unknown" for a
 * stop/cancel on a run whose definition carries no request (the
 * operation needs no ports, so the shape does not matter there).
 */
export type OptionsStageControlDecodedShape =
  | OptionsStageControlRequestShape
  | "goal"
  | "unknown";

export interface OptionsStageControlInput {
  /** The host DO's raw SQLite handle — the engine stores are built over it. */
  sql: SqlStorage;
  /**
   * The stage storage the original leg used (the host DO's storage in
   * a chat/MCP turn). Absent, a fresh in-memory store stands in and
   * earlier artifacts are unreadable — a re-run then fails honestly
   * at the first artifact read, never on a fabricated input.
   */
  storage?: OptionsStageStorage;
  /** The Worker env — the manual leg's canonical leg needs it. */
  env?: Env;
  /** The options run id (the job is `options-screen:<runId>` for an
   * options screen, `strategy-screen:<runId>` for a strategy screen
   * since #4271 — the control resolves which one this run defined). */
  runId: string;
  /** One of the 8 addressable stages (#4067). */
  stage: string;
  operation: OptionsStageControlOperation;
  /** The acting login — the ports' owner-scoped stages require it. */
  userLogin?: string;
  /** The chain source the re-run fetches through (the turn's E*TRADE client). */
  etradeClient?: ConstructorParameters<typeof DynamicOptionsScreener>[0];
  /** The scan-run store, when the caller has one (scanner-shape persist re-runs). */
  scanRunStore?: ScanRunStore;
}

export interface OptionsStageControlResult {
  runId: string;
  jobId: string;
  stage: OptionsPipelineStage;
  operation: OptionsStageControlOperation;
  /** The engine state after the operation (dispatch state / instance state). */
  state: string;
  requestShape: OptionsStageControlDecodedShape;
  /** The addressed stage's units after the operation, with any error. */
  stageUnits: Array<{
    unitId: string;
    status: string;
    attempt: number;
    error?: string;
  }>;
}

/**
 * A named control refusal. `code` is the contract (an engine code
 * when the engine refused, otherwise one of this module's own);
 * the message names the run, the stage, and the reason.
 */
export class OptionsStageControlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OptionsStageControlError";
    this.code = code;
  }
}

function asControlError(error: unknown): OptionsStageControlError {
  if (error instanceof OptionsStageControlError) return error;
  if (error instanceof JobPipelineError) {
    return new OptionsStageControlError(error.code, error.message);
  }
  if (error instanceof Error) {
    return new OptionsStageControlError("stage_control_failed", error.message);
  }
  return new OptionsStageControlError(
    "stage_control_failed",
    `options stage control failed: ${String(error)}`,
  );
}

function readRequestShape(
  request: unknown,
  runId: string,
): OptionsStageControlRequestShape | "goal" {
  const classInput = (
    request as { classInput?: Record<string, unknown> } | null
  )?.classInput;
  if (!classInput || typeof classInput !== "object") {
    throw new OptionsStageControlError(
      "stage_request_unrecognized",
      `options run ${runId}: the stored request has no classInput — the run's shape cannot be determined, so no stage can be rebuilt; re-dispatch the screen`,
    );
  }
  if (classInput.strategyRequest !== undefined) return "panel";
  if (classInput.scan !== undefined) return "scan";
  if (classInput.request !== undefined) return "manual";
  if (classInput.goalPlan !== undefined) return "goal";
  throw new OptionsStageControlError(
    "stage_request_unrecognized",
    `options run ${runId}: the stored request's classInput carries none of strategyRequest / scan / request / goalPlan — the run's shape cannot be determined, so no stage can be rebuilt; re-dispatch the screen`,
  );
}

/**
 * Rebuild the step's ports for one request shape. The storage is the
 * caller-supplied stage storage (the original leg's store); the claims
 * are fresh (see the module header); the queue is null (no publishing
 * on a control re-run).
 */
function rebuildStepDeps(
  input: OptionsStageControlInput,
  request: unknown,
  shape: OptionsStageControlRequestShape,
  storage: OptionsStageStorage,
): OptionsScreenStepDeps {
  const stages =
    shape === "panel"
      ? createStrategyScreenPorts({
          agents: createStrategyScreenAgents(input.etradeClient),
          storage,
        })
      : shape === "scan"
        ? createScannerScreenPorts({
            agents: createStrategyScreenAgents(input.etradeClient),
            storage,
            ...(input.scanRunStore ? { scanRunStore: input.scanRunStore } : {}),
          })
        : createOptionsScreenPorts({
            screener: new DynamicOptionsScreener(input.etradeClient),
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
            // are not rebuildable in this turn (see the module
            // header), and those two stages refuse before execution.
            // The defaults exist so the other six stages' ports can
            // still be built — they are never invoked for them.
            shapeReport: async ({ screen }) => screen,
            deliver: async () => ({
              terminal: "completed",
              deliveryState: "deferred-to-caller",
            }),
          });
  return {
    runId: input.runId,
    ...(input.userLogin ? { userLogin: input.userLogin } : {}),
    request,
    workflow: {
      stages,
      claims: memoryStageClaims(),
      queue: null,
    },
    stageRecords: [],
    published: [],
  };
}

/**
 * Drive one stage of one options run through the engine's control
 * plane. The stage is validated against the #4067 pin first; the job
 * must exist in this DO's engine stores; run / re-run / resume need
 * the stored dispatch request. Failures throw OptionsStageControlError
 * carrying the code + the stage + the reason — never a silent absence.
 */
/**
 * Issue #4271: resolve which job a screen run defined. An options
 * screen defines `options-screen:<runId>`; a strategy screen defines
 * `strategy-screen:<runId>` (since #4271). The control plane addresses
 * a run by its runId, so it tries the options job first (the pre-#4271
 * shape) and then the strategy job. The stages, the vocabulary, and
 * the port rebuilding are identical for both — the strategy job's
 * children carry the same eight stage kinds — so only the job identity
 * is resolved here. A run defined on neither is the pre-existing
 * job_not_found refusal. (The strategy STAGE VOCABULARY is S2's work,
 * #4272; this is only the lookup that keeps strategy runs controllable
 * under their new job.)
 */
async function resolveScreenJobId(
  reader: JobPipelineControl,
  runId: string,
): Promise<{ jobId: string; view: Awaited<ReturnType<JobPipelineControl["getJob"]>> }> {
  for (const jobId of [optionsScreenJobId(runId), strategyScreenJobId(runId)]) {
    try {
      const view = await reader.getJob(jobId);
      return { jobId, view };
    } catch (error) {
      if (error instanceof JobPipelineError && error.code === "job_not_found") {
        continue;
      }
      throw error;
    }
  }
  throw new OptionsStageControlError(
    "job_not_found",
    `options run ${runId}: no engine record for job ${optionsScreenJobId(runId)} or ${strategyScreenJobId(runId)} in this host — the run was dispatched on another host, in-memory, or before the engine routing; re-dispatch the screen from this turn`,
  );
}

export async function controlOptionsStage(
  input: OptionsStageControlInput,
): Promise<OptionsStageControlResult> {
  const { runId, stage, operation } = input;
  if (
    !(OPTIONS_ADDRESSABLE_STAGES as readonly string[]).includes(stage)
  ) {
    throw new OptionsStageControlError(
      "stage_vocabulary_unknown",
      `options stage ${JSON.stringify(stage)} is not addressable — the addressable stages are ${OPTIONS_ADDRESSABLE_STAGES.join(", ")}; display stages (feed/store/serve) are presentation only and never control addresses`,
    );
  }
  const optionsStage = stage as OptionsPipelineStage;
  const engineStores = optionsEngineStoresFromSql(input.sql);
  const storage = input.storage ?? memoryStageStorage();
  try {
    // Read first, over a control without the step: getJob executes
    // nothing, so the step is only registered when an execution op
    // needs it. Issue #4271: resolve which job this run defined — the
    // options job or the strategy job — so a strategy run stays
    // controllable under its new job.
    const reader = new JobPipelineControl({
      stores: engineStores.stores,
      runRecorder: engineStores.runRecorder,
      publisher: null,
      steps: createBuiltinStepRegistry(),
      invocation: "sync",
    });
    const { jobId, view } = await resolveScreenJobId(reader, runId);
    const rawConfig = (view.definition as { rawConfig?: unknown }).rawConfig;
    const request = (rawConfig as { request?: unknown } | null)?.request;
    const needsExecution =
      operation === "run" || operation === "rerun" || operation === "resume";
    if (needsExecution && request === undefined) {
      throw new OptionsStageControlError(
        "stage_request_missing",
        `options run ${runId}: the stored job definition carries no dispatch request — the run was dispatched before #4066 persisted requests, so stage ${stage} cannot be rebuilt; re-dispatch the screen`,
      );
    }
    // Stop / cancel need no ports, so a run with no stored request
    // can still be stopped or cancelled (shape "unknown"); an
    // execution op always has its request by the check above.
    const shape: OptionsStageControlDecodedShape =
      request === undefined ? "unknown" : readRequestShape(request, runId);
    // The goal leg's ports live on the ScreenerAgent DO, not the chat
    // host — an execution op on a goal-shape run refuses by name.
    if (shape === "goal" && needsExecution) {
      throw new OptionsStageControlError(
        "stage_port_unavailable",
        `options run ${runId}: the goal leg's ports live on the ScreenerAgent DO, not the chat host — a goal-leg stage cannot be controlled from this turn; re-dispatch from the goal leg`,
      );
    }
    // The manual route's shapeReport / deliver need the
    // ScreenerAgent-bound delivery builders: refuse by name before
    // any execution, rather than running a shape that is not the
    // manual route's.
    if (
      shape === "manual" &&
      needsExecution &&
      (stage === "shapeReport" || stage === "deliver")
    ) {
      throw new OptionsStageControlError(
        "stage_port_unavailable",
        `options run ${runId}: stage ${stage} of a manual-shape run needs the manual route's delivery builders (PDF/XLSX/CSV via getScreenerAgent), which a chat/MCP turn cannot bind — re-dispatch the screen from the manual route`,
      );
    }
    const control = needsExecution
      ? new JobPipelineControl({
          stores: engineStores.stores,
          runRecorder: engineStores.runRecorder,
          publisher: null,
          steps: registerOptionsScreenStep(
            createBuiltinStepRegistry(),
            // Narrowed by the guards above: an execution op has its
            // request, and the goal shape refused, so the shape is
            // one of the three rebuildable shapes here.
            rebuildStepDeps(
              input,
              request,
              shape as OptionsStageControlRequestShape,
              storage,
            ),
          ),
          invocation: "sync",
        })
      : reader;
    let state: string;
    if (operation === "run") {
      state = (await control.runStageByVocabulary(jobId, optionsStage)).state;
    } else if (operation === "rerun") {
      state = (await control.rerunStageByVocabulary(jobId, optionsStage)).state;
    } else if (operation === "stop") {
      state = (await control.stopStageByVocabulary(jobId, optionsStage)).state;
    } else if (operation === "resume") {
      state = (await control.resumeStageByVocabulary(jobId, optionsStage)).state;
    } else {
      state = (await control.cancelStageByVocabulary(jobId, optionsStage)).state;
    }
    const after = await control.getJob(jobId);
    const stageView = after.stages.find((s) => s.kind === optionsStage);
    return {
      runId,
      jobId,
      stage: optionsStage,
      operation,
      state,
      requestShape: shape,
      stageUnits: (stageView?.units ?? []).map((unit) => ({
        unitId: unit.unitId,
        status: unit.status,
        attempt: unit.attempt,
        ...(unit.error !== undefined ? { error: unit.error } : {}),
      })),
    };
  } catch (error) {
    throw asControlError(error);
  }
}
