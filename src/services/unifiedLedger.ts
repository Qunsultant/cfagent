/**
 * Issue #3121 Phase 2 (#3123, reuse) — the ONE run-ledger write
 * entry and the ONE merged-read merge, plus the stub transport the
 * ScheduledAgent uses to reach the one physical ledger store.
 *
 * Before #3123, `job_run_records` was written through two stores:
 * OrchestratorAgent DO SQLite (P-A: the callback recorder, the
 * cron-dispatch recorder, the orchestrator watchdog, the pipeline
 * recorder seam) and ScheduledAgent DO key-value under the
 * `"jobRunRecords"` key (P-B: goal runs + the goals watchdog).
 * The two halves were only merged client-side. This module is the
 * single write entry every DO-SQLite writer routes through
 * (`recordLedgerRun`), and the single merge every read routes
 * through (`mergeLedgerRuns`).
 *
 * The one physical store is the OrchestratorAgent DO SQLite
 * `job_run_records` table (P-A). The ScheduledAgent reaches it
 * through the existing ScheduledAgent → OrchestratorAgent stub
 * channel (the same channel as the goal-lifecycle audit sink) via
 * `postLedgerRun` / `fetchLedgerRuns` below, posting to the shared
 * orchestrator instance's `POST /schedules/runs/record` route
 * (background-attribution gate, copied from the S5 cron-dispatch
 * record route). The transport never throws and never breaks a
 * tick: a failed post falls back to the legacy KV key, and a
 * failed fetch reads KV only — existing KV rows keep reading
 * through the merged read, so history is never dropped silently.
 * Until the service user is configured, the record route answers
 * 401 (nothing is background without one) and goal rows keep
 * landing in KV; they land in SQLite once it is configured, and
 * the merged read covers both homes either way.
 *
 * Scoping (recorded, #3123): `mas_async_jobs` stays the async-job
 * execution record (its rows ARE the chain steps' run records by
 * S4 design) and `mas_job_outcomes` stays the outcome sink — this
 * module never writes either. The D1 pipeline residency
 * (`D1JobRunRecordStore`, workflow residency has no DO sql handle)
 * stays in D1: filed as #4124, a sub-issue of #3123.
 */
import { backgroundDispatchHeaders } from "../security/backgroundAttribution";
import type { JobRunRecordStore } from "../data/jobRunRecordPorts";
import {
  buildJobRunRecord,
  normalizeJobRunRecord,
  type JobRunRecord,
  type JobRunRecordInput,
} from "./jobRunRecords";

/** POST path for a ledger row on the shared orchestrator instance. */
export const LEDGER_RECORD_ROUTE = "/schedules/runs/record";

/** GET path for ledger rows on an orchestrator instance. */
export const LEDGER_READ_ROUTE = "/schedules/runs";

/**
 * THE single job_run_records write entry for DO-SQLite writers.
 * Builds (validates) via buildJobRunRecord, then stores. Every
 * writer that used to call `store.record(buildJobRunRecord(...))`
 * calls this instead — one entry, one validation, one insert.
 */
export function recordLedgerRun(
  store: JobRunRecordStore,
  input: JobRunRecordInput,
): JobRunRecord {
  const built = buildJobRunRecord(input);
  store.record(built);
  return built;
}

/** Dedup key: one run is one (job, start, operation). */
function ledgerRunKey(record: JobRunRecord): string {
  return `${record.jobId}|${record.started}|${record.operation}`;
}

/**
 * THE single merged read: newest-first (started desc, first-seen
 * wins ties), deduplicated across homes. The first list wins a
 * duplicate — callers pass the authoritative home first.
 */
export function mergeLedgerRuns(...lists: JobRunRecord[][]): JobRunRecord[] {
  const seen = new Set<string>();
  const merged: JobRunRecord[] = [];
  for (const list of lists) {
    for (const record of list) {
      const key = ledgerRunKey(record);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(record);
    }
  }
  merged.sort((a, b) => (b.started < a.started ? -1 : b.started > a.started ? 1 : 0));
  return merged;
}

/** A stub-fetch function: the DO-side `(req) => stub.fetch(req)` shape. */
export type LedgerPost = (req: Request) => Promise<Response>;

/**
 * Post one ledger row to the shared orchestrator instance. Never
 * throws: false means "not stored — fall back" (401 with no service
 * user configured, a failed fetch, a non-2xx answer).
 */
export async function postLedgerRun(
  post: LedgerPost,
  record: JobRunRecord,
  serviceLogin: string | null,
): Promise<boolean> {
  try {
    const res = await post(
      new Request(`https://agent.internal${LEDGER_RECORD_ROUTE}`, {
        method: "POST",
        headers: {
          ...backgroundDispatchHeaders(serviceLogin ?? ""),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(record),
      }),
    );
    return typeof res?.status === "number" && res.status < 400;
  } catch {
    return false;
  }
}

/**
 * Fetch ledger rows from an orchestrator instance's read route.
 * Returns null on any transport or shape failure — the caller
 * reads its fallback home instead. Never throws.
 */
export async function fetchLedgerRuns(
  post: LedgerPost,
  opts?: { jobId?: string; limit?: number },
): Promise<JobRunRecord[] | null> {
  try {
    const params = new URLSearchParams({ limit: String(opts?.limit ?? 50) });
    if (opts?.jobId) params.set("jobId", opts.jobId);
    const res = await post(
      new Request(`https://agent.internal${LEDGER_READ_ROUTE}?${params}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      }),
    );
    if (!res || typeof res.status !== "number" || res.status >= 400) return null;
    const data = (await res.json().catch(() => null)) as { runs?: unknown } | null;
    if (!data || !Array.isArray(data.runs)) return null;
    return (data.runs as JobRunRecord[]).map((row) => normalizeJobRunRecord(row));
  } catch {
    return null;
  }
}
