/**
 * Shared test-only ledger stub: an ORCHESTRATOR_AGENT namespace
 * whose fetch answers the ScheduledAgent ledger channel.
 *
 * Issue #6101 (step 9, Q6) — the KV `"jobRunRecords"` key is
 * retired, so tests that fire goals through ScheduledAgent can no
 * longer read runs back from ctx.storage. The ledger post/read
 * channel (`POST /schedules/runs/record`, `GET /schedules/runs`)
 * is the only home now; this stub is its in-memory stand-in:
 * posted rows land in `runs` (newest first) and the read route
 * serves them back, filtered by `jobId` and capped by `limit`,
 * the way `fetchLedgerRuns` asks. Non-ledger requests fall
 * through to `fallback` (e.g. an audit capture) or answer 200.
 *
 * Test helper only — never imported by src/.
 */
import { LEDGER_READ_ROUTE, LEDGER_RECORD_ROUTE } from "../src/services/unifiedLedger";
import type { JobRunRecord } from "../src/services/jobRunRecords";

export interface LedgerStub {
  /** The ORCHESTRATOR_AGENT namespace value to bind as env. */
  namespace: unknown;
  /** Posted rows, newest first — seed or inspect directly. */
  runs: JobRunRecord[];
}

export function makeLedgerStub(
  opts: {
    fallback?: (req: Request) => Promise<Response> | Response;
  } = {},
): LedgerStub {
  const runs: JobRunRecord[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (_id: unknown) => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === LEDGER_RECORD_ROUTE) {
          const row = (await req.json().catch(() => null)) as JobRunRecord | null;
          if (row) runs.unshift(row);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (req.method === "GET" && url.pathname === LEDGER_READ_ROUTE) {
          const jobId = url.searchParams.get("jobId");
          const limit = Number(url.searchParams.get("limit") ?? "50");
          const filtered = (jobId ? runs.filter((r) => r.jobId === jobId) : runs).slice(
            0,
            Number.isFinite(limit) ? limit : 50,
          );
          return new Response(JSON.stringify({ ok: true, runs: filtered }), {
            status: 200,
          });
        }
        if (opts.fallback) return opts.fallback(req);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }),
  };
  return { namespace, runs };
}
