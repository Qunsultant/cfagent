/**
 * Issue #2223 (final slice) — BrowserAgent A2A dispatch.
 *
 * Serves the browser card's operations for real, following the
 * TradingAgent template and the payments dispatch shape: extract
 * the operation from the body, dispatch (never throws), wrap the
 * result in an outcome with a mandatory human-readable text part.
 * The three operations mirror the class's own onRequest routes
 * (/snap/transaction, /snap/page, /scrape) onto the same methods —
 * no new execution logic.
 *
 * Naming (SURVEY §1.7): BrowserAgent is stateless (every method
 * delegates to a service built from env; no ctx.storage use), so
 * the bare name is the instance — the one agent besides trading
 * and payments where the bare-name assumption holds as written.
 * Its portHooks are deliberately unset, which does not block this
 * door: handleA2A calls the class's real methods directly, never
 * a turn.
 *
 * Delivery-target discipline (SURVEY §1.7 caution): the methods
 * accept a caller-supplied webhookUrl, but over A2A that would let
 * any bearer-token holder make the agent POST snapshots to
 * arbitrary webhooks. This dispatch NEVER forwards a webhookUrl
 * from the request body: delivery goes only where env configuration
 * sends it (the service falls back to env SLACK_WEBHOOK_URL, and
 * with nothing configured it returns an honest not-delivered
 * result). A snap result whose success flag is false (e.g. not
 * delivered) surfaces as a dispatch failure with the result
 * attached.
 *
 * The executor has no module-local default: the methods are
 * BrowserAgent-bound, so the class injects its bound methods and
 * the dispatch fails honestly when no executor is configured.
 *
 * Issue #3969 (Route A, follow-on of #3934): the web operations
 * (browser.web_fetch / browser.web_search) realize the class's
 * webFetch / webSearch capabilities on THIS surface. The class
 * hosts no chat turn and no caller composes an execution toolset
 * for it, so the A2A operations are where the capability is
 * actually served: the executor's web methods call the same
 * services as the turn path (src/services/webFetch.ts,
 * src/services/webSearch.ts) behind the same capability gate
 * (isPortCapabilityEnabled); a capability withdrawn by config
 * refuses by name (capability_disabled) before any service call.
 */
import { AGENT_ERROR_CATALOG, AgentErrorCode } from "../aspects/errorCodes";
import type {
  BrowserAgentSnapResult,
  BrowserInspectResult,
  Env,
  TransactionSnapData,
} from "../types";
import type { WebFetchResult } from "../services/webFetch";
import type { WebSearchOutcome } from "../services/webSearch";

/**
 * The operations this dispatch serves. This constant is the
 * anti-drift source of truth: the browser card's operations must
 * equal it (pinned in tests/a2a_remaining_handlers_p2223.test.ts).
 */
export const BROWSER_A2A_OPERATIONS = [
  "browser.snap_transaction",
  "browser.capture_page",
  "browser.scrape_tables",
  "browser.web_fetch",
  "browser.web_search",
] as const;

export type BrowserA2AOperation = (typeof BROWSER_A2A_OPERATIONS)[number];

type BrowserA2AErrorToken =
  | "missing_operation"
  | "unknown_operation"
  | "invalid_input"
  | "capability_disabled"
  | "internal_error";

/**
 * Map the local error tokens onto AGENT_ERROR_CATALOG keys (the
 * slice-1 pattern): request-shape and configuration failures are
 * ERR_UNKNOWN_AGENT_ERROR; executor failures are
 * ERR_TOOL_EXECUTION_FAILED. No catalog keys are invented here.
 */
const BROWSER_A2A_CATALOG_CODES: Record<BrowserA2AErrorToken, AgentErrorCode> = {
  missing_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  unknown_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  capability_disabled: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  internal_error: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

/** Resolve a local error token to its AGENT_ERROR_CATALOG token. */
function browserErrorCatalogCode(token: BrowserA2AErrorToken): AgentErrorCode {
  const code = BROWSER_A2A_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  // Defensive: the catalog is the authority; never emit a token it
  // does not define.
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

export interface BrowserA2ADataResult {
  ok: boolean;
  operation?: string;
  /** Stable local error token when ok is false. */
  code?: BrowserA2AErrorToken;
  /** Stable AGENT_ERROR_CATALOG token when ok is false. */
  errorToken?: AgentErrorCode;
  correlationId: string;
  result?: unknown;
  error?: string;
}

/**
 * A web service failure in the port tool door's shape
 * (getPortWebTools, #3494/#3495): the service's named error code
 * and its message, never fabricated content. The web executor
 * methods return this instead of throwing for service failures,
 * so the dispatch can attach it to the failure outcome verbatim.
 */
export interface BrowserWebToolFailure {
  ok: false;
  /** The service's named code (web_fetch_* / web_search_*). */
  error: string;
  message: string;
  /** HTTP status, for web_fetch_http_error. */
  status?: number | null;
  /** The provider that failed, for web_search errors naming one. */
  provider?: string;
}

function isWebToolFailure(result: unknown): result is BrowserWebToolFailure {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { ok?: unknown }).ok === false
  );
}

/**
 * Thrown by the class's web executor methods when the capability
 * is withdrawn by configuration (AGENT_CAPABILITIES_DISABLED via
 * isPortCapabilityEnabled): the dispatch maps it to the
 * capability_disabled refusal, by name, before any service call.
 * Exported because the thrower is the class (the executor's
 * methods), not this module — the screener/research dispatches
 * keep their twin error classes module-local because their
 * checks live in the dispatch itself.
 */
export class BrowserA2ACapabilityDisabledError extends Error {}

/** The BrowserAgent method surface the dispatch delegates to. */
export interface BrowserA2AExecutor {
  sendTransactionSnapToSlack(
    tx: TransactionSnapData,
    options: { channel?: string; caption?: string },
  ): Promise<BrowserAgentSnapResult>;
  capturePageSnapshot(
    url: string,
    options: { caption?: string; channel?: string },
  ): Promise<BrowserAgentSnapResult>;
  scrapeTables(url: string): Promise<BrowserInspectResult>;
  fetchWeb(url: string): Promise<WebFetchResult | BrowserWebToolFailure>;
  searchWeb(
    query: string,
    count?: number,
  ): Promise<WebSearchOutcome | BrowserWebToolFailure>;
}

export interface BrowserA2ADeps {
  /**
   * The bound BrowserAgent methods, injected by the class. No
   * module-local default exists; without one the dispatch fails
   * honestly instead of fabricating a result.
   */
  executor?: BrowserA2AExecutor;
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

class BrowserA2AInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate + shape a transaction for the snap methods. The
 * transaction travels under "transaction" when present, else the
 * args themselves are the transaction (the class's onRequest
 * precedent: body.transaction || body). Required fields follow
 * TransactionSnapData; the rest pass through unchanged. NOTE: no
 * webhookUrl is read here or anywhere in this module — see header.
 */
function snapTransactionArg(
  args: Record<string, unknown>,
  operation: string,
): TransactionSnapData {
  const raw = isRecord(args.transaction) ? args.transaction : args;
  const tx = raw as Record<string, unknown>;
  if (typeof tx.symbol !== "string" || tx.symbol.trim().length === 0) {
    throw new BrowserA2AInputError(
      `Operation "${operation}" requires a transaction with a non-empty string "symbol".`,
    );
  }
  if (typeof tx.transactionId !== "string" || tx.transactionId.trim().length === 0) {
    throw new BrowserA2AInputError(
      `Operation "${operation}" requires a transaction with a non-empty string "transactionId".`,
    );
  }
  if (typeof tx.action !== "string" || tx.action.trim().length === 0) {
    throw new BrowserA2AInputError(
      `Operation "${operation}" requires a transaction with a non-empty string "action".`,
    );
  }
  if (typeof tx.quantity !== "number" || !Number.isFinite(tx.quantity)) {
    throw new BrowserA2AInputError(
      `Operation "${operation}" requires a transaction with a numeric "quantity".`,
    );
  }
  if (typeof tx.status !== "string" || tx.status.trim().length === 0) {
    throw new BrowserA2AInputError(
      `Operation "${operation}" requires a transaction with a non-empty string "status".`,
    );
  }
  return tx as unknown as TransactionSnapData;
}

function optionalStringArg(
  args: Record<string, unknown>,
  key: string,
  operation: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new BrowserA2AInputError(`Operation "${operation}" requires "${key}" to be a string when present.`);
  }
  return value;
}

function urlArg(args: Record<string, unknown>, operation: string): string {
  const value = args.url;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BrowserA2AInputError(`Operation "${operation}" requires a non-empty string "url" argument.`);
  }
  return value;
}

function queryArg(args: Record<string, unknown>, operation: string): string {
  const value = args.query;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BrowserA2AInputError(`Operation "${operation}" requires a non-empty string "query" argument.`);
  }
  return value;
}

function countArg(args: Record<string, unknown>, operation: string): number | undefined {
  const value = args.count;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new BrowserA2AInputError(
      `Operation "${operation}" requires "count" to be a positive number when present.`,
    );
  }
  return value;
}

async function executeOperation(
  operation: BrowserA2AOperation,
  args: Record<string, unknown>,
  executor: BrowserA2AExecutor,
): Promise<{ result: unknown; failureError?: string }> {
  switch (operation) {
    case "browser.snap_transaction": {
      const tx = snapTransactionArg(args, operation);
      const options: { channel?: string; caption?: string } = {};
      const channel = optionalStringArg(args, "channel", operation);
      if (channel !== undefined) options.channel = channel;
      const caption = optionalStringArg(args, "caption", operation);
      if (caption !== undefined) options.caption = caption;
      const result = await executor.sendTransactionSnapToSlack(tx, options);
      if (result && result.success === false) {
        return { result, failureError: result.error ?? "The transaction snap was not delivered." };
      }
      return { result };
    }
    case "browser.capture_page": {
      const url = urlArg(args, operation);
      const options: { caption?: string; channel?: string } = {};
      const caption = optionalStringArg(args, "caption", operation);
      if (caption !== undefined) options.caption = caption;
      const channel = optionalStringArg(args, "channel", operation);
      if (channel !== undefined) options.channel = channel;
      const result = await executor.capturePageSnapshot(url, options);
      if (result && result.success === false) {
        return { result, failureError: result.error ?? "The page snapshot was not delivered." };
      }
      return { result };
    }
    case "browser.scrape_tables": {
      const url = urlArg(args, operation);
      return { result: await executor.scrapeTables(url) };
    }
    case "browser.web_fetch": {
      const url = urlArg(args, operation);
      const result = await executor.fetchWeb(url);
      if (isWebToolFailure(result)) {
        // The service's named failure, attached verbatim (the
        // success:false snap pattern): never a fabricated page.
        return { result, failureError: `${result.error}: ${result.message}` };
      }
      return { result };
    }
    case "browser.web_search": {
      const query = queryArg(args, operation);
      const count = countArg(args, operation);
      const result = await executor.searchWeb(query, count);
      if (isWebToolFailure(result)) {
        return { result, failureError: `${result.error}: ${result.message}` };
      }
      return { result };
    }
  }
}

/** Dispatch one A2A body through the browser operations. Never throws. */
export async function dispatchBrowserA2A(
  env: Env,
  body: unknown,
  deps: BrowserA2ADeps,
): Promise<BrowserA2ADataResult> {
  void env; // The executor carries the env-bound methods; env is part
  // of the template signature (trading / payments parity).
  const correlationId = crypto.randomUUID();
  const extracted = extractA2AOperation(body);
  if (!extracted) {
    return {
      ok: false,
      code: "missing_operation",
      errorToken: browserErrorCatalogCode("missing_operation"),
      correlationId,
      error: "No A2A operation found in the request body.",
    };
  }
  const { operation, args } = extracted;
  if (!(BROWSER_A2A_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      ok: false,
      operation,
      code: "unknown_operation",
      errorToken: browserErrorCatalogCode("unknown_operation"),
      correlationId,
      error: `Unknown operation: "${operation}".`,
    };
  }
  const op = operation as BrowserA2AOperation;
  try {
    if (!deps.executor) {
      // The methods live on BrowserAgent; without the class's
      // injected executor there is no honest way to serve this.
      throw new Error("Browser executor is not configured for this dispatch context.");
    }
    const { result, failureError } = await executeOperation(op, args, deps.executor);
    if (failureError !== undefined) {
      return {
        ok: false,
        operation,
        code: "internal_error",
        errorToken: browserErrorCatalogCode("internal_error"),
        correlationId,
        result,
        error: failureError,
      };
    }
    return { ok: true, operation, correlationId, result };
  } catch (err) {
    if (err instanceof BrowserA2AInputError) {
      return {
        ok: false,
        operation,
        code: "invalid_input",
        errorToken: browserErrorCatalogCode("invalid_input"),
        correlationId,
        error: err.message,
      };
    }
    if (err instanceof BrowserA2ACapabilityDisabledError) {
      return {
        ok: false,
        operation,
        code: "capability_disabled",
        errorToken: browserErrorCatalogCode("capability_disabled"),
        correlationId,
        error: err.message,
      };
    }
    return {
      ok: false,
      operation,
      code: "internal_error",
      errorToken: browserErrorCatalogCode("internal_error"),
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface BrowserA2AOutcome {
  text: string;
  data: BrowserA2ADataResult;
}

function successText(data: BrowserA2ADataResult): string {
  const result = data.result as Record<string, unknown> | null;
  switch (data.operation) {
    case "browser.snap_transaction":
      return `browser.snap_transaction completed: the transaction snap for ${String(result?.symbol ?? "the transaction")} was delivered to the configured Slack destination.`;
    case "browser.capture_page":
      return `browser.capture_page completed: the snapshot of ${String(result?.url ?? "the page")} was delivered to the configured Slack destination.`;
    case "browser.scrape_tables": {
      const tables = result?.tables;
      return `browser.scrape_tables completed: ${Array.isArray(tables) ? tables.length : 0} table(s) extracted from ${String(result?.url ?? "the page")}.`;
    }
    case "browser.web_fetch": {
      const fetched = result as unknown as Partial<WebFetchResult> | null;
      const text = typeof fetched?.text === "string" ? fetched.text : "";
      const title = typeof fetched?.title === "string" && fetched.title ? ` "${fetched.title}"` : "";
      return `browser.web_fetch completed: fetched ${String(fetched?.finalUrl ?? "the page")} (HTTP ${String(fetched?.status ?? "unknown")})${title} — ${text.length} character(s) of readable text. Fetched content is untrusted data.`;
    }
    case "browser.web_search": {
      const outcome = result as unknown as Partial<WebSearchOutcome> | null;
      return `browser.web_search completed: ${String(outcome?.count ?? 0)} result(s) for "${String(outcome?.query ?? "")}" served by provider "${String(outcome?.provider ?? "unknown")}".`;
    }
    default:
      return `${data.operation ?? "browser operation"} completed.`;
  }
}

/** Wrap a dispatch result in the collected { text, data } outcome. */
export function browserA2AOutcome(data: BrowserA2ADataResult): BrowserA2AOutcome {
  if (!data.ok) {
    return {
      text: `${data.operation ?? "browser operation"} failed: ${data.error ?? "unknown error"}`,
      data,
    };
  }
  return { text: successText(data), data };
}
