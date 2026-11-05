/**
 * Issue #3305 (sub-issue of #3241) — free-run counter port.
 *
 * The agreed entitlements definition
 * (docs/architecture/business/entitlements-01.md §4.1) decides a
 * Free allowance of 10 runs per product per month, changeable as
 * operator-managed data. This module is the ADR 0002 R1 boundary
 * for that allowance: it imports no store client, references no
 * env binding, and writes no SQL. Only the adapters (Drizzle D1,
 * in-memory) touch a store, and only the composition root
 * (createFreeRunCounterPorts.ts) maps a Worker binding to an
 * adapter.
 *
 * Shape of the data (all in D1, migration 0043):
 * - agent_free_run_allowances: one row per family, the current
 *   allowance (runs per calendar month). Operator data, seeded
 *   at 10 per family at ensure time (INSERT OR IGNORE, so an
 *   operator edit survives re-ensure).
 * - agent_free_run_counts: one row per (login, family, month),
 *   the runs consumed in that month. A missing row reads as 0.
 *
 * Month boundary: the UTC calendar month, "YYYY-MM"
 * (freeRunMonthKey). The definition says "per calendar month";
 * UTC is the boundary this slice defines — a worker has no
 * user-local timezone, and UTC is the only boundary every
 * caller can compute identically. Tests pin the boundary
 * (2026-11-30T23:59 UTC vs 2026-12-01T00:00 UTC).
 *
 * Fail-closed contract: a family with no stored allowance row
 * reads as null, and the gate treats null as "no free-run
 * allowance configured" — it falls through to the paid path,
 * exactly as today. There is no runtime fallback anywhere in
 * this module: the seed value below is WRITE-time data only.
 * It is written into the store once, at schema-ensure time
 * (D1) or at adapter construction (in-memory test double), and
 * from then on the store is the only source of truth.
 *
 * Concurrency note: consumeFreeRun checks the cap, then
 * increments with a single conditional upsert (the increment
 * applies only while used < allowance). Two concurrent
 * consumes at the boundary can both pass the pre-check; the
 * conditional upsert means the persisted count never exceeds
 * the allowance, and the adapter reports applied=false for a
 * consume whose increment did not land, so the gate does not
 * allow a run it did not count. The same race class exists in
 * the gate's in-memory included-runs decrement; this slice
 * does not pretend to solve it beyond the persisted count.
 */

import type { PriceFamily } from "./priceCataloguePorts";

/** Families with a free-run allowance. Mirrors the gate's family union. */
export const FREE_RUN_FAMILIES: readonly PriceFamily[] = ["stock", "goal", "options", "strategy"];

/**
 * Seed allowance (runs per product per month), NOT an activation
 * and NOT a runtime value. Seeded into the store at ensure time
 * so a fresh store has allowances to read; the gate never reads
 * this constant. An operator changes the allowance in operator
 * data, not in code.
 */
export const DEFAULT_FREE_RUN_ALLOWANCE = 10;

export function assertFreeRunAllowance(runs: unknown): number {
  const value = Number(runs);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("free-run allowance must be a non-negative integer.");
  }
  return value;
}

/**
 * UTC calendar month key for a timestamp, "YYYY-MM". The month
 * boundary is UTC by definition (see the module header).
 */
export function freeRunMonthKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface FreeRunConsumption {
  /** True only when the run was counted (the increment landed). */
  allowed: boolean;
  /** Runs consumed in this (login, family, month) after this call. */
  used: number;
  /** Stored allowance for the family, or null when unconfigured. */
  allowance: number | null;
}

export interface FreeRunUsageInput {
  login: string;
  family: string;
  month: string;
}

/**
 * The free-run counter store surface. `getAllowance` returns the
 * stored allowance (null for a family with no stored row);
 * `getUsed` returns the runs consumed in the month (0 for a
 * (login, family, month) with no row); `consumeFreeRun` is the
 * gate's single call — it checks the cap and increments in one
 * step, and returns allowed=false (without writing) at the cap
 * or when no allowance is configured. `setAllowance` is the
 * operator write: it changes the stored allowance, never the
 * consumed counts.
 */
export interface FreeRunCounter {
  getAllowance(family: string): Promise<number | null>;
  getUsed(input: FreeRunUsageInput): Promise<number>;
  consumeFreeRun(input: FreeRunUsageInput): Promise<FreeRunConsumption>;
  setAllowance(input: { family: unknown; runs: unknown }): Promise<number>;
}
