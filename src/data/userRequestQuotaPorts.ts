/**
 * Issue #2842 (#2837 sub-issue) — the per-user report-run quota
 * counter port.
 *
 * The port is deliberately dumb: it knows rows, not policy.
 * Windows, limits, overrides arithmetic, and the fail-closed
 * mapping live in src/security/userRequestQuota.ts. Every
 * operation is synchronous over the host's storage — the gate's
 * probe-then-charge sequence must never await, or the #1993
 * atomicity argument (one DO request at a time, no interleave
 * inside one synchronous stretch) fails.
 *
 * Residency (same argument as the screen lock's ADR D-0 note):
 * the counters live in the per-owner ScreenerAgent instance's
 * own SQLite — the instance IS the user partition, so tenant
 * isolation holds by construction as well as by the
 * (tenantId, userLogin) key. No second store is invented: the
 * screen lock already lives here, and the quota rows sit
 * beside it, not in a new DO.
 */
import type { SqlStorage } from "./repositoryPorts";

export type UserRequestQuotaWindowKind = "daily" | "weekly" | "monthly";

/** One charged run in one window. Kind is attribution only — the pool counts all kinds. */
export interface UserRequestQuotaChargeInput {
  tenantId: string;
  userLogin: string;
  windowKind: UserRequestQuotaWindowKind;
  windowKey: string;
  kind: string;
  runId: string;
  nowMs: number;
}

export interface UserRequestQuotaProbeInput {
  tenantId: string;
  userLogin: string;
  windowKind: UserRequestQuotaWindowKind;
  windowKey: string;
  /** Omitted for pure usage reads (no run to test for idempotency). */
  runId?: string;
  nowMs: number;
}

export interface UserRequestQuotaProbe {
  /** Charged runs in this window (all kinds — one pool). */
  usage: number;
  /** Override rows for this window key (active filtering is policy's job). */
  overrides: UserRequestQuotaOverride[];
  /** True when this run id already holds a charge in this window. */
  alreadyCounted: boolean;
}

export interface UserRequestQuotaOverrideInput {
  tenantId: string;
  userLogin: string;
  windowKind: UserRequestQuotaWindowKind;
  windowKey: string;
  extraRuns: number;
  grantedBy: string;
  reason: string;
  createdMs: number;
  /** Null = applies until the window ends (the route fills this in). */
  expiresMs: number | null;
}

/** The auditable override record: admin, user, tenant, grant, timestamp. */
export interface UserRequestQuotaOverride {
  id: string;
  tenantId: string;
  userLogin: string;
  windowKind: UserRequestQuotaWindowKind;
  windowKey: string;
  extraRuns: number;
  grantedBy: string;
  reason: string;
  createdMs: number;
  expiresMs: number | null;
}

export interface UserRequestQuotaPort {
  /** The tables' DDL home. Ensure-style; idempotent. */
  ensureSchema(): void;
  /** Count charges + overrides for one window; test one run id. */
  probe(input: UserRequestQuotaProbeInput): UserRequestQuotaProbe;
  /** Record one charge, idempotently (a repeat insert is a no-op). */
  chargeWindow(input: UserRequestQuotaChargeInput): { usage: number };
  /** Record an admin override grant (the auditable row). */
  grantOverride(input: UserRequestQuotaOverrideInput): UserRequestQuotaOverride;
  /** All override rows for one user (newest first). */
  listOverrides(input: { tenantId: string; userLogin: string }): UserRequestQuotaOverride[];
}

export type UserRequestQuotaSqlExecutor = SqlStorage;
