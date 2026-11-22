/**
 * Issue #5425 (#3515 S5) — SLI/SLO definitions: the two #3515
 * SLO thresholds (uptime target, P95 API latency max).
 *
 * The threshold values are externalized tenant-scoped config:
 * two fields on the tenant settings row (`agentTenantSettings`,
 * D1) read and written through the CommercialStore port,
 * surfaced in the tenant admin panel (PATCH
 * /platform-tenants/:id/settings). There is NO hardcoded value
 * and NO env var in this module: the bounds below are VALIDATION
 * bounds on operator-supplied values, not defaults. The P95
 * upper bound mirrors the platform's own step default (live
 * Workflows steps run a 10-minute timeout — verified in #5780,
 * the same ceiling S4's turn-step timeout uses), so a configured
 * value can never exceed what the platform itself allows a step;
 * the lower bounds keep the values above timer granularity (1 ms)
 * and above a meaningless 0% uptime target.
 *
 * Unconfigured = named refusal, fail closed (Venus ruling
 * 2026-11-18): an SLO with no configured threshold for its
 * tenant reports "unconfigured" and claims no compliance, instead
 * of evaluating against an invented number. The refusal is
 * `SloThresholdsUnconfiguredError` (stable code
 * `slo_thresholds_unconfigured`, reason `absent` for no stored
 * value, `invalid` for a stored value that fails validation,
 * `field` naming which threshold). Callers that read the raw
 * stored values use `resolveSloThresholds`; callers that read
 * through the port use `readSloThresholds`.
 */
import type { CommercialStore } from "../data/commercialPorts";

/** D1 columns on `agentTenantSettings` (migration 0079). Absent row / null = unconfigured. */
export const SLO_UPTIME_TARGET_SETTINGS_FIELD = "sloUptimeTargetRatio";
export const SLO_P95_LATENCY_SETTINGS_FIELD = "sloP95LatencyMaxMs";

/**
 * Validation bounds for an operator-supplied uptime target
 * ratio. Not defaults. The target is a floor: the SLO is met
 * when measured uptime is >= the target. 0 is excluded (a 0%
 * target is meaningless); 1 (100%) is allowed.
 */
export const SLO_UPTIME_TARGET_MIN_RATIO = 0;
export const SLO_UPTIME_TARGET_MAX_RATIO = 1;

/** Validation bounds (ms) for an operator-supplied P95 latency max. Not defaults. */
export const SLO_P95_LATENCY_MIN_MS = 1;
export const SLO_P95_LATENCY_MAX_MS = 600_000;

/** Stable code for the unconfigured-thresholds refusal. */
export const SLO_THRESHOLDS_UNCONFIGURED_CODE = "slo_thresholds_unconfigured";

/** Which SLO threshold the refusal names. */
export type SloThresholdField = "sloUptimeTargetRatio" | "sloP95LatencyMaxMs";

/** Named refusal: the tenant has no usable SLO threshold configured. */
export class SloThresholdsUnconfiguredError extends Error {
  readonly code = SLO_THRESHOLDS_UNCONFIGURED_CODE;
  readonly reason: "absent" | "invalid";
  readonly field: SloThresholdField;
  constructor(
    tenantId: string,
    field: SloThresholdField,
    reason: "absent" | "invalid",
    detail?: string,
  ) {
    super(
      reason === "absent"
        ? `SLO threshold ${field} is unconfigured for tenant "${tenantId}": set ${field} in tenant settings before evaluating the SLO.`
        : `SLO threshold ${field} for tenant "${tenantId}" is invalid${detail ? `: ${detail}` : ""}: set a valid ${field} in tenant settings before evaluating the SLO.`,
    );
    this.name = "SloThresholdsUnconfiguredError";
    this.reason = reason;
    this.field = field;
  }
}

/**
 * Validate an operator-supplied uptime target ratio (number or
 * numeric string). Returns the ratio, or throws a plain Error
 * describing the violation (the route maps it to a 400; the
 * resolver maps it to the named refusal).
 */
export function parseSloUptimeTargetRatio(raw: unknown): number {
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : NaN;
  if (
    !Number.isFinite(value) ||
    value <= SLO_UPTIME_TARGET_MIN_RATIO ||
    value > SLO_UPTIME_TARGET_MAX_RATIO
  ) {
    throw new Error(
      `sloUptimeTargetRatio must be a number greater than ${SLO_UPTIME_TARGET_MIN_RATIO} and at most ${SLO_UPTIME_TARGET_MAX_RATIO} (got ${JSON.stringify(raw)}).`,
    );
  }
  return value;
}

/**
 * Validate an operator-supplied P95 latency max (number or
 * numeric string). Returns the milliseconds, or throws a plain
 * Error describing the violation (the route maps it to a 400;
 * the resolver maps it to the named refusal).
 */
export function parseSloP95LatencyMaxMs(raw: unknown): number {
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(value)) {
    throw new Error(
      `sloP95LatencyMaxMs must be an integer number of milliseconds (got ${JSON.stringify(raw)}).`,
    );
  }
  if (value < SLO_P95_LATENCY_MIN_MS || value > SLO_P95_LATENCY_MAX_MS) {
    throw new Error(
      `sloP95LatencyMaxMs must be between ${SLO_P95_LATENCY_MIN_MS} and ${SLO_P95_LATENCY_MAX_MS} milliseconds (got ${value}).`,
    );
  }
  return value;
}

/** The two SLO thresholds, both configured (never defaulted). */
export interface SloThresholds {
  uptimeTargetRatio: number;
  p95LatencyMaxMs: number;
}

/**
 * Resolve the stored SLO thresholds for a tenant. `null` /
 * `undefined` (absent row) refuses as `absent`; a present but
 * invalid value refuses as `invalid`. The uptime target is
 * checked first, so a refusal names it when both are missing.
 * Never returns a default.
 */
export function resolveSloThresholds(
  stored: { uptimeTargetRatio: unknown; p95LatencyMaxMs: unknown },
  tenantId = "primary",
): SloThresholds {
  if (stored.uptimeTargetRatio === null || stored.uptimeTargetRatio === undefined) {
    throw new SloThresholdsUnconfiguredError(tenantId, "sloUptimeTargetRatio", "absent");
  }
  let uptimeTargetRatio: number;
  try {
    uptimeTargetRatio = parseSloUptimeTargetRatio(stored.uptimeTargetRatio);
  } catch (err) {
    throw new SloThresholdsUnconfiguredError(
      tenantId,
      "sloUptimeTargetRatio",
      "invalid",
      err instanceof Error ? err.message : String(err),
    );
  }
  if (stored.p95LatencyMaxMs === null || stored.p95LatencyMaxMs === undefined) {
    throw new SloThresholdsUnconfiguredError(tenantId, "sloP95LatencyMaxMs", "absent");
  }
  let p95LatencyMaxMs: number;
  try {
    p95LatencyMaxMs = parseSloP95LatencyMaxMs(stored.p95LatencyMaxMs);
  } catch (err) {
    throw new SloThresholdsUnconfiguredError(
      tenantId,
      "sloP95LatencyMaxMs",
      "invalid",
      err instanceof Error ? err.message : String(err),
    );
  }
  return { uptimeTargetRatio, p95LatencyMaxMs };
}

/** Read a tenant's configured SLO thresholds through the store port (throws the named refusal when unconfigured). */
export async function readSloThresholds(
  store: Pick<CommercialStore, "getTenantSloUptimeTargetRatio" | "getTenantSloP95LatencyMaxMs">,
  tenantId: string,
): Promise<SloThresholds> {
  const uptimeTargetRatio = await store.getTenantSloUptimeTargetRatio(tenantId);
  const p95LatencyMaxMs = await store.getTenantSloP95LatencyMaxMs(tenantId);
  return resolveSloThresholds({ uptimeTargetRatio, p95LatencyMaxMs }, tenantId);
}
