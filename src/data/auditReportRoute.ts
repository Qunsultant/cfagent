/**
 * Issue #1688 ([AGENTIC] Slice 3) — pure, testable handlers
 * for the audit-history, reports-list, and reports-seed
 * routes. The Worker route in src/server.ts only wires real
 * dependencies into these functions; every decision below is
 * covered by tests/data_foundation_slice3.test.ts.
 *
 * The read routes answer from the PROJECTION ONLY, never
 * the durable object, and return only projection fields
 * (report bodies stay out of the list shape — the durable
 * object holds the full copy). An unbound store is answered
 * 503 by the server wiring, not here.
 *
 * Decision order for the read routes: unauthenticated →
 * 401; wrong method → 405; missing chain id (audit route
 * only) → 400; otherwise the tenant-scoped read.
 *
 * Decision order for the seed route (same shape as the
 * slice-0 halt seed route): unauthenticated → 401;
 * non-POST → 405; unwired session (no internalUserId) →
 * 403; wired non-admin → 403 with NO data; platform-admin
 * → 410 Gone. Issue #6101 (step 8) RETIRED the seed: it
 * copied the instance's DO mas_reports rows into D1
 * agent_reports, which the replacement ruling forbids
 * (existing DO data is never copied to D1; new writes go
 * to D1, old DO rows stay as history drained by retention).
 * The route stays as a named tombstone so an operator who
 * still calls it learns why, instead of a 404. The seed
 * never auto-ran: no boot, deploy, or tick path called it.
 */
import type {
  AuditEventRow,
  CanonicalReportRow,
} from "./auditReportPorts";
import type { ReconcileUsageEventsResult } from "../agents/orchestrator/usageEventsReconcile";

export interface AuditHistoryRouteSession {
  internalUserId?: string;
}

export interface AuditHistoryRouteDeps {
  session: AuditHistoryRouteSession | null;
  method: string;
  tenantId: string;
  chainId: string;
  readHistory: () => Promise<AuditEventRow[]>;
}

export async function handleAuditHistoryRoute(
  deps: AuditHistoryRouteDeps,
): Promise<Response> {
  if (!deps.session) {
    return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
  }
  if (deps.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!deps.chainId) {
    return Response.json({ error: "chainId is required." }, { status: 400 });
  }
  try {
    const events = await deps.readHistory();
    return Response.json({
      chainId: deps.chainId,
      events: events.map((event) => ({
        eventKind: event.eventKind,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        actor: event.actor,
        detailJson: event.detailJson,
        occurredAtMs: event.occurredAtMs,
      })),
    });
  } catch {
    return Response.json(
      { error: "Audit history unavailable." },
      { status: 500 },
    );
  }
}

export interface ReportsRouteDeps {
  session: AuditHistoryRouteSession | null;
  method: string;
  tenantId: string;
  reportId: string | null;
  readReports: () => Promise<CanonicalReportRow[]>;
}

export async function handleReportsRoute(
  deps: ReportsRouteDeps,
): Promise<Response> {
  if (!deps.session) {
    return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
  }
  if (deps.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const reports = await deps.readReports();
    return Response.json({
      reports: reports.map((report) => ({
        reportId: report.reportId,
        runId: report.runId,
        generationId: report.generationId,
        title: report.title,
        source: report.source,
        summary: report.summary,
        version: report.version,
        updatedAtMs: report.updatedAtMs,
      })),
    });
  } catch {
    return Response.json(
      { error: "Reports unavailable." },
      { status: 500 },
    );
  }
}

export interface SeedReportsRouteSession {
  githubLogin?: string;
  internalUserId?: string;
}

export interface SeedReportsRouteDeps {
  session: SeedReportsRouteSession | null;
  method: string;
  isPlatformAdmin: boolean;
  tenantId: string;
}

export interface ReconcileUsageEventsRouteDeps {
  session: SeedReportsRouteSession | null;
  method: string;
  isPlatformAdmin: boolean;
  tenantId: string;
  runReconcile: (input: {
    tenantId: string;
    setBy: string;
    limit?: number;
  }) => Promise<ReconcileUsageEventsResult>;
}

/**
 * Issue #3185 (bridge slice) — POST /api/ops/usage-events-reconcile:
 * the deliberate operator invocation point for the one-off
 * usage-events backfill (the same gating shape the deleted run-ledger reconcile route used).
 * Gating mirrors the seed route exactly (requireAuth → wired
 * session → live platform-admin membership, fail-closed, no data
 * on 403). Never auto-run: no boot, deploy, or tick path calls
 * it. A refused sweep (AGENT_DB unbound) returns 200 with the
 * refusal named in the result — the operator sees why nothing
 * was reconciled instead of a silent zero-row pass.
 */
export async function handleReconcileUsageEventsRoute(
  deps: ReconcileUsageEventsRouteDeps,
): Promise<Response> {
  if (!deps.session) {
    return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
  }
  if (deps.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!deps.session.internalUserId) {
    return Response.json(
      { error: "Forbidden: usage-events reconcile requires a wired session." },
      { status: 403 },
    );
  }
  if (!deps.isPlatformAdmin) {
    return Response.json(
      { error: "Forbidden: usage-events reconcile requires platform-admin membership." },
      { status: 403 },
    );
  }
  try {
    const result = await deps.runReconcile({
      tenantId: deps.tenantId,
      setBy: deps.session.githubLogin ?? deps.session.internalUserId,
    });
    return Response.json(result);
  } catch {
    // Generic error only: a failed invoke does not prove
    // nothing happened, so the operator diagnoses projection
    // state before retrying (the second invoke reports zero
    // new rows when all rows are already current).
    return Response.json(
      { error: "Usage-events reconcile unavailable." },
      { status: 500 },
    );
  }
}

export async function handleSeedReportsRoute(
  deps: SeedReportsRouteDeps,
): Promise<Response> {
  if (!deps.session) {
    return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
  }
  if (deps.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!deps.session.internalUserId) {
    return Response.json(
      { error: "Forbidden: reports seed requires a wired session." },
      { status: 403 },
    );
  }
  if (!deps.isPlatformAdmin) {
    return Response.json(
      { error: "Forbidden: reports seed requires platform-admin membership." },
      { status: 403 },
    );
  }
  // #6101 step 8 — RETIRED. The seed copied the instance's DO
  // mas_reports rows into D1 agent_reports; the replacement
  // ruling forbids copying existing DO data to D1. Reports
  // written after the cutover already live in D1; pre-cutover
  // rows stay in the frozen DO table as history. 410 (not 404)
  // so the retirement is named, not silent.
  return Response.json(
    {
      error:
        "Gone: the canonical reports seed was retired by #6101 — it copied existing DO mas_reports rows into D1, which the replacement ruling forbids. Post-cutover reports already live in D1 agent_reports; pre-cutover rows stay in the frozen DO table as history.",
      reason: "reports-seed-retired-6101",
    },
    { status: 410 },
  );
}
