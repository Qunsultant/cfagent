/**
 * Issue #2381: the single outcome catalog + the single resolver.
 *
 * Successor to src/errors/errorAspects.ts (renamed in the same
 * slice, #2381): the aspect machinery is reused here — withLogging,
 * withSecurity, withExceptionHandling, BusinessError, codedMessage —
 * but it resolves through the outcome catalog, never the old error
 * catalog, and there is no second resolver anywhere.
 *
 * Read-time rules (audit integrity — stored rows are never rewritten):
 * - A pre-rename string resolves through legacyAliases to the NEW
 *   code's aspects. The stored value itself is untouched.
 * - An unknown code passes through unresolved: resolveOutcome
 *   returns resolved=false with a null entry, codedMessage renders
 *   the input code verbatim, and the resolver never invents a code
 *   (the old FAILURE_UNEXPECTED_ERROR fallback is gone by design).
 * - A read never fails: resolveOutcome never throws.
 *
 * Business messages go to UI and channels. Technical details go to
 * logs only.
 */

import catalog from "./outcomeCatalog.json";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "outcomes/outcomeAspects",
});

export interface OutcomeCatalogEntry {
  code: string;
  outcome: "success" | "failure";
  businessMessage: string;
  technicalDetail: string;
  category: string;
  retryable: boolean;
  httpStatus: number;
}

type Catalog = Record<string, OutcomeCatalogEntry>;
const outcomeCatalog = (catalog as { outcomes: Catalog }).outcomes;

/** Read-time only: pre-rename string -> new outcome code. */
export const LEGACY_OUTCOME_ALIASES: Record<string, string> = (
  catalog as { legacyAliases: Record<string, string> }
).legacyAliases;

/** Map a possibly pre-rename code to its current code, verbatim otherwise. */
export function normalizeOutcomeCode(code: string): string {
  return LEGACY_OUTCOME_ALIASES[code] ?? code;
}

export interface OutcomeResolution {
  /** The code as stored/emitted (pre-rename strings preserved here). */
  inputCode: string;
  /** The code the aspects belong to (new code after alias mapping). */
  code: string;
  resolved: boolean;
  entry: OutcomeCatalogEntry | null;
  businessMessage: string | null;
}

/**
 * The one resolver. Never throws, never invents: an unknown code
 * resolves to itself with resolved=false and a null entry.
 */
export function resolveOutcome(code: string): OutcomeResolution {
  const normalized = normalizeOutcomeCode(code);
  const entry = outcomeCatalog[normalized] ?? null;
  return {
    inputCode: code,
    code: entry ? entry.code : code,
    resolved: entry !== null,
    entry,
    businessMessage: entry ? entry.businessMessage : null,
  };
}

/** Catalog entry for a code (alias-aware), or null when unknown. */
export function getOutcome(code: string): OutcomeCatalogEntry | null {
  return resolveOutcome(code).entry;
}

/**
 * Issue #1252 (#1173 R4), re-homed on the outcome catalog: the one
 * rendering of a cataloged outcome — "[CODE] business message" plus
 * an optional specific detail. Every converted surface (user
 * notification, console log, job record) uses this so an outcome
 * carries the SAME code everywhere it appears. Unknown codes render
 * verbatim (passthrough), never substituted with another code.
 */
export function codedMessage(code: string, detail?: string): string {
  const resolved = resolveOutcome(code);
  const base = resolved.entry
    ? `[${resolved.entry.code}] ${resolved.entry.businessMessage}`
    : `[${code}]`;
  return detail ? `${base} — ${detail}` : base;
}

/**
 * Issue #2975 (Phase 5 Slice 9) — channel rendering from the catalog.
 *
 * Templates live in the catalog file's top-level "channelTemplates"
 * section, NOT as outcome entries: the #2381 pin requires every
 * outcomes key to match SUCCESS|FAILURE and carry full outcome
 * fields, and notice/alert texts are not outcomes. Each shipped
 * template has a frozen "legacy_*" twin with identical text at ship
 * time (no copy change); the renderer falls back to the twin when
 * the primary template is missing. A read never fails: unknown keys
 * render a non-blank sentinel, never a throw, never blank.
 */
export interface ChannelTemplateSet {
  slack?: string;
}

export function renderChannelText(
  templateKey: string,
  channel: "slack",
  vars: Record<string, string | number>,
  fallbackTemplateKey?: string,
): string {
  try {
    const templates = (
      catalog as { channelTemplates?: Record<string, ChannelTemplateSet> }
    ).channelTemplates;
    const template =
      templates?.[templateKey]?.[channel] ??
      (fallbackTemplateKey ? templates?.[fallbackTemplateKey]?.[channel] : undefined);
    if (!template) return `[unrendered:${templateKey}]`;
    return template.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = vars[name];
      return value === undefined || value === null ? "" : String(value);
    });
  } catch {
    return `[unrendered:${templateKey}]`;
  }
}

/**
 * True when a message already carries a cataloged (or aliased)
 * outcome code in its leading "[CODE]" bracket — used by the report
 * parsers so an already-coded error is preserved, not double-wrapped.
 * Unknown bracket codes do not count: they are passthrough, not coded.
 */
export function hasOutcomeCodePrefix(message: string): boolean {
  const match = /^\[([^\]]+)\]/.exec(message);
  return match ? resolveOutcome(match[1]).resolved : false;
}

/** Outcome error — carries a catalog code, not a technical message. */
export class BusinessError extends Error {
  readonly code: string;
  readonly entry: OutcomeCatalogEntry | null;
  readonly context: Record<string, unknown>;

  constructor(code: string, context: Record<string, unknown> = {}, cause?: unknown) {
    const resolved = resolveOutcome(code);
    super(resolved.entry ? resolved.entry.businessMessage : code);
    this.name = "BusinessError";
    // Alias-aware: a pre-rename code normalizes to the new code in
    // memory only. Stored rows are never rewritten by this class.
    this.code = resolved.code;
    this.entry = resolved.entry;
    this.context = context;
    if (cause instanceof Error && cause.stack) {
      this.stack = cause.stack;
    }
  }

  /** For UI: only the business message, never technical details. */
  toJSON(): { code: string; message: string; retryable: boolean } {
    return {
      code: this.code,
      message: this.entry ? this.entry.businessMessage : this.code,
      retryable: this.entry ? this.entry.retryable : false,
    };
  }
}

/**
 * Logging aspect: wraps a function with structured entry/exit/exception logs.
 */
export function withLogging<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  context: { component: string; operation: string; traceId?: string },
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
 * Exception handling aspect: catches exceptions, maps to the outcome
 * catalog, logs technical detail, throws BusinessError with the
 * business message.
 */
export function withExceptionHandling<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  context: { component: string; operation: string; defaultCode?: string },
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    try {
      return await fn(...args);
    } catch (err) {
      // If already a BusinessError, pass through (don't double-wrap).
      if (err instanceof BusinessError) throw err;

      // Map to an outcome code based on error content.
      const code = mapToOutcomeCode(err, context.defaultCode || "FAILURE_UNEXPECTED_ERROR");
      const resolved = resolveOutcome(code);

      // Log technical detail (never shown to user).
      structuredLog.error(
        "business_error",
        {
          operation: context.operation,
          code,
          technicalDetail: resolved.entry?.technicalDetail,
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
 * Each check returns null (pass) or an outcome code (fail).
 */
export function withSecurity<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  checks: Array<(args: TArgs) => string | null>,
  context: { component: string },
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    for (const check of checks) {
      const failedCode = check(args);
      if (failedCode) {
        const resolved = resolveOutcome(failedCode);
        structuredLog.warn(
          "security_check_failed",
          { code: resolved.code },
          { component: context.component },
        );
        throw new BusinessError(failedCode);
      }
    }
    return fn(...args);
  };
}

/** Map a raw error to an outcome code. */
function mapToOutcomeCode(err: unknown, defaultCode: string): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("oauth") || msg.includes("401") || msg.includes("token missing")) return "FAILURE_QUOTE_AUTH_MISSING";
  if (msg.includes("429") || msg.includes("rate limit")) return "FAILURE_QUOTE_RATE_LIMITED";
  if (msg.includes("empty response") || msg.includes("no quote data")) return "FAILURE_QUOTE_PARTIAL_SYMBOLS";
  if (msg.includes("parse") || msg.includes("unexpected token") || msg.includes("json")) return "FAILURE_QUOTE_FORMAT_UNEXPECTED";
  if (msg.includes("http 5") || msg.includes("http 4")) return "FAILURE_QUOTE_SERVICE_UNAVAILABLE";
  return defaultCode;
}
