/**
 * Cloudflare Agents Task Scheduling Service
 *
 * Implements:
 * - Automated E*TRADE OAuth 1.0a access token proactive renewal (daily before midnight ET).
 * - Autonomous periodic market screening & technical opportunity detection.
 * - HITL Order Draft Expiration timer (auto-expiring stale unconfirmed orders after 15m).
 * - Persistent scheduled task reminders with SQLite auditing.
 */

import type { Env, ScheduledTaskResult, StageChainConfig, TradeRecord, ScreenedStockItem } from "../types";
import { DatabaseORM } from "../orm";
import { codedMessage } from "../outcomes/outcomeAspects";
import { renewETradeAccessToken, getStoredTokens, etradeIdentityFromLogin } from "../security/etradeOAuth";
import { getServiceUserLogin } from "../security/serviceIdentity";
import { createMessagingPorts } from "../messaging/createMessagingPorts";
import { toScreenerEnvelope } from "../messaging/screenerEventEnvelope";
import {
  guardScheduledETradeAuth,
  type AuthEpisodeStore,
} from "./etradeAuthPreflight";
import type { ScreenerTrace } from "./screenerTrace";
import { withRetry } from "./resilience";
import { resolvePipelinePolicy } from "./pipelinePolicy";
import { DynamicMarketScreener } from "../trading";
import {
  type ScannedStock,
  type OpportunityStock,
} from "../trading";
import { ETradeService } from "./etrade";
import { hasActiveChain } from "./asyncJobGate";
import { createAsyncJobPorts } from "../data/createAsyncJobPorts";
import {
  isPortfolioContextEnabled,
  settingReadFromSql,
} from "./screeningFlags";
import {
  UnifiedOptionsService,
  runPanelWithAgents,
  type PanelAgents,
  validateStrategyRequest,
  validateNoViewRequest,
  NO_VIEW_EXPECTED_IV_DIRECTION,
  deriveDiscoveryRequest,
  toProfileRef,
  MAX_SAVED_REQUESTS_PER_RUN,
  type NoViewStrategyRequest,
  type OptionThesis,
  type OptionStrategyType,
  type StrategyRequest,
} from "../trading";
import { DEFAULT_SUBREQUEST_BUDGET, getOpportunityScannerConfig } from "../config/etapiConfig";
// Issue #2577: the report scope (theses, strategies, chains, formats,
// channels) is data — config/options-reports.json, env
// OPTIONS_REPORT_CONFIG / OPTIONS_REPORT_PRESET — not a hardcoded default
// in this method. Imported directly rather than through the ../trading
// barrel so the barrel's pinned extraction ledger stays untouched.
import { describeReportScope, resolveOptionsReportScope } from "../trading/optionsReportScope";
import { tagOpportunitiesWithDirection, ETradeSlackTradingService } from "../trading";
// Issue #1291: the scheduled path's unified scan result is an
// OpportunityScanResult, not the OptionScreenResult the workbook
// generator reads — adapt at this seam (XLSX; #1569 applies the
// same adapter at the CSV seam below).
import { adaptOpportunityScanToOptionScreenResult } from "../trading";
import type { ScanRunStore } from "../trading";
import type { ETradeCaptureDeps } from "../trading";
import type {
  DiscoveryConstraintSet,
  DiscoveryRunStatus,
  DiscoveryRunStore,
  DiscoverySymbolOutcome,
  StrategyProfileStore,
} from "../trading";
import {
  buildDiscoveryCanonicalBody,
  generateAndStoreDiscoveryReport,
} from "./discoveryReportPublish";
import type { DiscoveryReportInput } from "../trading";
import {
  resolveFeedSnapshotForSymbol,
  pickFeedLoadParams,
  type FeedSnapshotInput,
  type FeedSnapshotReader,
} from "./feedSnapshotStore";
import { resolvePresetFilter } from "./screenerPresetResolution";
import { DynamicOptionsScreener } from "../trading";
import { OptionsDataAgent, StrategyRiskAgent, RecommendationAgent, type OptionsDataSnapshot } from "../trading";
import { collectIvHistory, flattenWatchlistSymbols, type IvCollectionReport } from "../trading";
import type { IvHistoryStore } from "../trading";
// Issue #278: durable scheduled-run reports for the AI Search agent.
import { getCuratedStockUniverse } from "../config/curatedStockUniverse";
import {
  getCfpayConfig,
  cfpaySendEmail,
  cfpaySendEmailWithAttachments,
} from "./cfpayA2A";
import { ETradeEmailTradingService } from "../trading";
import { ETradeWebhookService } from "./tradingWebhooks";
import { ScreenerEventBus } from "../events/screenerEvents";
import {
  screenerOutcomeFromEvent,
  resolveScreenerFollowupConfig,
  optionsCoverageBelowBroadcastFloor,
  formatDegradedCoverageNotice,
  type ScreenerOutcomeOpportunity,
  type ScreenerRunOutcome,
} from "./screenerFollowups";
import { createFollowupDeliveryPort } from "./screenerFollowupDelivery";
import { deliverDiscoveryDirect } from "./screeningDelivery";
import { recordJobOutcome } from "./jobOutcomes";
import { storeReportStage } from "./unifiedReportPipeline";
import { storeOptionsCanonicalReport } from "./optionsServeRecord";
import { registerScreenerPublishers } from "../events/screenerPublishers";
import { deliverScreenerToSlackA2A } from "./screenerSlackDelivery";
import { getEventCalendarCoverage, getSymbolEventCalendar } from "./eventCalendar";

export interface AutonomousOptionsAnalysisOptions {
  symbols?: string[];
  /** Universe to scan (resolves to symbols via listings; overrides symbols). */
  universe?: string;
  /** Maximum number of live universe listings to analyze; zero means all. */
  maxItems?: number;
  thesis?: OptionThesis;
  targetDate?: string;
  allowedStrategies?: OptionStrategyType[];
  riskProfile?: "conservative" | "balanced" | "aggressive";
  pushToSlack?: boolean;
  slackChannel?: string;
  emailTo?: string;
  webhookUrl?: string;
  environment?: string;
  trigger?: "manual" | "scheduled";
  userLogin?: string;
  /** Issue #2216: the arming schedule's id, when the caller knows it
   *  (recorded as run provenance; the SDK callback path supplies none
   *  — the schedules routes stamp it at arm/trigger time when known). */
  scheduleId?: string;
  /** Consolidation C4 (#1329): per-record stage-chain config — in
   *  chain mode the run bridges fully (bridge deliver jobs carry the
   *  adopted PDF; direct Slack/email delivery is suppressed so the
   *  artifact is delivered exactly once). Absent ⇒ direct path. */
  stageChain?: StageChainConfig;
  /** Execute each underlying as a paced durable shard, then collate once. */
  sharded?: boolean;
}

export interface AutonomousStrategyDiscoveryOptions {
  /** Complete saved StrategyRequests, captured from the discovery
   *  panel and re-run verbatim (issue #126 decision — the system
   *  never derives a target or invents a view for a schedule). */
  requests?: StrategyRequest[];
  /** Input model discriminator (issue #533). Absent or "saved-request"
   *  is the #126 model above; "profile-derived" arms the fields
   *  below instead; "no-view" (issue #534) arms constraintSets —
   *  the service branches on it. The three shapes are mutually
   *  exclusive: a payload mixing them fails pre-execution. */
  inputModel?: "saved-request" | "profile-derived" | "no-view";
  /** Profile-derived model: the explicit symbol set (exactly one of
   *  symbols / watchlistName). */
  symbols?: string[];
  /** Profile-derived model: a watchlist name resolved at fire time
   *  against the schedule owner's stored watchlists. */
  watchlistName?: string;
  /** Profile-derived model: the Strategy Profile id, resolved at
   *  fire time under the schedule owner's identity. */
  profileId?: string;
  /** No-view model (issue #534): constraint sets — one symbol each,
   *  constraints only. No thesis, target, or IV direction exists on
   *  the type; validateNoViewRequest rejects smuggled view fields. */
  constraintSets?: NoViewStrategyRequest[];
  environment?: string;
  trigger?: "manual" | "scheduled";
  userLogin?: string;
  /** The arming schedule's id, when the caller knows it (recorded as
   *  run provenance; the SDK callback path supplies none). */
  scheduleId?: string;
  /** Consolidation #1236 (discovery notifications): per-task delivery
   *  recipients. Carried to the bridge in chain mode and to the direct
   *  delivery in non-chain mode. A task naming no channels plans no
   *  notification — env-configured channels are never added to a
   *  discovery run that did not name them. */
  emailTo?: string;
  slackChannel?: string;
  webhookUrl?: string;
  /** Consolidation #1236 (feed seam): per-task feed input. When
   *  present, generate reads stored snapshot artifacts instead of
   *  live-loading — per symbol, through the panel's snapshot
   *  override. Absent ⇒ the fused live path, unchanged. The no-view
   *  model never calls runDiscoveryRequest, so it ignores this
   *  field — recorded as remainder. */
  snapshotInput?: FeedSnapshotInput;
  /** Consolidation C4 (#1329): per-record stage-chain config — a
   *  completed discovery run bridges generate + serve (canonical
   *  report adoption). Consolidation #1236 notifications: chain mode
   *  ALSO carries delivery — the bridge flips deliverViaChain to
   *  true with the task's own channel fields + a deliveryChannels
   *  allowlist derived from them, and direct delivery is suppressed
   *  in chain mode (goal-pattern exactly-once). A task naming no
   *  channels plans no delivery even in chain mode (empty allowlist).
   *  Failed runs do not bridge: their existing failure-notice path
   *  is channel-divergent from the bridge's, and suppressing it
   *  would risk a lost notice. */
  stageChain?: StageChainConfig;
}

/**
 * Failure contract for scheduled jobs (issue #112 — deliberate; do not
 * "fix" by throwing):
 *
 * These methods NEVER throw to their scheduler caller. A failure is
 * returned as a terminal `{ success: false, error }` result and is
 * surfaced by the service itself — an audit event plus, for user-facing
 * jobs, a session message — and by the OrchestratorAgent callback's
 * broadcast. The Cloudflare Agents SDK retries a THROWING callback by
 * default ({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 3000 }), but
 * that platform retry is deliberately NOT used here: a broker/data
 * failure will not heal within 100ms–3s, and a blind retry could
 * duplicate notifications after a partial success. The async-job
 * plumbing makes the same choice explicitly, passing
 * `retry: { maxAttempts: 1 }` on its schedule() calls. A failed
 * scheduled run stays failed — visible in the audit log, the session,
 * and the broadcast — until its next scheduled fire or a manual
 * trigger.
 */
/**
 * Consolidation #1236 (discovery notifications): map a discovery
 * run's per-symbol outcomes to the delivery surface's opportunity
 * shape — the same top-10 shape stock screens render. Per completed
 * outcome the best trade wins, else the top ranked strategy; the
 * no-view path reads bestNoViewTrade/rankedNoView. Failed outcomes
 * and abstentions (status "abstained", or completed + abstained
 * true on the no-view path) contribute nothing. Only label +
 * underlying price exist on candidates — no company name or change
 * percent is fabricated. Capped at 10 here; the formatter slices to
 * 10 again, so the cap is belt-and-braces.
 */
export function discoveryDeliveryOpportunities(
  outcomes: DiscoverySymbolOutcome[],
): ScreenerOutcomeOpportunity[] {
  const opportunities: ScreenerOutcomeOpportunity[] = [];
  for (const outcome of outcomes) {
    if (outcome.status !== "completed" || outcome.abstained) continue;
    const candidate =
      outcome.bestTrade?.best?.candidate
      ?? outcome.ranked?.[0]?.candidate
      ?? outcome.bestNoViewTrade?.best?.candidate
      ?? outcome.rankedNoView?.[0]?.candidate;
    if (!candidate) continue;
    opportunities.push({
      symbol: outcome.symbol,
      signal: candidate.label,
      lastPrice: candidate.underlyingPrice,
    });
    if (opportunities.length >= 10) break;
  }
  return opportunities;
}

export interface DiscoveryDeliveryOutcomeInput {
  runId: string;
  status: DiscoveryRunStatus;
  inputModel: string;
  symbols: string[];
  summary: string;
  trigger: "manual" | "scheduled";
  matchedCount: number;
  totalScanned: number;
  outcomes: DiscoverySymbolOutcome[];
  reportId?: string;
  /** True when the run carries stageChain (bridge path); false for
   *  the direct path. The direct outcome is never fed to the
   *  planner, but deliverViaChain: false documents that it stays
   *  off the chain. */
  chainMode: boolean;
  stageChain?: ScreenerRunOutcome["stageChain"];
  emailTo?: string;
  slackChannel?: string;
  webhookUrl?: string;
}

/**
 * Consolidation #1236 (discovery notifications): build the one
 * delivery outcome for a discovery run, shared by both phases —
 * chain mode (bridge carries it to the planner) and direct mode
 * (delivered through the port inside the run). Chain mode derives
 * the deliveryChannels allowlist from the task's own fields in
 * CHANNEL_ORDER; a task naming no channels gets an empty allowlist
 * and plans nothing. reportUrl wires to the run's real detail
 * address (GET /api/etrade/options/discovery-runs/:id) — no UI
 * deep-link exists for a run, so none is invented.
 */
export function buildDiscoveryDeliveryOutcome(
  input: DiscoveryDeliveryOutcomeInput,
): ScreenerRunOutcome {
  const channels: NonNullable<ScreenerRunOutcome["deliveryChannels"]> = [];
  if (input.slackChannel) channels.push("slack");
  if (input.emailTo) channels.push("email");
  if (input.webhookUrl) channels.push("webhook");
  const outcome: ScreenerRunOutcome = {
    kind: "discovery",
    trigger: input.trigger,
    success: input.status !== "failed",
    thesis: `Strategy discovery (${input.inputModel}) — ${input.symbols.join(", ")}`,
    summary: input.summary,
    pdfKeys: [],
    canonicalReportId: input.reportId,
    matchedCount: input.matchedCount,
    totalScanned: input.totalScanned,
    opportunities: discoveryDeliveryOpportunities(input.outcomes),
    reportUrl: `/api/etrade/options/discovery-runs/${input.runId}`,
    emailTo: input.emailTo,
    slackChannel: input.slackChannel,
    webhookUrl: input.webhookUrl,
    deliverViaChain: input.chainMode,
  };
  if (input.chainMode) {
    outcome.deliveryChannels = channels;
    outcome.stageChain = input.stageChain;
  }
  return outcome;
}


export class ScheduledTasksService {
  constructor(
    private env: Env,
    private orm: DatabaseORM | undefined,
    // Issue #1185: the service runs under its owner's explicit login.
    private userLogin: string,
    private scanRunStore?: ScanRunStore,
    private ivHistoryStore?: IvHistoryStore,
    private discoveryRunStore?: DiscoveryRunStore,
    private strategyProfileStore?: StrategyProfileStore,
    /** Issue #1123 S5b: the follow-up bridge. When the host wires it,
     *  screener events join the tracked job pipeline instead of the
     *  private event bus (stock chains fully; options bridge fully in
     *  chain mode — C4 #1329 — and record-only otherwise, because
     *  unchained options delivery stays on the #223 direct path). */
    private followupScheduler?: (
      outcome: import("./screenerFollowups").ScreenerRunOutcome,
      userLogin: string,
      chainReport: boolean,
    ) => Promise<void>,
    /** Issue #1157 (E2): data-provider platform deps for the
     *  scheduled options path, supplied by the orchestrator-side
     *  constructors that own a Durable Object storage handle (the
     *  same storage the injected scanRunStore is built over).
     *  Forwarded to UnifiedOptionsService; absent, scheduled scans
     *  run exactly as before (raw client, no capture). */
    private platformDeps?: ETradeCaptureDeps,
    /** Issue #1355: async-job submission port for sharded chains.
     *  Wired by the orchestrator to submitAsyncJob; absent, a
     *  sharded run fails honestly instead of running unsharded
     *  under a sharded label. */
    private shardSubmit?: (
      spec: import("../types").AsyncJobSubmission
    ) => Promise<{ jobId: string; status: "queued"; statusUrl: string }>,
    /** Consolidation #1236 (feed seam): the feed artifact reader
     *  for snapshot-input mode. Wired by the orchestrator-side
     *  constructors that own a Durable Object storage handle.
     *  Absent, a run naming snapshotInput fails its symbols
     *  honestly ("feed snapshot store not configured") instead of
     *  silently live-loading. */
    private feedSnapshotStore?: FeedSnapshotReader,
  ) {}

  /**
   * Issue #781: build the E*TRADE service for the scheduled options
   * flows (discovery variants, IV collection). The injected ORM is
   * forwarded as-is; these flows use the service's REST client, and
   * the ORM reaches only its trading platform, whose contract is
   * explicitly optional with every access guarded — so without an
   * ORM, platform persistence is honestly absent. The former stub
   * fallback (an ORM whose exec returns an empty array for every
   * query) made the platform believe persistence existed while
   * discarding every write. When no ORM is present, construct
   * env-first: ETradeService's orm-first overload would otherwise
   * drop the env argument.
   */
  private createETradeService(userLogin: string, environment?: string): ETradeService {
    return this.orm
      ? new ETradeService(this.orm, this.env, userLogin, environment)
      : new ETradeService(this.env, undefined, userLogin, environment);
  }

  /**
   * Issue #1378: the route-bound universe deps for scheduled
   * options discovery (full capture via platformDeps when its blob
   * handle is present, outcome-only otherwise — the same split as
   * the options_analysis site). Undefined when no platform store
   * is configured or the bundle cannot be built; discovery then
   * throws naming the seam rather than fetching directly. The run
   * id is minted per call (decision D2 recorded exception: these
   * discovery sites have no caller run id).
   */
  private async scheduledUniverseDeps(
    userLogin: string
  ): Promise<import("../trading").NasdaqUniverseDeps | undefined> {
    if (!this.platformDeps?.sql) return undefined;
    try {
      const {
        nasdaqUniverseRouteBundle,
        nasdaqUniverseProviderFromRoute,
        bindNasdaqUniverseDeps,
      } = await import("../trading");
      const bundle = await nasdaqUniverseRouteBundle({
        sql: this.platformDeps.sql as never,
        ...(this.platformDeps.blobStorage
          ? { storage: this.platformDeps.blobStorage as never }
          : {}),
        env: this.platformDeps.env as never,
        userLogin,
        runId: crypto.randomUUID(),
      });
      const provider = nasdaqUniverseProviderFromRoute(
        bundle.registry,
        bundle.configs,
        bundle.routes
      );
      return bindNasdaqUniverseDeps(provider, bundle.runContext);
    } catch (err) {
      console.warn(
        `[scheduled] universe deps unavailable, options discovery degrades to the missing-seam throw: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }

  /**
   * ScreenerAgent stub (issue #261) — one agent owns all screening.
   */
  private getScreenerAgent(userLogin = this.userLogin): import("../agents/screener-agent").ScreenerAgent {
    // Issue #1185: the bare "default" instance name belongs to the
    // configured service identity — the only login that maps to it.
    const serviceUserLogin = getServiceUserLogin(this.env);
    const id = (this.env as any).SCREENER_AGENT.idFromName(
      serviceUserLogin && userLogin === serviceUserLogin ? "default" : `screener:${userLogin}`
    );
    return (this.env as any).SCREENER_AGENT.get(id);
  }

  /**
   * Issue #1333: discovery outcomes into the job-outcome sink.
   * Guarded on platformDeps.sql and never throwing — a sink failure
   * must not fail the discovery run.
   */
  private recordDiscoveryOutcome(input: {
    id: string;
    trigger: "manual" | "scheduled";
    status: "completed" | "failed" | "partial";
    scanned?: number;
    matched?: number;
    codedError?: string;
    createdAt?: string;
  }): void {
    try {
      const sql = this.platformDeps?.sql;
      if (!sql) return;
      recordJobOutcome(sql, {
        kind: "discovery",
        origin: "discovery",
        ...input,
      });
    } catch (err) {
      console.warn("[ScheduledTasksService] discovery outcome record failed:", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Helper to append an audit event into mas_events if ORM is available
   */
  private audit(type: string, payload: Record<string, unknown>): void {
    if (!this.orm?.events) return;
    try {
      // Issue #1999 (D7): this service runs system-path executions
      // only (cron/bridge/scheduled), so every row it writes is a
      // system-principal row for the run owner — never a session
      // row, never a defaulted identity. G-AUD-3, applied.
      this.orm.events.create({
        id: crypto.randomUUID(),
        sessionId: this.userLogin,
        type,
        agent: "orchestrator",
        payload: { ...payload, principalKind: "system" },
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      // Issue #1999: an audit insertion failure is fail-visible,
      // never silent — the warn carries type + login on the
      // worker-log channel. The run's outcome is unchanged: the
      // audit store is the record, not the run.
      console.warn(
        `[ScheduledTasksService] Audit insertion failed (type=${type}, login=${this.userLogin}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Issue #1174 (#1173 S1): the scheduled-run auth guard. Delegates
   * the policy to etradeAuthPreflight (verify → renew → block) with
   * this host's seams: the episode dedup store rides platformDeps'
   * blob storage (the host DO storage, when the host supplied it) and
   * the alert/record path is the follow-up bridge plus a direct Slack
   * alert inside the guard. Never throws.
   *
   * Issue #2440: the run-as login resolves to its session identity
   * via the alias record before the guard runs, so tokens stored
   * under internal-id or alias-login keys resolve exactly as the
   * panel seam resolves them. The login is already trusted here —
   * it is the schedule's owner login — and an unresolvable login
   * yields an empty identity, keeping today's login-only lookup
   * (the helper never throws: a store blip falls back to {}).
   */
  private async guardScheduledAuth(
    userLogin: string,
    environment: string | undefined,
    kind: "stock" | "options",
    label: string,
    trace?: ScreenerTrace
  ): Promise<{ blocked: true; error: string; alerted: boolean } | { blocked: false }> {
    const blob = this.platformDeps?.blobStorage as unknown as
      | AuthEpisodeStore
      | undefined;
    const store =
      blob && typeof blob.get === "function" && typeof blob.put === "function"
        ? blob
        : undefined;
    const identity = await etradeIdentityFromLogin(this.env, userLogin);
    const res = await guardScheduledETradeAuth({
      env: this.env,
      userLogin,
      environment,
      identity,
      store,
      bridge: this.followupScheduler,
      kind,
      label,
      trace,
    });
    if (res.blocked) {
            // Issue #2216: the audit event carries the trace fields, so the
      // run is attributable from the audit side too (the guard alert
      // and the failure legs carry the same trace from the message side).
      this.audit("etrade.auth_blocked", {
        userLogin,
        kind,
        alerted: res.alerted,
        ...(trace
          ? {
              runId: trace.runId,
              scheduleId: trace.scheduleId,
              workflow: trace.workflow,
              stage: trace.stage,
          }
          : {}),
      });
      return { blocked: true, error: res.error, alerted: res.alerted };
    }
    return { blocked: false };
  }

  /**
   * Issue #210: publish a screener event to the bus, registering the
   * Slack/email/webhook subscribers on first use. Never throws.
   */
  private screenerBus?: ScreenerEventBus;
  private async publishScreenerEvent(
    event: import("../events/screenerEvents").ScreenerEvent
  ): Promise<void> {
    try {
      // Issue #1123 S5b: the tracked pipeline is the preferred sink —
      // the run is recorded as a main job and chained (report →
      // deliveries → notifications) exactly like an interactive
      // screen. The bus remains for hosts that don't wire the bridge.
      if (this.followupScheduler) {
        // Consolidation C4 (#1329): a chained event bridges fully —
        // options in chain mode, and any screener event carrying a
        // stage-chain config. Unchained options events stay
        // record-only (chainReport=false); their delivery stays on
        // the #223 direct path.
        await this.followupScheduler(
          screenerOutcomeFromEvent(event, this.env.APP_BASE_URL),
          this.userLogin,
          Boolean((event as { stageChain?: unknown }).stageChain) || event.type.startsWith("screener."),
        );
        return;
      }
      // Issue #1739: the durable queue is primary for the two
      // bus-subscribed event types (screener.completed / screener.failed
      // — screener.md §8.1). options.* events keep the legacy bus path:
      // they have no bus subscribers today, and their delivery stays on
      // the #223 direct path. The bus fallback below runs only when no
      // subscriber stream received the event, so an event is never
      // delivered twice and never lost in-process.
      if (event.type.startsWith("screener.")) {
        try {
          const ports = createMessagingPorts(this.env);
          if (ports) {
            const report = await ports.publisher.publish(
              toScreenerEnvelope(event, this.userLogin)
            );
            if (report.deliveredTo.length > 0) return;
            console.warn(
              "[ScheduledTasksService] queue publish reached no subscriber stream — falling back to the in-process bus."
            );
          }
        } catch (err) {
          console.warn(
            "[ScheduledTasksService] queue publish failed, falling back to the in-process bus:",
            err instanceof Error ? err.message : String(err)
          );
        }
      }
      if (!this.screenerBus) {
        this.screenerBus = new ScreenerEventBus();
        registerScreenerPublishers(this.screenerBus, {
          env: this.env,
          orm: this.orm,
          userLogin: this.userLogin,
        });
      }
      await this.screenerBus.publish(event);
    } catch (err) {
      console.warn(
        "[ScheduledTasksService] screener event publish failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Proactively renews E*TRADE OAuth 1.0a access tokens before midnight ET expiry
   */
  async autoRenewETradeTokens(
    targetUser?: string,
    targetEnv?: string
  ): Promise<ScheduledTaskResult<{ renewed: boolean; userLogin: string; expiresAt?: string; message?: string }>> {
    const timestamp = new Date().toISOString();
    const user = targetUser || this.userLogin;

    try {
      // Issue #2442 S3: the run-as login resolves to its session identity
      // via the alias record before the token read, so tokens stored
      // under internal-id or alias-login keys resolve exactly as the
      // panel seam resolves them. The login is already trusted here —
      // it is the schedule's owner login — and an unresolvable login
      // yields an empty identity, keeping today's login-only lookup
      // (the helper never throws: a store blip falls back to {}).
      const identity = await etradeIdentityFromLogin(this.env, user);
      const storedTokens = await getStoredTokens(this.env, user, targetEnv, identity);
      if (!storedTokens) {
        return {
          success: true,
          taskType: "etrade_token_renewal",
          data: {
            renewed: false,
            userLogin: user,
            message: `No active E*TRADE tokens found in storage for user [${user}].`,
          },
          timestamp,
        };
      }

      const renewed = await renewETradeAccessToken(this.env, user, targetEnv, identity);
      if (!renewed) {
        this.audit("etrade.token_auto_renew_failed", {
          userLogin: user,
          environment: targetEnv || "default",
          reason: "Upstream renewal rejected or token already expired past midnight ET",
        });

        return {
          success: false,
          taskType: "etrade_token_renewal",
          error: `E*TRADE access token renewal rejected or expired for user [${user}].`,
          timestamp,
        };
      }

      this.audit("etrade.token_auto_renewed", {
        userLogin: user,
        environment: renewed.environment,
        storedAt: renewed.storedAt,
      });

      return {
        success: true,
        taskType: "etrade_token_renewal",
        data: {
          renewed: true,
          userLogin: user,
          expiresAt: renewed.storedAt,
          message: `E*TRADE access token renewed successfully for [${user}].`,
        },
        timestamp,
      };
    } catch (err: any) {
      this.audit("etrade.token_auto_renew_error", {
        userLogin: user,
        error: err.message,
      });

      return {
        success: false,
        taskType: "etrade_token_renewal",
        error: err.message || "Failed to renew E*TRADE access token",
        timestamp,
      };
    }
  }

  /**
   * Runs an autonomous market screen via ScreenerAgent (#261).
   * One agent owns all screening; E*TRADE-only data with honest failure.
   */
  /**
   * Issue #1355: scheduled stock screen as sharded jobs. This
   * branch does NOT run the screen — it submits the chain's first
   * shard (feed.nasdaq) through the orchestrator's async-job
   * submission port, and the executor's completion hooks advance
   * the chain (nasdaq → etrade → yahoo → assemble → pdf/xlsx/csv
   * → store → serve → deliver). The monolithic path below is
   * untouched when the flag is absent; off runs keep today's
   * behaviour exactly.
   *
   * Composition supersedes the single-provider option here: the
   * feed shards fetch nasdaq (universe) + etrade (quotes) + yahoo
   * (gap-fill quotes for symbols etrade missed + history
   * technicals), and assemble merges them — the same dataset the
   * monolithic path screens, with per-element provenance.
   *
   * No screener.completed event is published at submission: the
   * run has no outcome yet, and publishing one would make the
   * follow-up bridge record a second main job + a second report
   * chain (double delivery). The chain IS the record — its
   * completion announces via the tracked pipeline's delivered
   * notifications, and its store shards write the mas_reports
   * rows. The caller (scheduledCallbacks) records last_runs with
   * the chain id and skips the canonical-row write, which the
   * store shards own.
   *
   * Requires the shard-submit port (wired by the orchestrator to
   * submitAsyncJob). Without it the run fails honestly instead of
   * running unsharded under a sharded label.
   */
  private async autonomousMarketScreenSharded(
    options: {
      sector?: string;
      universe?: string;
      maxItems?: number;
      userLogin?: string;
      environment?: "TEST" | "PROD";
      trigger?: "manual" | "scheduled";
      emailTo?: string;
      slackChannel?: string;
      webhookUrl?: string;
      pushToSlack?: boolean;
      filters?: import("../types").StockScreenerFilter;
      stageChain?: import("../types").StageChainConfig;
    },
    userLogin: string,
    timestamp: string
  ): Promise<ReturnType<ScheduledTasksService["autonomousMarketScreen"]>> {
    const universe = (options.universe as any) || "TECH";
    const sector = options.sector || options.filters?.sector || "ALL";
    if (!this.shardSubmit) {
      // Issue #1412 (mirror of #1369): a missing-port run is a
      // failure, not a quiet return — throw so the caller's catch
      // runs the full failure path (audit + session message +
      // screener.failed bus event). The run still never executes
      // unsharded under a sharded label.
      throw new Error("Sharded runs require the async-job submission port; run unsharded or configure the host.");
    }
    // Issue #1993: sharded chains bypass runScreen, so they never
    // acquire the run lock. Refuse submission while a monolithic run
    // holds it (probed on the same per-owner ScreenerAgent stub) or
    // while another chain for the same user + universe is still
    // active in this instance's mas_async_jobs rows (platformDeps.sql
    // is that same storage; absent, only the lock probe applies). A
    // refused submission returns the skipped shape the caller already
    // honors — no new run, no duplicate Slack partial. The probe is
    // best-effort: if the stub cannot answer (test doubles, missing
    // binding), the run proceeds ungated rather than failing on gate
    // machinery — the pre-#1993 behavior, never a new failure mode.
    let lockHeld = false;
    try {
      const running = await this.getScreenerAgent(userLogin).isScreenRunning(universe, userLogin);
      lockHeld = running.running;
    } catch {
      console.warn("[ScheduledTasksService] Screen-run lock probe unavailable; proceeding without the gate (#1993).");
    }
    if (lockHeld) {
      return { success: true, taskType: "market_screen", skipped: true, skippedReason: "already-running", sharded: true, timestamp } as any;
    }
    if (this.platformDeps?.sql) {
      let activeChain = false;
      try {
        // #2358 (#1976 step 4a): the gate's payload scan serves
        // through the async-job read port (activeJobPayloads in
        // src/data/asyncJobPorts.ts executes the same statement).
        const rows = createAsyncJobPorts(this.platformDeps.sql as never).read.activeJobPayloads() as unknown as Array<Record<string, unknown>>;
        activeChain = hasActiveChain(rows, userLogin, universe);
      } catch {
        // A gate read failure must not wedge submissions: proceed, and
        // the lock probe above remains the primary guard.
      }
      if (activeChain) {
        return { success: true, taskType: "market_screen", skipped: true, skippedReason: "already-running", sharded: true, timestamp } as any;
      }
    }
    try {
      const { planFeedStart } = await import("./shardJobs");
      const channels = [
        ...(options.emailTo ? ["email"] : []),
        ...(options.pushToSlack !== false ? ["slack"] : []),
        ...(options.webhookUrl ? ["webhook"] : []),
      ] as import("../types").AsyncJobChannel[];
      const chainId = crypto.randomUUID();
      const submitted = await this.shardSubmit(
        planFeedStart({
          chainId,
          universe,
          userLogin,
          environment: options.environment,
          trigger: options.trigger || "scheduled",
          maxItems: options.maxItems,
          timestamp,
          channels,
          emailTo: options.emailTo,
          slackChannel: options.slackChannel,
          webhookUrl: options.webhookUrl,
          stageChain: options.stageChain,
        })
      );
      this.audit("screener.sharded_chain_submitted", {
        sector,
        universe,
        chainId,
        jobId: submitted.jobId,
      });
      return {
        success: true,
        taskType: "market_screen",
        data: {
          totalScanned: 0,
          matchedCount: 0,
          opportunities: [],
          allStocks: [],
          sector,
          universe,
          provider: "sharded",
          sharded: true,
          chainId,
          notifications: {
            slack: options.pushToSlack !== false,
            email: Boolean(options.emailTo),
            webhook: Boolean(options.webhookUrl),
          },
        },
        timestamp,
      } as any;
    } catch (err: any) {
      // Issue #1851 (mirrors #1412): audit the submission attempt, then
      // RETHROW so the caller catch runs the full failure path (audit +
      // session message + screener.failed event) instead of returning a
      // silent {success:false}. The inner audit stays: it carries the
      // sharded flag (submission-attempt record), distinct from the caller
      // run-failure record.
      this.audit("screener.screen_failed", {
        sector: sector || "ALL",
        error: err.message,
        sharded: true,
      });
      throw err;
    }
  }

  async autonomousMarketScreen(options: {
    sector?: string;
    universe?: string;
    maxItems?: number;
    userLogin?: string;
    environment?: "TEST" | "PROD";
    trigger?: "manual" | "scheduled";
    emailTo?: string;
    slackChannel?: string;
    webhookUrl?: string;
    pushToSlack?: boolean;
    /** Issue #2216: the arming schedule's id, when the caller knows it. */
    scheduleId?: string;
    filters?: import("../types").StockScreenerFilter;
    /** Issue #1499 (#940-E): id of a stored screener preset whose
     *  criteria filter this run. Resolved at RUN time (below), so
     *  preset edits apply to future runs without re-arming the
     *  schedule. When set, the preset's criteria REPLACE options.filters
     *  — a run never merges two filter sources. */
    presetId?: string;
    /** Issue #1007: data provider (default "etrade"); "yahoo" runs the
     *  same pipeline over the Yahoo data-source adapter. */
    provider?: import("../trading").StockScreenProvider;
    /** Consolidation C3 (#1277): stage-chain config from the schedule
     *  payload — carried onto the run's events so the follow-up
     *  bridge stamps the run's stage jobs. */
    stageChain?: import("../types").StageChainConfig;
    /** Issue #1355: run this scheduled screen as sharded jobs
     *  (feed → generate → store → serve → deliver) instead of the
     *  monolithic runScreen path. Absent/false keeps today's
     *  behaviour exactly. */
    sharded?: boolean;
  } = {}): Promise<ScheduledTaskResult<{
    totalScanned: number;
    matchedCount: number;
    opportunities: OpportunityStock[];
    allStocks: ScannedStock[];
    sector?: string;
    universe?: string;
    /** Issue #1007: provider that produced the run. */
    provider?: string;
    expectedCount?: number;
    pdfKey?: string;
    pdfStatus?: "generated" | "failed" | "skipped";
    pdfError?: string;
    xlsxKey?: string;
    xlsxStatus?: "generated" | "failed" | "skipped";
    xlsxError?: string;
    csvKey?: string;
    csvStatus?: "generated" | "failed" | "skipped";
    csvError?: string;
    /** Issue #1355: true when this result came from the sharded path. */
    sharded?: boolean;
    /** Issue #1355: the submitted chain's id (sharded runs only). */
    chainId?: string;
    notifications?: {
      slack?: boolean;
      email?: boolean;
      webhook?: boolean;
    };
  }>> {
    const timestamp = new Date().toISOString();
    // Issue #1527: whole-run fallback marker, set when the E*TRADE
    // guard blocks and the run falls back to Yahoo. Declared here so
    // the catch below can name it on a fallback-run failure.
    let providerFallback: { from: "etrade"; reason: string } | undefined;

    try {
      const userLogin = options.userLogin || this.userLogin;
      if (!userLogin) {
        throw new Error("No authenticated E*TRADE account is associated with this scheduled screen. Open the schedules panel while signed in and run it again.");
      }
      // Issue #1499 (#940-E): a schedule's presetId resolves at RUN time
      // against the caller's own presets, before any broker work — so a
      // missing, foreign, unreadable, or wrong-asset-class preset fails
      // this run loudly through the catch below (audit + session
      // message + failure broadcast), never as a silent unfiltered run.
      // The resolved criteria replace options.filters for both the
      // sharded and the monolithic dispatch below.
      let screenFilters = options.filters;
      if (options.presetId !== undefined) {
        const sql = this.platformDeps?.sql;
        if (!sql) {
          throw new Error("Preset resolution is unavailable for this scheduled screen host — the run cannot apply its preset, so it does not run unfiltered.");
        }
        const resolved = resolvePresetFilter(sql, userLogin, options.presetId);
        if (!resolved.ok) {
          throw new Error(resolved.error);
        }
        if (resolved.assetClass !== "stocks") {
          throw new Error(`Preset "${options.presetId}" is an options preset and cannot filter a stock screen.`);
        }
        screenFilters = resolved.criteria as import("../types").StockScreenerFilter;
      }
      // Issue #17: the portfolio-context flag is read at run time
      // (settings live in the orchestrator's storage, which this
      // service's platformDeps.sql points at). No sql host means no
      // settings read, which the flag contract reads as OFF — never
      // as an error. The sharded chain below does not carry this
      // flag yet (its ShardChainContext has no field for it), so a
      // sharded scheduled run simply runs unmodified; the
      // monolithic path — the default — carries it.
      const portfolioContext = this.platformDeps?.sql
        ? isPortfolioContextEnabled(settingReadFromSql(this.platformDeps.sql))
        : false;
      // Issue #1174 (#1173 S1): pre-flight the broker token for
      // E*TRADE-provider runs. An expired, unrenewable token blocks
      // the run up front — recorded with the remedy, one alert per
      // expiry episode — instead of failing inside quote acquisition
      // every hour (the 2026-10-23 overnight incident). Yahoo runs
      // never touch the broker (#1007) and skip the guard.
      // Issue #1527: a blocked E*TRADE run no longer fails outright —
      // it falls back to a whole-run Yahoo screen. The guard's deduped
      // episode alert already fired inside the guard; the fallback
      // run's marker is the per-run signal, and a fallback success
      // emits no failure notice. A fallback that itself fails takes
      // the normal failure path in the catch below.
      if ((options.provider ?? "etrade") === "etrade") {
        const guard = await this.guardScheduledAuth(
          userLogin,
          options.environment,
          "stock",
          `${options.universe || "NASDAQ100"} stock screen`,
          {
            scheduleId: options.scheduleId,
            runId: `stock_scanner:${timestamp}:${options.universe || "NASDAQ100"}`,
            workflow: "autonomousMarketScreen",
            trigger: options.trigger ?? "scheduled",
            stage: "auth guard",
            firedAt: timestamp,
            runAs: userLogin,
            universe: options.universe || "NASDAQ100",
          }
        );
        if (guard.blocked) {
          providerFallback = { from: "etrade", reason: "etrade-auth-dead" };
          this.audit("screener.run_fallback", {
            kind: "stock",
            universe: options.universe || "TECH",
            sector: options.sector || "ALL",
            from: "etrade",
            to: "yahoo",
            reason: "etrade-auth-dead",
            error: guard.error,
          });
        }
      }
      // Issue #1355: sharded execution. The monolithic path below is
      // untouched when the flag is absent — off runs keep today's
      // behaviour exactly.
      // Issue #1527: a fallback run bypasses sharded dispatch — the
      // sharded chain's E*TRADE feed shard has no auth-dead mode, so
      // the fallback runs the monolithic Yahoo path and is recorded
      // without the sharded flag.
      if (options.sharded && !providerFallback) {
        // Issue #1412: await (do not bare-return) so a rejection from
        // the sharded path — e.g. the missing-port throw above — is
        // caught by this function's catch instead of escaping to the
        // caller. A bare `return` of a rejected promise bypasses the
        // enclosing try/catch in an async function.
        return await this.autonomousMarketScreenSharded({ ...options, filters: screenFilters }, userLogin, timestamp);
      }
      // Issue #261/#270: delegate screening to ScreenerAgent (E*TRADE-only).
      // Issue #421: pass the sector through unset when none was chosen —
      // ScreenerAgent labels unselected runs "ALL" instead of inventing one.
      const result = await this.getScreenerAgent(userLogin).runScreen({
        trigger: options.trigger || "scheduled",
        sector: options.sector,
        universe: (options.universe as any) || "TECH",
        maxSymbols: options.maxItems,
        filters: screenFilters,
        userLogin,
        environment: options.environment,
        portfolioContext,
        // Issue #1007: provider rides through to the pipeline run;
        // absent keeps the E*TRADE default, byte-identical in shape.
        // Issue #1527: a fallback run rides provider "yahoo" plus the
        // marker; a deliberate Yahoo run rides provider "yahoo" with
        // no marker; an E*TRADE-live run is unchanged.
        ...(providerFallback
          ? { provider: "yahoo" as const, providerFallback }
          : options.provider
            ? { provider: options.provider }
            : {}),
      });

      if (result.skippedDuplicate) {
        return { success: true, taskType: "market_screen", skipped: true, timestamp } as any;
      }

      if (!result.success) {
        throw new Error(result.error || "E*TRADE unavailable");
      }

      // Audit every run (not just ones with hits) so "Recent autonomous
      // actions" shows the full history, including quiet runs.
      // Issue #1527: the audit names the run's provider and, for a
      // fallback run, the marker — the fallback is visible in history.
      this.audit("screener.run_completed", {
        runId: `screener:${result.timestamp || timestamp}`,
        screenType: "stock",
        runType: result.trigger || options.trigger || "scheduled",
        sector: result.sector,
        universe: result.universe,
        provider: result.provider,
        ...(providerFallback ? { providerFallback } : {}),
        totalScanned: result.totalScanned,
        matchedCount: result.matchedCount,
        opportunityCount: result.opportunities.length,
        symbols: result.opportunities.map(s => s.symbol),
      });
      if (result.opportunities.length > 0) {
        this.audit("screener.opportunities_detected", {
          sector: result.sector,
          universe: result.universe,
          count: result.opportunities.length,
          symbols: result.opportunities.map(s => s.symbol),
        });
      }

      // Issue #210: publish to the event bus so Slack/email/webhook
      // subscribers can harvest the results.
      await this.publishScreenerEvent({
        type: "screener.completed",
        timestamp,
        universe: result.universe,
        trigger: options.trigger || "scheduled",
        expectedCount: result.expectedCount,
        ...(providerFallback ? { providerFallback } : {}),
        pdfKey: result.pdfKey,
        pdfStatus: result.pdfStatus,
        pdfError: result.pdfError,
        xlsxKey: result.xlsxKey,
        xlsxStatus: result.xlsxStatus,
        xlsxError: result.xlsxError,
        csvKey: result.csvKey,
        csvStatus: result.csvStatus,
        csvError: result.csvError,
        deliveryId: `${options.trigger || "scheduled"}:${result.universe}:${timestamp.slice(0, 16)}`,
        sector: result.sector || options.sector || "ALL",
        totalScanned: result.totalScanned,
        matchedCount: result.matchedCount,
        opportunities: result.opportunities,
        filterSummary: result.filterSummary,
        stageChain: options.stageChain,
        emailTo: options.emailTo,
        slackChannel: options.slackChannel,
        webhookUrl: options.webhookUrl,
        rejections: result.rejections,
        ...(result.partial
          ? {
              partial: {
                quotedCount: result.partial.quotedCount,
                requestedCount: result.partial.requestedCount,
                failedSymbols: result.partial.failedSymbols,
                failureReasons: result.partial.failureReasons,
              },
            }
          : {}),
      });

      return {
        success: true,
        taskType: "market_screen",
        data: {
          totalScanned: result.totalScanned,
          matchedCount: result.matchedCount,
          opportunities: result.opportunities,
          allStocks: result.allStocks,
          sector: result.sector,
          universe: result.universe,
          provider: result.provider,
          ...(providerFallback ? { providerFallback } : {}),
          expectedCount: result.expectedCount,
          pdfKey: result.pdfKey,
          pdfStatus: result.pdfStatus,
          pdfError: result.pdfError,
          xlsxKey: result.xlsxKey,
          xlsxStatus: result.xlsxStatus,
          xlsxError: result.xlsxError,
          csvKey: result.csvKey,
          csvStatus: result.csvStatus,
          csvError: result.csvError,
          notifications: {
            slack: options.pushToSlack !== false,
            email: Boolean(options.emailTo),
            webhook: Boolean(options.webhookUrl),
          },
        },
        timestamp,
      };
    } catch (err: any) {
      // Failure surfacing (issue #112): screen failures used to vanish —
      // no audit event, no session message — unlike options analysis.
      // Audit and surface them symmetrically.
      // Issue #1527: a fallback run that itself fails takes this same
      // path; the audit names the fallback so the failure record
      // shows it was a fallback attempt, not an E*TRADE-live failure.
      this.audit("screener.screen_failed", {
        runId: `screener:${timestamp}`,
        screenType: "stock",
        runType: options.trigger || "scheduled",
        sector: options.sector || "ALL",
        error: err.message,
        ...(providerFallback ? { providerFallback } : {}),
      });

      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content: `⚠️ Scheduled Market Screen failed for sector ${options.sector || "ALL"}: ${err.message || "Market screener execution error"}${providerFallback ? " (Yahoo fallback after E*TRADE auth failure)" : ""}`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }

      // Issue #210: publish the failure so subscribers can notify.
      await this.publishScreenerEvent({
        type: "screener.failed",
        timestamp,
        universe: options.universe || "TECH",
        trigger: options.trigger || "scheduled",
        deliveryId: `${options.trigger || "scheduled"}:${options.universe || "TECH"}:${timestamp.slice(0, 16)}`,
        sector: options.sector || "ALL",
        error: err.message || "Market screener execution error",
        stageChain: options.stageChain,
        emailTo: options.emailTo,
        slackChannel: options.slackChannel,
        webhookUrl: options.webhookUrl,
      });

      return {
        success: false,
        taskType: "market_screen",
        error: err.message || "Market screener execution error",
        timestamp,
      };
    }
  }

  /**
   * Consolidation C1 (issue #1201, epic #1151 R1): runs a goal-driven
   * screen (Phase 1 scenario + Phase 3 semantics through the Phase 0
   * registry) via ScreenerAgent — the same one-agent-owns-screening
   * delegation as autonomousMarketScreen. Canonical recording
   * (mas_reports + screening activity log) and optional Phase 6
   * channel delivery happen inside executeGoalScreenRun; the run is
   * ledger-idempotent on its minute slot, so a duplicate scheduled
   * delivery reports skipped, exactly like the market screen. Failure
   * contract mirrors autonomousMarketScreen (issue #112): audit +
   * session message + a failure result, never a silent vanish.
   */
  async autonomousGoalScreen(options: {
    goalKind?: string;
    direction?: string;
    scenarioId?: string;
    symbols?: string[];
    assetClasses?: ("stocks" | "options")[];
    userLogin?: string;
    environment?: "TEST" | "PROD";
    trigger?: "manual" | "scheduled";
    emailTo?: string;
    /** Issue #2216: the arming schedule's id, when the caller knows it. */
    scheduleId?: string;
    /** Issue #2186: schedule kind for paid routing — absent fails
     *  closed to recurring (coverage-only). No caller sets this yet. */
    scheduleKind?: "one_off" | "recurring";
    /** Issue #2186: human authorization at submission for a one-off
     *  run. No caller sets this yet. */
    authorizedAtSubmission?: boolean;
    slackChannel?: string;
    pushToSlack?: boolean;
    /** Consolidation C4 (#1329): per-record stage-chain config — a
     *  completed goal screen bridges generate + serve (canonical
     *  report adoption). Consolidation #1236 chains delivery too:
     *  in chain mode the direct Phase 6 delivery is suppressed and
     *  the bridge carries deliverViaChain=true, so the artifact is
     *  delivered exactly once, by the chain. Absent ⇒ unbridged. */
    stageChain?: StageChainConfig;
  } = {}): Promise<ScheduledTaskResult<{
    taskId: string;
    status?: string;
    hits?: number;
    goalKind?: string;
    /** Issue #1571: the fallback marker when the stock leg fell back
     *  to Yahoo (mirrors the #1527 market-screen data shape). */
    providerFallback?: {
      from: "etrade";
      reason: string;
    };
    /** Issue #1996: workflow run id when the run was submitted to
     *  the unified run-request path instead of executing direct. */
    workflowId?: string;
  }>> {
    const timestamp = new Date().toISOString();
    // Issue #1571: whole-run fallback marker, set when the E*TRADE
    // guard blocks a stocks-requesting goal run. Declared here so the
    // catch below can name it on a fallback-run failure.
    let providerFallback: { from: "etrade"; reason: string } | undefined;
    try {
      const userLogin = options.userLogin || this.userLogin;
      if (!userLogin) {
        throw new Error("No authenticated account is associated with this scheduled goal screen. Open the schedules panel while signed in and run it again.");
      }
      if (!this.orm) {
        throw new Error("Goal-screen schedules require the ORM-backed schedule service.");
      }
      const { GOAL_KINDS, buildScenario } = await import("./goalScenarioEngine");
      const runtime = await import("./screeningRuntime");
      let scenario: ReturnType<typeof buildScenario>;
      let scenarioSource: "built" | "stored";
      if (options.scenarioId) {
        const store = await import("./goalScenarioStore");
        store.ensureGoalScenarioTables(this.orm as any);
        const record = store.getScenario(this.orm as any, userLogin, options.scenarioId);
        if (!record) {
          throw new Error(`Stored scenario '${options.scenarioId}' was not found for this account.`);
        }
        const goal = store.getGoal(this.orm as any, userLogin, record.goalId);
        if (!goal) {
          throw new Error(`The goal owning scenario '${options.scenarioId}' was not found for this account.`);
        }
        scenario = runtime.scenarioFromStoredRecord(goal, record);
        scenarioSource = "stored";
      } else {
        if (!options.goalKind || !(GOAL_KINDS as readonly string[]).includes(options.goalKind)) {
          throw new Error(`goalKind must be one of: ${GOAL_KINDS.join(", ")}.`);
        }
        const outlooks = ["bullish", "bearish", "volatile", "range_bound", "unknown"];
        if (options.direction !== undefined && !outlooks.includes(options.direction)) {
          throw new Error(`direction must be one of: ${outlooks.join(", ")}.`);
        }
        scenario = buildScenario({
          goalKind: options.goalKind as (typeof GOAL_KINDS)[number],
          portfolioRef: { kind: "hypothetical" },
          ...(options.direction
            ? { direction: options.direction as ReturnType<typeof buildScenario>["direction"] }
            : {}),
        });
        scenarioSource = "built";
      }
      const trigger = options.trigger || "scheduled";
      const idempotencyKey =
        trigger === "scheduled"
          ? `goal-screen:scheduled:${userLogin}:${scenario.goalKind}:${timestamp.slice(0, 16)}`
          : `goal-screen:manual:${userLogin}:${scenario.goalKind}:${timestamp}`;
      // Consolidation #1236: in chain mode the direct Phase 6 delivery
      // is suppressed — the bridge below carries deliverViaChain=true
      // so the chain delivers exactly once to the same recipients.
      // Direct delivery (immediate text, draft-marked, no hold) and
      // chain delivery (followup.deliver, immediate post-#1347) share
      // the immediate-send posture, so chaining changes timing
      // (deliverDelaySeconds) and text format (generic followup text,
      // no hit list), not the hold semantics. Unchained runs keep the
      // direct path byte-identical.
      const directChannels: ("email" | "slack")[] = [
        ...(options.emailTo ? ["email" as const] : []),
        ...(options.pushToSlack || options.slackChannel ? ["slack" as const] : []),
      ];
      const chainMode = Boolean(options.stageChain);
      const deliver: ("slack" | "email" | "webhook" | "voice")[] = chainMode ? [] : directChannels;
      // Issue #1571: the goal path never went through the scheduled
      // auth guard — unlike the market and options screens, which
      // both pre-flight it. A stocks-requesting goal run now guards
      // too: when E*TRADE auth is dead it falls back to a whole-run
      // Yahoo stock leg (the agent's provider-"yahoo" goal path),
      // with the #1527 marker semantics. The guard's deduped episode
      // alert already fired inside the guard; a fallback success
      // emits no failure notice. Options-only runs never consult the
      // guard — there is no stock leg to fall back, and the options
      // path is unchanged (stocks only, per the 2026-10-25 ruling).
      // A fallback that itself fails takes the normal failure path
      // in the catch below.
      const stocksRequested = !options.assetClasses || options.assetClasses.includes("stocks");
      if (stocksRequested) {
        const guard = await this.guardScheduledAuth(
          userLogin,
          options.environment,
          "stock",
          "goal screen",
          {
            scheduleId: options.scheduleId,
            runId: `goal_screen:${timestamp}:${scenario.goalKind}`,
            workflow: "autonomousGoalScreen",
            trigger: options.trigger ?? "scheduled",
            stage: "auth guard",
            firedAt: timestamp,
            runAs: userLogin,
          }
        );
        if (guard.blocked) {
          providerFallback = { from: "etrade", reason: "etrade-auth-dead" };
          this.audit("goal_screen.run_fallback", {
            kind: "stock",
            goalKind: scenario.goalKind,
            from: "etrade",
            to: "yahoo",
            reason: "etrade-auth-dead",
            error: guard.error,
          });
        }
      }
      // Issue #1996 (#1972 slice 1): workflow submission for
      // scheduled goal screens. Only when NOT in chain mode:
      // the chain bridge below needs the completed result (its
      // canonicalReportId + counts) to bridge generate + serve,
      // and a queued run has no result to bridge — chain mode
      // keeps direct behavior byte-identical. A null start
      // (no workflow binding, no projection store, start
      // error) falls through to the direct path unchanged.
      // Issue #1997: the workflow-first path above is
      // flag-gated. Flag OFF → the block is skipped and the
      // run goes direct (scheduled runs return to direct by
      // default until the flag is enabled). Flag ON → the
      // workflow is REQUIRED: a failed start throws, so the
      // tick records a failure (run_failed audit) instead of
      // silently running direct.
      // Issue #2186 (slice 10): monetization ON gates scheduled goal
      // screens before any workflow or direct start. Covered runs go
      // through PaymentWorkflow (re-check + consume + start); uncovered
      // recurring/unstated runs are skipped, audited, and explained —
      // never an unattended charge, never a free run. Chain mode has
      // no paid path (a queued run has no result to bridge), so it
      // skips the same way. An account/store failure THROWS into the
      // tick's run_failed path below — coverage unknown is not a skip.
      // CROSS-LANE (CTO review): this block sits ahead of the
      // CTO-owned workflow-first block (#1997) and returns/throws
      // before it; it does not change the free-path workflow start,
      // audit, or direct fall-through below.
      const monetizationOn = await (
        await import("../features/createFeatureFlagPort")
      ).createFeatureFlagPort(this.env).isEnabled("monetization");
      if (monetizationOn) {
        const { resolveIaaaTenant } = await import("../security/iaaaGithubEndToEnd");
        const tenantId = resolveIaaaTenant(this.env);
        const { createCommercialAdapter, ensureCommercialSchema } =
          await import("../data/createCommercialPorts");
        const { createSubscriptionAdapter, ensureSubscriptionSchema } =
          await import("../data/createSubscriptionPorts");
        const {
          coverageForAccount,
          resolvePaidScreenAction,
          resolvePaidScreenAccount,
          buildPaidScreenSubmission,
        } = await import("./paidScreenSubmission");
        const { buildGoalScreenCommand } = await import("./goalScreenWorkflowSubmission");
        const { startPaymentWorkflowViaBinding } =
          await import("./paymentWorkflowSubmission");
        // Issue #2185: the goal price comes from the operator price
        // catalogue port, never from a code constant (the old
        // price table was removed by the catalogue slice). Fail-closed: an
        // unbound catalogue or a missing/invalid stored price
        // THROWS into the tick's run_failed path, like the store
        // failures below — coverage unknown is not a skip, and no
        // price is ever guessed. A fresh store seeds the proposed
        // goal price at ensure time, so the value is unchanged.
        const { createPriceCatalogueAdapter, ensurePriceCatalogueSchema } =
          await import("../data/createPriceCataloguePorts");
        const priceCatalogue = createPriceCatalogueAdapter(this.env as { AGENT_DB?: unknown });
        if (!priceCatalogue) {
          throw new Error(
            "Price catalogue is unavailable; refusing to route a paid scheduled screen without operator price data.",
          );
        }
        await ensurePriceCatalogueSchema(priceCatalogue.db);
        const goalScreenPriceUSD = await priceCatalogue.getPrice("goal");
        if (goalScreenPriceUSD === null || !Number.isFinite(goalScreenPriceUSD) || goalScreenPriceUSD <= 0) {
          throw new Error(
            "No valid stored price for family goal: refusing to route a paid scheduled screen (fail-closed).",
          );
        }
        const skipPaid = (status: string, reason: string) => {
          this.audit("goal_screen.skipped_uncovered", {
            goalKind: scenario.goalKind,
            jobId: idempotencyKey,
            trigger,
            status,
            reason,
            priceUSD: goalScreenPriceUSD,
          });
          return {
            success: true,
            taskType: "goal_screen",
            skipped: true,
            timestamp,
            data: { taskId: idempotencyKey, status, reason, priceUSD: goalScreenPriceUSD, goalKind: scenario.goalKind },
          } as any;
        };
        if (chainMode) {
          return skipPaid(
            "skipped_chain_mode",
            "Chain-mode scheduled runs cannot ride the payment workflow (a queued run has no result to bridge); skipped while monetization is on.",
          );
        }
        const commercial = createCommercialAdapter(this.env as { AGENT_DB?: unknown });
        const subscriptions = createSubscriptionAdapter(this.env as { AGENT_DB?: unknown });
        if (!commercial || !subscriptions) {
          throw new Error(
            "Commercial account store is unavailable; refusing to route a paid scheduled screen without verified coverage.",
          );
        }
        await ensureCommercialSchema(commercial.db);
        await ensureSubscriptionSchema(subscriptions.db);
        const { account } = await resolvePaidScreenAccount(
          { commercial, subscriptions },
          { userId: userLogin, email: options.emailTo ?? "", tenantId, nowMs: Date.now() },
        );
        const coverage = coverageForAccount(account, goalScreenPriceUSD);
        const action = resolvePaidScreenAction({
          monetizationOn: true,
          trigger: "scheduled",
          scheduleKind: options.scheduleKind,
          authorizedAtSubmission: options.authorizedAtSubmission,
          coverage,
          priceUSD: goalScreenPriceUSD,
        });
        if (action.action === "skip") {
          return skipPaid("skipped_uncovered", action.reason);
        }
        if (!options.emailTo) {
          return skipPaid(
            "skipped_no_checkout_contact",
            "Scheduled goal run has no checkout contact (emailTo); refusing to start a payment workflow with an invented address.",
          );
        }
        const paidCommand = buildGoalScreenCommand({
          jobId: idempotencyKey,
          source: "scheduled-tasks",
          trigger,
          userLogin,
          tenantId,
          scenario,
          scenarioSource,
          ...(options.assetClasses ? { assetClasses: options.assetClasses } : {}),
          ...(options.symbols ? { symbols: options.symbols } : {}),
          ...(directChannels.length > 0 ? { deliverChannels: directChannels } : {}),
          ...(options.emailTo ? { emailTo: options.emailTo } : {}),
          ...(options.environment ? { environment: options.environment } : {}),
          ...(providerFallback ? { provider: "yahoo" as const, providerFallback } : {}),
        });
        const params = buildPaidScreenSubmission({
          runRequestId: idempotencyKey,
          family: "goal",
          trigger: "scheduled",
          scheduleKind: options.scheduleKind,
          authorizedAtSubmission: options.authorizedAtSubmission,
          tenantId,
          userId: userLogin,
          email: options.emailTo,
          account,
          screenerCommand: paidCommand,
        });
        const started = await startPaymentWorkflowViaBinding(
          this.env.PAYMENT_WORKFLOW as unknown as
            | import("./paymentWorkflowSubmission").PaymentWorkflowBinding
            | undefined,
          params,
        );
        this.audit("goal_screen.payment_started", {
          goalKind: scenario.goalKind,
          jobId: idempotencyKey,
          workflowId: started.workflowId,
          trigger,
        });
        return {
          success: true,
          taskType: "goal_screen",
          timestamp,
          data: {
            taskId: idempotencyKey,
            status: "payment_started",
            workflowId: started.workflowId,
            goalKind: scenario.goalKind,
            ...(providerFallback ? { providerFallback } : {}),
          },
        };
      }
      const goalWorkflowOn = await (
        await import("../features/createFeatureFlagPort")
      ).createFeatureFlagPort(this.env).isEnabled("goal_workflow");
      if (!chainMode && goalWorkflowOn) {
        const { buildGoalScreenCommand, startGoalScreenWorkflow } =
          await import("./goalScreenWorkflowSubmission");
        const { createObservabilitySink } =
          await import("../observability/createObservabilityPorts");
        const { resolveIaaaTenant } = await import("../security/iaaaGithubEndToEnd");
        const handle = await startGoalScreenWorkflow(
          this.env,
          buildGoalScreenCommand({
            jobId: idempotencyKey,
            source: "scheduled-tasks",
            trigger,
            userLogin,
            tenantId: resolveIaaaTenant(this.env),
            scenario,
            scenarioSource,
            ...(options.assetClasses ? { assetClasses: options.assetClasses } : {}),
            ...(options.symbols ? { symbols: options.symbols } : {}),
            ...(directChannels.length > 0 ? { deliverChannels: directChannels } : {}),
            ...(options.emailTo ? { emailTo: options.emailTo } : {}),
            ...(options.environment ? { environment: options.environment } : {}),
            ...(providerFallback ? { provider: "yahoo" as const, providerFallback } : {}),
          }),
          createObservabilitySink(this.env),
        );
        if (handle) {
          this.audit("goal_screen.workflow_submitted", {
            goalKind: scenario.goalKind,
            jobId: idempotencyKey,
            workflowId: handle.workflowId,
            trigger,
          });
          return {
            success: true,
            taskType: "goal_screen",
            timestamp,
            data: {
              taskId: idempotencyKey,
              status: "queued",
              workflowId: handle.workflowId,
              goalKind: scenario.goalKind,
              ...(providerFallback ? { providerFallback } : {}),
            },
          };
        }
      }
      const out = await runtime.executeGoalScreenRun({
        agent: this.getScreenerAgent(userLogin),
        orm: this.orm,
        env: this.env,
        userLogin,
        scenario,
        scenarioSource,
        trigger,
        idempotencyKey,
        environment: options.environment,
        assetClasses: options.assetClasses,
        symbols: options.symbols,
        ...(deliver.length > 0 ? { deliver } : {}),
        ...(options.emailTo ? { emailTo: options.emailTo } : {}),
        // Issue #1571: a fallback run rides provider "yahoo" plus the
        // marker; an E*TRADE-live run is unchanged.
        ...(providerFallback
          ? { provider: "yahoo" as const, providerFallback }
          : {}),
      });
      if (!out.executed) {
        return { success: true, taskType: "goal_screen", skipped: true, timestamp } as any;
      }
      this.audit("goal_screen.run_completed", {
        goalKind: out.result?.goalKind,
        status: out.result?.status,
        hits: out.result?.counts.hits,
        taskId: out.taskId,
        ...(providerFallback ? { providerFallback } : {}),
      });
      if (out.result?.status === "failed") {
        throw new Error("Goal-driven screen failed on every requested asset class.");
      }
      // Consolidation C4 (#1329): chain identity + serve stage for a
      // completed goal screen. Consolidation #1236 chains delivery:
      // the direct path above is suppressed in chain mode, and the
      // bridge carries the per-task recipients + a delivery-channel
      // allowlist mirroring the direct path, so the chain delivers
      // exactly once and adds no env-configured channel the direct
      // path never used. A bridge failure never fails the run's
      // screen outcome — but Issue #1999: the submission retries
      // under the report policy, and a final failure is audited
      // (followup.schedule_failed) so no chain delivery is silently
      // assumed from a kept canonical row.
      if (options.stageChain && this.followupScheduler) {
        const scheduler = this.followupScheduler;
        try {
          await withRetry(
            () =>
              scheduler(
                {
                  kind: "goal",
                  trigger,
                  success: true,
                  thesis: `Goal screen — ${out.result?.goalKind ?? "goal"}`,
                  pdfKeys: [],
                  canonicalReportId: out.canonicalReportId,
                  deliverViaChain: true,
                  ...(options.emailTo ? { emailTo: options.emailTo } : {}),
                  ...(options.slackChannel ? { slackChannel: options.slackChannel } : {}),
                  deliveryChannels: directChannels,
                  matchedCount: out.result?.counts.hits,
                  totalScanned: (out.result?.counts.stocksScanned ?? 0)
                    + (out.result?.counts.optionsUnderlyingsScanned ?? 0),
                  stageChain: options.stageChain,
                  // Issue #1571: the bridge outcome names the fallback.
                  ...(providerFallback ? { providerFallback } : {}),
                },
                userLogin,
                true,
              ),
            resolvePipelinePolicy(this.env as unknown as Record<string, unknown>).retry.report,
            { label: "followup-bridge" },
          );
        } catch (bridgeErr) {
          console.warn("[ScheduledTasksService] Goal bridge failed (canonical row kept):", bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr));
          this.audit("followup.schedule_failed", {
            taskId: out.taskId,
            trigger,
            error: bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr),
          });
        }
      }
      return {
        success: true,
        taskType: "goal_screen",
        timestamp,
        data: {
          taskId: out.taskId,
          status: out.result?.status,
          hits: out.result?.counts.hits,
          goalKind: out.result?.goalKind,
          ...(providerFallback ? { providerFallback } : {}),
        },
      };
    } catch (err: any) {
      // Issue #1571: a fallback run that itself fails takes this same
      // path; the audit names the fallback so the failure record
      // shows it was a fallback attempt, not an E*TRADE-live failure.
      this.audit("goal_screen.run_failed", {
        goalKind: options.goalKind,
        scenarioId: options.scenarioId,
        error: err.message,
        // Issue #2065 (remainder): the typed failure code rides the
        // audit, so a failed start is diagnosable without log access.
        ...(typeof err?.code === "string" ? { errorCode: err.code } : {}),
        ...(providerFallback ? { providerFallback } : {}),
      });
      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content: `⚠️ Scheduled Goal Screen failed: ${err.message || "Goal screen execution error"}${providerFallback ? " (Yahoo fallback after E*TRADE auth failure)" : ""}`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }
      return {
        success: false,
        taskType: "goal_screen",
        error: err.message || "Goal screen execution error",
        timestamp,
      };
    }
  }

  /**
   * Automatically expires a previewed order draft after timeout (15-minute HITL window)
   */
  async expireStaleOrderDraft(
    orderId: string
  ): Promise<ScheduledTaskResult<{
    orderId: string;
    expired: boolean;
    previousStatus: string;
    trade?: TradeRecord;
  }>> {
    const timestamp = new Date().toISOString();

    if (!this.orm?.trades) {
      return {
        success: false,
        taskType: "order_expiration",
        error: "Database ORM not initialized",
        timestamp,
      };
    }

    const trade = this.orm.trades.findById(orderId);
    if (!trade) {
      return {
        success: false,
        taskType: "order_expiration",
        error: `Order draft '${orderId}' not found.`,
        timestamp,
      };
    }

    // Only expire if still in 'previewed' status (not executed, rejected, or cancelled)
    if (trade.status === "previewed") {
      const notes = `${trade.previewNotes || ""} [Auto-expired: 15-minute HITL window elapsed without human authorization]`.trim();
      this.orm.trades.update(orderId, {
        status: "expired",
        updatedAt: timestamp,
        previewNotes: notes,
      });

      this.audit("order.auto_expired", {
        orderId,
        symbol: trade.symbol,
        quantity: trade.quantity,
        totalValue: trade.totalValue,
        previousStatus: "previewed",
        expiredAt: timestamp,
      });

      return {
        success: true,
        taskType: "order_expiration",
        data: {
          orderId,
          expired: true,
          previousStatus: "previewed",
          trade: { ...trade, status: "expired", previewNotes: notes, updatedAt: timestamp },
        },
        timestamp,
      };
    }

    // Order was already resolved (approved, rejected, cancelled, etc.)
    return {
      success: true,
      taskType: "order_expiration",
      data: {
        orderId,
        expired: false,
        previousStatus: trade.status,
        trade,
      },
      timestamp,
    };
  }

  /**
   * Dispatches a scheduled user reminder: records it in the user's chat
   * history (the delivery channel) and audits the outcome.
   *
   * Issue #123 (F19): the result reflects what actually happened per
   * channel. The chat-message insert IS the delivery — if it fails (or
   * no message store is available), the dispatch FAILED: the failure is
   * audited as `reminder.dispatch_failed` (the #112 failure contract)
   * and returned as `{ success: false, error }`, never swallowed into a
   * success claim. `reminder.dispatched` is audited only when the
   * reminder was actually recorded.
   */
  async dispatchReminder(
    reminderId: string,
    message: string
  ): Promise<ScheduledTaskResult<{
    reminderId: string;
    message: string;
    dispatchedAt: string;
    channels: { audit: boolean; chatMessage: boolean };
    messageError?: string;
  }>> {
    const timestamp = new Date().toISOString();

    let chatMessageRecorded = false;
    let messageError: string | undefined;
    if (this.orm?.messages) {
      try {
        this.orm.messages.create({
          id: crypto.randomUUID(),
          sessionId: this.userLogin,
          role: "assistant",
          content: `⏰ Scheduled Reminder [${reminderId}]: ${message}`,
          agent: "orchestrator",
          createdAt: timestamp,
        });
        chatMessageRecorded = true;
      } catch (err: any) {
        messageError = err?.message || "Failed to record reminder message";
      }
    } else {
      messageError = "No message store available to record the reminder";
    }

    // The audit channel claim reflects whether an audit store is actually
    // attached (this.audit no-ops without one, as everywhere in this service).
    const auditAvailable = Boolean(this.orm?.events);

    if (!chatMessageRecorded) {
      this.audit("reminder.dispatch_failed", {
        reminderId,
        message,
        userLogin: this.userLogin,
        error: messageError,
        attemptedAt: timestamp,
      });
      return {
        success: false,
        taskType: "reminder",
        error: `Reminder could not be delivered to chat history: ${messageError}`,
        data: {
          reminderId,
          message,
          dispatchedAt: timestamp,
          channels: { audit: auditAvailable, chatMessage: false },
          messageError,
        },
        timestamp,
      };
    }

    this.audit("reminder.dispatched", {
      reminderId,
      message,
      userLogin: this.userLogin,
      dispatchedAt: timestamp,
      channels: { audit: auditAvailable, chatMessage: true },
    });

    return {
      success: true,
      taskType: "reminder",
      data: {
        reminderId,
        message,
        dispatchedAt: timestamp,
        channels: { audit: auditAvailable, chatMessage: true },
      },
      timestamp,
    };
  }

  /**
   * Autonomous Options Intelligence & Cross-Symbol Opportunity Analysis
   * Can be triggered on-demand or executed on a Cloudflare Agents schedule (cron or interval)
   * Dispatches push notifications to Slack, Email, and Webhook upon completion
   */
  async autonomousOptionsAnalysis(
    options: AutonomousOptionsAnalysisOptions = {}
  ): Promise<ScheduledTaskResult<{
    totalScanned: number;
    withTrades: number;
    symbols: string[];
    summary: string;
    notifications: {
      slack?: boolean;
      email?: boolean;
      webhook?: boolean;
    };
    opportunities?: any[];
    reportUrl?: string;
    sharded?: boolean;
    chainId?: string;
    /** Issue #2091: the service's artifact keys + canonical row id. */
    pdfKey?: string;
    xlsxKey?: string;
    csvKey?: string;
    canonicalReportId?: string | null;
  }>> {
    const timestamp = new Date().toISOString();
    let symbols: string[] = [];
    // Issue #2577: resolve the report scope once per run. The thesis still
    // orients scoring, but it no longer decides which strategies exist in
    // the report: the wanted set does. `allowedStrategies` from the
    // schedule is a request-level narrowing (a schedule naming three
    // strategies gets three); omitting it resolves to the full registry.
    const reportScope = resolveOptionsReportScope({
      ...(options.thesis ? { thesis: options.thesis as string } : {}),
      ...(options.allowedStrategies?.length
        ? { strategies: options.allowedStrategies.map(String) }
        : {}),
      ...(options.symbols?.length ? { symbols: options.symbols } : {}),
      env: this.env as { OPTIONS_REPORT_CONFIG?: string; OPTIONS_REPORT_PRESET?: string },
    });
    // One execution per thesis per run today; a multi-thesis scope names
    // its remaining theses in the audit stamp so the gap is visible.
    const targetThesis = (reportScope.theses[0] ?? "bullish") as OptionThesis;
    const scopeStrategies = (
      reportScope.strategyScope === "all" ? ["all"] : reportScope.strategyIds
    ) as OptionStrategyType[];
    const scopeDte = {
      ...(reportScope.chains.dte.minDte !== null ? { minDte: reportScope.chains.dte.minDte } : {}),
      ...(reportScope.chains.dte.maxDte !== null ? { maxDte: reportScope.chains.dte.maxDte } : {}),
    };
    const reportRunId = `options_scanner:${timestamp}:${targetThesis}`;
    let auditRunId = reportRunId;
    const shouldNotifySlack = options.pushToSlack === true ||
      (options.pushToSlack === undefined && Boolean(this.env.SLACK_BOT_TOKEN || getCfpayConfig(this.env)));

    try {
      const userLogin = options.userLogin || this.userLogin;
      if (!userLogin) {
        throw new Error("No authenticated E*TRADE account is associated with this options screen. Sign in and run it again.");
      }
      // Issue #1174 (#1173 S1): same auth pre-flight as the stock
      // screen — options scans die on the same midnight-ET token
      // cliff; block up front with one alert per episode instead.
      // Issue #1583: when an alert was already sent for this episode
      // (!guard.alerted), honor the contract ("further runs today stay quiet")
      // and return quietly without repeat notification spam.
      {
        const guard = await this.guardScheduledAuth(
          userLogin,
          options.environment,
          "options",
          "options screen",
          {
            scheduleId: options.scheduleId,
            runId: reportRunId,
            workflow: "autonomousOptionsAnalysis",
            trigger: options.trigger ?? "scheduled",
            stage: "auth guard",
            firedAt: timestamp,
            runAs: userLogin,
            universe: options.universe,
            thesis: targetThesis,
          }
        );
        if (guard.blocked) {
          if (!guard.alerted) {
            this.audit("options.scheduled_analysis_blocked_quiet", {
              userLogin,
              thesis: targetThesis,
              error: guard.error,
            });
            return {
              success: false,
              taskType: "options_analysis" as any,
              error: guard.error,
              timestamp,
            };
          }
          throw new Error(guard.error);
        }
      }
      if (options.trigger === "scheduled") {
        const jobKey = `options:${options.universe || (options.symbols || []).join(",")}:${targetThesis}:${options.maxItems ?? "all"}`;
        const claimed = await this.getScreenerAgent(userLogin).claimScheduledExecution(jobKey, options.environment);
        if (!claimed) return { success: true, taskType: "options_analysis", skipped: true, timestamp } as any;
      }
      // Resolve universe to symbols inside the failure boundary so listings
      // and E*TRADE errors reach the scheduled failure notification path.
      const effectiveUniverse = options.universe || (options.symbols && options.symbols.length > 0 ? null : "NASDAQ100");
      if (effectiveUniverse) {
        // Issue #1378: the universe resolves through the route
        // table (bundle → reader → binder), never by direct
        // listings-module call. Without a platform store there is
        // no bundle to build: the named throw below reaches the
        // scheduled failure notification path (this block is inside
        // the failure boundary), never a silent empty run.
        // Decision D2 recorded exception: no run id exists at
        // universe-resolution time (the sharded chain id is minted
        // only after symbols resolve, below), so the universe
        // capture is recorded under a minted id.
        if (!this.platformDeps?.sql) {
          throw new Error(
            "options_analysis universe resolution requires platformDeps.sql — no platform store is configured (#1378)"
          );
        }
        const {
          nasdaqUniverseRouteBundle,
          nasdaqUniverseProviderFromRoute,
          bindNasdaqUniverseDeps,
          resolveUniverse,
          UNIVERSES,
        } = await import("../trading");
        const bundle = await nasdaqUniverseRouteBundle({
          sql: this.platformDeps.sql as never,
          ...(this.platformDeps.blobStorage
            ? { storage: this.platformDeps.blobStorage as never }
            : {}),
          env: this.platformDeps.env as never,
          userLogin,
          runId: crypto.randomUUID(),
        });
        const provider = nasdaqUniverseProviderFromRoute(
          bundle.registry,
          bundle.configs,
          bundle.routes
        );
        const listings = await bindNasdaqUniverseDeps(
          provider,
          bundle.runContext
        ).fetchListings();
        const universeDef = UNIVERSES[effectiveUniverse as keyof typeof UNIVERSES];
        const resolved = resolveUniverse(effectiveUniverse as any, listings);
        const maxSymbols = options.maxItems ?? universeDef?.defaultMaxSymbols ?? 50;
        symbols = (maxSymbols > 0 ? resolved.slice(0, maxSymbols) : resolved).map((l) => l.symbol);
      } else {
        const requested = options.symbols || [];
        symbols = options.maxItems && options.maxItems > 0 ? requested.slice(0, options.maxItems) : requested;
      }
      if (symbols.length === 0) {
        throw new Error(`No live symbols resolved for the options universe${effectiveUniverse ? ` ${effectiveUniverse}` : ""}; no static list was substituted.`);
      }

      const unifiedService = new UnifiedOptionsService(
        this.env,
        userLogin,
        options.environment,
        this.orm,
        this.scanRunStore,
        undefined,
        undefined,
        this.platformDeps
      );

      // Issue #16: fetch the event calendar for the scan's names so
      // the run judges event risk per name and reports coverage. The
      // service never throws; uncovered names stay unverified.
      //
      // Issue #1785: a scheduled run over more symbols than one
      // invocation's subrequest budget can cover takes the existing
      // sharded branch below (one paced per-symbol job, each invocation
      // with its own budget) instead of running monolithically and
      // deferring most of the universe. Measured per-symbol cost of
      // the snapshot path is 1 expire-dates fetch + ~11 chain fetches
      // (pinned by tests/options_scan_subrequest_budget.test.ts, which
      // reproduces prod's exactly-3-of-100); floor(35 / 12) = 2 symbols
      // fit one budget. Explicit sharded: true still shards regardless
      // of size; manual runs and small scheduled runs keep the
      // monolithic path. Caveat: the limit is a typical-cost heuristic
      // — a symbol with unusually many expirations in its window can
      // still partial even below it, and then the #1718 degraded
      // notice (not silence) is what the run reports.
      const SCHEDULED_OPTIONS_MONOLITHIC_SYMBOL_LIMIT = Math.max(
        1,
        Math.floor(DEFAULT_SUBREQUEST_BUDGET / 12),
      );
      const autoShard =
        options.trigger === "scheduled" &&
        symbols.length > SCHEDULED_OPTIONS_MONOLITHIC_SYMBOL_LIMIT;
      if (options.sharded || autoShard) {
        if (!this.shardSubmit) {
          throw new Error("Sharded options runs require the async-job submission port; configure the host or run the scan directly.");
        }
        const { planOptionsFeedShards } = await import("./shardJobs");
        const chainId = crypto.randomUUID();
        const chain: import("../types").ShardChainContext = {
          chainId,
          screenType: "options",
          universe: effectiveUniverse || "symbols",
          userLogin,
          environment: options.environment as "TEST" | "PROD" | undefined,
          trigger: options.trigger || "scheduled",
          maxItems: symbols.length,
          timestamp,
          channels: [
            ...(options.emailTo ? ["email" as const] : []),
            ...(shouldNotifySlack ? ["slack" as const] : []),
            ...((options.webhookUrl || this.env.OUTBOUND_WEBHOOK_URL) ? ["webhook" as const] : []),
          ],
          emailTo: options.emailTo || (this.env as any).OPTIONS_EMAIL_TO || (this.env as any).SCREENER_EMAIL_TO,
          slackChannel: options.slackChannel || (this.env as any).SCREENER_SLACK_CHANNEL || (this.env as any).SLACK_CHANNEL,
          webhookUrl: options.webhookUrl || this.env.OUTBOUND_WEBHOOK_URL,
          reportBaseUrl: this.env.APP_BASE_URL || "https://agent.openaimp.com",
          stageChain: options.stageChain,
          // A one-second not-before interval spaces independent Worker
          // invocations. Each invocation receives its own chain-fetch budget.
          staggerMs: 1_000,
          options: {
            symbols,
            thesis: targetThesis,
            targetDate: options.targetDate || new Date(Date.parse(timestamp) + 30 * 86400000).toISOString().slice(0, 10),
            riskProfile: options.riskProfile || "balanced",
            allowedStrategies: scopeStrategies,
            ...scopeDte,
            maxPlannedLoss: reportScope.gates.maxPlannedLoss,
            minRewardRisk: reportScope.gates.minRewardRisk,
            // Issue #2091: scheduled runs judge the chain against every
            // wanted strategy, not only the thesis-matching ones. The
            // wanted set is the scope's lever; the thesis orients scoring.
            evaluateAllStrategies: true,
          },
        };
        // The per-symbol job owns its event-calendar request too; do not
        // fan out 100 calendar lookups in this scheduling invocation.
        const specs = planOptionsFeedShards(chain, timestamp);
        const submitted: string[] = [];
        for (const spec of specs) submitted.push((await this.shardSubmit(spec)).jobId);
        this.audit("options.sharded_chain_submitted", { chainId, universe: chain.universe, symbols: symbols.length, jobs: submitted.length, scope: describeReportScope(reportScope), theses: reportScope.theses, strategies: reportScope.strategyScope === "all" ? "all" : scopeStrategies, warnings: reportScope.warnings });
        return {
          success: true,
          taskType: "options_analysis" as any,
          data: {
            totalScanned: 0,
            withTrades: 0,
            symbols,
            summary: `Options scan queued as ${symbols.length} paced symbol jobs; results will be collated after completion.`,
            notifications: {},
            opportunities: [],
            sharded: true,
            chainId,
          },
          timestamp,
        } as any;
      }

      const scanCalendarCoverage = await getEventCalendarCoverage(symbols);

      const response = await unifiedService.execute({
        action: "opportunities",
        symbols,
        thesis: targetThesis,
        targetDate: options.targetDate,
        riskProfile: options.riskProfile || "balanced",
        allowedStrategies: scopeStrategies,
        ...scopeDte,
        maxPlannedLoss: reportScope.gates.maxPlannedLoss,
        minRewardRisk: reportScope.gates.minRewardRisk,
        // Issue #2091: scheduled runs judge the chain against every
        // wanted strategy, not only the thesis-matching ones.
        evaluateAllStrategies: true,
        channel: "ui",
        userLogin,
        overrideEnv: options.environment,
        // Issue #738: pass the symbol count so the scanner doesn't truncate to 20.
        maxSymbols: symbols.length,
        eventCalendarBySymbol: Object.fromEntries(scanCalendarCoverage.bySymbol),
      });
      const scanData = response.data as any;
      auditRunId = scanData?.scanRunId || reportRunId;
      if (!response.success) throw new Error(response.summary || "Scheduled options scan failed");
      const scannedCount = Number(scanData?.scanned ?? 0);
      const coverageErrors = Number(scanData?.coverage?.errors ?? 0);
      const truncatedCount = Number(scanData?.truncatedSymbols ?? scanData?.coverage?.truncated ?? 0);
      // Issue #916: Don't fail the entire run on partial chain failures.
      // Log the coverage gaps but continue with what we have. Only throw
      // if we have coverage data AND nothing was evaluated (total failure).
      // If coverage is missing (e.g. test mocks), don't throw — the old
      // code only threw on coverageErrors > 0.
      const hasCoverage = scanData?.coverage != null;
      const evaluatedCount = Number(scanData?.coverage?.evaluated ?? 0);
      if (hasCoverage && evaluatedCount === 0) {
        // Issue #915 (Mubasher): name the dominant skip reason alongside
        // the counts — counts alone left failing runs undiagnosable.
        // Issue #1290: the scanner now stamps that ranking on the
        // result (partial.topSkipReason); consume the stamp when
        // present and keep the local ranking only as the fallback for
        // hand-built results (e.g. test mocks) that carry no stamp.
        const skippedList: Array<{ reason?: unknown }> = Array.isArray(scanData?.skipped) ? scanData.skipped : [];
        const stampedReason =
          typeof scanData?.partial?.topSkipReason === "string" && scanData.partial.topSkipReason &&
          typeof scanData?.partial?.topSkipCount === "number" && scanData.partial.topSkipCount > 0
            ? (scanData.partial.topSkipReason as string)
            : null;
        let topReason: string | null = stampedReason;
        let topCount = stampedReason
          ? Number(scanData.partial.topSkipCount)
          : 0;
        if (!topReason) {
          const reasonCounts = new Map<string, number>();
          for (const entry of skippedList) {
            const reason = typeof entry?.reason === "string" && entry.reason ? entry.reason : "Unknown";
            reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
          }
          for (const [reason, count] of reasonCounts) {
            if (count > topCount) {
              topReason = reason;
              topCount = count;
            }
          }
        }
        const reasonSuffix = topReason
          ? ` Top skip reason: "${topReason}" (${topCount} of ${skippedList.length} failed symbols).`
          : "";
        throw new Error(
          codedMessage(
            "FAILURE_SCREEN_NO_CONTRACTS_EVALUATED",
            `Incomplete options universe: ${scannedCount} of ${symbols.length} underlyings scanned, ` +
            `${coverageErrors} quote/chain failures, ${truncatedCount} truncated.${reasonSuffix} No partial report published.`,
          )
        );
      }
      if (coverageErrors > 0 || truncatedCount > 0) {
        console.warn(
          `[ScheduledTasks] [FAILURE_SCREEN_PARTIAL_COVERAGE] Partial options coverage: ${scannedCount} of ${symbols.length} scanned, ` +
          `${coverageErrors} quote/chain failures, ${truncatedCount} truncated. Publishing partial report.`
        );
      }

      // Issue #275: tag each opportunity with its strategy's direction
      // tags (the catalog theses) before the PDF, the canonical report
      // and the channel payloads are built from this data — every
      // published copy carries the tags.
      if (Array.isArray(scanData?.opportunities)) {
        scanData.opportunities = tagOpportunitiesWithDirection(scanData.opportunities);
      }

      const notifications: { slack?: boolean; email?: boolean; webhook?: boolean } = {};
      let optionsPdfKey: string | undefined;
      let optionsPdf: Uint8Array | undefined;
      let optionsPdfFile: string | undefined;
      // Issue #1195 (#1173 R3b): options XLSX, twin of the PDF vars.
      let optionsXlsxKey: string | undefined;
      let optionsXlsx: Uint8Array | undefined;
      let optionsXlsxFile: string | undefined;
      let optionsCsvKey: string | undefined;
      let optionsCsv: Uint8Array | undefined;
      let optionsCsvFile: string | undefined;
      // Issue #914: Use the unified report pipeline (delegates to
      // ReportAssetAgent per #680, single owner for PDF generation).
      try {
        const { runReportPipeline } = await import("./unifiedReportPipeline");
        const pipelineResult = await runReportPipeline(
          this.env as any,
          null as any, // Storage handled by ReportAssetAgent internally
          {
            type: "options",
            trigger: "scheduled",
            result: response.data,
            userLogin,
            title: `Options scanner — ${targetThesis} (${timestamp.slice(0, 10)})`,
            summary: response.summary,
            timestamp,
          }
        );
        if (pipelineResult.pdfStatus === "generated") {
          optionsPdfKey = pipelineResult.pdfKey;
          // Fetch the bytes for Slack delivery
          const screenerAgent = this.getScreenerAgent(userLogin);
          const pdfData = await (screenerAgent as any).getPdfByKey(optionsPdfKey);
          if (pdfData) {
            optionsPdf = pdfData.bytes;
            optionsPdfFile = pdfData.fileName;
          }
        } else {
          // Issue #1023 (S4): NO direct-generator fallback — the unified
          // pipeline is the only PDF path (#914/#680). The run publishes
          // without a PDF: optionsPdfKey stays undefined, so no reportUrl
          // is fabricated, and the failure is visible here in the log.
          console.warn("[ScheduledTasksService] Options PDF generation via pipeline failed:", pipelineResult.pdfError);
        }
      } catch (pdfErr) {
        console.warn("[ScheduledTasksService] Options PDF generation/storage failed:", pdfErr instanceof Error ? pdfErr.message : String(pdfErr));
      }
      // Issue #1195 (#1173 R3b): generate + store the options XLSX
      // (own failure domain; recorded, never fatal).
      try {
        const screenerAgent = this.getScreenerAgent(userLogin);
        const stored = await (screenerAgent as any).generateAndStoreOptionsXlsx(
          adaptOpportunityScanToOptionScreenResult(response.data),
        );
        optionsXlsxKey = stored.key;
        optionsXlsxFile = stored.fileName;
        const data = await (screenerAgent as any).getOptionsXlsxByKey(stored.key);
        if (data) optionsXlsx = data.bytes;
      } catch (xlsxErr) {
        console.warn("[ScheduledTasksService] Options XLSX generation/storage failed:", xlsxErr instanceof Error ? xlsxErr.message : String(xlsxErr));
      }
      // Issue #1346: generate + store the options CSV (own failure
      // domain; recorded, never fatal). Issue #1569: the scheduled
      // path's unified scan result is an OpportunityScanResult, not
      // the OptionScreenResult the CSV generator reads — adapt at
      // this seam with the same #1291 adapter as the XLSX call above.
      try {
        const screenerAgent = this.getScreenerAgent(userLogin);
        const stored = await (screenerAgent as any).generateAndStoreOptionsCsv(
          adaptOpportunityScanToOptionScreenResult(response.data),
        );
        optionsCsvKey = stored.key;
        optionsCsvFile = stored.fileName;
        const data = await (screenerAgent as any).getOptionsCsvByKey(stored.key);
        if (data) optionsCsv = data.bytes;
      } catch (csvErr) {
        console.warn("[ScheduledTasksService] Options CSV generation/storage failed:", csvErr instanceof Error ? csvErr.message : String(csvErr));
      }
      const reportUrl = optionsPdfKey
        ? `${this.env.APP_BASE_URL || "https://agent.openaimp.com"}/api/options/report.pdf?key=${encodeURIComponent(optionsPdfKey)}`
        : undefined;

      // Store the searchable report once before any channel delivery. The
      // PDF remains in ScreenerAgent storage; mas_reports keeps its key/URL
      // and the complete structured scan payload for AI Search.
      const generationId = reportRunId;
      const canonical = storeOptionsCanonicalReport(this.orm, {
        runId: generationId,
        generationId,
        title: `Options scanner — ${targetThesis} (${timestamp.slice(0, 10)})`,
        source: "options_scanner",
        summary: response.summary,
        body: {
          generatedAt: timestamp,
          thesis: targetThesis,
          symbols,
          totalScanned: response.data?.scanned ?? symbols.length,
          withTrades: response.data?.withTrades ?? 0,
          opportunities: response.data?.opportunities ?? [],
          pdfKey: optionsPdfKey,
          pdfStatus: optionsPdfKey ? "generated" : "failed",
          xlsxKey: optionsXlsxKey,
          xlsxStatus: optionsXlsxKey ? "generated" : "failed",
          xlsxUrl: optionsXlsxKey
            ? `/api/options/report.xlsx?key=${encodeURIComponent(optionsXlsxKey)}`
            : undefined,
          csvKey: optionsCsvKey,
          csvStatus: optionsCsvKey ? "generated" : "failed",
          csvUrl: optionsCsvKey
            ? `/api/options/report.csv?key=${encodeURIComponent(optionsCsvKey)}`
            : undefined,
          reportUrl,
          report: typeof response.toWebhook === "function" ? response.toWebhook() : response.data,
        },
        createdAt: timestamp,
        // Options run-record fix: owner-scope the canonical row. Without it the
        // report is stored under `default` and the owner-scoped Reports
        // read cannot see the run it just produced.
        userLogin,
      },
      // Issue #1169 S4-1: thread this.env so the seam indexes this
      // options_scanner row at write time.
      this.env);

      // Consolidation C4 (#1329): chain mode suppresses the direct
      // Slack/email/webhook delivery below — the bridge's deliver jobs
      // carry the adopted PDF instead, so the artifact is delivered
      // exactly once. Audit + session message stay (they are the run's
      // record, not delivery channels).
      const chainMode = Boolean(options.stageChain);

      // One A2A file operation creates one Slack notification with the
      // summary attached, avoiding the old text-plus-file duplicate pair.
      if (shouldNotifySlack && !chainMode) {
        const slackChannel = options.slackChannel || (this.env as any).SCREENER_SLACK_CHANNEL || (this.env as any).SLACK_CHANNEL;
        // Issue #1718: a below-floor partial is NOT broadcast as a
        // success — degraded notice only, no PDF/files, no report link.
        // Persistence above (run record, canonical report, PDF) is
        // untouched: the run stays stored as evidence.
        if (optionsCoverageBelowBroadcastFloor(scanData?.partial)) {
          const degraded = formatDegradedCoverageNotice(scanData.partial, "Options screen", targetThesis);
          try {
            const delivery = await deliverScreenerToSlackA2A(this.env, { text: degraded, channel: slackChannel });
            notifications.slack = delivery.ok;
            if (!delivery.ok) console.warn("[ScheduledTasksService] Slack A2A degraded-coverage notice failed:", delivery.error);
          } catch (noticeErr) {
            console.warn("[ScheduledTasksService] Options Slack degraded-coverage notice failed:", noticeErr instanceof Error ? noticeErr.message : String(noticeErr));
            notifications.slack = false;
          }
        } else {
        const slackPayload = response.toSlack();
        const text = typeof slackPayload === "string" ? slackPayload : slackPayload.text || JSON.stringify(slackPayload);
        const matchCount = response.data?.matchedCount || response.data?.opportunities?.length || 0;
        try {
          const delivery = await deliverScreenerToSlackA2A(this.env, {
            text,
            channel: slackChannel,
            ...(optionsPdf && optionsPdfFile ? { pdf: {
              bytes: optionsPdf,
              fileName: optionsPdfFile,
              title: `Options Scanner Report — ${targetThesis} ${timestamp.slice(0, 10)}`,
              comment: `📄 Options scan PDF — ${matchCount} matches${reportUrl ? `\n${reportUrl}` : ""}\n\n${text}`,
            } } : {}),
            ...(optionsXlsx && optionsXlsxFile ? { files: [{
              bytes: optionsXlsx,
              fileName: optionsXlsxFile,
              title: optionsXlsxFile,
            }] } : {}),
            ...(optionsCsv && optionsCsvFile ? { files: [{
              bytes: optionsCsv,
              fileName: optionsCsvFile,
              title: optionsCsvFile,
            }] } : {}),
          });
          notifications.slack = delivery.ok;
          if (!delivery.ok) console.warn("[ScheduledTasksService] Slack A2A PDF delivery failed:", delivery.error);
        } catch (pdfErr) {
          console.warn("[ScheduledTasksService] Options Slack delivery failed:", pdfErr instanceof Error ? pdfErr.message : String(pdfErr));
          const delivery = await deliverScreenerToSlackA2A(this.env, { text, channel: slackChannel });
          notifications.slack = delivery.ok;
          if (!delivery.ok) console.warn("[ScheduledTasksService] Slack A2A notification failed:", delivery.error);
        }
        } // end else: at-or-above-floor success delivery (#1718)
      }

      // 2. Push Email if recipient is specified or environment configured
      // Issue #303: Try cfpay via A2A first, fall back to local.
      const targetEmail = options.emailTo || (this.env as any).OPTIONS_EMAIL_TO || (this.env as any).SCREENER_EMAIL_TO;
      if (targetEmail && !chainMode) {
        const cfpay = getCfpayConfig(this.env);
        let emailOk = false;
        if (cfpay) {
          try {
            const subject = `📊 E*TRADE Scheduled Options Intelligence [${targetThesis.toUpperCase()}] - ${symbols.join(", ")}`;
            const body = `${response.toEmailText()}${reportUrl ? `\n\nPDF report: ${reportUrl}` : ""}`;
            // Issue #1195: attach PDF + XLSX when the run produced them.
            const toB64 = (bytes: Uint8Array) => {
              let binary = "";
              for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
              return btoa(binary);
            };
            const cfpayAttachments = [
              ...(optionsPdf && optionsPdfFile ? [{ filename: optionsPdfFile, contentB64: toB64(optionsPdf), contentType: "application/pdf" }] : []),
              ...(optionsXlsx && optionsXlsxFile ? [{ filename: optionsXlsxFile, contentB64: toB64(optionsXlsx), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }] : []),
            ];
            let r;
            if (cfpayAttachments.length > 0) {
              r = await cfpaySendEmailWithAttachments(cfpay, {
                to: targetEmail,
                subject,
                body,
                attachments: cfpayAttachments,
              });
            } else {
              r = await cfpaySendEmail(cfpay, targetEmail, subject, body);
            }
            emailOk = r.ok;
            if (!r.ok) {
              console.warn("[ScheduledTasksService] cfpay Email failed, falling back to local:", r.error);
            }
          } catch (err) {
            console.warn("[ScheduledTasksService] cfpay Email error:", err);
          }
        }
        if (!emailOk) {
          try {
            const emailService = new ETradeEmailTradingService(this.env, this.orm, this.userLogin);
            notifications.email = await emailService.sendOutboundEmail(
              targetEmail,
              `📊 E*TRADE Scheduled Options Intelligence [${targetThesis.toUpperCase()}] - ${symbols.join(", ")}`,
              response.toEmailHtml(),
              `${response.toEmailText()}${reportUrl ? `\n\nPDF report: ${reportUrl}` : ""}`,
              // Issue #1195: PDF + XLSX attachments (array form, #1191).
              (() => {
                const toB64 = (bytes: Uint8Array) => {
                  let b = "";
                  for (let i = 0; i < bytes.length; i += 8192) b += String.fromCharCode(...bytes.subarray(i, i + 8192));
                  return btoa(b);
                };
                const list = [
                  ...(optionsPdf && optionsPdfFile ? [{ fileName: optionsPdfFile, contentType: "application/pdf", contentBase64: toB64(optionsPdf) }] : []),
                  ...(optionsXlsx && optionsXlsxFile ? [{ fileName: optionsXlsxFile, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contentBase64: toB64(optionsXlsx) }] : []),
                ];
                return list.length > 0 ? list : undefined;
              })()
            );
          } catch (emailErr) {
            console.warn("[ScheduledTasksService] Email notification error:", emailErr);
            notifications.email = false;
          }
        } else {
          notifications.email = true;
        }
      }

      // 3. Push Webhook if target URL is specified or default configured
      const targetWebhookUrl = options.webhookUrl || this.env.OUTBOUND_WEBHOOK_URL;
      if (targetWebhookUrl && !chainMode) {
        try {
          const webhookService = new ETradeWebhookService(this.orm, this.env, this.userLogin);
          const webhookPayload = { ...response.toWebhook(), reportUrl };
          const whResult = await webhookService.dispatchOutboundWebhook(
            "options.scheduled_analysis",
            webhookPayload,
            targetWebhookUrl
          );
          notifications.webhook = whResult.success;
          if (!whResult.success) {
            // e.g. no OUTBOUND_WEBHOOK_SECRET configured (issue #123/F20):
            // the flag above already reports false; log the reason too.
            console.warn("[ScheduledTasksService] Webhook notification not sent:", whResult.error || `HTTP ${whResult.status}`);
          }
        } catch (webhookErr) {
          console.warn("[ScheduledTasksService] Webhook notification error:", webhookErr);
          notifications.webhook = false;
        }
      }

      this.audit("options.scheduled_analysis_completed", {
        runId: auditRunId,
        screenType: "options",
        runType: options.trigger || "scheduled",
        symbols,
        thesis: targetThesis,
        scanned: response.data?.scanned ?? symbols.length,
        withTrades: response.data?.withTrades ?? 0,
        notifications,
        reportId: canonical?.reportId,
      });

      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content: `🎯 Scheduled Options Intelligence: ${response.summary}`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }

      // Issue #223: put the run on the screener event bus, mirroring the
      // stock screen (#210). In chain mode (#1329) the event carries
      // the PDF key + stage-chain config so the bridge can plan the
      // serve/deliver stages; unchained, delivery stays on the direct
      // A2A path and the event is the lifecycle record subscribers
      // consume.
      await this.publishScreenerEvent({
        type: "options.completed",
        timestamp,
        trigger: options.trigger || "scheduled",
        universe: options.universe,
        thesis: targetThesis,
        totalScanned: response.data?.scanned ?? symbols.length,
        withTrades: response.data?.withTrades ?? 0,
        symbols,
        summary: response.summary,
        reportUrl,
        pdfKey: optionsPdfKey,
        pdfStatus: optionsPdfKey ? "generated" : undefined,
        // Options run-record fix: the bus event is what the bridge records the run
        // from; without these the run's workbook + CSV never reach the
        // outcome, so Workflow Runs lists a PDF-only run.
        xlsxKey: optionsXlsxKey,
        xlsxStatus: optionsXlsxKey ? "generated" : undefined,
        csvKey: optionsCsvKey,
        csvStatus: optionsCsvKey ? "generated" : undefined,
        stageChain: options.stageChain,
        // Issue #1718: the qualification rides the event so the
        // lifecycle completed notice can apply the broadcast floor.
        partial: scanData?.partial,
        opportunities: (response.data?.opportunities || []).slice(0, 10).map((row: any) => ({
          symbol: row.symbol,
          strategy: row.pick?.best?.candidate?.type,
          directionTags: row.directionTags,
        })),
      });

      return {
        success: true,
        taskType: "options_analysis" as any,
        data: {
          totalScanned: response.data?.scanned ?? symbols.length,
          withTrades: response.data?.withTrades ?? 0,
          symbols,
          summary: response.summary,
          notifications,
          opportunities: response.data?.opportunities,
          reportUrl,
          // Issue #2091: the service's own artifact keys + canonical
          // row, so the orchestrator writer can carry them instead of
          // writing a second keyless row.
          pdfKey: optionsPdfKey,
          xlsxKey: optionsXlsxKey,
          csvKey: optionsCsvKey,
          canonicalReportId: canonical?.reportId ?? null,
        },
        timestamp,
      };
    } catch (err: any) {
      this.audit("options.scheduled_analysis_failed", {
        runId: auditRunId,
        screenType: "options",
        runType: options.trigger || "scheduled",
        symbols,
        thesis: targetThesis,
        error: err.message,
      });

      // Failure surfacing (issue #112): mirror the success path's
      // session message so a failed run is visible in the conversation,
      // not only in the audit log.
      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content: `⚠️ Scheduled Options Intelligence failed for ${symbols.join(", ") || options.universe || "NASDAQ100"}: ${err.message || "Scheduled options analysis failed"}`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }

      // Consolidation C4 (#1329): in chain mode the bridge's failure
      // notifications cover the failure, so the direct notice is
      // suppressed (same exactly-once rule as the success path).
      if (shouldNotifySlack && !options.stageChain) {
        const failure = await deliverScreenerToSlackA2A(this.env, {
          channel: options.slackChannel,
          text: `⚠️ Scheduled Options Screen FAILED — ${options.universe || symbols.join(", ") || "NASDAQ100"} (${targetThesis})\nError: ${err.message || "Scheduled options analysis failed"}\n_Time: ${timestamp}_`,
        });
        if (!failure.ok) console.warn("[ScheduledTasksService] Slack A2A failure notification failed:", failure.error);
      }

      // Issue #223: the failure joins the bus too, mirroring screener.failed.
      await this.publishScreenerEvent({
        type: "options.failed",
        timestamp,
        trigger: options.trigger || "scheduled",
        universe: options.universe,
        thesis: targetThesis,
        error: err.message || "Scheduled options analysis failed",
        stageChain: options.stageChain,
      });

      return {
        success: false,
        taskType: "options_analysis" as any,
        error: err.message || "Scheduled options analysis failed",
        timestamp,
      };
    }
  }

  /**
   * Scheduled strategy discovery (issue #126, PR-E): re-runs SAVED
   * StrategyRequests — captured whole from the discovery panel — against
   * live chains through the same panel pipeline function the interactive
   * route uses, and persists one run record per execution
   * (SqlDiscoveryRunStore) with per-symbol outcomes.
   *
   * The input model is deliberate (user decision on #126): the payload
   * carries complete requests and this task re-runs them verbatim. It
   * never derives a target price, a thesis, or any other part of a view
   * the user did not configure.
   *
   * Honesty contract (mirrors the scanner's, per #112): a failure to
   * resolve the owner/environment, a missing store, or an invalid
   * payload fails the task with audit + session message and persists
   * NOTHING. Once execution starts, exactly one run record is
   * persisted: "completed" when every request produced a result,
   * "partial" when some did and some failed (the failures are named on
   * the record), and "failed" when none did — an all-failed run takes
   * the failure path (audit + session message + { success: false })
   * and its record exists for diagnosis, never as a success.
   */

  /**
   * Issue #424: strategy-discovery failures were audit + session-message
   * only — silent in Slack/webhook terms, unlike every sibling scheduled
   * job (market screen failures fan out via the bus publishers; options
   * analysis failures send a Slack A2A notice). Mirror that fan-out here:
   * Slack (cfpay A2A when configured, else the bot-token service) plus the
   * outbound webhook, each best-effort. When no channel is configured at
   * all, audit the skip so the silence is at least on the record.
   */
  private async notifyStrategyDiscoveryFailure(args: {
    error: string;
    symbols: string[];
    trigger?: string;
    inputModel?: string;
  }): Promise<void> {
    const text =
      `⚠️ Scheduled Strategy Discovery FAILED — ${args.symbols.join(", ") || "no symbols"}\n` +
      `Error: ${args.error}\n_Time: ${new Date().toISOString()}_`;
    let attempted = false;
    try {
      if (getCfpayConfig(this.env)) {
        attempted = true;
        const result = await deliverScreenerToSlackA2A(this.env, { text });
        if (!result.ok) {
          console.warn("[ScheduledTasksService] Discovery failure Slack A2A failed:", result.error);
        }
      } else if (this.env.SLACK_BOT_TOKEN || this.env.SLACK_WEBHOOK_URL) {
        attempted = true;
        const slack = new ETradeSlackTradingService(this.env, this.orm, this.userLogin);
        await slack.postSlackMessage({ text } as any);
      }
    } catch (err) {
      console.warn(
        "[ScheduledTasksService] Discovery failure Slack notify failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
    const webhookUrl = this.env.OUTBOUND_WEBHOOK_URL;
    if (webhookUrl) {
      attempted = true;
      try {
        const webhook = new ETradeWebhookService(this.orm, this.env, this.userLogin);
        await webhook.dispatchOutboundWebhook(
          "options.strategy_discovery_failed",
          {
            error: args.error,
            symbols: args.symbols,
            trigger: args.trigger || "scheduled",
            ...(args.inputModel ? { inputModel: args.inputModel } : {}),
          },
          webhookUrl
        );
      } catch (err) {
        console.warn(
          "[ScheduledTasksService] Discovery failure webhook notify failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    if (!attempted) {
      this.audit("options.strategy_discovery_notify_skipped", {
        error: args.error,
        symbols: args.symbols,
        ...(args.inputModel ? { inputModel: args.inputModel } : {}),
        reason: "no notification channel configured",
      });
    }
  }

  async autonomousStrategyDiscovery(
    options: AutonomousStrategyDiscoveryOptions = {}
  ): Promise<ScheduledTaskResult<{
    runId: string;
    status: DiscoveryRunStatus;
    requestCount: number;
    completedCount: number;
    failedCount: number;
    symbols: string[];
    failures: Array<{ symbol: string; error: string }>;
    abstained?: Array<{ symbol: string; reason: string }>;
  }>> {
    const timestamp = new Date().toISOString();
    // Issue #534: the no-view input model has its own validation +
    // ranking flow. A payload carrying constraintSets under any other
    // (or no) discriminator routes here too, so the shape is judged
    // — and rejected as mixed — instead of being silently ignored by
    // a sibling model.
    if (options.inputModel === "no-view" || options.constraintSets !== undefined) {
      return this.autonomousStrategyDiscoveryNoView(options, timestamp);
    }
    // Issue #533: the profile-derived input model has its own
    // resolution + derivation flow; the saved-request path below is
    // untouched for every other payload.
    if (options.inputModel === "profile-derived") {
      return this.autonomousStrategyDiscoveryDerived(options, timestamp);
    }
    const requests = options.requests ?? [];
    const symbols = requests.map((r) => (typeof r?.symbol === "string" ? r.symbol.toUpperCase().trim() : "?"));

    const fail = async (error: string, runId?: string, status?: DiscoveryRunStatus, failures: Array<{ symbol: string; error: string }> = []) => {
      this.audit("options.strategy_discovery_failed", {
        symbols,
        trigger: options.trigger || "scheduled",
        ...(runId ? { runId } : {}),
        error,
      });
      // Issue #1333: discovery outcomes into the job-outcome sink.
      this.recordDiscoveryOutcome({
        id: runId ?? `discovery:${timestamp}:${symbols.join(",")}`,
        trigger: options.trigger || "scheduled",
        status: "failed",
        scanned: requests.length,
        matched: 0,
        codedError: error,
        createdAt: timestamp,
      });
      await this.notifyStrategyDiscoveryFailure({ error, symbols, trigger: options.trigger });
      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content: `⚠️ Scheduled Strategy Discovery failed for ${symbols.join(", ") || "no saved requests"}: ${error}`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }
      return {
        success: false,
        taskType: "strategy_discovery" as any,
        error,
        ...(runId
          ? {
              data: {
                runId,
                status: status as DiscoveryRunStatus,
                requestCount: requests.length,
                completedCount: requests.length - failures.length,
                failedCount: failures.length,
                symbols,
                failures,
              },
            }
          : {}),
        timestamp,
      } as ScheduledTaskResult<{
        runId: string;
        status: DiscoveryRunStatus;
        requestCount: number;
        completedCount: number;
        failedCount: number;
        symbols: string[];
        failures: Array<{ symbol: string; error: string }>;
        abstained?: Array<{ symbol: string; reason: string }>;
      }>;
    };

    try {
      const userLogin = options.userLogin || this.userLogin;
      if (!userLogin) {
        return await fail("No authenticated E*TRADE account is associated with this scheduled discovery. Open the schedules panel while signed in and run it again.");
      }
      if (!this.discoveryRunStore) {
        return await fail("Discovery run store not configured for this service instance");
      }
      if (!Array.isArray(requests) || requests.length === 0) {
        return await fail("Scheduled discovery requires at least one saved strategy request; none was supplied. Capture a view in the discovery panel and schedule it — no view is invented for a schedule.");
      }
      if (requests.length > MAX_SAVED_REQUESTS_PER_RUN) {
        return await fail(`Scheduled discovery is capped at ${MAX_SAVED_REQUESTS_PER_RUN} saved requests per run; ${requests.length} were supplied.`);
      }
      for (let i = 0; i < requests.length; i++) {
        const validationError = validateStrategyRequest(requests[i]);
        if (validationError) {
          return await fail(`Saved discovery request ${i + 1} of ${requests.length} (${symbols[i]}) is invalid: ${validationError}`);
        }
      }

      // One client/agent set for the whole execution — the same
      // construction the interactive strategies route uses, under the
      // schedule owner's identity and environment (#447/#461).
      const etrade = this.createETradeService(userLogin, options.environment);
      const agents: PanelAgents = {
        data: new OptionsDataAgent(new DynamicOptionsScreener(etrade.client, undefined, await this.scheduledUniverseDeps(userLogin))),
        risk: new StrategyRiskAgent(),
        recommender: new RecommendationAgent(),
      };

      const outcomes: DiscoverySymbolOutcome[] = [];
      for (const request of requests) {
        outcomes.push(await this.runDiscoveryRequest(agents, etrade, request, options.snapshotInput, userLogin));
      }

      const failures = outcomes
        .filter((o) => o.status === "failed")
        .map((o) => ({ symbol: o.symbol, error: o.error || "unknown failure" }));
      const status: DiscoveryRunStatus =
        failures.length === 0 ? "completed" : failures.length === outcomes.length ? "failed" : "partial";

      const run = await this.discoveryRunStore.save({
        createdAt: timestamp,
        trigger: options.trigger === "manual" ? "manual-trigger" : "scheduled",
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
        userLogin,
        inputModel: "saved-request",
        requests,
        outcomes,
        status,
      });

      await this.persistDiscoveryCanonicalAndBridge({
        run,
        summary: `Strategy discovery (saved-request) ${status}: ${requests.length - failures.length} of ${requests.length} requests produced results.`,
        symbols,
        options,
        timestamp,
        outcomes,
        matchedCount: requests.length - failures.length,
        totalScanned: requests.length,
      });

      if (status === "failed") {
        return await fail(
          `Every saved discovery request failed (${failures.map((f) => `${f.symbol}: ${f.error}`).join("; ")})`,
          run.id,
          status,
          failures
        );
      }

      this.audit("options.strategy_discovery_completed", {
        runId: run.id,
        status,
        symbols,
        requestCount: requests.length,
        completedCount: requests.length - failures.length,
        failedCount: failures.length,
        trigger: options.trigger || "scheduled",
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
      });
      // Issue #1333: discovery outcomes into the job-outcome sink.
      this.recordDiscoveryOutcome({
        id: run.id,
        trigger: options.trigger || "scheduled",
        status: status === "completed" ? "completed" : "partial",
        scanned: requests.length,
        matched: requests.length - failures.length,
        codedError: failures.length > 0 ? failures.map((f) => `${f.symbol}: ${f.error}`).join("; ") : undefined,
        createdAt: timestamp,
      });

      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content:
              status === "completed"
                ? `🔭 Scheduled Strategy Discovery completed for ${symbols.join(", ")}: all ${requests.length} saved requests produced results.`
                : `🔭 Scheduled Strategy Discovery partially completed for ${symbols.join(", ")}: ${requests.length - failures.length} of ${requests.length} requests produced results; failed: ${failures.map((f) => `${f.symbol} (${f.error})`).join("; ")}.`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }

      return {
        success: true,
        taskType: "strategy_discovery" as any,
        data: {
          runId: run.id,
          status,
          requestCount: requests.length,
          completedCount: requests.length - failures.length,
          failedCount: failures.length,
          symbols,
          failures,
        },
        timestamp,
      };
    } catch (err: any) {
      return await fail(err?.message || "Scheduled strategy discovery failed");
    }
  }

  /**
   * Consolidation C4 (#1329): persist the canonical mas_reports row
   * for a discovery run and, when the run carries stageChain, bridge
   * it (generate + serve stages, then deliver when the task named
   * channels — #1236 notifications). Called right after the detail
   * save, before the status is judged — so even a failed run gains
   * its canonical row (the detail prune can never erase it from
   * GET /api/runs). Failed runs do NOT bridge and do NOT deliver:
   * their failure-notice path is channel-divergent from the
   * bridge's, and suppressing it would risk a lost notice. A bridge
   * failure never fails the run itself — it is logged, and the
   * canonical row is the record. Non-chain runs deliver directly
   * (Phase 1) when the task named channels; chain mode suppresses
   * direct delivery so the notification is sent exactly once.
   */
  private async persistDiscoveryCanonicalAndBridge(args: {
    run: { id: string; status: DiscoveryRunStatus; inputModel: string };
    summary: string;
    symbols: string[];
    options: AutonomousStrategyDiscoveryOptions;
    timestamp: string;
    outcomes: DiscoverySymbolOutcome[];
    matchedCount: number;
    totalScanned: number;
  }): Promise<string | undefined> {
    let reportId: string | undefined;
    if (this.orm) {
      // Issue #2180: the run report's document set, generated BEFORE the
      // canonical write so the row carries the keys — the store is
      // insert-only per generation id, so a later write could never attach
      // them.
      const reportInput: DiscoveryReportInput = {
        runId: args.run.id,
        createdAt: args.timestamp,
        trigger: args.options.trigger || "scheduled",
        inputModel: args.run.inputModel,
        status: args.run.status,
        summary: args.summary,
        symbols: args.symbols,
        matchedCount: args.matchedCount,
        totalScanned: args.totalScanned,
        outcomes: args.outcomes,
      };
      const artifacts = await generateAndStoreDiscoveryReport({
        env: this.env,
        storage: (this.platformDeps as { blobStorage?: unknown } | undefined)?.blobStorage as any,
        input: reportInput,
      });
      const stored = await storeReportStage(this.orm, {
        runId: `discovery:${args.run.id}`,
        generationId: `discovery:${args.run.id}`,
        title: `Strategy discovery — ${args.run.inputModel}`,
        source: "discovery",
        summary: args.summary,
        body: buildDiscoveryCanonicalBody(
          {
            discoveryRunId: args.run.id,
            status: args.run.status,
            inputModel: args.run.inputModel,
            symbols: args.symbols,
            trigger: args.options.trigger || "scheduled",
            // Consolidation #1236 (feed seam): surface the feed inputs
            // through serve — which artifact fed each symbol, its
            // asOf, and whether it was stale. Only in snapshot mode.
            ...(args.outcomes.some((o) => o.snapshotInput)
              ? {
                  snapshotInputs: args.outcomes
                    .filter((o) => o.snapshotInput)
                    .map((o) => ({ symbol: o.symbol, ...o.snapshotInput })),
                }
              : {}),
          },
          artifacts,
        ),
        createdAt: args.timestamp,
        userLogin: this.userLogin,
      },
      // Issue #1169 S4-1: thread this.env so the seam indexes this
      // discovery row at write time.
      this.env);
      reportId = stored?.reportId;
    }
    if (args.run.status !== "failed") {
      const outcome = buildDiscoveryDeliveryOutcome({
        runId: args.run.id,
        status: args.run.status,
        inputModel: args.run.inputModel,
        symbols: args.symbols,
        summary: args.summary,
        trigger: args.options.trigger || "scheduled",
        matchedCount: args.matchedCount,
        totalScanned: args.totalScanned,
        outcomes: args.outcomes,
        reportId,
        chainMode: Boolean(args.options.stageChain),
        stageChain: args.options.stageChain,
        emailTo: args.options.emailTo,
        slackChannel: args.options.slackChannel,
        webhookUrl: args.options.webhookUrl,
      });
      if (args.options.stageChain && this.followupScheduler) {
        const scheduler = this.followupScheduler;
        try {
          // Issue #1999: serve submission retries under the report
          // policy; a final failure is audited, never silent.
          await withRetry(
            () => scheduler(outcome, this.userLogin, true),
            resolvePipelinePolicy(this.env as unknown as Record<string, unknown>).retry.report,
            { label: "followup-bridge" },
          );
        } catch (bridgeErr) {
          console.warn("[ScheduledTasksService] Discovery bridge failed (canonical row kept):", bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr));
          this.audit("followup.schedule_failed", {
            bridge: "discovery",
            error: bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr),
          });
        }
      } else if (!args.options.stageChain) {
        await this.sendDiscoveryDirect(outcome);
      }
    }
    return reportId;
  }

  /**
   * Consolidation #1236 Phase 1: deliver a non-chain discovery
   * notification directly through the delivery port — the same
   * transports, footer, allowlist, and per-channel isolation as the
   * chain path, so direct and chain texts are identical for the
   * same outcome. Best-effort by design: a failure is audited via
   * warn and never fails the run. Without an ORM there is no
   * canonical row to link, so delivery is skipped (the content
   * spec requires the canonical link).
   */
  private async sendDiscoveryDirect(outcome: ScreenerRunOutcome): Promise<void> {
    if (!this.orm) {
      console.warn("[ScheduledTasksService] Discovery direct delivery skipped: no ORM (no canonical row to link).");
      return;
    }
    try {
      const port = createFollowupDeliveryPort({
        env: this.env,
        getOrm: () => this.orm as DatabaseORM,
        getScreenerAgent: (userLogin?: string) => this.getScreenerAgent(userLogin),
      });
      const results = await deliverDiscoveryDirect({
        port,
        outcome,
        config: resolveScreenerFollowupConfig(this.env as unknown as Record<string, unknown>),
        userLogin: this.userLogin,
      });
      for (const result of results) {
        if (!result.ok) {
          console.warn(`[ScheduledTasksService] Discovery direct delivery failed (${result.channel}):`, result.error ?? "unknown error");
        }
      }
    } catch (err) {
      console.warn("[ScheduledTasksService] Discovery direct delivery failed:", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Runs ONE constructed discovery request through the pipeline and
   * shapes its outcome. Shared verbatim by the saved-request path
   * (issue #126) and the profile-derived path (issue #533) — the two
   * input models differ in where requests come from, never in how a
   * request is executed or judged.
   */
  private async runDiscoveryRequest(
    agents: PanelAgents,
    etrade: ETradeService,
    request: StrategyRequest,
    snapshotInput?: FeedSnapshotInput,
    userLogin?: string,
  ): Promise<DiscoverySymbolOutcome> {
    const symbol = request.symbol.toUpperCase().trim();
    try {
      // Consolidation #1236 (feed seam): snapshot-input mode. The
      // stored snapshot replaces the live load (panel shim
      // override); the pipeline downstream is unchanged. A missing
      // artifact or filter mismatch fails this symbol explicitly —
      // never a silent live fallback, which would hide the missing
      // feed and run on different data than the schedule named.
      let snapshotOverride: OptionsDataSnapshot | undefined;
      let snapshotProvenance: DiscoverySymbolOutcome["snapshotInput"];
      if (snapshotInput) {
        if (!this.feedSnapshotStore) {
          return { symbol, status: "failed", request, error: "feed snapshot store not configured for this service instance" };
        }
        const resolved = resolveFeedSnapshotForSymbol({
          store: this.feedSnapshotStore,
          userLogin: userLogin ?? this.userLogin,
          symbol,
          input: snapshotInput,
          requestFilters: pickFeedLoadParams(request),
          nowMs: Date.now(),
        });
        if (resolved.status === "missing") {
          return { symbol, status: "failed", request, error: resolved.reason };
        }
        snapshotOverride = resolved.artifact.snapshot;
        snapshotProvenance = {
          artifactId: resolved.artifact.id,
          asOf: resolved.artifact.asOf,
          stale: resolved.stale,
        };
        if (resolved.stale) {
          this.audit("options.strategy_discovery_snapshot_stale", {
            symbol,
            artifactId: resolved.artifact.id,
            asOf: resolved.artifact.asOf,
            maxAgeSeconds: snapshotInput.maxAgeSeconds,
          });
        }
      }
      const result = await runPanelWithAgents(agents, request, snapshotOverride ? { snapshotOverride } : {});
      const snapshot = result.snapshot;
      // A snapshot that never loaded its chain is a failure, not
      // an empty success: the screen records why (validation
      // error, per-symbol fetch errors, or the client's recorded
      // upstream cause). Zero contracts with NO failure signal is
      // a genuine no-candidates outcome and completes honestly.
      const fetchReasons = (snapshot.screen.fetchErrors ?? [])
        .filter((e) => e.symbol === symbol)
        .map((e) => e.reason);
      let failure: string | undefined;
      if (snapshot.validationError) {
        failure = snapshot.validationError;
      } else if (snapshot.contracts.length === 0 && fetchReasons.length > 0) {
        failure = fetchReasons.join("; ");
      } else if (snapshot.contracts.length === 0) {
        failure = etrade.getLastError() || undefined;
      }
      if (failure) {
        return { symbol, status: "failed", request, error: failure };
      }
      return {
        symbol,
        status: "completed",
        request,
        ranked: result.ranked,
        riskReports: result.riskReports,
        screenedOut: result.screenedOut.slice(0, 50),
        excluded: result.strategies.excluded,
        bestTrade: result.bestTrade,
        snapshot: {
          dataSource: snapshot.dataSource,
          screen: snapshot.screen,
          ...(snapshot.validationError ? { validationError: snapshot.validationError } : {}),
        },
        ...(snapshotProvenance ? { snapshotInput: snapshotProvenance } : {}),
      };
    } catch (err: any) {
      return {
        symbol,
        status: "failed",
        request,
        error: err?.message || "Strategy discovery pipeline failed",
      };
    }
  }

  /**
   * Issue #533 (D4): resolves a watchlist NAME to its symbols from
   * the owner's stored watchlists — no E*TRADE round-trip, so
   * watchlist edits between arming and firing are honoured. The name
   * match is trimmed and case-insensitive. Returns null when no
   * stored watchlist matches (or the ORM is unavailable); the caller
   * fails honestly and persists nothing.
   */
  private resolveWatchlistSymbols(name: string, userLogin: string): string[] | null {
    if (!this.orm?.watchlists) return null;
    try {
      const rows = this.orm.watchlists.findMany({ where: { userLogin } }) as Array<{
        name?: string;
        symbolsJson?: string | null;
      }>;
      const key = name.trim().toLowerCase();
      const match = rows.find(
        (row) => typeof row?.name === "string" && row.name.trim().toLowerCase() === key
      );
      if (!match) return null;
      const seen = new Set<string>();
      const symbols: string[] = [];
      for (const raw of flattenWatchlistSymbols([match])) {
        const symbol = typeof raw === "string" ? raw.toUpperCase().trim() : "";
        if (symbol && !seen.has(symbol)) {
          seen.add(symbol);
          symbols.push(symbol);
        }
      }
      return symbols;
    } catch {
      return null;
    }
  }

  /**
   * The profile-derived discovery fire (issue #533). The schedule
   * armed a symbol set (explicit, or a watchlist name resolved at
   * fire time) plus a Strategy Profile id; the profile is resolved
   * NOW, so edits and deletions since arming are honoured as honest
   * outcomes. Each symbol's target is derived from its own live
   * chain under the profile (see derivation module), the constructed
   * request runs through the unchanged pipeline, and the run persists
   * stamped "profile-derived" with the profile reference and the full
   * derivation per symbol. A symbol that cannot be derived honestly
   * ABSTAINS — reason on the record, no request, no target — and an
   * all-abstained fire persists as a FAILED run on the #112 failure
   * path. Resolution failures before execution (identity, stores,
   * profile, symbol set) persist NOTHING, the saved-path precedent.
   */
  private async autonomousStrategyDiscoveryDerived(
    options: AutonomousStrategyDiscoveryOptions,
    timestamp: string
  ): Promise<ScheduledTaskResult<{
    runId: string;
    status: DiscoveryRunStatus;
    requestCount: number;
    completedCount: number;
    failedCount: number;
    symbols: string[];
    failures: Array<{ symbol: string; error: string }>;
    abstained?: Array<{ symbol: string; reason: string }>;
  }>> {
    let attemptedSymbols: string[] = Array.isArray(options.symbols)
      ? options.symbols
          .map((s) => (typeof s === "string" ? s.toUpperCase().trim() : ""))
          .filter((s) => s.length > 0)
      : [];

    const fail = async (
      error: string,
      runId?: string,
      status?: DiscoveryRunStatus,
      failures: Array<{ symbol: string; error: string }> = [],
      abstentions: Array<{ symbol: string; reason: string }> = [],
      constructedCount = 0
    ) => {
      this.audit("options.strategy_discovery_failed", {
        symbols: attemptedSymbols,
        inputModel: "profile-derived",
        trigger: options.trigger || "scheduled",
        ...(runId ? { runId } : {}),
        ...(abstentions.length > 0 ? { abstained: abstentions } : {}),
        error,
      });
      // Issue #1333: profile-derived discovery outcomes into the sink.
      this.recordDiscoveryOutcome({
        id: runId ?? `discovery:profile-derived:${attemptedSymbols.join(",")}`,
        trigger: options.trigger || "scheduled",
        status: "failed",
        scanned: constructedCount,
        matched: 0,
        codedError: error,
      });
      await this.notifyStrategyDiscoveryFailure({ error, symbols: attemptedSymbols, trigger: options.trigger, inputModel: "profile-derived" });
      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content: `⚠️ Scheduled Strategy Discovery failed for ${attemptedSymbols.join(", ") || "no symbols"}: ${error}`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }
      return {
        success: false,
        taskType: "strategy_discovery" as any,
        error,
        ...(runId ? {
          data: {
            runId,
            status: status ?? "failed",
            requestCount: constructedCount,
            completedCount: constructedCount - failures.length,
            failedCount: failures.length,
            symbols: attemptedSymbols,
            failures,
            abstained: abstentions,
          },
        } : {}),
        timestamp,
      } as ScheduledTaskResult<{
        runId: string;
        status: DiscoveryRunStatus;
        requestCount: number;
        completedCount: number;
        failedCount: number;
        symbols: string[];
        failures: Array<{ symbol: string; error: string }>;
        abstained?: Array<{ symbol: string; reason: string }>;
      }>;
    };

    try {
      const userLogin = options.userLogin || this.userLogin;
      if (!userLogin) {
        return await fail(
          "No authenticated E*TRADE account is associated with this scheduled discovery. Open the schedules panel while signed in and run it again."
        );
      }
      if (!this.discoveryRunStore) {
        return await fail("Discovery run store not configured for this service instance");
      }
      if (!this.strategyProfileStore) {
        return await fail("Strategy profile store not configured for this service instance");
      }
      const profileId = typeof options.profileId === "string" ? options.profileId.trim() : "";
      if (!profileId) {
        return await fail(
          "Profile-derived discovery requires a profileId; none was supplied. The schedule must name the Strategy Profile its targets are derived under."
        );
      }
      const profile = await this.strategyProfileStore.get(userLogin, profileId);
      if (!profile) {
        // Deleted (or never existed) since arming: an honest failure
        // naming the profile — never a silently substituted view.
        return await fail(
          `Strategy profile ${profileId} was not found for this account. It may have been deleted after the schedule was armed; no run was recorded.`
        );
      }

      const hasSymbols = options.symbols !== undefined;
      const hasWatchlist = options.watchlistName !== undefined;
      if (hasSymbols === hasWatchlist) {
        return await fail(
          "Profile-derived discovery requires exactly one symbol source: payload.symbols or payload.watchlistName."
        );
      }
      let symbols: string[];
      if (hasSymbols) {
        if (!Array.isArray(options.symbols)) {
          return await fail("Profile-derived discovery requires exactly one symbol source: payload.symbols or payload.watchlistName.");
        }
        const seen = new Set<string>();
        symbols = [];
        for (const raw of options.symbols) {
          const symbol = typeof raw === "string" ? raw.toUpperCase().trim() : "";
          if (symbol && !seen.has(symbol)) {
            seen.add(symbol);
            symbols.push(symbol);
          }
        }
      } else {
        const name = typeof options.watchlistName === "string" ? options.watchlistName : "";
        const resolved = name.trim() ? this.resolveWatchlistSymbols(name, userLogin) : null;
        if (!resolved) {
          return await fail(
            `Watchlist "${options.watchlistName}" was not found among this account's stored watchlists; no run was recorded.`
          );
        }
        symbols = resolved;
      }
      attemptedSymbols = symbols;
      if (symbols.length === 0) {
        return await fail(
          "Profile-derived discovery resolved to no symbols; there is nothing to derive. No run was recorded."
        );
      }
      if (symbols.length > MAX_SAVED_REQUESTS_PER_RUN) {
        return await fail(
          `Scheduled discovery is capped at ${MAX_SAVED_REQUESTS_PER_RUN} symbols per run; ${symbols.length} were resolved.`
        );
      }

      // One client/agent set for the whole execution — the saved
      // path's construction, under the schedule owner's identity and
      // environment (#447/#461, #672).
      const etrade = this.createETradeService(userLogin, options.environment);
      const agents: PanelAgents = {
        data: new OptionsDataAgent(new DynamicOptionsScreener(etrade.client, undefined, await this.scheduledUniverseDeps(userLogin))),
        risk: new StrategyRiskAgent(),
        recommender: new RecommendationAgent(),
      };
      const emMultiples = getOpportunityScannerConfig().targetEmMultiples;

      const outcomes: DiscoverySymbolOutcome[] = [];
      const constructed: StrategyRequest[] = [];
      for (const symbol of symbols) {
        let derivationSnapshot: Awaited<ReturnType<typeof agents.data.loadSnapshot>>;
        try {
          derivationSnapshot = await agents.data.loadSnapshot({
            symbol,
            minDte: profile.minDte,
            maxDte: profile.maxDte,
          });
        } catch (err: any) {
          // The derivation input itself failed to load: an
          // abstention (the symbol was never derived), not a
          // pipeline failure.
          outcomes.push({
            symbol,
            status: "abstained",
            error: err?.message || "Chain snapshot failed to load",
          });
          continue;
        }
        const derived = deriveDiscoveryRequest({
          symbol,
          snapshot: derivationSnapshot,
          profile,
          emMultiples,
          now: new Date(timestamp),
        });
        if (!derived.derived) {
          outcomes.push({
            symbol,
            status: "abstained",
            error: derived.reason,
            ...(derived.derivation ? { derivation: derived.derivation } : {}),
          });
          continue;
        }
        constructed.push(derived.request);
        // Issue #16: attach this name's event calendar before the
        // pipeline runs — the persisted run record carries it on the
        // request, so the run's calendar facts stay auditable. The
        // service never throws; uncovered keeps event risk unverified.
        derived.request.eventCalendar = await getSymbolEventCalendar(symbol);
        const outcome = await this.runDiscoveryRequest(agents, etrade, derived.request, options.snapshotInput, userLogin);
        outcomes.push({ ...outcome, derivation: derived.derivation });
      }

      const failures = outcomes
        .filter((o) => o.status === "failed")
        .map((o) => ({ symbol: o.symbol, error: o.error || "unknown failure" }));
      const abstentions = outcomes
        .filter((o) => o.status === "abstained")
        .map((o) => ({ symbol: o.symbol, reason: o.error || "abstained" }));
      const completedCount = outcomes.filter((o) => o.status === "completed").length;
      const status: DiscoveryRunStatus =
        outcomes.length > 0 && completedCount === outcomes.length
          ? "completed"
          : completedCount === 0
            ? "failed"
            : "partial";

      const profileRef = toProfileRef(profile);
      // The run is persisted BEFORE the status is judged — an
      // all-abstained/failed fire's record is exactly what makes the
      // honesty inspectable (and the run id joins the failure data).
      const run = await this.discoveryRunStore.save({
        createdAt: timestamp,
        trigger: options.trigger === "manual" ? "manual-trigger" : "scheduled",
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
        userLogin,
        inputModel: "profile-derived",
        profileRef,
        requests: constructed,
        outcomes,
        status,
      });

      await this.persistDiscoveryCanonicalAndBridge({
        run,
        summary: `Strategy discovery (profile-derived) ${status}: ${completedCount} of ${constructed.length} derived requests produced results.`,
        symbols,
        options,
        timestamp,
        outcomes,
        matchedCount: completedCount,
        totalScanned: constructed.length,
      });

      if (status === "failed") {
        const parts = [
          ...failures.map((f) => `${f.symbol}: ${f.error}`),
          ...abstentions.map((a) => `${a.symbol}: abstained (${a.reason})`),
        ];
        return await fail(
          `No derived discovery request produced a result (${parts.join("; ")})`,
          run.id,
          status,
          failures,
          abstentions,
          constructed.length
        );
      }

      this.audit("options.strategy_discovery_completed", {
        runId: run.id,
        status,
        symbols,
        inputModel: "profile-derived",
        profileRef,
        requestCount: constructed.length,
        // Issue #16: how many of the run's names carried live calendar
        // coverage (the per-name facts ride on the persisted requests).
        eventCalendarCoverage: {
          covered: constructed.filter((r) => r.eventCalendar?.covered).length,
          total: symbols.length,
        },
        completedCount,
        failedCount: failures.length,
        abstained: abstentions,
        trigger: options.trigger || "scheduled",
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
      });
      // Issue #1333: profile-derived discovery outcomes into the sink.
      this.recordDiscoveryOutcome({
        id: run.id,
        trigger: options.trigger || "scheduled",
        status,
        scanned: constructed.length,
        matched: completedCount,
        codedError: failures.length > 0 ? failures.map((f) => `${f.symbol}: ${f.error}`).join("; ") : undefined,
        createdAt: timestamp,
      });

      if (this.orm?.messages) {
        try {
          const failureNote = failures.length > 0
            ? `; failed: ${failures.map((f) => `${f.symbol} (${f.error})`).join("; ")}`
            : "";
          const abstainNote = abstentions.length > 0
            ? `; abstained: ${abstentions.map((a) => `${a.symbol} (${a.reason})`).join("; ")}`
            : "";
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content:
              status === "completed"
                ? `🔭 Scheduled Strategy Discovery (profile-derived) completed for ${symbols.join(", ")}: all ${constructed.length} derived requests produced results.`
                : `🔭 Scheduled Strategy Discovery (profile-derived) partially completed for ${symbols.join(", ")}: ${completedCount} of ${constructed.length} derived requests produced results${failureNote}${abstainNote}.`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }
      return {
        success: true,
        taskType: "strategy_discovery" as any,
        data: {
          runId: run.id,
          status,
          requestCount: constructed.length,
          completedCount,
          failedCount: failures.length,
          symbols: attemptedSymbols,
          failures,
          abstained: abstentions,
        },
        timestamp,
      };
    } catch (err: any) {
      return await fail(err?.message || "Scheduled strategy discovery failed");
    }
  }

  /**
   * The no-view discovery fire (issue #534). The schedule armed
   * constraint sets — a symbol plus constraints per set, with NO
   * thesis and NO target anywhere — and each symbol's live chain is
   * ranked once by the target-free score model (no-view-v1). Nothing
   * in this path constructs, derives, or defaults a StrategyRequest:
   * the question is "which structures does this symbol's chain
   * support best under these constraints", and where the honest
   * answer is "none" the symbol ABSTAINS — a completed outcome with
   * the gate reasons recorded and a no_trade pick — rather than
   * failing or crowning a best-of-garbage. Status semantics mirror
   * the sibling models with the plan's one deliberate difference:
   * all-failed takes the #112 failure path, an all-abstained fire is
   * a COMPLETED run (an honest "nothing qualifies"), and any other
   * mix is partial. Shape/validation failures before execution
   * (identity, store, mixed or empty payload, an invalid or
   * view-smuggling constraint set) persist NOTHING.
   */
  private async autonomousStrategyDiscoveryNoView(
    options: AutonomousStrategyDiscoveryOptions,
    timestamp: string
  ): Promise<ScheduledTaskResult<{
    runId: string;
    status: DiscoveryRunStatus;
    requestCount: number;
    completedCount: number;
    failedCount: number;
    symbols: string[];
    failures: Array<{ symbol: string; error: string }>;
    abstained?: Array<{ symbol: string; reason: string }>;
  }>> {
    const constraintSets = Array.isArray(options.constraintSets) ? options.constraintSets : [];
    const symbols = constraintSets.map((s) =>
      typeof s?.symbol === "string" ? s.symbol.toUpperCase().trim() : "?"
    );

    const fail = async (
      error: string,
      runId?: string,
      status?: DiscoveryRunStatus,
      failures: Array<{ symbol: string; error: string }> = [],
      abstentions: Array<{ symbol: string; reason: string }> = []
    ) => {
      this.audit("options.strategy_discovery_failed", {
        symbols,
        inputModel: "no-view",
        trigger: options.trigger || "scheduled",
        ...(runId ? { runId } : {}),
        ...(abstentions.length > 0 ? { abstained: abstentions } : {}),
        error,
      });
      // Issue #1333: no-view discovery outcomes into the sink.
      this.recordDiscoveryOutcome({
        id: runId ?? `discovery:no-view:${symbols.join(",")}`,
        trigger: options.trigger || "scheduled",
        status: "failed",
        scanned: symbols.length,
        matched: 0,
        codedError: error,
      });
      await this.notifyStrategyDiscoveryFailure({ error, symbols, trigger: options.trigger, inputModel: "no-view" });
      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content: `⚠️ Scheduled Strategy Discovery (no-view) failed for ${symbols.join(", ") || "no constraint sets"}: ${error}`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }
      return {
        success: false,
        taskType: "strategy_discovery" as any,
        error,
        ...(runId ? {
          data: {
            runId,
            status: status ?? "failed",
            requestCount: constraintSets.length,
            completedCount: constraintSets.length - failures.length - abstentions.length,
            failedCount: failures.length,
            symbols,
            failures,
            abstained: abstentions,
          },
        } : {}),
        timestamp,
      } as ScheduledTaskResult<{
        runId: string;
        status: DiscoveryRunStatus;
        requestCount: number;
        completedCount: number;
        failedCount: number;
        symbols: string[];
        failures: Array<{ symbol: string; error: string }>;
        abstained?: Array<{ symbol: string; reason: string }>;
      }>;
    };

    try {
      const userLogin = options.userLogin || this.userLogin;
      if (!userLogin) {
        return await fail(
          "No authenticated E*TRADE account is associated with this scheduled discovery. Open the schedules panel while signed in and run it again."
        );
      }
      if (!this.discoveryRunStore) {
        return await fail("Discovery run store not configured for this service instance");
      }
      if (options.inputModel !== "no-view") {
        return await fail(
          `No-view constraint sets require inputModel "no-view"; this payload carries ${options.inputModel ? `"${options.inputModel}"` : "no inputModel"}. The discovery input models are mutually exclusive — no run was recorded.`
        );
      }
      if (
        options.requests !== undefined ||
        options.symbols !== undefined ||
        options.watchlistName !== undefined ||
        options.profileId !== undefined
      ) {
        return await fail(
          "No-view discovery payloads carry constraintSets only — requests, symbols, watchlistName and profileId belong to the other discovery input models. Mixed payload shapes are rejected, never partially honoured; no run was recorded."
        );
      }
      if (!Array.isArray(options.constraintSets) || options.constraintSets.length === 0) {
        return await fail(
          "No-view discovery requires at least one constraint set in payload.constraintSets; none was supplied. A constraint set names a symbol and its constraints only — no view is invented for a schedule."
        );
      }
      if (options.constraintSets.length > MAX_SAVED_REQUESTS_PER_RUN) {
        return await fail(
          `Scheduled discovery is capped at ${MAX_SAVED_REQUESTS_PER_RUN} symbols per run; ${options.constraintSets.length} constraint sets were supplied.`
        );
      }
      // Every set is validated BEFORE any chain loads: an invalid
      // set — including one smuggling a thesis/target past the type
      // (validateNoViewRequest rejects view fields outright) — fails
      // the whole payload pre-execution, the saved-path precedent.
      for (let i = 0; i < options.constraintSets.length; i++) {
        const validationError = validateNoViewRequest(
          options.constraintSets[i] as Parameters<typeof validateNoViewRequest>[0]
        );
        if (validationError) {
          return await fail(
            `No-view constraint set ${i + 1} of ${options.constraintSets.length} (${symbols[i]}) is invalid: ${validationError}`
          );
        }
      }

      // One client/agent set for the whole execution — the saved
      // path's construction, under the schedule owner's identity and
      // environment (#447/#461).
      const etrade = this.createETradeService(userLogin, options.environment);
      const agents: PanelAgents = {
        data: new OptionsDataAgent(new DynamicOptionsScreener(etrade.client, undefined, await this.scheduledUniverseDeps(userLogin))),
        risk: new StrategyRiskAgent(),
        recommender: new RecommendationAgent(),
      };

      const outcomes: DiscoverySymbolOutcome[] = [];
      for (const constraintSet of options.constraintSets) {
        outcomes.push(await this.runNoViewDiscoveryRequest(agents, etrade, constraintSet));
      }

      const failures = outcomes
        .filter((o) => o.status === "failed")
        .map((o) => ({ symbol: o.symbol, error: o.error || "unknown failure" }));
      const abstentions = outcomes
        .filter((o) => o.abstained === true)
        .map((o) => ({
          symbol: o.symbol,
          reason:
            o.excluded && o.excluded.length > 0
              ? o.excluded.map((e) => `${e.reason} (${e.count})`).join("; ")
              : "No structure cleared the stated constraints",
        }));
      const completedCount = outcomes.filter(
        (o) => o.status === "completed" && o.abstained !== true
      ).length;
      const status: DiscoveryRunStatus =
        failures.length === outcomes.length
          ? "failed"
          : completedCount === outcomes.length
            ? "completed"
            : completedCount === 0 && failures.length === 0
              ? "completed"
              : "partial";

      // The run is persisted BEFORE the status is judged — an
      // all-failed fire's record is exactly what makes the failure
      // diagnosable (and the run id joins the failure data).
      const run = await this.discoveryRunStore.save({
        createdAt: timestamp,
        trigger: options.trigger === "manual" ? "manual-trigger" : "scheduled",
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
        userLogin,
        inputModel: "no-view",
        requests: [],
        constraintSets: outcomes.flatMap((o) => (o.constraintSet ? [o.constraintSet] : [])),
        outcomes,
        status,
      });

      await this.persistDiscoveryCanonicalAndBridge({
        run,
        summary: `Strategy discovery (no-view) ${status}: ${completedCount} of ${constraintSets.length} constraint sets produced ranked structures.`,
        symbols,
        options,
        timestamp,
        outcomes,
        matchedCount: completedCount,
        totalScanned: constraintSets.length,
      });

      if (status === "failed") {
        const parts = [
          ...failures.map((f) => `${f.symbol}: ${f.error}`),
          ...abstentions.map((a) => `${a.symbol}: abstained (${a.reason})`),
        ];
        return await fail(
          `No no-view discovery symbol produced a result (${parts.join("; ")})`,
          run.id,
          status,
          failures,
          abstentions
        );
      }

      this.audit("options.strategy_discovery_completed", {
        runId: run.id,
        status,
        symbols,
        inputModel: "no-view",
        requestCount: constraintSets.length,
        completedCount,
        failedCount: failures.length,
        abstained: abstentions,
        trigger: options.trigger || "scheduled",
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
      });
      // Issue #1333: no-view discovery outcomes into the sink.
      this.recordDiscoveryOutcome({
        id: run.id,
        trigger: options.trigger || "scheduled",
        status,
        scanned: constraintSets.length,
        matched: completedCount,
        codedError: failures.length > 0 ? failures.map((f) => `${f.symbol}: ${f.error}`).join("; ") : undefined,
        createdAt: timestamp,
      });

      if (this.orm?.messages) {
        try {
          const failureNote = failures.length > 0
            ? `; failed: ${failures.map((f) => `${f.symbol} (${f.error})`).join("; ")}`
            : "";
          const abstainNote = abstentions.length > 0
            ? `; abstained: ${abstentions.map((a) => `${a.symbol} (${a.reason})`).join("; ")}`
            : "";
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content:
              status === "completed" && abstentions.length === 0
                ? `🔭 Scheduled Strategy Discovery (no-view) completed for ${symbols.join(", ")}: all ${constraintSets.length} constraint sets produced ranked structures under their constraints. No view was supplied, derived, or assumed.`
                : status === "completed"
                  ? `🔭 Scheduled Strategy Discovery (no-view) completed for ${symbols.join(", ")}: no structure qualified under the stated constraints — every symbol abstained${abstainNote}. No pick was manufactured.`
                  : `🔭 Scheduled Strategy Discovery (no-view) partially completed for ${symbols.join(", ")}: ${completedCount} of ${constraintSets.length} constraint sets produced ranked structures${failureNote}${abstainNote}.`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }
      return {
        success: true,
        taskType: "strategy_discovery" as any,
        data: {
          runId: run.id,
          status,
          requestCount: constraintSets.length,
          completedCount,
          failedCount: failures.length,
          symbols,
          failures,
          abstained: abstentions,
        },
        timestamp,
      };
    } catch (err: any) {
      return await fail(err?.message || "Scheduled strategy discovery failed");
    }
  }

  /**
   * Runs ONE no-view constraint set (issue #534) and shapes its
   * outcome: the symbol's snapshot loads through the same data agent
   * the sibling models use, chain failure is judged exactly as in
   * runDiscoveryRequest, and qualifying structures are ranked by the
   * target-free model. A loaded chain with zero qualifying
   * structures is a completed ABSTENTION — flagged, gate reasons in
   * `excluded`, empty ranked set, no_trade pick — never a failure
   * and never a manufactured pick.
   */
  private async runNoViewDiscoveryRequest(
    agents: PanelAgents,
    etrade: ETradeService,
    constraintSet: NoViewStrategyRequest
  ): Promise<DiscoverySymbolOutcome> {
    const symbol = constraintSet.symbol.toUpperCase().trim();
    const record: DiscoveryConstraintSet = {
      source: "no-view",
      request: constraintSet,
      expectedIvDirection: NO_VIEW_EXPECTED_IV_DIRECTION,
    };
    try {
      const snapshot = await agents.data.loadSnapshot(constraintSet);
      // A snapshot that never loaded its chain is a failure, not an
      // abstention: the screen records why (validation error,
      // per-symbol fetch errors, or the client's recorded upstream
      // cause). Zero contracts with NO failure signal means the
      // chain loaded empty — the gates then abstain honestly below.
      const fetchReasons = (snapshot.screen.fetchErrors ?? [])
        .filter((e) => e.symbol === symbol)
        .map((e) => e.reason);
      let failure: string | undefined;
      if (snapshot.validationError) {
        failure = snapshot.validationError;
      } else if (snapshot.contracts.length === 0 && fetchReasons.length > 0) {
        failure = fetchReasons.join("; ");
      } else if (snapshot.contracts.length === 0) {
        failure = etrade.getLastError() || undefined;
      }
      if (failure) {
        return { symbol, status: "failed", constraintSet: record, error: failure };
      }
      const strategies = agents.risk.buildNoViewStrategies(snapshot.contracts, constraintSet);
      const ranked = agents.recommender.rankNoView(
        strategies.candidates,
        constraintSet,
        constraintSet.riskProfile ?? "balanced"
      );
      const limit = constraintSet.candidateLimit ?? ranked.length;
      const bestTrade = agents.recommender.pickBestNoViewTrade(strategies.candidates, constraintSet);
      const snapshotBlock = {
        dataSource: snapshot.dataSource,
        screen: snapshot.screen,
        ...(snapshot.validationError ? { validationError: snapshot.validationError } : {}),
      };
      if (strategies.candidates.length === 0) {
        return {
          symbol,
          status: "completed",
          abstained: true,
          constraintSet: record,
          rankedNoView: [],
          excluded: strategies.excluded,
          bestNoViewTrade: bestTrade,
          snapshot: snapshotBlock,
        };
      }
      return {
        symbol,
        status: "completed",
        constraintSet: record,
        rankedNoView: ranked.slice(0, limit),
        excluded: strategies.excluded,
        bestNoViewTrade: bestTrade,
        snapshot: snapshotBlock,
      };
    } catch (err: any) {
      return {
        symbol,
        status: "failed",
        constraintSet: record,
        error: err?.message || "Strategy discovery pipeline failed",
      };
    }
  }

  /**
   * Issue #1999 (D2): persist one IV-collection run's report row.
   * Returns false (and audits) when the store throws — the caller
   * reports failure instead of success. Returns true when the row
   * is stored, or when no store is configured (nothing to fail).
   */
  private persistIvCollectionReport(report: IvCollectionReport, timestamp: string): boolean {
    if (!this.orm?.storeCanonicalReport) return true;
    try {
      this.orm.storeCanonicalReport({
        runId: `iv_collection:${report.date}`,
        generationId: `iv_collection:${report.date}`,
        title: `Daily IV collection — ${report.date}`,
        source: "iv_collection",
        summary: `📈 Daily IV collection [${report.date}]: ${report.recorded} recorded, ${report.alreadyRecorded} already recorded, ${report.failed} failed across ${report.outcomes.length} tracked names.`,
        body: { ...report, trackedCount: report.outcomes.length },
        createdAt: timestamp,
        userLogin: this.userLogin,
      },
      // Issue #1169 S4-1 (preserved through the #1999 splice): thread
      // this.env so the seam indexes this iv_collection row at write time.
      this.env);
      return true;
    } catch (storeErr) {
      this.audit("options.iv_collection_persist_failed", {
        date: report.date,
        error: storeErr instanceof Error ? storeErr.message : String(storeErr),
      });
      return false;
    }
  }

  /**
   * Daily ATM IV collection (issue #15): one IV-history record per
   * tracked name (curated universe ∪ all watchlist symbols), derived
   * from the live chain through the scanner's own data path
   * (OptionsDataAgent over the DynamicOptionsScreener — broker chains
   * only). Idempotent per (symbol, day): rerunning the task the same
   * day records nothing twice. A name whose chain fails gets NO
   * record and is named in the report's failed outcomes — history is
   * never fabricated to fill a gap. Runs under this service's
   * userLogin identity, like its sibling tasks.
   *
   * `options.symbols`, when given, replaces the tracked set (on-demand
   * / diagnostic runs); the daily schedule passes nothing.
   */
  async collectDailyIvHistory(
    options: { symbols?: string[]; environment?: string } = {}
  ): Promise<ScheduledTaskResult<IvCollectionReport & { trackedCount: number }>> {
    const timestamp = new Date().toISOString();

    if (!this.ivHistoryStore) {
      return {
        success: false,
        taskType: "options.iv_collection",
        error: "IV history store not configured for this service instance",
        timestamp,
      };
    }

    try {
      // The same E*TRADE client construction the unified options
      // service uses, so collection reads chains under the same
      // identity/environment as every other options path.
      const etrade = this.createETradeService(this.userLogin, options.environment);
      const dataAgent = new OptionsDataAgent(new DynamicOptionsScreener(etrade.client, undefined, await this.scheduledUniverseDeps(this.userLogin)));

      const fetchChain = async (symbol: string) => {
        const snapshot = await dataAgent.loadSnapshot({ symbol });
        const fetchReasons = (snapshot.screen.fetchErrors ?? [])
          .filter((e) => e.symbol === symbol)
          .map((e) => e.reason);
        const error =
          snapshot.validationError ??
          (fetchReasons.length ? fetchReasons.join("; ") : undefined);
        return { contracts: snapshot.contracts, ...(error ? { error } : {}) };
      };

      const curatedSymbols = options.symbols ?? getCuratedStockUniverse().map((s) => s.symbol);
      const watchlistSymbols = options.symbols ? [] : this.flattenWatchlistSymbols();

      const report = await collectIvHistory({
        store: this.ivHistoryStore,
        fetchChain,
        curatedSymbols,
        watchlistSymbols,
      });

      this.audit("options.iv_collection_completed", {
        date: report.date,
        tracked: report.outcomes.length,
        recorded: report.recorded,
        alreadyRecorded: report.alreadyRecorded,
        failed: report.failed,
        failedSymbols: report.outcomes.filter((o) => o.status === "failed").map((o) => o.symbol),
      });

      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content:
              `📈 Daily IV collection [${report.date}]: ${report.recorded} recorded, ` +
              `${report.alreadyRecorded} already recorded, ${report.failed} failed ` +
              `across ${report.outcomes.length} tracked names.`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }

      // Issue #278: persist the scheduled run's report durably
      // (mas_reports) so the AI Search agent can surface it later.
      // Issue #308: through the single generate→store seam — one
      // canonical row per generation (generationId = run id).
      // Issue #1999 (D2): the persisted row IS this run's record
      // (#278: persist so the agent can surface it later). A lost
      // store must not report success — the run failed its point.
      const stored = this.persistIvCollectionReport(report, timestamp);

      return {
        success: stored,
        taskType: "options.iv_collection",
        data: { ...report, trackedCount: report.outcomes.length },
        timestamp,
      };
    } catch (err: any) {
      this.audit("options.iv_collection_failed", {
        error: err.message,
      });

      return {
        success: false,
        taskType: "options.iv_collection",
        error: err.message || "Daily IV collection failed",
        timestamp,
      };
    }
  }

  /** All symbols across all stored watchlists (symbolsJson arrays);
   *  a watchlist read failure degrades to the curated universe only. */
  private flattenWatchlistSymbols(): string[] {
    if (!this.orm?.watchlists) return [];
    try {
      return flattenWatchlistSymbols(this.orm.watchlists.findMany({}));
    } catch {
      return [];
    }
  }
}
