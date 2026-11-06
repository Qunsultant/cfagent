import type { Env, SessionData, TransactionSnapData } from "./types";
import {
  clearSessionCookie,
  getSessionIdCandidates,
  renewSession,
  setSessionCookie,
} from "./session";
import { getServiceUserLogin, isLoginShaped, isSharedOrchestratorAddress, SHARED_ORCHESTRATOR_INSTANCE } from "./security/serviceIdentity";
import { backgroundDispatchHeaders, backgroundDispatchHeadersWithTrace } from "./security/backgroundAttribution";
import {
  createDeadLetterRecord,
  logDeadLetter,
  type DeadLetterRecord,
} from "./messaging/deadLetter";
import { getSessionCached, getSessionCachedFetchedAt, invalidateSessionCache } from "./security/sessionCache";
import { resolveIdleTimeoutMs } from "./security/sessionPolicy";
import { csrfGateResult, ensureCsrfCookie } from "./security/csrf";
import { rotateUserSessionsForEnv, sessionRotationCookie } from "./security/sessionRotation";
import { resolveScreenerAgentName } from "./agents/screenerAgentName";
import { isAnalysisDoneStageMessage, isStageBoundaryMessage } from "./workflows/stageQueueTransport";
import {
  quotaWindowKey,
  type QuotaUsageView,
} from "./security/userRequestQuota";
import type { UserRequestQuotaOverride } from "./data/userRequestQuotaPorts";
import {
  buildLoggedInUserRows,
  parseLoggedInSessionEntry,
} from "./security/iaaaLoggedInUsers";
import { SESSION_REVOCATION_CROSS_ISOLATE_BOUND_MS } from "./security/revocationTargets";
import { deleteSession, getSession, listSessionFamilyEntries, sessionStore, updateSession, wiredAccessRequestStore, wiredMembershipStore } from "./security/session";
import {
  isAdminRoleGrant,
  listGrantsForReview,
  resolveGrantDefaultExpiryDays,
  runGranterRevocationPass,
  type GranterRevocationPassResult,
} from "./security/grantRules";
import { createGrantProposalStore, resolveAdminGrantProposal } from "./security/grantProposals";
import { type DoNamespaceLike, type DoStubLike } from "./data/durableKv";
import type { ActorNamespaceLike } from "./services/actorGatewayPorts";
import { zonedDateParts } from "./schedule";
import { OPERATION_CATALOG } from "./orchestrate";
import { SCHEDULE_SYSTEMS, WORKER_CRON_TRIGGERS_INVENTORY } from "./services/scheduleSystems";
import {
  SOCIAL_BRIEF_MAX_CHARS,
  createSocialBriefStoreFromNamespace,
  isBriefDate,
} from "./agents/social/briefStore";
import { createSocialStoresFromNamespace } from "./agents/social/durableStores";
import {
  KNOWN_SOCIAL_CHANNELS,
  parseSocialConfig,
} from "./agents/social/config";
import {
  createMemoryDryRunSink,
  resolvePostUrl,
  resolveSubmissionEndpoint,
} from "./agents/social/publisher";
import { createFetchSocialTransport } from "./agents/social/liveTransport";
import { approveAndPublish, rejectSocialDraft } from "./agents/social/approvalActions";
import {
  handleSocialSlackInteraction,
  parseSocialAction,
} from "./agents/social/interactions";
import { checkAllTokenHealth } from "./agents/social/tokenHealth";
import {
  resolveWiredFreshnessMs,
  validateAndTouchWiredSession,
} from "./security/iaaaEnforcement";
import { isPlatformServiceProvisioned } from "./security/serviceDispatch";
import { requiresStepUpForAction, requiresStepUpForMint } from "./security/iaaaGates";
import { createWiredAuditStore } from "./security/iaaaAuditStore";
import {
  createKvMembershipStore,
  grantMembership,
  listMembershipsFromEntries,
  readMembershipById,
} from "./security/iaaaMembershipStore";
import { createKvPermissionDenialStore } from "./security/iaaaPermissionDenialStore";
import {
  MANAGEABLE_DENIED_PERMISSIONS,
  canManagePermissionDenial,
} from "./security/permissionDenials";
import {
  ALL_ROLES,
  canGrantRole,
  PERMISSIONS,
  type AuthorizationScope,
  type Role,
} from "./security/authorization";
import {
  approveBootstrapProposal,
  bootstrapProposalAuditInput,
  confirmBootstrapApplied,
  createBootstrapProposal,
  createKvBootstrapProposalStore,
  currentBootstrapEntries,
  findBootstrapDivergence,
  parseStoredBootstrapProposal,
  rejectBootstrapProposal,
  BOOTSTRAP_PROPOSAL_KEY_PREFIX,
  type BootstrapProposal,
  type BootstrapProposalAuditAction,
} from "./security/bootstrapProposals";
import {
  parseBootstrapAdmins,
  resolveBootstrapEntries,
} from "./security/iaaaBootstrap";
import { createWiredBindingStore } from "./security/iaaaLogin";
import {
  approveProposal,
  createKvPolicyProposalStore,
  createProposal,
  diffPolicySnapshots,
  parseStoredProposal,
  policyProposalAuditInput,
  previewDecisions,
  promoteProposal,
  rejectProposal,
  POLICY_PROPOSAL_ACTIVE_KEY,
  POLICY_PROPOSAL_KEY_PREFIX,
  type PolicyProposal,
  type PolicyProposalAuditAction,
} from "./security/policyProposals";
import {
  canRevokeRoleGrant,
  flattenRoleGrants,
  removeRoleBinding,
  toRoleGrantView,
  validateRoleGrantRequest,
} from "./security/roleGrants";
import { buildAdminOverview, computeAdminCounts, isPlatformAdmin } from "./security/iaaaAdminOverview";
import {
  evaluateWithObligations,
  type ObligationAuditWriter,
} from "./security/obligations";
import {
  IAAA_AUDIT_POLICY_VERSION,
  recordAuditEvent,
} from "./security/iaaaAudit";
import { parseSessionRegistryEntries } from "./security/iaaaSessionRegistry";
import {
  isMailSuppressed,
  resolveOffboardSessions,
  runOffboard,
  setMailSuppression,
} from "./security/iaaaLifecycleWiring";
import { createSubscriptionAdapter } from "./data/createSubscriptionPorts";
import { hasUnexpiredSubscription } from "./data/subscriptionPorts";
import { createLifecycleAdapter } from "./data/createLifecyclePorts";
import { handleSeedGovernanceRoute } from "./data/seedGovernanceRoute";
import {
  handleChainStatusRoute,
  handleReconcileChainsRoute,
} from "./data/chainStatusRoute";
import { readChainStatus } from "./data/createChainSchedulePorts";
import type { ReconcileReport } from "./data/chainScheduleProjection";
import {
  handleJobHistoryRoute,
  handleReconcileJobsRoute,
} from "./data/shardJobRoute";
import {
  createTraceReader,
  handleMeshTraceRoute,
} from "./data/meshTraceRoute";
import {
  createShardJobAdapter,
  readJobHistory,
} from "./data/createShardJobPorts";
import { handleMeshRegistryRoute } from "./agents/meshRegistryRoute";
import { handleProductCatalogRoute } from "./agents/productCatalogRoute";
import { createPriceCatalogueAdapter } from "./data/createPriceCataloguePorts";
import { handleRetentionPurgeRoute } from "./data/retentionRoute";
import { buildPurgeAuditEventInput } from "./data/retention1766";
import {
  handlePrivacyErasureRoute,
  handlePrivacyExportRoute,
  handlePrivacyPreferencesRoute,
  handlePrivacyStatusRoute,
} from "./privacy/privacyRoutes";
import {
  buildExportPayload,
  type ErasureLeg,
  type PrivacyPreferences,
} from "./privacy/privacyDsar";
import {
  consumeCfBatch,
  dispatchSubscriberBatch,
} from "./messaging/cfQueueMessagingAdapter";
import { createMessagingPorts } from "./messaging/createMessagingPorts";
import { createScreenerEventsWorkHandler } from "./messaging/screenerEventsConsumer";
import { createDeadLetterStoreAdapter, ensureDeadLetterStoreSchema } from "./data/createDeadLetterStorePorts";
import { createBreakerStateStoreAdapter, ensureBreakerStateSchema } from "./data/createBreakerStateStorePorts";
import { configureDefaultBreakerDurability } from "./breakers/createBreakerPorts";
import { createBreakerTripSubscriber } from "./breakers/breakerTripAlert";
import { resolveDlqDepthAlertThreshold } from "./config/dlqDepthAlert";
import { persistDeadLetterLanding } from "./messaging/deadLetterPersist";
import { postSlackText, resourceSlackPost } from "./agents/resourceGoals";
import type { SlackDeliveryEnv } from "./agents/social/delivery";
import {
  isMessageEnvelope,
  type MessageEnvelope,
  type SubscriberHandlers,
} from "./messaging/messagingPorts";
import { actorGateway } from "./services/cloudflareActorGateway";
import { withRequestObservability } from "./observability/aspects";
import { createObservabilitySink } from "./observability/createObservabilityPorts";
import { writeEnvelopeToSink, childSpan, formatTraceparent, newTraceContext } from "./observability/observabilityPorts";
import { observeInternalDispatch } from "./observability/scheduledJobOutcomes";
import { createScreenerQueueHandler } from "./messaging/screenerQueueConsumer";
import {
  createRetentionPurgeStore,
  runRetentionPurgeForTenant,
} from "./data/createRetentionPorts";
import type { ReconcileShardJobsReport } from "./data/shardJobProjection";
import {
  handleAuditHistoryRoute,
  handleReportsRoute,
  handleSeedReportsRoute,
} from "./data/auditReportRoute";
import {
  handleTelemetryDecisionActionRoute,
  handleTelemetryDecisionsRoute,
  handleTelemetryReconcileRoute,
  handleTelemetrySummaryRoute,
} from "./telemetry/telemetryRoute";
import type { TrackRecordIdeaInput } from "./telemetry/telemetryProjection";
import {
  createTelemetryAdapter,
  ensureTelemetryTables,
} from "./telemetry/createTelemetryPorts";
import { createResourceUsagePort } from "./telemetry/createResourceUsagePorts";
import type { ResourceAttribution } from "./telemetry/resourceUsagePorts";
import { defaultBreakerRegistry } from "./breakers/createBreakerPorts";
import { gatewayStatsSnapshot } from "./gateway/createGatewayPorts";
import { retrievalStatsSnapshot } from "./telemetry/retrievalStats";
import {
  createAuditReportAdapter,
  readAuditHistory,
  readReports,
} from "./data/createAuditReportPorts";
import type { SeedCanonicalReportsResult } from "./data/auditReportProjection";
import type { GovernedHaltState } from "./data/governedHalt";
import { buildOpenApiSpec, SWAGGER_UI_HTML } from "./security/openapiSpec";
import { resolveIaaaTenant } from "./security/iaaaGithubEndToEnd";
import { resolveDoNameForUser } from "./security/iaaaMigration";
import { evaluateRoutePep } from "./security/pepGateway";
import {
  bearerKeyFromRequest,
  listApiKeys,
  mintApiKey,
  revokeApiKey,
  verifyApiKey,
} from "./security/apiKeys";
import {
  bearerTokenFromRequest,
  serviceTokenStore,
  verifyServiceToken,
} from "./security/serviceTokens";
import { serveStaticAsset, fetchStaticAsset } from "./security/staticAssets";
import { withErrorBoundary } from "./security/workerErrorBoundary";
import { handleLogout, renderLoginPage } from "./oauth";
import {
  AUTH_OUTCOME_PARAM,
  authOutcomeLoginUrl,
  parseAuthOutcome,
} from "./security/authOutcome";
import { validateReturnTarget } from "./security/returnTarget";
import {
  disabledLoginResponse,
  enabledProviders,
  getProvider,
  getProviderByIssuer,
  isWiringEnabled,
  resolveLoginProvider,
} from "./security/providers";
import { renderLandingPage } from "./landing";
import { resolvePollingConfigFromEnv } from "./pollingConfig";
import { TICKER_INSTANCE_NAME } from "./agents/ticker-agent";
import { SERVER_PALETTE } from "./theme/serverPalette";
import { routeAgentRequest } from "agents";
import {
  getETradeRequestToken,
  exchangeETradeVerifier,
  renewETradeAccessToken,
  revokeStoredTokens,
  revokeRemoteAccessToken,
  getETradeAuthStatus,
  getStoredTokens,
  getValidTokens,
  renewAllStoredETradeTokens,
  renewFailureDetail,
  etradeIdentityFromSession,
  isTokenExpiredEt,
  listTokenFamilyEntries,
} from "./services/etradeOAuth";
import {
  PublicClientRejectedError,
  completePublicOAuth,
  connectPublicPersonalToken,
  disconnectPublic,
  getPublicConnectionStatus,
  publicClientMetadataDocument,
  startPublicOAuth,
} from "./security/publicOAuth";
import { ETradeRestClient } from "./trading";
import { resolveEnvironmentConfig } from "./config/environment";
import {
  isFeatureEnabled,
  getAllFeatureFlags,
  createFeatureDisabledResponse,
  matchFeatureForRoute,
} from "./config/featureFlags";
import { handleCloudflareEmailMessage, ETradeEmailTradingService } from "./trading";
import { ETradeSlackTradingService, confirmSlackLink } from "./trading";
import {
  INBOUND_EMAIL_ORCHESTRATOR_INSTANCE,
  resolvePrincipal,
  slackPrincipalLinkStoreFromEnv,
  verifyApprovalLinkForPrincipal,
} from "./trading";
import { gateSlackRequest, timingSafeEqual } from "./security/webhookSecurity";
import { sanitizeInboundText } from "./security/promptInjectionSanitize";
import {
  checkPublicRestThrottle,
  createIngressThrottle,
  pickWebhookSignature,
} from "./api/ingress";
import { nlqWebhookBodySchema } from "./api/ingressSchemas";
import { dispatchWsUpgrade } from "./api/wsRoutes";
import {
  levelsForApiIngressMode,
  resolveApiIngressMode,
} from "./config/apiIngressModes";
import {
  deriveNlqNonce,
  sharedMemoryReplayStore,
  validateEmailRecipient,
} from "./security/webhookReplay";
import { handleVoiceWebSocketConnection, ETradeVoiceTradingService, createOrchestratorVoiceTurnForwarder } from "./trading";
import { ETradeWebhookService } from "./services/tradingWebhooks";
import { ETradeBrowserService } from "./services/browserAgent";
import { handleMarketQuotesHttp } from "./services/marketStream";
import { sendProvisioningWelcome } from "./services/provisioningWelcome";
import {
  createUserEmailDestinationStore,
  normalizeEmailDestination,
} from "./services/userEmailDestination";
import {
  getQuoteSource,
  setQuoteSource,
  normalizeQuoteSource,
  type QuoteSourceStore,
} from "./services/quoteSourceSetting";
import {
  levelsForQuoteSwitch,
  resolveQuoteExpiryMode,
  resolveQuoteHttpProviderMode,
  resolveQuoteStreamProvenance,
} from "./config/quoteModes";
import { resolveSnapIdentity } from "./config/restTwinsModes";
import { buildDataProviderPorts } from "./data/buildDataProviderPorts";
import { registerDataProviderPortsBuilder } from "./data/dataProviderPortsProvider";
import { aspectTransactionRunner } from "./data/transactionRunner";
import { registerTransactionRunner } from "./data/transactionRunnerProvider";

// #2303 (#1976 step 1): register the data-provider ports
// builder for the client-bundle-reachable consumers
// (ETradeService, ETradeTradingPlatform) that cannot import
// the builder themselves — see dataProviderPortsProvider.ts.
registerDataProviderPortsBuilder(buildDataProviderPorts);

// #2337 (#1976 step 2): register the transaction runner for
// the options/discovery adapters' withTransaction wraps — the
// adapters resolve it through transactionRunnerProvider.ts
// because their module graph is client-bundle-reachable and
// the aspect (node:async_hooks) is server-only.
registerTransactionRunner(aspectTransactionRunner);
import {
  filterLiveFlowItems,
  filterNewsFlowItems,
  filterInsiderFlowItems,
  filterCongressFlowItems,
  calculateFlowSummary,
  DEFAULT_SAVED_PRESETS,
  getDynamicLiveFlowItems,
  getDynamicFlowSummary,
  summarizeFlowProvenance,
  fetchRealMarketNews,
  fetchRealSecInsiderFilings,
  fetchRealCongressDisclosures,
  MarketCapCategory,
  AssetClassCategory,
} from "./trading";
import { isAllowedOrigin, requireAuth, authenticateRequest } from "./server/auth";
import { handleCoreEarlyRoutes, handleCoreHealthRoutes, handleCoreLateRoutes } from "./server/routes/core";
import { handleAuthLoginRoutes, handleAuthMeRoutes, handleAuthIaaaRoutes } from "./server/routes/auth";
import { handlePrivacyRoutes, handlePrivacyChainsRoutes, handlePrivacyReportsRoutes } from "./server/routes/privacy";
import { handleTradingScheduleRoutes, handleTradingOmniRoutes, handleTradingQuotesRoutes, handleTradingApproveRoutes } from "./server/routes/trading";
import { handleMessagingSagaRoutes, handleMessagingSocialRoutes, handleMessagingSlackRoutes } from "./server/routes/messaging";
import { handlePlatformTelemetryRoutes, handlePlatformRetrievalRoutes, handlePlatformMcpRoutes, handlePlatformPaymentsRoutes, handlePlatformBrowserRoutes } from "./server/routes/platform";
export { OrchestratorAgent } from "./agents/orchestrator";
// Issue #1387 — the agents SDK resolves sub-agent roots through
// ctx.exports by constructor.name, so OrchestratorAgent is exported
// under its own name: the root-namespace lookup requires
// ctx.exports["OrchestratorAgent"] to expose idFromName.
// Issue #2523 (Agent Mesh S2-B, gate record #2326) — the two-deploy
// G0 rename is complete. Migration v14 (#2330, Deploy A) tombstoned
// the colliding v9 OrchestratorAgent namespace (and, per the legacy
// Delete-migration procedure, temporarily removed this own-name
// export); migration v15 now renames the SEARCH_AGENT namespace
// onto OrchestratorAgent (renamed_classes), so the SearchAgent
// export alias is retired and this own-name export is restored. The
// SEARCH_AGENT binding name is unchanged — only its class_name is
// now OrchestratorAgent — so instance names (logins) and their
// stored state carry over, the class's own-name namespace is the
// renamed namespace, and sub-agent root resolution through
// ctx.exports works again.
// Issue #2230 — wrangler requires every bound DO class to be exported from
// the entrypoint, otherwise `wrangler deploy` fails.
export { TickerAgent, TICKER_INSTANCE_NAME } from "./agents/ticker-agent";
export { OptionsScannerMCP } from "./mcps/scanner/cloudflareWalletsScanner";
export { BrowserAgent } from "./agents/browserAgent";
export { SlackAgent } from "./agents/slackAgent";
export { AiSearchAgent } from "./agents/aiSearchAgent";
// Issue #2253 — SandboxAgent DO: wrangler binds SANDBOX_AGENT to this
// class, so it must be exported from the entrypoint (same rule as the
// #2230 note above).
export { SandboxAgent } from "./agents/sandbox-agent";
// Issue #197: wrangler.jsonc binds PAYMENTS_AGENT/SCHEDULED_AGENT as Durable
// Objects — wrangler requires every bound DO class to be exported from the
// entrypoint, otherwise `wrangler deploy` fails.
export { PaymentsAgent } from "./agents/payments-agent";
export { ScheduledAgent } from "./agents/scheduled-agent";
export { ScreenerAgent } from "./agents/screener-agent";
// Issue #319 — wrangler requires every bound DO class to be exported from
// the entrypoint, otherwise `wrangler deploy` fails.
export { ResearchAgent } from "./agents/research-agent";
export { TradingAgent } from "./agents/trading-agent";
export { TradingTradeWorkflow } from "./agents/trading-trade-workflow";
export { ScreenerScreenWorkflow } from "./workflows/screenerWorkflow";
export { PaymentWorkflow } from "./workflows/paymentWorkflow";
export { CrossDomainSagaWorkflow } from "./workflows/sagaWorkflow";
export { ReportAssetAgent } from "./agents/report-asset-agent";
export { SessionStore } from "./security/sessionStore";



/**
 * Phase 5 Slice 2 (issue #2000) — one-time per-isolate breaker
 * durability configuration. Idempotent: the first call wins;
 * later calls are no-ops (bindings do not change within an
 * isolate's lifetime, so a null store at first call stays
 * null). The schema ensure runs fire-and-forget once: a load
 * that races it degrades to in-memory (logged) and the next
 * load succeeds — the durable adapter never fails a provider
 * call over store state. Called at the top of fetch, scheduled,
 * and queue entry points, before any breaker use.
 */
let breakerDurabilityConfigured = false;
function ensureBreakerDurability(env: Env): void {
  if (breakerDurabilityConfigured) return;
  breakerDurabilityConfigured = true;
  const adapter = createBreakerStateStoreAdapter(env);
  if (!adapter) return;
  const subscriber = createBreakerTripSubscriber({
    postText: (text) =>
      postSlackText({ post: resourceSlackPost, env: env as unknown as SlackDeliveryEnv, text }),
    claimTripAlert: (transitionId, atMs, token) => adapter.claimTripAlert(transitionId, atMs, token),
  });
  configureDefaultBreakerDurability({
    store: adapter,
    tripAlert: (envelope) => {
      void subscriber.handleEnvelope(envelope);
    },
  });
  void ensureBreakerStateSchema(adapter.db).catch((err: unknown) => {
    console.warn(
      `[breaker] schema ensure failed, loads degrade to in-memory until it succeeds: ${err instanceof Error ? err.message : String(err)}`
    );
  });
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
    // Phase 5 Slice 2 (#2000) — durable breaker production path.
    // Configures the shared registry's store + trip subscriber once
    // per isolate, before any breaker use in this request (the
    // registry is created lazily on first use; configuration must
    // precede it, which entry-point ordering guarantees). Unbound
    // AGENT_DB leaves the in-memory registry in place — exactly
    // today's behavior, no lockout.
    ensureBreakerDurability(env);
    const url = new URL(request.url);
    const path = url.pathname;

    // Issue #329: static assets never need a session, but `run_worker_first`
    // routes them through this handler anyway — so serve them from the ASSETS
    // binding before `requireAuth` can spend a session-store read on them.
    const staticAsset = await serveStaticAsset(request, path, env);
    if (staticAsset) return staticAsset;

    // Issue #3113 (#945 Q5): CSRF gate for cookie-authenticated
    // mutations. Runs before routing so a rejected request changes
    // no state; safe methods, requests without a session cookie,
    // and exempt paths (login/callback, HMAC webhooks,
    // token-authenticated /mcp and /a2a, Slack events) pass.
    const csrf = csrfGateResult(request);
    if (!csrf.pass) {
      return Response.json({ error: csrf.error, code: csrf.code }, { status: 403 });
    }

    // Issue #241: abuse throttling on expensive ingress routes.
    // `null` = allowed, otherwise a 429 Response to return immediately.
    // #1768: uniform throttle from src/api/ingress.ts — the bucket key
    // is the connecting IP, never the caller-supplied x-user-login
    // (which let any unauthenticated caller mint a fresh bucket per
    // fake login and evade the throttle). Session-gated call sites
    // pass the server-verified login separately (memory_search below).
    const throttle = createIngressThrottle(request);
    // #1768: WS burst-cap mode, admin/platform-controlled via env
    // only — never from request input (see apiIngressModes.ts guard).
    const apiIngressMode = resolveApiIngressMode(
      levelsForApiIngressMode(undefined, undefined, undefined, env.API_INGRESS_MODE),
    ).mode;
    // #1774 (parent #1717, F-55): public-REST burst cap — unified
    // mode only, per-IP, /api/* paths only (see src/api/ingress.ts).
    // Legacy mode keeps the current uncapped behavior; production
    // activation is an owner action (API_INGRESS_MODE env value).
    if (path.startsWith("/api/")) {
      const restLimited = checkPublicRestThrottle(request, { mode: apiIngressMode });
      if (restLimited) return restLimited;
    }
    // Slice 2 (#2902): Core early branches moved to src/server/routes/core.ts
    // (/.well-known metadata, /a2a/*, /api/features).
    const coreEarlyResponse = await handleCoreEarlyRoutes(request, env, url, path);
    if (coreEarlyResponse) return coreEarlyResponse;
    // Slice 4 (#2902): privacy family moved to src/server/routes/privacy.ts —
    // /api/privacy/status, /api/privacy/preferences, /api/privacy/export, /api/privacy/erasure.
    const privacyResponse = await handlePrivacyRoutes(request, env, url, path);
    if (privacyResponse) return privacyResponse;
    // Slice 6 (#2902): saga/NLQ/QA/memory moved to src/server/routes/messaging.ts —
    // /api/saga/*, /nlq/webhook + /api/trading/nlq/webhook + /api/nlq/webhook,
    // /api/qa/investigate, /api/memory/search.
    const messagingSagaResponse = await handleMessagingSagaRoutes(request, env, url, path, throttle);
    if (messagingSagaResponse) return messagingSagaResponse;
    // Slice 5 (#2902): /api/schedule/* moved to src/server/routes/trading.ts —
    // goals, operations, ticks, runs, systems.
    const tradingScheduleResponse = await handleTradingScheduleRoutes(request, env, url, path);
    if (tradingScheduleResponse) return tradingScheduleResponse;
    // Slice 6 (#2902): social family moved to src/server/routes/messaging.ts —
    // /api/social/brief, /api/social/approval, /api/social/approvals,
    // /api/social/posts, /api/social/token-health.
    const messagingSocialResponse = await handleMessagingSocialRoutes(request, env, url, path);
    if (messagingSocialResponse) return messagingSocialResponse;
    // Slice 3 (#2902): /api/me, /api/user/email-destination,
    // /api/iaaa/overview, /api/governance/seed-halt moved to src/server/routes/auth.ts.
    const authMeResponse = await handleAuthMeRoutes(request, env, url, path);
    if (authMeResponse) return authMeResponse;
    // Slice 4 (#2902): chains/jobs/traces/registry/catalog/reconcile/retention
    // moved to src/server/routes/privacy.ts — /api/chains/*, /api/jobs/*,
    // /api/traces, /api/agents/registry, /api/products/catalog, /api/retention/purge.
    const privacyChainsResponse = await handlePrivacyChainsRoutes(request, env, url, path);
    if (privacyChainsResponse) return privacyChainsResponse;
    // Slice 7 (#2902): telemetry & calibration moved to src/server/routes/platform.ts —
    // /api/telemetry/summary, /api/telemetry/decisions, /api/telemetry/reconcile,
    // /api/telemetry/decisions/:id/(decide|apply|supersede|expire).
    const platformTelemetryResponse = await handlePlatformTelemetryRoutes(request, env, url, path);
    if (platformTelemetryResponse) return platformTelemetryResponse;
    // Slice 4 (#2902): audit/reports moved to src/server/routes/privacy.ts —
    // /api/audit/history, /api/reports/list, /api/reports/seed-canonical.
    const privacyReportsResponse = await handlePrivacyReportsRoutes(request, env, url, path);
    if (privacyReportsResponse) return privacyReportsResponse;
    // Slice 7 (#2902): market-graph population moved to src/server/routes/platform.ts —
    // POST /api/retrieval/populate-market-graph.
    const platformRetrievalResponse = await handlePlatformRetrievalRoutes(request, env, url, path);
    if (platformRetrievalResponse) return platformRetrievalResponse;
    // Slice 3 (#2902): IAAA lifecycle moved to src/server/routes/auth.ts —
    // /api/iaaa/access-request*, membership/permission/role-grant/
    // logged-in-users/quota/policy/bootstrap lifecycle, /api/api-keys.
    const authIaaaResponse = await handleAuthIaaaRoutes(request, env, url, path);
    if (authIaaaResponse) return authIaaaResponse;
    // Slice 7 (#2902): MCP moved to src/server/routes/platform.ts —
    // /mcp, /api/mcp, /mcp/scanner, /mcp/scanner/*.
    const platformMcpResponse = await handlePlatformMcpRoutes(request, env, url, path);
    if (platformMcpResponse) return platformMcpResponse;
    // Slice 7 (#2902): payments family moved to src/server/routes/platform.ts —
    // OPTIONS preflight, /api/payments/agentic/* + /payments/agentic/commercial/*,
    // /api/premium/*, /api/payments/webhook + /payments/webhook.
    const platformPaymentsResponse = await handlePlatformPaymentsRoutes(request, env, url, path);
    if (platformPaymentsResponse) return platformPaymentsResponse;
    // Slice 5 (#2902): omnichannel trading moved to src/server/routes/trading.ts —
    // /api/trading/email/*, /api/trading/slack/*, /api/trading/voice/*,
    // /api/trading/options/*, /trading/options/*, /api/schedules (forward).
    const tradingOmniResponse = await handleTradingOmniRoutes(request, env, url, path);
    if (tradingOmniResponse) return tradingOmniResponse;

    // #1768: WebSocket upgrade dispatch, table-driven (src/api/wsRoutes.ts).
    // Same position in the chain as the two branches it replaces
    // (after schedules, before batch quotes), same paths, same auth:
    // voice still 401s without a session BEFORE accept (#154), and
    // the quotes path stays public (M10, #2230 — routing through
    // routeAgentRequest onBeforeConnect would 401 unauthenticated
    // callers and break the public landing page tape). The quotes
    // upgrade now forwards with caller identity headers stripped
    // (TickerAgent reads only the #1725 x-quote-* carriers, never
    // x-user-login), and in API_INGRESS_MODE=unified the IP burst
    // cap applies (F-40). Non-upgrade requests fall through (null),
    // exactly as the old branches' failed conditions did.
    const wsResponse = await dispatchWsUpgrade(request, env, {
      requireAuth: (req, e) => requireAuth(req, e as Env),
      acceptVoice: async (_req, _e, userLogin) => {
        // Issue #154: the voice-trading session requires an app session,
        // checked BEFORE the WebSocket is accepted. Previously a null
        // session proceeded under a shared synthetic voice identity, so an
        // unauthenticated caller could open a voice trading session.
        const pair = new WebSocketPair();
        const [clientWs, serverWs] = Object.values(pair);
        serverWs.accept();

        // Issue #815: the worker isolate has no ORM (an ORM wraps a
        // specific Durable Object's storage.sql), so voice turns are
        // forwarded per-turn to the session user's orchestrator DO, whose
        // POST /trading/voice/turn route runs the voice service against
        // the DO's real ORM. The forwarder keys the DO instance by, and
        // sets the identity header from, the verified session login above
        // — never from caller input.
        const forwardVoiceTurn = createOrchestratorVoiceTurnForwarder(env, userLogin);
        handleVoiceWebSocketConnection(serverWs, env, undefined, userLogin, forwardVoiceTurn).catch(console.warn);

        return new Response(null, { status: 101, webSocket: clientWs });
      },
      fetchTicker: async (strippedRequest) => {
        return actorGateway.dispatch(env.TICKER_AGENT, TICKER_INSTANCE_NAME, strippedRequest);
      },
      ingressMode: apiIngressMode,
    });
    if (wsResponse) return wsResponse;
    // Slice 5 (#2902): market quotes moved to src/server/routes/trading.ts —
    // /api/market-data/quotes, /api/market/quotes, /api/foss/quotes, /api/market/quotes/source.
    const tradingQuotesResponse = await handleTradingQuotesRoutes(request, env, url, path);
    if (tradingQuotesResponse) return tradingQuotesResponse;
    // Slice 7 (#2902): browser-agent snapshots moved to src/server/routes/platform.ts —
    // POST /api/browser/snapshot, /browser/snapshot, /api/browser/transaction-snap,
    // /browser/transaction-snap, /api/browser/snap/transaction.
    const platformBrowserResponse = await handlePlatformBrowserRoutes(request, env, url, path);
    if (platformBrowserResponse) return platformBrowserResponse;
    // Slice 6 (#2902): Slack family moved to src/server/routes/messaging.ts —
    // /slack/commands, /slack/slash, /slack, /slack/events, /slack/interactions,
    // /slack/install, /slack/oauth_callback.
    const messagingSlackResponse = await handleMessagingSlackRoutes(request, env, url, path);
    if (messagingSlackResponse) return messagingSlackResponse;
    // Slice 5 (#2902): approve/clear/reset/options-flows moved to src/server/routes/trading.ts —
    // /trade/approve, /clear, /reset, /api/clear, /api/reset, /api/options/flows/*.
    const tradingApproveResponse = await handleTradingApproveRoutes(request, env, url, path);
    if (tradingApproveResponse) return tradingApproveResponse;
    // Slice 2 (#2902): Core late tail moved to src/server/routes/core.ts —
    // /openapi.json + /api/docs, the /api/* fallthrough to the Orchestrator
    // (SEARCH_AGENT), /checkout/sandbox, / + /index.html, static fallback.
    // The late handler is the dispatcher terminus: it always returns (its
    // last statement is the original static-asset fallback), so its result
    // is returned directly, exactly as the inline tail did.
    return handleCoreLateRoutes(request, env, url, path);
}

// Slice 7 (#2902): PREMIUM_GATEWAY_INSTANCE moved to src/server/routes/platform.ts;
// re-exported here so existing imports from the entry keep working.
export { PREMIUM_GATEWAY_INSTANCE } from "./server/routes/platform";

// Issue #1739 — per-subscriber dedup for screener-event delivery
// batches. Module-level so it survives across batches in one
// isolate; cross-isolate redelivery is possible under at-least-once
// delivery (see the messaging port docstring), and downstream
// scheduled deliveries already dedup on their own stable delivery id.
const screenerDeliverySeen = new Set<string>();

// Issue #2544 (Cloudflare migration step 1) — per-envelope dedup
// for screener-events work batches, same isolate-scoped shape as
// the delivery seen set above: the QueuePort consumer core marks
// processed/drop envelope ids seen, so an at-least-once redelivery
// never re-invokes the work handler.
const screenerEventsSeen = new Set<string>();

/**
 * Issue #2544 — the single options_analysis queue dispatch, shared
 * by the revived screener-events consumer and the legacy fallthrough
 * below. Identity rules (#1185/#1066, #2331 slice 2): queue work
 * runs under the message payload's stored owner when it carries
 * one, else the explicit service identity. With neither, this
 * THROWS (the caller retries) rather than dispatching under a
 * fabricated identity. A service dispatch additionally requires a
 * live platform-tier member binding, and the shared-orchestrator
 * address is never an identity. Denied messages return "denied"
 * (the caller acks/drops them, never retries: a re-dispatch
 * would deny again, and options analysis is time-sensitive).
 *
 * @param awaitDispatch — true routes the trigger fetch through
 * await (a fetch failure throws → the QueuePort core retries
 * into the DLQ); false preserves the legacy fallthrough shape
 * (waitUntil when available, else await).
 */
async function dispatchOptionsAnalysisQueueWork(opts: {
  env: Env;
  ctx?: any;
  agent: { fetch: (request: Request) => Promise<unknown> };
  payload: Record<string, unknown> | null | undefined;
  serviceUserLogin: string | null;
  getServiceProvisioned: () => Promise<boolean>;
  awaitDispatch: boolean;
  runId?: string;
  unitId?: string;
}): Promise<"dispatched" | "denied"> {
  // Matches the pre-#2544 fallthrough exactly: a falsy payload
  // dispatches as an empty object, never as a falsy body.
  const payload = opts.payload || {};
  const payloadOwner = isLoginShaped(
    (payload as { userLogin?: unknown }).userLogin
  )
    ? (payload as { userLogin: string }).userLogin
    : null;
  const userLogin = payloadOwner ?? opts.serviceUserLogin;
  if (!userLogin) {
    throw new Error(
      "options_analysis queue message has no payload owner and SERVICE_USER_LOGIN is not configured — refusing to dispatch under a fabricated identity (#1185)."
    );
  }
  let denied: string | null = null;
  if (isSharedOrchestratorAddress(userLogin)) {
    denied = "the payload names the shared-orchestrator address as its owner";
  } else if (userLogin === opts.serviceUserLogin) {
    if (!(await opts.getServiceProvisioned())) {
      denied = "the service user is not provisioned for the platform tier";
    }
  }
  if (denied) {
    const scope =
      opts.runId !== undefined
        ? ` (run ${opts.runId}, unit ${opts.unitId ?? opts.runId})`
        : "";
    console.warn(
      `[Queue Handler] Dropping options_analysis queue message${scope}: ${denied} — dispatching it would run unattended work without a verified identity (#2331 slice 2).`
    );
    return "denied";
  }
  const queuePromise = opts.agent.fetch(
    new Request("https://agent.internal/schedules/trigger-options-analysis", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Issue #1764 — background attribution: the unattended
        // dispatch carries x-actor-kind: background alongside
        // x-user-login, so downstream audit no longer has to know
        // the service login value to tell background from user work.
        ...backgroundDispatchHeaders(userLogin),
      },
      body: JSON.stringify(payload),
    })
  );
  if (!opts.awaitDispatch && opts.ctx?.waitUntil) opts.ctx.waitUntil(queuePromise);
  else await queuePromise;
  return "dispatched";
}

export default {
  // Issue #329: an escaped throw used to surface as Cloudflare error 1101 —
  // every visitor saw an edge error page. The boundary turns any failure into a
  // real 5xx with a machine-readable code (and stops KV quota throws from
  // taking authentication, and therefore the site, down).
  // Issue #1743 — HTTP boundary observability: honor the
  // incoming traceparent (or start a fresh trace), time the
  // request, stream one http.request event. Purely
  // observational — the response passes through unchanged,
  // and the error boundary still converts throws to 5xx.
  fetch: withRequestObservability(withErrorBoundary(handleFetch)),
  async email(message: any, env: Env, ctx?: any): Promise<void> {
    await handleCloudflareEmailMessage(message, env, ctx);
  },
  async scheduled(event: any, env: Env, ctx?: any): Promise<void> {
    // Phase 5 Slice 2 (#2000) — durable breaker production path (see ensureBreakerDurability).
    ensureBreakerDurability(env);
    // #1185 / #1066 — unattended work runs under the explicit service
    // identity (SERVICE_USER_LOGIN), never a hardcoded synthetic login.
    // The shared Orchestrator instance is addressed by its established
    // address (an address, not an identity). When no service identity is
    // configured, the identity-bearing dispatches below are skipped and
    // logged — failing closed instead of fabricating an identity. The
    // 03:00 UTC token-renewal pass asserts no identity (it enumerates
    // every stored token) and runs either way.
    // #2331 slice 2: configuration alone is not enough — the tick and
    // the identity-bearing dispatches below run only while the service
    // user holds a live platform-tier member binding. Worker-level
    // denials are logged here (no funnel is available in the Worker
    // entry); in-agent denials are funnel-audited. LOUD CONSEQUENCE:
    // after this deploys, scheduled goals pause until a platform admin
    // provisions the platform tier via POST
    // /api/admin/service-user/provision (nothing is provisioned today).
    // That is the fail-closed intent, not a surprise outage.
    const userLogin = getServiceUserLogin(env);
    const serviceProvisioned = userLogin
      ? await isPlatformServiceProvisioned(
          createKvMembershipStore(sessionStore(env)),
          userLogin,
          Date.now(),
        )
      : false;
    const agent = actorGateway.stub<DoStubLike>(env.SEARCH_AGENT, SHARED_ORCHESTRATOR_INSTANCE);

    // PR #4 — ScheduledAgent tick: evaluate due goals, budget-check,
    // create Orchestrator jobs (issue #166).
    if (event?.cron === "*/30 * * * *") {
      if (!userLogin || !serviceProvisioned) {
        console.error(
          "[scheduled] Service user is not provisioned for the platform tier — skipping the ScheduledAgent tick and the research/reflection/adaptation dispatches rather than running unattended work without a verified identity (#2331 slice 2). Provision the platform tier via POST /api/admin/service-user/provision to resume scheduled goals."
        );
        return;
      }
      const schedAgent = actorGateway.stub<{
        onCron(): Promise<unknown>;
      }>(env.SCHEDULED_AGENT, "default");
      const tickPromise = schedAgent.onCron();
      if (ctx?.waitUntil) ctx.waitUntil(tickPromise);
      else await tickPromise;
      // Issue Qunsultant/cfagent#2037 — one trace per tick. Every
      // dispatch below carries a child span of this trace, so a
      // DO-side AE event, a mas_events outcome row, and a Slack
      // alert all correlate to the tick that sent them. The
      // traceparent rides every tick dispatch (corpus/digest
      // included — their routes ignore it today, at no cost);
      // only the three named jobs get the failure observer, per
      // the issue's scope. The observer never rejects, so
      // waitUntil/await below keep today's fire-and-forget shape.
      const tickTrace = newTraceContext();
      const observeTickDispatch = (
        job: "research" | "reflection" | "adaptation",
        promise: Promise<unknown>,
      ): Promise<void> =>
        observeInternalDispatch(promise, {
          job,
          sink: createObservabilitySink(env),
          trace: tickTrace,
          recordFailure: async (input) => {
            const recorded = (await agent.fetch(
              new Request("https://agent.internal/scheduled-job-outcome", {
                method: "POST",
                headers: backgroundDispatchHeadersWithTrace(
                  userLogin,
                  formatTraceparent(childSpan(tickTrace)),
                ),
                body: JSON.stringify(input),
              }),
            )) as unknown as { status?: unknown };
            if (
              !recorded ||
              typeof recorded.status !== "number" ||
              recorded.status >= 400
            ) {
              throw new Error("scheduled-job-outcome record failed");
            }
          },
          alertUnreachable: async (failedJob, trace) => {
            await postSlackText({
              post: resourceSlackPost,
              env: env as unknown as SlackDeliveryEnv,
              text:
                `Scheduled job ${failedJob} dispatch failed AND its outcome ` +
                `record is unreachable (trace ${trace.traceId}). The DO did ` +
                `not record this failure — investigate the dispatch layer; ` +
                `see Cloudflare logs for the tick.`,
            });
          },
        });
      // Issue #354 — the daily options-research run (after market close)
      // rides this tick: the dedicated 0 21 * * 1-5 trigger cannot exist
      // (Workers Free ceiling of 5 cron triggers/account, error 10072; it
      // was never in wrangler.jsonc, so the old branch below was dead code).
      // Fire/no-fire is decided inside the tick route (weekday, >= 21:00
      // UTC, not already fired today — durable guard in mas_settings), so
      // this dispatch is unconditional; skips are cheap and explicit.
      const researchPromise = observeTickDispatch(
        "research",
        agent.fetch(
          new Request("https://agent.internal/research/scheduled-tick", {
            method: "POST",
            headers: backgroundDispatchHeadersWithTrace(
              userLogin,
              formatTraceparent(childSpan(tickTrace)),
            ),
          }),
        ),
      );
      if (ctx?.waitUntil) ctx.waitUntil(researchPromise);
      else await researchPromise;
      // Issue #705 — the weekly reflection job rides this tick (same
      // Workers Free ceiling constraint as #354). Fire/no-fire is decided
      // inside the route (Sunday, not already fired this week — durable
      // guard in mas_settings), so this dispatch is unconditional.
      const reflectionPromise = observeTickDispatch(
        "reflection",
        agent.fetch(
          new Request("https://agent.internal/reflection/run", {
            method: "POST",
            headers: backgroundDispatchHeadersWithTrace(
              userLogin,
              formatTraceparent(childSpan(tickTrace)),
            ),
          }),
        ),
      );
      if (ctx?.waitUntil) ctx.waitUntil(reflectionPromise);
      else await reflectionPromise;
      // Issue #754 — the weekly strategy-weight adjustment rides this
      // tick (same Workers Free ceiling constraint as #354/#705).
      // Fire/no-fire is decided inside the job (ISO-week guard +
      // adaptation kill switch in mas_settings), so this dispatch is
      // unconditional; skips are cheap and explicit in the job result.
      const weightsPromise = observeTickDispatch(
        "adaptation",
        agent.fetch(
          new Request("https://agent.internal/adaptation/weights/run", {
            method: "POST",
            headers: backgroundDispatchHeadersWithTrace(
              userLogin,
              formatTraceparent(childSpan(tickTrace)),
            ),
          }),
        ),
      );
      if (ctx?.waitUntil) ctx.waitUntil(weightsPromise);
      else await weightsPromise;
      // Issue #1169 (S4-4) — the weekly corpus sync rides this tick
      // (same Workers Free ceiling constraint as #354/#705/#754).
      // Fire/no-fire is decided inside the route (weekly guard +
      // durable marker in mas_settings), so this dispatch is
      // unconditional; skips are cheap and explicit in the route
      // result.
      const corpusSyncPromise = agent.fetch(
        new Request("https://agent.internal/knowledge/corpus-sync", {
          method: "POST",
          headers: backgroundDispatchHeadersWithTrace(
            userLogin,
            formatTraceparent(childSpan(tickTrace)),
          ),
        })
      );
      if (ctx?.waitUntil) ctx.waitUntil(corpusSyncPromise);
      else await corpusSyncPromise;
      // Issue #2659 (monetization Phase 2.4) — the scheduled
      // digest pass rides this tick (same Workers Free ceiling
      // constraint as #354/#705/#754/#1169: no new cron trigger).
      // Fire/no-fire is decided inside the route (once per UTC
      // day — durable marker in agent_digest_pass_days), so this
      // dispatch is unconditional; the route returns fired:false
      // on later ticks the same day, and the tick supplies no
      // itemsByUser, so scheduled sends use the digest content
      // provider (#2981: tenant projection highlights); a
      // subscriber with no windowed reports honestly skips.
      // Dispatches as the service user
      // (backgroundDispatchHeaders), which is the only identity
      // the run-due route accepts.
      const digestPassPromise = agent.fetch(
        new Request("https://agent.internal/payments/agentic/commercial/lifecycle/digest/run-due", {
          method: "POST",
          headers: backgroundDispatchHeadersWithTrace(
            userLogin,
            formatTraceparent(childSpan(tickTrace)),
          ),
        })
      );
      if (ctx?.waitUntil) ctx.waitUntil(digestPassPromise);
      else await digestPassPromise;
      // Issue #1077 Phase 5b slice 1: the parallel social tick is gone.
      // Social posting is now a ScheduledAgent goal ("daily-social-post",
      // disabled by default) evaluated by the onCron call at the top of
      // this branch — no second scheduler, no second fire check.
      return;
    }
    // Renew all account-scoped Durable Object tokens before midnight ET.
    if (event?.cron === "0 3 * * *") {
      const renewPromise = renewAllStoredETradeTokens(env).then((counts) => {
        console.info("[scheduled] E*TRADE account-token renewal completed", counts);
      });
      if (ctx?.waitUntil) ctx.waitUntil(renewPromise);
      else await renewPromise;
      // Issue #255 — nightly mas_messages retention pass (0 4 * * * cron in
      // wrangler.jsonc). Enforces the retention window and records one
      // mas_events row per run.
    } else if (event?.cron === "0 4 * * *") {
      if (!userLogin || !serviceProvisioned) {
        console.error(
          "[scheduled] SERVICE_USER_LOGIN is not configured or the service user is not provisioned for the platform tier — skipping the retention dispatch rather than running unattended work without a verified identity (#2331 slice 2)."
        );
        return;
      }
      const retentionPromise = agent.fetch(
        new Request("https://agent.internal/schedules/trigger-retention", {
          method: "POST",
          headers: { ...backgroundDispatchHeaders(userLogin) },
        })
      );
      if (ctx?.waitUntil) ctx.waitUntil(retentionPromise);
      else await retentionPromise;
    }
  },
  async queue(batch: any, env: Env, ctx?: any): Promise<void> {
    // Phase 5 Slice 2 (#2000) — durable breaker production path (see ensureBreakerDurability).
    ensureBreakerDurability(env);
    // Issue #1739 — durable screener-event delivery. The delivery
    // subscriber queue is dispatched through the broadcast core with
    // per-subscriber dedup; screener-events batches take the step-1
    // branch below, and every other batch falls through to the
    // existing path untouched (options_analysis + ack-all behavior
    // preserved).
    // Phase 5 Slice 1 (issue #2000) — dead-letter persistence
    // closure, shared by all three queue branches below. The
    // console dead-letter record is always emitted first by the
    // caller; this closure only adds the store row + depth
    // check. It never throws by construction (schema-ensure
    // failures return early, the persist helper catches the
    // rest), so awaiting it can never change an ack/retry
    // disposition. Unbound AGENT_DB yields undefined: drops
    // stay console-only, exactly today's behavior.
    const dlqStore = createDeadLetterStoreAdapter(env);
    const persistDeadLetter = dlqStore
      ? async (record: DeadLetterRecord, envelope: MessageEnvelope | null): Promise<void> => {
          try {
            await ensureDeadLetterStoreSchema(dlqStore.db);
          } catch (err) {
            console.warn("[dead-letter] schema ensure failed (console record stands):", err);
            return;
          }
          await persistDeadLetterLanding(
            {
              store: dlqStore,
              threshold: resolveDlqDepthAlertThreshold(env as unknown as Record<string, unknown>),
              sendAlert: async (text) => {
                // Env carries the Slack delivery vars postSlackText
                // reads; the cast bridges the index-signature gap
                // between the Env interface and SlackDeliveryEnv.
                await postSlackText({ post: resourceSlackPost, env: env as unknown as SlackDeliveryEnv, text });
              },
            },
            record,
            envelope,
          );
        }
      : undefined;
    if (batch?.queue === "screener-events-delivery") {
      const deliveryHandler = createScreenerQueueHandler({ env });
      const handlers: SubscriberHandlers = new Map([
        [
          "delivery",
          new Map([
            ["screener.completed", deliveryHandler],
            ["screener.failed", deliveryHandler],
          ]),
        ],
      ]);
      await dispatchSubscriberBatch(
        batch,
        "delivery",
        handlers,
        screenerDeliverySeen,
        persistDeadLetter
      );
      // Issue #1743 — passive observability tap: fold the same
      // delivery envelopes into the Analytics Engine stream.
      // This tap NEVER owns ack/retry (delivery above does) and
      // NEVER fails the batch — a tap failure is warned, and
      // the delivery outcome stands.
      try {
        const sink = createObservabilitySink(env);
        for (const msg of batch.messages ?? []) {
          if (isMessageEnvelope(msg.body)) {
            await writeEnvelopeToSink(sink, msg.body);
          }
        }
      } catch (tapErr) {
        console.warn(
          "[observability] delivery tap failed (ignored):",
          tapErr,
        );
      }
      return;
    }
    // Issue #2544 (Cloudflare migration step 1) — the screener-events
    // work queue finally has a consumer. Envelopes route through
    // the QueuePort consumer contract (consumeCfBatch over the
    // messaging ports, deduped on the envelope id): at-least-once
    // delivery, a handler throw becomes a retry (the platform
    // re-delivers up to max_retries, then the DLQ —
    // screener-events-dlq — with run/unit ids intact in the
    // message body), and the options_analysis work item is REVIVED
    // here (decided in #2544) via the QueuePort work handler.
    // Legacy non-envelope taskType messages take the deprecated
    // wrapper below; anything else can never decode and is acked
    // + logged, never retried (a poison-loop guard).
    if (batch?.queue === "screener-events") {
      const serviceUserLogin = getServiceUserLogin(env);
      const agent = actorGateway.stub<DoStubLike>(env.SEARCH_AGENT, SHARED_ORCHESTRATOR_INSTANCE);
      let serviceProvisioned: boolean | null = null;
      const getServiceProvisioned = async (): Promise<boolean> => {
        if (serviceProvisioned === null) {
          serviceProvisioned = await isPlatformServiceProvisioned(
            createKvMembershipStore(sessionStore(env)),
            serviceUserLogin,
            Date.now(),
          );
        }
        return serviceProvisioned;
      };
      const dispatchWork = (
        payload: Record<string, unknown> | null | undefined,
        awaitDispatch: boolean,
        runId?: string,
        unitId?: string
      ) =>
        dispatchOptionsAnalysisQueueWork({
          env,
          ctx,
          agent,
          payload,
          serviceUserLogin,
          getServiceProvisioned,
          awaitDispatch,
          runId,
          unitId,
        });
      // Issue #1764 — the work handler's terminal drops (no
      // handler, denied dispatch) go through its default console
      // dead-letter sink: one parseable `[dead-letter]` record
      // per drop, ack/retry semantics unchanged.
      const workHandler = createScreenerEventsWorkHandler({
        dispatchOptionsAnalysis: (payload, runId, unitId) =>
          dispatchWork(payload, true, runId, unitId),
        persistDeadLetter,
      });
      const envelopeMessages: any[] = [];
      if (batch?.messages && Array.isArray(batch.messages)) {
        for (const msg of batch.messages) {
          if (isAnalysisDoneStageMessage(msg.body)) {
            // Issue #2869 slice 1 — the analysis-done queue
            // executor. The message routes to the OWNING
            // ScreenerAgent DO (per-owner instance, so the
            // durable stage claims are the in-process leg's
            // claims: a normal-path redelivery is
            // duplicate-suppressed, never regenerated).
            // Ack on generated / duplicate-suppressed /
            // dead-lettered; retry (to max_retries, then
            // the screener-events-dlq) only when the
            // consumer throws — a missing persisted
            // analysis, which the consumer refuses to
            // fabricate. A poison body can never reach
            // here: the guard above only passes
            // well-shaped analysis-done messages.
            try {
              const stageMsg = msg.body;
              const agentId = env.SCREENER_AGENT.idFromName(
                resolveScreenerAgentName(env, stageMsg.userLogin),
              );
              const agent = env.SCREENER_AGENT.get(agentId) as unknown as {
                consumeQueuedAnalysisDone: (
                  message: unknown,
                  attempt?: number,
                ) => Promise<{ status: string; reason?: string; pdfKey?: string; pdfStatus?: string; pdfError?: string }>;
              };
              const outcome = await agent.consumeQueuedAnalysisDone(
                stageMsg,
                typeof (msg as { attempts?: unknown }).attempts === "number"
                  ? ((msg as { attempts: number }).attempts as number)
                  : 1,
              );
              // Issue #2869 slice 1 follow-up: on a queued
              // generation (in-process leg failed, claim
              // released, queued consume generated), refresh
              // the canonical row's PDF fields through the
              // one recorder — otherwise the Reports tab
              // keeps showing no PDF for a run that now has
              // one. Refresh is update-only, monotonic, and
              // owner-scoped, so a duplicate-suppressed
              // consume (no pdfKey carried) refreshes
              // nothing, and a refresh failure never fails
              // the queue ack: the generated PDF is already
              // durable on the persisted analysis key.
              // Addressing, stated plainly: the recorder
              // instance that wrote the row is the REST
              // path's per-user orchestrator instance for
              // manual runs, and the shared orchestrator
              // instance for workflow runs — so the
              // handler tries the per-user instance first
              // and the shared instance when that reports
              // no row. Both attempts are update-only and
              // owner-scoped, so a miss refreshes nothing.
              if (outcome.status === "generated" && outcome.pdfKey) {
                try {
                  const refreshInput = {
                    generationId: stageMsg.runId,
                    userLogin: stageMsg.userLogin,
                    pdfKey: outcome.pdfKey,
                    ...(outcome.pdfStatus ? { pdfStatus: outcome.pdfStatus } : {}),
                    ...(outcome.pdfError ? { pdfError: outcome.pdfError } : {}),
                  };
                  type RefreshOrchestrator = {
                    refreshCanonicalPdfFields: (
                      input: typeof refreshInput,
                    ) => Promise<{ status: string; reportId?: string }>;
                  };
                  const perUser = actorGateway.stub<RefreshOrchestrator>(
                    env.SEARCH_AGENT,
                    stageMsg.userLogin,
                  );
                  const first = await perUser.refreshCanonicalPdfFields(refreshInput);
                  if (first.status === "missing-row") {
                    const shared = actorGateway.stub<RefreshOrchestrator>(
                      env.SEARCH_AGENT,
                      SHARED_ORCHESTRATOR_INSTANCE,
                    );
                    const second = await shared.refreshCanonicalPdfFields(refreshInput);
                    if (second.status !== "refreshed" && second.status !== "noop") {
                      console.warn(`[Queue Handler] canonical PDF refresh unresolved: per-user ${first.status}, shared ${second.status} (run ${stageMsg.runId}).`);
                    }
                  } else if (first.status !== "refreshed" && first.status !== "noop") {
                    console.warn(`[Queue Handler] canonical PDF refresh ${first.status} (run ${stageMsg.runId}).`);
                  }
                } catch (refreshErr) {
                  console.warn(`[Queue Handler] canonical PDF refresh failed (run ${stageMsg.runId}); generated PDF remains on the persisted analysis key:`, refreshErr);
                }
              }
              if (typeof msg.ack === "function") msg.ack();
              if (outcome.status === "dead-lettered") {
                console.warn("[Queue Handler] analysis-done stage message dead-lettered:", outcome.reason ?? "unknown");
              }
            } catch (queueErr) {
              console.warn("[Queue Handler] Failed to consume analysis-done stage message; retrying:", queueErr);
              if (typeof msg.retry === "function") msg.retry();
            }
          } else if (isStageBoundaryMessage(msg.body)) {
            // Issue #2869 slice 2 — the stage-boundary queue
            // executor. The message routes to the OWNING
            // ScreenerAgent DO (per-owner instance, so the
            // durable stage claims are the in-process leg's
            // claims): the recorder claims the idempotencyKey
            // and verifies the boundary artifact exists, then
            // acks on recorded / duplicate-suppressed /
            // dead-lettered; it throws (retry to max_retries,
            // then the screener-events-dlq) only on a missing
            // persisted artifact, which the recorder refuses
            // to fabricate. Without this branch these messages
            // would fall through to the undecodable drop below.
            try {
              const stageMsg = msg.body;
              const agentId = env.SCREENER_AGENT.idFromName(
                resolveScreenerAgentName(env, stageMsg.userLogin),
              );
              const agent = env.SCREENER_AGENT.get(agentId) as unknown as {
                recordQueuedStageBoundary: (
                  message: unknown,
                  attempt?: number,
                ) => Promise<{ status: string; reason?: string }>;
              };
              const outcome = await agent.recordQueuedStageBoundary(
                stageMsg,
                typeof (msg as { attempts?: unknown }).attempts === "number"
                  ? ((msg as { attempts: number }).attempts as number)
                  : 1,
              );
              if (typeof msg.ack === "function") msg.ack();
              if (outcome.status === "dead-lettered") {
                console.warn("[Queue Handler] stage-boundary message dead-lettered:", outcome.reason ?? "unknown");
              }
            } catch (queueErr) {
              console.warn("[Queue Handler] Failed to record stage-boundary message; retrying:", queueErr);
              if (typeof msg.retry === "function") msg.retry();
            }
          } else if (isMessageEnvelope(msg.body)) {
            envelopeMessages.push(msg);
          } else if (msg.body?.taskType === "options_analysis") {
            // @deprecated Legacy taskType queue shape — superseded by CloudEvents envelope work items routed through the QueuePort screener-events consumer (src/messaging/screenerEventsConsumer.ts). Kept as a thin wrapper; do not add new producers.
            try {
              const legacyOutcome = await dispatchWork(msg.body?.payload, false);
              if (legacyOutcome === "denied") {
                // Issue #1764 — a denied legacy message is dropped
                // (acked below), now with a structured dead-letter
                // record instead of only the dispatch warning.
                const legacyDeniedRecord = createDeadLetterRecord({
                  queue: batch.queue,
                  reason: "denied",
                  detail:
                    "Legacy options_analysis dispatch denied by the identity rules — dropping; a re-dispatch would deny again (#1764).",
                });
                logDeadLetter(legacyDeniedRecord);
                // Slice 1 (#2000): persist the drop (no envelope;
                // a denied dispatch is never replayable).
                await persistDeadLetter?.(legacyDeniedRecord, null);
              }
              if (typeof msg.ack === "function") msg.ack();
            } catch (queueErr) {
              console.warn("[Queue Handler] Failed to process queue message:", queueErr);
              if (typeof msg.retry === "function") msg.retry();
            }
          } else {
            // Issue #1764 — acked as before (undecodable bytes can
            // never decode), now with a structured dead-letter record.
            const undecodableRecord = createDeadLetterRecord({
              queue: batch.queue,
              reason: "undecodable",
              detail:
                "Dropping undecodable screener-events queue message (no valid envelope, no legacy taskType) (#1764).",
            });
            logDeadLetter(undecodableRecord);
            // Slice 1 (#2000): persist the drop (no envelope).
            await persistDeadLetter?.(undecodableRecord, null);
            if (typeof msg.ack === "function") msg.ack();
          }
        }
      }
      if (envelopeMessages.length > 0) {
        const ports = createMessagingPorts(env, {
          seenIds: screenerEventsSeen,
        });
        if (ports) {
          await consumeCfBatch(
            { queue: batch.queue, messages: envelopeMessages },
            ports.consumer,
            workHandler,
            persistDeadLetter
          );
        } else {
          // No messaging ports (no SCREENER_EVENTS binding): the
          // worker cannot honestly claim QueuePort routing, so the
          // envelopes are retried into the DLQ path visibly rather
          // than acked into silence.
          console.warn(
            "[messaging] screener-events batch has no messaging ports — retrying envelopes into the DLQ path."
          );
          for (const msg of envelopeMessages) {
            if (typeof msg.retry === "function") msg.retry();
          }
        }
      }
      return;
    }
    // #1185 / #1066 — queue work runs under the message payload's stored
    // owner when it carries one, else the explicit service identity. With
    // neither, the message is retried (the existing catch path) rather
    // than dispatched under a fabricated identity.
    // #2331 slice 2: a service dispatch additionally requires a live
    // platform-tier member binding, and the shared-orchestrator address
    // is never an identity. Denied messages are logged and acked
    // (dropped, not retried: a re-dispatch would deny again, and
    // options analysis is time-sensitive).
    const serviceUserLogin = getServiceUserLogin(env);
    const agent = actorGateway.stub<DoStubLike>(env.SEARCH_AGENT, SHARED_ORCHESTRATOR_INSTANCE);
    let serviceProvisioned: boolean | null = null;

    if (batch?.messages && Array.isArray(batch.messages)) {
      for (const msg of batch.messages) {
        try {
          const body = msg.body;
          if (body?.taskType === "options_analysis") {
            // @deprecated Legacy taskType queue shape — superseded by CloudEvents envelope work items routed through the QueuePort screener-events consumer (src/messaging/screenerEventsConsumer.ts). Kept as a thin wrapper; do not add new producers.
            const fallthroughOutcome = await dispatchOptionsAnalysisQueueWork({
              env,
              ctx,
              agent,
              payload: body?.payload,
              serviceUserLogin,
              getServiceProvisioned: async () => {
                if (serviceProvisioned === null) {
                  serviceProvisioned = await isPlatformServiceProvisioned(
                    createKvMembershipStore(sessionStore(env)),
                    serviceUserLogin,
                    Date.now(),
                  );
                }
                return serviceProvisioned;
              },
              awaitDispatch: false,
            });
            if (fallthroughOutcome === "denied") {
              // Issue #1764 — dropped (acked below) with a
              // structured dead-letter record, as in the
              // screener-events legacy branch above.
              const fallthroughDeniedRecord = createDeadLetterRecord({
                queue: batch.queue,
                reason: "denied",
                detail:
                  "Legacy options_analysis dispatch denied by the identity rules — dropping; a re-dispatch would deny again (#1764).",
              });
              logDeadLetter(fallthroughDeniedRecord);
              // Slice 1 (#2000): persist the drop (no envelope).
              await persistDeadLetter?.(fallthroughDeniedRecord, null);
            }
          }
          if (typeof msg.ack === "function") msg.ack();
        } catch (queueErr) {
          console.warn("[Queue Handler] Failed to process queue message:", queueErr);
          if (typeof msg.retry === "function") msg.retry();
        }
      }
    }
  },
} satisfies ExportedHandler<Env>;


