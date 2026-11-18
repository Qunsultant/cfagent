/**
 * Issue #5175 slice 2 — the run registry ports: TWO ports by role
 * over the registry tables (mas_runs + mas_run_aliases).
 *
 * The registry is the resolution half of the one id authority
 * (proposed-solution-5175.md): slice 1's leaf module
 * (src/services/executionTreeIds.ts) mints; this registry records
 * every minted run once so any id resolves. The registry NEVER
 * mints — it only records ids minted elsewhere (slice 1's minters,
 * or legacy ids adopted as aliases), and it NEVER rewrites a
 * legacy id: a legacy id becomes an alias row pointing at its
 * canonical run, readable forever.
 *
 * Record vs resolve are roles over one store in one instance, so
 * the composition root hands the same store out twice (the
 * async-job trio's shape: src/data/createAsyncJobPorts.ts).
 *
 * This module carries the record types and the port interfaces
 * ONLY (ADR 0002 R1/R2). Adapters: doSqliteRunRegistryAdapter.ts
 * (production), inMemoryRunRegistryAdapter.ts (test double).
 * The resolver API + MCP resolve_id (slice 5) serve through the
 * resolve port; no call site is migrated here (slice 3).
 */
import type { SqlStorage } from "../orm";
import type { RunId } from "../services/executionTreeIds";

export type RunRegistrySqlExecutor = SqlStorage;

/** The full stored run row, exactly as the table holds it. */
export interface RunRegistryRow {
  run_id: string;
  family: string | null;
  job_kind: string | null;
  trigger: string | null;
  created_at: string;
}

/** One alias row: a legacy id mapped to its canonical run. */
export interface RunAliasRow {
  alias: string;
  run_id: string;
  created_at: string;
}

export interface RecordRunInput {
  /** Canonical run id (run:<time>-<counter>). Must parse as a
   *  run id — anything else is rejected, never recorded. */
  runId: RunId;
  /** Family short id (e.g. stockscr), or null when unknown. */
  family?: string | null;
  /** Job kind / spec (e.g. screener), or null when unknown. */
  jobKind?: string | null;
  /** What caused the run (scheduled tick, manual Run now,
   *  Copilot call, goal-leg invocation), or null when unknown. */
  trigger?: string | null;
  /** Legacy ids for this run, adopted as aliases. A canonical id
   *  in this list is never recorded as an alias (see
   *  RunAliasConflict, reason "canonical"). */
  aliases?: string[];
  /** Creation instant (ISO). Defaults to now. */
  nowIso?: string;
}

/** One alias that could not be recorded, with the reason. */
export interface RunAliasConflict {
  alias: string;
  /** The run the alias already maps to — or the alias itself
   *  when the reason is "canonical" (a canonical id resolves
   *  to itself, never through the alias table). */
  existingRunId: string;
  /** "mapped-elsewhere": the alias already maps to a different
   *  run — the first mapping wins, this one is refused.
   *  "canonical": the alias parses as a canonical id, so it can
   *  never be an alias row. */
  reason: "mapped-elsewhere" | "canonical";
}

export interface RecordRunResult {
  runId: string;
  /** True iff this call created the run row. A re-record of an
   *  existing run is a no-op for the run row (first write wins —
   *  family / job_kind / trigger are never overwritten). */
  recorded: boolean;
  /** Aliases this call recorded (in input order). */
  aliasesRecorded: string[];
  /** Aliases this call refused, with the reason each. */
  aliasConflicts: RunAliasConflict[];
}

/** What resolveId found — the registry answers "what is this id"
 *  by checking the registry first (never by parsing alone). */
export type ResolveIdResult =
  | {
      found: true;
      /** The id itself is the canonical run id. */
      kind: "run";
      runId: string;
      row: RunRegistryRow;
    }
  | {
      found: true;
      /** The id is a legacy alias of the run. */
      kind: "alias";
      runId: string;
      alias: string;
      row: RunRegistryRow;
    }
  | {
      found: true;
      /** The id is a canonical non-run id carrying a run body
       *  (stage / step / event / trace / generation / delivery /
       *  job-instance) — it resolves to its run. */
      kind: "derived";
      runId: string;
      row: RunRegistryRow;
    }
  | { found: false; id: string };

/** The record role: ensure + record-once + direct run read. */
export interface RunRegistryRecordPort {
  /** The registry's ONE DDL home: both tables + the alias
   *  reverse-lookup index. Ensure-style additive; idempotent. */
  ensureSchema(): void;
  /** Record a run once (first write wins), adopting its legacy
   *  ids as aliases. Idempotent: re-recording the same run
   *  changes nothing and reports recorded: false. */
  recordRun(input: RecordRunInput): RecordRunResult;
  /** The full row for a canonical run id, or undefined. */
  getRun(runId: string): RunRegistryRow | undefined;
}

/** The resolve role: "what is this id". */
export interface RunRegistryResolvePort {
  /** Registry first: a canonical run id, a legacy alias, or a
   *  canonical derived id carrying a run body. Anything else —
   *  an unrecorded run, an unknown legacy id, a canonical id of
   *  another kind (pay / goal / chain / …) — is honestly
   *  not found, never invented. */
  resolveId(id: string): ResolveIdResult;
}
