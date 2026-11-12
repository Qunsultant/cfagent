/**
 * Issue #2223 (final slice) — ScreenerAgent A2A dispatch.
 *
 * Serves the screener card's operations for real, following the
 * TradingAgent template and the payments dispatch shape: extract
 * the operation from the body, dispatch (never throws), wrap the
 * result in an outcome with a mandatory human-readable text part.
 *
 * Instance discipline (SURVEY §1.3): A2A resolution lands on the
 * service instance "default" only when a service identity is
 * configured (src/a2a/resolution.ts). This dispatch completes the
 * contract: run operations are attributed to getServiceUserLogin(env)
 * explicitly — a caller-supplied userLogin in the body is overridden,
 * never trusted — and fail closed (not_configured) when no service
 * identity exists, instead of letting the class throw on a virgin
 * instance or attribute the run to nobody. The request's test seam
 * (yahooDeps) and the scheduled layer's fallback-provenance marker
 * (providerFallback) are not in the accepted field set: an A2A caller
 * cannot inject a fetcher or stamp a run as a fallback.
 *
 * A completed run whose own record says success:false (e.g. zero
 * quotes — the class "fails honestly" with success:false + error,
 * screener-agent.ts) surfaces as a dispatch failure with the record
 * attached; a partial run (partial qualification) stays a success —
 * it is a qualified report, never a failure (issue #462).
 *
 * The executor has no module-local default: the methods are
 * ScreenerAgent-bound, so the class injects its bound methods and
 * the dispatch fails honestly when no executor is configured.
 */
import { AGENT_ERROR_CATALOG, AgentErrorCode } from "../aspects/errorCodes";
import { getServiceUserLogin } from "../security/serviceIdentity";
import type { Env } from "../types";
import type { OptionScreenerFilter, StockScreenerFilter } from "../types";
import type { ScreeningProviderAssetClass } from "../trading";
import type { ScreenerRunRequest, ScreenerRunResult } from "./screener-agent";
import {
  aggregateShardResults,
  runStockScreenViaEngine,
  type RunStockScreenViaEngine,
  type ScreenEngineAgentGates,
} from "../workflows/runStockScreenViaEngine";
import {
  runGoalScreenViaEngine,
  type RunGoalScreenViaEngine,
} from "../workflows/runGoalScreenViaEngine";
import { workflowTenantId } from "../workflows/screenerWorkflowRoutes";
import type { GoalScreenSubmissionInput } from "../services/goalScreenWorkflowSubmission";
import type { SqlStorage } from "../data/repositoryPorts";
import type { StockScreenRunSpec } from "../workflows/stockScreenRunSpec";
import type { ScreenerTask } from "../services/screenerTaskLedger";
import type { ScenarioDefinition } from "../services/goalScenarioEngine";

/**
 * The operations this dispatch serves. This constant is the
 * anti-drift source of truth: the screener card's operations must
 * equal it (pinned in tests/a2a_remaining_handlers_p2223.test.ts).
 */
export const SCREENER_A2A_OPERATIONS = [
  "screener.run_screen",
  "screener.run_goal_screen",
  "screener.latest",
  "screener.history",
  "screener.list_tasks",
] as const;

export type ScreenerA2AOperation = (typeof SCREENER_A2A_OPERATIONS)[number];

type ScreenerA2AErrorToken =
  | "missing_operation"
  | "unknown_operation"
  | "invalid_input"
  | "not_configured"
  | "internal_error";

/**
 * Map the local error tokens onto AGENT_ERROR_CATALOG keys (the
 * slice-1 pattern): request-shape and configuration failures are
 * ERR_UNKNOWN_AGENT_ERROR; executor failures are
 * ERR_TOOL_EXECUTION_FAILED. No catalog keys are invented here.
 */
const SCREENER_A2A_CATALOG_CODES: Record<ScreenerA2AErrorToken, AgentErrorCode> = {
  missing_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  unknown_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  not_configured: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  internal_error: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

/** Resolve a local error token to its AGENT_ERROR_CATALOG token. */
function screenerErrorCatalogCode(token: ScreenerA2AErrorToken): AgentErrorCode {
  const code = SCREENER_A2A_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  // Defensive: the catalog is the authority; never emit a token it
  // does not define.
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

export interface ScreenerA2ADataResult {
  ok: boolean;
  operation?: string;
  /** Stable local error token when ok is false. */
  code?: ScreenerA2AErrorToken;
  /** Stable AGENT_ERROR_CATALOG token when ok is false. */
  errorToken?: AgentErrorCode;
  correlationId: string;
  result?: unknown;
  error?: string;
}

/** The ScreenerAgent method surface the dispatch delegates to. */
export interface ScreenerA2AExecutor {
  /**
   * Issue #4278: run_screen no longer delegates to the agent's
   * runScreen — it goes through the one engine seam, so the
   * direct method is gone from this interface (keeping it would
   * invite the next bypass). The seam admits through the gates
   * below; they are optional on the interface so older executors
   * keep compiling, but run_screen fails closed without them.
   *
   * Issue #4279: run_goal_screen likewise no longer delegates to
   * the agent's runGoalScreen — it goes through the one goal seam
   * (runGoalScreenViaEngine, injected on the deps below). The
   * direct method is gone from this interface for the same reason.
   */
  isScreenRunning?: ScreenEngineAgentGates["isScreenRunning"];
  chargeScreenQuota?: ScreenEngineAgentGates["chargeScreenQuota"];
  getLatest(): Promise<ScreenerRunResult | null>;
  getHistory(): Promise<ScreenerRunResult[]>;
  listScreenerTasks(limit?: number): Promise<ScreenerTask[]>;
}

export interface ScreenerA2ADeps {
  /**
   * The bound ScreenerAgent methods, injected by the class. No
   * module-local default exists; without one the dispatch fails
   * honestly instead of fabricating a result.
   */
  executor?: ScreenerA2AExecutor;
  /**
   * Issue #4278: the one engine seam run_screen runs through.
   * Optional: absent, the dispatch calls the real seam; tests
   * inject a fake. The field exists only so a test can
   * substitute the seam — it never selects a different engine.
   */
  runStockScreenViaEngine?: RunStockScreenViaEngine;
  /**
   * Issue #4279: the one goal seam run_goal_screen runs through.
   * Optional: absent, the dispatch calls the real seam; tests
   * inject a fake. Same idiom as runStockScreenViaEngine.
   */
  runGoalScreenViaEngine?: RunGoalScreenViaEngine;
  /**
   * Issue #4279: the DO SQL store the goal seam reads the
   * canonical row back from. Bound by the class (the dispatch
   * itself holds no storage); absent, run_goal_screen fails
   * closed as not configured instead of returning a result it
   * cannot read back.
   */
  getSql?: () => SqlStorage;
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

class ScreenerA2AInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function triggerArg(args: Record<string, unknown>, operation: string): "manual" | "scheduled" {
  const value = args.trigger;
  if (value === undefined) return "manual";
  if (value === "manual" || value === "scheduled") return value;
  throw new ScreenerA2AInputError(
    `Operation "${operation}" requires "trigger" to be "manual" or "scheduled" when present.`,
  );
}

function environmentArg(
  args: Record<string, unknown>,
  operation: string,
): "TEST" | "PROD" | undefined {
  const value = args.environment;
  if (value === undefined) return undefined;
  if (value === "TEST" || value === "PROD") return value;
  throw new ScreenerA2AInputError(
    `Operation "${operation}" requires "environment" to be "TEST" or "PROD" when present.`,
  );
}

function positiveNumberArg(
  args: Record<string, unknown>,
  key: string,
  operation: string,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ScreenerA2AInputError(
      `Operation "${operation}" requires "${key}" to be a positive number when present.`,
    );
  }
  return value;
}

function serviceLoginOrFail(env: Env, operation: string): string {
  const login = getServiceUserLogin(env);
  if (!login) {
    throw new ScreenerA2ANotConfiguredError(
      `Operation "${operation}" requires a configured service identity (SERVICE_USER_LOGIN): ` +
        "A2A screen runs are attributed to the service identity and fail closed without one (issue #1185).",
    );
  }
  return login;
}

class ScreenerA2ANotConfiguredError extends Error {}

async function executeOperation(
  operation: ScreenerA2AOperation,
  args: Record<string, unknown>,
  env: Env,
  deps: ScreenerA2ADeps,
): Promise<{ result: unknown; failureError?: string }> {
  const executor = deps.executor!;
  const seam = deps.runStockScreenViaEngine;
  switch (operation) {
    case "screener.run_screen": {
      const userLogin = serviceLoginOrFail(env, operation);
      const req: ScreenerRunRequest = {
        trigger: triggerArg(args, operation),
        userLogin,
      };
      if (args.filters !== undefined) {
        if (!isRecord(args.filters)) {
          throw new ScreenerA2AInputError(`Operation "${operation}" requires "filters" to be an object when present.`);
        }
        req.filters = args.filters as StockScreenerFilter;
      }
      if (args.sector !== undefined) {
        if (typeof args.sector !== "string") {
          throw new ScreenerA2AInputError(`Operation "${operation}" requires "sector" to be a string when present.`);
        }
        req.sector = args.sector;
      }
      if (args.universe !== undefined) {
        if (typeof args.universe !== "string" || args.universe.trim().length === 0) {
          throw new ScreenerA2AInputError(`Operation "${operation}" requires "universe" to be a non-empty string when present.`);
        }
        req.universe = args.universe as ScreenerRunRequest["universe"];
      }
      const maxItems = positiveNumberArg(args, "maxItems", operation);
      if (maxItems !== undefined) req.maxItems = maxItems;
      const maxSymbols = positiveNumberArg(args, "maxSymbols", operation);
      if (maxSymbols !== undefined) req.maxSymbols = maxSymbols;
      if (args.symbols !== undefined) {
        if (!Array.isArray(args.symbols)) {
          throw new ScreenerA2AInputError(`Operation "${operation}" requires "symbols" to be an array when present.`);
        }
        req.symbols = args.symbols as ScreenerRunRequest["symbols"];
      }
      const environment = environmentArg(args, operation);
      if (environment !== undefined) req.environment = environment;
      if (args.provider !== undefined) {
        if (args.provider !== "etrade" && args.provider !== "yahoo") {
          throw new ScreenerA2AInputError(`Operation "${operation}" requires "provider" to be "etrade" or "yahoo" when present.`);
        }
        req.provider = args.provider;
      }
      if (args.portfolioContext !== undefined) {
        if (typeof args.portfolioContext !== "boolean") {
          throw new ScreenerA2AInputError(`Operation "${operation}" requires "portfolioContext" to be a boolean when present.`);
        }
        req.portfolioContext = args.portfolioContext;
      }
      // Issue #4278: run_screen goes through the one engine seam
      // (was executor.runScreen). The spec carries trigger /
      // filters; the overrides carry provider, sector, caps, and
      // symbols. Deliver is false: the operation returns the
      // result to the A2A caller, and no bridge delivery exists
      // on this door (the direct path never delivered either —
      // runScreen only persists + marks the deliver boundary).
      // Universe ALL fans out on the engine — the direct path
      // screened ZERO symbols for ALL (resolveUniverse refuses
      // it) — and the shards aggregate back into the one ALL
      // result this operation has always returned. The gates are
      // fail-closed: a run without them cannot be admitted.
      if (!executor.isScreenRunning || !executor.chargeScreenQuota) {
        throw new Error(
          "screener.run_screen requires the executor's isScreenRunning + chargeScreenQuota gates — refusing to run ungated or uncharged (issue #4278).",
        );
      }
      const runEngine = seam ?? runStockScreenViaEngine;
      const spec: StockScreenRunSpec = {
        source: "mesh",
        trigger: req.trigger,
        deliver: false,
        filters: req.filters ?? {},
        universe: req.universe ?? (req.symbols ? "symbols" : "TECH"),
        asyncRequested: false,
        delivery: {},
        userLogin,
      };
      const outcome = await runEngine({
        env,
        spec,
        userLogin,
        ...(req.environment !== undefined ? { environment: req.environment } : {}),
        ...(req.portfolioContext !== undefined ? { portfolioContext: req.portfolioContext } : {}),
        agent: {
          isScreenRunning: (universe, login) => executor.isScreenRunning!(universe, login),
          chargeScreenQuota: (input) => executor.chargeScreenQuota!(input),
          getHistory: () => executor.getHistory(),
        },
        commandOverrides: {
          ...(req.provider ? { provider: req.provider } : {}),
          ...(req.sector ? { sector: req.sector } : {}),
          ...(req.maxItems !== undefined ? { maxItems: req.maxItems } : {}),
          ...(req.maxSymbols !== undefined ? { maxSymbols: req.maxSymbols } : {}),
          ...(req.symbols ? { shards: [{ shardId: "symbols", symbols: req.symbols }] } : {}),
        },
      });
      const result =
        outcome.results.length === 1
          ? outcome.results[0]
          : aggregateShardResults(outcome.results, "ALL");
      // The class's own honest-failure shape: success:false + error.
      // The record stays attached so the caller sees what ran.
      if (result && result.success === false) {
        return { result, failureError: result.error ?? "The screen run reported success:false." };
      }
      return { result };
    }
    case "screener.run_goal_screen": {
      const userLogin = serviceLoginOrFail(env, operation);
      if (!isRecord(args.scenario)) {
        throw new ScreenerA2AInputError(`Operation "${operation}" requires a "scenario" object argument.`);
      }
      const idempotencyKey = args.idempotencyKey;
      if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
        throw new ScreenerA2AInputError(`Operation "${operation}" requires a non-empty string "idempotencyKey" argument.`);
      }
      const environment = environmentArg(args, operation);
      let assetClasses: ScreeningProviderAssetClass[] | undefined;
      if (args.assetClasses !== undefined) {
        if (!Array.isArray(args.assetClasses) || !args.assetClasses.every((v) => typeof v === "string")) {
          throw new ScreenerA2AInputError(`Operation "${operation}" requires "assetClasses" to be an array of strings when present.`);
        }
        assetClasses = args.assetClasses as ScreeningProviderAssetClass[];
      }
      let symbols: string[] | undefined;
      if (args.symbols !== undefined) {
        if (!Array.isArray(args.symbols) || !args.symbols.every((v) => typeof v === "string")) {
          throw new ScreenerA2AInputError(`Operation "${operation}" requires "symbols" to be an array of strings when present.`);
        }
        symbols = args.symbols as string[];
      }
      let baseStockFilter: StockScreenerFilter | undefined;
      if (args.baseStockFilter !== undefined) {
        if (!isRecord(args.baseStockFilter)) {
          throw new ScreenerA2AInputError(`Operation "${operation}" requires "baseStockFilter" to be an object when present.`);
        }
        baseStockFilter = args.baseStockFilter as StockScreenerFilter;
      }
      let baseOptionsFilter: OptionScreenerFilter | undefined;
      if (args.baseOptionsFilter !== undefined) {
        if (!isRecord(args.baseOptionsFilter)) {
          throw new ScreenerA2AInputError(`Operation "${operation}" requires "baseOptionsFilter" to be an object when present.`);
        }
        baseOptionsFilter = args.baseOptionsFilter as OptionScreenerFilter;
      }
      let provider: "yahoo" | undefined;
      if (args.provider !== undefined) {
        if (args.provider !== "yahoo") {
          throw new ScreenerA2AInputError(`Operation "${operation}" requires "provider" to be "yahoo" when present (the goal screen's only alternate provider).`);
        }
        provider = args.provider;
      }
      // Issue #4279: run_goal_screen goes through the one goal seam
      // (was executor.runGoalScreen). The submission carries the
      // A2A caller's base filters onto the goal command, so the
      // migration does not silently drop them; delivery is absent,
      // exactly as the direct path (the dispatch returns the result
      // to the A2A caller — it never delivered). The read-back needs
      // the DO SQL store: without the class's getSql the run cannot
      // be read back, so the operation fails closed as not
      // configured instead of returning a result it cannot read.
      if (!deps.getSql) {
        throw new ScreenerA2ANotConfiguredError(
          `Operation "${operation}" requires the dispatch's getSql store binding — refusing to run a goal screen whose result cannot be read back (issue #4279).`,
        );
      }
      const submission: GoalScreenSubmissionInput = {
        jobId: idempotencyKey,
        source: "a2a",
        trigger: triggerArg(args, operation),
        userLogin,
        tenantId: workflowTenantId(env),
        scenario: args.scenario as unknown as ScenarioDefinition,
        scenarioSource: "built",
        ...(assetClasses ? { assetClasses } : {}),
        ...(symbols ? { symbols } : {}),
        ...(environment !== undefined ? { environment } : {}),
        ...(provider ? { provider } : {}),
        ...(baseStockFilter ? { baseStockFilter } : {}),
        ...(baseOptionsFilter ? { baseOptionsFilter } : {}),
      };
      const runGoal = deps.runGoalScreenViaEngine ?? runGoalScreenViaEngine;
      const result = await runGoal({
        env,
        submission,
        getSql: deps.getSql,
        readTask: async (key) => {
          const tasks = await executor.listScreenerTasks(200);
          return tasks.find((t) => t.idempotencyKey === key) ?? null;
        },
      });
      return { result };
    }
    case "screener.latest":
      return { result: await executor.getLatest() };
    case "screener.history":
      return { result: await executor.getHistory() };
    case "screener.list_tasks": {
      const limit = positiveNumberArg(args, "limit", operation);
      return { result: await executor.listScreenerTasks(limit) };
    }
  }
}

/** Dispatch one A2A body through the screener operations. Never throws. */
export async function dispatchScreenerA2A(
  env: Env,
  body: unknown,
  deps: ScreenerA2ADeps,
): Promise<ScreenerA2ADataResult> {
  const correlationId = crypto.randomUUID();
  const extracted = extractA2AOperation(body);
  if (!extracted) {
    return {
      ok: false,
      code: "missing_operation",
      errorToken: screenerErrorCatalogCode("missing_operation"),
      correlationId,
      error: "No A2A operation found in the request body.",
    };
  }
  const { operation, args } = extracted;
  if (!(SCREENER_A2A_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      ok: false,
      operation,
      code: "unknown_operation",
      errorToken: screenerErrorCatalogCode("unknown_operation"),
      correlationId,
      error: `Unknown operation: "${operation}".`,
    };
  }
  const op = operation as ScreenerA2AOperation;
  try {
    if (!deps.executor) {
      // The methods live on ScreenerAgent; without the class's
      // injected executor there is no honest way to serve this.
      throw new Error("Screener executor is not configured for this dispatch context.");
    }
    const { result, failureError } = await executeOperation(op, args, env, deps);
    if (failureError !== undefined) {
      return {
        ok: false,
        operation,
        code: "internal_error",
        errorToken: screenerErrorCatalogCode("internal_error"),
        correlationId,
        result,
        error: failureError,
      };
    }
    return { ok: true, operation, correlationId, result };
  } catch (err) {
    if (err instanceof ScreenerA2AInputError) {
      return {
        ok: false,
        operation,
        code: "invalid_input",
        errorToken: screenerErrorCatalogCode("invalid_input"),
        correlationId,
        error: err.message,
      };
    }
    if (err instanceof ScreenerA2ANotConfiguredError) {
      return {
        ok: false,
        operation,
        code: "not_configured",
        errorToken: screenerErrorCatalogCode("not_configured"),
        correlationId,
        error: err.message,
      };
    }
    return {
      ok: false,
      operation,
      code: "internal_error",
      errorToken: screenerErrorCatalogCode("internal_error"),
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ScreenerA2AOutcome {
  text: string;
  data: ScreenerA2ADataResult;
}

function successText(data: ScreenerA2ADataResult): string {
  const result = data.result as Record<string, unknown> | null;
  switch (data.operation) {
    case "screener.run_screen": {
      const partial = result?.partial ? " (qualified partial: incomplete quote set)" : "";
      return `screener.run_screen completed: scanned ${typeof result?.totalScanned === "number" ? result.totalScanned : 0} symbol(s), ${typeof result?.matchedCount === "number" ? result.matchedCount : 0} matched${partial}. The run is recorded on the service instance.`;
    }
    case "screener.run_goal_screen": {
      const task = (result?.task ?? {}) as Record<string, unknown>;
      return `screener.run_goal_screen completed: task ${String(task.id ?? "unknown")} ${result?.executed === false ? "already existed (duplicate delivery suppressed)" : "executed"}.`;
    }
    case "screener.latest":
      return data.result === null
        ? "screener.latest completed: no screen run has been recorded on the service instance yet."
        : "screener.latest completed: the most recent screen run on the service instance is attached.";
    case "screener.history":
      return `screener.history completed: ${Array.isArray(data.result) ? data.result.length : 0} recorded run(s) on the service instance.`;
    case "screener.list_tasks":
      return `screener.list_tasks completed: ${Array.isArray(data.result) ? data.result.length : 0} screener task(s).`;
    default:
      return `${data.operation ?? "screener operation"} completed.`;
  }
}

/** Wrap a dispatch result in the collected { text, data } outcome. */
export function screenerA2AOutcome(data: ScreenerA2ADataResult): ScreenerA2AOutcome {
  if (!data.ok) {
    return {
      text: `${data.operation ?? "screener operation"} failed: ${data.error ?? "unknown error"}`,
      data,
    };
  }
  return { text: successText(data), data };
}
