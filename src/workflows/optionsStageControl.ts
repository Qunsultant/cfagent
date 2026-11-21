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
 *   Issue #4272 (#3552 S2): the strategy job's stages are addressed
 *   under the strategy vocabulary (STRATEGY_ADDRESSABLE_STAGES — the
 *   same 8 ids by design, the strategy pipeline being the eight-stage
 *   options pipeline over strategy ports), so a strategy run's stage
 *   is validated against the union of the two vocabularies — one set,
 *   two names — and the job resolution below already picks the
 *   strategy job for a strategy run.
 * - The dispatch request rides the job definition's rawConfig
 *   (persisted by defineJob, #4066). A run dispatched before #4066
 *   carries no request, so run / re-run / resume refuse
 *   `stage_request_missing` by name — re-dispatch the screen.
 * - The step's ports are rebuilt from the request's shape
 *   (strategyRequest → panel ports; scan → scanner ports;
 *   request/filter → manual ports) with the SAME stage storage the
 *   original leg used — the caller's handle when supplied, else the
 *   threaded storage (#4400): the engine stores' artifact store
 *   scoped by the run's current engine run id, where a panel
 *   dispatch wrote the stage artifacts — so a re-run reads the
 *   earlier stages' artifacts from the keys the original run wrote.
 *   A run whose artifacts live in neither refuses
 *   `stage_storage_unavailable` by name before any execution (the
 *   first stage, which reads no earlier artifact, is exempt). The
 *   rebuild is the shared one (optionsStepPorts.ts — the workflow
 *   host's resolving steps use it per invocation, #4289). The claims
 *   store is fresh in-memory: a claim is per-dispatch idempotency,
 *   and an explicit re-run IS a new execution (the engine's
 *   checkpoint is what `rerunStage` reset). The queue is null: a
 *   control re-run publishes no stage-boundary messages.
 * - The manual route's shapeReport / deliver are NOT rebuildable in
 *   a chat/MCP turn: the delivery builders need `getScreenerAgent`
 *   (PDF/XLSX/CSV generation), which no MCP context binds. Those two
 *   stages refuse `stage_port_unavailable` for a manual-shape run
 *   (re-dispatch from the manual route instead); the plain defaults
 *   stand in so the other six stages' ports can still be built.
 *   Panel/scanner shapes build their own shapeReport/deliver, so
 *   all eight stages are controllable for them.
 * - The goal leg's job record is addressable from the chat host
 *   ONLY where the host seam persisted it in the D1 residency
 *   (#4859): the goal leg dispatches through the workflow host
 *   (#4858), which defines the job over the D1 stores before the
 *   workflow instance runs — and the chat turn's env carries the
 *   same AGENT_DB binding, so the control resolves the SAME record
 *   the workflow instance drives (definitions, instances, run
 *   records, artifacts) with no cross-DO path. The #4274
 *   decided-not-to stands for any goal run whose record is NOT
 *   D1-addressable: a goal-shape execution op on a record resolved
 *   over the DO stores still refuses `stage_port_unavailable` by
 *   name. (The goal leg's shapeReport/deliver are pure functions
 *   of their inputs and ARE rebuildable — the blocker was the job
 *   record, not the ports, and the host seam removed it for
 *   host-dispatched runs.)
 * - A comparison run (#4276) is a single engine step, not a staged
 *   pipeline: the control resolves its `comparison:<runId>` job and
 *   decodes its shape, but run / re-run / resume refuse
 *   `stage_port_unavailable` (no stage ports exist to rebuild) and
 *   stop / cancel refuse the engine's `stage_vocabulary_unknown`
 *   (no stage node exists in the job) — both by name, never silent.
 * - Runs on other DOs, and in-memory paid-screen runs, have no
 *   durable record in this DO or the D1 residency: the control
 *   refuses them by name (`job_not_found`), never by pretending
 *   they ran here.
 * - A run carrying a broker stage input (#3960) resolves its chain
 *   source from the descriptor through the injected `chainSourceFor`
 *   factory — the resolving steps' signature — never silently
 *   through the turn's default client: a chainFetch re-run on a run
 *   whose descriptor names another broker would otherwise fetch the
 *   wrong broker's chains and overwrite the run's artifacts. With
 *   no factory bound the run refuses by name, exactly as the
 *   resolving steps refuse it. Only an object broker value is a
 *   descriptor: the legacy string broker key keeps today's
 *   behavior (the turn's client stands, the factory is never
 *   consulted), and a run with no broker value at all likewise
 *   never consults the factory.
 */

import { JobPipelineControl } from "../services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../services/jobPipelineSteps";
import { JobPipelineError } from "../services/jobPipelineConfig";
import type { SqlStorage } from "../orm";
import type { Env } from "../types";
import type { DynamicOptionsScreener, OptionChainSource } from "../trading";
import type { ScanRunStore } from "../data/scanRunPorts";
import {
  OPTIONS_ADDRESSABLE_STAGES,
  OPTIONS_PIPELINE_STAGES,
  STRATEGY_ADDRESSABLE_STAGES,
  type OptionsPipelineStage,
} from "./stageRuntimeIds";
import {
  comparisonJobId,
  optionsEngineStoresFromSql,
  optionsScreenJobId,
  optionsStageStorageFromArtifacts,
  registerOptionsScreenStep,
  strategyScreenJobId,
  type OptionsEngineStores,
} from "./optionsScreenEngine";
import {
  optionsArtifactKey,
  type OptionsStageStorage,
} from "./optionsScreenPorts";
import {
  memoryStageStorage,
} from "./optionsScreenWorkflow";
import {
  BROKER_STAGE_INPUT_KEY,
  decodeBrokerStageInput,
  decodeOptionsRequestShape,
  rebuildOptionsStepDeps,
  type OptionsDecodedRequestShape,
  type OptionsRequestShape,
} from "./optionsStepPorts";
import { envStrings } from "./envStrings";

export type OptionsStageControlOperation =
  | "run"
  | "rerun"
  | "stop"
  | "resume"
  | "cancel";

export type OptionsStageControlRequestShape = OptionsRequestShape;

/**
 * The shape a stored request decodes to — including the goal leg,
 * which a control action can name but can drive an execution op for
 * only where the record resolved over the D1 residency bundle
 * (#4859; otherwise the #4274 decided-not-to stands), the
 * comparison leg, which a control action can name but cannot drive
 * a stage op for (a comparison run is a single engine step, not a
 * staged pipeline — #4276), and "unknown" for a stop/cancel on a run
 * whose definition carries no request (the operation needs no ports,
 * so the shape does not matter there).
 */
export type OptionsStageControlDecodedShape =
  | OptionsDecodedRequestShape
  | "unknown";

export interface OptionsStageControlInput {
  /**
   * The host DO's raw SQLite handle — the engine stores are built
   * over it. Optional since #4859: a control variant over the D1
   * residency bundle alone (d1Stores) needs no SQL handle. At least
   * one of sql / d1Stores is required (stage_control_unavailable
   * otherwise).
   */
  sql?: SqlStorage;
  /**
   * The pre-built engine stores bundle for the D1 residency
   * (#4859) — production builds it from env.AGENT_DB via
   * optionsWorkflowRunDepsFromEnv. Resolution tries the DO stores
   * first, then this bundle; whichever holds the job record drives
   * the stage. A goal-shape execution op lifts the #4274 guard
   * only when the record resolved over this bundle.
   */
  d1Stores?: OptionsEngineStores;
  /**
   * The stage storage the original leg used (the host DO's storage in
   * a chat/MCP turn). Absent, the threaded storage stands in: the
   * engine stores' artifact store scoped by the run's current engine
   * run id, where a panel dispatch since #4400 wrote the stage
   * artifacts — so a re-run reads the earlier stages' artifacts from
   * the same stores. A run whose artifacts live in neither refuses
   * by name (stage_storage_unavailable) before any execution,
   * instead of reporting a completion it did not execute.
   */
  storage?: OptionsStageStorage;
  /** The Worker env — the manual leg's canonical leg needs it. */
  env?: Env;
  /** The options run id (the job is `options-screen:<runId>` for an
   * options screen, `strategy-screen:<runId>` for a strategy screen
   * since #4271, `comparison:<runId>` for a comparison run since
   * #4276 — the control resolves which one this run defined). */
  runId: string;
  /** One of the 8 addressable stages (#4067). */
  stage: string;
  operation: OptionsStageControlOperation;
  /** The acting login — the ports' owner-scoped stages require it. */
  userLogin?: string;
  /** The chain source the re-run fetches through (the turn's E*TRADE client). */
  etradeClient?: ConstructorParameters<typeof DynamicOptionsScreener>[0];
  /**
   * The chain source factory (#4859, the resolving steps' signature):
   * consulted ONLY when the stored request carries a broker stage
   * input as an object descriptor (a legacy string broker key never
   * consults it), and its result is the source the re-run fetches
   * through. The door binds it to resolveChainSourceForRequest (the
   * #3960 residency factory); injected, never imported, so this
   * module stays free of the server-only residency module (#4066
   * discipline). A descriptor-carrying run with no factory bound
   * refuses by name.
   */
  chainSourceFor?: (
    userLogin: string | undefined,
    request: unknown,
    runId: string,
  ) => OptionChainSource | undefined;
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
    // Includes OptionsStepPortsError (a JobPipelineError): the shared
    // rebuild's named codes (stage_request_unrecognized et al.)
    // reach the caller with their code intact.
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

/**
 * Drive one stage of one options run through the engine's control
 * plane. The stage is validated against the #4067 pin first; the job
 * must exist in the host DO's engine stores or the D1 residency
 * stores (#4859); run / re-run / resume need the stored dispatch
 * request. Failures throw OptionsStageControlError carrying the code
 * + the stage + the reason — never a silent absence.
 */
/**
 * Issue #4271: resolve which job a screen run defined. An options
 * screen defines `options-screen:<runId>`; a strategy screen defines
 * `strategy-screen:<runId>` (since #4271); a comparison run defines
 * `comparison:<runId>` (since #4276). The control plane addresses
 * a run by its runId, so it tries the options job first (the pre-#4271
 * shape), then the strategy job, then the comparison job. The stages,
 * the vocabulary, and the port rebuilding are identical for the two
 * screen jobs — the strategy job's children carry the same eight
 * stage kinds — so only the job identity is resolved here; the
 * comparison job carries no stages, and stage ops on it refuse by
 * name further down. A run defined on none is the pre-existing
 * job_not_found refusal. (The strategy STAGE VOCABULARY is S2's work,
 * #4272; this is only the lookup that keeps strategy runs controllable
 * under their new job.)
 */
async function resolveScreenJobId(
  reader: JobPipelineControl,
  runId: string,
): Promise<{ jobId: string; view: Awaited<ReturnType<JobPipelineControl["getJob"]>> }> {
  for (const jobId of [optionsScreenJobId(runId), strategyScreenJobId(runId), comparisonJobId(runId)]) {
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
    `options run ${runId}: no engine record for job ${optionsScreenJobId(runId)}, ${strategyScreenJobId(runId)}, or ${comparisonJobId(runId)} in this host — the run was dispatched on another host, in-memory, or before the engine routing; re-dispatch the screen from this turn`,
  );
}

export async function controlOptionsStage(
  input: OptionsStageControlInput,
): Promise<OptionsStageControlResult> {
  const { runId, stage, operation } = input;
  // Issue #4272: the stage is validated against the union of the
  // options and strategy vocabularies — one set, two names — so a
  // strategy run's stage is addressable under the strategy
  // vocabulary exactly as an options run's is under the options one.
  if (
    !(OPTIONS_ADDRESSABLE_STAGES as readonly string[]).includes(stage) &&
    !(STRATEGY_ADDRESSABLE_STAGES as readonly string[]).includes(stage)
  ) {
    throw new OptionsStageControlError(
      "stage_vocabulary_unknown",
      `options stage ${JSON.stringify(stage)} is not addressable — the addressable stages are ${OPTIONS_ADDRESSABLE_STAGES.join(", ")} (the options vocabulary, #4067; the strategy vocabulary, #4272, is the same 8 by design); display stages (feed/store/serve) are presentation only and never control addresses`,
    );
  }
  const optionsStage = stage as OptionsPipelineStage;
  // Issue #4859 — dual resolution: the DO stores first (the
  // pre-existing path, unchanged), then the D1 residency bundle.
  // Whichever holds the job record drives the stage, and the
  // residency the record resolved over decides the #4274 guard.
  const candidates: Array<{
    stores: OptionsEngineStores;
    addressedOver: "do" | "d1";
  }> = [];
  if (input.sql !== undefined) {
    candidates.push({
      stores: optionsEngineStoresFromSql(input.sql),
      addressedOver: "do",
    });
  }
  if (input.d1Stores !== undefined) {
    candidates.push({ stores: input.d1Stores, addressedOver: "d1" });
  }
  if (candidates.length === 0) {
    throw new OptionsStageControlError(
      "stage_control_unavailable",
      `options run ${runId}: stage ${stage} cannot be driven (${operation}) — neither the host DO's SQL handle nor the D1 residency stores are bound in this turn, so no engine record is addressable; re-dispatch the screen from a turn that binds one`,
    );
  }
  try {
    // Read first, over a control without the step: getJob executes
    // nothing, so the step is only registered when an execution op
    // needs it. Issue #4271: resolve which job this run defined — the
    // options job or the strategy job — so a strategy run stays
    // controllable under its new job. Issue #4859: try each
    // candidate store set in order; a job_not_found on one falls
    // through to the next, and any other failure surfaces.
    let resolved: {
      stores: OptionsEngineStores;
      addressedOver: "do" | "d1";
      jobId: string;
      view: Awaited<ReturnType<JobPipelineControl["getJob"]>>;
      reader: JobPipelineControl;
    } | null = null;
    let lastNotFound: OptionsStageControlError | null = null;
    for (const candidate of candidates) {
      const reader = new JobPipelineControl({
        stores: candidate.stores.stores,
        runRecorder: candidate.stores.runRecorder,
        publisher: null,
        steps: createBuiltinStepRegistry(),
        invocation: "sync",
      });
      try {
        const { jobId, view } = await resolveScreenJobId(reader, runId);
        resolved = { ...candidate, jobId, view, reader };
        break;
      } catch (error) {
        if (error instanceof OptionsStageControlError && error.code === "job_not_found") {
          lastNotFound = error;
          continue;
        }
        throw error;
      }
    }
    if (resolved === null) {
      // One candidate searched: the pre-existing refusal, verbatim.
      // Both searched: name both residencies, so the caller knows
      // the record is in neither.
      if (candidates.length === 1 && lastNotFound !== null) {
        throw lastNotFound;
      }
      throw new OptionsStageControlError(
        "job_not_found",
        `options run ${runId}: no engine record for job ${optionsScreenJobId(runId)}, ${strategyScreenJobId(runId)}, or ${comparisonJobId(runId)} in this host's DO stores or the D1 residency stores — the run was dispatched on another host, in-memory, or before the engine routing; re-dispatch the screen from this turn`,
      );
    }
    const { stores: engineStores, addressedOver, jobId, view, reader } = resolved;
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
      request === undefined ? "unknown" : decodeOptionsRequestShape(request, runId);
    // The goal leg's job record is not addressable from the chat
    // host (decided-not-to, #4274) — UNLESS the record resolved
    // over the D1 residency bundle (#4859): the host seam
    // persisted it there, so the record IS addressable and the
    // guard lifts for exactly those runs. A goal-shape execution
    // op on a record resolved over the DO stores still refuses by
    // name, with the #4274 message unchanged.
    if (shape === "goal" && needsExecution && addressedOver !== "d1") {
      throw new OptionsStageControlError(
        "stage_port_unavailable",
        `options run ${runId}: the goal leg's job record is not addressable from this turn (decided-not-to, #4274) — the goal leg runs over in-memory engine stores on the ScreenerAgent DO, so no durable job exists in this host; a goal-leg stage cannot be controlled from chat; re-dispatch from the goal leg`,
      );
    }
    // The comparison leg's run is a single engine step, not a staged
    // pipeline (#4276): there are no stage ports to rebuild, so an
    // execution op on a comparison-shape run refuses by name.
    if (shape === "comparison" && needsExecution) {
      throw new OptionsStageControlError(
        "stage_port_unavailable",
        `options run ${runId}: a comparison run is a single engine step, not an eight-stage pipeline — stage ${stage} has no ports to rebuild, so it cannot be run, re-run, or resumed; re-dispatch the comparison`,
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
    // Issue #4859 — a run carrying a broker stage input resolves
    // its chain source from the descriptor, never silently through
    // the turn's default client: a chainFetch re-run on a run whose
    // descriptor names another broker would fetch the wrong
    // broker's chains and overwrite the run's artifacts. Only an
    // OBJECT broker value is a descriptor (#3960): the legacy
    // string broker key (a scan request's `broker: "etrade"`, the
    // #5194 ambiguity) keeps today's behavior — the turn's client
    // stands, and the factory is never consulted. A descriptor
    // with no factory bound refuses by name, exactly as the
    // resolving steps refuse it (optionsPipelineJobs.ts); an
    // invalid descriptor refuses rather than guessing.
    let chainSource = input.etradeClient;
    if (needsExecution) {
      const brokerValue = (
        request as { classInput?: Record<string, unknown> } | null | undefined
      )?.classInput?.[BROKER_STAGE_INPUT_KEY];
      if (brokerValue !== undefined && typeof brokerValue === "object" && brokerValue !== null) {
        const brokerInput = decodeBrokerStageInput(request, runId);
        if (brokerInput !== undefined) {
          if (input.chainSourceFor === undefined) {
            throw new OptionsStageControlError(
              "stage_port_unavailable",
              `options run ${runId}: the stored request carries a broker stage input (broker "${brokerInput.broker}", ${brokerInput.mode} mode) but this turn binds no chain source — the screener cannot resolve its chains; bind chainSourceFor (the #3960 residency factory) and re-dispatch`,
            );
          }
          chainSource = input.chainSourceFor(input.userLogin, request, runId);
        }
      }
    }
    // Issue #4400 — the stage storage: the caller's handle when
    // supplied (the contract the manual route and the direct legs
    // already keep: the SAME storage the original leg used), else
    // the threaded storage — the artifact store scoped by the
    // run's current engine run id. The engine re-uses that id for
    // stage actions, so the threaded storage reads exactly what
    // the dispatch wrote. No current run means the engine refuses
    // downstream (stage_no_run); the fresh store stands in only so
    // that refusal, not a storage error, is what surfaces.
    // Issue #4859 — over the D1 residency the caller's DO storage
    // is never the run's store: a host dispatch wrote its artifacts
    // to the residency's artifact store, so the threaded storage
    // stands in and the #4400 probe below runs against it.
    const effectiveStorageInput =
      addressedOver === "d1" ? undefined : input.storage;
    const engineRunId = view.instance?.currentRunId ?? null;
    const storage =
      effectiveStorageInput ??
      (engineRunId
        ? optionsStageStorageFromArtifacts(engineStores.stores.artifacts, engineRunId)
        : memoryStageStorage());
    // Issue #4400 — a run whose artifacts were never threaded
    // refuses by name before any execution: every stage after the
    // first reads an earlier stage's artifact, and with no threaded
    // artifact in the store the stage has no persisted input. The
    // first stage reads none (it plans from the request), so it is
    // exempt — it re-executes from the request and threads its own
    // artifact. Caller-supplied storage is the caller's explicit
    // contract and is never probed.
    if (
      needsExecution &&
      effectiveStorageInput === undefined &&
      engineRunId !== null &&
      stage !== OPTIONS_PIPELINE_STAGES[0]
    ) {
      const keys = await engineStores.stores.artifacts.listArtifactKeys(engineRunId);
      const threaded = OPTIONS_PIPELINE_STAGES.some((stageId) =>
        keys.includes(optionsArtifactKey(runId, stageId)),
      );
      if (!threaded) {
        throw new OptionsStageControlError(
          "stage_storage_unavailable",
          `options run ${runId}: stage ${stage} cannot be driven (${operation}) — no stage artifacts for this run exist in this host's engine stores; the run was dispatched before stage-storage threading (#4400) or over per-call storage, so the stage has no persisted input to read; re-dispatch the screen`,
        );
      }
    }
    const control = needsExecution
      ? new JobPipelineControl({
          stores: engineStores.stores,
          runRecorder: engineStores.runRecorder,
          publisher: null,
          steps: registerOptionsScreenStep(
            createBuiltinStepRegistry(),
            // Narrowed by the guards above: an execution op has its
            // request, and the goal and comparison shapes refused,
            // so the shape is one of the three rebuildable shapes here.
            // The rebuild is the shared one (optionsStepPorts.ts):
            // the same decode + port construction the workflow host's
            // resolving steps use per invocation.
            rebuildOptionsStepDeps({
              runId: input.runId,
              ...(input.userLogin ? { userLogin: input.userLogin } : {}),
              request,
              shape: shape as OptionsStageControlRequestShape,
              storage,
              ...(input.env ? { env: input.env } : {}),
              ...(chainSource ? { chainSource } : {}),
              ...(input.scanRunStore ? { scanRunStore: input.scanRunStore } : {}),
            }),
          ),
          invocation: "sync",
          // Issue #4782 S3 — the stage re-run resolves its retry
          // policy from the caller's env (platform default);
          // the step deps above already carry the same env.
          ...(input.env ? { env: envStrings(input.env) } : {}),
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
