/**
 * Issue #6100 — one attribution envelope: every platform event
 * attributable per tenant / user / session / action.
 *
 * The envelope is defined ONCE, here. It is stamped at the
 * AOP / execution-context boundary (OrchestratorAgent.recordAudit)
 * and carried into every recording path; it is never re-derived
 * per path (Venus ruling 2026-11-22: one envelope, built once).
 *
 * Dimensions and their sources at the boundary:
 * - platform: the DEPLOYMENT identity — a config value
 *   (PLATFORM_ID env, default "cfagent"), resolved by the caller
 *   via resolvePlatformId. CORRECTION to the issue body: the
 *   platformIdentity service (src/services/platformIdentity) does
 *   NOT provide a platform id — it resolves tenant/user for a
 *   verified login and has no platform-id field; `platformId` in
 *   code is the broker enum (src/trading/agent.ts:25); the
 *   Validated ExecutionContext (#1078) has no platform field; the
 *   OTel service name ("ai-search-agent") is a telemetry service
 *   name, not a platform identity. The platform id is deployment
 *   config, never login-resolved and never broker-derived.
 * - tenant: the resolved tenant where the boundary knows it — an
 *   explicit caller value wins (#4623 pattern); otherwise null.
 *   Never invented, never the env default.
 * - principal (user): the executing principal where known — the
 *   in-flight turn's userLogin, or an explicit caller value;
 *   otherwise null.
 * - session: the per-user Durable Object instance key
 *   (OrchestratorAgent.sessionKey) — always present on this path.
 * - action: the thing being recorded. On mas_events the event
 *   `type` IS the action (no separate column); on the canonical
 *   audit it is the `action` field; on metering it is the
 *   `category`.
 * - trace: the in-flight turn's traceparent trace id, parsed with
 *   the shared parseTraceparent; null outside a turn — a trace is
 *   never fabricated.
 * - correlation: the operation id the caller knows (run id, job
 *   id, dispatch id); null when unknown. NEVER minted per row —
 *   a fresh UUID per row would correlate nothing and would read
 *   as a real link.
 *
 * Null means "not resolvable at the boundary", exactly as the
 * #3182 tenant-column precedent: legacy and unattributed rows
 * stay explicitly NULL, and a filtered read excludes nulls.
 * This module is pure: no env access, no Date.now, no random —
 * the caller resolves the platform id and passes it in.
 */
import type { UsageEventRow } from "../data/canonicalReportStorePorts";
import type { AuditEvent } from "../types";

/** The platform's own identity when no PLATFORM_ID is configured. */
export const DEFAULT_PLATFORM_ID = "cfagent";

/**
 * The one attribution envelope. action is always present (it is
 * the row's own identity); every other dimension is null when the
 * boundary cannot resolve it — including sessionId on rows from
 * paths that are not session-scoped (metering).
 */
export interface AttributionEnvelope {
  platformId: string | null;
  tenantId: string | null;
  principalId: string | null;
  sessionId: string | null;
  action: string;
  traceId: string | null;
  correlationId: string | null;
}

/** What the stamping boundary knows synchronously. */
export interface AttributionBoundary {
  /** Already resolved via resolvePlatformId — never a raw env read here. */
  platformId: string;
  sessionId: string;
  action: string;
  tenantId?: string | null;
  principalId?: string | null;
  traceId?: string | null;
  correlationId?: string | null;
}

/**
 * Dimensions a caller may supply explicitly. An explicit
 * non-empty value wins over the boundary's (#4623 pattern);
 * an absent or null override falls back to the boundary.
 */
export type AttributionEnvelopeOverride = Partial<
  Pick<AttributionEnvelope, "tenantId" | "principalId" | "traceId" | "correlationId">
>;

/** Resolve the deployment platform id: the configured value, else the platform's own name. */
export function resolvePlatformId(envValue?: string | null): string {
  const trimmed = typeof envValue === "string" ? envValue.trim() : "";
  return trimmed.length > 0 ? trimmed : DEFAULT_PLATFORM_ID;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Stamp the envelope from what the boundary knows, with an
 * explicit caller override winning per field. Deterministic:
 * no time, no randomness — the same inputs give the same envelope.
 */
export function resolveAttributionEnvelope(
  boundary: AttributionBoundary,
  override: AttributionEnvelopeOverride = {},
): AttributionEnvelope {
  return {
    platformId: clean(boundary.platformId) ?? DEFAULT_PLATFORM_ID,
    tenantId: clean(override.tenantId ?? boundary.tenantId),
    principalId: clean(override.principalId ?? boundary.principalId),
    sessionId: boundary.sessionId,
    action: boundary.action,
    traceId: clean(override.traceId ?? boundary.traceId),
    correlationId: clean(override.correlationId ?? boundary.correlationId),
  };
}

/**
 * Map a metering row onto the same envelope. usage_events keeps
 * its metering axis — the mapping aligns keys, it does not
 * change the row: tenant_id is the tenant, user_login is the
 * principal, category is the action, run_id is the correlation.
 * Metering is not session-scoped and carries no trace, so those
 * dimensions are null, honestly.
 */
export function usageEventToEnvelope(
  row: UsageEventRow,
  platformId: string,
): AttributionEnvelope {
  return {
    platformId: clean(platformId) ?? DEFAULT_PLATFORM_ID,
    tenantId: clean(row.tenantId),
    principalId: clean(row.userLogin),
    sessionId: null,
    action: row.category,
    traceId: null,
    correlationId: clean(row.runId),
  };
}

/** Map a stored mas_events row onto the envelope (action = type). */
export function auditEventToEnvelope(row: AuditEvent): AttributionEnvelope {
  return {
    platformId: clean(row.platformId),
    tenantId: clean(row.tenantId),
    principalId: clean(row.principalId),
    sessionId: row.sessionId,
    action: row.type,
    traceId: clean(row.traceId),
    correlationId: clean(row.correlationId),
  };
}
