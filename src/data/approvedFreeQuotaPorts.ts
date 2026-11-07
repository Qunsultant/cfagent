/**
 * Issue #3263 (sub-issue of #3256; ownership COO-spr9) — approved-free
 * per-service quota port.
 *
 * The agreed entitlements definition
 * (docs/architecture/business/entitlements-01.md §5) bounds the
 * operator-granted unlimited-free entitlement (#3245) with a per-service
 * cap per period plus the grant's limited-time window. This module is
 * the ADR 0002 R1 boundary for that bound: it imports no store client,
 * references no env binding, and writes no SQL. Only the adapters
 * (Drizzle D1, in-memory) touch a store, and only the composition root
 * (createApprovedFreeQuotaPorts.ts) maps a Worker binding to an adapter.
 *
 * Shape of the data (all in D1, migration 0054, seeded by migration 0055):
 * - agent_approved_free_quotas: one row per family, the current cap
 *   (runs per period). Operator data, seeded by migration 0055's
 *   INSERT OR IGNORE rows (the decided default, 10 runs per service
 *   per month), so an operator edit survives every later migration run.
 * - agent_approved_free_quota_settings: one row (id 'default') — the
 *   window kind ('month' | 'week') and the at-limit action
 *   ('upgrade_or_buy_credits' | 'stop'). Seeded by migration 0055
 *   (month + upgrade_or_buy_credits, i.e. #3241 decision 4).
 * - agent_approved_free_quota_counts: one row per
 *   (tenant_id, login, family, period), the runs consumed under the
 *   grant in that period. A missing row reads as 0.
 *
 * Tenant scoping (#1069 §10): counts are keyed by tenant_id — a login's
 * usage in Tenant A never leaks to Tenant B and cannot be spent from
 * Tenant B. (The #3305 free-run counter keys (login, family, month)
 * WITHOUT tenant; that is deliberately NOT changed here — the quota
 * tables are tenant-scoped by design.)
 *
 * Period boundary: the window kind selects it. 'month' is the UTC
 * calendar month, "YYYY-MM" (freeRunMonthKey, shared with #3305).
 * 'week' is the ISO week, "YYYY-Www", boundary Monday 00:00 UTC.
 * The time window of the grant itself is the grant's operator-set
 * expiry (expiresAtMs, #3245); no second expiry column is invented.
 *
 * Fail-closed contract: a family with no stored cap row reads as null,
 * and the gate treats null as "no quota configured" — it falls through
 * to the normal gate, exactly as today. Settings missing reads as null
 * with the same fall-through. There is no runtime fallback anywhere in
 * this module: the defaults live only as migration 0055's rows, never
 * in code. No code constant holds a quota number, a window, or an
 * at-limit action.
 *
 * Concurrency note: consumeQuotaRun mirrors consumeFreeRun — the
 * increment is a single conditional upsert (it applies only while
 * used < cap, judged against the CURRENT stored cap inside the
 * statement). The adapter reports applied=false for a consume whose
 * increment did not land, so the gate does not allow a run it did
 * not count.
 */

import { BusinessError } from "../outcomes/outcomeAspects";
import { freeRunMonthKey } from "./freeRunCounterPorts";
import { assertPriceFamily, type PriceFamily } from "./priceCataloguePorts";

/**
 * Issue #3263 — AOP: quota failures are typed, catalog-coded
 * outcomes, never raw errors. The failure kind is recorded at the
 * point of failure (the port assert / adapter read); the route maps
 * the kind to its catalog code and the panel renders the catalog
 * businessMessage (#2573 precedent). `missing_context` is a
 * server-side caller bug (the gate/routes always pass
 * server-resolved values), so it maps to the existing
 * FAILURE_UNEXPECTED_ERROR rather than a quota code.
 */
export type ApprovedFreeQuotaErrorKind =
  | "invalid_family"
  | "invalid_cap"
  | "invalid_window"
  | "invalid_action"
  | "invalid_settings"
  | "missing_context"
  | "corrupt_count";

export const APPROVED_FREE_QUOTA_ERROR_CODES: Record<ApprovedFreeQuotaErrorKind, string> = {
  invalid_family: "FAILURE_APPROVED_FREE_QUOTA_INVALID_FAMILY",
  invalid_cap: "FAILURE_APPROVED_FREE_QUOTA_INVALID_CAP",
  invalid_window: "FAILURE_APPROVED_FREE_QUOTA_INVALID_WINDOW",
  invalid_action: "FAILURE_APPROVED_FREE_QUOTA_INVALID_ACTION",
  invalid_settings: "FAILURE_APPROVED_FREE_QUOTA_INVALID_SETTINGS",
  missing_context: "FAILURE_UNEXPECTED_ERROR",
  corrupt_count: "FAILURE_APPROVED_FREE_QUOTA_CORRUPT",
};

export class ApprovedFreeQuotaError extends BusinessError {
  readonly kind: ApprovedFreeQuotaErrorKind;
  constructor(kind: ApprovedFreeQuotaErrorKind, context: Record<string, unknown> = {}) {
    super(APPROVED_FREE_QUOTA_ERROR_CODES[kind], context);
    this.name = "ApprovedFreeQuotaError";
    this.kind = kind;
  }
}

/**
 * Quota-scoped family assert: wraps the pre-existing
 * `assertPriceFamily` (which raw-throws "Invalid price family")
 * so every family failure in quota code carries the typed kind.
 */
export function assertApprovedFreeQuotaFamily(value: unknown): PriceFamily {
  try {
    return assertPriceFamily(value);
  } catch {
    throw new ApprovedFreeQuotaError("invalid_family", { family: String(value) });
  }
}

/** Families with an approved-free quota. Mirrors the gate's family union. */
export const APPROVED_FREE_QUOTA_FAMILIES: readonly PriceFamily[] = ["stock", "goal", "options", "strategy"];

/** The period over which a per-service cap counts. */
export type ApprovedFreeQuotaWindowKind = "month" | "week";

/** What the user is offered at the limit (#3241 decision 4 + its 'stop' candidate). */
export type ApprovedFreeQuotaAtLimitAction = "upgrade_or_buy_credits" | "stop";

export function assertApprovedFreeQuotaWindowKind(value: unknown): ApprovedFreeQuotaWindowKind {
  if (value !== "month" && value !== "week") {
    throw new ApprovedFreeQuotaError("invalid_window", { windowKind: String(value) });
  }
  return value;
}

export function assertApprovedFreeQuotaAtLimitAction(value: unknown): ApprovedFreeQuotaAtLimitAction {
  if (value !== "upgrade_or_buy_credits" && value !== "stop") {
    throw new ApprovedFreeQuotaError("invalid_action", { atLimitAction: String(value) });
  }
  return value;
}

export function assertApprovedFreeQuotaCap(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ApprovedFreeQuotaError("invalid_cap", { capRuns: typeof value === "number" ? value : String(value) });
  }
  return value;
}

export function assertApprovedFreeQuotaSettings(value: unknown): {
  windowKind: ApprovedFreeQuotaWindowKind;
  atLimitAction: ApprovedFreeQuotaAtLimitAction;
} {
  if (typeof value !== "object" || value === null) {
    throw new ApprovedFreeQuotaError("invalid_settings");
  }
  const settings = value as Record<string, unknown>;
  return {
    windowKind: assertApprovedFreeQuotaWindowKind(settings.windowKind),
    atLimitAction: assertApprovedFreeQuotaAtLimitAction(settings.atLimitAction),
  };
}

/**
 * ISO week key for a timestamp, "YYYY-Www". The week starts Monday
 * 00:00 UTC; the year is the ISO year (the year of the week's Thursday).
 */
export function approvedFreeQuotaWeekKey(nowMs: number): string {
  const d = new Date(nowMs);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0 .. Sunday = 6
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(Date.UTC(isoYear, 0, 4 - jan4Day));
  const week = Math.floor((thursday.getTime() - week1Monday.getTime()) / (7 * 86400000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Period key for a timestamp under a window kind. */
export function approvedFreeQuotaPeriodKey(nowMs: number, windowKind: ApprovedFreeQuotaWindowKind): string {
  const kind = assertApprovedFreeQuotaWindowKind(windowKind);
  return kind === "week" ? approvedFreeQuotaWeekKey(nowMs) : freeRunMonthKey(nowMs);
}

export interface ApprovedFreeQuotaSettings {
  windowKind: ApprovedFreeQuotaWindowKind;
  atLimitAction: ApprovedFreeQuotaAtLimitAction;
  updatedAtMs: number;
  updatedBy: string | null;
}

export interface ApprovedFreeQuotaConsumption {
  /** True only when the run was counted (the increment landed). */
  allowed: boolean;
  /** Runs consumed in this (tenant, login, family, period) after this call. */
  used: number;
  /** Stored cap for the family, or null when unconfigured. */
  cap: number | null;
  /** The period this consumption was judged in. */
  period: string;
}

export interface ApprovedFreeQuotaUsageInput {
  tenantId: string;
  login: string;
  family: string;
  period: string;
}

function assertTenantLogin(input: { tenantId: unknown; login: unknown }): void {
  if (typeof input.tenantId !== "string" || input.tenantId.trim() === "") {
    throw new ApprovedFreeQuotaError("missing_context", { field: "tenantId" });
  }
  if (typeof input.login !== "string" || input.login.trim() === "") {
    throw new ApprovedFreeQuotaError("missing_context", { field: "login" });
  }
}

/**
 * The approved-free quota store surface. `getCap` returns the stored
 * cap (null for a family with no stored row); `getUsed` returns the
 * runs consumed in the period (0 for a (tenant, login, family, period)
 * with no row); `getSettings` returns the stored settings row (null
 * when unconfigured); `consumeQuotaRun` is the gate's single call — it
 * checks the cap and increments in one step, and returns allowed=false
 * (without writing) at the cap or when no cap is configured.
 * `setCap` / `setSettings` are the operator writes: they change the
 * stored values, never the consumed counts. `ensureSchema` applies
 * the quota migrations idempotently — it is a PORT method so route
 * handlers never touch a store handle (Hexagonal, standards §7.1):
 * the D1 adapter applies migrations 0054+0055, the in-memory
 * adapter is a no-op returning [].
 */
export interface ApprovedFreeQuota {
  ensureSchema(): Promise<number[]>;
  getCap(family: string): Promise<number | null>;
  getUsed(input: ApprovedFreeQuotaUsageInput): Promise<number>;
  getSettings(): Promise<ApprovedFreeQuotaSettings | null>;
  consumeQuotaRun(input: ApprovedFreeQuotaUsageInput): Promise<ApprovedFreeQuotaConsumption>;
  setCap(input: { family: unknown; capRuns: unknown; updatedBy?: unknown }): Promise<number>;
  setSettings(input: {
    windowKind?: unknown;
    atLimitAction?: unknown;
    updatedBy?: unknown;
  }): Promise<ApprovedFreeQuotaSettings>;
}

export { assertTenantLogin };
export type { PriceFamily };
