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
import { handleCoreEarlyRoutes, handleCoreHealthRoutes, handleCoreLateRoutes, ensureBreakerDurability } from "./server/routes/core";
import { handleAuthLoginRoutes, handleAuthMeRoutes, handleAuthIaaaRoutes } from "./server/routes/auth";
import { handlePrivacyRoutes, handlePrivacyChainsRoutes, handlePrivacyReportsRoutes } from "./server/routes/privacy";
import { handleTradingScheduleRoutes, handleTradingOmniRoutes, handleTradingQuotesRoutes, handleTradingApproveRoutes } from "./server/routes/trading";
import { handleMessagingSagaRoutes, handleMessagingSocialRoutes, handleMessagingSlackRoutes } from "./server/routes/messaging";
import { handlePlatformTelemetryRoutes, handlePlatformRetrievalRoutes, handlePlatformMcpRoutes, handlePlatformPaymentsRoutes, handlePlatformBrowserRoutes } from "./server/routes/platform";
import { handleScheduledEvent, handleQueueBatch } from "./server/routes/queue";
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



// Slice 8 (#2902): ensureBreakerDurability moved to src/server/routes/core.ts
// (contract §2.5 Core prelude); imported below and called by handleFetch.

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

// Slice 8 (#2902): queue/scheduled consumer wiring moved to src/server/routes/queue.ts —
// the screenerDeliverySeen / screenerEventsSeen dedup sets and the shared
// dispatchOptionsAnalysisQueueWork helper. The default export below delegates.

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
  // Slice 8 (#2902): scheduled consumer moved to src/server/routes/queue.ts —
  // */30 tick, 03:00 token renewal, 04:00 retention.
  async scheduled(event: any, env: Env, ctx?: any): Promise<void> {
    await handleScheduledEvent(event, env, ctx);
  },
  // Slice 8 (#2902): queue consumer moved to src/server/routes/queue.ts —
  // screener-events-delivery, screener-events, options_analysis fallthrough.
  async queue(batch: any, env: Env, ctx?: any): Promise<void> {
    await handleQueueBatch(batch, env, ctx);
  },
} satisfies ExportedHandler<Env>;


