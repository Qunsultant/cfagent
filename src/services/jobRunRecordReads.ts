/**
 * Issue #3946 (Option B — two ledgers, surfaces merge): the read seam
 * for the engine's D1 job run records (src/data/d1JobRunRecordAdapter,
 * migration 0047). The engine writes its run records to D1 in both
 * residencies; the screener keeps its DO ledgers. The three named read
 * surfaces (Workflow Runs, /api/runs, /api/runs/details) merge the two
 * ledgers through this seam — the D1 rows are never re-homed into DO,
 * and the DO rows are never projected into D1 here (that is #4116).
 *
 * Identity: the D1 port exposes no row id, so a record's identity is
 * derived from (jobId, started, finished) — the same job cannot
 * start+finish twice in the same millisecond under the engine's
 * sequential per-job execution, so the derived id is stable and
 * unique per run. Both surfaces share this one function, so a D1 row
 * is the same row everywhere it appears.
 *
 * Failure is named, never silent: an unbound AGENT_DB throws a named
 * error so each route names the unreadable ledger in storeErrors and
 * the other ledgers still render.
 */
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
} from "../data/d1JobRunRecordAdapter";
import type { JobRunRecord } from "./jobRunRecords";

/** The stable derived identity of a D1 job run record. */
export function d1JobRunRecordId(record: JobRunRecord): string {
  return `d1:${record.jobId}:${record.started}:${record.finished}`;
}

const D1_UNBOUND_MESSAGE =
  "AGENT_DB is not bound: the engine's D1 job run records are unreadable in this deployment";

/**
 * List the engine's D1 job run records, newest-first. Throws a named
 * error when AGENT_DB is unbound — callers name it, never swallow it.
 */
export async function listD1JobRunRecords(
  env: unknown,
  limit: number,
): Promise<JobRunRecord[]> {
  const d1 = (env as { AGENT_DB?: unknown } | null | undefined)?.AGENT_DB;
  if (!d1) throw new Error(D1_UNBOUND_MESSAGE);
  const db = createD1JobRunRecordDb(d1 as D1Database);
  await ensureJobRunRecordsSchema(db);
  return new D1JobRunRecordStore(db).listRecent(limit);
}
