/**
 * Aspect-Oriented Programming (AOP) Interceptors
 *
 * Implements:
 * - Cross-Cutting Concerns: Logging, Sandbox Security Guard, and Error Handling decoupled from domain logic.
 * - Standard Library Compliance: Relies strictly on standard console streams and standard Web APIs.
 * - Sensitive Data Masking: Redacts OAuth tokens, client secrets, and consumer keys from logs.
 */

import { ETradeError, ETradeErrorCode, AgentError, AgentErrorCode, resolveErrorAspect } from "./errorCodes";
import { BusinessError } from "../outcomes/outcomeAspects";
import { isETradeHost } from "../config/environment";

export interface AspectContext {
  operationName: string;
  domain?: string;
  isLive?: boolean;
  targetUrl?: string;
  audit?: (event: string, category: string, payload: Record<string, unknown>) => void;
}

/**
 * Sanitizes input arguments to prevent secret leakage in logs
 */
function sanitizeForLog(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeForLog);

  const clean: Record<string, unknown> = {};
  const sensitivePatterns = /key|secret|token|password|authorization|verifier|signature/i;

  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (sensitivePatterns.test(k) && typeof v === "string") {
      clean[k] = v.length > 8 ? `${v.slice(0, 4)}...${v.slice(-4)}` : "***";
    } else if (typeof v === "object") {
      clean[k] = sanitizeForLog(v);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

/**
 * Sandbox Security Guard Aspect
 * Guarantees that in non-live (TEST) mode, NO network call can ever target live production.
 *
 * Exact-hostname matching (CodeQL js/incomplete-url-substring-sanitization,
 * #1034/#1035 — same pattern as #843-#847): substring checks like
 * `url.includes("api.etrade.com")` are bypassable — e.g. the userinfo trick
 * `https://apisb.etrade.com@api.etrade.com/` (real host: api.etrade.com)
 * slipped through because the string also contains "apisb.etrade.com", and
 * percent-encoded hosts were invisible to substring matching entirely.
 * Parse the URL and compare the hostname exactly instead.
 */
export function assertSandboxUrlSafety(url: string, isLive: boolean): void {
  if (!isLive && isETradeHost(url, "api.etrade.com")) {
    throw new ETradeError(
      ETradeErrorCode.SANDBOX_GUARD_VIOLATION,
      `SECURITY VIOLATION: Blocked outgoing call to live production URL [${url}] while running in Sandbox/TEST mode.`
    );
  }
}

/**
 * Aspect Wrapper: executes a function with standardized logging, error translation, and sandbox security check.
 */
export async function withAspects<T>(
  context: AspectContext,
  fn: () => Promise<T> | T
): Promise<T> {
  const start = performance.now();
  const { operationName, isLive, targetUrl, audit } = context;

  // 1. Sandbox Security Guard Aspect
  if (targetUrl !== undefined && isLive !== undefined) {
    assertSandboxUrlSafety(targetUrl, isLive);
  }

  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - start);

    // 2. Logging Aspect (Success)
    console.info(`[Aspect][${operationName}] Completed in ${durationMs}ms`);

    // 3. Audit Aspect
    if (audit) {
      audit(`etrade.${operationName}.success`, "trading", {
        operationName,
        durationMs,
        isLive,
      });
    }

    return result;
  } catch (err: unknown) {
    const durationMs = Math.round(performance.now() - start);

    // Issue #3197: outcome-coded errors pass through like ETradeError —
    // wrapping a BusinessError in INTERNAL_ERROR would strip the
    // outcome code the routes and the hub rely on, while the message
    // alone cannot identify the outcome. Genuinely unhandled errors
    // still take the INTERNAL_ERROR path below.
    if (err instanceof ETradeError || err instanceof BusinessError) {
      console.warn(`[Aspect][${operationName}] Handled error [${err.code}]: ${err.message} (${durationMs}ms)`);
      if (audit) {
        audit(`etrade.${operationName}.failed`, "trading", {
          code: err.code,
          error: err.message,
          durationMs,
        });
      }
      throw err;
    }

    const rawMessage = err instanceof Error ? err.message : String(err);
    console.error(`[Aspect][${operationName}] Unhandled exception (${durationMs}ms):`, rawMessage);

    if (audit) {
      audit(`etrade.${operationName}.error`, "trading", {
        error: rawMessage,
        durationMs,
      });
    }

    throw new ETradeError(ETradeErrorCode.INTERNAL_ERROR, rawMessage, { durationMs });
  }
}

/**
 * Standardized Aspect Event Logger for Cross-Cutting Observability
 */
export interface AspectEvent {
  aspect: string;
  operationName: string;
  code?: string;
  level?: "info" | "warn" | "error";
  durationMs?: number;
  message?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  audit?: (event: string, category: string, payload: Record<string, unknown>) => void;
}

export function logAspectEvent(event: AspectEvent): void {
  const level = event.level || "info";
  const codeTag = event.code ? `[${event.code}]` : "";
  const durationTag = event.durationMs !== undefined ? ` (${event.durationMs}ms)` : "";
  const logPrefix = `[Aspect][${event.aspect}][${event.operationName}]${codeTag}`;
  const details = event.message || event.error || "";

  if (level === "error") {
    console.error(`${logPrefix}${durationTag} ERROR:`, details, event.metadata || "");
  } else if (level === "warn") {
    console.warn(`${logPrefix}${durationTag} WARN:`, details, event.metadata || "");
  } else {
    console.info(`${logPrefix}${durationTag}`, details, event.metadata || "");
  }

  if (event.audit) {
    const auditStatus = level === "error" ? "error" : level === "warn" ? "warning" : "completed";
    event.audit(`${event.aspect.toLowerCase()}.${event.operationName.toLowerCase()}.${auditStatus}`, event.aspect.toLowerCase(), {
      operationName: event.operationName,
      code: event.code,
      level,
      durationMs: event.durationMs,
      message: event.message,
      error: event.error,
      ...event.metadata,
    });
  }
}

export interface AgentAspectContext {
  operationName: string;
  userLogin?: string;
  model?: string;
  audit?: (event: string, category: string, payload: Record<string, unknown>) => void;
}

/**
 * Aspect Wrapper for AI Agent operations: translates raw errors into externalized error codes and logs them as aspects.
 */
export async function withAgentAspect<T>(
  context: AgentAspectContext,
  fn: () => Promise<T> | T
): Promise<T> {
  const start = performance.now();
  const { operationName, userLogin, model, audit } = context;

  logAspectEvent({
    aspect: "Agent",
    operationName,
    level: "info",
    message: `Starting execution for ${userLogin || "session"} using model ${model || "default"}`,
  });

  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - start);

    logAspectEvent({
      aspect: "Agent",
      operationName,
      level: "info",
      durationMs,
      message: "Completed successfully",
      audit,
    });

    return result;
  } catch (err: unknown) {

    const durationMs = Math.round(performance.now() - start);
    const resolved = resolveErrorAspect(err);

    logAspectEvent({
      aspect: "Agent",
      operationName,
      code: resolved.code,
      level: "error",
      durationMs,
      error: resolved.message,
      metadata: { remediation: resolved.remediation, resolutionSteps: resolved.resolutionSteps },
      audit,
    });

    throw new AgentError(resolved.code as AgentErrorCode, resolved.message, {
      durationMs,
      remediation: resolved.remediation,
      resolutionSteps: resolved.resolutionSteps,
      rawError: resolved.rawError,
    });
  }
}

