/**
 * Issue #2223 (final slice) — ScheduledAgent A2A dispatch.
 *
 * Serves the scheduled card's operations for real, following the
 * TradingAgent template and the payments dispatch shape: extract
 * the operation from the body, dispatch (never throws), wrap the
 * result in an outcome with a mandatory human-readable text part.
 *
 * Instance discipline (SURVEY §1.4 — the sharpest hazard in the
 * survey): A2A resolution for "scheduled" has landed on the live
 * "default" instance since slice 1 (src/a2a/resolution.ts). A
 * virgin instance would seed DEFAULT_SCHEDULES on first read and
 * serve plausible-looking WRONG state; this handler only ever runs
 * on the resolved instance, and nothing here seeds, synthesizes, or
 * fabricates schedule state. onCron — the governed firing path —
 * is deliberately NOT an A2A operation.
 *
 * Wire convention (payments parity): the body's "operation" names
 * the A2A operation, so a goal's catalog operation travels as "op"
 * and is mapped onto addGoal's "operation" field here. The method
 * itself validates the goal semantically (cron shape, catalog
 * membership, duplicate id); its refusals surface as failure
 * results carrying its message. removeGoal / setGoalEnabled
 * returning false is a state answer ("no such goal"), not an
 * error — the same verdict-is-the-result reading as a budget check.
 * triggerGoal returns its tick either way; a tick carrying errors
 * (e.g. goal not found) is reported in the outcome text.
 *
 * The executor has no module-local default: the methods are
 * ScheduledAgent-bound, so the class injects its bound methods and
 * the dispatch fails honestly when no executor is configured.
 */
import { AGENT_ERROR_CATALOG, AgentErrorCode } from "../aspects/errorCodes";
import type { Env } from "../types";
import type { ScheduledGoal, ScheduleTick } from "../schedule";
import { classifyAgentScheduleRequest } from "../services/agentScheduleCapability";

/**
 * The operations this dispatch serves. This constant is the
 * anti-drift source of truth: the scheduled card's operations must
 * equal it (pinned in tests/a2a_remaining_handlers_p2223.test.ts).
 */
export const SCHEDULED_A2A_OPERATIONS = [
  "scheduled.list_goals",
  "scheduled.tick_history",
  "scheduled.add_goal",
  "scheduled.remove_goal",
  "scheduled.set_goal_enabled",
  "scheduled.trigger_goal",
] as const;

export type ScheduledA2AOperation = (typeof SCHEDULED_A2A_OPERATIONS)[number];

type ScheduledA2AErrorToken =
  | "missing_operation"
  | "unknown_operation"
  | "invalid_input"
  | "internal_error";

/**
 * Map the local error tokens onto AGENT_ERROR_CATALOG keys (the
 * slice-1 pattern): request-shape failures are
 * ERR_UNKNOWN_AGENT_ERROR; executor failures are
 * ERR_TOOL_EXECUTION_FAILED. No catalog keys are invented here.
 */
const SCHEDULED_A2A_CATALOG_CODES: Record<ScheduledA2AErrorToken, AgentErrorCode> = {
  missing_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  unknown_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  internal_error: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

/** Resolve a local error token to its AGENT_ERROR_CATALOG token. */
function scheduledErrorCatalogCode(token: ScheduledA2AErrorToken): AgentErrorCode {
  const code = SCHEDULED_A2A_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  // Defensive: the catalog is the authority; never emit a token it
  // does not define.
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

export interface ScheduledA2ADataResult {
  ok: boolean;
  operation?: string;
  /** Stable local error token when ok is false. */
  code?: ScheduledA2AErrorToken;
  /** Stable AGENT_ERROR_CATALOG token when ok is false. */
  errorToken?: AgentErrorCode;
  correlationId: string;
  result?: unknown;
  error?: string;
}

/** The goal shape addGoal accepts (its inline parameter). */
export interface ScheduledAddGoalRequest {
  id: string;
  name: string;
  cron: string;
  operation: string;
  budgetCents: number;
  enabled?: boolean;
  timeZone?: string;
}

/** The ScheduledAgent method surface the dispatch delegates to. */
export interface ScheduledA2AExecutor {
  listGoals(): Promise<ScheduledGoal[]>;
  getTickHistory(limit?: number): Promise<ScheduleTick[]>;
  addGoal(goal: ScheduledAddGoalRequest): Promise<ScheduledGoal>;
  removeGoal(id: string): Promise<boolean>;
  setGoalEnabled(id: string, enabled: boolean): Promise<boolean>;
  triggerGoal(id: string): Promise<ScheduleTick>;
}

export interface ScheduledA2ADeps {
  /**
   * The bound ScheduledAgent methods, injected by the class. No
   * module-local default exists; without one the dispatch fails
   * honestly instead of fabricating a result.
   */
  executor?: ScheduledA2AExecutor;
}

/**
 * Extract { operation, args } from an A2A request body: either the
 * JSON-RPC message/send envelope (a data part carrying
 * { operation, ...args }) or a bare { operation, ...args } object.
 * Same envelope logic as the other #2223 dispatches (kept local —
 * no coupling to another agent's module graph).
 */
function extractA2AOperation(
  body: unknown,
): { operation: string; args: Record<string, unknown> } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  const parts = b.params?.message?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part?.kind === "data" && part.data && typeof part.data === "object") {
        const { operation, ...args } = part.data as Record<string, unknown>;
        if (typeof operation === "string") return { operation, args };
      }
    }
  }
  if (typeof b.operation === "string") {
    const { operation, ...args } = b;
    return { operation: operation as string, args };
  }
  return null;
}

class ScheduledA2AInputError extends Error {}

function stringArg(
  args: Record<string, unknown>,
  key: string,
  operation: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ScheduledA2AInputError(
      `Operation "${operation}" requires a non-empty string "${key}" argument.`,
    );
  }
  return value;
}

function positiveNumberArg(
  args: Record<string, unknown>,
  key: string,
  operation: string,
  required: boolean,
): number | undefined {
  const value = args[key];
  if (value === undefined) {
    if (required) {
      throw new ScheduledA2AInputError(`Operation "${operation}" requires a numeric "${key}" argument.`);
    }
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ScheduledA2AInputError(
      `Operation "${operation}" requires "${key}" to be a positive number${required ? "" : " when present"}.`,
    );
  }
  return value;
}

async function executeOperation(
  operation: ScheduledA2AOperation,
  args: Record<string, unknown>,
  executor: ScheduledA2AExecutor,
): Promise<unknown> {
  switch (operation) {
    case "scheduled.list_goals":
      return executor.listGoals();
    case "scheduled.tick_history": {
      const limit = positiveNumberArg(args, "limit", operation, false);
      return executor.getTickHistory(limit);
    }
    case "scheduled.add_goal": {
      const goal: ScheduledAddGoalRequest = {
        id: stringArg(args, "id", operation),
        name: stringArg(args, "name", operation),
        cron: stringArg(args, "cron", operation),
        // The envelope's "operation" names THIS dispatch; the
        // goal's catalog operation travels as "op" (payments wire
        // convention) and maps onto the method's field here.
        operation: stringArg(args, "op", operation),
        budgetCents: positiveNumberArg(args, "budgetCents", operation, true)!,
      };
      // Issue #3122 (F2): descriptor-only goal operations are excluded
      // from agent scheduling — their firings mint a pending
      // descriptor and execute nothing, so arming one would report
      // success and do no work. This check is principal-free
      // (classification only); PDP + approval + ownership for goal
      // A2A wait on the principal-carrying envelope (#4143).
      const classification = classifyAgentScheduleRequest({
        kind: "goal-operation",
        operation: goal.operation,
        budgetCents: goal.budgetCents,
      });
      if (!classification.schedulable) {
        throw new ScheduledA2AInputError(
          `Operation "scheduled.add_goal" refused: ${classification.denialReason}`,
        );
      }
      if (args.enabled !== undefined) {
        if (typeof args.enabled !== "boolean") {
          throw new ScheduledA2AInputError(`Operation "${operation}" requires "enabled" to be a boolean when present.`);
        }
        goal.enabled = args.enabled;
      }
      if (args.timeZone !== undefined) {
        if (typeof args.timeZone !== "string" || args.timeZone.trim().length === 0) {
          throw new ScheduledA2AInputError(`Operation "${operation}" requires "timeZone" to be a non-empty string when present.`);
        }
        goal.timeZone = args.timeZone;
      }
      return executor.addGoal(goal);
    }
    case "scheduled.remove_goal":
      return executor.removeGoal(stringArg(args, "id", operation));
    case "scheduled.set_goal_enabled": {
      const id = stringArg(args, "id", operation);
      if (typeof args.enabled !== "boolean") {
        throw new ScheduledA2AInputError(`Operation "${operation}" requires a boolean "enabled" argument.`);
      }
      return executor.setGoalEnabled(id, args.enabled);
    }
    case "scheduled.trigger_goal":
      return executor.triggerGoal(stringArg(args, "id", operation));
  }
}

/** Dispatch one A2A body through the scheduled operations. Never throws. */
export async function dispatchScheduledA2A(
  env: Env,
  body: unknown,
  deps: ScheduledA2ADeps,
): Promise<ScheduledA2ADataResult> {
  void env; // The executor carries the env-bound methods; env is part
  // of the template signature (trading / payments parity).
  const correlationId = crypto.randomUUID();
  const extracted = extractA2AOperation(body);
  if (!extracted) {
    return {
      ok: false,
      code: "missing_operation",
      errorToken: scheduledErrorCatalogCode("missing_operation"),
      correlationId,
      error: "No A2A operation found in the request body.",
    };
  }
  const { operation, args } = extracted;
  if (!(SCHEDULED_A2A_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      ok: false,
      operation,
      code: "unknown_operation",
      errorToken: scheduledErrorCatalogCode("unknown_operation"),
      correlationId,
      error: `Unknown operation: "${operation}".`,
    };
  }
  const op = operation as ScheduledA2AOperation;
  try {
    if (!deps.executor) {
      // The methods live on ScheduledAgent; without the class's
      // injected executor there is no honest way to serve this.
      throw new Error("Scheduled executor is not configured for this dispatch context.");
    }
    const result = await executeOperation(op, args, deps.executor);
    return { ok: true, operation, correlationId, result };
  } catch (err) {
    if (err instanceof ScheduledA2AInputError) {
      return {
        ok: false,
        operation,
        code: "invalid_input",
        errorToken: scheduledErrorCatalogCode("invalid_input"),
        correlationId,
        error: err.message,
      };
    }
    return {
      ok: false,
      operation,
      code: "internal_error",
      errorToken: scheduledErrorCatalogCode("internal_error"),
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ScheduledA2AOutcome {
  text: string;
  data: ScheduledA2ADataResult;
}

function successText(data: ScheduledA2ADataResult): string {
  const result = data.result as Record<string, unknown> | boolean | unknown[] | null;
  switch (data.operation) {
    case "scheduled.list_goals":
      return `scheduled.list_goals completed: ${Array.isArray(data.result) ? data.result.length : 0} scheduled goal(s) on the live instance.`;
    case "scheduled.tick_history":
      return `scheduled.tick_history completed: ${Array.isArray(data.result) ? data.result.length : 0} tick record(s).`;
    case "scheduled.add_goal": {
      const goal = (result ?? {}) as Record<string, unknown>;
      return `scheduled.add_goal completed: goal "${String(goal.id ?? "")}" (${String(goal.operation ?? "")}) added ${goal.enabled === false ? "disabled" : "enabled"} on the live instance.`;
    }
    case "scheduled.remove_goal":
      return data.result === true
        ? "scheduled.remove_goal completed: the goal was removed from the live instance."
        : "scheduled.remove_goal completed: no goal with id matched — nothing was removed.";
    case "scheduled.set_goal_enabled":
      return data.result === true
        ? "scheduled.set_goal_enabled completed: the goal's enabled state was updated on the live instance."
        : "scheduled.set_goal_enabled completed: no goal with id matched — nothing was changed.";
    case "scheduled.trigger_goal": {
      const tick = (result ?? {}) as Record<string, unknown>;
      const errors = Array.isArray(tick.errors) ? (tick.errors as string[]) : [];
      return errors.length > 0
        ? `scheduled.trigger_goal completed: the firing reported errors — ${errors.join("; ")}.`
        : `scheduled.trigger_goal completed: ${typeof tick.jobsCreated === "number" ? tick.jobsCreated : 0} job(s) created, ${typeof tick.jobsSkipped === "number" ? tick.jobsSkipped : 0} skipped.`;
    }
    default:
      return `${data.operation ?? "scheduled operation"} completed.`;
  }
}

/** Wrap a dispatch result in the collected { text, data } outcome. */
export function scheduledA2AOutcome(data: ScheduledA2ADataResult): ScheduledA2AOutcome {
  if (!data.ok) {
    return {
      text: `${data.operation ?? "scheduled operation"} failed: ${data.error ?? "unknown error"}`,
      data,
    };
  }
  return { text: successText(data), data };
}
