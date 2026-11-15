/**
 * Issue #2362 (#1976 step 4f) — the quote-source setting port.
 *
 * The setting is the deployment-wide quote source pick from
 * issue #2108 (the WS + HTTP quote surfaces share one
 * Worker-level cache, so the pick is deployment-wide, not
 * per-user). The table's DDL authority is migration 0022
 * (src/data/migrationRunner.ts); before this slice the module
 * self-created it at runtime (step-4 audit R-8).
 *
 * DECLARED FAIL-OPEN (the port contract, previously an
 * ambient side effect of the legacy module): `get()` NEVER
 * throws and NEVER returns an error state. An absent store
 * (composition hands out a port whose reads land nowhere),
 * a missing table, a missing row, an invalid stored value,
 * or any store failure all resolve to "auto" — the legacy
 * env-driven behaviour. Writes are the opposite direction:
 * `set()` ensures the schema and upserts, and a store
 * failure on write propagates to the caller, because a
 * settings write that silently did not land would misreport
 * state to the operator who made it.
 */
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { quoteSourceSetting } from "./drizzleSchema";

export type QuoteSource = "auto" | "alpaca" | "yahoo";

const SOURCES: QuoteSource[] = ["auto", "alpaca", "yahoo"];

export function normalizeQuoteSource(value: unknown): QuoteSource {
  return typeof value === "string" && (SOURCES as string[]).includes(value)
    ? (value as QuoteSource)
    : "auto";
}

/** The Drizzle D1 database object carrying the quote-source setting schema. */
export type QuoteSourceD1Db = DrizzleD1Database<{
  quoteSourceSetting: typeof quoteSourceSetting;
}>;

export interface QuoteSourcePort {
  /** Idempotent schema ensure (the migration-0022 DDL). */
  ensureSchema(): Promise<void>;
  /** Fail-open read: resolves "auto" on any absence or failure. */
  get(): Promise<QuoteSource>;
  /** Normalize, ensure, upsert; returns the stored value. */
  set(source: QuoteSource): Promise<QuoteSource>;
}
