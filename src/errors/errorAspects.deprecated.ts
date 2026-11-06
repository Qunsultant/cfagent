/**
 * @deprecated Superseded by src/outcomes/outcomeAspects.ts and
 * src/outcomes/outcomeCatalog.json (issue #2381). Frozen: no new
 * features, no new consumers — retained only so pre-rename history
 * stays readable. Do not import this file; use the outcome resolver.
 *
 * Issue #817: aspect-oriented cross-cutting concerns.
 *
 * Three aspects that wrap business logic:
 * - withLogging: structured JSON logs (entry, exit, exception)
 * - withSecurity: auth/validation gates before execution
 * - withExceptionHandling: maps exceptions to error catalog,
 *   logs technical detail, returns business message to caller
 *
 * Business messages go to UI. Technical details go to logs only.
 */

import catalog from "./errorCatalog.deprecated.json";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "errors/errorAspects.deprecated",
});

export interface ErrorCatalogEntry {
  code: string;
  businessMessage: string;
  technicalDetail: string;
  category: string;
  retryable: boolean;
  httpStatus: number;
}

type Catalog = Record<string, ErrorCatalogEntry>;
const errorCatalog = (catalog as { errors: Catalog }).errors;

export function getError(code: string): ErrorCatalogEntry {
  return errorCatalog[code] || errorCatalog["SYS_001"];
}

/**
 * Issue #1252 (#1173 R4): the one rendering of a cataloged failure —
 * "[CODE] business message" plus an optional specific detail. Every
 * converted surface (user notification, console log, job record) uses
 * this so a failure carries the SAME code everywhere it appears.
 * Unknown codes render as SYS_001 via getError's fallback (the
 * catalog integrity test pins every referenced code to a real entry).
 */
export function codedMessage(code: string, detail?: string): string {
  const entry = getError(code);
  const base = `[${entry.code}] ${entry.businessMessage}`;
  return detail ? `${base} — ${detail}` : base;
}

/** Business error — carries a catalog code, not a technical message. */
export class BusinessError extends Error {
  readonly code: string;
  readonly entry: ErrorCatalogEntry;
  readonly context: Record<string, unknown>;

  constructor(code: string, context: Record<string, unknown> = {}, cause?: unknown) {
    const entry = getError(code);
    super(entry.businessMessage);
    this.name = "BusinessError";
    this.code = code;
    this.entry = entry;
    this.context = context;
    if (cause instanceof Error && cause.stack) {
      this.stack = cause.stack;
    }
  }

  /** For UI: only the business message, never technical details. */
  toJSON(): { code: string; message: string; retryable: boolean } {
    return {
      code: this.code,
      message: this.entry.businessMessage,
      retryable: this.entry.retryable,
    };
  }
}

/**
 * Logging aspect: wraps a function with structured entry/exit/exception logs.
 */
export function withLogging<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  context: { component: string; operation: string; traceId?: string }
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    const start = Date.now();
    const traceId = context.traceId || `ax_${Date.now().toString(36)}`;
    structuredLog.info(
      "aspect_enter",
      { operation: context.operation },
      { component: context.component, traceId },
    );
    try {
      const result = await fn(...args);
      structuredLog.info(
        "aspect_exit",
        { operation: context.operation, durationMs: Date.now() - start },
        { component: context.component, traceId },
      );
      return result;
    } catch (err) {
      // Log technical detail, rethrow for the exception aspect to handle.
      structuredLog.error(
        "aspect_exception",
        {
          operation: context.operation,
          durationMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack?.slice(0, 1000) : undefined,
        },
        { component: context.component, traceId },
      );
      throw err;
    }
  };
}

/**
 * Exception handling aspect: catches exceptions, maps to catalog,
 * logs technical detail, throws BusinessError with business message.
 */
export function withExceptionHandling<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  context: { component: string; operation: string; defaultCode?: string }
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    try {
      return await fn(...args);
    } catch (err) {
      // If already a BusinessError, pass through (don't double-wrap).
      if (err instanceof BusinessError) throw err;

      // Map to catalog code based on error content.
      const code = mapToErrorCode(err, context.defaultCode || "SYS_001");
      const entry = getError(code);

      // Log technical detail (never shown to user).
      structuredLog.error(
        "business_error",
        {
          operation: context.operation,
          code,
          technicalDetail: entry.technicalDetail,
          originalError: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack?.slice(0, 1000) : undefined,
        },
        { component: context.component },
      );

      throw new BusinessError(code, { operation: context.operation }, err);
    }
  };
}

/**
 * Security aspect: runs checks before the wrapped function.
 * Each check returns null (pass) or an error code (fail).
 */
export function withSecurity<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  checks: Array<(args: TArgs) => string | null>,
  context: { component: string }
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    for (const check of checks) {
      const failedCode = check(args);
      if (failedCode) {
        const entry = getError(failedCode);
        structuredLog.warn(
          "security_check_failed",
          { code: failedCode },
          { component: context.component },
        );
        throw new BusinessError(failedCode);
      }
    }
    return fn(...args);
  };
}

/** Map a raw error to a catalog code. */
function mapToErrorCode(err: unknown, defaultCode: string): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("oauth") || msg.includes("401") || msg.includes("token missing")) return "QUOTE_001";
  if (msg.includes("429") || msg.includes("rate limit")) return "QUOTE_006";
  if (msg.includes("empty response") || msg.includes("no quote data")) return "QUOTE_003";
  if (msg.includes("parse") || msg.includes("unexpected token") || msg.includes("json")) return "QUOTE_004";
  if (msg.includes("http 5") || msg.includes("http 4")) return "QUOTE_002";
  return defaultCode;
}
