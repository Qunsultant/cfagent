/**
 * Issue #359-16: task schedule management routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the contiguous schedules block (invoked at the EXACT original
 * position in routeRequest's sequential matching sequence, after the
 * screener + research delegation and before routeRequest's Not-found
 * fallthrough):
 *   GET         /schedules                        (list; ?type=cron|interval|delayed|scheduled)
 *   POST        /schedules/cancel                 (cancel by id)
 *   DELETE      /schedules/:id                    (cancel by id)
 *   GET         /schedules/:id                    (get by id)
 *   POST        /schedules/create                 (create; #111 callback allow-list)
 *   POST        /schedules                        (create alias)
 *   POST        /schedules/trigger-screen
 *   POST        /schedules/trigger-renew
 *   POST        /schedules/trigger-options-analysis
 *   POST        /schedules/trigger-retention      (issue #255)
 *   POST        /schedules/record-cron-dispatch    (issue #3121 S5 — Worker cron dispatch ledger row)
 *   POST        /schedules/runs/record             (issue #3121 Phase 2 #3123 — ledger record route)
 *   POST        /schedules/trigger-iv-collection  (issue #15)
 *   POST        /schedules/trigger-discovery      (issue #126)
 *   POST        /schedules/:id/pause               (issue #273)
 *   POST        /schedules/:id/resume              (issue #273)
 *   POST        /schedules/:id/trigger             (issue #273)
 *   PUT         /schedules/:id                     (issue #273)
 *   GET         /schedules/approvals               (issue #3122 — list pending agent-schedule approvals)
 *   POST        /schedules/approvals/:id/approve   (issue #3122 — PDP-checked approve + arm)
 *   POST        /schedules/approvals/:id/reject    (issue #3122 — PDP-checked reject)
 *
 * The handler ends with an explicit `return null` - never undefined.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * SchedulesRouteContext parameter; there are no new globals and no
 * back-references into the class. The Agents SDK scheduler methods stay
 * owned by the Agent base class and arrive as narrow wrappers (the
 * `as keyof this` assertion pattern from the #109 NLQ scheduling port).
 * The #111 callback allow-list constants stay module-owned by
 * orchestrator.ts (CREATABLE_SCHEDULE_CALLBACKS is a public export) and
 * arrive via the context.
 */

import type { AgentContext, Schedule, ScheduleCriteria } from "agents";
import { resolveEnvironmentConfig } from "../../config/environment";
import { getStoredTokens, isTokenExpiredEt, etradeIdentityFromLogin } from "../../security/etradeOAuth";
import {
  BROKER_DISPLAY_NAMES,
  isBrokerId,
  resolveTenantProviders,
} from "../../services/tenantProviders";
import { tradingTypeFor } from "../../trading";
import { isLoginShaped, getServiceUserLogin } from "../../security/serviceIdentity";
import { findDuplicateSchedule } from "../../services/scheduleDedupe";
import {
  buildScheduleProvenance,
  stampScheduleProvenance,
} from "../../services/consolidatedScheduling";
import { runStorageRetention } from "../../security/storageRetention";
import { verifyStoredAuditChainAndAlert } from "../../services/auditTamperAlert";
import { createBlobStore } from "../../services/blobStoreR2Adapter";
import { pruneJobOutcomes } from "../../services/jobOutcomes";
import { SqlJobRunRecordStore } from "../../data/doSqliteJobRunRecordAdapter";
import { recordScheduleCallbackRun } from "../orchestrator/scheduleCallbackRunRecords";
import {
  buildSnapshotManifest,
  ORPHAN_SWEEP_PREFIX,
  planOrphanSweep,
  resolveOrphanSweepDelete,
  resolveSnapshotEnabled,
  SNAPSHOT_ROW_LIMIT,
  snapshotObjectKey,
} from "../../data/retention1766";
import {
  buildSchedulePayload,
  validateStrategyRequest,
} from "../../trading";
import {
  buildOptionsDiscoveryPorts,
  createOptionsDiscoveryPorts,
} from "../../data/createOptionsDiscoveryPorts";
import { ScheduledTasksService } from "../../services/scheduledTasks";
import { pickFeedLoadParams } from "../../services/feedSnapshotStore";
import {
  deleteUnifiedSchedule,
  getUnifiedScheduleDetail,
  listUnifiedScheduleItems,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
  screenScheduleToRecord,
  tickerPushRecordToListItem,
  triggerUnifiedSchedule,
  unifiedRecordToListItem,
  updateUnifiedSchedule,
  type ScheduleAlarms,
  type ScheduleAlarmLike,
} from "../../services/unifiedScheduleManagement";
import {
  TICKER_INSTANCE_NAME,
  resolveTickerPushStaleAfterIntervals,
} from "../ticker-agent";
import { actorGateway } from "../../services/cloudflareActorGateway";
import type { TickerPushRecordStub } from "../../services/actorGatewayPorts";
import { createUnifiedSchedulePorts } from "../../data/createUnifiedSchedulePorts";
import { recordLedgerRun } from "../../services/unifiedLedger";
import { buildJobRunRecord, type JobRunRecordInput } from "../../services/jobRunRecords";
import { resolveActorAttribution } from "../../security/backgroundAttribution";
import type { DatabaseORM } from "../../orm";
import type { AgentName, AgentScheduleItem, Env } from "../../types";
import {
  adoptAgentSdkScheduleRecord,
  agentScheduleProvenance,
  createAgentScheduleExecutorDepsForDo,
  createAgentSchedulePdpDeps,
  decidePendingScheduleApproval,
  evaluateAgentSchedulePdp,
  executeAgentScheduleAction,
  removeAgentSdkScheduleRecord,
  resolvePendingScheduleApproval,
  type AgentScheduleActionResult,
  type AgentSdkScheduleAdapter,
  type AgentSdkTiming,
  type AgentWorkflowStageScheduleAdapter,
} from "../../services/agentScheduleCapability";
import {
  createWorkflowStageScheduleAdapter,
  validateWorkflowStageScheduleInput,
  type WorkflowStageRegistry,
} from "../../services/workflowStageSchedule";
import { getScheduledAgentDoor } from "../orchestrator/meshDoors";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { scheduleWebhookFollowupBodySchema } from "../../api/ingressSchemas";
import {
  buildScheduleWebhookFollowupSubmission,
  buildScheduleWebhookMintRecord,
  SCHEDULE_WEBHOOK_AUDIT_EVENTS,
} from "../../services/scheduleWebhookFollowup";
import { createPendingScheduleApprovalPort } from "../../data/doSqlitePendingScheduleApprovalsAdapter";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { handleCronDispatchRecordRoute } from "./cronDispatchRecord";
import { RECORDED_SCHEDULE_CALLBACKS } from "../orchestrator/scheduleCallbacks";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/schedules",
});

/** Structural mirror of OrchestratorAgent's private ETradeEnvironment
 * (src/agents/orchestrator.ts). */
type ETradeEnvironment = "TEST" | "PROD";

/** Structural mirror of OrchestratorAgent's private ScreenerExecutionContext
 * (src/agents/orchestrator.ts). */
type ScreenerExecutionContext = { userLogin: string; environment?: ETradeEnvironment };

/** The subset of OrchestratorAgent surface the schedules handlers need. */
export interface SchedulesRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** Durable Object agent context (owner: OrchestratorAgent - was `this.ctx`),
   * used for the SqlStorage-backed stores. */
  agentCtx: AgentContext;
  /** Audit funnel (owner: OrchestratorAgent.audit - was `this.audit`). */
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** SDK schedule listing (owner: Agent base class - was `this.listSchedules`). */
  listSchedules(criteria?: ScheduleCriteria): Promise<Schedule<unknown>[]>;
  /** SDK schedule cancellation (owner: Agent base class - was `this.cancelSchedule`). */
  cancelSchedule(id: string): Promise<boolean>;
  /** SDK schedule lookup (owner: Agent base class - was `this.getScheduleById`). */
  getScheduleById(id: string): Promise<Schedule<unknown> | undefined>;
  /** SDK scheduler (owner: Agent base class - was `this.schedule`). */
  schedule(
    when: Date | string | number,
    callback: string,
    payload?: unknown,
    options?: { idempotent?: boolean }
  ): Promise<Schedule<unknown>>;
  /** SDK interval scheduler (owner: Agent base class - was `this.scheduleEvery`). */
  scheduleEvery(
    intervalSeconds: number,
    callback: string,
    payload?: unknown
  ): Promise<Schedule<unknown>>;
  /** Execution-context accessor (owner: OrchestratorAgent.getScreenerExecutionContext - was `this.getScreenerExecutionContext`). */
  getScreenerExecutionContext(): Promise<ScreenerExecutionContext | undefined>;
  /** ORM accessor (owner: OrchestratorAgent.getOrm - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Issue #1123 S5b: follow-up bridge for screener runs triggered
   *  through the schedule routes (optional — hosts without it keep
   *  the service's event-bus behavior). */
  scheduleScreenerFollowups?: (
    outcome: import("../../services/screenerFollowups").ScreenerRunOutcome,
    userLogin: string,
    chainReport?: boolean,
  ) => Promise<void>;
  /** Issue #1574: submit an opt-in options shard chain on existing async-job rails. */
  submitShardJob?: (spec: import("../../types").AsyncJobSubmission) => Promise<{ jobId: string; status: "queued"; statusUrl: string }>;
  /** Consolidation #1236 (feed seam): submit an async job (owner:
   *  OrchestratorAgent.submitAsyncJob). Used by the feed-snapshot
   *  route; hosts without it cannot submit feed jobs. */
  submitAsyncJob?: (spec: import("../../types").AsyncJobSubmission) => Promise<{ jobId: string; status: "queued"; statusUrl: string }>;
  /** Scheduled market screen (owner: OrchestratorAgent.autonomousMarketScreen - was `this.autonomousMarketScreen`). */
  autonomousMarketScreen(payload?: {
    sector?: string;
    universe?: string;
    maxItems?: number;
    broadcast?: boolean;
    trigger?: "manual" | "scheduled";
    userLogin?: string;
    environment?: ETradeEnvironment;
    emailTo?: string;
    slackChannel?: string;
    webhookUrl?: string;
    pushToSlack?: boolean;
    filters?: import("../../types").StockScreenerFilter;
    provider?: import("../../trading").StockScreenProvider;
    stageChain?: import("../../types").StageChainConfig;
  }): Promise<void>;
  /** E*TRADE token renewal (owner: OrchestratorAgent.autoRenewETradeTokens - was `this.autoRenewETradeTokens`). */
  autoRenewETradeTokens(payload?: { userLogin?: string; env?: string }): Promise<void>;
  /** #111 user-creatable callback allow-list (owner: orchestrator.ts module const CREATABLE_SCHEDULE_CALLBACKS). */
  creatableScheduleCallbacks: readonly string[];
  /** Account-scoped callback set (owner: orchestrator.ts module const ACCOUNT_SCOPED_SCHEDULE_CALLBACKS). */
  accountScopedScheduleCallbacks: ReadonlySet<string>;
  /** Manual dispatch of a schedule's own callback (owner: OrchestratorAgent — a dynamic this[callback] invocation), used by POST /schedules/:id/trigger (#273). */
  runScheduleCallback(callback: string, payload: unknown): Promise<void>;
}

/**
 * Issue #1170 (E3): the runScheduleCallback closure that used to be
 * built inline in OrchestratorAgent.routeRequest's schedules
 * context now lives here with the routes it serves (the #992
 * extraction pattern — this is what keeps orchestrator.ts inside
 * its size budget as new dispatch blocks land). Behaviour is
 * identical to the inline closure: resolve the named method on the
 * host, refuse non-callables with the same error, invoke with the
 * host as `this`.
 */
export function makeRunScheduleCallback(
  host: unknown
): SchedulesRouteContext["runScheduleCallback"] {
  return async (callback: string, payload: unknown) => {
    const fn = (host as Record<string, unknown>)[callback];
    if (typeof fn !== "function") {
      throw new Error(`Schedule callback '${callback}' is not callable on the orchestrator.`);
    }
    await (fn as (p: unknown) => Promise<void>).call(host, payload);
  };
}

/**
 * Issue #3121 #3310 — the one alarms-port construction for the
 * unified management service: the SDK scheduler surface
 * (list/get/cancel/arm) over the class's Agent methods. The routes
 * and the A2A capability instance share it, so the two never drift
 * into different arming behavior.
 */
export function makeScheduleAlarmsPort(
  scheduling: Pick<
    SchedulesRouteContext,
    "listSchedules" | "getScheduleById" | "cancelSchedule" | "schedule" | "scheduleEvery"
  >,
): ScheduleAlarms {
  return {
    list: () =>
      scheduling
        .listSchedules()
        .then((s) => s as unknown as ScheduleAlarmLike[]),
    get: (id) =>
      scheduling
        .getScheduleById(id)
        .then((s) => (s ? (s as unknown as ScheduleAlarmLike) : undefined)),
    cancel: (id) => scheduling.cancelSchedule(id),
    arm: (timing, callback, payload) => {
      if (timing.type === "cron")
        return scheduling
          .schedule(timing.cron, callback, payload, { idempotent: true })
          .then((s) => s as unknown as ScheduleAlarmLike);
      if (timing.type === "interval")
        return scheduling
          .scheduleEvery(timing.intervalSeconds, callback, payload)
          .then((s) => s as unknown as ScheduleAlarmLike);
      return scheduling
        .schedule(new Date(timing.time * 1000), callback, payload)
        .then((s) => s as unknown as ScheduleAlarmLike);
    },
  };
}

/**
 * Task schedule management routes. Invoked from routeRequest at the exact
 * position the original block occupied (after the
 * handleScreenerResearchRoutes delegation, before the Not-found
 * fallthrough); returns a Response when one of the owned paths matches, or
 * null to continue sequential matching.
 */
/**
 * Issue #4004 follow-up — which identity a schedule-creation request acts
 * as. The header is the Worker-established identity for this request and
 * wins whenever it is usable; the per-instance screener context is the
 * fallback for callers that carry no identity, never an override of one.
 * A context login such as an agent identity ("openaimp") therefore cannot
 * shadow the signed-in owner and send the credential lookup to the wrong
 * connection (the stale connection has no stored credential for the owner).
 */
type ScheduleEnv = "TEST" | "PROD";

export function resolveTrustedScheduleIdentity(input: {
  headerLogin: string | null | undefined;
  headerEnvironment: string;
  context?: { userLogin?: string; environment?: ScheduleEnv } | null;
  configuredEnvironment: ScheduleEnv;
}): { userLogin: string; environment: ScheduleEnv } {
  const headerLogin = isLoginShaped(input.headerLogin) ? input.headerLogin : "";
  const headerEnv =
    input.headerEnvironment === "TEST" || input.headerEnvironment === "PROD"
      ? (input.headerEnvironment as ScheduleEnv)
      : undefined;
  return {
    userLogin: headerLogin || input.context?.userLogin || "",
    environment: headerEnv || input.context?.environment || input.configuredEnvironment,
  };
}

/**
 * Issue #3121 #4237 — the ticker-push row for the Schedules home
 * list. The record lives in the TickerAgent's own store (ADR 0029
 * D-0), so the list reads it through the typed RPC and appends its
 * list item (interval + last push + derived health). Best-effort:
 * an unbound namespace, a failed RPC, a null record, or a record of
 * another kind omits the row and logs a warning — the list never
 * fails because the live feed cannot be reached. The health
 * threshold resolves from env here, never on the client.
 */
export async function readTickerPushListItem(
  env: Env,
): Promise<ReturnType<typeof tickerPushRecordToListItem> | null> {
  try {
    const stub = actorGateway.stub<TickerPushRecordStub>(
      env.TICKER_AGENT,
      TICKER_INSTANCE_NAME,
    );
    const record = await stub.getTickerPushRecord();
    if (!record || record.kind !== "ticker-push") return null;
    return tickerPushRecordToListItem(
      record,
      Date.now(),
      resolveTickerPushStaleAfterIntervals(env),
    );
  } catch (err) {
    structuredLog.warn("schedules.ticker_push_read_failed", {
      message: "[Schedules] ticker-push list read failed; the row is omitted:",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function handleSchedulesRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: SchedulesRouteContext
): Promise<Response | null> {
    // Issue #3121 Phase 2 (#3123): the one schedule store — the
    // unified DO-SQLite `unified_schedules` table — and the one
    // management path behind every route in this file. Subpath ids
    // come from the /schedules/<id>/<action> shape via regex (not a
    // counted route condition).
    const unifiedStore = () =>
      createUnifiedSchedulePorts({
        sql: ctx.agentCtx.storage.sql,
        storage: ctx.agentCtx.storage,
      }).unifiedSchedulesSync;
    const alarms: ScheduleAlarms = makeScheduleAlarmsPort(ctx);
    const subpathId = (p: string): string => {
      const m = p.match(/\/schedules\/([^/]+)\//);
      if (!m) return "";
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    };

    // Issue #3311 — webhook-triggered scheduling: a workflow step
    // calls POST /schedules/webhook/followup (via the HMAC edge in
    // src/server/routes/scheduleWebhook.ts) and the scheduler mints a
    // scheduled follow-up job/sub-job on the async-job chain. The
    // branch sits FIRST: no other branch may swallow this path.
    //
    // Order: edge-marker gate (a call that did not pass the edge is
    // refused — the DO never mints on an unauthenticated forward) →
    // trusted identity (the header the edge stamped from the verified
    // body, never a caller header) → zod re-validation (the edge
    // already validated; the DO never trusts the forwarder blindly) →
    // PDP via #3122's evaluateAgentSchedulePdp (task:create; proceeds
    // when PDP is disabled, exactly as #3122 does) → capability
    // allow-list + submission build (the service module throws a
    // business error) → the one submitAsyncJob minter → the mint
    // ledger row (best-effort: a failed write is audited, never
    // breaks the mint) → both audits (call + mint).
    //
    // The follow-up fires under the chain's own guards (not-before,
    // claim, retry-once, recovery bounds) — no new firing path, no
    // T4 semantics change. Approval gate: none here — the caller is
    // a workflow executing the owner's already-authorized pipeline,
    // not an agent proposing a new consequential action (recorded in
    // #3311 for owner amendment at review).
    if (path.endsWith("/schedules/webhook/followup") && request.method === "POST") {
      try {
        if (request.headers.get("x-schedule-webhook") !== "1") {
          return Response.json(
            { error: "Schedule webhook calls must arrive through the authenticated webhook edge." },
            { status: 401 },
          );
        }
        const context = await ctx.getScreenerExecutionContext();
        const trusted = resolveTrustedScheduleIdentity({
          headerLogin: request.headers.get("x-user-login") || "",
          headerEnvironment: (request.headers.get("x-environment") || "").toUpperCase(),
          context,
          configuredEnvironment: resolveEnvironmentConfig(ctx.env).name as ScheduleEnv,
        });
        if (!trusted.userLogin) {
          return Response.json({ error: "An authenticated user identity is required for a schedule webhook follow-up." }, { status: 401 });
        }
        const userLogin = trusted.userLogin;
        const rawBody = (await request.json().catch(() => null)) as unknown;
        const shaped = scheduleWebhookFollowupBodySchema.safeParse(rawBody);
        if (!shaped.success) {
          ctx.audit(SCHEDULE_WEBHOOK_AUDIT_EVENTS.denied, "orchestrator", {
            userLogin,
            workflowId: (rawBody as Record<string, unknown> | null)?.workflowId ?? null,
            reason: "webhook body failed validation",
          });
          return Response.json({ error: "Webhook body is invalid." }, { status: 400 });
        }
        const validBody = shaped.data;
        ctx.audit(SCHEDULE_WEBHOOK_AUDIT_EVENTS.received, "orchestrator", {
          userLogin,
          workflowId: validBody.workflowId,
          scheduleId: validBody.scheduleId ?? null,
          capability: validBody.capability,
          runAt: validBody.runAt,
        });
        const pdp = await evaluateAgentSchedulePdp(createAgentSchedulePdpDeps(ctx.env), {
          principal: { login: userLogin, agentId: "schedule-webhook" },
          tenantId: resolveIaaaTenant(ctx.env),
          action: "create",
          nowMs: Date.now(),
        });
        if (pdp.enforced && !pdp.allowed) {
          ctx.audit(SCHEDULE_WEBHOOK_AUDIT_EVENTS.denied, "orchestrator", {
            userLogin,
            workflowId: validBody.workflowId,
            scheduleId: validBody.scheduleId ?? null,
            capability: validBody.capability,
            reason: pdp.reason ?? "PDP denied",
          });
          return Response.json({ error: "This webhook caller is not authorized to mint a schedule follow-up." }, { status: 403 });
        }
        let submission: import("../../types").AsyncJobSubmission;
        try {
          submission = buildScheduleWebhookFollowupSubmission(validBody);
        } catch (err) {
          ctx.audit(SCHEDULE_WEBHOOK_AUDIT_EVENTS.denied, "orchestrator", {
            userLogin,
            workflowId: validBody.workflowId,
            scheduleId: validBody.scheduleId ?? null,
            capability: validBody.capability,
            reason: err instanceof Error ? err.message : String(err),
          });
          return Response.json({ error: err instanceof Error ? err.message : "Follow-up could not be built." }, { status: 400 });
        }
        if (!ctx.submitAsyncJob) {
          return Response.json({ error: "Follow-up submission is not wired on this host." }, { status: 500 });
        }
        const submitted = await ctx.submitAsyncJob(submission);
        const nowIso = new Date().toISOString();
        try {
          recordLedgerRun(new SqlJobRunRecordStore(ctx.agentCtx.storage.sql), {
            system: "orchestrator-schedule",
            ...buildScheduleWebhookMintRecord({ jobId: submitted.jobId, body: validBody, nowIso }),
          });
        } catch (err) {
          // Recording never breaks the mint — but a swallowed store
          // failure is unobservable, so it is audited instead.
          ctx.audit(SCHEDULE_WEBHOOK_AUDIT_EVENTS.mintLedgerFailed, "orchestrator", {
            userLogin,
            workflowId: validBody.workflowId,
            jobId: submitted.jobId,
            error: err instanceof Error ? err.message : String(err),
          });
          structuredLog.warn("schedules.webhook_mint_ledger_failed", {
            message: "[Schedules] schedule webhook mint ledger write failed:",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        ctx.audit(SCHEDULE_WEBHOOK_AUDIT_EVENTS.minted, "orchestrator", {
          userLogin,
          workflowId: validBody.workflowId,
          scheduleId: validBody.scheduleId ?? null,
          capability: validBody.capability,
          runAt: validBody.runAt,
          jobId: submitted.jobId,
        });
        return Response.json({
          ...submitted,
          capability: validBody.capability,
          runAt: validBody.runAt,
          workflowId: validBody.workflowId,
          scheduleId: validBody.scheduleId ?? null,
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to mint schedule webhook follow-up" }, { status: 500 });
      }
    }
    // Issue #3121 #3310 — the stages adapter over the one
    // management service: the registry read goes through the
    // ScheduledAgent door (a job with no definition reads null —
    // the adapter names the refusal); the trigger firing dispatches
    // through the class's runScheduleCallback, whose runWorkflowStage
    // method records its own run, so no second recording here.
    const workflowStageAdapter = (): AgentWorkflowStageScheduleAdapter => {
      const registry: WorkflowStageRegistry = {
        getDefinition: async (jobId) => {
          try {
            const door = getScheduledAgentDoor(ctx.env);
            const view = await door.getPipelineJobStatus(jobId);
            return view.definition ?? null;
          } catch {
            return null;
          }
        },
      };
      return createWorkflowStageScheduleAdapter({
        store: unifiedStore(),
        alarms,
        registry,
        runCallback: (callback, payload) => ctx.runScheduleCallback(callback, payload),
        nowIso: () => new Date().toISOString(),
      });
    };

    // List all schedules (supports ?type=cron|interval|delayed|scheduled)
    if ((path.endsWith("/schedules") || path.endsWith("/api/schedules") || path === "/schedules" || path === "/api/schedules") && request.method === "GET") {
      try {
        // Issue #108: the typed listSchedules() is called directly. The
        // old fallback chain (listSchedules → scheduler.list → deprecated
        // getSchedules → 200 with an empty list) is deleted: it masked a
        // broken scheduling binding as "you have no schedules" (audit
        // finding F14). A failure now surfaces as the 500 below.
        const typeParam = url.searchParams.get("type");
        const items = await listUnifiedScheduleItems(
          { store: unifiedStore(), alarms },
          typeParam ?? undefined,
        );
        // Issue #3121 #4237 — the ticker-push row is not in this
        // store (it lives in the TickerAgent); append it when the
        // feed answers, under the same ?type= filter as the rest.
        const tickerItem = await readTickerPushListItem(ctx.env);
        if (tickerItem && (!typeParam || tickerItem.type === typeParam)) {
          items.push(tickerItem);
        }
        return Response.json({
          count: items.length,
          schedules: items,
          creatableCallbacks: [...ctx.creatableScheduleCallbacks],
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to list schedules", schedules: [] }, { status: 500 });
      }
    }

    // Cancel a schedule by ID (POST /api/schedules/cancel or DELETE /api/schedules/:id)
    if (
      ((path.endsWith("/schedules/cancel") || path.includes("/schedules/cancel/")) && request.method === "POST") ||
      (path.includes("/schedules/") && request.method === "DELETE")
    ) {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const scheduleId =
          body.scheduleId ||
          body.id ||
          url.searchParams.get("id") ||
          path.split("/schedules/cancel/")[1] ||
          path.split("/schedules/")[1] ||
          "";

        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        const deleted = await deleteUnifiedSchedule({ store: unifiedStore(), alarms }, scheduleId);
        const cancelled = deleted.cancelled;
        ctx.audit("schedule.cancelled", "orchestrator", { scheduleId, success: cancelled });
        return Response.json({ scheduleId, cancelled });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to cancel schedule" }, { status: 500 });
      }
    }

    // Issue #3122 — pending-approval decisions for agent schedules.
    // GET /api/schedules/approvals lists pending approvals (the queue
    // the approval UI reads, #4142); POST
    // /api/schedules/approvals/:id/approve arms the recorded
    // definition through the capability (the approver is PDP-checked
    // for action:approve; the arming runs under the ORIGINAL
    // requester's principal with the approval as its gate-skip
    // token); /reject records the rejection and arms nothing. A
    // failed arming leaves the approval pending, so the approver can
    // retry once the cause is fixed.
    if (request.method === "GET" && (path.endsWith("/schedules/approvals") || path.endsWith("/api/schedules/approvals"))) {
      try {
        const port = createPendingScheduleApprovalPort(ctx.agentCtx.storage.sql);
        const approvals = (await port.load()).filter((entry) => entry.status === "pending");
        return Response.json({ count: approvals.length, approvals });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to list pending approvals" }, { status: 500 });
      }
    }
    const approvalsMatch = path.match(/\/schedules\/approvals\/([^/]+)\/(approve|reject)$/);
    if (request.method === "POST" && approvalsMatch) {
      const approvalId = (() => {
        try {
          return decodeURIComponent(approvalsMatch[1]);
        } catch {
          return approvalsMatch[1];
        }
      })();
      const decision = approvalsMatch[2] as "approve" | "reject";
      try {
        const context = await ctx.getScreenerExecutionContext();
        const trusted = resolveTrustedScheduleIdentity({
          headerLogin: request.headers.get("x-user-login") || "",
          headerEnvironment: (request.headers.get("x-environment") || "").toUpperCase(),
          context,
          configuredEnvironment: resolveEnvironmentConfig(ctx.env).name as ScheduleEnv,
        });
        if (!trusted.userLogin) {
          return Response.json({ error: "An authenticated user identity is required to decide a schedule approval." }, { status: 401 });
        }
        // PDP: the approver needs action:approve in the tenant scope.
        const pdp = await evaluateAgentSchedulePdp(createAgentSchedulePdpDeps(ctx.env), {
          principal: { login: trusted.userLogin, agentId: "schedule-approvals-api" },
          tenantId: resolveIaaaTenant(ctx.env),
          action: "approve",
          nowMs: Date.now(),
        });
        if (pdp.enforced && !pdp.allowed) {
          return Response.json({ error: `Approval denied by policy: ${pdp.reason ?? "action:approve not granted"}` }, { status: 403 });
        }
        const port = createPendingScheduleApprovalPort(ctx.agentCtx.storage.sql);
        const entry = resolvePendingScheduleApproval(await port.load(), approvalId);
        if (!entry) {
          return Response.json({ error: `Pending approval '${approvalId}' was not found.` }, { status: 404 });
        }
        if (entry.status !== "pending") {
          return Response.json({ error: `Pending approval '${approvalId}' is already decided (${entry.status}).` }, { status: 409 });
        }
        const nowIso = new Date().toISOString();
        if (decision === "reject") {
          await port.save(decidePendingScheduleApproval(await port.load(), approvalId, "rejected", trusted.userLogin, nowIso));
          ctx.audit("agent.schedule.approval-rejected", "orchestrator", { pendingApprovalId: approvalId, decidedBy: trusted.userLogin, kind: entry.kind });
          return Response.json({ approvalId, status: "rejected" });
        }
        // Approve: arm the recorded definition through the capability
        // under the original requester's principal. A goal definition
        // cannot arm from this DO (goals live in the ScheduledAgent
        // DO) — it is decided on the goal endpoint instead. A
        // stage-schedule arms through the stages adapter (the
        // unified store + the alarms port + the door registry read).
        if (entry.kind === "goal") {
          return Response.json({ error: `Pending approval '${approvalId}' is a goal approval; decide it at POST /api/schedule/goals/approvals/${approvalId}/approve.` }, { status: 409 });
        }
        const def = entry.definition as Record<string, unknown>;
        const principal = { login: entry.requestedBy, agentId: entry.agentId };
        const tenantId = resolveIaaaTenant(ctx.env);
        if (entry.kind === "workflow-stage") {
          const capabilityDeps = createAgentScheduleExecutorDepsForDo(
            ctx.env,
            ctx.agentCtx.storage.sql,
            (type, payload) => ctx.audit(type, "orchestrator", payload),
            { stages: workflowStageAdapter() },
          );
          let armedStage: AgentScheduleActionResult;
          if (def.jobId !== undefined) {
            armedStage = await executeAgentScheduleAction(capabilityDeps, {
              action: "create",
              kind: "workflow-stage",
              principal,
              tenantId,
              jobId: String(def.jobId),
              nodePath: String(def.nodePath),
              timing: def.timing as AgentSdkTiming,
              ...(typeof def.reason === "string" ? { reason: def.reason } : {}),
              approvedPendingId: approvalId,
            });
          } else {
            armedStage = await executeAgentScheduleAction(capabilityDeps, {
              action: "update",
              kind: "workflow-stage",
              principal,
              tenantId,
              scheduleId: String(def.scheduleId),
              ...(def.timing !== undefined ? { timing: def.timing as AgentSdkTiming } : {}),
              ...(typeof def.reason === "string" ? { reason: def.reason } : {}),
              approvedPendingId: approvalId,
            });
          }
          if (!armedStage.ok) {
            return Response.json({ error: `Approval could not be armed: ${armedStage.reason}` }, { status: 502 });
          }
          await port.save(decidePendingScheduleApproval(await port.load(), approvalId, "approved", trusted.userLogin, nowIso));
          ctx.audit("agent.schedule.approval-approved", "orchestrator", { pendingApprovalId: approvalId, decidedBy: trusted.userLogin, kind: entry.kind, scheduleId: armedStage.scheduleId });
          return Response.json({ approvalId, status: "approved", scheduleId: armedStage.scheduleId });
        }
        const toItem = (s: unknown): AgentScheduleItem => s as unknown as AgentScheduleItem;
        const sdkAdapter: AgentSdkScheduleAdapter = {
          list: async () => (await ctx.listSchedules()).map(toItem),
          get: async (id) => {
            const found = await ctx.getScheduleById(id);
            return found === undefined ? undefined : toItem(found);
          },
          create: async ({ timing, callback, payload }) => {
            let armed: AgentScheduleItem;
            if (timing.type === "cron") armed = toItem(await ctx.schedule(timing.cron, callback, payload, { idempotent: true }));
            else if (timing.type === "interval") armed = toItem(await ctx.scheduleEvery(timing.intervalSeconds, callback, payload));
            else if (timing.type === "scheduled") armed = toItem(await ctx.schedule(new Date(timing.time * 1000), callback, payload));
            else armed = toItem(await ctx.schedule(timing.delayInSeconds, callback, payload));
            // Issue #3122 (store integration, #3123): the approved arming
            // adopts its record into the unified store (record id = alarm
            // id), so an approved schedule lives in the one store.
            await adoptAgentSdkScheduleRecord(unifiedStore(), armed, new Date().toISOString());
            return armed;
          },
          cancel: async (id) => {
            const cancelled = await ctx.cancelSchedule(id);
            if (cancelled) await removeAgentSdkScheduleRecord(unifiedStore(), id);
            return cancelled;
          },
        };
        const capabilityDeps = createAgentScheduleExecutorDepsForDo(
          ctx.env,
          ctx.agentCtx.storage.sql,
          (type, payload) => ctx.audit(type, "orchestrator", payload),
          { sdk: sdkAdapter },
        );
        let armed: AgentScheduleActionResult;
        if (def.callback !== undefined) {
          armed = await executeAgentScheduleAction(capabilityDeps, {
            action: "create",
            kind: "sdk",
            principal,
            tenantId,
            callback: String(def.callback),
            timing: def.timing as AgentSdkTiming,
            ...(def.payload !== undefined ? { payload: def.payload } : {}),
            approvedPendingId: approvalId,
          });
        } else {
          armed = await executeAgentScheduleAction(capabilityDeps, {
            action: "update",
            kind: "sdk",
            principal,
            tenantId,
            scheduleId: String(def.scheduleId),
            ...(def.timing !== undefined ? { timing: def.timing as AgentSdkTiming } : {}),
            ...(def.payload !== undefined ? { payload: def.payload } : {}),
            approvedPendingId: approvalId,
          });
        }
        if (!armed.ok) {
          return Response.json({ error: `Approval could not be armed: ${armed.reason}` }, { status: 502 });
        }
        await port.save(decidePendingScheduleApproval(await port.load(), approvalId, "approved", trusted.userLogin, nowIso));
        ctx.audit("agent.schedule.approval-approved", "orchestrator", { pendingApprovalId: approvalId, decidedBy: trusted.userLogin, kind: entry.kind, scheduleId: armed.scheduleId });
        return Response.json({ approvalId, status: "approved", scheduleId: armed.scheduleId });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to decide the schedule approval" }, { status: 500 });
      }
    }

    // Cancel ALL schedules on this instance (POST /api/schedules/cancel-all).
    // Issue #2280: the post-reset queue wipe mechanism — one endpoint for
    // the whole framework queue instead of one cancel per id. The list
    // covers every cf_agents_jobs row owned by this agent: user schedules
    // AND executeAsyncJob rows share the scheduler capability (verified
    // against agents SDK 0.24.0: JobQueue.list filters by capability, and
    // async jobs are scheduled through the same ctx.schedule API), so
    // cancelling each listed id empties the queue; the next alarm then
    // finds nothing due and the SDK deletes the alarm (rearmAlarm),
    // which stops the loop. Paused schedules are NOT queue rows (already
    // cancelled at SDK level) — their resume records in the paused store
    // are preserved, counted in the response, and never deleted here.
    // Fail-closed: without { confirm: true } this returns the preview
    // (what would be cancelled) and cancels nothing.
    if (path.endsWith("/schedules/cancel-all") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const schedules = await ctx.listSchedules();
        const preview = schedules.map((s) => ({ id: s.id, callback: s.callback }));
        let pausedPreserved = 0;
        try {
          pausedPreserved = unifiedStore().listByState("paused").length;
        } catch {
          pausedPreserved = 0;
        }
        if (body.confirm !== true) {
          return Response.json({
            cancelled: 0,
            confirmRequired: true,
            wouldCancel: preview,
            wouldCancelCount: preview.length,
            pausedPreserved,
          });
        }
        const cancelledIds: string[] = [];
        const failed: Array<{ id: string; error: string }> = [];
        for (const item of preview) {
          try {
            const ok = await ctx.cancelSchedule(item.id);
            if (ok) cancelledIds.push(item.id);
            else failed.push({ id: item.id, error: "not found" });
          } catch (err: any) {
            failed.push({ id: item.id, error: err.message || "cancel failed" });
          }
        }
        ctx.audit("schedules.cancelled.all", "orchestrator", {
          cancelledCount: cancelledIds.length,
          cancelledIds,
          failedCount: failed.length,
          pausedPreserved,
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
          cancelled: cancelledIds.length,
          cancelledIds,
          failed,
          pausedPreserved,
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to cancel all schedules" }, { status: 500 });
      }
    }

    // Issue #2964 — per-run job records + the creatable-callback
    // catalog for the unified Jobs UI. These MUST be matched BEFORE
    // the get-by-id block below: /schedules/abc/runs would otherwise
    // misparse "runs" as the id and 404, and /schedules/callbacks
    // would misparse "callbacks" as the id.
    if (path === "/schedules/runs" && request.method === "GET") {
      try {
        const params = new URL(request.url).searchParams;
        const scheduleId = params.get("scheduleId") || undefined;
        const limit = Number(params.get("limit") || 50);
        const store = new SqlJobRunRecordStore(ctx.agentCtx.storage.sql);
        const runs = scheduleId ? store.listByJob(scheduleId, limit) : store.listRecent(limit);
        return Response.json({ ok: true, runs });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to list job runs" }, { status: 500 });
      }
    }
    const scheduleRunsMatch = path.match(/^\/schedules\/([^/]+)\/runs$/);
    if (scheduleRunsMatch && request.method === "GET") {
      try {
        const limit = Number(new URL(request.url).searchParams.get("limit") || 50);
        const store = new SqlJobRunRecordStore(ctx.agentCtx.storage.sql);
        return Response.json({ ok: true, runs: store.listByJob(scheduleRunsMatch[1], limit) });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to list job runs" }, { status: 500 });
      }
    }

    // Issue #3121 Phase 2 (#3123) — ledger record route. The
    // ScheduledAgent posts goal rows to the one physical ledger
    // (this instance's job_run_records) through this background-
    // gated route (same gate as record-cron-dispatch, §12 of the
    // S5 design). Placed here, next to the runs reads: no earlier
    // branch can swallow it — the earlier POST branches match only
    // `/schedules/cancel`, `/schedules/cancel-all`, the
    // `/:id/pause|resume|trigger` suffixes, `/schedules/create`,
    // `/schedules` exactly, or the other `trigger-*` suffixes —
    // and the generic `/schedules/` branches above are GET, DELETE,
    // or PUT, never POST. Body: a full JobRunRecord. A malformed
    // shape is 400 (the validator is the build); a store failure
    // is 500. The record itself goes through the one entry.
    if (path.endsWith("/schedules/runs/record") && request.method === "POST") {
      const attribution = resolveActorAttribution(
        request.headers,
        getServiceUserLogin(ctx.env),
      );
      if (attribution.actorKind !== "background") {
        return Response.json(
          { success: false, error: "Background service dispatch required." },
          { status: 401 },
        );
      }
      const body = (await request.json().catch(() => null)) as unknown;
      if (!body || typeof body !== "object") {
        return Response.json({ success: false, error: "Invalid ledger record." }, { status: 400 });
      }
      try {
        buildJobRunRecord(body as JobRunRecordInput);
      } catch (err) {
        return Response.json(
          { success: false, error: err instanceof Error ? err.message : "Invalid ledger record." },
          { status: 400 },
        );
      }
      try {
        const store = new SqlJobRunRecordStore(ctx.agentCtx.storage.sql);
        const built = recordLedgerRun(store, body as JobRunRecordInput);
        return Response.json({ success: true, jobId: built.jobId, scheduleId: built.scheduleId ?? null });
      } catch (err) {
        return Response.json(
          { success: false, error: err instanceof Error ? err.message : "Failed to record ledger run." },
          { status: 500 },
        );
      }
    }
    if (path === "/schedules/callbacks" && request.method === "GET") {
      return Response.json({ ok: true, callbacks: ctx.creatableScheduleCallbacks });
    }

    // Get specific schedule by ID (GET /api/schedules/:id)
    if (path.includes("/schedules/") && request.method === "GET") {
      try {
        const scheduleId = path.split("/schedules/").pop() || "";
        const detail = await getUnifiedScheduleDetail({ store: unifiedStore(), alarms }, scheduleId);
        if (!detail.ok) {
          return Response.json({ error: detail.error }, { status: detail.status });
        }
        return Response.json(detail.detail);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to get schedule" }, { status: 500 });
      }
    }

    // Pause a schedule (POST /api/schedules/:id/pause) — issue #273.
    // The SDK schedule is cancelled, but its definition and state
    // live in the unified store as a paused record, so the job stays
    // listed (status: paused) and can be resumed or edited in place.
    if (path.includes("/schedules/") && path.endsWith("/pause") && request.method === "POST") {
      try {
        const scheduleId = subpathId(path);
        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        const result = await pauseUnifiedSchedule({ store: unifiedStore(), alarms }, scheduleId, new Date().toISOString());
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: result.status });
        }
        ctx.audit("schedule.paused", "orchestrator", { scheduleId, callback: result.record.callback });
        return Response.json({ success: true, schedule: unifiedRecordToListItem(result.record) });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to pause schedule" }, { status: 500 });
      }
    }

    // Resume a paused schedule (POST /api/schedules/:id/resume) — #273.
    if (path.includes("/schedules/") && path.endsWith("/resume") && request.method === "POST") {
      try {
        const scheduleId = subpathId(path);
        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        const result = await resumeUnifiedSchedule({ store: unifiedStore(), alarms }, scheduleId, new Date().toISOString());
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: result.status });
        }
        ctx.audit("schedule.resumed", "orchestrator", { scheduleId, newScheduleId: result.alarm?.id, callback: result.record.callback });
        return Response.json({ success: true, previousId: result.previousId, schedule: result.alarm });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to resume schedule" }, { status: 500 });
      }
    }

    // Trigger a schedule's callback now (POST /api/schedules/:id/trigger) — #273.
    if (path.includes("/schedules/") && path.endsWith("/trigger") && request.method === "POST") {
      try {
        const scheduleId = subpathId(path);
        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        const result = await triggerUnifiedSchedule(
          { store: unifiedStore(), alarms },
          scheduleId,
          async (callback, payload) => {
            // Issue #2964: record the manual run. Callbacks whose method
            // wrapper records its own runs (the creatable four, plus the
            // four internal callbacks #3788 wrapped) record outcome-aware
            // runs themselves, so the route must not double-record them;
            // other callbacks have no wrapper, so the route records the
            // invocation itself (invocation-level success, since the
            // callback reports no outcome). Paused schedules refused
            // inside the service with 409 record nothing — no run happened.
            if ((RECORDED_SCHEDULE_CALLBACKS as readonly string[]).includes(callback)) {
              await ctx.runScheduleCallback(callback, payload);
            } else {
              await recordScheduleCallbackRun(
                ctx.agentCtx.storage.sql,
                callback,
                payload,
                { id: scheduleId },
                () => ctx.runScheduleCallback(callback, payload),
              );
            }
          },
        );
        if (!result.ok) {
          return Response.json(
            { success: false, error: result.error },
            { status: result.status },
          );
        }
        ctx.audit("schedule.triggered", "orchestrator", { scheduleId: result.scheduleId, callback: result.callback });
        return Response.json({ success: true, scheduleId: result.scheduleId, callback: result.callback });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger schedule" }, { status: 500 });
      }
    }

    // Update a schedule (PUT /api/schedules/:id) — issue #273: change
    // the cron/interval and/or payload atomically (cancel + recreate
    // under the hood; paused jobs update in place in the unified store).
    if (path.includes("/schedules/") && request.method === "PUT") {
      try {
        const scheduleId = path.split("/schedules/").pop() || "";
        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        const body = (await request.json().catch(() => ({}))) as any;
        const result = await updateUnifiedSchedule(
          { store: unifiedStore(), alarms },
          scheduleId,
          body,
          Date.now(),
        );
        if (!result.ok) {
          return Response.json({ success: false, error: result.error }, { status: result.status });
        }
        if (result.alarm) {
          ctx.audit("schedule.updated", "orchestrator", { scheduleId, newScheduleId: result.alarm.id, callback: result.record.callback });
          return Response.json({ success: true, previousId: result.previousId, schedule: result.alarm });
        }
        ctx.audit("schedule.updated", "orchestrator", { scheduleId, callback: result.record.callback, paused: true });
        return Response.json({ success: true, schedule: unifiedRecordToListItem(result.record) });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to update schedule" }, { status: 500 });
      }
    }

    // Create a stage-schedule (POST /api/schedules/workflow-stages) —
    // issue #3121 #3310: one pipeline job stage on its own schedule.
    // The REST create has no approval gate (the caller IS the human;
    // the gate is the agent path's, per #3122's design): session-gated,
    // registry-validated via the ScheduledAgent door, audited
    // `schedule.created`. Pause/resume/trigger/delete/detail/update/list
    // flow through the existing /:id/* routes via the management
    // service — no new routes for them.
    if (path.endsWith("/schedules/workflow-stages") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const context = await ctx.getScreenerExecutionContext();
        const trusted = resolveTrustedScheduleIdentity({
          headerLogin: request.headers.get("x-user-login") || "",
          headerEnvironment: (request.headers.get("x-environment") || "").toUpperCase(),
          context,
          configuredEnvironment: resolveEnvironmentConfig(ctx.env).name as ScheduleEnv,
        });
        if (!trusted.userLogin) {
          return Response.json({ error: "An authenticated user identity is required to create a stage-schedule." }, { status: 401 });
        }
        const validated = validateWorkflowStageScheduleInput({
          jobId: body.jobId,
          nodePath: body.nodePath,
          scheduleType: body.scheduleType,
          cron: body.cron,
          intervalSeconds: body.intervalSeconds,
          reason: body.reason,
        });
        if (!validated.ok) {
          return Response.json({ error: validated.error }, { status: 400 });
        }
        const def = validated.value;
        const created = await workflowStageAdapter().create({
          jobId: def.jobId,
          nodePath: def.nodePath,
          timing:
            def.type === "cron"
              ? { type: "cron", cron: def.cron as string }
              : { type: "interval", intervalSeconds: def.intervalSeconds as number },
          reason: body.reason,
          ownerLogin: trusted.userLogin,
          provenance: agentScheduleProvenance("schedules-api", trusted.userLogin),
        });
        ctx.audit("schedule.created", "orchestrator", {
          scheduleId: created.id,
          jobId: def.jobId,
          nodePath: def.nodePath,
          stageId: def.stageId,
          origin: "api",
        });
        return Response.json({ success: true, schedule: unifiedRecordToListItem(created) });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to create stage-schedule" }, { status: 500 });
      }
    }

    // Create a schedule (delayed, scheduled, cron, or interval)
    if ((path.endsWith("/schedules/create") || (path.endsWith("/schedules") && request.method === "POST"))) {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const { scheduleType, callback, payload, delayInSeconds, intervalSeconds, cron, date } = body;

        if (!callback) {
          return Response.json({ error: "Callback method name is required" }, { status: 400 });
        }

        // Callback allow-list (#111): this public route may only arm the
        // user-creatable callbacks in ctx.creatableScheduleCallbacks.
        // Anything else — including internal-only callbacks such as
        // executeAsyncJob and expireStaleOrderDraft — is rejected, and no
        // schedule is created.
        if (!(ctx.creatableScheduleCallbacks as readonly string[]).includes(callback)) {
          return Response.json(
            {
              success: false,
              error: `Callback '${callback}' is not allowed: POST /api/schedules/create only accepts ${ctx.creatableScheduleCallbacks.join(", ")}`,
            },
            { status: 400 }
          );
        }

        // Stamp screening schedules with the identity established by the
        // authenticated Worker forwarder. Never trust a caller-supplied
        // payload.userLogin to select another account's E*TRADE credentials.
        const context = await ctx.getScreenerExecutionContext();
        const headerUserLogin = request.headers.get("x-user-login") || "";
        const headerEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        // #4004 follow-up: the Worker-established header is THIS request's
        // verified identity; the stored screener context is per-instance
        // and can be stale (a previous login, or an agent identity such as
        // "openaimp"). Letting the context win made creation look for
        // credentials under the wrong connection and
        // refuse every schedule the signed-in owner tried to create.
        const trusted = resolveTrustedScheduleIdentity({
          headerLogin: headerUserLogin,
          headerEnvironment,
          context,
          configuredEnvironment: resolveEnvironmentConfig(ctx.env).name as ScheduleEnv,
        });
        const trustedUserLogin = trusted.userLogin;
        const trustedEnvironment = trusted.environment;
        if (ctx.accountScopedScheduleCallbacks.has(callback) && !trustedUserLogin) {
          return Response.json({ success: false, error: "An authenticated broker account is required to create screening schedules." }, { status: 401 });
        }
        // Issue #3655: the creation credential check follows the tenant
        // broker, not E*TRADE unconditionally. Broker etrade — or an
        // unreadable/unconfigured selection, preserving pre-#3655
        // behaviour — runs the existing E*TRADE token check below,
        // unchanged. Any other broker verifies that broker's
        // credentials via resolveScreenSelection; a missing credential
        // is a 409 NAMING THE BROKER, never E*TRADE. Broker + data
        // provider + mode are resolved here and stamped onto the
        // payload at build time (identity, never a form value).
        let createBrokerId: string | undefined;
        let createDataProviderId: string | undefined;
        let createMode: "live" | "paper" | undefined;
        if (ctx.accountScopedScheduleCallbacks.has(callback)) {
          const tenantProviders = await resolveTenantProviders(ctx.env);
          createDataProviderId = tenantProviders.dataProviderId;
          // Issue #3655: providerConnections is imported LAZILY, never
          // statically — it sits on a load cycle with the trading
          // barrel (providerConnections → ../trading →
          // unifiedOptionsService → providerConnections); a static
          // import here would bind unifiedOptionsService to the real
          // reader instead of a test's vi.mock of it.
          const { readTenantBrokerSelection } = await import("../../services/providerConnections");
          const brokerRead = await readTenantBrokerSelection(ctx.env);
          const brokerId = brokerRead.status === "ok" ? brokerRead.brokerId : "etrade";
          createBrokerId = brokerId;
          const createEnvironment = trustedEnvironment === "TEST" ? "TEST" : "PROD";
          createMode = tradingTypeFor(
            isBrokerId(brokerId) ? brokerId : "etrade",
            createEnvironment
          );
          if (brokerId === "etrade") {
            // Issue #2442 S3: the trusted login (Worker-forwarder
            // established, never caller-supplied) resolves to its session
            // identity via the alias record, so a token stored under an
            // internal-id or alias-login key passes the preflight exactly
            // as it passes the panel check. Unresolvable yields an empty
            // identity, keeping today's login-only lookup.
            const identity = await etradeIdentityFromLogin(ctx.env, trustedUserLogin);
            const storedTokens = await getStoredTokens(ctx.env, trustedUserLogin, trustedEnvironment, identity);
            if (!storedTokens || isTokenExpiredEt(storedTokens.storedAt)) {
              return Response.json({
                success: false,
                error: "Connect an E*TRADE account for this environment before creating an account-scoped schedule.",
              }, { status: 409 });
            }
          } else {
            // Issue #3655: lazy import — same cycle as the broker read
            // above; never a static import of providerConnections here.
            const { resolveScreenSelection } = await import("../../services/providerConnections");
            const selection = await resolveScreenSelection({
              env: ctx.env,
              userLogin: trustedUserLogin,
            });
            if (!selection.resolved) {
              const display = BROKER_DISPLAY_NAMES[brokerId] ?? brokerId;
              return Response.json({
                success: false,
                error: `Connect a ${display} account for this environment before creating an account-scoped schedule (${selection.code}: ${selection.error}).`,
              }, { status: 409 });
            }
          }
        }
        const { userLogin: _untrustedUserLogin, environment: _untrustedEnvironment, brokerId: _untrustedBrokerId, dataProviderId: _untrustedDataProviderId, mode: _untrustedMode, ...safePayload } =
          payload && typeof payload === "object" ? payload : {};
        // Issue #2373 (slice C): schedule-creation guard for
        // STOCK schedules, under monetization ON only. Stock
        // ticks cannot ride the payment workflow (chain /
        // monolithic execution, G7-rejected migration — see the
        // tick decision in src/services/scheduledTasks.ts), so a
        // one-off stock schedule can never checkout: claiming
        // one_off without authorization is a 400 (authorization
        // never given), and claiming one_off WITH authorization
        // is also a 400 with the honest explanation (no checkout
        // exists for it — run manually via the paid screen seam
        // or use a covered recurring schedule). An absent
        // scheduleKind is stamped "recurring" below (fail-closed
        // default, covering legacy schedules); the tick itself
        // also defaults absent → recurring. Goal callbacks are
        // NOT guarded here: goal ticks already handle one_off
        // via the payment-workflow seam. The guard validates on
        // the raw payload BEFORE buildSchedulePayload, because
        // the builder's strict criteria schema does not know
        // these fields and would reject them as unknown; the
        // fields are stripped from the builder input and stamped
        // back onto the stored payload after the build.
        let stampedScheduleKind: "one_off" | "recurring" | undefined;
        if (callback === "autonomousMarketScreen") {
          const monetizationOn = await (
            await import("../../features/createFeatureFlagPort")
          ).createFeatureFlagPort(ctx.env).isEnabled("monetization");
          if (monetizationOn) {
            const claimedKind = (safePayload as Record<string, unknown>).scheduleKind;
            const claimedAuth = (safePayload as Record<string, unknown>).authorizedAtSubmission;
            if (
              claimedKind !== undefined &&
              claimedKind !== "one_off" &&
              claimedKind !== "recurring"
            ) {
              return Response.json(
                { success: false, error: `Invalid scheduleKind '${String(claimedKind)}': expected "one_off" or "recurring".` },
                { status: 400 },
              );
            }
            if (claimedKind === "one_off" && claimedAuth !== true) {
              return Response.json(
                { success: false, error: "A one-off stock schedule requires authorizedAtSubmission: a one-off run may not claim authorization never given." },
                { status: 400 },
              );
            }
            if (claimedKind === "one_off") {
              return Response.json(
                { success: false, error: "One-off checkout is unavailable for scheduled stock screens: the chain/monolithic run cannot ride the payment workflow. Run it manually via the paid screen seam or use a covered recurring schedule." },
                { status: 400 },
              );
            }
            stampedScheduleKind = (claimedKind as "recurring" | undefined) ?? "recurring";
            delete (safePayload as Record<string, unknown>).scheduleKind;
            delete (safePayload as Record<string, unknown>).authorizedAtSubmission;
          }
        }
        // Issue #959 (screening consolidation S1): criteria validation
        // and payload assembly live in ONE shared builder —
        // buildSchedulePayload in src/trading/screeningSchemas.ts —
        // used identically by this route, the trigger routes below, and
        // the NLQ scheduling executor, so the same criteria arm the same
        // payload through every door. The builder reproduces this
        // route's historical checks and error strings (universe,
        // symbols, the three discovery input models, maxItems) and
        // stamps identity from the trusted context only.
        let screeningPayload: unknown;
        if (ctx.accountScopedScheduleCallbacks.has(callback)) {
          const built = buildSchedulePayload(callback, safePayload, {
            userLogin: trustedUserLogin || undefined,
            environment: trustedEnvironment || undefined,
            trigger: "scheduled",
            // Issue #3655: server-resolved broker + data provider +
            // mode ride the identity stamp (never a form value).
            ...(createBrokerId ? { brokerId: createBrokerId } : {}),
            ...(createDataProviderId ? { dataProviderId: createDataProviderId } : {}),
            ...(createMode ? { mode: createMode } : {}),
          });
          if (!built.ok) {
            return Response.json({ success: false, error: built.error }, { status: 400 });
          }
          // Creation policy (route-level, unchanged): a stock schedule
          // must name its universe explicitly. The shared builder
          // deliberately does not require one — the trigger and NLQ
          // paths rely on the market-screen service's own default.
          if (callback === "autonomousMarketScreen" && safePayload.universe === undefined) {
            return Response.json({ success: false, error: "Stock schedules require one explicit universe." }, { status: 400 });
          }
          screeningPayload = built.value;
        } else {
          screeningPayload = payload;
        }
        // Issue #2373 (slice C): stamp the guard-validated
        // scheduleKind onto the stored payload (fail-closed
        // default "recurring" when the creator claimed none), so
        // the tick reads the same kind the guard approved. Flag
        // OFF (stampedScheduleKind undefined) leaves the payload
        // exactly as today.
        if (
          stampedScheduleKind !== undefined &&
          typeof screeningPayload === "object" &&
          screeningPayload !== null
        ) {
          (screeningPayload as Record<string, unknown>).scheduleKind = stampedScheduleKind;
        }

        // No fabricated success (#111): this route never invents a
        // schedule id or reports success for a schedule that does not
        // exist. Issue #108: the calls below use the typed Agents SDK
        // API directly — schedule/scheduleEvery are typed members of
        // the Agent base class, so the old missing-method guard is
        // gone; if a typed call throws, the catch below returns the
        // same honest 503 {success:false} shape.
        // Issue #2071: creation is idempotent. A duplicate submit (double
        // click, retried request) returns the schedule that already exists
        // instead of arming a second identical one — interval schedules are
        // not idempotent at the SDK layer, which is how the page ended up
        // showing the same schedule twice.
        let duplicate: Schedule<unknown> | undefined;
        try {
          duplicate = findDuplicateSchedule(
            (await ctx.listSchedules()) as unknown as Record<string, any>[],
            callback,
            screeningPayload,
            { type: scheduleType, cron, intervalSeconds, delayInSeconds, date },
          ) as unknown as Schedule<unknown> | undefined;
        } catch {
          duplicate = undefined;
        }
        // Issue #3121 Phase 2 (#3123) — adoption: the armed alarm's
        // definition and state live in the unified store (record id =
        // the SDK alarm id; alarmId tracks the SDK-assigned id across
        // re-arms). Insert-if-absent: a record that already exists
        // (an idempotent re-arm, a duplicate) is never clobbered —
        // overwriting it would reset createdAt and the list order.
        // Best-effort: the alarm is armed either way — a failed
        // record write must not fail the creation, and the schedule
        // adopts a record when it is next touched.
        const adoptRecord = (armed: Schedule<unknown>) => {
          try {
            const store = unifiedStore();
            if (!store.get(armed.id)) {
              store.save(
                screenScheduleToRecord(
                  armed as unknown as ScheduleAlarmLike,
                  new Date().toISOString(),
                  trustedUserLogin || null,
                ),
              );
            }
          } catch {
            // Adoption failure is not a creation failure.
          }
        };
        if (duplicate) {
          adoptRecord(duplicate);
          ctx.audit("schedule.duplicate_suppressed", "orchestrator", {
            scheduleId: (duplicate as any).id,
            callback,
            scheduleType,
          });
          return Response.json({ success: true, schedule: duplicate, duplicate: true });
        }

        // Issue #3121 S1 — creation provenance travels in the stored
        // payload (#2366 items 3–4): origin user, the trusted creator
        // identity (null when none was established — recorded
        // explicitly, never invented), creation time. Stamped AFTER
        // the duplicate check, so the fresh timestamp cannot defeat
        // dedup; a payload that already carries provenance keeps its
        // original creation record. The SDK-owned table schema is
        // untouched — the payload is the app's JSON blob on the row.
        screeningPayload = stampScheduleProvenance(
          screeningPayload,
          buildScheduleProvenance({
            origin: "user",
            createdBy: trustedUserLogin || null,
          }),
        );

        let schedule: Schedule<unknown> | undefined;
        if (scheduleType === "interval" && intervalSeconds) {
          schedule = await ctx.scheduleEvery(Number(intervalSeconds), callback, screeningPayload);
        } else if (scheduleType === "cron" && cron) {
          schedule = await ctx.schedule(cron, callback, screeningPayload, { idempotent: body.idempotent !== false });
        } else if (scheduleType === "scheduled" && date) {
          schedule = await ctx.schedule(new Date(date), callback, screeningPayload);
        } else if (delayInSeconds !== undefined) {
          schedule = await ctx.schedule(Number(delayInSeconds), callback, screeningPayload);
        } else {
          return Response.json(
            { error: "Invalid schedule parameters: provide intervalSeconds, cron, date, or delayInSeconds" },
            { status: 400 }
          );
        }

        ctx.audit("schedule.created", "orchestrator", { scheduleId: schedule?.id, callback, scheduleType });
        if (schedule) adoptRecord(schedule);
        return Response.json({ success: true, schedule });
      } catch (err: any) {
        // A throwing SDK scheduling call created nothing, so it gets the
        // honest 503 {success:false, error} shape (#111), worded as what
        // it is — scheduling was unavailable and no schedule was created
        // — never a success response and never a fabricated id.
        return Response.json(
          { success: false, error: `Scheduling unavailable: ${err.message || "Failed to create schedule"}` },
          { status: 503 }
        );
      }
    }

    // Trigger autonomous market screen immediately on demand
    if (path.endsWith("/schedules/trigger-screen") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const userLogin = request.headers.get("x-user-login") || undefined;
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD" ? rawEnvironment : undefined;
        // Issue #959: trigger bodies validate through the same shared
        // schedule builder as schedule creation — identity keys in the
        // body are stripped and re-stamped from the trusted context.
        const { userLogin: _bodyLogin, environment: _bodyEnv, ...triggerCriteria } = body ?? {};
        const built = buildSchedulePayload("autonomousMarketScreen", triggerCriteria, { userLogin, environment, trigger: "manual" }, { applyCreationDefaults: false });
        if (!built.ok) {
          return Response.json({ success: false, error: built.error }, { status: 400 });
        }
        await ctx.autonomousMarketScreen(built.value);
        return Response.json({ success: true, message: "Autonomous market screen triggered" });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger market screen" }, { status: 500 });
      }
    }

    // Trigger E*TRADE token renewal immediately on demand
    if (path.endsWith("/schedules/trigger-renew") && request.method === "POST") {
      try {
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin;
        if (!userLogin) return Response.json({ success: false, error: "An authenticated broker account is required." }, { status: 401 });
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD" ? rawEnvironment : context?.environment;
        await ctx.autoRenewETradeTokens({ userLogin, env: environment });
        return Response.json({ success: true, message: "E*TRADE token renewal triggered" });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger token renewal" }, { status: 500 });
      }
    }

    // Trigger autonomous options analysis immediately on demand
    if (path.endsWith("/schedules/trigger-options-analysis") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin || "";
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD"
          ? rawEnvironment
          : context?.environment;
        const service = new ScheduledTasksService(ctx.env, ctx.getOrm(), userLogin, createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns, undefined, undefined, undefined, ctx.scheduleScreenerFollowups, { sql: ctx.agentCtx.storage.sql, blobStorage: ctx.agentCtx.storage, env: ctx.env }, ctx.submitShardJob, undefined, ctx.env.SCREENER_EVENTS ?? null);
        // Issue #959: validate through the shared schedule builder.
        const { userLogin: _bodyLogin, environment: _bodyEnv, ...triggerCriteria } = body ?? {};
        const built = buildSchedulePayload("autonomousOptionsAnalysis", triggerCriteria, { userLogin: userLogin || undefined, environment, trigger: "manual" }, { applyCreationDefaults: false });
        if (!built.ok) {
          return Response.json({ success: false, error: built.error }, { status: 400 });
        }
        const result = await service.autonomousOptionsAnalysis(built.value as any);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger options analysis" }, { status: 500 });
      }
    }

    // Issue #3121 S5 — Worker cron dispatch ledger row. The named
    // entry points report their dispatch through this background-
    // gated route (see `handleCronDispatchRecordRoute`). Placed
    // adjacent to the trigger-retention branch: no earlier branch
    // can swallow it — the earlier POST branches match only
    // `/schedules/cancel`, `/schedules/cancel-all`, the
    // `/:id/pause|resume|trigger` suffixes, `/schedules/create`,
    // `/schedules` exactly, or the other `trigger-*` suffixes —
    // and the generic `/schedules/` branches above are GET, DELETE,
    // or PUT, never POST.
    if (path.endsWith("/schedules/record-cron-dispatch") && request.method === "POST") {
      return handleCronDispatchRecordRoute(request, {
        env: ctx.env,
        sql: ctx.agentCtx.storage.sql,
      });
    }

    // Nightly retention pass (issue #255, part of #143; extended to
    // mas_events + mas_memory by issue #786). The Worker's scheduled()
    // handler fires this at the 0 4 * * * cron.
    // Issue #1766 rides the same pass (same precedent as the #2294
    // job-outcomes leg): a best-effort orphan sweep over the
    // reports/ prefix and a best-effort R2 snapshot export of
    // this instance's tables. Both legs are best-effort — a
    // context without raw SQL or a bucket (tests, older
    // callers) or a leg failure must never fail the pass
    // itself — and both write their own mas_events audit rows
    // so the pass's work is observable, not just logged.
    // Fail-closed guards: the sweep deletes NOTHING unless
    // RETENTION_ORPHAN_SWEEP_DELETE is exactly "true", and a
    // referenced-keys read failure skips planning entirely
    // (an unknown referenced set must never read as "every
    // object is orphaned"). The sweep runs on the shared
    // Orchestrator instance only; per-user instances are
    // covered by PITR, not by this leg (recorded in the
    // #1766 doc, not papered over).
    if (path.endsWith("/schedules/trigger-retention") && request.method === "POST") {
      try {
        // #3156 (Q7): verify the mas_events tamper chain BEFORE any
        // pruning. A failed verification records a loud, blocking
        // alert and SKIPS the storage-retention prune this run —
        // pruning a broken chain would destroy the evidence the
        // review needs. If the alert write itself fails, the run
        // returns 503 rather than silently continuing (a
        // deliberate exception to this route's best-effort
        // philosophy for job-outcome pruning: tamper-evidence
        // handling is not best-effort). The orphan sweep, snapshot
        // export, and job-outcome prune do not touch mas_events
        // and still run. Retention windows themselves are
        // unchanged by this slice.
        let auditChainVerification;
        try {
          auditChainVerification = verifyStoredAuditChainAndAlert(ctx.getOrm());
        } catch (err) {
          structuredLog.error("schedules.retention_tamper_alert_write_failed", {
            message: "[retention] tamper alert write failed; retention aborted:",
            error: err instanceof Error ? err.message : String(err),
          });
          return Response.json(
            { error: "Audit chain verification alert could not be recorded; retention aborted." },
            { status: 503 },
          );
        }
        const auditChainPruneSkipped = !auditChainVerification.valid;
        if (auditChainPruneSkipped) {
          structuredLog.error("schedules.retention_audit_chain_verification_failed", {
            message: `[retention] audit chain verification FAILED brokenIndex=${auditChainVerification.brokenIndex} reason=${auditChainVerification.reason}; storage-retention prune skipped, evidence preserved.`,
            brokenIndex: auditChainVerification.brokenIndex,
            reason: auditChainVerification.reason,
          });
        }
        const result = auditChainPruneSkipped
          ? { skipped: true, pruned: 0 }
          : runStorageRetention(ctx.getOrm(), {
              retentionDays: ctx.env.MAS_MESSAGES_RETENTION_DAYS,
              eventsRetentionDays: ctx.env.MAS_EVENTS_RETENTION_DAYS,
              memoryRetentionDays: ctx.env.MAS_MEMORY_RETENTION_DAYS,
            });
        // #2294: the outcome feed had no retention decision at all. Bound it
        // in the same nightly pass so history cannot grow into the read path.
        // Best-effort: a context without raw SQL (tests, older callers) or a
        // prune failure must never fail the retention pass itself.
        let jobOutcomes = { deletedByAge: 0, deletedByCap: 0, error: null as string | null };
        try {
          const sql = ctx.agentCtx.storage.sql;
          const pruned = pruneJobOutcomes(sql, {
            retentionDays: ctx.env.MAS_JOB_OUTCOMES_RETENTION_DAYS,
          });
          jobOutcomes = { ...pruned, error: null };
        } catch (err) {
          jobOutcomes.error = err instanceof Error ? err.message : String(err);
          structuredLog.warn("schedules.retention_job_outcomes_prune_failed", {
            message: "[retention] job outcomes prune failed:",
            error: jobOutcomes.error,
          });
        }
        const auditEvent = (type: string, payload: Record<string, unknown>) => {
          try {
            const orm = ctx.getOrm() as unknown as {
              events?: { create: (row: Record<string, unknown>) => void };
            };
            orm.events?.create({
              id: `retention_${crypto.randomUUID().slice(0, 8)}`,
              sessionId: "system",
              type,
              agent: "orchestrator",
              payload,
              createdAt: new Date().toISOString(),
            });
          } catch {
            // Audit persistence is best-effort here; the response
            // fields below are the operator-visible record.
          }
        };
        // #1766 leg 1 — orphan sweep (reports/*.json vs mas_reports.body_r2_key).
        const orphanSweep = {
          scanned: 0,
          orphans: 0,
          danglingRows: 0,
          deleted: 0,
          deleteFailed: 0,
          deleteEnabled: false,
          truncated: false,
          error: null as string | null,
          skipped: null as string | null,
        };
        try {
          // Issue #1777 (Adapter S3): the sweep lists/deletes through
          // the one BlobStore port; the skipped message is unchanged.
          const store = createBlobStore(ctx.env);
          if (!store) {
            orphanSweep.skipped = "REPORTS_BUCKET is not bound";
          } else {
            const sql = ctx.agentCtx.storage.sql as {
              exec: (q: string, ...params: unknown[]) => Iterable<unknown>;
            };
            const bucketKeys: string[] = [];
            let cursor: string | undefined;
            let pageTruncated = false;
            do {
              const page = await store.list({ prefix: ORPHAN_SWEEP_PREFIX, cursor, limit: 1000 });
              for (const key of page.keys) bucketKeys.push(key);
              pageTruncated = page.truncated;
              cursor = page.truncated ? page.cursor : undefined;
              if (bucketKeys.length >= 5000) {
                pageTruncated = true;
                break;
              }
            } while (pageTruncated && cursor);
            orphanSweep.truncated = pageTruncated;
            let referencedKeys: string[] | null = null;
            try {
              const rows = Array.from(
                sql.exec("SELECT body_r2_key FROM mas_reports WHERE body_r2_key IS NOT NULL"),
              ) as Array<{ body_r2_key?: unknown }>;
              referencedKeys = rows
                .map((r) => r.body_r2_key)
                .filter((k): k is string => typeof k === "string");
            } catch (err) {
              // Fail closed: without the referenced set, every object
              // would read as orphaned — so plan nothing at all.
              orphanSweep.error = `referenced-keys read failed: ${err instanceof Error ? err.message : String(err)}`;
            }
            if (referencedKeys !== null) {
              const plan = planOrphanSweep({ bucketKeys, referencedKeys });
              orphanSweep.scanned = plan.scanned;
              orphanSweep.orphans = plan.orphans.length;
              orphanSweep.danglingRows = plan.danglingRows.length;
              orphanSweep.deleteEnabled = resolveOrphanSweepDelete(
                ctx.env?.RETENTION_ORPHAN_SWEEP_DELETE,
              );
              if (orphanSweep.deleteEnabled) {
                for (const key of plan.orphans) {
                  try {
                    await store.delete(key);
                    orphanSweep.deleted += 1;
                  } catch {
                    orphanSweep.deleteFailed += 1;
                  }
                }
              }
              auditEvent("RETENTION_ORPHAN_SWEEP", {
                scanned: orphanSweep.scanned,
                orphans: orphanSweep.orphans,
                danglingRows: orphanSweep.danglingRows,
                deleted: orphanSweep.deleted,
                deleteFailed: orphanSweep.deleteFailed,
                deleteEnabled: orphanSweep.deleteEnabled,
                truncated: orphanSweep.truncated,
                note: "Nightly orphan sweep (#1766): reports/*.json objects with no mas_reports row; dangling rows are reported, never deleted.",
              });
            }
          }
        } catch (err) {
          orphanSweep.error = err instanceof Error ? err.message : String(err);
          structuredLog.warn("schedules.retention_orphan_sweep_failed", {
            message: "[retention] orphan sweep failed:",
            error: orphanSweep.error,
          });
        }
        // #1766 leg 2 — R2 snapshot export of this instance's tables.
        const snapshot = {
          tables: 0,
          rows: 0,
          truncatedTables: [] as string[],
          key: null as string | null,
          error: null as string | null,
          skipped: null as string | null,
        };
        try {
          if (!resolveSnapshotEnabled(ctx.env?.RETENTION_SNAPSHOT_ENABLED)) {
            snapshot.skipped = "disabled by RETENTION_SNAPSHOT_ENABLED=false";
          } else {
            const store = createBlobStore(ctx.env);
            if (!store) {
              snapshot.skipped = "REPORTS_BUCKET is not bound";
            } else {
              const sql = ctx.agentCtx.storage.sql as {
                exec: (q: string, ...params: unknown[]) => Iterable<unknown>;
              };
              const tableRows = Array.from(
                sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"),
              ) as Array<{ name?: unknown }>;
              const tables: Array<{ table: string; rows: unknown[] }> = [];
              for (const t of tableRows) {
                if (typeof t.name !== "string" || !/^[A-Za-z0-9_]+$/.test(t.name)) continue;
                const rows = Array.from(sql.exec(`SELECT * FROM "${t.name}" LIMIT 5001`));
                tables.push({ table: t.name, rows });
              }
              const manifest = await buildSnapshotManifest({
                instance: "orchestrator",
                exportedAt: Date.now(),
                tables,
                rowLimit: SNAPSHOT_ROW_LIMIT,
              });
              const key = snapshotObjectKey("orchestrator", manifest.exportedAt);
              await store.put(key, JSON.stringify(manifest), {
                contentType: "application/json",
              });
              snapshot.tables = manifest.tables.length;
              snapshot.rows = manifest.tables.reduce((sum, t) => sum + t.rowCount, 0);
              snapshot.truncatedTables = manifest.tables
                .filter((t) => t.truncated)
                .map((t) => t.table);
              snapshot.key = key;
              auditEvent("RETENTION_SNAPSHOT", {
                tables: snapshot.tables,
                rows: snapshot.rows,
                truncatedTables: snapshot.truncatedTables,
                key,
                manifestSha256: manifest.manifestSha256,
                note: "Nightly R2 snapshot export (#1766): portable per-table dump complementing Cloudflare PITR (30-day whole-DB restore); truncated tables are flagged, never silently partial.",
              });
            }
          }
        } catch (err) {
          snapshot.error = err instanceof Error ? err.message : String(err);
          structuredLog.warn("schedules.retention_snapshot_export_failed", {
            message: "[retention] snapshot export failed:",
            error: snapshot.error,
          });
        }
        return Response.json({
          success: true,
          ...result,
          auditChainVerification,
          auditChainPruneSkipped,
          jobOutcomesPruned: jobOutcomes.deletedByAge + jobOutcomes.deletedByCap,
          jobOutcomesByAge: jobOutcomes.deletedByAge,
          jobOutcomesByCap: jobOutcomes.deletedByCap,
          jobOutcomesError: jobOutcomes.error,
          orphanSweep,
          snapshot,
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to run storage retention" }, { status: 500 });
      }
    }

    // Trigger the daily IV history collection immediately on demand
    // (issue #15) — same per-name outcomes the scheduled run produces;
    // idempotent per (symbol, day), so a manual rerun is safe.
    if (path.endsWith("/schedules/trigger-iv-collection") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin;
        if (!userLogin) return Response.json({ success: false, error: "An authenticated broker account is required." }, { status: 401 });
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD" ? rawEnvironment : context?.environment;
        // Issue #2337 cutover (R-2): the on-demand trigger
        // collects through the env-aware build's IV store —
        // D1 when AGENT_DB is bound — the same store the
        // scheduled collector and the read paths use.
        const service = new ScheduledTasksService(
          ctx.env,
          ctx.getOrm(),
          userLogin,
          createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns,
          (await buildOptionsDiscoveryPorts(ctx.env, { sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage })).ivHistory,
          undefined,
          undefined,
          ctx.scheduleScreenerFollowups, undefined, undefined, undefined, ctx.env.SCREENER_EVENTS ?? null
        );
        const result = await service.collectDailyIvHistory({ ...body, userLogin, environment });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger IV collection" }, { status: 500 });
      }
    }

    // Trigger scheduled strategy discovery immediately on demand
    // (issue #126) — re-runs the body's SAVED StrategyRequests verbatim
    // through the discovery pipeline and persists the run as a
    // "manual-trigger" discovery run. An account identity is required:
    // runs are per-user records and execute under the owner's E*TRADE
    // session (mirrors trigger-iv-collection's 401). Issue #533: a body
    // carrying inputModel "profile-derived" (+ profileId and symbols
    // or watchlistName) flows through the same call — the service
    // branches on the discriminator — and abstentions ride back in the
    // result data alongside failures. Issue #534: a body carrying
    // inputModel "no-view" (+ constraintSets) flows through the same
    // call the same way.
    if (path.endsWith("/schedules/trigger-discovery") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin;
        if (!userLogin) return Response.json({ success: false, error: "An authenticated broker account is required." }, { status: 401 });
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD"
          ? rawEnvironment
          : context?.environment;
        // Issue #1661: platformDeps threads the DO storage handle so
        // trigger-discovery listings fetch live + capture (behavior change
        // from the missing-seam throw — disclosed, Q3).
        const service = new ScheduledTasksService(
          ctx.env,
          ctx.getOrm(),
          userLogin,
          createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns,
          undefined,
          createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).discoveryRuns,
          createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).strategyProfiles,
          ctx.scheduleScreenerFollowups,
          { sql: ctx.agentCtx.storage.sql, blobStorage: ctx.agentCtx.storage, env: ctx.env },
          undefined,
          createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).feedSnapshots, ctx.env.SCREENER_EVENTS ?? null
        );
        // Issue #959: validate through the shared schedule builder
        // (the service's own derivation validation still runs inside).
        const { userLogin: _bodyLogin, environment: _bodyEnv, ...triggerCriteria } = body ?? {};
        const built = buildSchedulePayload("autonomousStrategyDiscovery", triggerCriteria, { userLogin, environment, trigger: "manual" }, { applyCreationDefaults: false });
        if (!built.ok) {
          return Response.json({ success: false, error: built.error }, { status: 400 });
        }
        const result = await service.autonomousStrategyDiscovery(built.value as any);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger strategy discovery" }, { status: 500 });
      }
    }

    // Submit the feed stage (consolidation #1236): produce + store
    // one snapshot artifact per symbol as a feed.snapshot async job
    // (stage "feed", retryable, status-visible). With chainTo, the
    // job mints a chain id and its completion plans the generate
    // stage (see the feed completion hook); without it, the job is
    // a standalone refresh. When chainTo is present the feed symbols
    // + filters are DERIVED from its requests, so generate-time
    // filter matching holds by construction; a body.symbols that
    // disagrees with chainTo.requests is rejected rather than
    // silently ignored.
    if (path.endsWith("/schedules/feed-snapshot") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin;
        if (!userLogin) return Response.json({ success: false, error: "An authenticated broker account is required." }, { status: 401 });
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD"
          ? rawEnvironment
          : context?.environment;
        if (!ctx.submitAsyncJob) return Response.json({ success: false, error: "Feed submission is not wired on this host." }, { status: 500 });
        const tickerRe = /^[A-Z0-9./-]{1,16}$/i;
        const chainTo = body?.chainTo;
        let feedSymbols: Array<{ symbol: string; loadParams?: Record<string, unknown> }> | undefined;
        let chainRequests: Array<Record<string, unknown>> | undefined;
        if (chainTo !== undefined) {
          if (chainTo === null || typeof chainTo !== "object" || !Array.isArray(chainTo.requests) || chainTo.requests.length === 0) {
            return Response.json({ success: false, error: "chainTo.requests must be a non-empty array." }, { status: 400 });
          }
          for (const key of ["emailTo", "slackChannel", "webhookUrl"] as const) {
            if (chainTo[key] !== undefined && typeof chainTo[key] !== "string") {
              return Response.json({ success: false, error: `chainTo.${key} must be a string.` }, { status: 400 });
            }
          }
          chainRequests = [];
          feedSymbols = [];
          for (const req of chainTo.requests) {
            const invalid = validateStrategyRequest(req);
            if (invalid) {
              return Response.json({ success: false, error: `chainTo request is invalid: ${invalid}` }, { status: 400 });
            }
            const symbol = String((req as { symbol: string }).symbol).toUpperCase().trim();
            chainRequests.push(req);
            feedSymbols.push({ symbol, loadParams: pickFeedLoadParams(req) as Record<string, unknown> });
          }
          if (body?.symbols !== undefined) {
            const bodySymbols = Array.isArray(body.symbols) ? body.symbols.map((s: unknown) => String(s).toUpperCase().trim()) : null;
            const derived = feedSymbols.map((s) => s.symbol);
            if (!bodySymbols || bodySymbols.length !== derived.length || bodySymbols.some((s: string, i: number) => s !== derived[i])) {
              return Response.json({ success: false, error: "symbols must match chainTo.requests symbols." }, { status: 400 });
            }
          }
        } else {
          if (!Array.isArray(body?.symbols) || body.symbols.length === 0) {
            return Response.json({ success: false, error: "symbols must be a non-empty array, or chainTo.requests must name the feed." }, { status: 400 });
          }
          for (const s of body.symbols) {
            if (typeof s !== "string" || !tickerRe.test(s.trim())) {
              return Response.json({ success: false, error: `symbols must be valid ticker strings; got '${String(s)}'.` }, { status: 400 });
            }
          }
          feedSymbols = body.symbols.map((s: string) => ({ symbol: s.toUpperCase().trim() }));
        }
        const chainId = chainTo !== undefined ? crypto.randomUUID() : undefined;
        const submitted = await ctx.submitAsyncJob({
          capability: "feed.snapshot",
          payload: {
            userLogin,
            ...(environment ? { environment } : {}),
            symbols: feedSymbols,
            ...(chainTo
              ? {
                  chainTo: {
                    requests: chainRequests,
                    ...(typeof chainTo.emailTo === "string" ? { emailTo: chainTo.emailTo } : {}),
                    ...(typeof chainTo.slackChannel === "string" ? { slackChannel: chainTo.slackChannel } : {}),
                    ...(typeof chainTo.webhookUrl === "string" ? { webhookUrl: chainTo.webhookUrl } : {}),
                  },
                }
              : {}),
          },
          stage: "feed",
          ...(chainId ? { chainId } : {}),
        } as import("../../types").AsyncJobSubmission);
        return Response.json({ ...submitted, stage: "feed", ...(chainId ? { chainId } : {}) });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to submit feed snapshot" }, { status: 500 });
      }
    }
  return null;
}
