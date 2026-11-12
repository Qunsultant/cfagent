/**
 * Issue #4066 — the Options Copilot per-stage control door.
 *
 * The mesh door for `options_copilot_stage_control`: given (runId,
 * stageId, operation) it drives ONE stage of one options run through
 * the engine's control plane (src/workflows/optionsStageControl.ts)
 * from the copilot turn. The run must have a durable engine record
 * in THIS host DO (dispatched from the copilot turn with a SQL
 * handle); runs on other DOs, and in-memory paid-screen runs, refuse
 * by name (`job_not_found`), never by pretending they ran here.
 *
 * Errors: door-level refusals throw MeshDoorError (identity_required,
 * door_unavailable, bad input). Control-plane refusals propagate as
 * OptionsStageControlError — the control plane's own coded errors
 * (stage_vocabulary_unknown, stage_request_missing,
 * stage_port_unavailable, stage_not_runnable, ...) — returned as
 * errors, never as success (the #3533 chain-door precedent). Every
 * refusal names the run, the stage, and the reason.
 */

import type { Env } from "../../types";
import type { DatabaseORM, SqlStorage } from "../../orm";
import { ETradeService } from "../../services/etrade";
import type { NasdaqUniverseRouteBundleInput } from "../../trading";
import {
  controlOptionsStage,
  type OptionsStageControlInput,
  type OptionsStageControlOperation,
  type OptionsStageControlResult,
} from "../../workflows/optionsStageControl";
import type { OptionsStageStorage } from "../../workflows/optionsScreenPorts";
import { MeshDoorError, requireActingLogin } from "./meshDoors";
import type { McpToolContext } from "../../patterns/interfaces";

export type OptionsStageControlDoorOperation = OptionsStageControlOperation;

export interface OptionsStageControlDoorContext {
  env: Env;
  /** The host DO's raw SQLite handle — required (no record is addressable without it). */
  sql?: SqlStorage;
  /**
   * The host DO's storage — the same handle the original leg's stage
   * artifacts persist under. The control reads it as a stage store
   * (the NLQ execution's pipelineStorage cast idiom); the E*TRADE
   * client reads it as the universe seam's storage.
   */
  storage?: NasdaqUniverseRouteBundleInput["storage"];
  orm?: DatabaseORM;
  createEtradeService?: (login: string) => ETradeService;
  audit?: (
    type: string,
    agent: string,
    payload: Record<string, unknown>,
  ) => void;
  /** Seam: the control function (tests fake it; production uses controlOptionsStage). */
  controlStage?: (
    input: OptionsStageControlInput,
  ) => Promise<OptionsStageControlResult>;
}

export interface OptionsStageControlDoorInput {
  runId: string;
  stage: string;
  operation: OptionsStageControlDoorOperation;
}

export type OptionsStageControlDoorResult = OptionsStageControlResult;

const CONTROL_OPERATIONS: readonly OptionsStageControlDoorOperation[] = [
  "run",
  "rerun",
  "stop",
  "resume",
  "cancel",
];

function defaultCreateEtradeService(
  ctx: OptionsStageControlDoorContext,
): (actingLogin: string) => ETradeService {
  return (actingLogin: string) =>
    new ETradeService(ctx.orm, ctx.env, actingLogin, undefined, ctx.storage);
}

/**
 * Drive one stage of one options run from the copilot turn.
 * The acting login rides the turn, never the arguments.
 */
export async function controlOptionsStageViaDoor(
  ctx: OptionsStageControlDoorContext,
  actingLogin: string | undefined | null,
  input: OptionsStageControlDoorInput,
): Promise<OptionsStageControlDoorResult> {
  const login = requireActingLogin(actingLogin);
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!runId) {
    throw new MeshDoorError(
      "door_unavailable",
      "options_copilot_stage_control requires a runId — the options run to control; no run was named.",
    );
  }
  const stage = typeof input.stage === "string" ? input.stage.trim() : "";
  if (!stage) {
    throw new MeshDoorError(
      "door_unavailable",
      `options run ${runId}: options_copilot_stage_control requires a stage — one of the 8 addressable options stages; no stage was named.`,
    );
  }
  if (
    !(CONTROL_OPERATIONS as readonly string[]).includes(input.operation)
  ) {
    throw new MeshDoorError(
      "door_unavailable",
      `options run ${runId}: unknown stage operation ${JSON.stringify(input.operation)} — the operations are ${CONTROL_OPERATIONS.join(", ")}.`,
    );
  }
  if (!ctx.sql) {
    throw new MeshDoorError(
      "door_unavailable",
      `options run ${runId}: the stage-control door cannot access SQLite — the executing context carries no instance SQL storage, so no engine record can be addressed.`,
    );
  }
  const needsExecution =
    input.operation === "run" ||
    input.operation === "rerun" ||
    input.operation === "resume";
  const control = ctx.controlStage ?? controlOptionsStage;
  const result = await control({
    sql: ctx.sql,
    ...(ctx.storage
      ? {
          storage: ctx.storage as unknown as OptionsStageStorage | undefined,
        }
      : {}),
    env: ctx.env,
    runId,
    stage,
    operation: input.operation,
    userLogin: login,
    // The chain source is only needed when a stage executes; a
    // stop/cancel never fetches, so no client is built for them.
    ...(needsExecution
      ? {
          etradeClient: (ctx.createEtradeService ??
            defaultCreateEtradeService(ctx))(login).client,
        }
      : {}),
  });
  ctx.audit?.("options_copilot.stage_control_via_door", "orchestrator", {
    runId,
    stage,
    operation: input.operation,
    state: result.state,
    requestShape: result.requestShape,
  });
  return result;
}

/** Build the door context from an MCP tool context (the stock-door shape). */
export function meshOptionsStageControlDoorContextFromMcp(
  context: McpToolContext,
): OptionsStageControlDoorContext {
  const storage = context.storage as unknown as
    | { sql?: SqlStorage }
    | undefined;
  const sql = storage?.sql;
  if (!sql) {
    throw new MeshDoorError(
      "door_unavailable",
      "Options stage-control door cannot access SQLite: executing context carries no instance SQL storage.",
    );
  }
  return {
    env: context.env,
    sql,
    storage: context.storage,
    orm: context.orm,
    audit: (type, agent, payload) => {
      try {
        context.audit(type, agent, payload);
      } catch {}
    },
  };
}
