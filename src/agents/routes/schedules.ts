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
 *   POST        /schedules/trigger-iv-collection  (issue #15)
 *   POST        /schedules/trigger-discovery      (issue #126)
 *   POST        /schedules/:id/pause               (issue #273)
 *   POST        /schedules/:id/resume              (issue #273)
 *   POST        /schedules/:id/trigger             (issue #273)
 *   PUT         /schedules/:id                     (issue #273)
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
import { isLoginShaped } from "../../security/serviceIdentity";
import { findDuplicateSchedule } from "../../services/scheduleDedupe";
import { runStorageRetention } from "../../security/storageRetention";
import { pruneJobOutcomes } from "../../services/jobOutcomes";
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
  pausedRecordToListItem,
  resolveScheduleUpdate,
  scheduleToPausedRecord,
  type PausedScheduleRecord,
  type ResolvedScheduleTiming,
  type ScheduleDefinitionLike,
} from "../../services/scheduleManagement";
import type { DatabaseORM } from "../../orm";
import type { AgentName, Env } from "../../types";

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
 * Task schedule management routes. Invoked from routeRequest at the exact
 * position the original block occupied (after the
 * handleScreenerResearchRoutes delegation, before the Not-found
 * fallthrough); returns a Response when one of the owned paths matches, or
 * null to continue sequential matching.
 */
export async function handleSchedulesRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: SchedulesRouteContext
): Promise<Response | null> {
    // Issue #273 helpers: the paused-job store lives in the agent's own
    // SQLite (see services/scheduleManagement.ts); subpath ids come from
    // the /schedules/<id>/<action> shape via regex (not a counted
    // route condition).
    const pausedStore = () => createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).pausedSchedulesSync;
    const subpathId = (p: string): string => {
      const m = p.match(/\/schedules\/([^/]+)\//);
      if (!m) return "";
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    };
    const timingFromDefinition = (def: {
      type: string;
      cron?: string;
      intervalSeconds?: number;
      time?: number;
    }): ResolvedScheduleTiming | null => {
      if (def.type === "cron" && def.cron) return { type: "cron", cron: def.cron };
      if (def.type === "interval" && def.intervalSeconds)
        return { type: "interval", intervalSeconds: def.intervalSeconds };
      if ((def.type === "scheduled" || def.type === "delayed") && def.time !== undefined)
        return { type: def.type, time: def.time };
      return null;
    };
    const armFromTiming = (timing: ResolvedScheduleTiming, callback: string, payload: unknown) => {
      if (timing.type === "cron") return ctx.schedule(timing.cron, callback, payload, { idempotent: true });
      if (timing.type === "interval") return ctx.scheduleEvery(timing.intervalSeconds, callback, payload);
      return ctx.schedule(new Date(timing.time * 1000), callback, payload);
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
        const schedules = await ctx.listSchedules(
          typeParam ? { type: typeParam as ScheduleCriteria["type"] } : undefined
        );
        // Issue #273: paused jobs are cancelled SDK schedules, so they
        // are merged back in from the paused store (flagged `paused`,
        // no next run) — pausing never makes a job vanish from the UI.
        let pausedItems: ReturnType<typeof pausedRecordToListItem>[] = [];
        try {
          pausedItems = pausedStore()
            .list()
            .filter((r) => !typeParam || r.type === typeParam)
            .map(pausedRecordToListItem);
        } catch {
          pausedItems = [];
        }
        return Response.json({
          count: schedules.length + pausedItems.length,
          schedules: [...schedules, ...pausedItems],
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
        let cancelled = await ctx.cancelSchedule(scheduleId);
        if (!cancelled) {
          // Issue #273: deleting a paused job deletes its stored record.
          try {
            cancelled = pausedStore().remove(scheduleId);
          } catch {
            cancelled = false;
          }
        }
        ctx.audit("schedule.cancelled", "orchestrator", { scheduleId, success: cancelled });
        return Response.json({ scheduleId, cancelled });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to cancel schedule" }, { status: 500 });
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
          pausedPreserved = pausedStore().list().length;
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

    // Get specific schedule by ID (GET /api/schedules/:id)
    if (path.includes("/schedules/") && request.method === "GET") {
      try {
        const scheduleId = path.split("/schedules/").pop() || "";
        const schedule = await ctx.getScheduleById(scheduleId);
        if (!schedule) {
          // Issue #273: a paused job resolves from the paused store.
          // The lookup degrades to the plain 404 if the store is
          // unavailable — it must never mask the not-found answer.
          let paused: PausedScheduleRecord | undefined;
          try {
            paused = pausedStore().get(scheduleId);
          } catch {
            paused = undefined;
          }
          if (paused) return Response.json(pausedRecordToListItem(paused));
          return Response.json({ error: `Schedule '${scheduleId}' not found` }, { status: 404 });
        }
        return Response.json(schedule);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to get schedule" }, { status: 500 });
      }
    }

    // Pause a schedule (POST /api/schedules/:id/pause) — issue #273.
    // The SDK schedule is cancelled, but its full definition is kept in
    // the paused store so the job stays listed (status: paused) and can
    // be resumed or edited in place.
    if (path.includes("/schedules/") && path.endsWith("/pause") && request.method === "POST") {
      try {
        const scheduleId = subpathId(path);
        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        const store = pausedStore();
        const already = store.get(scheduleId);
        if (already) {
          return Response.json({ success: true, schedule: pausedRecordToListItem(already) });
        }
        const schedule = await ctx.getScheduleById(scheduleId);
        if (!schedule) {
          return Response.json({ error: `Schedule '${scheduleId}' not found` }, { status: 404 });
        }
        const record = scheduleToPausedRecord(schedule, new Date().toISOString());
        store.save(record);
        await ctx.cancelSchedule(scheduleId);
        ctx.audit("schedule.paused", "orchestrator", { scheduleId, callback: schedule.callback });
        return Response.json({ success: true, schedule: pausedRecordToListItem(record) });
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
        const store = pausedStore();
        const record = store.get(scheduleId);
        if (!record) {
          return Response.json({ error: `Schedule '${scheduleId}' is not paused` }, { status: 404 });
        }
        const timing = timingFromDefinition(record);
        if (!timing) {
          return Response.json({ error: `Paused schedule '${scheduleId}' has an incomplete definition and cannot be resumed` }, { status: 500 });
        }
        const schedule = await armFromTiming(timing, record.callback, record.payload);
        store.remove(scheduleId);
        ctx.audit("schedule.resumed", "orchestrator", { scheduleId, newScheduleId: schedule?.id, callback: record.callback });
        return Response.json({ success: true, previousId: scheduleId, schedule });
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
        if (pausedStore().get(scheduleId)) {
          return Response.json(
            { success: false, error: "Schedule is paused — resume it before triggering." },
            { status: 409 }
          );
        }
        const schedule = await ctx.getScheduleById(scheduleId);
        if (!schedule) {
          return Response.json({ error: `Schedule '${scheduleId}' not found` }, { status: 404 });
        }
        const payload =
          schedule.payload && typeof schedule.payload === "object"
            ? { ...(schedule.payload as Record<string, unknown>), trigger: "manual", scheduleId }
            : schedule.payload;
        await ctx.runScheduleCallback(schedule.callback, payload);
        ctx.audit("schedule.triggered", "orchestrator", { scheduleId, callback: schedule.callback });
        return Response.json({ success: true, scheduleId, callback: schedule.callback });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger schedule" }, { status: 500 });
      }
    }

    // Update a schedule (PUT /api/schedules/:id) — issue #273: change
    // the cron/interval and/or payload atomically (cancel + recreate
    // under the hood; paused jobs update in place in the paused store).
    if (path.includes("/schedules/") && request.method === "PUT") {
      try {
        const scheduleId = path.split("/schedules/").pop() || "";
        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        const body = (await request.json().catch(() => ({}))) as any;
        const store = pausedStore();
        const paused = store.get(scheduleId);
        if (paused) {
          const resolution = resolveScheduleUpdate(paused, body, Date.now());
          if (!resolution.ok) {
            return Response.json({ success: false, error: resolution.error }, { status: 400 });
          }
          const updated: PausedScheduleRecord = {
            id: paused.id,
            callback: paused.callback,
            payload: resolution.payload,
            type: resolution.timing.type,
            pausedAt: paused.pausedAt,
            ...(resolution.timing.type === "cron" ? { cron: resolution.timing.cron } : {}),
            ...(resolution.timing.type === "interval" ? { intervalSeconds: resolution.timing.intervalSeconds } : {}),
            ...(resolution.timing.type === "scheduled" || resolution.timing.type === "delayed"
              ? { time: resolution.timing.time }
              : {}),
          };
          store.save(updated);
          ctx.audit("schedule.updated", "orchestrator", { scheduleId, callback: paused.callback, paused: true });
          return Response.json({ success: true, schedule: pausedRecordToListItem(updated) });
        }
        const existing = await ctx.getScheduleById(scheduleId);
        if (!existing) {
          return Response.json({ error: `Schedule '${scheduleId}' not found` }, { status: 404 });
        }
        const resolution = resolveScheduleUpdate(
          existing as unknown as ScheduleDefinitionLike,
          body,
          Date.now()
        );
        if (!resolution.ok) {
          return Response.json({ success: false, error: resolution.error }, { status: 400 });
        }
        await ctx.cancelSchedule(scheduleId);
        const schedule = await armFromTiming(resolution.timing, existing.callback, resolution.payload);
        ctx.audit("schedule.updated", "orchestrator", { scheduleId, newScheduleId: schedule?.id, callback: existing.callback });
        return Response.json({ success: true, previousId: scheduleId, schedule });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to update schedule" }, { status: 500 });
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
        const trustedUserLogin = context?.userLogin || (isLoginShaped(headerUserLogin) ? headerUserLogin : "");
        const headerEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const trustedEnvironment = context?.environment ||
          (headerEnvironment === "TEST" || headerEnvironment === "PROD"
            ? headerEnvironment
            : resolveEnvironmentConfig(ctx.env).name as ETradeEnvironment);
        if (ctx.accountScopedScheduleCallbacks.has(callback) && !trustedUserLogin) {
          return Response.json({ success: false, error: "An authenticated E*TRADE account is required to create screening schedules." }, { status: 401 });
        }
        if (ctx.accountScopedScheduleCallbacks.has(callback)) {
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
        }
        const { userLogin: _untrustedUserLogin, environment: _untrustedEnvironment, ...safePayload } =
          payload && typeof payload === "object" ? payload : {};
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
        if (duplicate) {
          ctx.audit("schedule.duplicate_suppressed", "orchestrator", {
            scheduleId: (duplicate as any).id,
            callback,
            scheduleType,
          });
          return Response.json({ success: true, schedule: duplicate, duplicate: true });
        }

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
        if (!userLogin) return Response.json({ success: false, error: "An authenticated E*TRADE account is required." }, { status: 401 });
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
        const service = new ScheduledTasksService(ctx.env, ctx.getOrm(), userLogin, createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns, undefined, undefined, undefined, ctx.scheduleScreenerFollowups, { sql: ctx.agentCtx.storage.sql, blobStorage: ctx.agentCtx.storage, env: ctx.env }, ctx.submitShardJob);
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
        const result = runStorageRetention(ctx.getOrm(), {
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
          console.warn("[retention] job outcomes prune failed:", jobOutcomes.error);
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
          const bucket = ctx.env?.REPORTS_BUCKET;
          if (!bucket) {
            orphanSweep.skipped = "REPORTS_BUCKET is not bound";
          } else {
            const sql = ctx.agentCtx.storage.sql as {
              exec: (q: string, ...params: unknown[]) => Iterable<unknown>;
            };
            const bucketKeys: string[] = [];
            let cursor: string | undefined;
            let pageTruncated = false;
            do {
              const page = await bucket.list({ prefix: ORPHAN_SWEEP_PREFIX, cursor, limit: 1000 });
              for (const obj of page.objects) bucketKeys.push(obj.key);
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
                    await bucket.delete(key);
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
          console.warn("[retention] orphan sweep failed:", orphanSweep.error);
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
            const bucket = ctx.env?.REPORTS_BUCKET;
            if (!bucket) {
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
              await bucket.put(key, JSON.stringify(manifest), {
                httpMetadata: { contentType: "application/json" },
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
          console.warn("[retention] snapshot export failed:", snapshot.error);
        }
        return Response.json({
          success: true,
          ...result,
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
        if (!userLogin) return Response.json({ success: false, error: "An authenticated E*TRADE account is required." }, { status: 401 });
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
          ctx.scheduleScreenerFollowups
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
        if (!userLogin) return Response.json({ success: false, error: "An authenticated E*TRADE account is required." }, { status: 401 });
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
          createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).feedSnapshots
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
        if (!userLogin) return Response.json({ success: false, error: "An authenticated E*TRADE account is required." }, { status: 401 });
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
