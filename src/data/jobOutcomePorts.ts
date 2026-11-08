/**
 * Issue #2356 (#1976 step 4c, ADR 0022 D-I step 4) — job
 * outcome port for the evidence satellites.
 *
 * ADR D-0 ruled this family DO-resident behind a port (audit
 * §3): the feed reader is the owning instance's Autopilot
 * Control (property (e) at write). The family owns TWO tables
 * — mas_job_outcomes AND the mas_job_outcomes_meta prune
 * watermark (audit R-9: enumerated from the module's DDL,
 * not from any prior record). This module carries the record
 * types and the port interface ONLY (ADR 0002 R1/R2).
 * Adapters: doSqliteJobOutcomeAdapter.ts (production),
 * inMemoryJobOutcomeAdapter.ts (test double). The types
 * moved here from src/services/jobOutcomes.ts, which is now
 * a re-export shim.
 *
 * No tenant column exists on either table — the per-login
 * instance IS the scope, exactly as today.
 *
 * TRANSACTION SEAM (ADR D-C): record() is one SELECT + one
 * INSERT OR REPLACE (the write itself is a single atomic
 * statement); prune is idempotent bounded maintenance,
 * applied sequentially exactly as in the legacy module. No
 * wrap is claimed.
 */
import type { SqlStorage } from "../orm";

export type JobOutcomeKind =
  | "stock"
  | "options"
  | "goal"
  | "discovery"
  // Issue #3527 S5 — the corpus sync and the reports
  // canonical-index sweep record their actual runs here too.
  | "corpus"
  | "reports"
  // Issue #3530 slice B — feed runs settled on the pipeline host
  // record here too, through the same one sink.
  | "feed";
export type JobOutcomeTrigger = "manual" | "scheduled";
export type JobOutcomeStatus = "completed" | "failed" | "partial";

export interface JobOutcomeInput {
  id: string;
  kind: JobOutcomeKind;
  trigger: JobOutcomeTrigger;
  status: JobOutcomeStatus;
  scanned?: number;
  matched?: number;
  codedError?: string;
  reportUrl?: string;
  pdfKey?: string;
  xlsxKey?: string;
  csvKey?: string;
  deliveryStates?: Record<string, string>;
  origin: string;
  createdAt?: string;
}

export interface JobOutcomeRow {
  id: string;
  kind: JobOutcomeKind;
  trigger: JobOutcomeTrigger;
  status: JobOutcomeStatus;
  scanned: number | null;
  matched: number | null;
  codedError: string | null;
  reportUrl: string | null;
  pdfKey: string | null;
  xlsxKey: string | null;
  csvKey: string | null;
  deliveryStates: Record<string, string>;
  origin: string;
  createdAt: string;
}

/** Default age window for outcome rows; older history has no reader. */
export const JOB_OUTCOMES_RETENTION_DEFAULT_DAYS = 90;
/** Hard row cap per instance; the feed only reads the newest 50. */
export const JOB_OUTCOMES_KEEP_ROWS = 500;
/** The nightly pass reaches only the shared agent; each per-user agent
 * bounds itself on first use instead (see maybePrune). */
export const JOB_OUTCOMES_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface PruneJobOutcomesOptions {
  /** Age window; <= 0 disables the age prune (the row cap still applies). */
  retentionDays?: number | string | null;
  /** Rows kept regardless of age. Defaults to JOB_OUTCOMES_KEEP_ROWS. */
  keepRows?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface PruneJobOutcomesResult {
  deletedByAge: number;
  deletedByCap: number;
}

/** The job-outcome sink contract (sync, mirroring the legacy
 *  module's seam). Upsert-merge semantics are contractual:
 *  defined scalar fields win, undefined never wipes an
 *  existing value, delivery states merge key-wise, and a
 *  completed/partial re-record without a coded error clears
 *  a stale one. */
export interface JobOutcomeStore {
  ensureTables(): void;
  record(input: JobOutcomeInput): JobOutcomeRow;
  prune(options?: PruneJobOutcomesOptions): PruneJobOutcomesResult;
  maybePrune(nowMs?: number): boolean;
  list(limit?: number): JobOutcomeRow[];
  /**
   * Maintenance surface (added #2358, step 4a — the maintenance
   * route's clear of this table was the family's named bypass):
   * countRows / clearRows serve the operator clear. Neither
   * ensures the tables — a missing table surfaces the store's
   * own error, and the route keeps its missing-table tolerance
   * exactly as before. clearRows deletes ONLY mas_job_outcomes
   * rows: the mas_job_outcomes_meta prune watermark is
   * deliberately preserved, as the route has always done.
   */
  countRows(): number;
  clearRows(): void;
}

export type JobOutcomeSqlExecutor = SqlStorage;
