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
 * - With confirm: deletes, audits once per funnel
 *   (`maintenance.table.cleared`) — and a gated clear (every table
 *   except mas_async_jobs) writes ONE IAAA chain record BEFORE the
 *   delete (audit-before-write, #6503 step 9): a failed audit
 *   refuses with the coded 503 and deletes nothing.
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
 *   alongside `confirm: true`); the funnel audit row for the clear is
 *   written AFTER the delete, so it survives the clear as the post-wipe
 *   record, and the IAAA chain record lands BEFORE the delete in the
 *   SessionStore DO audit log (not mas_events), so the wipe cannot
 *   erase it. The pre-wipe export lives at GET /api/maintenance/
 *   events-export (own-instance, capped, truncated-flagged).
 */

import type { AgentContext } from "agents";
import { createAsyncJobPorts } from "../../data/createAsyncJobPorts";
import { createEvidenceSatellitePorts } from "../../data/createEvidenceSatellitePorts";
import { createD1UnifiedSchedulePorts } from "../../data/createUnifiedSchedulePorts";
import {
  auditScheduleControlBeforeWrite,
  auditScheduleControlRefusal,
  resolveScheduleControlCaller,
} from "./schedules";
import type { AuditStore } from "../../security/iaaaAudit";
import type { Env } from "../../types";
import type { SqlStorage } from "../../data/repositoryPorts";
import { DO_DML_CATALOGUE } from "../../data/schemaComponent/doDmlCatalogue";
import { executeDoDml } from "../../data/schemaComponent/doDmlExecutor";
import {
  buildCombinedCatalogue,
  executeDoLeg,
  expectedModelForLeg,
  introspectSchema,
  planForLeg,
  resolveRecreatePlan,
  selectSteps,
  UNCREATABLE_LAYERS,
  verifyRecreate,
} from "../../data/schemaComponent/recreateRunner";

export interface MaintenanceRouteContext {
  /** Durable Object agent context (owner: OrchestratorAgent). */
  agentCtx: AgentContext;
  /** Worker environment (owner: OrchestratorAgent — was `this.env`).
   *  Issue #6503 — the maintenance wipe reads the D1 schedule store
   *  through it (AGENT_DB); absent on hosts without a binding. */
  env?: Env;
  /** Audit funnel (owner: OrchestratorAgent.audit). */
  audit(
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ): void;
  /**
   * Issue #6503 step 8b — the step-8 (G1) caller seam's inputs,
   * for the clear-table gate below. All optional: absent, the seam
   * resolves identity from the Worker-established x-user-login
   * header alone and the membership store from the session store,
   * exactly as the schedules routes do. routeRequest passes the
   * execution-context accessor; tests inject the alias KV /
   * membership store stubs. Never a client-supplied tenantId/userId.
   */
  getScreenerExecutionContext?: () => Promise<
    { userLogin: string; environment?: "TEST" | "PROD" } | undefined
  >;
  /** Injectable alias KV for the login→internal-id lookup (tests). */
  flagAliasKv?: import("../../security/kvResilience").KvLike;
  /** Injectable membership store for the platform-admin probe (tests). */
  flagMembershipStore?: import("../../security/authorization").MembershipStore;
  /**
   * Issue #6503 step 9 (G2) — test seam: use this IAAA audit store
   * instead of createWiredAuditStore(env) for the audit-before-write
   * record on gated clears. Absent, the route records through the
   * wired store (the SessionStore DO audit-append).
   */
  auditStore?: AuditStore | null;
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

/**
 * POST /api/maintenance/recreate-schema: the recreate door for this
 * instance's own store (the DO leg). The Data Lifecycle route fans
 * out to it per login; the route never touches an instance's store
 * directly.
 *
 * Body: { codes: string[], preview?: boolean } — codes are the
 * DO-plane step codes the caller wants run. Code-only validation:
 * every code must be a DO-plane code from the plan; an unknown
 * code, a code from another plane, or raw SQL passed as a code is
 * a 400 and nothing runs. The door probes its own store and
 * selects the steps that close a diff, so a re-run is a no-op and
 * a failed run is re-run safely (selection is diff-based).
 *
 * Preview ({ preview: true }): probe + select only, no execution,
 * no audit. Execute: run the selected steps that are also in the
 * requested codes, stop at the first failure with an honest
 * partial report, then re-probe and verify against the DO leg's
 * expected model. Audits once after the attempt
 * (maintenance.schema.recreated), even when it fails.
 *
 * The DO leg claims no atomicity: the aspect's DO backend refuses
 * async work and the executor is async, so a failed run leaves
 * the steps that already ran in place — the report says so.
 */
async function handleRecreateSchema(
  request: Request,
  ctx: MaintenanceRouteContext,
): Promise<Response> {
  const plan = resolveRecreatePlan();
  const legPlan = planForLeg(plan, "do");
  const catalogue = buildCombinedCatalogue();
  const doPlaneCodes = new Set(legPlan.steps.map((s) => s.code));
  try {
    const body = (await request.json().catch(() => ({}))) as any;
    const codes = body.codes;
    if (!Array.isArray(codes)) {
      return Response.json(
        { error: "codes must be an array of DO-plane step codes" },
        { status: 400 },
      );
    }
    // An empty code list is a legitimate no-op execute (the route's
    // fan-out sends the selected codes, and a healthy instance
    // selects none): the door still probes and verifies, and
    // returns an empty report.
    for (const code of codes) {
      if (typeof code !== "string" || !doPlaneCodes.has(code)) {
        return Response.json(
          {
            error: `Unknown or not DO-plane code: ${code}. Only DO-plane step codes from the recreate plan are accepted; raw SQL is never accepted.`,
          },
          { status: 400 },
        );
      }
    }
    const sql = ctx.agentCtx.storage.sql;
    const exec = (sql as { exec: (q: string) => Iterable<unknown> }).exec;
    const probe = {
      query: async (query: string) =>
        Array.from(exec(query)) as Array<Record<string, unknown>>,
    };
    const executor = {
      exec: (statement: string) => {
        exec(statement);
      },
    };
    const actual = await introspectSchema(probe);
    const selected = selectSteps(legPlan, actual, []);
    // Step descriptors (code + params), not bare codes: the generic
    // column-add steps share one code and differ only by params, so
    // a bare code list cannot tell them apart — and the route's
    // preview detail shows each step's code with its params.
    const describe = (s: { code: string; params: Record<string, string> }) => ({
      code: s.code,
      params: s.params,
    });
    const selectedSteps = [...selected.schema, ...selected.seeds].sort(
      (a, b) => a.order - b.order,
    );
    const selectedKeys = new Set(
      selectedSteps.map((s) => `${s.code}|${JSON.stringify(s.params)}`),
    );
    const skippedSteps = legPlan.steps.filter(
      (s) => !selectedKeys.has(`${s.code}|${JSON.stringify(s.params)}`),
    );

    if (body.preview === true) {
      return Response.json({
        preview: true,
        leg: "do",
        selected: selectedSteps.map(describe),
        skipped: skippedSteps.map(describe),
        uncreatableLayers: UNCREATABLE_LAYERS,
      });
    }

    const requested = new Set(codes as string[]);
    const toExecute = selectedSteps.filter((s) => requested.has(s.code));
    const notRequested = selectedSteps.filter(
      (s) => !requested.has(s.code),
    );
    const report = await executeDoLeg(executor, catalogue, toExecute);
    const after = await introspectSchema(probe);
    const verification = verifyRecreate(
      expectedModelForLeg(plan, "do"),
      after,
    );
    ctx.audit("maintenance.schema.recreated", "orchestrator", {
      leg: "do",
      outcome: report.outcome,
      executed: report.executed.length,
      failed: report.failed.map((f) => f.code),
    });
    return Response.json({
      preview: false,
      leg: "do",
      planned: selectedSteps.map(describe),
      notRequested: notRequested.map(describe),
      report,
      verification: {
        ok: verification.ok,
        failures: verification.failures,
        extras: verification.extras,
        knownDifferences: verification.knownDifferences,
      },
    });
  } catch (err: unknown) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to recreate schema" },
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
    path.endsWith("/maintenance/recreate-schema") &&
    request.method === "POST"
  ) {
    return handleRecreateSchema(request, ctx);
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

    // Issue #6503 step 8b (G1) — the clear-table gate, through the
    // step-8 seam (resolveScheduleControlCaller), never a second
    // gate: identity from the verified session only, never a
    // client-supplied tenantId/userId. Every clearable table except
    // mas_async_jobs requires platform-admin (401 no identity, 403
    // otherwise), preview included — a preview count is instance
    // state, and a confirm deletes it. The per-table decision:
    // - unified_schedules: platform-admin only — the wipe deletes
    //   paused records instance-wide, including paused platform
    //   (system) rows; the only client callers are the
    //   platform-admin-gated AdminQueueWipePanel and the likewise
    //   platform-admin-gated SchedulesPanel empty action (#5893).
    // - mas_events: platform-admin only — audit history, destroyed
    //   irreversibly; its only client caller is the selective wipe
    //   in the platform-admin-gated AdminQueueWipePanel (#2489).
    // - mas_job_outcomes, mas_job_outcomes_meta: platform-admin
    //   only — history + prune watermark; their only client caller
    //   is the AdminQueueWipePanel selective wipe.
    // - mas_async_jobs: UNGATED — the WorkflowRunsPanel prune
    //   (?tab=workflow-runs, a general user surface in Chat) clears
    //   it for any signed-in user, and the clear is session-scoped
    //   (the caller's own session rows only; running rows never
    //   deleted), so there is a legitimate non-admin use and no
    //   platform-wide effect to protect.
    // The gate sits after the allowlist + auditConfirm validation
    // (those 400s are public contract, pinned by existing tests)
    // and before any counting or deletion.
    // Issue #6503 step 9 (G2) — the gate's caller, kept for the
    // audit-before-write record and the funnel attribution below;
    // null when the table is ungated (mas_async_jobs, session-scoped
    // prune for any signed-in user — no gate, no chain record).
    let clearCaller: Awaited<ReturnType<typeof resolveScheduleControlCaller>> | null = null;
    if (clearable !== "mas_async_jobs") {
      const caller = await resolveScheduleControlCaller(request, {
        env: ctx.env ?? ({} as Env),
        getScreenerExecutionContext:
          ctx.getScreenerExecutionContext ?? (async () => undefined),
        ...(ctx.flagAliasKv ? { flagAliasKv: ctx.flagAliasKv } : {}),
        ...(ctx.flagMembershipStore
          ? { flagMembershipStore: ctx.flagMembershipStore }
          : {}),
      });
      clearCaller = caller;
      const auditDeps = {
        env: ctx.env ?? ({} as Env),
        auditStore: ctx.auditStore,
        audit: ctx.audit,
      };
      if (caller.kind === "unauthenticated") {
        const reason = "Unauthorized: a signed-in session is required to clear tables.";
        await auditScheduleControlRefusal(auditDeps, "maintenance.table.cleared", clearable, reason, caller, { table: clearable });
        return Response.json({ error: reason }, { status: 401 });
      }
      if (caller.kind !== "platform-admin") {
        const reason = `Forbidden: clearing '${clearable}' requires platform-admin.`;
        await auditScheduleControlRefusal(auditDeps, "maintenance.table.cleared", clearable, reason, caller, { table: clearable });
        return Response.json({ error: reason }, { status: 403 });
      }
    }

    // Each plan reports scope, preview counts, and (on confirm) the delete.
    // Counts are taken before the delete in the same request, so the
    // reported deleted count is exact (single-threaded DO, no interleaving).
    let scope: string;
    let wouldDelete = 0;
    let skippedRunning = 0;
    let breakdown: Record<string, number> | undefined;
    let runDelete: () => void | Promise<void>;

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
          // #4387 (P6d): the watermark clear executes through the
          // DO DML catalogue (dml.do.mas_job_outcomes_meta.clear),
          // AOP-logged with the code — the inline DELETE is gone.
          // The missing-table tolerance below is unchanged: the
          // executor wraps failures as EXECUTION_FAILED with the
          // raw message embedded, so "no such table" still matches.
          executeDoDml(
            DO_DML_CATALOGUE,
            sql as SqlStorage,
            "dml.do.mas_job_outcomes_meta.clear",
            {},
          );
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
          // #4387 (P6d): the audit-history clear executes through
          // the DO DML catalogue (dml.do.mas_events.clear),
          // AOP-logged with the code — the inline DELETE is gone.
          executeDoDml(
            DO_DML_CATALOGUE,
            sql as SqlStorage,
            "dml.do.mas_events.clear",
            {},
          );
        } catch (err) {
          if (!isMissingTable(err)) throw err;
        }
      };
    } else {
      scope = "instance";
      const store = createD1UnifiedSchedulePorts({ d1: ctx.env?.AGENT_DB }).unifiedSchedules;
      wouldDelete = (await store.listByState("paused")).length;
      runDelete = async () => {
        // #3123: the wipe clears paused records only — the unified
        // store's clearPaused() deletes state='paused' rows and
        // never touches active records.
        await store.clearPaused();
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

    // Issue #6503 step 9 (G2) — audit-before-write for gated
    // clears: ONE chain record before the delete runs; a failed
    // audit refuses with the coded 503 and deletes nothing. The
    // record lands in the SessionStore DO audit log (not
    // mas_events), so it survives even a mas_events wipe. The
    // ungated mas_async_jobs prune (no gate, no resolved caller)
    // keeps its after-write funnel annotation only.
    if (clearCaller) {
      const clearAuditRefusal = await auditScheduleControlBeforeWrite(
        { env: ctx.env ?? ({} as Env), auditStore: ctx.auditStore },
        clearCaller,
        "maintenance.table.cleared",
        clearable,
      );
      if (clearAuditRefusal) return clearAuditRefusal;
    }

    await runDelete();
    ctx.audit("maintenance.table.cleared", "orchestrator", {
      table: clearable,
      scope,
      deletedCount: wouldDelete,
      ...(clearable === "mas_async_jobs" ? { skippedRunning } : {}),
      // Issue #6503 step 9 (G2) — caller attribution on every event.
      ...(clearCaller
        ? {
            changedBy: clearCaller.kind === "unauthenticated" ? "anonymous" : clearCaller.login,
            callerLevel: clearCaller.kind,
          }
        : {}),
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
