/**
 * Issue #2223 (final slice) — ReportAssetAgent A2A dispatch.
 *
 * Serves the report-asset card's operations for real, following
 * the TradingAgent template and the payments dispatch shape:
 * extract the operation from the body, dispatch (never throws),
 * wrap the result in an outcome with a mandatory human-readable
 * text part.
 *
 * Naming (SURVEY §6.1): the A2A name is the hyphenated card name
 * "report-asset" — the dispatcher's path regex accepts hyphens
 * since slice 1, so the name now reaches resolution (which lands
 * on the service instance "default", src/a2a/resolution.ts) instead
 * of dying at the route. The OPERATIONS keep the class's own
 * report_asset.* spelling.
 *
 * Identity (SURVEY §1.6): the class carries identity in the REQUEST
 * (AssetRequest.userLogin), never in the instance name. This
 * dispatch threads getServiceUserLogin(env) as the request's user
 * scope for generation (overriding any body-supplied login) and
 * fails closed (not_configured) without one. Assets live in the
 * shared report store (R2 when bound), so get is key-addressed and
 * needs no identity.
 *
 * Honesty: generateAsset NEVER throws — it returns null on any
 * failure (SURVEY §1.6(d)). A null here is translated into a
 * generation_failed failure result, never a success. getAsset's
 * null (missing key or store failure — the method conflates them)
 * surfaces as not_found. report_asset.get returns the asset's
 * metadata plus its bytes base64-encoded — the explicit design for
 * carrying bytes in the JSON { text, data } outcome (SURVEY §1.6
 * names generate + a base64 get as the two honest options).
 * report_asset.list (#2421, Agent Mesh S15) enumerates the service
 * instance's asset metadata through the class's listAssets — the
 * list the chat door has had since #2349 — metadata only: asset
 * bytes never ride a listing.
 *
 * The executor has no module-local default: the methods are
 * ReportAssetAgent-bound, so the class injects its bound methods
 * and the dispatch fails honestly when no executor is configured.
 */
import { AGENT_ERROR_CATALOG, AgentErrorCode } from "../aspects/errorCodes";
import { getServiceUserLogin } from "../security/serviceIdentity";
import type { Env } from "../types";
import type {
  AssetRequest,
  AssetResult,
  AssetType,
  ReportAssetMeta,
} from "./report-asset-agent";

/**
 * The operations this dispatch serves. This constant is the
 * anti-drift source of truth: the report-asset card's operations
 * must equal it (pinned in tests/a2a_remaining_handlers_p2223.test.ts).
 */
export const REPORT_ASSET_A2A_OPERATIONS = [
  "report_asset.generate",
  "report_asset.get",
  "report_asset.list",
] as const;

export type ReportAssetA2AOperation = (typeof REPORT_ASSET_A2A_OPERATIONS)[number];

type ReportAssetA2AErrorToken =
  | "missing_operation"
  | "unknown_operation"
  | "invalid_input"
  | "not_configured"
  | "generation_failed"
  | "not_found"
  | "internal_error";

/**
 * Map the local error tokens onto AGENT_ERROR_CATALOG keys (the
 * slice-1 pattern): request-shape, configuration, and not-found
 * failures are ERR_UNKNOWN_AGENT_ERROR (the request named something
 * this door cannot serve or find); execution failures, including a
 * failed generation, are ERR_TOOL_EXECUTION_FAILED. No catalog keys
 * are invented here.
 */
const REPORT_ASSET_A2A_CATALOG_CODES: Record<ReportAssetA2AErrorToken, AgentErrorCode> = {
  missing_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  unknown_operation: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  not_configured: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  not_found: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  generation_failed: AgentErrorCode.TOOL_EXECUTION_FAILED,
  internal_error: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

/** Resolve a local error token to its AGENT_ERROR_CATALOG token. */
function reportAssetErrorCatalogCode(token: ReportAssetA2AErrorToken): AgentErrorCode {
  const code = REPORT_ASSET_A2A_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  // Defensive: the catalog is the authority; never emit a token it
  // does not define.
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

export interface ReportAssetA2ADataResult {
  ok: boolean;
  operation?: string;
  /** Stable local error token when ok is false. */
  code?: ReportAssetA2AErrorToken;
  /** Stable AGENT_ERROR_CATALOG token when ok is false. */
  errorToken?: AgentErrorCode;
  correlationId: string;
  result?: unknown;
  error?: string;
}

/** The ReportAssetAgent method surface the dispatch delegates to. */
export interface ReportAssetA2AExecutor {
  generateAsset(request: AssetRequest): Promise<AssetResult | null>;
  getAsset(key: string): Promise<{ bytes: Uint8Array; fileName: string } | null>;
  listAssets(limit?: number): Promise<ReportAssetMeta[]>;
}

export interface ReportAssetA2ADeps {
  /**
   * The bound ReportAssetAgent methods, injected by the class. No
   * module-local default exists; without one the dispatch fails
   * honestly instead of fabricating a result.
   */
  executor?: ReportAssetA2AExecutor;
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

class ReportAssetA2AInputError extends Error {}
class ReportAssetA2ANotConfiguredError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ASSET_TYPES: readonly string[] = ["research", "screener", "options", "opportunity-hunt"];

/** Chunked base64 for byte payloads (btoa exists in Workers + Node). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function executeOperation(
  operation: ReportAssetA2AOperation,
  args: Record<string, unknown>,
  env: Env,
  executor: ReportAssetA2AExecutor,
): Promise<{ result: unknown; failure?: { code: ReportAssetA2AErrorToken; error: string } }> {
  switch (operation) {
    case "report_asset.generate": {
      const type = args.type;
      if (typeof type !== "string" || !ASSET_TYPES.includes(type)) {
        throw new ReportAssetA2AInputError(
          `Operation "${operation}" requires "type" to be one of ${ASSET_TYPES.join(", ")}.`,
        );
      }
      if (args.data === undefined) {
        throw new ReportAssetA2AInputError(
          `Operation "${operation}" requires a "data" argument (the canonical data the renderer consumes).`,
        );
      }
      const userLogin = getServiceUserLogin(env);
      if (!userLogin) {
        throw new ReportAssetA2ANotConfiguredError(
          `Operation "${operation}" requires a configured service identity (SERVICE_USER_LOGIN): ` +
            "generated assets are scoped to the service identity and fail closed without one (issue #1185).",
        );
      }
      const request: AssetRequest = {
        type: type as AssetType,
        data: args.data,
        userLogin,
      };
      if (args.key !== undefined) {
        if (typeof args.key !== "string" || args.key.trim().length === 0) {
          throw new ReportAssetA2AInputError(`Operation "${operation}" requires "key" to be a non-empty string when present.`);
        }
        request.key = args.key;
      }
      if (args.fileName !== undefined) {
        if (typeof args.fileName !== "string" || args.fileName.trim().length === 0) {
          throw new ReportAssetA2AInputError(`Operation "${operation}" requires "fileName" to be a non-empty string when present.`);
        }
        request.fileName = args.fileName;
      }
      if (args.pdfOptions !== undefined) {
        if (!isRecord(args.pdfOptions)) {
          throw new ReportAssetA2AInputError(`Operation "${operation}" requires "pdfOptions" to be an object when present.`);
        }
        request.pdfOptions = args.pdfOptions as AssetRequest["pdfOptions"];
      }
      const result = await executor.generateAsset(request);
      if (result === null) {
        // The method's failure signal is null (it never throws):
        // translate it into an honest failure, never a success.
        return {
          result: null,
          failure: {
            code: "generation_failed",
            error: "ReportAssetAgent generateAsset returned no asset (generation or storage failed; the method logs the cause).",
          },
        };
      }
      return { result };
    }
    case "report_asset.get": {
      const key = args.key;
      if (typeof key !== "string" || key.trim().length === 0) {
        throw new ReportAssetA2AInputError(`Operation "${operation}" requires a non-empty string "key" argument.`);
      }
      const stored = await executor.getAsset(key);
      if (stored === null) {
        return {
          result: null,
          failure: {
            code: "not_found",
            error: `No asset stored under key "${key}" (or the store could not be read).`,
          },
        };
      }
      return {
        result: {
          key,
          fileName: stored.fileName,
          byteLength: stored.bytes.length,
          bytesBase64: bytesToBase64(stored.bytes),
        },
      };
    }
    case "report_asset.list": {
      let limit: number | undefined;
      if (args.limit !== undefined) {
        if (
          typeof args.limit !== "number" ||
          !Number.isFinite(args.limit) ||
          args.limit <= 0
        ) {
          throw new ReportAssetA2AInputError(
            `Operation "${operation}" requires "limit" to be a positive number when present.`,
          );
        }
        limit = Math.floor(args.limit);
      }
      return { result: await executor.listAssets(limit) };
    }
  }
}

/** Dispatch one A2A body through the report-asset operations. Never throws. */
export async function dispatchReportAssetA2A(
  env: Env,
  body: unknown,
  deps: ReportAssetA2ADeps,
): Promise<ReportAssetA2ADataResult> {
  const correlationId = crypto.randomUUID();
  const extracted = extractA2AOperation(body);
  if (!extracted) {
    return {
      ok: false,
      code: "missing_operation",
      errorToken: reportAssetErrorCatalogCode("missing_operation"),
      correlationId,
      error: "No A2A operation found in the request body.",
    };
  }
  const { operation, args } = extracted;
  if (!(REPORT_ASSET_A2A_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      ok: false,
      operation,
      code: "unknown_operation",
      errorToken: reportAssetErrorCatalogCode("unknown_operation"),
      correlationId,
      error: `Unknown operation: "${operation}".`,
    };
  }
  const op = operation as ReportAssetA2AOperation;
  try {
    if (!deps.executor) {
      // The methods live on ReportAssetAgent; without the class's
      // injected executor there is no honest way to serve this.
      throw new Error("Report asset executor is not configured for this dispatch context.");
    }
    const { result, failure } = await executeOperation(op, args, env, deps.executor);
    if (failure) {
      return {
        ok: false,
        operation,
        code: failure.code,
        errorToken: reportAssetErrorCatalogCode(failure.code),
        correlationId,
        error: failure.error,
      };
    }
    return { ok: true, operation, correlationId, result };
  } catch (err) {
    if (err instanceof ReportAssetA2AInputError) {
      return {
        ok: false,
        operation,
        code: "invalid_input",
        errorToken: reportAssetErrorCatalogCode("invalid_input"),
        correlationId,
        error: err.message,
      };
    }
    if (err instanceof ReportAssetA2ANotConfiguredError) {
      return {
        ok: false,
        operation,
        code: "not_configured",
        errorToken: reportAssetErrorCatalogCode("not_configured"),
        correlationId,
        error: err.message,
      };
    }
    return {
      ok: false,
      operation,
      code: "internal_error",
      errorToken: reportAssetErrorCatalogCode("internal_error"),
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ReportAssetA2AOutcome {
  text: string;
  data: ReportAssetA2ADataResult;
}

function successText(data: ReportAssetA2ADataResult): string {
  const result = data.result as Record<string, unknown> | null;
  switch (data.operation) {
    case "report_asset.generate":
      return `report_asset.generate completed: asset stored as "${String(result?.fileName ?? "")}" under key "${String(result?.key ?? "")}".`;
    case "report_asset.get":
      return `report_asset.get completed: "${String(result?.fileName ?? "")}" (${typeof result?.byteLength === "number" ? result.byteLength : 0} bytes, base64 in the data part).`;
    case "report_asset.list":
      return `report_asset.list completed: ${Array.isArray(data.result) ? data.result.length : 0} asset(s) on the service instance (metadata only — no bytes in a listing).`;
    default:
      return `${data.operation ?? "report-asset operation"} completed.`;
  }
}

/** Wrap a dispatch result in the collected { text, data } outcome. */
export function reportAssetA2AOutcome(data: ReportAssetA2ADataResult): ReportAssetA2AOutcome {
  if (!data.ok) {
    return {
      text: `${data.operation ?? "report-asset operation"} failed: ${data.error ?? "unknown error"}`,
      data,
    };
  }
  return { text: successText(data), data };
}
