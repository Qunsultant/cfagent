/**
 * Issue #2359 (#1976 step 4d, ADR 0022 D-I step 4) — the
 * canonical-report store ports: the WRITE port that completes
 * step 3c's deferred half, a READ port for the seam's read
 * surfaces, and the usage-metering port for the seam module's
 * companion table.
 *
 * Step 3a (#2345) ported the mas_reports READ side behind the
 * generic CanonicalReportPort and deliberately left the write
 * side in services/scheduledReports.ts — "the door stays
 * storeReportAtGeneration (one writer, generation-id
 * idempotency)". Step 3c (#2347) landed the fan-out CONTRACT
 * on that seam (declared outcomes, R2-put-before-INSERT,
 * fanout_outcome recorded on the row). This slice moves the
 * seam's STATEMENTS behind these ports without touching the
 * contract: scheduledReports.ts keeps the fan-out logic, the
 * outcome computation, the never-throws discipline and every
 * log line; the ports hold the SQL. The write port is the
 * seam's own storage contract — dedupe lookup, the shared
 * INSERT, fan-out outcome recording, the coupled delete's row
 * half, the backfill pointer rewrite — NOT the generic
 * repository contract, whose column map cannot express the
 * fan-out record.
 *
 * The usage_events port covers the metering companion the
 * step-4 audit assigned to this slice with the seam
 * (audit §4 row 1: mas_reports, usage_events): the accepted
 * metering store of record (#792 determination), DO-resident
 * in whichever instance's seam records the event.
 *
 * Residency (ADR D-0): DO (e)(f) — per-login instance plus
 * owner discipline enforced in the seam (reportOwnerOf
 * refuses owner-less writes); D1 agent_reports remains the
 * projection. This module carries types + interfaces ONLY.
 * Adapters: doSqliteCanonicalReportStoreAdapter.ts +
 * doSqliteUsageEventAdapter.ts (production),
 * inMemoryCanonicalReportStoreAdapters.ts (test doubles).
 *
 * TRANSACTION SEAM (ADR D-C): deliberately none — step 3c
 * ruled the fan-out is NOT a transaction candidate (its only
 * SQL write is one already-atomic INSERT; the R2 / Vectorize
 * / AI Search legs cannot join a DO transaction). The
 * fan-out outcome recording is a read-modify-write over one
 * row under the instance's serialization (property (b)),
 * exactly as the seam ran it inline.
 */
import type { SqlStorage } from "./repositoryPorts";

export type CanonicalReportStoreSqlExecutor = SqlStorage;

/** The full stored row (the seam's hit projection columns). */
export interface CanonicalReportStoredRow {
  id: string;
  run_id: string;
  title: string;
  source: string;
  summary: string;
  body: string;
  created_at: string;
  /**
   * Issue #4116 — the generation id the row was stored under
   * (the twin-link key for the D1 projection). NULL for legacy
   * rows stored before #308, which never carried one.
   */
  generation_id: string | null;
  /**
   * Issue #4116 — the row's owning login (the D1 projection's
   * owner scope: D1-only reads filter by it exactly like the
   * DO read filters by userLogin). NULL for legacy rows stored
   * before #584, which never carried an owner.
   */
  user_login: string | null;
  body_r2_key: string | null;
  fanout_outcome: string | null;
}

/** The stored-row subset the store seams hand to the index hook. */
export interface CanonicalReportStoredContent {
  title: string;
  source: string;
  summary: string;
  body: string;
  bodyR2Key: string | null;
  /** Issue #2602: the row owner, so a redelivery can re-check it before
   *  backfilling the stored body. */
  userLogin?: string;
}

/** The shared INSERT's input (the seam computes every field,
 *  including the recorded fan-out outcome JSON). */
export interface InsertCanonicalReportRow {
  id: string;
  runId: string;
  title: string;
  source: string;
  summary: string;
  body: string;
  createdAt: string;
  generationId: string | null;
  owner: string;
  bodyR2Key: string | null;
  fanoutOutcomeJson: string;
}

export interface CanonicalReportWritePort {
  /** The table's ONE DDL home: base CREATE + additive column
   *  reconciliation + indexes. The generation UNIQUE index is
   *  TENANT-scoped — (user_login, generation_id), the same
   *  pair the dedupe lookup scopes on (#2398) — guarded
   *  exactly as the legacy ensure guarded it, with a shape
   *  reconciliation that swaps a pre-#2398 global index for
   *  the tenant-scoped one. Idempotent. */
  ensureSchema(): void;
  /** The dedupe lookup: the row id stored for a (generation,
   *  owner) pair, or "" when none. Tenant-scoped. */
  findIdByGeneration(generationId: string, owner: string): string;
  /** The stored content behind an id (redelivery hook), or null. */
  findStoredContent(id: string): CanonicalReportStoredContent | null;
  /** THE shared INSERT (body_r2_key + fanout_outcome columns;
   *  a set pointer stores "" in the body column). Insert-or-
   *  throw: the tenant-scoped generation UNIQUE index
   *  (user_login, generation_id) is the backstop — a duplicate
   *  WITHIN a tenant throws; another tenant's row with the
   *  same generation id is a different report and lands. */
  insertRow(row: InsertCanonicalReportRow): void;
  /** Record (overwrite) a row's fan-out outcome JSON — the
   *  dedupe record and the leg-settle updates both land here;
   *  the seam owns the read-modify-write merge. */
  updateFanoutOutcome(reportId: string, fanoutOutcomeJson: string): void;
  /** Replace a row's inline body JSON (issue #2528, slice 1:
   *  canonical artifact-key backfill on redelivery). The seam
   *  owns the merge — it only fills fields that are missing —
   *  and never calls this for R2-pointer rows, whose body
   *  lives in the R2 object, not in this column. */
  updateBody(reportId: string, bodyJson: string): void;
  /** A row's recorded fan-out outcome JSON, or null. */
  getFanoutOutcomeRaw(reportId: string): string | null;
  /** The coupled delete's row half (the seam deletes the R2
   *  object first; see deleteCanonicalReport's contract). */
  deleteRow(reportId: string): void;
  /** The lazy-backfill pointer rewrite, guarded on the
   *  pointer still being NULL so a racing writer wins. */
  backfillBodyPointer(reportId: string, bodyR2Key: string): void;
}

export interface CanonicalReportReadPort {
  /** One row by id (the delivery read-back), or null. */
  getRowById(reportId: string): CanonicalReportStoredRow | null;
  /** One row by run id, newest first, owner-scoped when an owner is given.
   *  Issue #2863: Replay needs the latest canonical copy for a run id,
   *  not the first stored id — duplicates resolve to the newest row. */
  getRowByRunIdForOwner(
    runId: string,
    owner: string | undefined
  ): CanonicalReportStoredRow | null;
  /** One row by id, owner-scoped when an owner is given. */
  getRowByIdForOwner(
    reportId: string,
    owner: string | undefined
  ): CanonicalReportStoredRow | null;
  /** Token search (one LIKE group per token over title /
   *  summary / body), newest first, owner-scoped when given. */
  searchRows(
    tokens: string[],
    owner: string | undefined,
    limit: number
  ): CanonicalReportStoredRow[];
  /** Newest-first listing, owner- and source-scoped as given. */
  listRows(
    owner: string | undefined,
    sourceFilter: string | undefined,
    limit: number
  ): CanonicalReportStoredRow[];
  /** The first row id stored for a run id, or null (the
   *  run-confirmations join's report half). */
  findIdByRunId(runId: string): string | null;
  /** One page of the index backfill, oldest first. */
  listIndexBackfillRows(
    limit: number,
    offset: number
  ): Array<{
    id: string;
    title: string;
    source: string;
    summary: string;
    body: string;
    body_r2_key: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// usage_events — the metering companion (#584 EP-009).
// ---------------------------------------------------------------------------

export interface UsageEventRow {
  id: string;
  userLogin: string;
  runId: string;
  category: string;
  createdAt: string;
}

export interface InsertUsageEventRow extends UsageEventRow {
  detailJson: string | null;
}

export interface UsageEventPort {
  /** Base table + the per-tenant index. Idempotent. */
  ensureSchema(): void;
  /** Append one metered event (insert-or-throw). */
  insertEvent(row: InsertUsageEventRow): void;
  /** One tenant's events, newest first. */
  listByUser(userLogin: string, limit: number): UsageEventRow[];
}
