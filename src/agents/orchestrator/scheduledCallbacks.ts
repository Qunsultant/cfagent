/**
 * Issue #992: Scheduled callbacks (E*TRADE token renewal, scheduled market screen, strategy discovery, IV collection, order-draft expiry, reminders) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * ScheduledCallbacksContext.
 */

import type { AgentContext } from "agents";
import type { DatabaseORM } from "../../orm";
import type { Env } from "../../types";
import {
  ScheduledTasksService,
  type AutonomousStrategyDiscoveryOptions,
} from "../../services/scheduledTasks";
import {
  buildOptionsDiscoveryPorts,
  createOptionsDiscoveryPorts,
} from "../../data/createOptionsDiscoveryPorts";
import { resolveScheduledLogin, type ScreenerExecutionContext } from "./scheduleMaintenance";
import { deliverGatedSlack } from "../../services/gatedSlackDelivery";
import { recordBlockingAudit } from "../../security/auditChain";
import {
  enforceBrokerDispatch,
  enforceServiceDispatch,
  resolveDispatchCandidate,
  type DispatchDenialReason,
} from "../../security/serviceDispatch";
import { getServiceUserLogin } from "../../security/serviceIdentity";
import type { MembershipStore } from "../../security/authorization";
import { enforceOwnerDispatch } from "../../security/runRevocationGate";
import { sessionStore } from "../../security/session";
import { lookupInternalUserIdByLogin } from "../../security/iaaaMigration";
import type { JobRunOutcome } from "../../data/jobRunRecordPorts";
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/orchestrator/scheduledCallbacks",
});

type ETradeEnvironment = "TEST" | "PROD";

/**
 * Issue #2964 — the outcome a scheduled callback reports to its
 * recording wrapper. The callbacks deliberately never throw for a
 * failed or skipped run (platform callback retry is not used for
 * scheduled jobs — see the failure contract on
 * ScheduledTasksService), so a throw-based record would mark every
 * failed screen as a success. The outcome object carries the truth
 * instead: success with a descriptor (+ artifact refs), failure
 * with error text, skipped with its reason. The orchestrator
 * methods stay Promise<void> — they record, then discard.
 */
export interface ScheduledCallbackOutcome {
  outcome: JobRunOutcome;
  detail?: string;
  descriptor?: string;
  error?: string;
  artifactRefs?: string[];
}

/**
 * #2331 slice 2: one dispatch decision for every schedule callback.
 * Resolution preserves each callback's existing precedence (the caller
 * passes its already-resolved login); the broker check runs before the
 * membership check, so brokerage-attached work denies as
 * BROKER_REQUIRED even for an unprovisioned service identity. A denied
 * dispatch never runs: the caller audits and returns, and the schedule
 * is preserved (unlike the unowned case, which removes the schedule),
 * so a provisioned-later retry still fires.
 */
type CallbackDispatch =
  | { allowed: true; kind: "owner" | "service"; login: string }
  | { denied: true; reason: DispatchDenialReason; detail?: string };

async function resolveCallbackDispatch(
  ctx: ScheduledCallbacksContext,
  candidate: string | undefined,
  needsBroker: boolean,
): Promise<CallbackDispatch> {
  const serviceLogin = getServiceUserLogin(ctx.env);
  const identity = resolveDispatchCandidate(candidate, serviceLogin);
  if ("denied" in identity) return identity;
  const broker = enforceBrokerDispatch(identity.kind, needsBroker);
  if ("denied" in broker) return broker;
  if (identity.kind === "owner") {
    // #3154 (Q6): revocation-mid-run consumer — an owner firing
    // re-checks live membership at dispatch, mirroring the service
    // tier's membership check. The resolver is the iaaa-alias login
    // lookup over the SessionStore KV (the same store the
    // membership store reads); an unresolvable login, a missing
    // store, or a lookup failure preserves pre-existing behavior
    // (allow, logged inside enforceOwnerDispatch) — see
    // runRevocationGate.ts. A denial audits via auditCallbackDenial
    // at the call sites and preserves the schedule.
    const owner = await enforceOwnerDispatch({
      store: ctx.serviceMembershipStore,
      resolveInternalUserId:
        ctx.resolveOwnerInternalUserId ??
        ((login) => lookupInternalUserIdByLogin(sessionStore(ctx.env), login)),
      login: identity.login,
      nowMs: Date.now(),
    });
    if ("denied" in owner) {
      return { denied: true, reason: "OWNER_MEMBERSHIP_REVOKED", detail: owner.detail };
    }
    return { allowed: true, kind: "owner", login: identity.login };
  }
  const store = ctx.serviceMembershipStore;
  const decision = store
    ? await enforceServiceDispatch(store, {
        serviceLogin: serviceLogin ?? identity.login,
        tier: "platform",
        nowMs: Date.now(),
      })
    : {
        denied: true as const,
        reason: "SERVICE_NOT_PROVISIONED" as const,
        detail: "no membership store on the callback context",
      };
  if ("denied" in decision) return decision;
  return { allowed: true, kind: "service", login: identity.login };
}

function auditCallbackDenial(
  ctx: ScheduledCallbacksContext,
  callback: string,
  decision: { reason: DispatchDenialReason; detail?: string },
): void {
  ctx.audit?.("schedule.dispatch_denied", "orchestrator", {
    callback,
    reason: decision.reason,
    ...(decision.detail ? { detail: decision.detail } : {}),
  });
}

/**
 * Ports the scheduled-callback functions receive from the class. The
 * in-flight slot sets are the class's own Set instances (shared by
 * reference so the re-entrancy guards keep working); storage and
 * lifecycle ownership stay in OrchestratorAgent.
 */
export interface ScheduledCallbacksContext {
  env: Env;
  agentCtx: AgentContext;
  /** The agent instance, for the (this as any) SDK escape hatches the bodies already used. */
  self: unknown;
  getScreenerExecutionContext: () => Promise<ScreenerExecutionContext | undefined>;
  removeUnownedBaselineSchedules: () => Promise<void>;
  getOrm: () => DatabaseORM;
  sessionKey: () => string;
  waitUntilStable: (options: { timeout: number }) => Promise<boolean>;
  scheduledScreenerSlots: Set<string>;
  scheduledDiscoverySlots: Set<string>;
  /** Issue #1123 S5b: follow-up bridge for scheduled screener runs
   *  (recorded main job + report/delivery/notification chain). */
  scheduleScreenerFollowups?: (
    outcome: import("../../services/screenerFollowups").ScreenerRunOutcome,
    userLogin: string,
    chainReport?: boolean,
  ) => Promise<void>;
  /** #2331 slice 2: the funnel audit for dispatch decisions. Optional
   *  so existing test contexts without it still compile; the
   *  orchestrator builder always supplies it, and a denial without an
   *  audit sink is still a denial (the run does not execute). */
  audit?: (
    type: string,
    agent: "orchestrator",
    payload: Record<string, unknown>,
  ) => void;
  /** #2331 slice 2: the membership store the dispatch guard checks
   *  service identities against. The orchestrator builder supplies the
   *  KV store; a context without one denies every service dispatch
   *  (fail closed — an unverifiable service identity never runs). */
  serviceMembershipStore?: MembershipStore;
  /**
   * #3154 (Q6): owner-identity resolver for the revocation-mid-run
   *  consumer. When supplied (tests, and any future builder that
   *  resolves identity outside the SessionStore), the dispatch
   *  guard uses it instead of the default iaaa-alias lookup over
   *  sessionStore(ctx.env). The default keeps production contexts
   *  (built by the orchestrator builder, which does not set this
   *  port) working with no builder change.
   */
  resolveOwnerInternalUserId?: (login: string) => Promise<string | null>;
}

/**
 * Issue #2178 (Q7 S2) — report family: make a failed canonical
 * report store visible. The store's failure signal is a null
 * return, not a throw, so the caller checks and calls this. The
 * failure record is a chained audit row (retrievable through
 * the audit read path); if the audit store itself is down, the
 * failure falls back to the worker log rather than vanishing.
 * Never throws, so scheduled callbacks keep their no-throw
 * contract even when both stores fail.
 */
export function recordReportStoreFailure(
  orm: DatabaseORM,
  input: { runId: string; userLogin: string },
): void {
  try {
    orm.events.create({
      id: crypto.randomUUID(),
      sessionId: input.userLogin,
      type: "screener.report_store_failed",
      agent: "orchestrator",
      payload: { runId: input.runId, userLogin: input.userLogin },
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    structuredLog.error("scheduledCallbacks.report_store_failure_audit_failed", {
      message: `[scheduledCallbacks] report store failure for run ${input.runId} could not be audited:`,
      runId: input.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Cloudflare Agents Scheduled Callback: Proactively renews E*TRADE tokens before midnight ET
 */
export async function autoRenewETradeTokens(ctx: ScheduledCallbacksContext, payload?: { userLogin?: string; env?: string }): Promise<void> {
  try {
    await ctx.waitUntilStable({ timeout: 30_000 });
  } catch {
    // Continue if timeout or unhandled
  }
  const context = await ctx.getScreenerExecutionContext();
  const user = context?.userLogin || payload?.userLogin;
  // #2331 slice 2: dispatch enforcement. Token renewal is brokerage
  // work: a service identity never renews, and an unresolvable
  // identity keeps the existing skip-and-remove behavior, now audited.
  const dispatch = await resolveCallbackDispatch(ctx, user, true);
  if ("denied" in dispatch) {
    auditCallbackDenial(ctx, "autoRenewETradeTokens", dispatch);
    if (dispatch.reason === "NO_IDENTITY") {
      await ctx.removeUnownedBaselineSchedules();
      structuredLog.warn("scheduledCallbacks.token_renewal_skipped_no_owner", {
        message: "[OrchestratorAgent] Skipping token renewal without an authenticated account owner.",
      });
    }
    return;
  }
  const userLogin = dispatch.login;
  const environment = context?.environment || payload?.env;
  const service = new ScheduledTasksService(ctx.env, ctx.getOrm(), userLogin, createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns, undefined, undefined, undefined, ctx.scheduleScreenerFollowups, undefined, undefined, undefined, ctx.env.SCREENER_EVENTS ?? null);
  const res = await service.autoRenewETradeTokens(userLogin, environment);
  if (!res.success) {
    structuredLog.warn("scheduledCallbacks.token_renewal_failed", {
      message: "[OrchestratorAgent] autoRenewETradeTokens error:",
      error: res.error,
    });
    // Issue #1174 (#1173 S1): a failed renewal is tonight's outage
    // warning — raise the deduplicated reconnect alert NOW (shared
    // episode flag with the run-time guard) instead of leaving it as
    // a log line nobody reads until six runs have failed.
    const { etradeAuthEpisodeKey, fireAuthEpisodeAlertOnce } = await import("../../services/etradeAuthPreflight");
    await fireAuthEpisodeAlertOnce(
      ctx.agentCtx.storage as any,
      etradeAuthEpisodeKey(userLogin, Date.now()),
      async () => {
        // #3177: system auth alert — ungated (no login passed, the gate
        // is never consulted), but master-routed so the alert no longer
        // depends on cfpay being configured. Exact text and dedupe kept.
        await deliverGatedSlack(ctx.env, {
          text: "⚠️ E*TRADE connection expired — automatic token renewal failed. Reconnect your account in Settings to keep scheduled runs working. Runs stay blocked (quietly) until you reconnect.",
        });
      }
    );
  }
  // Issue #2178 (Q7 S2) — token-ops family: the renewal OUTCOME
  // claim goes through the blocking helper. This row is distinct
  // from the service's own warn-path outcome notes
  // (etrade.token_auto_renewed/failed/error), which stay — the
  // service is also called from the NLQ path, where no callback
  // exists. A throwing store propagates out of the callback: the
  // renewal surfaces as an error (the next scheduled renewal
  // retries it), never as a success with no record.
  recordBlockingAudit(ctx.getOrm().events, {
    id: crypto.randomUUID(),
    sessionId: userLogin,
    type: "etrade.token_renewal_claim",
    agent: "orchestrator",
    payload: {
      userLogin: userLogin,
      environment: environment ?? "default",
      success: res.success,
      renewed: (res as { data?: { renewed?: boolean } }).data?.renewed ?? false,
      ...(res.success ? {} : { error: res.error }),
    },
    createdAt: new Date().toISOString(),
  });
}

/**
 * Cloudflare Agents Scheduled Callback: Runs periodic market screening
 * Protected with keepAliveWhile to avoid DO inactivity eviction
 */
export async function autonomousMarketScreen(ctx: ScheduledCallbacksContext, payload?: {
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
  /** Issue #1499 (#940-E): id of a stored preset, resolved at RUN time
   *  by the service (preset edits apply to future runs; the preset's
   *  criteria replace filters). Carried through the {...payload} spread
   *  below — including Trigger-Now dispatches of the same schedule. */
  presetId?: string;
  /** Issue #2908 (G1): the arming schedule's id, when the caller knows it — rides the canonical body (see run below). */
  scheduleId?: string;
  /** Issue #1007: data provider for the scheduled run (default "etrade"). */
  provider?: import("../../trading").StockScreenProvider;
  /** Consolidation C3 (#1277): stage-chain config from the schedule
   *  payload, forwarded to the service so the run's stage jobs are
   *  stamped at the follow-up bridge. */
  stageChain?: import("../../types").StageChainConfig;
  /** Issue #1355: run this scheduled screen as sharded jobs
   *  (validated by marketScreenScheduleCriteriaSchema). */
  sharded?: boolean;
  /** Issue #2373 (slice C): schedule kind + submission
   *  authorization, carried through the {...payload} spread to
   *  ScheduledTasksService.autonomousMarketScreen. Absent fails
   *  closed to recurring at the tick. */
  scheduleKind?: "one_off" | "recurring";
  authorizedAtSubmission?: boolean;
}): Promise<ScheduledCallbackOutcome> {
  try {
    await ctx.waitUntilStable({ timeout: 30_000 });
  } catch {
    // Continue if timeout or unhandled
  }
  // Issue #2964: the outcome stash. runScreen assigns it on every
  // return; the outer function returns the stashed value after
  // awaiting, whatever keepAliveWhile returns (its return type is
  // not the callback's outcome).
  let outcome: ScheduledCallbackOutcome = { outcome: "skipped", detail: "callback did not run" };
  const runScreen = async (): Promise<ScheduledCallbackOutcome> => {
    const trigger = payload?.trigger || "scheduled";
    const universe = payload?.universe || "NASDAQ100";
    const savedContext = await ctx.getScreenerExecutionContext();
    const userLogin = resolveScheduledLogin(payload?.userLogin, savedContext?.userLogin);
    const environment = payload?.environment || savedContext?.environment;
    // #2331 slice 2: dispatch enforcement, before the slot logic. A
    // denied dispatch audits and returns without running; the schedule
    // is preserved (unlike the unowned case) so a provisioned-later
    // retry still fires. The resolved login replaces the old ""
    // fallback below.
    const dispatch = await resolveCallbackDispatch(ctx, userLogin, false);
    if ("denied" in dispatch) {
      auditCallbackDenial(ctx, "autonomousMarketScreen", dispatch);
      if (trigger === "scheduled" && dispatch.reason === "NO_IDENTITY") {
        // A pre-auth startup schedule has no safe account mapping.
        // Remove it before it can emit the same Slack failure every hour.
        await ctx.removeUnownedBaselineSchedules();
        structuredLog.warn("scheduledCallbacks.market_screen_skipped_no_owner", {
          message: "[OrchestratorAgent] Skipping unowned scheduled market screen.",
        });
      }
      return (outcome = { outcome: "skipped", detail: `dispatch denied (${dispatch.reason})` });
    }
    const resolvedLogin = dispatch.login;
    if (trigger === "scheduled") {
      // Old or duplicate cron records can still invoke the same universe
      // more than once in an hour. Keep the last delivered slot per
      // universe in DO storage so only one run publishes to Slack.
      const slot = new Date().toISOString().slice(0, 16);
      const slotKey = `${universe}:${slot}`;
      ctx.scheduledScreenerSlots ??= new Set<string>();
      if (ctx.scheduledScreenerSlots.has(slotKey)) {
        return (outcome = { outcome: "skipped", detail: `duplicate minute slot for ${universe} (in-memory)` });
      }
      if (ctx.scheduledScreenerSlots.size > 32) ctx.scheduledScreenerSlots.clear();
      ctx.scheduledScreenerSlots.add(slotKey);
      const key = `screener:scheduled:last-slot:${universe}`;
      const last = await ctx.agentCtx.storage.get<{ slot: string }>(key);
      if (last?.slot === slot) {
        structuredLog.warn("scheduledCallbacks.market_screen_duplicate_suppressed", {
          message: `[OrchestratorAgent] Suppressing duplicate scheduled screen for ${universe} in ${slot}Z`,
          universe,
          slot,
        });
        return (outcome = { outcome: "skipped", detail: `duplicate minute slot for ${universe} (persistent)` });
      }
      await ctx.agentCtx.storage.put(key, { slot });
    }
    const orm = ctx.getOrm();
    // Scheduled callbacks have no authenticated HTTP headers. Use the
    // identity and environment saved from the user's schedules requests.
    const service = new ScheduledTasksService(ctx.env, orm, resolvedLogin, createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns, undefined, undefined, undefined, ctx.scheduleScreenerFollowups, { sql: ctx.agentCtx.storage.sql, blobStorage: ctx.agentCtx.storage as any, env: ctx.env },
      // Issue #1355: shard submission rides the agent's private
      // submitAsyncJob via the same (ctx.self as any) escape hatch
      // this file already uses for broadcast/keepAliveWhile.
      (spec) => (ctx.self as any).submitAsyncJob(spec), undefined, ctx.env.SCREENER_EVENTS ?? null);
    const res = await service.autonomousMarketScreen({ ...payload, userLogin: resolvedLogin, environment, trigger });
    if ((res as any).skipped) {
      return (outcome = { outcome: "skipped", detail: "service skipped" });
    }
    // Issue #212: persist the run for the "last results" UX endpoint.
    try {
      const key = "screener:last_runs";
      const existing = ((await ctx.agentCtx.storage.get(key)) as any[]) || [];
      const run = {
        timestamp: res.timestamp,
        // Issue #2062: the scheduled callback records its own trigger so
        // the run's type is data, not a guess from its provenance.
        trigger: "scheduled",
        // Issue #2908 (G1): the schedule id rides the canonical
        // body when the schedule payload carries one — never
        // fabricated when it does not.
        ...(typeof payload?.scheduleId === "string" ? { scheduleId: payload.scheduleId } : {}),
        sector: res.data?.sector || payload?.sector || "ALL",
        universe: res.data?.universe || payload?.universe || "NASDAQ100",
        // Issue #1007: provider provenance rides into the stored run
        // and the canonical report body below.
        provider: res.data?.provider || payload?.provider || "etrade",
        success: res.success,
        totalScanned: res.data?.totalScanned ?? 0,
        matchedCount: res.data?.matchedCount ?? 0,
        // Issue #261: opportunities arrive pre-shaped from ScreenerAgent.
        opportunities: res.data?.opportunities || [],
        // Issue #253: full scanned set so the panel can render the
        // per-symbol data table. Already shaped by the shared pipeline.
        allStocks: res.data?.allStocks || [],
        pdfKey: res.data?.pdfKey,
        pdfStatus: res.data?.pdfStatus,
        pdfError: res.data?.pdfError,
        xlsxKey: res.data?.xlsxKey,
        xlsxStatus: res.data?.xlsxStatus,
        xlsxError: res.data?.xlsxError,
        csvKey: res.data?.csvKey,
        csvStatus: res.data?.csvStatus,
        csvError: res.data?.csvError,
        // Issue #1355: a queued sharded chain has no outcome yet —
        // last_runs records the chain id, and the canonical row is
        // skipped (the chain's store shards write the per-format
        // rows when they run).
        queued: res.data?.sharded ? true : undefined,
        chainId: res.data?.chainId,
        error: res.success ? undefined : res.error,
      };
      await ctx.agentCtx.storage.put(key, [run, ...existing].slice(0, 20));
      // Issue #278: persist the scheduled run's report durably
      // (mas_reports) so the NextGenTP agent can surface it later.
      // Issue #308: through the single generate→store seam — one
      // canonical row per generation (generationId = run id).
      // Skipped for queued sharded chains (see above).
      if (!res.data?.sharded && userLogin) {
      const stored = orm.storeCanonicalReport({
        runId: `screener:${res.timestamp}`,
        generationId: `screener:${res.timestamp}`,
        title: `Autonomous market screen — ${res.data?.universe || payload?.universe || "NASDAQ100"}`,
        source: "screener",
        summary: res.success
          ? `Scanned ${run.totalScanned} symbols, ${run.matchedCount} matched, ${run.opportunities.length} opportunities.`
          : `Scheduled screen failed: ${res.error ?? "unknown error"}.`,
        body: {
          ...run,
          pdfKey: run.pdfKey,
          runSource: "stock",
          reportUrl: run.pdfKey
            ? `${ctx.env.APP_BASE_URL || "https://agent.openaimp.com"}/api/screener/report.pdf?key=${encodeURIComponent(String(run.pdfKey))}`
            : undefined,
        },
        createdAt: res.timestamp,
        userLogin,
      },
      // Issue #1169 S4-1: thread ctx.env so the seam indexes this
      // screener row at write time.
      ctx.env);
      // Issue #2178 (Q7 S2): the canonical store never throws — null
      // IS its failure signal. Ignoring it (the old behavior) made a
      // run with no stored report read exactly like a stored one.
      // Record the failure visibly instead; no throw, preserving
      // this callback's deliberate no-throw contract.
      if (!stored) {
        recordReportStoreFailure(orm, { runId: `screener:${res.timestamp}`, userLogin });
      }
      }
    } catch {
      // Non-critical: persistence failure must not break the screen.
    }
    if (res.success && res.data?.opportunities && res.data.opportunities.length > 0) {
      if (typeof (ctx.self as any).broadcast === "function") {
        try {
          (ctx.self as any).broadcast(
            JSON.stringify({
              type: "market_alert",
              title: "Autonomous Screener Alert",
              count: res.data.opportunities.length,
              opportunities: res.data.opportunities,
              timestamp: res.timestamp,
            })
          );
        } catch {
          // Non-critical broadcast error
        }
      }
    } else if (!res.success) {
      // Failure surfacing (issue #112): a failed screen used to vanish
      // silently. The service now audits it and records a session
      // message; broadcast the failure too so live clients see it.
      // Deliberately no throw: platform callback retry is not used
      // for scheduled jobs — see the failure contract on
      // ScheduledTasksService.
      if (typeof (ctx.self as any).broadcast === "function") {
        try {
          (ctx.self as any).broadcast(
            JSON.stringify({
              type: "market_alert",
              title: "Autonomous Screener Failed",
              success: false,
              sector: payload?.sector,
              error: res.error,
              timestamp: res.timestamp,
            })
          );
        } catch {
          // Non-critical broadcast error
        }
      }
    }
    // Issue #2964: the run's outcome for the recording wrapper.
    return (outcome = res.success
      ? {
          outcome: "success",
          descriptor: `Scanned ${res.data?.totalScanned ?? 0} symbols, ${res.data?.matchedCount ?? 0} matched, ${res.data?.opportunities?.length ?? 0} opportunities.`,
          artifactRefs: [res.data?.pdfKey, res.data?.xlsxKey, res.data?.csvKey].filter(
            (k): k is string => typeof k === "string",
          ),
        }
      : { outcome: "failure", error: res.error ?? "scheduled screen failed" });
  };

  if (typeof (ctx.self as any).keepAliveWhile === "function") {
    await (ctx.self as any).keepAliveWhile(runScreen);
  } else {
    await runScreen();
  }
  return outcome;
}

/**
 * Cloudflare Agents Scheduled Callback: Goal-Driven Screen
 * (consolidation C1, issue #1201, epic #1151 R1). Runs the schedule
 * payload's goal/scenario screen through the Phase 0 registry +
 * Phase 3 semantics via ScheduledTasksService.autonomousGoalScreen.
 * Mirrors the autonomousMarketScreen wrapper: the payload login and
 * environment win when present, with the saved execution context as
 * the legacy fallback (#1965); unowned scheduled fires are
 * skipped, and results AND failures are broadcast (issue #112) — the
 * service itself audits, records the canonical report + activity
 * entry, and delivers over the Phase 6 channels when the payload
 * asks. Deliberately no throw: see the failure contract on
 * ScheduledTasksService.
 */
export async function autonomousGoalScreen(ctx: ScheduledCallbacksContext, payload?: {
  goalKind?: string;
  direction?: string;
  scenarioId?: string;
  symbols?: string[];
  assetClasses?: ("stocks" | "options")[];
  trigger?: "manual" | "scheduled";
  userLogin?: string;
  environment?: ETradeEnvironment;
  emailTo?: string;
  slackChannel?: string;
  pushToSlack?: boolean;
  /** Consolidation C4 (#1329): stage-chain config from the schedule
   *  payload, forwarded to the service (spread into the service call
   *  below) so a completed goal screen bridges generate + serve. */
  stageChain?: import("../../types").StageChainConfig;
  /** Issue #2373 (slice C): schedule kind + submission
   *  authorization, carried through the {...payload} spread to
   *  ScheduledTasksService.autonomousGoalScreen (which already
   *  declared these options; the wrapper type did not). Absent
   *  fails closed to recurring at the tick. */
  scheduleKind?: "one_off" | "recurring";
  authorizedAtSubmission?: boolean;
}): Promise<ScheduledCallbackOutcome> {
  try {
    await ctx.waitUntilStable({ timeout: 30_000 });
  } catch {
    // Continue if timeout or unhandled
  }
  // Issue #2964: outcome stash, same pattern as autonomousMarketScreen.
  let outcome: ScheduledCallbackOutcome = { outcome: "skipped", detail: "callback did not run" };
  const runGoalScreen = async (): Promise<ScheduledCallbackOutcome> => {
    const trigger = payload?.trigger || "scheduled";
    const savedContext = await ctx.getScreenerExecutionContext();
    const userLogin = resolveScheduledLogin(payload?.userLogin, savedContext?.userLogin);
    const environment = payload?.environment || savedContext?.environment;
    // #2331 slice 2: dispatch enforcement, before the service. A
    // denied dispatch audits and returns; the unowned scheduled case
    // keeps its existing remove-the-schedule behavior, now audited.
    const dispatch = await resolveCallbackDispatch(ctx, userLogin, false);
    if ("denied" in dispatch) {
      auditCallbackDenial(ctx, "autonomousGoalScreen", dispatch);
      if (trigger === "scheduled" && dispatch.reason === "NO_IDENTITY") {
        await ctx.removeUnownedBaselineSchedules();
        structuredLog.warn("scheduledCallbacks.goal_screen_skipped_no_owner", {
          message: "[OrchestratorAgent] Skipping unowned scheduled goal screen.",
        });
      }
      return (outcome = { outcome: "skipped", detail: `dispatch denied (${dispatch.reason})` });
    }
    const resolvedLogin = dispatch.login;
    const service = new ScheduledTasksService(ctx.env, ctx.getOrm(), resolvedLogin, createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns, undefined, undefined, undefined, ctx.scheduleScreenerFollowups, { sql: ctx.agentCtx.storage.sql, blobStorage: ctx.agentCtx.storage as any, env: ctx.env }, undefined, undefined, ctx.env.SCREENER_EVENTS ?? null);
    const res = await service.autonomousGoalScreen({ ...payload, userLogin: resolvedLogin, environment, trigger });
    if ((res as any).skipped) {
      return (outcome = { outcome: "skipped", detail: "service skipped" });
    }
    if (typeof (ctx.self as any).broadcast === "function") {
      try {
        (ctx.self as any).broadcast(
          JSON.stringify(
            res.success
              ? {
                  type: "goal_screen_alert",
                  title: "Autonomous Goal Screen",
                  success: true,
                  goalKind: res.data?.goalKind || payload?.goalKind,
                  status: res.data?.status,
                  hits: res.data?.hits,
                  taskId: res.data?.taskId,
                  timestamp: res.timestamp,
                }
              : {
                  type: "goal_screen_alert",
                  title: "Autonomous Goal Screen Failed",
                  success: false,
                  goalKind: payload?.goalKind,
                  error: res.error,
                  timestamp: res.timestamp,
                }
          )
        );
      } catch {
        // Non-critical broadcast error
      }
    }
    // Issue #2964: the run's outcome for the recording wrapper.
    return (outcome = res.success
      ? {
          outcome: "success",
          descriptor: `goal screen ${res.data?.goalKind || payload?.goalKind || ""} ${res.data?.status || ""} (hits: ${res.data?.hits ?? 0})`.trim(),
        }
      : { outcome: "failure", error: res.error ?? "goal screen failed" });
  };

  if (typeof (ctx.self as any).keepAliveWhile === "function") {
    await (ctx.self as any).keepAliveWhile(runGoalScreen);
  } else {
    await runGoalScreen();
  }
  return outcome;
}

/**
 * Cloudflare Agents Scheduled Callback: Scheduled Strategy Discovery
 * (issue #126, PR-E). Re-runs the schedule payload's SAVED
 * StrategyRequests verbatim through the discovery pipeline and
 * persists the run (SqlDiscoveryRunStore) for the panel to read
 * back. Mirrors the autonomousOptionsAnalysis wrapper: the payload
 * login and environment win when present, with the saved execution
 * context as the legacy fallback (#1965); unowned
 * scheduled fires are skipped, duplicate fires within the same
 * minute slot for the same saved-request set are suppressed, and
 * results AND failures are broadcast (issue #112) — the service
 * itself audits and records the session message. Deliberately no
 * throw: see the failure contract on ScheduledTasksService.
 */
export async function autonomousStrategyDiscovery(ctx: ScheduledCallbacksContext, payload?: AutonomousStrategyDiscoveryOptions): Promise<ScheduledCallbackOutcome> {
  try {
    await ctx.waitUntilStable({ timeout: 30_000 });
  } catch {
    // Continue if timeout or unhandled
  }
  // Issue #2964: outcome stash, same pattern as autonomousMarketScreen.
  let outcome: ScheduledCallbackOutcome = { outcome: "skipped", detail: "callback did not run" };
  const runDiscovery = async (): Promise<ScheduledCallbackOutcome> => {
    const savedContext = await ctx.getScreenerExecutionContext();
    const userLogin = resolveScheduledLogin(payload?.userLogin, savedContext?.userLogin);
    const environment = payload?.environment || savedContext?.environment;
    // #2331 slice 2: dispatch enforcement, before the slot logic, so a
    // denied dispatch writes no slot keys and constructs no service.
    // The unowned non-manual case keeps its existing remove behavior,
    // now audited; a denied service dispatch preserves the schedule.
    const dispatch = await resolveCallbackDispatch(ctx, userLogin, false);
    if ("denied" in dispatch) {
      auditCallbackDenial(ctx, "autonomousStrategyDiscovery", dispatch);
      if (payload?.trigger !== "manual" && dispatch.reason === "NO_IDENTITY") {
        await ctx.removeUnownedBaselineSchedules();
        structuredLog.warn("scheduledCallbacks.strategy_discovery_skipped_no_owner", {
          message: "[OrchestratorAgent] Skipping unowned scheduled strategy discovery.",
        });
      }
      return (outcome = { outcome: "skipped", detail: `dispatch denied (${dispatch.reason})` });
    }
    const resolvedLogin = dispatch.login;
    if (payload?.trigger !== "manual") {
      // Duplicate-fire suppression, keyed on the saved-request set
      // (not a thesis): the same schedule re-firing inside one
      // minute slot is a platform duplicate; a different request
      // set in the same minute is a different run and proceeds.
      // Issue #533: profile-derived payloads carry no requests —
      // the slot keys on the derived identity (input model, symbol
      // source, profile) instead, so two different derived
      // schedules in the same minute never suppress each other.
      // Saved-request payloads hash exactly as before. Issue #534:
      // no-view payloads carry no requests either — their
      // constraint sets join the key the same way (absent on the
      // other models, where JSON.stringify drops the key and the
      // hash is unchanged).
      const slot = new Date().toISOString().slice(0, 16);
      const requestsJson = JSON.stringify(
        payload?.requests ?? {
          inputModel: payload?.inputModel,
          symbols: payload?.symbols,
          watchlistName: payload?.watchlistName,
          profileId: payload?.profileId,
          constraintSets: payload?.constraintSets,
        }
      );
      let hash = 0;
      for (let i = 0; i < requestsJson.length; i++) {
        hash = ((hash << 5) - hash + requestsJson.charCodeAt(i)) | 0;
      }
      const slotKey = `${resolvedLogin}:${slot}:${(hash >>> 0).toString(36)}`;
      ctx.scheduledDiscoverySlots ??= new Set<string>();
      if (ctx.scheduledDiscoverySlots.has(slotKey)) {
        return (outcome = { outcome: "skipped", detail: "duplicate minute slot (in-memory)" });
      }
      if (ctx.scheduledDiscoverySlots.size > 32) ctx.scheduledDiscoverySlots.clear();
      ctx.scheduledDiscoverySlots.add(slotKey);
      const key = `discovery:scheduled:last-slot:${(hash >>> 0).toString(36)}`;
      const last = await ctx.agentCtx.storage.get<{ slot: string; userLogin: string }>(key);
      if (last?.slot === slot && last?.userLogin === resolvedLogin) {
        structuredLog.warn("scheduledCallbacks.strategy_discovery_duplicate_suppressed", {
          message: `[OrchestratorAgent] Suppressing duplicate scheduled strategy discovery in ${slot}Z`,
          slot,
        });
        return (outcome = { outcome: "skipped", detail: "duplicate minute slot (persistent)" });
      }
      await ctx.agentCtx.storage.put(key, { slot, userLogin: resolvedLogin });
    }
    // Issue #1661: platformDeps threads the DO storage handle so scheduled
    // discovery listings fetch live + capture (behavior change from the
    // missing-seam throw — disclosed, Q3).
    const service = new ScheduledTasksService(
      ctx.env,
      ctx.getOrm(),
      resolvedLogin,
      createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns,
      undefined,
      createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).discoveryRuns,
      createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).strategyProfiles,
      ctx.scheduleScreenerFollowups,
      { sql: ctx.agentCtx.storage.sql, blobStorage: ctx.agentCtx.storage as any, env: ctx.env },
      undefined,
      createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).feedSnapshots, ctx.env.SCREENER_EVENTS ?? null
    );
    const res = await service.autonomousStrategyDiscovery({ ...payload, userLogin: resolvedLogin, environment });
    if ((res as any).skipped) {
      return (outcome = { outcome: "skipped", detail: "service skipped" });
    }
    if (typeof (ctx.self as any).broadcast === "function") {
      try {
        if (res.success && res.data) {
          (ctx.self as any).broadcast(
            JSON.stringify({
              type: "discovery_alert",
              title: "Scheduled Strategy Discovery",
              success: true,
              runId: res.data.runId,
              status: res.data.status,
              symbols: res.data.symbols,
              requestCount: res.data.requestCount,
              completedCount: res.data.completedCount,
              failedCount: res.data.failedCount,
              timestamp: res.timestamp,
            })
          );
        } else if (!res.success) {
          (ctx.self as any).broadcast(
            JSON.stringify({
              type: "discovery_alert",
              title: "Scheduled Strategy Discovery Failed",
              success: false,
              symbols: payload?.requests?.length
                ? payload.requests.map((r) => r?.symbol)
                : (payload?.symbols ?? (payload?.constraintSets ?? []).map((s) => s?.symbol)),
              error: res.error,
              timestamp: res.timestamp,
            })
          );
        }
      } catch {
        // Non-critical broadcast error
      }
    }
    // Issue #2964: the run's outcome for the recording wrapper.
    return (outcome = res.success
      ? {
          outcome: "success",
          descriptor: `discovery run ${res.data?.runId || ""} ${res.data?.status || ""} (${res.data?.completedCount ?? 0} completed, ${res.data?.failedCount ?? 0} failed)`.trim(),
        }
      : { outcome: "failure", error: res.error ?? "strategy discovery failed" });
  };

  if (typeof (ctx.self as any).keepAliveWhile === "function") {
    await (ctx.self as any).keepAliveWhile(runDiscovery);
  } else {
    await runDiscovery();
  }
  return outcome;
}

/**
 * Cloudflare Agents Scheduled Callback: Daily IV History Collection
 * (issue #15). Persists one ATM IV record per tracked name per day;
 * names whose chains fail are reported failed in the run's audit —
 * no record is ever fabricated for a missing day.
 */
export async function collectIvHistory(ctx: ScheduledCallbacksContext, payload?: { symbols?: string[]; environment?: string; userLogin?: string }): Promise<void> {
  try {
    await ctx.waitUntilStable({ timeout: 30_000 });
  } catch {
    // Continue if timeout or unhandled
  }
  const runCollection = async () => {
    const context = await ctx.getScreenerExecutionContext();
    const userLogin = context?.userLogin || payload?.userLogin;
    // #2331 slice 2: IV history is options-chain work, so a service
    // identity never collects it (broker legs fail closed downstream,
    // but denial at dispatch is explicit and audited). The unowned
    // case keeps its existing remove behavior, now audited.
    const dispatch = await resolveCallbackDispatch(ctx, userLogin, true);
    if ("denied" in dispatch) {
      auditCallbackDenial(ctx, "collectIvHistory", dispatch);
      if (dispatch.reason === "NO_IDENTITY") {
        await ctx.removeUnownedBaselineSchedules();
        structuredLog.warn("scheduledCallbacks.iv_collection_skipped_no_owner", {
          message: "[OrchestratorAgent] Skipping IV collection without an authenticated account owner.",
        });
      }
      return;
    }
    const resolvedLogin = dispatch.login;
    const environment = context?.environment || payload?.environment;
    // Issue #2337 cutover (R-2): the collector writes through
    // the env-aware build's IV store — D1 when AGENT_DB is
    // bound — so collected days land in the post-cutover
    // store the read paths serve.
    const service = new ScheduledTasksService(
      ctx.env,
      ctx.getOrm(),
      resolvedLogin,
      createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns,
      (await buildOptionsDiscoveryPorts(ctx.env, { sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage })).ivHistory,
      undefined,
      undefined,
      ctx.scheduleScreenerFollowups, undefined, undefined, undefined, ctx.env.SCREENER_EVENTS ?? null
    );
    const res = await service.collectDailyIvHistory({ symbols: payload?.symbols, environment });
    if (!res.success) {
      structuredLog.warn("scheduledCallbacks.iv_collection_failed", {
        message: "[OrchestratorAgent] collectIvHistory error:",
        error: res.error,
      });
    } else if (typeof (ctx.self as any).broadcast === "function") {
      try {
        (ctx.self as any).broadcast(
          JSON.stringify({
            type: "iv_collection",
            title: "Daily IV History Collection",
            date: res.data?.date,
            recorded: res.data?.recorded,
            alreadyRecorded: res.data?.alreadyRecorded,
            failed: res.data?.failed,
            tracked: res.data?.trackedCount,
            timestamp: res.timestamp,
          })
        );
      } catch {
        // Non-critical broadcast error
      }
    }
  };

  if (typeof (ctx.self as any).keepAliveWhile === "function") {
    await (ctx.self as any).keepAliveWhile(runCollection);
  } else {
    await runCollection();
  }
}

/**
 * Cloudflare Agents Scheduled Callback: Auto-expires a stale unconfirmed order draft
 */
export async function expireStaleOrderDraft(ctx: ScheduledCallbacksContext, payload: { orderId: string; userLogin?: string }): Promise<void> {
  if (!payload?.orderId) return;
  // #2331 slice 2: dispatch enforcement, before construction. Order
  // state is owner-attached: a service identity never expires drafts,
  // and the shared address is never an identity.
  const dispatch = await resolveCallbackDispatch(ctx, payload.userLogin || ctx.sessionKey(), true);
  if ("denied" in dispatch) {
    auditCallbackDenial(ctx, "expireStaleOrderDraft", dispatch);
    return;
  }
  const service = new ScheduledTasksService(ctx.env, ctx.getOrm(), dispatch.login, createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns, undefined, undefined, undefined, ctx.scheduleScreenerFollowups, undefined, undefined, undefined, ctx.env.SCREENER_EVENTS ?? null);
  await service.expireStaleOrderDraft(payload.orderId);
}

/**
 * Cloudflare Agents Scheduled Callback: Dispatches a user reminder
 */
export async function sendScheduledReminder(ctx: ScheduledCallbacksContext, payload: { reminderId: string; message: string; userLogin?: string }): Promise<void> {
  if (!payload?.reminderId) return;
  // #2331 slice 2: dispatch enforcement, before construction. Chat
  // delivery is not brokerage, so a provisioned service identity may
  // deliver; an unprovisioned one and the shared address may not.
  const dispatch = await resolveCallbackDispatch(ctx, payload.userLogin || ctx.sessionKey(), false);
  if ("denied" in dispatch) {
    auditCallbackDenial(ctx, "sendScheduledReminder", dispatch);
    return;
  }
  const service = new ScheduledTasksService(ctx.env, ctx.getOrm(), dispatch.login, createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns, undefined, undefined, undefined, ctx.scheduleScreenerFollowups, undefined, undefined, undefined, ctx.env.SCREENER_EVENTS ?? null);
  const res = await service.dispatchReminder(payload.reminderId, payload.message);
  if (typeof (ctx.self as any).broadcast === "function") {
    try {
      // Issue #123 (F19): the broadcast mirrors the dispatch result —
      // a reminder whose chat-history delivery failed is broadcast in
      // the same message family with success: false + the error (the
      // #112 failure-surfacing pattern), never as a fired reminder.
      (ctx.self as any).broadcast(
        JSON.stringify(
          res.success
            ? {
                type: "scheduled_reminder",
                reminderId: payload.reminderId,
                message: payload.message,
                timestamp: res.timestamp,
              }
            : {
                type: "scheduled_reminder",
                reminderId: payload.reminderId,
                message: payload.message,
                success: false,
                error: res.error,
                timestamp: res.timestamp,
              }
        )
      );
    } catch {
      // Non-critical broadcast error
    }
  }
}
