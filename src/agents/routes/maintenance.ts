/**
 * Maintenance routes: bulk clears for caller-owned tables and queues.
 *
 * Issue #2280 follow-up to POST /api/schedules/cancel-all (PR #2320):
 * cancel-all empties the framework queue (`cf_agents_jobs` — schedules
 * ARE the queue rows), but it deliberately touches nothing else. This
 * endpoint covers the remaining clearable state: the app async-job queue
 * (`mas_async_jobs`), the job-outcome history (`mas_job_outcomes`), the
 * outcome prune watermark (`mas_job_outcomes_meta`), the audit history
 * (`mas_events`, gated — see below), and the paused schedule records
 * in the unified store (`unified_schedules` — paused rows only; an
 * active record is never wiped here, issue #3121 Phase 2 #3123).
 *
 * Every clear follows the same contract as cancel-all:
 * - Preview without `{ confirm: true }`: counts what WOULD be deleted,
 *   deletes nothing, writes no audit event.
 * - With confirm: deletes, audits once (`maintenance.table.cleared`).
 * - Scope is always the caller's own state: `mas_async_jobs` is filtered
 *   to the caller's session; the other tables live in the caller's
 *   own per-user agent instance, so instance-wide IS caller-owned.
 * - Fail-closed allowlist: any other table name is rejected. In
 *   particular `mas_messages` is cleared per session via POST /clear
 *   (purge), and the framework queue goes through
 *   POST /api/schedules/cancel-all — each rejection names the right
 *   route instead of silently refusing.
 * - `mas_async_jobs` rows with status 'running' are NEVER deleted
 *   (deleting them would orphan in-flight executions); they are counted
 *   as skippedRunning and reported, even if explicitly requested.
 * - `mas_job_outcomes_meta` (the `pruned_at` watermark) is preserved
 *   when outcomes are cleared; it is its own clearable row, and
 *   clearing it resets the pruning cursor.
 * - Issue #2489 SUPERSESSION: `mas_events` (audit history) was NEVER
 *   bulk-clearable here; owner direction 2026-10-30 (selective wipe,
 *   all selected by default) supersedes that rule FOR THIS SURFACE.
 *   The clear is gated by a second confirmation (`auditConfirm: true`
 *   alongside `confirm: true`); the audit row for the clear is written
 *   AFTER the delete, so it survives the clear as the post-wipe
 *   record. The pre-wipe export lives at GET /api/maintenance/
 *   events-export (own-instance, capped, truncated-flagged).
 */

import type { AgentContext } from "agents";
import { createAsyncJobPorts } from "../../data/createAsyncJobPorts";
import { createEvidenceSatellitePorts } from "../../data/createEvidenceSatellitePorts";
import { createUnifiedSchedulePorts } from "../../data/createUnifiedSchedulePorts";

export interface MaintenanceRouteContext {
  /** Durable Object agent context (owner: OrchestratorAgent). */
  agentCtx: AgentContext;
  /** Audit funnel (owner: OrchestratorAgent.audit). */
  audit(
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ): void;
}

const CLEARABLE_TABLES = [
  "mas_async_jobs",
  "mas_job_outcomes",
  "mas_job_outcomes_meta",
  "mas_events",
  "unified_schedules",
] as const;

type ClearableTable = (typeof CLEARABLE_TABLES)[number];

/** Pre-wipe audit export cap: rows above this are reported truncated. */
const EVENTS_EXPORT_LIMIT = 5000;

function isMissingTable(err: unknown): boolean {
  return (
    err instanceof Error && /no such table/i.test(err.message)
  );
}

function countRows(sql: unknown, query: string): number {
  const exec = (sql as { exec: (q: string) => Iterable<unknown> }).exec;
  const rows = Array.from(exec(query)) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

function deleteRows(sql: unknown, query: string): void {
  const exec = (sql as { exec: (q: string) => Iterable<unknown> }).exec;
  exec(query);
}

/**
 * GET /api/maintenance/events-export: own-instance audit history as a
 * downloadable JSON bundle, offered before a mas_events clear (#2489).
 * Same own-instance scope as clear-table (the instance is per-login,
 * so instance-wide here is still the caller's own data). Capped at
 * EVENTS_EXPORT_LIMIT rows with a truncated flag — never silently
 * partial.
 */
function handleEventsExport(
  ctx: MaintenanceRouteContext,
): Response {
  const sql = ctx.agentCtx.storage.sql;
  try {
    const rows = Array.from(
      (sql as { exec: (q: string) => Iterable<unknown> }).exec(
        "SELECT id, session_id, type, agent, payload, created_at FROM mas_events ORDER BY created_at ASC LIMIT 5001",
      ),
    ) as Array<Record<string, unknown>>;
    const truncated = rows.length > EVENTS_EXPORT_LIMIT;
    return Response.json({
      count: truncated ? EVENTS_EXPORT_LIMIT : rows.length,
      truncated,
      events: truncated ? rows.slice(0, EVENTS_EXPORT_LIMIT) : rows,
    });
  } catch (err: unknown) {
    if (isMissingTable(err)) {
      return Response.json({ count: 0, truncated: false, events: [] });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to export audit events" },
      { status: 500 },
    );
  }
}

export async function handleMaintenanceRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: MaintenanceRouteContext,
): Promise<Response | null> {
  if (path.endsWith("/maintenance/events-export") && request.method === "GET") {
    return handleEventsExport(ctx);
  }
  if (
    !path.endsWith("/maintenance/clear-table") ||
    request.method !== "POST"
  ) {
    return null;
  }
  try {
    const body = (await request.json().catch(() => ({}))) as any;
    const table = body.table as string;

    if (table === "mas_messages") {
      return Response.json(
        { error: "mas_messages is cleared per session via POST /clear (purge), not here" },
        { status: 400 },
      );
    }
    if (table === "cf_agents_jobs") {
      return Response.json(
        { error: "the framework queue is cleared via POST /api/schedules/cancel-all, not here" },
        { status: 400 },
      );
    }
    if (!(CLEARABLE_TABLES as readonly string[]).includes(table)) {
      return Response.json(
        {
          error: `Unknown or not clearable table: ${table}. Clearable: ${CLEARABLE_TABLES.join(", ")}`,
        },
        { status: 400 },
      );
    }

    const sql = ctx.agentCtx.storage.sql;
    const confirm = body.confirm === true;
    const clearable = table as ClearableTable;

    // Issue #2489: mas_events needs a SECOND confirmation beyond the
    // aggregate confirm. The server enforces it, so a raw call cannot
    // skip the extra step the UI presents. Preview (no confirm) is
    // unaffected — counting destroys nothing.
    if (clearable === "mas_events" && confirm && body.auditConfirm !== true) {
      return Response.json(
        { error: "mas_events requires a second confirmation (auditConfirm: true); audit history is destroyed irreversibly" },
        { status: 400 },
      );
    }

    // Each plan reports scope, preview counts, and (on confirm) the delete.
    // Counts are taken before the delete in the same request, so the
    // reported deleted count is exact (single-threaded DO, no interleaving).
    let scope: string;
    let wouldDelete = 0;
    let skippedRunning = 0;
    let breakdown: Record<string, number> | undefined;
    let runDelete: () => void;

    if (clearable === "mas_async_jobs") {
      scope = "session";
      // #2358 (#1976 step 4a): preview + delete serve through the
      // async-job Maintenance port (src/data/asyncJobPorts.ts).
      // The running-row protection and the missing-table tolerance
      // stay here, exactly as before.
      const maintenance = createAsyncJobPorts(sql as never).maintenance;
      const requested: string[] | undefined = Array.isArray(body.statuses)
        ? body.statuses.filter((s: unknown) => typeof s === "string")
        : undefined;
      let rows: Array<{ status: string; n: number }> = [];
      try {
        rows = maintenance.countByStatus(sessionId);
      } catch (err) {
        if (!isMissingTable(err)) throw err;
      }
      breakdown = {};
      for (const row of rows) {
        breakdown[row.status] = row.n;
        if (row.status === "running") {
          skippedRunning = row.n;
        } else if (!requested || requested.includes(row.status)) {
          wouldDelete += row.n;
        }
      }
      const statuses = requested
        ? requested.filter((s) => s !== "running")
        : undefined;
      runDelete = () => {
        try {
          if (statuses && statuses.length > 0) {
            maintenance.deleteByStatuses(sessionId, statuses);
          } else if (!statuses) {
            maintenance.deleteAllNonRunning(sessionId);
          }
          // Requested statuses all running (or empty): nothing to delete.
        } catch (err) {
          // Fresh instance with no table yet: preview already counted zero.
          if (!isMissingTable(err)) throw err;
        }
      };
    } else if (clearable === "mas_job_outcomes") {
      scope = "instance";
      // #2358: the clear serves through the 4c job-outcome port's
      // maintenance surface (countRows / clearRows). clearRows
      // deletes only mas_job_outcomes rows — the meta prune
      // watermark is preserved, as documented in the header; the
      // watermark is its own clearable row below (#2489).
      const outcomes = createEvidenceSatellitePorts(sql as never).jobOutcomes;
      try {
        wouldDelete = outcomes.countRows();
      } catch (err) {
        if (!isMissingTable(err)) throw err;
      }
      runDelete = () => {
        try {
          outcomes.clearRows();
        } catch (err) {
          if (!isMissingTable(err)) throw err;
        }
      };
    } else if (clearable === "mas_job_outcomes_meta") {
      scope = "instance";
      // Issue #2489: the prune watermark as its own row. Clearing it
      // resets the pruning cursor; the next prune recomputes it.
      // (Clearing outcomes alone still preserves it — see above.)
      try {
        wouldDelete = countRows(sql, "SELECT COUNT(*) AS n FROM mas_job_outcomes_meta");
      } catch (err) {
        if (!isMissingTable(err)) throw err;
      }
      runDelete = () => {
        try {
          deleteRows(sql, "DELETE FROM mas_job_outcomes_meta");
        } catch (err) {
          if (!isMissingTable(err)) throw err;
        }
      };
    } else if (clearable === "mas_events") {
      scope = "instance";
      // Issue #2489: audit history, gated by auditConfirm at confirm
      // time (above). The audit below is written AFTER the delete,
      // so the maintenance.table.cleared row for mas_events survives
      // the clear as the post-wipe record, by construction.
      try {
        wouldDelete = countRows(sql, "SELECT COUNT(*) AS n FROM mas_events");
      } catch (err) {
        if (!isMissingTable(err)) throw err;
      }
      runDelete = () => {
        try {
          deleteRows(sql, "DELETE FROM mas_events");
        } catch (err) {
          if (!isMissingTable(err)) throw err;
        }
      };
    } else {
      scope = "instance";
      const store = createUnifiedSchedulePorts({ sql: sql as never }).unifiedSchedulesSync;
      wouldDelete = store.listByState("paused").length;
      runDelete = () => {
        // #3123: the wipe clears paused records only — the unified
        // store's clearPaused() deletes state='paused' rows and
        // never touches active records.
        store.clearPaused();
      };
    }

    if (!confirm) {
      return Response.json({
        table: clearable,
        scope,
        confirmed: false,
        confirmRequired: true,
        wouldDelete,
        ...(breakdown ? { breakdown } : {}),
        ...(clearable === "mas_async_jobs" ? { skippedRunning } : {}),
      });
    }

    runDelete();
    ctx.audit("maintenance.table.cleared", "orchestrator", {
      table: clearable,
      scope,
      deletedCount: wouldDelete,
      ...(clearable === "mas_async_jobs" ? { skippedRunning } : {}),
      // Issue #2457: cross-tenant delegation annotation only. These
      // headers are set solely by the admin tenant-queue route when
      // it fans out to this instance; they never change scope or
      // authorization here — the instance itself is the scope.
      ...(request.headers.get("x-admin-actor")
        ? { adminActor: request.headers.get("x-admin-actor") }
        : {}),
      ...(request.headers.get("x-admin-tenant")
        ? { adminTenant: request.headers.get("x-admin-tenant") }
        : {}),
    });
    return Response.json({
      table: clearable,
      scope,
      confirmed: true,
      deleted: wouldDelete,
      ...(clearable === "mas_async_jobs" ? { skippedRunning } : {}),
    });
  } catch (err: any) {
    return Response.json(
      { error: err.message || "Failed to clear table" },
      { status: 500 },
    );
  }
}
