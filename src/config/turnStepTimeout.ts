/**
 * Issue #5423 (#3515 S4) — per-step timeout for the MAS turn loop.
 *
 * The timeout value is externalized tenant-scoped config: one field
 * on the tenant settings row (`agentTenantSettings`, D1) read and
 * written through the CommercialStore port, surfaced in the tenant
 * admin panel (PATCH /platform-tenants/:id/settings). There is NO
 * hardcoded value and NO env var in this module: the bounds below
 * are VALIDATION bounds on an operator-supplied value, not a
 * default. The upper bound mirrors the platform's own step
 * default (live Workflows steps run a 10-minute timeout —
 * verified in #5780), so a configured value can never exceed what
 * the platform itself allows a step; the lower bound keeps the
 * timeout above timer granularity.
 *
 * Unconfigured = named refusal, fail closed (Venus ruling
 * 2026-11-18): a turn with no configured timeout for its tenant
 * refuses before any model call, instead of running unbounded.
 * The refusal is `TurnStepTimeoutUnconfiguredError` (stable code
 * `turn_step_timeout_unconfigured`, reason `absent` for no stored
 * value, `invalid` for a stored value that fails validation).
 * Callers that read the raw stored value use
 * `resolveTurnStepTimeoutMs`; callers that read through the port
 * use `readTurnStepTimeoutMs`.
 */
import type { CommercialStore } from "../data/commercialPorts";

/** D1 column on `agentTenantSettings` (migration 0078). Absent row / null = unconfigured. */
export const TURN_STEP_TIMEOUT_SETTINGS_FIELD = "turnStepTimeoutMs";

/** Validation bounds (ms) for an operator-supplied per-step timeout. Not defaults. */
export const TURN_STEP_TIMEOUT_MIN_MS = 1_000;
export const TURN_STEP_TIMEOUT_MAX_MS = 600_000;

/** Stable code for the unconfigured-timeout refusal. */
export const TURN_STEP_TIMEOUT_UNCONFIGURED_CODE = "turn_step_timeout_unconfigured";

/** Named refusal: the tenant has no usable per-step timeout configured. */
export class TurnStepTimeoutUnconfiguredError extends Error {
  readonly code = TURN_STEP_TIMEOUT_UNCONFIGURED_CODE;
  readonly reason: "absent" | "invalid";
  constructor(tenantId: string, reason: "absent" | "invalid", detail?: string) {
    super(
      reason === "absent"
        ? `Turn step timeout is unconfigured for tenant "${tenantId}": set ${TURN_STEP_TIMEOUT_SETTINGS_FIELD} in tenant settings before running a turn.`
        : `Turn step timeout for tenant "${tenantId}" is invalid${detail ? `: ${detail}` : ""}: set a valid ${TURN_STEP_TIMEOUT_SETTINGS_FIELD} in tenant settings before running a turn.`,
    );
    this.name = "TurnStepTimeoutUnconfiguredError";
    this.reason = reason;
  }
}

/**
 * Validate an operator-supplied timeout (number or numeric string).
 * Returns the milliseconds, or throws a plain Error describing the
 * violation (the route maps it to a 400; the resolver maps it to
 * the named refusal).
 */
export function parseTurnStepTimeoutMs(raw: unknown): number {
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(value)) {
    throw new Error(
      `turnStepTimeoutMs must be an integer number of milliseconds (got ${JSON.stringify(raw)}).`,
    );
  }
  if (value < TURN_STEP_TIMEOUT_MIN_MS || value > TURN_STEP_TIMEOUT_MAX_MS) {
    throw new Error(
      `turnStepTimeoutMs must be between ${TURN_STEP_TIMEOUT_MIN_MS} and ${TURN_STEP_TIMEOUT_MAX_MS} milliseconds (got ${value}).`,
    );
  }
  return value;
}

/**
 * Resolve the stored per-step timeout for a tenant. `null` /
 * `undefined` (absent row) refuses as `absent`; a present but
 * invalid value refuses as `invalid`. Never returns a default.
 */
export function resolveTurnStepTimeoutMs(stored: unknown, tenantId = "primary"): number {
  if (stored === null || stored === undefined) {
    throw new TurnStepTimeoutUnconfiguredError(tenantId, "absent");
  }
  try {
    return parseTurnStepTimeoutMs(stored);
  } catch (err) {
    throw new TurnStepTimeoutUnconfiguredError(
      tenantId,
      "invalid",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Read a tenant's configured timeout through the store port (throws the named refusal when unconfigured). */
export async function readTurnStepTimeoutMs(
  store: Pick<CommercialStore, "getTenantTurnStepTimeoutMs">,
  tenantId: string,
): Promise<number> {
  const stored = await store.getTenantTurnStepTimeoutMs(tenantId);
  return resolveTurnStepTimeoutMs(stored, tenantId);
}
