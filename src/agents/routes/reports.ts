/**
 * Issue #359-01: reports + HITL routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move — no behavior change.
 *
 * The module handles the report generation/dispatch routes, the #277 HITL
 * confirmation routes (pending list + confirm), and the report-settings routes.
 * It is invoked from routeRequest at the EXACT position the original blocks
 * occupied in the sequential path.endsWith matching sequence. It returns a
 * Response when one of its paths matches, or null when none does — matching
 * order relative to all other handlers is preserved by the call site.
 *
 * Handlers that used OrchestratorAgent private helpers/state receive them via
 * the explicit ReportsRouteContext parameter; there are no new globals and no
 * back-references into the class.
 */

import type { AgentName, AsyncJobSubmission } from "../../types";
import {
  createCommercialAdapter,
  ensureCommercialSchema,
} from "../../data/createCommercialPorts";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import type { SqlStorage } from "../../orm";
import type { ScreenerAgent } from "../screener-agent";
import type { RunSummary } from "../../services/runSummaries";
import {
  canonicalResearchEmailBody,
  canonicalResearchWebhookBody,
  type ScheduledReportHit,
} from "../../services/scheduledReports";
import { createCanonicalReportStorePorts } from "../../data/createCanonicalReportStorePorts";
import type { SettingsChangeNotifier } from "../settingsWebhookNotify";
import { createOrchestratorTablePorts } from "../../data/createOrchestratorTablePorts";
import {
  runCanonicalIndexBackfillAll,
  runCanonicalIndexBackfillPage,
  shouldFireReportsIndexBackfillTick,
  REPORTS_INDEX_BACKFILL_LAST_RUN_KEY,
  type CanonicalIndexBackfillOutcome,
} from "../../services/reportSemanticIndex";
// Issue #3527 S5 — the reports canonical-index sweep is a
// registered scheduled job now: its outcomes record into the same
// #2037 sink + #1333 run store as the other tick jobs. Helpers
// live below the context type; recording never changes a response.
import {
  recordScheduledJobOutcome,
  sanitizeScheduledJobErrorCode,
  scheduledJobOutcomeStoreFromOrmEvents,
  type ScheduledJobOutcomeInput,
} from "../../observability/scheduledJobOutcomes";
import { parseTraceparent } from "../../observability/observabilityPorts";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { createStructuredLogger } from "../../observability/structuredLogger";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/reports",
});
import { resolveScheduledJobAlertThreshold } from "../../config/scheduledJobAlert";
import { postSlackText, resourceSlackPost } from "../resourceGoals";
import type { SlackDeliveryEnv } from "../social/delivery";
import {
  recordJobOutcome,
  type JobOutcomeTrigger,
} from "../../services/jobOutcomes";
import { resolveActorAttribution } from "../../security/backgroundAttribution";
import { getServiceUserLogin } from "../../security/serviceIdentity";
import {
  settingReadFromSql,
  settingWriteFromSql,
} from "../../services/screeningFlags";
import { unauthenticatedResponse } from "./routeIdentity";
import {
  POLLING_CONFIG_DEFAULTS,
  clampAutoRefreshIntervalS,
  resolvePollingConfigFromEnv,
  type PollingEnvVars,
} from "../../pollingConfig";

/** The subset of OrchestratorAgent surface the reports/HITL handlers need. */
export interface ReportsRouteContext {
  ensureTables(): SqlStorage;
  /** Worker bindings for the semantic-search handler (#2120 slice 0):
   *  AI + Vectorize arrive via the orchestrator mount ctx. Optional so
   *  older callers without bindings keep working; the handler falls
   *  back to lexical-only when they are absent.
   *  Issue #1169 S4-1: REPORTS_BUCKET joins them (type-only widening)
   *  so the index-backfill hook can resolve R2 bodies for WithR2 rows;
   *  the orchestrator mount already passes the full env. */
  env?: {
    AI?: any;
    VECTOR_MEMORY?: any;
    REPORTS_BUCKET?: any;
    /** Issue #2481: D1 binding for the tenant settings store. */
    AGENT_DB?: unknown;
    /** Issue #2481: server-resolved tenant id (see resolveIaaaTenant). */
    IAAA_TENANT_ID?: string;
    /** Issue #3527 S5: the service identity joins the narrow env
     *  so the sweep's run records can attribute a background
     *  dispatch vs a manual invocation (mounts pass the full env). */
    SERVICE_USER_LOGIN?: string;
  };
  /**
   * Issue #3527 S5 — ORM accessor (owner: OrchestratorAgent.getOrm)
   * for the sweep's scheduled-job outcome recording (#2037 sink).
   * Optional so older callers keep working; without it the
   * recording degrades to a no-op, never to a changed response.
   */
  getOrm?: () => {
    events?: { create?: unknown; findMany?: unknown };
  } | null | undefined;
  /**
   * Issue #3471: after a tenant provider (broker) selection write
   * commits, notify the caller's own orchestrator instance through
   * the webhook channel (the push leg). Optional: hosts without
   * the notifier keep the pre-#3471 behavior (the observe floor
   * bounds the staleness). Fire-and-forget; never throws; the
   * write's response never depends on it.
   */
  notifySettingsChanged?: SettingsChangeNotifier;
  /** ScreenerAgent accessor (owner: OrchestratorAgent.getScreenerAgent) —
   *  the #1057 Runs merge reads the agent's latest/history feed via it. */
  getScreenerAgent(userLogin?: string): ScreenerAgent;
  /** Execution-context accessor (owner: OrchestratorAgent.getScreenerExecutionContext). */
  getScreenerExecutionContext(): Promise<
    { userLogin: string; environment?: "TEST" | "PROD" } | undefined
  >;
  getReportDispatchHitl(): boolean;
  setReportDispatchHitl(enabled: boolean): void;
  getReportConfirmation(id: string): any | null;
  decideReportConfirmation(
    id: string,
    status: "approved" | "rejected" | "expired",
    decidedBy: string | null
  ): void;
  createReportConfirmation(
    kind: "email" | "webhook" | "screener",
    payloadJson: string,
    reportId?: string | null,
    /** Issue #2664: the login creating the hold. */
    createdBy?: string | null
  ): string;
  /** Issue #1123 S5c: resubmit a held screener follow-up delivery on
   *  approval (the resubmitted job carries the approval marker). */
  submitFollowupDelivery?: (
    delivery: {
      outcome: import("../../services/screenerFollowups").ScreenerRunOutcome;
      userLogin: string;
      channel: import("../../types").AsyncJobChannel;
      artifacts: Array<{ key: string; fileName: string }>;
      parentJobId?: string;
      displayName?: string;
    },
    confirmationId: string
  ) => Promise<boolean>;
  confirmationDeliveryMeta(row: any): { recipient?: string };
  deliverStoredReportEmail(
    reportId: string,
    recipient: string,
    userLogin: string
  ): Promise<"sent" | "missing" | "failed">;
  deliverStoredReportWebhook(
    reportId: string,
    userLogin: string
  ): Promise<{
    outcome: "sent" | "missing" | "failed";
    result?: { success: boolean; status?: number; error?: string; notConfigured?: boolean };
  }>;
  sendReportEmail(
    recipient: string,
    title: string,
    fileName: string,
    attachmentBase64: string,
    userLogin: string
  ): Promise<boolean>;
  sendReportWebhook(
    title: string,
    query: string,
    sheets: Array<{ name: string; rows: Array<Record<string, unknown>> }>,
    userLogin: string
  ): Promise<{ success: boolean; status?: number; error?: string; notConfigured?: boolean }>;
  storeResearchReportCanonicalAsync(
    bodyJson: string,
    meta: { title: string; summary: string; userLogin?: string }
  ): Promise<{ reportId: string; generationId: string } | null>;
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** REPORT_CONFIRMATION_TTL_MS (src/agents/orchestrator/reportConfirmationTtl.ts) */
  reportConfirmationTtlMs(): number;
}

/**
 * Issue #1170 (E3): the followup-delivery resubmission closure that
 * used to be built inline in OrchestratorAgent.routeRequest's
 * reports context now lives here with the routes it serves (the
 * #992 extraction pattern — this is what keeps orchestrator.ts
 * inside its size budget as new dispatch blocks land). Behaviour is
 * identical to the inline closure: on a #277 approval it submits
 * the held delivery as a followup.deliver job carrying the
 * approved-confirmation marker, and reports success.
 */
export function makeSubmitFollowupDelivery(
  submitAsyncJob: (job: AsyncJobSubmission) => Promise<unknown>
): NonNullable<ReportsRouteContext["submitFollowupDelivery"]> {
  return async (delivery, confirmationId) => {
    await submitAsyncJob({
      capability: "followup.deliver",
      payload: {
        outcome: delivery.outcome,
        userLogin: delivery.userLogin,
        channel: delivery.channel,
        artifacts: delivery.artifacts,
        approvedConfirmationId: confirmationId,
      },
      parentJobId: delivery.parentJobId,
      jobKind: "delivery",
      channel: delivery.channel,
      displayName: delivery.displayName,
    });
    return true;
  };
}

/**
 * Handles the reports + HITL routes. Returns a Response on match, null when no
 * reports path matches (the orchestrator then continues its sequential matching).
 */
/**
 * Issue #3527 S5 — record one reports-sweep outcome in the single
 * mas_events sink (the #2037 idiom: streak + Slack alert through
 * the existing routes). Recording is observation, never the job:
 * every failure degrades to a no-op so the response the caller is
 * owed (the tick's fire-and-forget dispatch) is never changed.
 */
async function recordReportsBackfillOutcome(
  ctx: ReportsRouteContext,
  sessionId: string,
  input: Omit<ScheduledJobOutcomeInput, "job">
): Promise<void> {
  try {
    await recordScheduledJobOutcome(
      {
        store: scheduledJobOutcomeStoreFromOrmEvents(() => {
          const orm = ctx.getOrm?.();
          return orm?.events ?? null;
        }, sessionId),
        alert: async (text: string) => {
          await postSlackText({
            post: resourceSlackPost,
            env: (ctx.env ?? {}) as unknown as SlackDeliveryEnv,
            text,
          });
        },
        threshold: resolveScheduledJobAlertThreshold(
          (ctx.env ?? {}) as Record<string, unknown>
        ),
      },
      { job: "reports-index-backfill", ...input }
    );
  } catch {
    // Observation never fails the response.
  }
}

/** Background dispatch vs manual invocation, by actor attribution. */
function reportsBackfillTrigger(ctx: ReportsRouteContext, request: Request): JobOutcomeTrigger {
  const attribution = resolveActorAttribution(
    request.headers,
    getServiceUserLogin((ctx.env ?? {}) as unknown as Parameters<typeof getServiceUserLogin>[0])
  );
  return attribution.actorKind === "background" ? "scheduled" : "manual";
}

const REPORTS_BACKFILL_FAILED_CODE = "reports_index_backfill_failed";

/**
 * Issue #3527 S5 — record one ACTUAL sweep run in the #1333
 * per-instance run store, the row the Autopilot "Job outcomes"
 * feed renders. The sweep has no per-item documents to detail;
 * its page totals ride deliveryStates as strings, the store's
 * only detail channel. A guard-skipped tick records NO run row —
 * the dispatch record above is its whole trace, exactly as the
 * job idiom draws it.
 */
function recordReportsBackfillRun(
  ctx: ReportsRouteContext,
  request: Request,
  sql: SqlStorage,
  args: {
    ranAt: string;
    status: "completed" | "failed";
    codedError?: string;
    outcome?: CanonicalIndexBackfillOutcome;
  }
): void {
  try {
    recordJobOutcome(sql, {
      id: `reports-index-backfill:${args.ranAt}`,
      kind: "reports",
      trigger: reportsBackfillTrigger(ctx, request),
      status: args.status,
      scanned: args.outcome?.rows,
      matched: args.outcome?.upserted,
      codedError: args.codedError,
      deliveryStates: args.outcome
        ? {
            pages: String(args.outcome.pages),
            upserted: String(args.outcome.upserted),
            skippedRetention: String(args.outcome.skippedRetention),
          }
        : undefined,
      origin: "reports-index-backfill",
      createdAt: args.ranAt,
    });
  } catch (err) {
    structuredLog.warn("scheduled_job_outcome.run_record_failed", {
      message: "[reports] reports-index-backfill run record failed",
      job: "reports-index-backfill",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function handleReportsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: ReportsRouteContext
): Promise<Response | null> {
  // Issue #277: list pending report-dispatch confirmations for the
  // Settings UI. Summaries only — payloads stay server-side until decided.
  // Issue #1324: the same list feeds the Reports panel's pending-review
  // queue, so items carry expiry (for the countdown) and artifact
  // metadata (file names/links, never payload bytes). Expired rows are
  // marked expired with an audit row — mirroring the confirm path —
  // so they leave the queue instead of lingering past their window.
  if (path.endsWith("/trading/reports/pending") && request.method === "GET") {
    try {
      // Issue #2359 (#1976 step 4d): the read serves through
      // the report-confirmation port (same projection, same
      // newest-first order) instead of raw SQL.
      const rows = createOrchestratorTablePorts(ctx.ensureTables() as never)
        .confirmations.listPending() as any[];
      const ttlMs = ctx.reportConfirmationTtlMs();
      const nowMs = Date.now();
      const live = rows.filter((row) => {
        const ageMs = nowMs - new Date(String(row.created_at)).getTime();
        if (Number.isFinite(ageMs) && ageMs <= ttlMs) return true;
        ctx.decideReportConfirmation(String(row.id), "expired", null);
        ctx.audit("research_report.confirmation_expired", "trading", { confirmationId: String(row.id) });
        return false;
      });
      return Response.json({
        pending: live.map((row) => {
          let payload: any = {};
          try {
            payload = JSON.parse(String(row.payload_json));
          } catch {
            payload = {};
          }
          // Issue #308: new rows carry delivery metadata in payload_json
          // (sheetCount); legacy rows carry the full payload (sheets).
          const sheetCount =
            (payload.sheets || []).length || payload.sheetCount || 0;
          const delivery = (payload as any).delivery ?? {};
          const artifacts = Array.isArray(delivery.artifacts)
            ? delivery.artifacts.map((a: any) => String(a.fileName || a.key || "")).filter(Boolean)
            : row.kind === "email" && payload.fileName
              ? [String(payload.fileName)]
              : [];
          const createdMs = new Date(String(row.created_at)).getTime();
          return {
            confirmationId: String(row.id),
            kind: String(row.kind),
            createdAt: String(row.created_at),
            expiresAt: Number.isFinite(createdMs) ? new Date(createdMs + ttlMs).toISOString() : null,
            detail:
              row.kind === "email"
                ? `${payload.recipient || "?"} · ${payload.fileName || "?"}`
                : row.kind === "screener"
                  ? `${delivery.displayName || "Screener delivery"} · ${delivery.channel || "?"}`
                  : `${payload.title || "Research report"} · ${sheetCount} sheets`,
            artifacts,
            ...(row.kind === "screener"
              ? {
                  channel: typeof delivery.channel === "string" ? delivery.channel : undefined,
                  displayName: typeof delivery.displayName === "string" ? delivery.displayName : undefined,
                  reportUrl: typeof delivery.outcome?.reportUrl === "string" ? delivery.outcome.reportUrl : undefined,
                }
              : {}),
          };
        }),
      });
    } catch (err) {
      return Response.json({ error: "Failed to list pending confirmations." }, { status: 500 });
    }
  }

  // Issue #1326: confirmations for ONE run, joined exactly — the run's
  // canonical mas_reports row (run_id = `screener:<timestamp>`) → its id
  // → mas_report_confirmations rows for that report. Summaries only;
  // payload bytes stay server-side until decided, as in the pending list.
  // A run with no canonical row returns an empty list, not an error:
  // pre-canonical runs have no delivery record to link.
  if (path.endsWith("/trading/reports/confirmations") && request.method === "GET") {
    try {
      const runId = url.searchParams.get("runId");
      if (!runId) {
        return Response.json({ error: "runId is required." }, { status: 400 });
      }
      const sql = ctx.ensureTables();
      // Issue #2359 (#1976 step 4d): both halves of the join
      // serve through their ports — the canonical-report read
      // port for the run's row id, the confirmation port for
      // its confirmations (same projections and order).
      const reportId = createCanonicalReportStorePorts(sql as never).read.findIdByRunId(runId);
      if (!reportId) {
        return Response.json({ confirmations: [] });
      }
      const rows = createOrchestratorTablePorts(sql as never)
        .confirmations.listByReportId(reportId) as any[];
      return Response.json({
        confirmations: rows.map((row) => {
          let payload: any = {};
          try {
            payload = JSON.parse(String(row.payload_json));
          } catch {
            payload = {};
          }
          const sheetCount =
            (payload.sheets || []).length || payload.sheetCount || 0;
          return {
            confirmationId: String(row.id),
            kind: String(row.kind),
            status: String(row.status),
            createdAt: String(row.created_at),
            decidedAt: row.decided_at ? String(row.decided_at) : null,
            decidedBy: row.decided_by ? String(row.decided_by) : null,
            detail:
              row.kind === "email"
                ? `${payload.recipient || "?"} · ${payload.fileName || "?"}`
                : `${payload.title || "Research report"} · ${sheetCount} sheets`,
          };
        }),
      });
    } catch (err) {
      return Response.json({ error: "Failed to list run confirmations." }, { status: 500 });
    }
  }

  // Issue #277: server-side setting for HITL confirmation on report
  // dispatch. Default ON (#1144) — held for confirmation unless the
  // setting explicitly opts out.
  if (path.endsWith("/trading/settings/report-dispatch-hitl") && request.method === "GET") {
    return Response.json({ enabled: ctx.getReportDispatchHitl() });
  }

  if (path.endsWith("/trading/settings/report-dispatch-hitl") && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
    if (!body || typeof body.enabled !== "boolean") {
      return Response.json({ error: "enabled (boolean) is required." }, { status: 400 });
    }
    ctx.setReportDispatchHitl(body.enabled);
    ctx.audit("report_dispatch_hitl.changed", "orchestrator", { enabled: body.enabled });
    return Response.json({ enabled: body.enabled });
  }

  // Issue #2481: per-tenant auto-refresh setting (owner decision
  // 2026-10-30: the switch is a per-tenant setting whose source
  // of truth is the tenant store, edited via the dynamic panel).
  // Reached as /api/tenant/settings/auto-refresh through the
  // Worker's generic /api/ forwarder (server.ts: authenticated,
  // /api prefix stripped, forwarded to the caller's agent
  // instance, whose routeRequest reaches this handler before
  // the queue decision — the same path the HITL setting above
  // takes). Tenancy does NOT come from the serving instance:
  // the row lives in shared D1 agent_tenant_settings
  // (migration 0026) and the tenant is server-resolved with
  // resolveIaaaTenant (env IAAA_TENANT_ID, else "primary"),
  // never from a client-supplied value, so a caller can only
  // ever read or write its own tenant's row. The dynamic panel
  // is the editor, not the truth: the app shell loads this
  // value at boot into the single client auto-refresh module.
  // Absent row = OFF, interval 15s (the existing client
  // default, preserved — not an owner-approved default).
  if (path.endsWith("/tenant/settings/auto-refresh")) {
    try {
      const adapter = ctx.env
        ? createCommercialAdapter(ctx.env as { AGENT_DB?: unknown })
        : null;
      if (!adapter) {
        return Response.json({ error: "Tenant store unavailable: AGENT_DB is not bound." }, { status: 503 });
      }
      await ensureCommercialSchema(adapter.db);
      const tenantId = resolveIaaaTenant(ctx.env as { IAAA_TENANT_ID?: string } | null | undefined);
      if (request.method === "GET") {
        const current = await adapter.getTenantAutoRefresh(tenantId);
        return Response.json({ tenantId, enabled: current.enabled, intervalS: current.intervalS });
      }
      if (request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          enabled?: unknown;
          intervalS?: unknown;
        } | null;
        if (!body || typeof body.enabled !== "boolean") {
          return Response.json({ error: "enabled (boolean) is required." }, { status: 400 });
        }
        // Issue #2513 — clamp to the configured auto-refresh min/max
        // (defaults 10/300s from pollingConfig) instead of accepting any
        // finite interval > 0. When env config is unavailable, the
        // defaults below are the fallback, per the task spec.
        const polling = ctx.env
          ? resolvePollingConfigFromEnv(ctx.env as unknown as PollingEnvVars)
          : POLLING_CONFIG_DEFAULTS;
        const storedIntervalS = (await adapter.getTenantAutoRefresh(tenantId)).intervalS;
        const requestedIntervalS =
          typeof body.intervalS === "number" && Number.isFinite(body.intervalS) && body.intervalS > 0
            ? Math.floor(body.intervalS)
            : storedIntervalS;
        const intervalS = clampAutoRefreshIntervalS(requestedIntervalS, polling);
        const record = await adapter.setTenantAutoRefresh(tenantId, {
          enabled: body.enabled,
          intervalS,
        });
        ctx.audit("tenant_auto_refresh.changed", "orchestrator", {
          tenantId,
          enabled: record.autoRefreshEnabled,
          intervalS: record.autoRefreshIntervalS,
        });
        return Response.json({
          tenantId: record.tenantId,
          enabled: record.autoRefreshEnabled,
          intervalS: record.autoRefreshIntervalS,
          updatedAtMs: record.updatedAtMs,
        });
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to load tenant auto-refresh setting" },
        { status: 500 },
      );
    }
  }

  // Per-tenant data-provider / broker selection (slice 1 of the
  // provider/broker agnosticism programme). Two independent
  // selections, stored on the existing agent_tenant_settings row
  // (migration 0027), tenant server-resolved via resolveIaaaTenant,
  // never from a client value. Absent row = the platform defaults
  // (#3812: etrade data provider / alpaca broker).
  // This route does not touch the auto-refresh handler above.
  if (path.endsWith("/tenant/settings/providers")) {
    try {
      const adapter = ctx.env
        ? createCommercialAdapter(ctx.env as { AGENT_DB?: unknown })
        : null;
      if (!adapter) {
        return Response.json({ error: "Tenant store unavailable: AGENT_DB is not bound." }, { status: 503 });
      }
      await ensureCommercialSchema(adapter.db);
      const tenantId = resolveIaaaTenant(ctx.env as { IAAA_TENANT_ID?: string } | null | undefined);
      if (request.method === "GET") {
        const current = await adapter.getTenantProviders(tenantId);
        // Issue #3751: the resolved provider identity rides the
        // response — display names from the one identity map via
        // the composed context resolver, over the SAME row this
        // handler already read (no second store read). The
        // adapter has already applied the platform defaults per
        // field, so an absent row serves the default identities;
        // the fellBack flags carry the context's resolution state.
        const { resolveTenantProviderContext } = await import("../../services/optionsProviderContext");
        const providerContext = resolveTenantProviderContext(current);
        return Response.json({
          tenantId,
          dataProviderId: current.dataProviderId,
          brokerId: current.brokerId,
          identity: {
            dataProviderDisplayName: providerContext.dataProviderDisplayName,
            brokerDisplayName: providerContext.brokerDisplayName,
            dataProviderFellBack: providerContext.dataProviderFellBack,
            brokerFellBack: providerContext.brokerFellBack,
          },
        });
      }
      if (request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          dataProviderId?: unknown;
          brokerId?: unknown;
        } | null;
        const { normalizeTenantProviders } = await import("../../services/tenantProviders");
        const normalized = body ? normalizeTenantProviders(body) : null;
        if (!normalized) {
          return Response.json({ error: "dataProviderId and brokerId are required and must be known ids." }, { status: 400 });
        }
        const record = await adapter.setTenantProviders(tenantId, normalized);
        ctx.audit("tenant_providers.changed", "orchestrator", {
          tenantId,
          dataProviderId: record.dataProviderId,
          brokerId: record.brokerId,
        });
        // Issue #3471: the write has committed — notify the
        // caller's own instance (the session login server.ts
        // stamps on the request), whose copilot resolves this
        // tenant's broker row. No login, no instance to notify:
        // the write still stands and the observe floor owns
        // convergence.
        const login = request.headers.get("x-user-login")?.trim();
        if (ctx.notifySettingsChanged && login) {
          try {
            ctx.notifySettingsChanged({
              kind: "broker_selection_changed",
              login,
              changedAt: new Date().toISOString(),
            });
          } catch {
            // Notification is best-effort by contract; a notifier
            // that throws anyway must never fail the write.
          }
        }
        return Response.json({
          tenantId: record.tenantId,
          dataProviderId: record.dataProviderId,
          brokerId: record.brokerId,
          updatedAtMs: record.updatedAtMs,
        });
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to load tenant provider selection" },
        { status: 500 },
      );
    }
  }

  // Issue #277: confirm (or reject) a pending report dispatch. Mirrors
  // POST /payments/confirm: the stored payload is executed only on
  // "approved"; nothing is sent on "rejected" or for unknown/expired ids.
  if (path.endsWith("/trading/reports/confirm") && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      confirmationId?: string;
      decision?: "approved" | "rejected";
      note?: string;
    };
    const confirmationId = (body.confirmationId || "").trim();
    const decision = body.decision || "approved";
    const note = (body.note || "").trim();
    if (!confirmationId) {
      return Response.json({ error: "confirmationId is required" }, { status: 400 });
    }
    const row = ctx.getReportConfirmation(confirmationId);
    if (!row) {
      return Response.json({ error: "Report confirmation not found." }, { status: 404 });
    }
    // Issue #2664: a held dispatch is its creator's HITL — no other
    // user may approve, reject, or trigger it, and no operator bypass
    // exists. The creator is the stored created_by; legacy rows fall
    // back to the linked canonical report's owner through the read
    // port (getRowByIdForOwner). Pre-#308 rows with neither a creator
    // nor a linked report keep the pinned embedded-payload fallback
    // (canonical-report.test.ts: legacy rows still approve): they
    // predate ownership tracking, are age-bounded by the TTL check
    // below, and live in the creator's per-user instance store. The
    // gate runs before any status/expiry read so a non-owner learns
    // nothing about the row.
    const callerLogin = request.headers.get("x-user-login") || sessionId;
    const { isCanonicalReportOwnedBy } = await import("../../services/scheduledReports");
    if (typeof (row as any).created_by === "string" && (row as any).created_by) {
      if ((row as any).created_by !== callerLogin) {
        ctx.audit("research_report.confirmation_denied", "trading", { confirmationId });
        return Response.json(
          { error: "Forbidden: this confirmation belongs to another user." },
          { status: 403 }
        );
      }
    } else if (row.report_id) {
      if (!isCanonicalReportOwnedBy(ctx.ensureTables(), String(row.report_id), callerLogin)) {
        ctx.audit("research_report.confirmation_denied", "trading", { confirmationId });
        return Response.json(
          { error: "Forbidden: this confirmation's report belongs to another user or is no longer available; re-submit the delivery." },
          { status: 403 }
        );
      }
    }
    // else: pre-#308 orphan row — pinned legacy fallback below.
    if (row.status !== "pending") {
      return Response.json(
        { error: `Report confirmation already ${row.status}.`, confirmationId },
        { status: 409 }
      );
    }
    const ageMs = Date.now() - new Date(String(row.created_at)).getTime();
    if (!Number.isFinite(ageMs) || ageMs > ctx.reportConfirmationTtlMs()) {
      ctx.decideReportConfirmation(confirmationId, "expired", null);
      ctx.audit("research_report.confirmation_expired", "trading", { confirmationId });
      return Response.json({ error: "Report confirmation expired.", confirmationId }, { status: 410 });
    }
    const userLogin = callerLogin;
    if (decision === "approved") {
      // Issue #1123 S5c: a held screener follow-up delivery. Approval
      // resubmits the delivery job with the approval marker so the
      // executor sends it; the spec rides the confirmation payload.
      if (row.kind === "screener") {
        if (!ctx.submitFollowupDelivery) {
          return Response.json({ error: "Screener delivery release is unavailable in this host." }, { status: 500 });
        }
        let delivery: Parameters<NonNullable<typeof ctx.submitFollowupDelivery>>[0] | undefined;
        try {
          delivery = (JSON.parse(String(row.payload_json)) as { delivery?: typeof delivery })?.delivery;
        } catch {
          delivery = undefined;
        }
        if (!delivery || typeof delivery !== "object") {
          return Response.json({ error: "The confirmation has no delivery payload." }, { status: 500 });
        }
        const submitted = await ctx.submitFollowupDelivery(delivery, confirmationId);
        if (!submitted) {
          return Response.json({ error: "Could not resubmit the held delivery." }, { status: 500 });
        }
        ctx.decideReportConfirmation(confirmationId, "approved", userLogin);
        ctx.audit("screener.followup_delivery_released", "orchestrator", { confirmationId, channel: delivery.channel });
        return Response.json({ success: true, status: "dispatched", confirmationId });
      }
      // Issue #308: deliver the STORED canonical copy. New rows
      // reference mas_reports via report_id; legacy rows (pre-#308)
      // carry the full payload in payload_json (fallback below).
      if (row.report_id) {
        const reportId = String(row.report_id);
        const meta = ctx.confirmationDeliveryMeta(row);
        if (row.kind === "email") {
          const recipient = meta.recipient || "";
          if (!recipient) {
            return Response.json({ error: "The confirmation has no delivery recipient." }, { status: 500 });
          }
          const outcome = await ctx.deliverStoredReportEmail(reportId, recipient, userLogin);
          if (outcome === "missing") {
            return Response.json({ error: "The stored report is no longer available." }, { status: 500 });
          }
          if (outcome !== "sent") {
            return Response.json({ error: "Email delivery is unavailable; check the configured email binding." }, { status: 503 });
          }
          ctx.decideReportConfirmation(confirmationId, "approved", userLogin);
          ctx.audit("research_report.emailed", "trading", {
            confirmationId,
            recipient,
            reportId,
            via: "hitl_confirmation",
          });
          return Response.json({ success: true, status: "dispatched", confirmationId });
        }
        const delivered = await ctx.deliverStoredReportWebhook(reportId, userLogin);
        if (delivered.outcome === "missing") {
          return Response.json({ error: "The stored report is no longer available." }, { status: 500 });
        }
        const result = delivered.result!;
        if (!result.success) {
          const status = result.notConfigured ? 503 : 502;
          return Response.json({ error: result.error || `Webhook returned HTTP ${result.status}.` }, { status });
        }
        ctx.decideReportConfirmation(confirmationId, "approved", userLogin);
        ctx.audit("research_report.webhook_dispatched", "trading", {
          confirmationId,
          status: result.status,
          reportId,
          via: "hitl_confirmation",
        });
        return Response.json({ success: true, status: "dispatched", confirmationId });
      }
      const payload = JSON.parse(String(row.payload_json)) as any;
      if (row.kind === "email") {
        const sent = await ctx.sendReportEmail(
          String(payload.recipient),
          String(payload.title),
          String(payload.fileName),
          String(payload.attachmentBase64),
          userLogin
        );
        if (!sent) {
          return Response.json({ error: "Email delivery is unavailable; check the configured email binding." }, { status: 503 });
        }
        ctx.decideReportConfirmation(confirmationId, "approved", userLogin);
        ctx.audit("research_report.emailed", "trading", {
          confirmationId,
          recipient: payload.recipient,
          fileName: payload.fileName,
          via: "hitl_confirmation",
        });
        return Response.json({ success: true, status: "dispatched", confirmationId });
      }
      const result = await ctx.sendReportWebhook(
        String(payload.title),
        String(payload.query || ""),
        payload.sheets,
        userLogin
      );
      if (!result.success) {
        const status = result.notConfigured ? 503 : 502;
        return Response.json({ error: result.error || `Webhook returned HTTP ${result.status}.` }, { status });
      }
      ctx.decideReportConfirmation(confirmationId, "approved", userLogin);
      ctx.audit("research_report.webhook_dispatched", "trading", {
        confirmationId,
        status: result.status,
        sheets: (payload.sheets || []).length,
        via: "hitl_confirmation",
      });
      return Response.json({ success: true, status: "dispatched", confirmationId });
    }
    ctx.decideReportConfirmation(confirmationId, "rejected", userLogin);
    ctx.audit("research_report.confirmation_rejected", "trading", { confirmationId, note });
    return Response.json({ success: true, status: "rejected", confirmationId });
  }

  if (path.endsWith("/trading/reports/email") && request.method === "POST") {
    const body = await request.json().catch(() => null) as {
      to?: string;
      fileName?: string;
      attachmentBase64?: string;
      title?: string;
    } | null;
    const recipient = typeof body?.to === "string" ? body.to.trim() : "";
    const fileName = typeof body?.fileName === "string" ? body.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") : "";
    const attachmentBase64 = typeof body?.attachmentBase64 === "string" ? body.attachmentBase64 : "";
    if (!body || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(recipient)) {
      return Response.json({ error: "A valid email recipient is required." }, { status: 400 });
    }
    if (!fileName.toLowerCase().endsWith(".xlsx") || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachmentBase64) || attachmentBase64.length > 7_000_000) {
      return Response.json({ error: "A valid .xlsx workbook under 5 MB is required." }, { status: 400 });
    }
    let workbookBytes: Uint8Array;
    try {
      const binary = atob(attachmentBase64);
      workbookBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      return Response.json({ error: "The workbook attachment is not valid base64." }, { status: 400 });
    }
    if (workbookBytes.length > 5 * 1024 * 1024 || workbookBytes[0] !== 0x50 || workbookBytes[1] !== 0x4b) {
      return Response.json({ error: "The attachment must be a valid .xlsx workbook under 5 MB." }, { status: 400 });
    }
    const userLogin = request.headers.get("x-user-login") || sessionId;
    const title = (typeof body.title === "string" ? body.title : "Research report").replace(/[\r\n]/g, " ").slice(0, 120);
    // Issue #308: store the canonical copy FIRST — every channel
    // delivers the stored report, never the request in memory.
    const reportBodyJson = canonicalResearchEmailBody({ title, fileName, attachmentBase64 });
    const stored = await ctx.storeResearchReportCanonicalAsync(reportBodyJson, {
      title,
      summary: `Research report workbook: ${fileName} (${title})`,
      userLogin,
    });
    if (!stored) {
      return Response.json({ error: "The report could not be stored; dispatch aborted." }, { status: 500 });
    }
    if (ctx.getReportDispatchHitl()) {
      // Issue #277: hold for human confirmation instead of sending.
      // Issue #308: the pending row references the stored report id;
      // payload_json carries delivery metadata only (no report bytes).
      const confirmationId = ctx.createReportConfirmation(
        "email",
        JSON.stringify({ recipient, title, fileName }),
        stored.reportId,
        userLogin
      );
      ctx.audit("research_report.pending_confirmation", "trading", { confirmationId, recipient, fileName, reportId: stored.reportId });
      return Response.json({ success: true, status: "pending_confirmation", confirmationId });
    }
    const outcome = await ctx.deliverStoredReportEmail(stored.reportId, recipient, userLogin);
    if (outcome === "missing") {
      return Response.json({ error: "The stored report is unavailable; dispatch aborted." }, { status: 500 });
    }
    if (outcome !== "sent") return Response.json({ error: "Email delivery is unavailable; check the configured email binding." }, { status: 503 });
    ctx.audit("research_report.emailed", "trading", { recipient, fileName, reportId: stored.reportId });
    return Response.json({ success: true });
  }

  if (path.endsWith("/trading/reports/webhook") && request.method === "POST") {
    const body = await request.json().catch(() => null) as {
      title?: string;
      query?: string;
      sheets?: Array<{ name: string; rows: Array<Record<string, unknown>> }>;
    } | null;
    if (!body || !Array.isArray(body.sheets) || body.sheets.length === 0 ||
      body.sheets.some((sheet) => !sheet || typeof sheet.name !== "string" || !Array.isArray(sheet.rows))) {
      return Response.json({ error: "A research report with named data sheets is required." }, { status: 400 });
    }
    // Issue #308: store the canonical copy FIRST — every channel
    // delivers the stored report, never the request in memory.
    const wtitle = (typeof body.title === "string" ? body.title : "Research report").replace(/[\r\n]/g, " ").slice(0, 120);
    const wuserLogin = request.headers.get("x-user-login") || sessionId;
    const reportBodyJson = canonicalResearchWebhookBody({
      title: wtitle,
      query: typeof body.query === "string" ? body.query : "",
      sheets: body.sheets,
    });
    const stored = await ctx.storeResearchReportCanonicalAsync(reportBodyJson, {
      title: wtitle,
      summary: `Research report: ${wtitle} (${body.sheets.length} sheets)`,
      userLogin: wuserLogin,
    });
    if (!stored) {
      return Response.json({ error: "The report could not be stored; dispatch aborted." }, { status: 500 });
    }
    if (ctx.getReportDispatchHitl()) {
      // Issue #277: hold for human confirmation instead of dispatching.
      // Issue #308: the pending row references the stored report id;
      // payload_json carries delivery metadata only (no report bytes).
      const confirmationId = ctx.createReportConfirmation(
        "webhook",
        JSON.stringify({ title: wtitle, query: typeof body.query === "string" ? body.query : "", sheetCount: body.sheets.length }),
        stored.reportId,
        wuserLogin
      );
      ctx.audit("research_report.pending_confirmation", "trading", {
        confirmationId,
        sheets: body.sheets.length,
        reportId: stored.reportId,
      });
      return Response.json({ success: true, status: "pending_confirmation", confirmationId });
    }
    const userLogin = request.headers.get("x-user-login") || sessionId;
    const delivered = await ctx.deliverStoredReportWebhook(stored.reportId, userLogin);
    if (delivered.outcome === "missing") {
      return Response.json({ error: "The stored report is unavailable; dispatch aborted." }, { status: 500 });
    }
    const result = delivered.result!;
    if (!result.success) {
      const status = result.notConfigured ? 503 : 502;
      return Response.json({ error: result.error || `Webhook returned HTTP ${result.status}.` }, { status });
    }
    ctx.audit("research_report.webhook_dispatched", "trading", { status: result.status, sheets: body.sheets.length, reportId: stored.reportId });
    return Response.json({ success: true, status: result.status });
  }

  // Issue #1169 S4-1: one-off semantic-index backfill for canonical
  // rows stored before their write-time hook existed, or written by
  // call sites without bindings at call time (optionsServeRecord's
  // recordOptionsOrchestratorRun, screeningRuntime, bundle rows).
  // Session-gated: the x-user-login header is set by server.ts from
  // the verified session (same gate as the knowledge-corpus route).
  // Paginated ({limit, offset}); re-runnable — re-upserts the same
  // `report:<id>` vector ids, so no duplicates. Skips `retention`.
  // NOT /api/reports/*, deliberately: the /api/reports/<id> detail
  // regex would swallow a same-shaped path (slice 0's 404-first fix).
  if (path.endsWith("/trading/reports/index-backfill") && request.method === "POST") {
    const login = request.headers.get("x-user-login") || "";
    if (!login) return unauthenticatedResponse();
    const body = (await request.json().catch(() => ({}))) as {
      limit?: number;
      offset?: number;
    };
    const limit = Math.min(500, Math.max(1, Math.floor(Number(body.limit) || 100)));
    const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
    try {
      // Issue #1169 S4-4: the page logic lives in
      // runCanonicalIndexBackfillPage (reportSemanticIndex.ts),
      // shared with the sweep below — this handler only parses
      // limit/offset and returns the page result as-is.
      const page = await runCanonicalIndexBackfillPage(
        ctx.env,
        ctx.ensureTables(),
        { limit, offset }
      );
      return Response.json(page);
    } catch (err) {
      return Response.json(
        { error: `Index backfill failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      );
    }
  }

  // Issue #3527 S4: the weekly canonical-index sweep — the full
  // backfill (runCanonicalIndexBackfillAll) as the reports
  // workflow's own scheduled job. Until S4 this sweep rode the
  // corpus sync (injected into runCorpusSync, gated by the corpus
  // marker); it is reports machinery, so it now has its own route,
  // its own tick rider (queue.ts, beside the corpus rider), and
  // its own weekly guard + durable marker
  // (reports_index_backfill_last_run in mas_settings, via the
  // screeningFlags settingRead/WriteFromSql idiom — the same
  // store the corpus marker uses). Fire/no-fire is decided here;
  // the dispatch is unconditional and skips are cheap and explicit.
  // The marker is written ONLY on a completed sweep: a throwing
  // sweep answers 500 (the paged route's shape) with no marker
  // write, so the next tick retries instead of waiting a week.
  // Session-gated exactly like the paged route above (the tick
  // dispatch carries the service identity via x-user-login).
  if (path.endsWith("/trading/reports/index-backfill-sweep") && request.method === "POST") {
    const login = request.headers.get("x-user-login") || "";
    if (!login) return unauthenticatedResponse();
    // Issue #3527 S5: every dispatch of this registered job —
    // fired, guard-skipped, or failed — records its outcome in
    // the system sink; only an actual run adds a #1333 run row.
    // Recording never changes the responses below.
    const traceId =
      parseTraceparent(request.headers.get("traceparent"))?.traceId ?? null;
    const sql = ctx.ensureTables();
    const decision = shouldFireReportsIndexBackfillTick(
      new Date(),
      settingReadFromSql(sql)(REPORTS_INDEX_BACKFILL_LAST_RUN_KEY)
    );
    if (!decision.fire) {
      await recordReportsBackfillOutcome(ctx, sessionId, {
        outcome: "skipped",
        traceId,
        reason: decision.reason,
      });
      return Response.json({
        success: true,
        skipped: true,
        reason: decision.reason,
        lastFiredAt: decision.lastFiredAt,
      });
    }
    const ranAt = new Date().toISOString();
    try {
      const outcome = await runCanonicalIndexBackfillAll(ctx.env, sql);
      settingWriteFromSql(sql)(REPORTS_INDEX_BACKFILL_LAST_RUN_KEY, ranAt);
      await recordReportsBackfillOutcome(ctx, sessionId, {
        outcome: "ran",
        traceId,
      });
      recordReportsBackfillRun(ctx, request, sql, {
        ranAt,
        status: "completed",
        outcome,
      });
      return Response.json({ success: true, ...outcome, ranAt });
    } catch (err) {
      const fromErr = sanitizeScheduledJobErrorCode(
        (err as { code?: unknown } | null)?.code
      );
      const errorCode =
        fromErr !== "unknown" ? fromErr : REPORTS_BACKFILL_FAILED_CODE;
      await recordReportsBackfillOutcome(ctx, sessionId, {
        outcome: "failed",
        traceId,
        errorCode,
      });
      recordReportsBackfillRun(ctx, request, sql, {
        ranAt,
        status: "failed",
        codedError: errorCode,
      });
      return Response.json(
        { error: `Index backfill sweep failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      );
    }
  }

  // Issue #341: watchlist & rejected-ideas browser — the §8 outputs of
  // every stored research run, flattened with provenance and filterable
  // by kind, rejected-gate code, and symbol search. Sourced entirely
  // from the stored canonical reports; nothing is recomputed.
  if (path.endsWith("/reports/research/browse") && request.method === "GET") {
    try {
      const { listScheduledReports } = await import("../../services/scheduledReports");
      const { extractResearchBrowseEntries, researchBrowseGates } = await import("../../services/researchBrowse");
      const headerLogin = request.headers.get("x-user-login");
      const userLogin = headerLogin && headerLogin.trim() ? headerLogin : undefined;
      const reports = listScheduledReports(ctx.ensureTables(), {
        userLogin,
        sourceFilter: "research_report",
        limit: 100,
      });
      const allEntries = extractResearchBrowseEntries(reports);
      const gates = researchBrowseGates(allEntries);
      let entries = allEntries;
      const kind = url.searchParams.get("kind");
      if (kind === "watchlist" || kind === "rejected") {
        entries = entries.filter((e) => e.kind === kind);
      }
      const gate = url.searchParams.get("gate");
      if (gate) {
        entries = entries.filter((e) => e.gate === gate);
      }
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (q) {
        entries = entries.filter((e) => e.symbol.toLowerCase().includes(q));
      }
      return Response.json({
        count: entries.length,
        gates,
        entries,
      });
    } catch {
      return Response.json({ error: "Failed to load research browse" }, { status: 500 });
    }
  }

  // Issue #2534: Run Details read surface. GET /api/runs/details
  // returns the traceability model for one run (request, provenance,
  // lineage, stage trace, why-no-data reasons) built from the same
  // merged Runs rows the Docs list reads — never a second divergent
  // copy, never a new run, never a record. Scoping matches /api/runs:
  // canonical rows use the header login or stay unscoped, scan /
  // discovery stores use the header login only.
  if (path.endsWith("/runs/details") && request.method === "GET") {
    try {
      const wanted = (url.searchParams.get("runId") || url.searchParams.get("id") || "").trim();
      if (!wanted) return Response.json({ error: "runId is required" }, { status: 400 });
      const headerLogin = request.headers.get("x-user-login");
      const reportLogin = headerLogin && headerLogin.trim() ? headerLogin : undefined;
      const sql = ctx.ensureTables();
      const { listScheduledReports, ensureScheduledReportsTable, resolveCanonicalReportBodyWithBackfill } = await import("../../services/scheduledReports");
      const { runSummaryFromReport, runSummaryFromScanRun, runSummaryFromDiscoveryRun, mergeRunSummaries } = await import("../../services/runSummaries");
      const { buildRunDetail } = await import("../../services/runDetails");
      ensureScheduledReportsTable(sql);
      const hits = listScheduledReports(sql, { userLogin: reportLogin, limit: 100 });
      const reportEnv = (ctx as any).env || {};
      const resolved = await Promise.all(
        hits.map(async (h) => ({ ...h, body: (await resolveCanonicalReportBodyWithBackfill(sql, reportEnv, h)) ?? "" })),
      );
      const lists: RunSummary[][] = [resolved.map(runSummaryFromReport)];
      const bodies = new Map<string, unknown>();
      for (const h of resolved) bodies.set(h.id, h.body);
      if (reportLogin) {
        try {
          const { createOptionsDiscoveryPorts } = await import("../../data/createOptionsDiscoveryPorts");
          const ports = createOptionsDiscoveryPorts({ sql });
          lists.push((await ports.scanRuns.list({ limit: 100, userLogin: reportLogin })).map(runSummaryFromScanRun));
          lists.push((await ports.discoveryRuns.list({ limit: 100, userLogin: reportLogin })).map(runSummaryFromDiscoveryRun));
        } catch {
          // Scan/discovery detail is best-effort; the canonical row
          // still yields a detail with those fields unknown.
        }
      }
      const merged = mergeRunSummaries(lists, 100);
      const summary = merged.find((r) => r.runId === wanted || r.id === wanted);
      if (!summary) return Response.json({ error: "run not found" }, { status: 404 });
      const body = summary.reportId ? bodies.get(summary.reportId) : undefined;
      return Response.json({ detail: buildRunDetail({ ...summary, body }) });
    } catch (err: any) {
      return Response.json({ error: err?.message || "Failed to load run details" }, { status: 500 });
    }
  }

  // Issue #1057 (consolidation S5): the one Runs read surface. Merges
  // run summaries from all four run stores (mas_reports,
  // mas_opportunity_scans, mas_discovery_runs, and the ScreenerAgent
  // latest/history feed) into the single normalized shape defined in
  // src/services/runSummaries.ts — newest first, de-duplicated on the
  // exact canonical joins (the canonical row wins). Scoping matches
  // each store's own route: canonical reports use the header login or
  // stay unscoped; the scan/discovery stores use the header login; the
  // screener feed uses header or execution context. Issue #1185: there
  // is no synthetic fallback identity — when no identity is available
  // for a store, that store is skipped and the skip is named in
  // storeErrors. A store that fails to read is likewise named in
  // storeErrors — never silently presented as empty.
  if (path.endsWith("/runs") && request.method === "GET") {
    try {
      const { parseRunsListKind } = await import("../../trading");
      const kindResult = parseRunsListKind(url.searchParams.get("kind") || "all");
      if (!kindResult.ok) {
        return Response.json({ error: kindResult.error, runs: [] }, { status: 400 });
      }
      const kind = kindResult.value;
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 100));
      const headerLogin = request.headers.get("x-user-login");
      const reportLogin = headerLogin && headerLogin.trim() ? headerLogin : undefined;
      // Issue #1185: identity-scoped stores read under the header login
      // only; without one they are skipped and named in storeErrors.
      const storeLogin = reportLogin;
      const sql = ctx.ensureTables();
      const lists: RunSummary[][] = [];
      const storeErrors: Record<string, string> = {};
      const readStore = async (name: string, read: () => Promise<RunSummary[]>) => {
        try {
          const rows = await read();
          lists.push(kind === "all" ? rows : rows.filter((row) => row.kind === kind));
        } catch (err: any) {
          storeErrors[name] = err?.message || String(err);
        }
      };
      if (kind === "all" || kind === "screener" || kind === "options_scanner" || kind === "goal") {
        await readStore("reports", async () => {
          const { listScheduledReports, ensureScheduledReportsTable, resolveCanonicalReportBodyWithBackfill } = await import("../../services/scheduledReports");
          const { runSummaryFromReport } = await import("../../services/runSummaries");
          ensureScheduledReportsTable(sql);
          const hits = listScheduledReports(sql, { userLogin: reportLogin, limit });
          // Issue #338 S2+S4: run summaries read body fields (pdfKey,
          // reportUrl) — resolve every row's body first; pointer rows
          // read from R2, inline rows serve inline and backfill.
          const reportEnv = (ctx as any).env || {};
          const resolved = await Promise.all(
            hits.map(async (h) => ({
              ...h,
              body: (await resolveCanonicalReportBodyWithBackfill(sql, reportEnv, h)) ?? "",
            }))
          );
          return resolved.map(runSummaryFromReport);
        });
      }
      if (kind === "all" || kind === "options_scanner") {
        if (!storeLogin) {
          storeErrors["scans"] = "skipped: no authenticated user identity available to scope the read";
        } else {
          await readStore("scans", async () => {
            const { createOptionsDiscoveryPorts } = await import("../../data/createOptionsDiscoveryPorts");
            const { runSummaryFromScanRun } = await import("../../services/runSummaries");
            const scans = await createOptionsDiscoveryPorts({ sql }).scanRuns.list({ limit, userLogin: storeLogin });
            return scans.map(runSummaryFromScanRun);
          });
        }
      }
      if (kind === "all" || kind === "discovery") {
        if (!storeLogin) {
          storeErrors["discovery"] = "skipped: no authenticated user identity available to scope the read";
        } else {
          await readStore("discovery", async () => {
            const { createOptionsDiscoveryPorts } = await import("../../data/createOptionsDiscoveryPorts");
            const { runSummaryFromDiscoveryRun } = await import("../../services/runSummaries");
            const runs = await createOptionsDiscoveryPorts({ sql }).discoveryRuns.list({ limit, userLogin: storeLogin });
            return runs.map(runSummaryFromDiscoveryRun);
          });
        }
      }
      if (kind === "all" || kind === "screener") {
        await readStore("screener", async () => {
          const { runSummaryFromScreenerRun } = await import("../../services/runSummaries");
          const context = await ctx.getScreenerExecutionContext();
          const screenerLogin = headerLogin || context?.userLogin;
          if (!screenerLogin) {
            // Issue #1185: named skip — surfaced via storeErrors by readStore.
            throw new Error("skipped: no authenticated user identity available to scope the read");
          }
          const agent = ctx.getScreenerAgent(screenerLogin);
          const history = await agent.getHistory();
          return history.map(runSummaryFromScreenerRun);
        });
      }
      const { mergeRunSummaries } = await import("../../services/runSummaries");
      const merged = mergeRunSummaries(lists, limit);
      return Response.json({
        count: merged.length,
        kind,
        runs: merged,
        ...(Object.keys(storeErrors).length ? { storeErrors } : {}),
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list runs", runs: [] }, { status: 500 });
    }
  }

  // Issue #339: one stored report by id for the Reports-tab detail view
  // (research run detail renders the canonical body client-side). The
  // attachment payload of email-delivery bodies is stripped — the detail
  // view needs metadata, not a base64 PDF. Owner scoping matches the
  // list (#584 EP-003).
  const reportDetailMatch = path.match(/\/api\/reports\/([^/]+)$/);
  // #2120 slice 0: "semantic-search" is a route, not a report id. Without
  // this exclusion the detail regex matches it first and 404s, so the
  // semantic-search branch below never runs.
  if (reportDetailMatch && reportDetailMatch[1] !== "semantic-search" && request.method === "GET") {
    try {
      const { getScheduledReportById, scheduledReportPdfUrl, resolveCanonicalReportBodyWithBackfill } = await import("../../services/scheduledReports");
      const headerLogin = request.headers.get("x-user-login");
      const userLogin = headerLogin && headerLogin.trim() ? headerLogin : undefined;
      const hit = getScheduledReportById(ctx.ensureTables(), decodeURIComponent(reportDetailMatch[1]), { userLogin });
      if (!hit) {
        return Response.json({ error: "Report not found" }, { status: 404 });
      }
      // Issue #338 S2: the canonical body may live in R2 behind the
      // body_r2_key pointer — resolve it before parsing (inline rows
      // resolve to themselves; a lost object resolves to null and the
      // detail view renders body: null, as for an unparseable body).
      const reportEnv = (ctx as any).env || {};
      const bodyText = (await resolveCanonicalReportBodyWithBackfill(ctx.ensureTables(), reportEnv, hit)) ?? "";
      let body: unknown = null;
      let hasAttachment = false;
      try {
        const parsed = JSON.parse(bodyText);
        if (parsed && typeof parsed === "object" && typeof (parsed as any).attachmentBase64 === "string" && (parsed as any).attachmentBase64) {
          hasAttachment = true;
          body = { ...(parsed as Record<string, unknown>), attachmentBase64: "" };
        } else {
          body = parsed;
        }
      } catch {
        body = null;
      }
      return Response.json({
        id: hit.id,
        runId: hit.runId,
        title: hit.title,
        source: hit.source,
        summary: hit.summary,
        createdAt: hit.createdAt,
        reportUrl: scheduledReportPdfUrl(hit.source, bodyText),
        hasAttachment,
        body,
      });
    } catch {
      return Response.json({ error: "Failed to load report" }, { status: 500 });
    }
  }

  // List persisted reports (issue #309). Queries mas_reports (populated by #278, #308).
  // Supports ?q=search query and ?source=screener|options_scanner|iv_collection
  if ((path.endsWith("/reports") || path === "/reports" || path === "/api/reports") && request.method === "GET") {
    try {
      const { searchScheduledReports, listScheduledReports, ensureScheduledReportsTable, scheduledReportPdfUrl } = await import("../../services/scheduledReports");
      const query = url.searchParams.get("q") || "";
      const sourceFilter = url.searchParams.get("source") || undefined;
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100));
      // #584 EP-003: tenant scoping from the caller's login. No header →
      // undefined → legacy unfiltered behavior (identity strings are not
      // yet unified; see scheduledReports.ts).
      const headerLogin = request.headers.get("x-user-login");
      const userLogin = headerLogin && headerLogin.trim() ? headerLogin : undefined;

      ensureScheduledReportsTable(ctx.ensureTables());

      let reports: any[];
      if (query.trim()) {
        // Search with query (user-scoped)
        reports = searchScheduledReports(ctx.ensureTables(), query, limit, { userLogin });
      } else {
        // List all (user-scoped), newest first
        // Note: mas_reports has no report_url column (see #307 R2 discussion).
        // The PDF URL is constructed from the runId via /api/screener/report.pdf
        reports = listScheduledReports(ctx.ensureTables(), { userLogin, sourceFilter, limit });
      }

      // Apply source filter to search results (search doesn't support it natively)
      if (sourceFilter && query.trim()) {
        reports = reports.filter((r: any) => r.source === sourceFilter);
      }

      // #638: surface the generated PDF's download URL when the stored
      // canonical body carries one. The PDF itself stays in
      // ScreenerAgent storage behind the report.pdf endpoints
      // (#269/#361); mas_reports has no URL column (#307).
      return Response.json({
        count: reports.length,
        reports: reports.map((r: any) => ({
          id: r.id,
          runId: r.runId,
          title: r.title,
          source: r.source,
          summary: r.summary,
          createdAt: r.createdAt,
          reportUrl: scheduledReportPdfUrl(r.source, r.body),
        })),
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list reports", reports: [] }, { status: 500 });
    }
  }

  // Issue #2863: report replay from persisted data only.
  // POST /api/reports/replay { reportId?, runId?, symbol? }.
  // A replay is NOT a run: it reads one canonical row (plus
  // its R2 body) and returns the persisted report with replay
  // provenance — zero live re-fetch, no re-charge (the handler
  // never touches any payment/monetization path, starts no
  // workflow, and writes no new canonical report). Loud
  // failures only: unknown/missing row -> 404, unavailable
  // body -> 500, unreplayable body -> 422. Never a fabricated
  // report. Lookup keys, in order: reportId (exact canonical
  // row id, owner-scoped), runId (stored run_id, owner-scoped
  // — the key RunDetailView knows: screener:<timestamp>),
  // symbol (newest stored research report for that symbol,
  // the key the Research Report subtab knows).
  if (path.endsWith("/reports/replay") && request.method === "POST") {
    const login = request.headers.get("x-user-login") || "";
    if (!login) return unauthenticatedResponse();
    const userLogin = login.trim();
    const body = (await request.json().catch(() => ({}))) as {
      reportId?: unknown;
      runId?: unknown;
      generationId?: unknown;
      symbol?: unknown;
    };
    const reportId = typeof body.reportId === "string" ? body.reportId.trim() : "";
    const runId =
      typeof body.runId === "string"
        ? body.runId.trim()
        : typeof body.generationId === "string"
          ? body.generationId.trim()
          : "";
    const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
    if (!reportId && !runId && !symbol) {
      return Response.json(
        { error: "Replay requires reportId, runId, or symbol." },
        { status: 400 },
      );
    }
    try {
      const {
        getScheduledReportById,
        getScheduledReportByRunId,
        listScheduledReports,
        resolveCanonicalReportBody,
      } = await import("../../services/scheduledReports");
      const { buildReplayFromRecord } = await import("../../workflows/reportReplay");
      const sql = ctx.ensureTables();
      let hit: ScheduledReportHit | null = null;
      if (reportId) {
        hit = getScheduledReportById(sql, reportId, { userLogin });
      } else if (runId) {
        hit = getScheduledReportByRunId(sql, runId, { userLogin });
      } else {
        // Newest stored research report for the symbol: resolve
        // bodies newest-first until one names the symbol.
        const rows = listScheduledReports(sql, {
          userLogin,
          sourceFilter: "research_report",
          limit: 100,
        });
        for (const row of rows) {
          const rowBody = await resolveCanonicalReportBody(ctx.env ?? {}, row);
          if (!rowBody) continue;
          try {
            const parsed = JSON.parse(rowBody) as { symbol?: unknown };
            if (typeof parsed.symbol === "string" && parsed.symbol.toLowerCase() === symbol.toLowerCase()) {
              hit = row;
              break;
            }
          } catch {
            continue;
          }
        }
      }
      if (!hit) {
        return Response.json(
          { error: "Report not found or not owned by the caller." },
          { status: 404 },
        );
      }
      const bodyJson = await resolveCanonicalReportBody(ctx.env ?? {}, hit);
      if (!bodyJson) {
        return Response.json(
          { error: "Persisted report body is unavailable." },
          { status: 500 },
        );
      }
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(bodyJson);
      } catch {
        return Response.json(
          { error: "Persisted report body is not valid JSON." },
          { status: 500 },
        );
      }
      let replay: unknown;
      try {
        replay = buildReplayFromRecord({
          id: hit.id,
          runId: hit.runId,
          source: hit.source,
          body: parsedBody,
          userLogin,
        });
      } catch (replayErr) {
        const message = replayErr instanceof Error ? replayErr.message : String(replayErr);
        const status = message.startsWith("not replayable") ? 422 : 500;
        return Response.json({ error: message }, { status });
      }
      ctx.audit("report.replayed", "orchestrator", {
        reportId: hit.id,
        runId: hit.runId,
        userLogin,
        partial: (replay as { partial?: boolean }).partial ?? false,
      });
      return Response.json({ replay });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to replay report." },
        { status: 500 },
      );
    }
  }

  // Issue #649: semantic search over reports (Vectorize).
  // Reachability (#2120 slice 0): the /api/reports/<id> detail branch
  // above explicitly skips id "semantic-search", so this branch runs
  // for the panel's semantic-search path. env arrives via
  // ReportsRouteContext from the orchestrator mount; the {} fallback
  // keeps lexical-only when the bindings are absent.
  if (path.endsWith("/reports/semantic-search") && request.method === "GET") {
    try {
      const { semanticSearchReports, mergeSearchHits } = await import("../../services/reportSemanticIndex");
      const { searchScheduledReports, ensureScheduledReportsTable } = await import("../../services/scheduledReports");
      const query = url.searchParams.get("q") || "";
      if (!query.trim()) {
        return Response.json({ hits: [], semantic: false });
      }
      const env = ctx.env || {};
      const semantic = await semanticSearchReports(env, query, 8);
      // Merge with lexical for the hybrid ranking.
      const lexical = searchScheduledReports(ctx.ensureTables(), query, 20).map((r: any) => String(r.id));
      const merged = mergeSearchHits(lexical, semantic);
      ensureScheduledReportsTable(ctx.ensureTables());
      return Response.json({
        hits: merged,
        semantic: semantic.length > 0,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Semantic search failed", hits: [] }, { status: 500 });
    }
  }

  return null;
}
