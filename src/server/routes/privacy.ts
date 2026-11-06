/**
 * Privacy & compliance branches for the Worker entry (src/server.ts).
 *
 * Slice 4 of Qunsultant/cfagent#2902 — moves only. Each handler below is a
 * verbatim block moved out of handleFetch, in its original position in the
 * dispatch chain; it returns null when no branch matches so handleFetch
 * falls through to the next delegation exactly as the inline chain did.
 * Branch lines keep their original indentation on purpose: re-indenting
 * would shift lines inside template literals and change response bytes.
 *
 * Handler signatures take the handleFetch locals the branches used
 * (request, env, url, path); shared auth comes from ../auth.
 */

import type { Env } from "../../types";
import { clearSessionCookie } from "../../session";
import { sessionStore, wiredMembershipStore } from "../../security/session";
import { requiresStepUpForAction } from "../../security/iaaaGates";
import { handlePrivacyErasureRoute, handlePrivacyExportRoute, handlePrivacyPreferencesRoute, handlePrivacyStatusRoute } from "../../privacy/privacyRoutes";
import { buildExportPayload, type ErasureLeg, type PrivacyPreferences } from "../../privacy/privacyDsar";
import { isWiringEnabled } from "../../security/providers";
import { requireAuth } from "../auth";
import { SHARED_ORCHESTRATOR_INSTANCE } from "../../security/serviceIdentity";
import { createWiredAuditStore } from "../../security/iaaaAuditStore";
import { buildAdminOverview } from "../../security/iaaaAdminOverview";
import { recordAuditEvent } from "../../security/iaaaAudit";
import { handleChainStatusRoute, handleReconcileChainsRoute } from "../../data/chainStatusRoute";
import { readChainStatus } from "../../data/createChainSchedulePorts";
import type { ReconcileReport } from "../../data/chainScheduleProjection";
import { handleJobHistoryRoute, handleReconcileJobsRoute } from "../../data/shardJobRoute";
import { createTraceReader, handleMeshTraceRoute } from "../../data/meshTraceRoute";
import { createShardJobAdapter, readJobHistory } from "../../data/createShardJobPorts";
import { handleMeshRegistryRoute } from "../../agents/meshRegistryRoute";
import { handleProductCatalogRoute } from "../../agents/productCatalogRoute";
import { createPriceCatalogueAdapter } from "../../data/createPriceCataloguePorts";
import { handleRetentionPurgeRoute } from "../../data/retentionRoute";
import { buildPurgeAuditEventInput } from "../../data/retention1766";
import { actorGateway } from "../../services/cloudflareActorGateway";
import { createRetentionPurgeStore, runRetentionPurgeForTenant } from "../../data/createRetentionPorts";
import type { ReconcileShardJobsReport } from "../../data/shardJobProjection";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { handleAuditHistoryRoute, handleReportsRoute, handleSeedReportsRoute } from "../../data/auditReportRoute";
import { createAuditReportAdapter, readAuditHistory, readReports } from "../../data/createAuditReportPorts";
import type { SeedCanonicalReportsResult } from "../../data/auditReportProjection";

/**
 * Slice 4 of Qunsultant/cfagent#2902 (Privacy & compliance) — moves only.
 * The privacy family of handleFetch, verbatim and in original order:
 * /api/privacy/status, /api/privacy/preferences, /api/privacy/export,
 * /api/privacy/erasure (one combined block, sub-branches by path).
 * Returns null when no branch matches, so handleFetch falls through to the
 * next delegation exactly as the inline chain did.
 */
export async function handlePrivacyRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
    // Issue #1765 (parent #1717, F-41 / PRV-001–PRV-004): privacy
    // routes — status (ADMT notice + GPC), preferences (ADMT
    // opt-out), export, erasure cascade. Session-gated: the
    // handlers 401/403, and every route serves ONLY the
    // caller's own subject (derived from the session's
    // internalUserId, never from request input).
    // Production wiring, stated honestly: preferences live in
    // the SessionStore under privacy:prefs:<subject>; the
    // erasure session leg deletes that record and the
    // response clears the caller's session cookie. The
    // Orchestrator/Research/Screener DO legs and Vectorize
    // are registered as DEFERRED — no per-subject delete RPC
    // exists on those stores on current main (verified by
    // grep: zero deleteUser/erase/purgeUser hits in
    // src/agents), so the cascade reports them instead of
    // claiming erasure it cannot perform. Adding one
    // eraseSubjectData callable per DO is the named
    // follow-up; until then the erasure report's
    // complete=false is the honest production answer.
    // Export coverage is likewise per-source: mas_messages /
    // research_runs / screener_runs rows live in DO SQLite
    // with no per-subject server read path, so they are
    // listed as not_wired, never implied included.
    if (
      path === "/api/privacy/status" ||
      path === "/api/privacy/preferences" ||
      path === "/api/privacy/export" ||
      path === "/api/privacy/erasure"
    ) {
      const session = await requireAuth(request, env).catch(() => null);
      const subject = typeof session?.internalUserId === "string" ? session.internalUserId : "";
      const kv = sessionStore(env);
      const prefsKey = `privacy:prefs:${subject}`;
      const loadPrefs = async (): Promise<PrivacyPreferences> => {
        const raw = subject ? await kv.get(prefsKey).catch(() => null) : null;
        if (!raw) return { saleSharingOptOut: false, admtOptOut: false };
        try {
          const parsed = JSON.parse(raw) as Partial<PrivacyPreferences>;
          return {
            saleSharingOptOut: parsed.saleSharingOptOut === true,
            admtOptOut: parsed.admtOptOut === true,
          };
        } catch {
          return { saleSharingOptOut: false, admtOptOut: false };
        }
      };
      const savePrefs = async (prefs: PrivacyPreferences): Promise<void> => {
        await kv.put(prefsKey, JSON.stringify(prefs));
      };
      const secGpcHeader = request.headers.get("Sec-GPC");
      if (path === "/api/privacy/status") {
        return handlePrivacyStatusRoute({
          session,
          method: request.method,
          secGpcHeader,
          preferences: await loadPrefs(),
        });
      }
      if (path === "/api/privacy/preferences") {
        let body: unknown = null;
        if (request.method === "POST") {
          try {
            body = await request.json();
          } catch {
            body = null;
          }
        }
        return handlePrivacyPreferencesRoute({
          session,
          method: request.method,
          subject,
          secGpcHeader,
          body,
          load: loadPrefs,
          save: async (_s, prefs) => savePrefs(prefs),
        });
      }
      if (path === "/api/privacy/export") {
        // #3102 (#945 Q4): sensitive export requires fresh
        // authentication inside the 10-minute window. Wiring OFF
        // keeps legacy behavior; a null session is left to the
        // export handler's own gate (401).
        if (session && requiresStepUpForAction(session, "sensitive-export", isWiringEnabled(env), Date.now())) {
          return Response.json({ error: "Step-up authentication required: please sign in again and retry." }, { status: 403 });
        }
        return handlePrivacyExportRoute({
          session,
          method: request.method,
          subject,
          loadExport: async (s) =>
            buildExportPayload({
              subject: s,
              session: { login: session?.githubLogin ?? null, hasInternalUserId: true },
              messages: [],
              researchRuns: [],
              screenerRuns: [],
              preferences: await loadPrefs(),
              generatedAt: Date.now(),
              coverage: [
                { source: "session", status: "included", note: "caller session summary + stored preferences" },
                {
                  source: "mas_messages",
                  status: "not_wired",
                  note: "rows live in OrchestratorAgent DO SQLite; no per-subject server read path on current main (#1765 follow-up)",
                },
                {
                  source: "research_runs",
                  status: "not_wired",
                  note: "rows live in ResearchAgent DO SQLite; no per-subject server read path on current main (#1765 follow-up)",
                },
                {
                  source: "screener_runs",
                  status: "not_wired",
                  note: "rows live in ScreenerAgent DO SQLite; no per-subject server read path on current main (#1765 follow-up)",
                },
                {
                  source: "vectorize",
                  status: "not_wired",
                  note: "vectors keyed by report/plan/outcome id, never by subject; no per-subject read path on current main",
                },
              ],
            }),
        });
      }
      // /api/privacy/erasure
      const legs: ErasureLeg[] = [
        {
          name: "session",
          erase: async (s) => {
            const before = await kv.get(`privacy:prefs:${s}`).catch(() => null);
            await kv.delete(`privacy:prefs:${s}`);
            const after = await kv.get(`privacy:prefs:${s}`).catch(() => null);
            return { deleted: before ? 1 : 0, residual: after ? 1 : 0 };
          },
          count: async (s) => ((await kv.get(`privacy:prefs:${s}`).catch(() => null)) ? 1 : 0),
        },
        {
          name: "orchestrator",
          deferred: "no per-subject delete RPC on OrchestratorAgent on current main (#1765 follow-up)",
        },
        {
          name: "research",
          deferred: "no per-subject delete RPC on ResearchAgent on current main (#1765 follow-up)",
        },
        {
          name: "screener",
          deferred: "no per-subject delete RPC on ScreenerAgent on current main (#1765 follow-up)",
        },
        {
          name: "vectorize",
          deferred: "no per-subject vector key on current main; vectors keyed by report/plan/outcome id",
        },
      ];
      const erasureResponse = await handlePrivacyErasureRoute({
        session,
        method: request.method,
        subject,
        legs,
      });
      // Erasure terminates the caller's own session: clear its
      // cookie on any handled (200) erasure response. Other
      // sessions of the same subject cannot be enumerated
      // (KvLike has no list) — recorded in the §15 report.
      if (erasureResponse.status === 200) {
        const headers = new Headers(erasureResponse.headers);
        headers.set("Set-Cookie", clearSessionCookie());
        return new Response(erasureResponse.body, {
          status: erasureResponse.status,
          headers,
        });
      }
      return erasureResponse;
    }
  return null;
}

/**
 * Slice 4 of Qunsultant/cfagent#2902 (Privacy & compliance) — moves only.
 * The chains / jobs / traces / registry / catalog / reconcile family of
 * handleFetch, verbatim and in original order: /api/chains/status,
 * /api/chains/reconcile, /api/jobs/history, /api/traces,
 * /api/agents/registry, /api/products/catalog, /api/jobs/reconcile,
 * /api/retention/purge. Returns null when no branch matches, so
 * handleFetch falls through to the next delegation exactly as the inline
 * chain did.
 */
export async function handlePrivacyChainsRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
    // --- Chain/schedule projection status (issue #1651, slice 1) ---
    // GET /api/chains/status?chainId=: tenant-scoped read of the
    // AgentDB projection ONLY — never the durable object. Gated
    // by requireAuth (any signed-in user); the tenant comes from
    // the IAAA tenant resolution, so a caller can only ever see
    // their own tenant's rows. Unbound AgentDB → 503.
    if (path === "/api/chains/status") {
      const session = await requireAuth(request, env);
      const tenantId = resolveIaaaTenant(env);
      const chainId = url.searchParams.get("chainId") ?? "";
      const status = session
        ? await readChainStatus(env, tenantId, chainId)
        : null;
      if (!session) {
        return handleChainStatusRoute({
          session: null,
          method: request.method,
          tenantId,
          chainId,
          readStatus: async () => ({ chain: null, schedule: null }),
        });
      }
      if (status === null) {
        return Response.json(
          { error: "Chain status unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      return handleChainStatusRoute({
        session,
        method: request.method,
        tenantId,
        chainId,
        readStatus: async () => status,
      });
    }

    // --- Chain/schedule reconciliation (issue #1651, slice 1) ---
    // POST /api/chains/reconcile: the deliberate operator
    // invocation point for projection reconciliation. Gating
    // reuses the IAAA admin pattern exactly (requireAuth → wired
    // session → live platform-admin membership, fail-closed, no
    // data on 403). Never auto-run: no boot, deploy, or tick
    // path calls it. Runs on the shared ScheduledAgent "default"
    // instance, whose synthesizedSchedules key is authoritative.
    if (path === "/api/chains/reconcile") {
      const session = await requireAuth(request, env);
      let isPlatformAdmin = false;
      if (session?.internalUserId) {
        try {
          const overview = await buildAdminOverview(
            {
              membershipStore: wiredMembershipStore(env),
              auditStore: createWiredAuditStore(env),
              kv: sessionStore(env),
              tenantId: resolveIaaaTenant(env),
              nowMs: Date.now(),
            },
            { callerInternalUserId: session.internalUserId },
          );
          isPlatformAdmin = overview.allowed;
        } catch {
          return Response.json({ error: "Chain reconciliation unavailable." }, { status: 500 });
        }
      }
      const sched = actorGateway.stub<{
        reconcileChainScheduleProjection(
          tenantId: string,
          actor?: string,
        ): Promise<ReconcileReport>;
      }>((env as any).SCHEDULED_AGENT, "default");
      return handleReconcileChainsRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId: resolveIaaaTenant(env),
        // Issue #2426: the operator's login rides to the agent so
        // the reconcile audit row names its real actor.
        runReconcile: ({ tenantId, actor }) =>
          sched.reconcileChainScheduleProjection(tenantId, actor),
      });
    }

    // --- Shard job projection history (issue #1676, slice 2) ---
    // GET /api/jobs/history?chainId=: tenant-scoped read of the
    // AgentDB projection ONLY — never the durable object. Gated
    // by requireAuth (any signed-in user); the tenant comes from
    // the IAAA tenant resolution, so a caller can only ever see
    // their own tenant's rows. Unbound AgentDB → 503.
    if (path === "/api/jobs/history") {
      const session = await requireAuth(request, env);
      const tenantId = resolveIaaaTenant(env);
      const chainId = url.searchParams.get("chainId") ?? "";
      const history = session
        ? await readJobHistory(env, tenantId, chainId)
        : null;
      if (!session) {
        return handleJobHistoryRoute({
          session: null,
          method: request.method,
          tenantId,
          chainId,
          readHistory: async () => [],
        });
      }
      if (history === null) {
        return Response.json(
          { error: "Job history unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      return handleJobHistoryRoute({
        session,
        method: request.method,
        tenantId,
        chainId,
        readHistory: async () => history,
      });
    }

    // --- Mesh trace read (issue #2000, Phase 5 slice 3) ---
    // GET /api/traces?traceId=: tenant-scoped read of one
    // trace's assembled hops — the surfacing route for the
    // mesh trace spine (before this slice no route exposed
    // hopsFor; the assembly lived only behind the MCP read
    // command). Gated by requireAuth (any signed-in user);
    // the tenant comes from the IAAA tenant resolution, like
    // the job-history read above. Unbound AgentDB → 503 (the
    // durable hop record requires AGENT_DB; isolate-local
    // in-memory hops are never served as a trace). Unknown
    // trace, or another tenant's trace → 404. The handler
    // answers GET only and writes nothing.
    if (path === "/api/traces") {
      const session = await requireAuth(request, env);
      const tenantId = resolveIaaaTenant(env);
      const traceId = url.searchParams.get("traceId") ?? "";
      return handleMeshTraceRoute({
        session,
        method: request.method,
        traceId,
        readTrace: createTraceReader(env, tenantId),
      });
    }

    // --- Agent Mesh registry view (issue #2469, S20/G9) ---
    // GET /api/agents/registry: the Agents view's data route — a
    // read-only rendering of the G0 registry (src/agents/
    // registry.ts), derived at request time. Gated by requireAuth
    // (any signed-in user), like the job-history read; the payload
    // is fleet facts recorded in code (credential posture as env
    // names only — never secret values), so no tenant scoping
    // applies. The handler answers GET only.
    if (path === "/api/agents/registry") {
      const session = await requireAuth(request, env);
      return handleMeshRegistryRoute({ session, method: request.method });
    }

    // --- Product catalog view (issue #2695, Platform Phase 4) ---
    // GET /api/products/catalog: the Products view's data route —
    // a read-only rendering of the Phase 2 product catalog with
    // Phase 3 access parity, derived at request time. Gated by
    // requireAuth (any signed-in user), like the registry read.
    // The price list comes from the price-catalogue adapter bound
    // to AGENT_DB; unbound → the handler answers 503 (a read route
    // never auto-migrates a schema). Exactly one bounded
    // price-catalogue query per request; no SessionStore reads
    // beyond requireAuth's own session check. The handler answers
    // GET only and writes nothing.
    if (path === "/api/products/catalog") {
      const session = await requireAuth(request, env);
      const adapter = createPriceCatalogueAdapter(
        env as { AGENT_DB?: unknown },
      );
      return handleProductCatalogRoute({
        session,
        method: request.method,
        listPrices: adapter ? () => adapter.getAllPrices() : null,
      });
    }

    // --- Shard job reconciliation (issue #1676, slice 2) ---
    // POST /api/jobs/reconcile: the deliberate operator
    // invocation point for shard job reconciliation. Gating
    // reuses the IAAA admin pattern exactly (requireAuth → wired
    // session → live platform-admin membership, fail-closed, no
    // data on 403). Never auto-run: no boot, deploy, or tick
    // path calls it. Runs on the shared Orchestrator instance,
    // whose mas_async_jobs rows are the rails source of truth.
    // Unbound AgentDB → 503 (checked before the handler runs).
    if (path === "/api/jobs/reconcile") {
      const session = await requireAuth(request, env);
      let isPlatformAdmin = false;
      if (session?.internalUserId) {
        try {
          const overview = await buildAdminOverview(
            {
              membershipStore: wiredMembershipStore(env),
              auditStore: createWiredAuditStore(env),
              kv: sessionStore(env),
              tenantId: resolveIaaaTenant(env),
              nowMs: Date.now(),
            },
            { callerInternalUserId: session.internalUserId },
          );
          isPlatformAdmin = overview.allowed;
        } catch {
          return Response.json({ error: "Job reconciliation unavailable." }, { status: 500 });
        }
      }
      if (!createShardJobAdapter(env)) {
        return Response.json(
          { error: "Job reconciliation unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      const stub = actorGateway.stub<{
        reconcileShardJobProjection(
          tenantId: string,
        ): Promise<ReconcileShardJobsReport>;
      }>(env.ORCHESTRATOR_AGENT, SHARED_ORCHESTRATOR_INSTANCE);
      return handleReconcileJobsRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId: resolveIaaaTenant(env),
        runReconcile: ({ tenantId }) =>
          stub.reconcileShardJobProjection(tenantId),
      });
    }

    // --- AgentDB retention purge (issue #1701, slice 6) ---
    // POST /api/retention/purge: the deliberate operator
    // invocation point for retention enforcement. Gating
    // reuses the IAAA admin pattern exactly (requireAuth →
    // wired session → live platform-admin membership,
    // fail-closed, no data on 403). Never auto-run: no boot,
    // deploy, or tick path calls it. Unlike reconciliation,
    // the purge needs no durable-object hop — it touches
    // only the AgentDB projection, so the server calls it
    // directly. Unbound AgentDB → 503 (checked before the
    // handler runs). The governed job definition
    // (RETENTION_PURGE_JOB) is activated by an operator as
    // a separate step; nothing here schedules it.
    // Issue #1766 (F-58): every purge run appends a
    // retention.purge IAAA audit event after the purge
    // succeeds; auditOk:false on the report means the
    // append failed and the run must not be reported as
    // audited.
    if (path === "/api/retention/purge") {
      const session = await requireAuth(request, env);
      let isPlatformAdmin = false;
      if (session?.internalUserId) {
        try {
          const overview = await buildAdminOverview(
            {
              membershipStore: wiredMembershipStore(env),
              auditStore: createWiredAuditStore(env),
              kv: sessionStore(env),
              tenantId: resolveIaaaTenant(env),
              nowMs: Date.now(),
            },
            { callerInternalUserId: session.internalUserId },
          );
          isPlatformAdmin = overview.allowed;
        } catch {
          return Response.json({ error: "Retention purge unavailable." }, { status: 500 });
        }
      }
      if (!createRetentionPurgeStore(env)) {
        return Response.json(
          { error: "Retention purge unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      return handleRetentionPurgeRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId: resolveIaaaTenant(env),
        runPurge: async ({ tenantId }) => {
          // Null is unreachable here (unbound store returned 503
          // above); the throw keeps the handler's contract total
          // and maps to 500 rather than a silent null.
          const report = await runRetentionPurgeForTenant(env, tenantId, {
            nowMs: Date.now(),
          });
          if (!report) {
            throw new Error(
              "Retention purge unavailable: AgentDB is not bound.",
            );
          }
          // Issue #1766 (F-58): the purge run IS an audit event.
          // The append is best-effort in one direction only: an
          // audit failure is surfaced as auditOk:false on the
          // report (never reported as audited when it was not)
          // and never hides the purge result itself.
          try {
            const audit = await recordAuditEvent(createWiredAuditStore(env), buildPurgeAuditEventInput(
              report,
              {
                actorPrincipalId:
                  typeof session?.internalUserId === "string"
                    ? session.internalUserId
                    : "system",
                tenantId,
                nowMs: Date.now(),
              },
            ));
            report.auditOk = audit.ok;
            if (!audit.ok) {
              console.error("[retention] purge audit append failed:", audit.error);
            }
          } catch (err) {
            report.auditOk = false;
            console.error(
              "[retention] purge audit append threw:",
              err instanceof Error ? err.message : String(err),
            );
          }
          return report;
        },
      });
    }
  return null;
}

/**
 * Slice 4 of Qunsultant/cfagent#2902 (Privacy & compliance) — moves only.
 * The audit / reports family of handleFetch, verbatim and in original
 * order: /api/audit/history, /api/reports/list,
 * /api/reports/seed-canonical. Returns null when no branch matches, so
 * handleFetch falls through to the next delegation exactly as the inline
 * chain did.
 */
export async function handlePrivacyReportsRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
    // --- Audit history (issue #1688, slice 3) ---
    // GET /api/audit/history?chainId=: tenant-scoped read of the
    // AgentDB audit projection ONLY — never the durable object.
    // Gated by requireAuth (any signed-in user); the tenant comes
    // from the IAAA tenant resolution, so a caller can only ever
    // see their own tenant's rows. Unbound AgentDB → 503.
    if (path === "/api/audit/history") {
      const session = await requireAuth(request, env);
      const tenantId = resolveIaaaTenant(env);
      const chainId = url.searchParams.get("chainId") ?? "";
      const history = session
        ? await readAuditHistory(env, tenantId, chainId)
        : null;
      if (!session) {
        return handleAuditHistoryRoute({
          session: null,
          method: request.method,
          tenantId,
          chainId,
          readHistory: async () => [],
        });
      }
      if (history === null) {
        return Response.json(
          { error: "Audit history unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      return handleAuditHistoryRoute({
        session,
        method: request.method,
        tenantId,
        chainId,
        readHistory: async () => history,
      });
    }

    // --- Canonical reports list (issue #1688, slice 3) ---
    // GET /api/reports/list[?reportId=]: tenant-scoped read of
    // the AgentDB report projection ONLY — never the durable
    // object. Without reportId, latest row per report, newest
    // first; with reportId, that one report. Gated by
    // requireAuth (any signed-in user); tenant from IAAA
    // resolution. Unbound AgentDB → 503. Bodies stay out of
    // the list shape — the durable object holds the full copy.
    if (path === "/api/reports/list") {
      const session = await requireAuth(request, env);
      const tenantId = resolveIaaaTenant(env);
      const reportId = url.searchParams.get("reportId");
      const reports = session
        ? await readReports(env, tenantId, reportId)
        : null;
      if (!session) {
        return handleReportsRoute({
          session: null,
          method: request.method,
          tenantId,
          reportId,
          readReports: async () => [],
        });
      }
      if (reports === null) {
        return Response.json(
          { error: "Reports unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      return handleReportsRoute({
        session,
        method: request.method,
        tenantId,
        reportId,
        readReports: async () => reports,
      });
    }

    // --- Canonical reports seed (issue #1688, slice 3) ---
    // POST /api/reports/seed-canonical: the deliberate operator
    // invocation point for the one-time canonical mas_reports
    // seed. Gating reuses the IAAA admin pattern exactly
    // (requireAuth → wired session → live platform-admin
    // membership, fail-closed, no data on 403). Never
    // auto-run: no boot, deploy, or tick path calls it. Runs
    // on the shared Orchestrator instance, whose mas_reports
    // is the canonical copy; it writes projection rows only,
    // never the DO table, and a second run seeds zero rows.
    if (path === "/api/reports/seed-canonical") {
      const session = await requireAuth(request, env);
      let isPlatformAdmin = false;
      if (session?.internalUserId) {
        try {
          const overview = await buildAdminOverview(
            {
              membershipStore: wiredMembershipStore(env),
              auditStore: createWiredAuditStore(env),
              kv: sessionStore(env),
              tenantId: resolveIaaaTenant(env),
              nowMs: Date.now(),
            },
            { callerInternalUserId: session.internalUserId },
          );
          isPlatformAdmin = overview.allowed;
        } catch {
          return Response.json({ error: "Reports seed unavailable." }, { status: 500 });
        }
      }
      if (!createAuditReportAdapter(env)) {
        return Response.json(
          { error: "Reports seed unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      const stub = actorGateway.stub<{
        seedCanonicalReports(
          setBy: string,
          tenantId: string,
        ): Promise<SeedCanonicalReportsResult>;
      }>(env.ORCHESTRATOR_AGENT, SHARED_ORCHESTRATOR_INSTANCE);
      return handleSeedReportsRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId: resolveIaaaTenant(env),
        runSeed: ({ tenantId, setBy }) => stub.seedCanonicalReports(setBy, tenantId),
      });
    }
  return null;
}
