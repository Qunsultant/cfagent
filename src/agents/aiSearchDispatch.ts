/**
 * Issue #2223 (AiSearchAgent slice) — AiSearchAgent A2A dispatch.
 *
 * Serves the aisearch card's single operation for real, following
 * the slice-1 orchestrator template (src/agents/orchestrator/
 * a2aDispatch.ts): extract the operation from the body, dispatch
 * (never throws), wrap the result in an outcome with a mandatory
 * human-readable text part.
 *
 * The one operation, aisearch.search, delegates to the agent's
 * two-path search runner (src/agents/aiSearchPaths.ts) — the same
 * runner the class's search() method and its turn tool use, so the
 * A2A door can never tell a different story from the agent's other
 * doors. A degraded runner result stays degraded through this
 * dispatch: its local outcome token becomes the dispatch code and
 * the text part says so.
 *
 * Operation extraction mirrors the orchestrator dispatch's envelope
 * logic locally: importing it would couple this module to the
 * orchestrator's whole module graph for one pure function.
 */
import {
  runAiSearchPaths,
  type AiSearchAgentErrorToken,
  type AiSearchAgentSearchResult,
} from "./aiSearchPaths";
import { AGENT_ERROR_CATALOG, AgentErrorCode } from "../aspects/errorCodes";
import type { Env } from "../types";

/**
 * The operations this dispatch serves. This constant is the
 * anti-drift source of truth: the aisearch card's operations must
 * equal it (pinned in tests/a2a_aisearch_dispatch_p2223.test.ts).
 */
export const AISEARCH_A2A_OPERATIONS = ["aisearch.search"] as const;

export type AiSearchA2AOperation = (typeof AISEARCH_A2A_OPERATIONS)[number];

type AiSearchA2AErrorToken =
  | "missing_operation"
  | "unknown_operation"
  | "invalid_input"
  | "internal_error"
  | AiSearchAgentErrorToken;

/**
 * Map the local error tokens onto AGENT_ERROR_CATALOG keys, the
 * same pattern as the orchestrator dispatch: unknown / missing
 * operation, invalid input and not-configured are "the request or
 * environment named something the agent does not know / cannot
 * serve" (ERR_UNKNOWN_AGENT_ERROR — the catalog has no validation
 * or configuration class); all-paths-failed and executor failures
 * are ERR_TOOL_EXECUTION_FAILED. No catalog keys are invented
 * here. (The pre-#3342 degraded_fallback entry existed only for
 * the retired REST path's runner outcome and is removed with it.)
 */
const AISEARCH_A2A_CATALOG_CODES: Record<AiSearchA2AErrorToken, AgentErrorCode> = {
  missing_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  unknown_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  not_configured: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  all_paths_failed: AgentErrorCode.TOOL_EXECUTION_FAILED,
  internal_error: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

/** Resolve a local error token to its AGENT_ERROR_CATALOG token. */
function aiSearchErrorCatalogCode(token: AiSearchA2AErrorToken): AgentErrorCode {
  const code = AISEARCH_A2A_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  // Defensive: the catalog is the authority; never emit a token it
  // does not define.
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

export interface AiSearchA2ADataResult {
  ok: boolean;
  operation?: string;
  /** Stable local error token when ok is false. */
  code?: AiSearchA2AErrorToken;
  /** Stable AGENT_ERROR_CATALOG token when ok is false. */
  errorToken?: AgentErrorCode;
  correlationId: string;
  result?: AiSearchAgentSearchResult;
  error?: string;
}

export interface AiSearchA2ADeps {
  /**
   * The search executor. Defaults to the real two-path runner
   * (src/agents/aiSearchPaths.ts); the class injects nothing — the
   * runner IS the agent's search, shared by every door.
   */
  search?: (
    env: Env,
    query: string,
    opts?: { limit?: number },
  ) => Promise<AiSearchAgentSearchResult>;
}

const defaultSearch: NonNullable<AiSearchA2ADeps["search"]> = (env, query, opts) =>
  runAiSearchPaths(env, query, opts ?? {});

/**
 * Extract { operation, args } from an A2A request body: either the
 * JSON-RPC message/send envelope (a data part carrying
 * { operation, ...args }) or a bare { operation, ...args } object.
 * Same envelope logic as the orchestrator dispatch (see header).
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

class AiSearchA2AInputError extends Error {}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Dispatch one A2A body through the aisearch operations. Never throws. */
export async function dispatchAiSearchA2A(
  env: Env,
  body: unknown,
  deps: AiSearchA2ADeps = {},
): Promise<AiSearchA2ADataResult> {
  const correlationId = crypto.randomUUID();
  const extracted = extractA2AOperation(body);
  if (!extracted) {
    return {
      ok: false,
      code: "missing_operation",
      errorToken: aiSearchErrorCatalogCode("missing_operation"),
      correlationId,
      error: "No A2A operation found in the request body.",
    };
  }
  const { operation, args } = extracted;
  if (!(AISEARCH_A2A_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      ok: false,
      operation,
      code: "unknown_operation",
      errorToken: aiSearchErrorCatalogCode("unknown_operation"),
      correlationId,
      error: `Unknown operation: "${operation}".`,
    };
  }
  try {
    const query = stringArg(args, "query");
    if (query === null) {
      throw new AiSearchA2AInputError(
        'Operation "aisearch.search" requires a non-empty string "query" argument.',
      );
    }
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
        ? Math.floor(args.limit)
        : undefined;
    const search = deps.search ?? defaultSearch;
    const result = await search(env, query, limit !== undefined ? { limit } : {});
    if (!result.ok) {
      // A degraded or failed search stays exactly that through the
      // dispatch — never re-wrapped as a success. The runner's own
      // correlationId is preserved on the result; the dispatch adds
      // its code/errorToken alongside.
      const code: AiSearchA2AErrorToken = result.code ?? "internal_error";
      return {
        ok: false,
        operation,
        code,
        errorToken: result.errorToken ?? aiSearchErrorCatalogCode(code),
        correlationId: result.correlationId || correlationId,
        error: result.error ?? result.degraded ?? "AiSearchAgent search did not succeed.",
      };
    }
    return { ok: true, operation, correlationId: result.correlationId || correlationId, result };
  } catch (err) {
    if (err instanceof AiSearchA2AInputError) {
      return {
        ok: false,
        operation,
        code: "invalid_input",
        errorToken: aiSearchErrorCatalogCode("invalid_input"),
        correlationId,
        error: err.message,
      };
    }
    return {
      ok: false,
      operation,
      code: "internal_error",
      errorToken: aiSearchErrorCatalogCode("internal_error"),
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface AiSearchA2AOutcome {
  text: string;
  data: AiSearchA2ADataResult;
}

function successText(data: AiSearchA2ADataResult): string {
  const result = data.result;
  const count = result?.results?.length ?? 0;
  const via = result?.path ? ` via the ${result.path} path` : "";
  const degradedNote = result?.degraded
    ? ` Degraded: the answer was served by a lower-priority path after an earlier path failed.`
    : "";
  return `aisearch.search completed${via}: ${count} result(s) from the Cloudflare AI Search instance.${degradedNote}`;
}

/** Wrap a dispatch result in the collected { text, data } outcome. */
export function aiSearchA2AOutcome(data: AiSearchA2ADataResult): AiSearchA2AOutcome {
  if (!data.ok) {
    return {
      text: `${data.operation ?? "aisearch operation"} failed: ${data.error ?? "unknown error"}`,
      data,
    };
  }
  return { text: successText(data), data };
}
