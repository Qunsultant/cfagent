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
 * Issue #2412 (Agent Mesh S13, G10): the NLQ webhook channel's service
 * identity. The webhook caller is authenticated by HMAC as a SYSTEM
 * caller, not as a user: when the caller asserts a well-formed userId,
 * the run is attributed to the namespaced principal
 * `nlq_webhook_<userId>`; when it asserts none, the run lands on this
 * named service identity — the channel's own instance, not a person's
 * login and not a shared user account. The value is the historical
 * instance name (renaming it would orphan the instance's existing
 * NLQ state); S13's change is to name the posture in code and in the
 * mesh channel registry (src/agents/registry.ts), not to move state.
 */
const NLQ_WEBHOOK_SERVICE_LOGIN = "nlq_webhook";

/**
 * Issue #313: single-owner handler for the NLQ inbound webhook.
 * All three advertised spellings — /nlq/webhook, /api/trading/nlq/webhook,
 * /api/nlq/webhook — delegate here so the logic (throttle, signature
 * verification, replay protection, forwarding) exists exactly once and
 * behaves byte-identically for every spelling.
 */
async function handleNlqWebhookRequest(
  request: Request,
  env: Env,
  throttle: (route: string, maxRequests: number, windowMs: number) => Response | null
): Promise<Response> {
  // Issue #241: this route fans out to the NLQ planner + optional email —
  // throttle per source IP before touching the body.
  const limited = throttle("nlq_webhook", 30, 60_000);
  if (limited) return limited;
  if (!env.INBOUND_NLQ_WEBHOOK_SECRET) {
    return Response.json({ error: "INBOUND_NLQ_WEBHOOK_SECRET is not configured." }, { status: 503 });
  }
  const rawBody = await request.text();
  if (rawBody.length > 128_000) return Response.json({ error: "Webhook payload exceeds 128 KB." }, { status: 413 });
  const verifier = new ETradeWebhookService(undefined, env, NLQ_WEBHOOK_SERVICE_LOGIN);
  // #1768: unified webhook signature header lookup — the same secret
  // and HMAC verification, accepting any known carrier spelling
  // (X-Signature-256 first, then the x-hub/x-signature aliases).
  const pickedSignature = pickWebhookSignature(request.headers);
  const isValid = await verifier.verifySignature(
    rawBody,
    pickedSignature?.value ?? null,
    env.INBOUND_NLQ_WEBHOOK_SECRET,
  );
  if (!isValid) return Response.json({ error: "Invalid NLQ webhook signature." }, { status: 401 });

  let body: { query?: unknown; emailTo?: unknown; userId?: unknown; timestamp?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  // #1768 (F-39): zod shape validation replaces manual property
  // parsing for the ingress body. Messages/statuses below are
  // unchanged — the schema only rejects wrong-typed fields and
  // non-object bodies (which previously threw on body.query and
  // surfaced as a 500) with the handler's existing messages.
  const shaped = nlqWebhookBodySchema.safeParse(body);
  if (!shaped.success) {
    const field = shaped.error.issues[0]?.path[0];
    if (field === "timestamp") {
      return Response.json({ error: "Webhook timestamp is missing, invalid, or expired." }, { status: 401 });
    }
    if (field === "emailTo") {
      return Response.json({ error: "emailTo must be a valid email address." }, { status: 400 });
    }
    return Response.json({ error: "A non-empty query string is required." }, { status: 400 });
  }
  body = shaped.data;
  if (typeof body.query !== "string" || !body.query.trim()) {
    return Response.json({ error: "A non-empty query string is required." }, { status: 400 });
  }
  // #1763 (SEC-005): sanitize the webhook query at entry — marker
  // defuse + control-strip — before the nonce, the forward, and any
  // prompt assembly downstream. Legitimate queries pass verbatim.
  // (Local const, not a re-read of body.query: the declared type
  // is unknown, so downstream uses must go through this variable.)
  const sanitizedQuery = sanitizeInboundText((body.query as string).trim());
  body.query = sanitizedQuery;
  if (typeof body.timestamp !== "string" || !Number.isFinite(Date.parse(body.timestamp)) ||
    Math.abs(Date.now() - Date.parse(body.timestamp)) > 5 * 60 * 1000) {
    return Response.json({ error: "Webhook timestamp is missing, invalid, or expired." }, { status: 401 });
  }
  if (sanitizedQuery.length > 4_000) return Response.json({ error: "Query must be 4,000 characters or fewer." }, { status: 413 });
  if (body.emailTo !== undefined &&
    (typeof body.emailTo !== "string" || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(body.emailTo.trim()))) {
    return Response.json({ error: "emailTo must be a valid email address." }, { status: 400 });
  }
  // Issue #143 P0: emailTo domain allowlist. When
  // EMAIL_TO_ALLOWED_DOMAINS is configured, only listed domains are
  // accepted; otherwise behavior is unchanged (format check only).
  if (typeof body.emailTo === "string" && body.emailTo.trim()) {
    const emailCheck = validateEmailRecipient(body.emailTo, env.EMAIL_TO_ALLOWED_DOMAINS);
    if (!emailCheck.ok) return Response.json({ error: emailCheck.reason }, { status: 400 });
  }
  // Issue #143 P0: replay protection. This edge route has no ORM, so
  // the nonce claim uses the isolate-scoped fallback store; HMAC +
  // the 5-minute timestamp window above remain the primary controls.
  const nlqNonce = await deriveNlqNonce(
    sanitizedQuery,
    typeof body.emailTo === "string" ? body.emailTo.trim() : undefined,
    body.timestamp
  );
  if (await sharedMemoryReplayStore().claim(nlqNonce, "nlq")) {
    return Response.json({ error: "Duplicate NLQ webhook event rejected (replay protection)." }, { status: 409 });
  }
  const userLogin = typeof body.userId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(body.userId)
    ? `nlq_webhook_${body.userId}`
    : NLQ_WEBHOOK_SERVICE_LOGIN;
  const target = new URL("/nlq", "https://agent.internal");
  const forwarded = new Request(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-user-login": userLogin,
      "x-nlq-source": "webhook",
    },
    body: JSON.stringify({ query: sanitizedQuery }),
  });
  const response = await actorGateway.dispatch(env.SEARCH_AGENT, userLogin, forwarded);
  if (!response.ok) return response;
  const result = await response.json() as Record<string, unknown>;

  if (typeof body.emailTo === "string" && body.emailTo.trim()) {
    const plan = result.plan as { operation?: string; domain?: string; tradingData?: { action?: string }; scheduleData?: { action?: string }; agenticPaymentsData?: { action?: string } } | undefined;
    const action = plan?.tradingData?.action || plan?.scheduleData?.action || plan?.agenticPaymentsData?.action;
    const emailAllowed = plan?.domain !== "agentic_payments" &&
      !["preview_order", "execute_order", "watchlist_save", "create", "cancel", "paid_scan", "paid_research"].includes(action || "");
    if (!emailAllowed) return Response.json({ ...result, emailDelivery: "not sent for an action request" });
    const recipient = body.emailTo.trim();
    const emailAgent = new ETradeEmailTradingService(env, undefined, userLogin);
    const summary = typeof result.summary === "string" ? result.summary : "NLQ request processed.";
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const text = `${summary}\n\n${JSON.stringify(rows, null, 2)}`;
    const safeText = text.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    })[character] || character);
    const sent = await emailAgent.sendOutboundEmail(
      recipient,
      "NLQ webhook response",
      `<h2>NLQ response</h2><pre>${safeText}</pre>`,
      text,
    );
    if (!sent) return Response.json({ error: "NLQ succeeded, but email delivery failed." }, { status: 502 });
  }
  return Response.json(result);
}

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

    // Issue #2041 S2: saga journey-gate routes (panel + chat
    // surfaces). Session login comes from requireAuth; the
    // handler 401s when absent (never a synthetic identity).
    if (path === "/api/saga/journey-gates" || path === "/api/saga/journey-decision") {
      const { handleSagaJourneyRoutes } = await import("./agents/routes/sagaJourney");
      const session = await requireAuth(request, env).catch(() => null);
      const sagaJourneyResponse = await handleSagaJourneyRoutes(
        request,
        url,
        path,
        env,
        session?.githubLogin ?? null,
      );
      if (sagaJourneyResponse) return sagaJourneyResponse;
    }

    // Issue #2041 S4: saga entry + status routes. Same placement
    // as the journey branch (before the feature gate): the entry
    // route enforces its own monetization flag (403 when OFF),
    // and the status route is deliberately NOT flag-gated (a read
    // path for one's own sagas must survive a flag flip).
    if (path === "/api/saga/start" || /^\/api\/saga\/[^/]+\/status$/.test(path)) {
      const { handleSagaEntryRoutes } = await import("./agents/routes/sagaEntry");
      const { handleSagaStatusRoutes } = await import("./agents/routes/sagaStatus");
      const session = await requireAuth(request, env).catch(() => null);
      const login = session?.githubLogin ?? null;
      const sagaEntryResponse = await handleSagaEntryRoutes(
        request,
        url,
        path,
        env,
        login,
      );
      if (sagaEntryResponse) return sagaEntryResponse;
      const sagaStatusResponse = await handleSagaStatusRoutes(
        request,
        url,
        path,
        env,
        login,
      );
      if (sagaStatusResponse) return sagaStatusResponse;
    }

    // Issue #1806: Server-side feature flag enforcement (default-closed, fail-closed).
    // An endpoint for a disabled feature is completely unreachable (HTTP 404 FEATURE_DISABLED).
    const gatedFeature = matchFeatureForRoute(path);
    if (gatedFeature) {
      const session = await requireAuth(request, env).catch(() => null);
      const isEnabled = await isFeatureEnabled(env, gatedFeature, {
        userLogin: session?.githubLogin,
      });
      if (!isEnabled) {
        return createFeatureDisabledResponse(gatedFeature, 404);
      }
    }

    if ((path === "/nlq/webhook" || path === "/api/trading/nlq/webhook" || path === "/api/nlq/webhook") && request.method === "POST") {
      // Issue #313: advertised /api spelling — same handler, no forked logic.
      return handleNlqWebhookRequest(request, env, throttle);
    }

    // --- Agents Routing (WebSockets and agent HTTP calls) ---
    const agentResponse = await routeAgentRequest(request, env, {
      cors: true,
      onBeforeConnect: async (req) => {
        // Cross-Site WebSocket Hijacking (CSWSH) check
        if (!isAllowedOrigin(req, env)) {
          return new Response("Forbidden: Invalid Origin", { status: 403 });
        }
        const session = await requireAuth(req, env);
        if (!session) {
          return new Response("Unauthorized", { status: 401 });
        }
      },
      onBeforeRequest: async (req) => {
        const session = await requireAuth(req, env);
        if (!session) {
          return new Response("Unauthorized", { status: 401 });
        }
      },
    });
    if (agentResponse) return agentResponse;
    // Slice 3 (#2902): login family moved to src/server/routes/auth.ts —
    // /login, /auth/login/<id>, /auth/callback/<id>, /auth/logout,
    // E*TRADE OAuth + public-OAuth families.
    const authLoginResponse = await handleAuthLoginRoutes(request, env, url, path);
    if (authLoginResponse) return authLoginResponse;
    // Slice 2 (#2902): /health + /api/health moved to src/server/routes/core.ts.
    const healthResponse = await handleCoreHealthRoutes(request, env, url, path);
    if (healthResponse) return healthResponse;

    // Issue #162 — QA self-healing: LLM investigation of a post-deploy failure.
    // Called by scripts/qa-smoke.mjs after filing the GitHub issue; the
    // returned diagnosis is posted as an issue comment for human supervision.
    // #1754 gate-coverage audit: this route was reachable with NO
    // authentication at all — any caller could spend LLM inference with
    // arbitrary input. It now requires a valid app session OR the
    // dedicated service token QA_INVESTIGATE_TOKEN (Bearer, timing-safe
    // compare, fail-closed when unset). The token is deliberately NOT
    // the A2A invocation token: QA diagnostics and agent dispatch are
    // different trust domains and must not share a credential. The
    // token is platform-set (owner action); it is never
    // user/session/run-configurable, so no caller can disable their
    // own gate. The gate runs before body parsing, so an unauthenticated
    // caller triggers no LLM work at all.
    if (path === "/api/qa/investigate" && request.method === "POST") {
      const session = await requireAuth(request, env).catch(() => null);
      if (!session) {
        const expected = (env as any).QA_INVESTIGATE_TOKEN as string | undefined;
        const authHeader = request.headers.get("authorization") ?? "";
        const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (!expected || !presented || !timingSafeEqual(presented, expected)) {
          console.warn("[qa-investigate] denied: no session and no valid service token");
          return Response.json({ error: "Unauthorized: a valid session or service token is required." }, { status: 401 });
        }
      }
      const body = (await request.json().catch(() => null)) as {
        operation?: unknown;
        errorClass?: unknown;
        detail?: unknown;
        runLink?: unknown;
      } | null;
      const operation = typeof body?.operation === "string" ? body.operation.slice(0, 200) : "";
      const errorClass = typeof body?.errorClass === "string" ? body.errorClass.slice(0, 200) : "";
      const detail = typeof body?.detail === "string" ? body.detail.slice(0, 8000) : "";
      const runLink = typeof body?.runLink === "string" ? body.runLink.slice(0, 500) : undefined;
      if (!operation || !errorClass || !detail) {
        return Response.json(
          { error: "operation, errorClass, and detail are required." },
          { status: 400 }
        );
      }
      const { investigateQAFailure } = await import("./qa/investigate");
      const investigation = await investigateQAFailure(env as any, {
        operation,
        errorClass,
        detail,
        runLink,
      });
      return Response.json({ ok: true, investigation });
    }

    // Issue #164 — VectorMemory browser: semantic search over past outcomes.
    // Also serves as the live-accumulation check: non-empty results prove
    // vectors are landing in the index.
    if (path === "/api/memory/search" && request.method === "POST") {
      // #1754 gate-coverage audit: this route was reachable with NO
      // authentication — only a per-caller throttle stood between an
      // anonymous caller and stored vector-memory outcomes. The only
      // in-app caller (src/client/memoryApi.ts) runs same-origin and
      // already sends the session cookie, so a session gate closes the
      // route without changing any legitimate call path.
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      // Issue #241: vector search is billed per query — throttle per caller.
      // #1768: the bucket key uses the server-verified session login
      // (never the caller header), so distinct users behind one IP
      // keep separate buckets and a fake login mints nothing.
      const limited = createIngressThrottle(request, { verifiedLogin: session.githubLogin })(
        "memory_search",
        60,
        60_000,
      );
      if (limited) return limited;
      const body = (await request.json().catch(() => null)) as {
        query?: unknown;
        topK?: unknown;
        operationFilter?: unknown;
      } | null;
      const query = typeof body?.query === "string" ? body.query.slice(0, 1000) : "";
      const topK = typeof body?.topK === "number" ? body.topK : 10;
      const operationFilter =
        typeof body?.operationFilter === "string" && body.operationFilter
          ? body.operationFilter.slice(0, 120)
          : undefined;
      if (!query) {
        return Response.json({ error: "query is required." }, { status: 400 });
      }
      if (!env.AI || !env.VECTOR_MEMORY) {
        return Response.json({ error: "Vector memory is not configured." }, { status: 503 });
      }
      const { VectorMemory } = await import("./memory/vector-memory");
      const vm = new VectorMemory(env.AI, env.VECTOR_MEMORY, undefined);
      const chunks = await vm.recallForPlan(query, operationFilter, topK);
      // Issue #1740 (Hybrid RAG): additive graph expansion. The
      // dense leg above is unchanged; when AgentDB is bound, the
      // same query gains graph-adjacent market context. Unbound
      // or failed graph means chunks-only, exactly as before.
      let graph: unknown[] = [];
      let graphDegraded = false;
      if ((env as any).AGENT_DB) {
        try {
          const { createMarketGraphAdapter, ensureMarketGraphTables } =
            await import("./retrieval/createRetrievalPorts");
          const { expandGraphContext } = await import(
            "./retrieval/hybridRetrieval"
          );
          const adapter = createMarketGraphAdapter(env as any);
          if (adapter) {
            await ensureMarketGraphTables(adapter);
            const expanded = await expandGraphContext(
              adapter,
              resolveIaaaTenant(env),
              query,
              chunks.map((c) => c.summary),
              { graphTopK: 12 },
            );
            graph = expanded.rows;
            graphDegraded = expanded.degraded;
          }
        } catch (err) {
          console.warn(
            "[retrieval] memory_search graph expansion failed, dense-only:",
            err instanceof Error ? err.message : String(err),
          );
          graphDegraded = true;
        }
      }
      // Issue #1742: consume #1740's retrieval.completed hook —
      // fold this retrieval's counts into the telemetry summary.
      // Best-effort, swallowed: telemetry never fails a search.
      try {
        const { toRetrievalCompletedEnvelope } = await import(
          "./retrieval/hybridRetrieval"
        );
        const { ingestRetrievalCompleted } = await import(
          "./telemetry/retrievalStats"
        );
        ingestRetrievalCompleted(
          toRetrievalCompletedEnvelope({
            denseCount: chunks.length,
            graphCount: graph.length,
            degraded: graphDegraded,
          }),
        );
      } catch (err) {
        console.warn(
          "[telemetry] retrieval.completed ingestion failed (ignored):",
          err instanceof Error ? err.message : String(err),
        );
      }
      return Response.json({ ok: true, chunks, graph, graphDegraded });
    }
    // Slice 5 (#2902): /api/schedule/* moved to src/server/routes/trading.ts —
    // goals, operations, ticks, runs, systems.
    const tradingScheduleResponse = await handleTradingScheduleRoutes(request, env, url, path);
    if (tradingScheduleResponse) return tradingScheduleResponse;

    // #1077 Phase 5b slice 2 — social brief provisioning (human path).
    // Placed before the generic /api/ forwarder. Session-gated,
    // like /api/schedule/* above (gated since #1156):
    // unauthenticated → 401.
    // Any signed-in user may provision; gating provisioning to
    // admins is a later item (the IAAA admin panel could own it).
    // Overwrite semantics: the most recent provision wins for the
    // date. A stored brief is content for the social goal only — it
    // is never auto-posted by this route.
    if (path === "/api/social/brief") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      const briefStore = createSocialBriefStoreFromNamespace(
        (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
      );
      if (!briefStore) {
        return Response.json({ error: "Social brief store unavailable." }, { status: 500 });
      }
      if (request.method === "GET") {
        const rawDate = new URL(request.url).searchParams.get("date");
        const date = rawDate ?? zonedDateParts(Date.now(), "America/New_York").date;
        if (!isBriefDate(date)) {
          return Response.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
        }
        try {
          const brief = await briefStore.getBrief(date);
          return Response.json({ ok: true, date, brief });
        } catch {
          return Response.json({ error: "Social brief store unavailable." }, { status: 500 });
        }
      }
      if (request.method === "POST") {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body) return Response.json({ error: "JSON body required." }, { status: 400 });
        const text = body.text;
        if (typeof text !== "string" || !text.trim()) {
          return Response.json({ error: "text must be a non-empty string." }, { status: 400 });
        }
        if (text.length > SOCIAL_BRIEF_MAX_CHARS) {
          return Response.json(
            { error: `text must be ${SOCIAL_BRIEF_MAX_CHARS} characters or fewer.` },
            { status: 413 },
          );
        }
        const rawDate =
          body.date === undefined ? undefined : typeof body.date === "string" ? body.date : null;
        if (rawDate === null) {
          return Response.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
        }
        const date = rawDate ?? zonedDateParts(Date.now(), "America/New_York").date;
        if (!isBriefDate(date)) {
          return Response.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
        }
        try {
          await briefStore.putBrief(date, text);
        } catch {
          return Response.json({ error: "Social brief store unavailable." }, { status: 500 });
        }
        return Response.json({ ok: true, date });
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // #1077 Phase 5b slice 3 — social approval routes (human path).
    // Placed before the generic /api/ forwarder, next to the brief
    // routes. Session-gated (401 unauthenticated), like the brief
    // routes — never an unauthenticated approve endpoint. Any
    // signed-in user may decide; the workspace trust model is the
    // same as the Slack cards (any workspace member with access).
    // POST /api/social/approval {date, channel, action} approves
    // (publishes promptly through the existing path) or rejects
    // (publishes nothing, record retained). Missing draft → 404;
    // already posted/rejected for the requested decision → 409.
    // GET /api/social/approvals lists pending approvals for a date
    // with draft text, so a reviewer can decide without Slack.
    if (path === "/api/social/approval" || path === "/api/social/approvals") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      const stores = createSocialStoresFromNamespace(
        (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
      );
      if (!stores) {
        return Response.json({ error: "Social stores unavailable." }, { status: 500 });
      }
      if (path === "/api/social/approvals") {
        if (request.method !== "GET") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const rawDate = new URL(request.url).searchParams.get("date");
        const date = rawDate ?? zonedDateParts(Date.now(), "America/New_York").date;
        if (!isBriefDate(date)) {
          return Response.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
        }
        try {
          const pending = await stores.approvals.listPending(date);
          const approvals: unknown[] = [];
          for (const record of pending) {
            const draft = await stores.ledger.getDraft(date, record.channel);
            if (!draft) continue;
            approvals.push({
              date,
              channel: record.channel,
              draftId: record.draftId,
              requestedAtMs: record.requestedAtMs,
              text: draft.text,
              status: draft.status,
            });
          }
          return Response.json({ ok: true, date, approvals });
        } catch {
          return Response.json({ error: "Social stores unavailable." }, { status: 500 });
        }
      }
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return Response.json({ error: "JSON body required." }, { status: 400 });
      const date = body.date;
      const channel = body.channel;
      const action = body.action;
      if (
        typeof date !== "string" ||
        !isBriefDate(date) ||
        typeof channel !== "string" ||
        !(KNOWN_SOCIAL_CHANNELS as readonly string[]).includes(channel) ||
        (action !== "approve" && action !== "reject")
      ) {
        return Response.json(
          { error: "date must be YYYY-MM-DD, channel must be a known social channel, action must be approve or reject." },
          { status: 400 },
        );
      }
      const draft = await stores.ledger.getDraft(date, channel);
      if (!draft) {
        return Response.json({ error: `no draft for ${channel} on ${date}` }, { status: 404 });
      }
      if (draft.status === "posted" || draft.status === "failed") {
        return Response.json(
          { error: `draft for ${channel} on ${date} is already ${draft.status}` },
          { status: 409 },
        );
      }
      const rawEnv = env as unknown as Record<string, string | undefined>;
      const socialEnv = {
        SOCIAL_POSTING_ENABLED: rawEnv.SOCIAL_POSTING_ENABLED,
        SOCIAL_AUTONOMOUS_CHANNELS: rawEnv.SOCIAL_AUTONOMOUS_CHANNELS,
        SOCIAL_APPROVAL_CHANNELS: rawEnv.SOCIAL_APPROVAL_CHANNELS,
        SOCIAL_LIVE_PUBLISHING: rawEnv.SOCIAL_LIVE_PUBLISHING,
      };
      if (action === "reject") {
        const rejected = await rejectSocialDraft({
          store: stores.ledger,
          approvals: stores.approvals,
          date,
          channel,
        });
        if (!rejected.ok) {
          return Response.json({ error: rejected.error }, { status: 409 });
        }
        return Response.json({ ok: true, rejected: true, date, channel });
      }
      if (!parseSocialConfig(socialEnv).postingEnabled) {
        return Response.json({ error: "social posting is not enabled" }, { status: 409 });
      }
      const approver = session.internalUserId ?? session.githubLogin ?? "session-user";
      const approved = await approveAndPublish({
        env: socialEnv,
        tokens: {
          X_ACCESS_TOKEN: rawEnv.X_ACCESS_TOKEN,
          THREADS_ACCESS_TOKEN: rawEnv.THREADS_ACCESS_TOKEN,
          FACEBOOK_PAGE_ACCESS_TOKEN: rawEnv.FACEBOOK_PAGE_ACCESS_TOKEN,
          INSTAGRAM_ACCESS_TOKEN: rawEnv.INSTAGRAM_ACCESS_TOKEN,
          LINKEDIN_ACCESS_TOKEN: rawEnv.LINKEDIN_ACCESS_TOKEN,
          LINKEDIN_AUTHOR_URN: rawEnv.LINKEDIN_AUTHOR_URN,
        },
        store: stores.ledger,
        approvals: stores.approvals,
        transport: createFetchSocialTransport(),
        dryRunSink: createMemoryDryRunSink(),
        nowMs: Date.now(),
        date,
        channel,
        approver,
      });
      if (!approved.ok) {
        return Response.json({ error: approved.error }, { status: 409 });
      }
      return Response.json({
        ok: true,
        approved: true,
        date,
        channel,
        publish: approved.channelResult,
      });
    }

    // Issue #1391: list posts / drafts for date, including submitted platform URLs
    if (path === "/api/social/posts") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      if (request.method !== "GET") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      const stores = createSocialStoresFromNamespace(
        (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
      );
      if (!stores) {
        return Response.json({ error: "Social stores unavailable." }, { status: 500 });
      }
      const rawDate = new URL(request.url).searchParams.get("date");
      const date = rawDate ?? zonedDateParts(Date.now(), "America/New_York").date;
      if (!isBriefDate(date)) {
        return Response.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
      }
      try {
        const drafts = await stores.ledger.listDrafts(date);
        const posts = drafts.map((draft) => ({
          channel: draft.channel,
          draftId: draft.id,
          date: draft.date,
          status: draft.status,
          text: draft.text,
          platformPostId: draft.platformPostId ?? null,
          submissionEndpoint: resolveSubmissionEndpoint(draft.channel),
          postUrl: resolvePostUrl(draft.channel, draft.platformPostId),
          createdAtMs: draft.createdAtMs,
          approval: draft.approval,
        }));
        return Response.json({ ok: true, date, posts });
      } catch {
        return Response.json({ error: "Social stores unavailable." }, { status: 500 });
      }
    }

    // #1077 token-health slice (#1160) — token presence + validity probe.
    // Session-gated (401 unauthenticated), like the brief/approval
    // routes. Any signed-in user may query; no admin gate invented.
    // GET only; 405 other methods. The response is status only:
    // configured/unconfigured + valid/invalid/unknown per channel,
    // never a token value. No live transport is wired in this slice,
    // so validity is unknown by design until activation wiring passes
    // one — never assumed valid. The goal executor does NOT call this.
    if (path === "/api/social/token-health") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      if (request.method !== "GET") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      const rawEnv = env as unknown as Record<string, string | undefined>;
      const channels = await checkAllTokenHealth({
        X_ACCESS_TOKEN: rawEnv.X_ACCESS_TOKEN,
        THREADS_ACCESS_TOKEN: rawEnv.THREADS_ACCESS_TOKEN,
        FACEBOOK_PAGE_ACCESS_TOKEN: rawEnv.FACEBOOK_PAGE_ACCESS_TOKEN,
        INSTAGRAM_ACCESS_TOKEN: rawEnv.INSTAGRAM_ACCESS_TOKEN,
        LINKEDIN_ACCESS_TOKEN: rawEnv.LINKEDIN_ACCESS_TOKEN,
        LINKEDIN_AUTHOR_URN: rawEnv.LINKEDIN_AUTHOR_URN,
      });
      return Response.json({ ok: true, channels });
    }
    // Slice 3 (#2902): /api/me, /api/user/email-destination,
    // /api/iaaa/overview, /api/governance/seed-halt moved to src/server/routes/auth.ts.
    const authMeResponse = await handleAuthMeRoutes(request, env, url, path);
    if (authMeResponse) return authMeResponse;
    // Slice 4 (#2902): chains/jobs/traces/registry/catalog/reconcile/retention
    // moved to src/server/routes/privacy.ts — /api/chains/*, /api/jobs/*,
    // /api/traces, /api/agents/registry, /api/products/catalog, /api/retention/purge.
    const privacyChainsResponse = await handlePrivacyChainsRoutes(request, env, url, path);
    if (privacyChainsResponse) return privacyChainsResponse;

    // --- Telemetry & calibration (issue #1742) ---
    // GET /api/telemetry/summary: any signed-in user; D1 metrics
    // (all five dimensions) + active calibrated notes + live
    // breaker health (#1745 registry snapshots) + retrieval
    // stats (folded #1740 retrieval.completed envelopes).
    // GET /api/telemetry/decisions: any signed-in user.
    // POST /api/telemetry/decisions/:id/decide|apply|supersede|expire:
    // platform-admin only (IAAA admin pattern, same as the
    // reconcile routes). POST /api/telemetry/reconcile:
    // platform-admin only; imports scored track-record ideas
    // for one research:<login> instance (default: the admin's
    // login; ?userLogin= overrides), bounded 500/call, repeat
    // calls converge. Never auto-run: no boot, deploy, or tick
    // path calls these. Reads pass a null store through to the
    // handler (401/503 there); governance paths check the
    // binding first, like the reconcile routes.
    if (
      path === "/api/telemetry/summary" ||
      path === "/api/telemetry/decisions" ||
      path === "/api/telemetry/reconcile" ||
      /^\/api\/telemetry\/decisions\/[^/]+\/(decide|apply|supersede|expire)$/.test(path)
    ) {
      const session = await requireAuth(request, env);
      const tenantId = resolveIaaaTenant(env);
      const store = createTelemetryAdapter(env as any);
      if (path === "/api/telemetry/summary") {
        if (store) await ensureTelemetryTables(store);
        // Issue #1888: enrichment quality feeds the telemetry
        // summary. Best-effort read of the session user's
        // orchestrator DO enrichment status (the DO owns the run
        // records); any failure leaves the field absent and never
        // fails the summary.
        let enrichmentQuality: import("./enrichment/enrichmentPorts").EnrichmentQualitySummary | null = null;
        if (session?.githubLogin) {
          try {
            // Issue #1759 (alias-forever cutover, executed): the
            // SearchAgent instance lives under the login the user
            // had when its state was created. A renamed wired user
            // resolves through the alias to that login; everyone
            // else resolves to their current login (unchanged).
            // Any alias-store failure falls back to the current
            // login — enrichment is best-effort and must never fail
            // the summary. The header carries the resolved login so
            // the instance and the identity it scopes by agree.
            let doLogin = session.githubLogin;
            if (session.internalUserId) {
              try {
                const resolved = await resolveDoNameForUser(sessionStore(env), {
                  currentLogin: session.githubLogin,
                  internalUserId: session.internalUserId,
                });
                doLogin = resolved.login;
              } catch {
                doLogin = session.githubLogin;
              }
            }
            const targetUrl = new URL("/enrichment/status", "https://agent.internal");
            const freq = new Request(targetUrl, {
              headers: { "x-user-login": doLogin },
              signal: AbortSignal.timeout(3000),
            });
            const fres = await actorGateway.dispatch(env.SEARCH_AGENT, doLogin, freq);
            if (fres.ok) {
              const data = (await fres.json().catch(() => null)) as {
                quality?: import("./enrichment/enrichmentPorts").EnrichmentQualitySummary;
              } | null;
              enrichmentQuality = data?.quality ?? null;
            }
          } catch {
            enrichmentQuality = null;
          }
        }
        return handleTelemetrySummaryRoute({
          session,
          method: request.method,
          tenantId,
          store,
          breakerSnapshots: () => defaultBreakerRegistry().snapshots(),
          retrievalStats: () => retrievalStatsSnapshot(),
          gatewayStats: () => gatewayStatsSnapshot(),
          enrichmentStats: enrichmentQuality ? () => enrichmentQuality : undefined,
        });
      }
      if (path === "/api/telemetry/decisions") {
        if (store) await ensureTelemetryTables(store);
        return handleTelemetryDecisionsRoute({
          session,
          method: request.method,
          tenantId,
          store,
          status: url.searchParams.get("status") ?? undefined,
          actorKey: url.searchParams.get("actorKey") ?? undefined,
          promptKey: url.searchParams.get("promptKey") ?? undefined,
        });
      }
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
          return Response.json({ error: "Telemetry operation unavailable." }, { status: 500 });
        }
      }
      if (!store) {
        return Response.json(
          { error: "Telemetry unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      await ensureTelemetryTables(store);
      if (path === "/api/telemetry/reconcile") {
        const userLogin =
          url.searchParams.get("userLogin") ?? session?.githubLogin ?? "default";
        const researchNs = (env as any).RESEARCH_AGENT as ActorNamespaceLike | undefined;
        return handleTelemetryReconcileRoute({
          session,
          method: request.method,
          isPlatformAdmin,
          tenantId,
          store,
          userLogin,
          loadTrackRecord: async () => {
            if (!researchNs) {
              throw new Error("ResearchAgent binding not configured.");
            }
            const agent = actorGateway.stub<{
              getTrackRecord(): Promise<{ ideas: unknown[] }>;
            }>(researchNs, `research:${userLogin}`);
            const record = await agent.getTrackRecord();
            return { ideas: record.ideas as unknown as TrackRecordIdeaInput[] };
          },
        });
      }
      const match = path.match(
        /^\/api\/telemetry\/decisions\/([^/]+)\/(decide|apply|supersede|expire)$/,
      );
      const decisionId = match ? decodeURIComponent(match[1]) : "";
      const action = (match ? match[2] : "decide") as
        | "decide"
        | "apply"
        | "supersede"
        | "expire";
      let verdict: string | undefined;
      if (action === "decide") {
        const body = (await request.json().catch(() => null)) as {
          verdict?: unknown;
        } | null;
        verdict = typeof body?.verdict === "string" ? body.verdict : undefined;
      }
      return handleTelemetryDecisionActionRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId,
        store,
        decisionId,
        action,
        verdict,
        // Issue #1743 — calibration envelopes flow to the stream
        // (calibration_applied on apply); best-effort by engine.
        emit: (envelope) => {
          void writeEnvelopeToSink(
            createObservabilitySink(env),
            envelope,
          );
        },
      });
    }
    // Slice 4 (#2902): audit/reports moved to src/server/routes/privacy.ts —
    // /api/audit/history, /api/reports/list, /api/reports/seed-canonical.
    const privacyReportsResponse = await handlePrivacyReportsRoutes(request, env, url, path);
    if (privacyReportsResponse) return privacyReportsResponse;

    // --- Market graph population (issue #1740, Hybrid RAG) ---
    // POST /api/retrieval/populate-market-graph: the deliberate
    // operator invocation point for seeding the D1 market
    // adjacency graph from the curated stock universe. Gating
    // reuses the IAAA admin pattern exactly (requireAuth →
    // wired session → live platform-admin membership,
    // fail-closed, no data on 403). Never auto-run: no boot,
    // deploy, or tick path calls it. Population runs in the
    // Worker (it reads the static universe and writes D1 via
    // the Worker's own AGENT_DB binding — no DO hop needed) and
    // is idempotent: a second run refreshes labels/weights and
    // reports the same counts. Unbound AgentDB → 503.
    if (path === "/api/retrieval/populate-market-graph") {
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
          return Response.json({ error: "Market graph population unavailable." }, { status: 500 });
        }
      }
      const { handlePopulateMarketGraphRoute } = await import(
        "./retrieval/populateMarketGraphRoute"
      );
      const { createMarketGraphAdapter, ensureMarketGraphTables } =
        await import("./retrieval/createRetrievalPorts");
      const { populateFromCuratedUniverse } = await import(
        "./retrieval/marketGraphPopulation"
      );
      const adapter = createMarketGraphAdapter(env as any);
      if (!adapter) {
        return Response.json(
          { error: "Market graph population unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      return handlePopulateMarketGraphRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId: resolveIaaaTenant(env),
        runPopulate: async ({ tenantId }) => {
          await ensureMarketGraphTables(adapter);
          return populateFromCuratedUniverse(adapter, tenantId, Date.now());
        },
      });
    }
    // Slice 3 (#2902): IAAA lifecycle moved to src/server/routes/auth.ts —
    // /api/iaaa/access-request*, membership/permission/role-grant/
    // logged-in-users/quota/policy/bootstrap lifecycle, /api/api-keys.
    const authIaaaResponse = await handleAuthIaaaRoutes(request, env, url, path);
    if (authIaaaResponse) return authIaaaResponse;

    // --- Model Context Protocol (MCP) JSON-RPC 2.0 & Discovery Endpoint ---
    // Issue #180: transport identity is the app session OR a per-user API
    // key (Authorization: Bearer cfk_…, see src/security/apiKeys.ts) bound
    // to the login that minted it. The caller-asserted `x-user-id` header
    // no longer asserts anything — it previously SELECTED the agent DO
    // instance, so asserting a victim's login ran the full tool registry
    // inside their instance, and anonymous callers shared an "mcp_client"
    // instance. No credential → 401 before any DO access. The in-app
    // explorer (McpApiExplorer) rides the session cookie and is unchanged.
    if (path === "/mcp" || path === "/api/mcp") {
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      };
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }

      const session = await requireAuth(request, env);
      let userLogin = session?.githubLogin;
      if (!userLogin) {
        const verified = await verifyApiKey(env, bearerKeyFromRequest(request));
        userLogin = verified?.login;
      }
      if (!userLogin) {
        return Response.json(
          { error: "Unauthorized: an app session or a valid API key is required." },
          { status: 401, headers: corsHeaders }
        );
      }
      const targetUrl = new URL("/mcp" + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      // #1744: principal kind for the MCP permission gate — the DO
      // cannot tell session from API-key auth from the login alone.
      forwardReq.headers.set("x-principal-kind", session ? "session" : "api-key");

      const resp = await actorGateway.dispatch(env.SEARCH_AGENT, userLogin, forwardReq);
      const headers = new Headers(resp.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return new Response(resp.body, { status: resp.status, headers });
    }

    // --- Cloudflare Wallets / x402 Pay-Per-Use Options Scanner MCP Endpoint ---
    // No session auth required — payment IS the access control (x402 paidTool).
    // MCP clients connect to /mcp/scanner and pay $0.05 USDC via Cloudflare Wallets.
    if (path === "/mcp/scanner" || path.startsWith("/mcp/scanner/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type, Authorization, PAYMENT-SIGNATURE, PAYMENT-REQUIRED",
            "Access-Control-Expose-Headers":
              "PAYMENT-REQUIRED, PAYMENT-RESPONSE, Payment-Receipt",
          },
        });
      }

      // Session AFFINITY, not identity (issue #700): this value only
      // picks which OptionsScannerMCP instance serves the client, so a
      // client's queued scans stay on one instance. No identity
      // propagates downstream on this route — the scanner DO never reads
      // either header and forwards under its own context — so a
      // login-shaped value asserts nothing (contrast the #154/#180/#183
      // routes, where the established identity selects the caller's own
      // agent instance). The honest header is `x-scanner-session`;
      // `x-user-id` is a DEPRECATED alias retained only for instance
      // continuity: dropping it would strand in-flight clients on a
      // different instance and orphan their queued scan jobs. With
      // neither header, traffic shares the "public_scanner" instance.
      const scannerAffinityId =
        request.headers.get("x-scanner-session") ||
        request.headers.get("x-user-id") ||
        "public_scanner";
      const scannerUrl = new URL(
        path.replace("/mcp/scanner", "") || "/" + url.search,
        "https://scanner.internal",
      );

      const resp = await actorGateway.dispatch(
        (env as any).OPTIONS_SCANNER_MCP,
        scannerAffinityId,
        new Request(scannerUrl, request),
      );
      const headers = new Headers(resp.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, PAYMENT-SIGNATURE");
      headers.set("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
      return new Response(resp.body, { status: resp.status, headers });
    }

    // --- Cloudflare Agentic Payments: CORS preflight (premium + wallet families) ---
    // Issue #2787: the commercial family answers its bare spelling too
    // (/payments/agentic/commercial/*), so its preflight is aliased here
    // exactly like its dispatch below.
    if ((path.startsWith("/api/premium/") || path.startsWith("/api/payments/agentic/") || path.startsWith("/payments/agentic/commercial/")) && request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, x-environment",
          "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, WWW-Authenticate, PAYMENT-RESPONSE, Payment-Receipt",
        },
      });
    }

    // --- Agentic Wallet API (/api/payments/agentic/*) ---
    // Issue #2787: the commercial family also answers its bare spelling
    // (/payments/agentic/commercial/*) — same handler, same session gate,
    // same instance routing, same forwarding. The /api spelling stays
    // canonical (every in-app client uses it); the bare spelling is an
    // alias, not a second route: subPath below strips /api when present
    // and passes bare paths through unchanged, so both spellings forward
    // identically to the handlers (which match endsWith). Precedent: the
    // webhook below accepts both /api/payments/webhook and
    // /payments/webhook. Only the commercial family is aliased — other
    // /payments/agentic/* paths keep the /api-only gate.
    // Issue #183: a session is REQUIRED for the wallet family (the #154
    // pattern) — the wallet and its HITL auto-approve limit are the
    // signed-in user's own state. Previously a null session fell back
    // to the caller-supplied x-user-id header or a shared
    // "agentic_consumer" instance, so an unauthenticated caller could
    // read and mutate a shared wallet (and select any user's instance
    // by asserting their login). The fallback identities are removed;
    // the only in-app caller (AgenticWalletPanel) is signed in.
    if (path.startsWith("/api/payments/agentic/") || path.startsWith("/payments/agentic/commercial/")) {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);

      const resp = await actorGateway.dispatch(env.SEARCH_AGENT, userLogin, forwardReq);
      const headers = new Headers(resp.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, x-environment");
      headers.set("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, WWW-Authenticate, PAYMENT-RESPONSE, Payment-Receipt");
      return new Response(resp.body, { status: resp.status, headers });
    }

    // --- Premium Paid Endpoints (/api/premium/*) ---
    // Issue #183: payment (x402) is the access control for premium
    // endpoints, so anonymous paid access stays — but identity is never
    // asserted. With a session, traffic runs under the session login,
    // exactly as before. Without one, caller-supplied identity headers
    // are stripped and the request is served by the dedicated
    // PREMIUM_GATEWAY instance (nobody's user instance — the instance
    // name itself is the downstream signal that this is anonymous
    // traffic); the premium handlers bind every persisted payment row
    // and the fulfillment identity to the VERIFIED payer instead.
    // Previously an asserted x-user-id selected ANY user's instance
    // and premium fulfillment ran under that asserted login.
    if (path.startsWith("/api/premium/")) {
      const session = await requireAuth(request, env);
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      let instanceName;
      if (session) {
        forwardReq.headers.set("x-user-login", session.githubLogin);
        instanceName = session.githubLogin;
      } else {
        forwardReq.headers.delete("x-user-login");
        forwardReq.headers.delete("x-user-id");
        instanceName = PREMIUM_GATEWAY_INSTANCE;
      }

      const resp = await actorGateway.dispatch(env.SEARCH_AGENT, instanceName, forwardReq);
      const headers = new Headers(resp.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, x-environment");
      headers.set("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, WWW-Authenticate, PAYMENT-RESPONSE, Payment-Receipt");
      return new Response(resp.body, { status: resp.status, headers });
    }

    // --- External Payment Webhook Listeners (Stripe, PayPal, Lemon Squeezy) ---
    if (path.startsWith("/api/payments/webhook") || path === "/payments/webhook") {
      const targetUrl = new URL("/payments/webhook" + url.search, "https://agent.internal");
      return actorGateway.dispatch(env.SEARCH_AGENT, "system_webhook_receiver", new Request(targetUrl, request));
    }
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

    // --- Cloudflare Browser Agent: Webhook Snapshot API ---
    if ((path === "/api/browser/snapshot" || path === "/browser/snapshot") && request.method === "POST") {
      // Issue #181: snapshots dispatch Slack posts — require a valid app session.
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      try {
        const body = (await request.json()) as any;
        const targetUrl = body.url || "https://etrade.com";
        const browserService = new ETradeBrowserService(env);
        const snapResult = await browserService.captureAndSendToSlack(targetUrl, {
          webhookUrl: body.webhookUrl || env.SLACK_WEBHOOK_URL,
          caption: body.caption,
          channel: body.channel,
        });
        return Response.json(snapResult);
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    // --- Cloudflare Browser Agent: Transaction Snap to Slack via Webhook API ---
    if ((path === "/api/browser/transaction-snap" || path === "/browser/transaction-snap" || path === "/api/browser/snap/transaction") && request.method === "POST") {
      // Issue #181: see above — require a valid app session.
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const tx: TransactionSnapData = body.transaction || body;
        if (!tx || !tx.symbol) {
          return Response.json({ error: "Transaction data with symbol is required." }, { status: 400 });
        }
        // #1733 (R06): the identity fallback chain lives in the
        // port helper — no behavior change. Session conditions:
        // requireAuth above already 401'd without a valid app
        // session, and a missing tx.symbol already 400'd, so the
        // header or tx.symbol always wins on the reachable path
        // and the "browser_trader" literal is a defensive default
        // only. The DO route has no fallback (one shared block).
        const userLogin = resolveSnapIdentity(request.headers.get("x-user-login"), tx.symbol);
        const targetUrl = new URL("/trading/browser/transaction-snap", "https://agent.internal");
        const forwardReq = new Request(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-user-login": userLogin },
          body: JSON.stringify(body),
        });
        return actorGateway.dispatch(env.SEARCH_AGENT, userLogin, forwardReq);
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    // --- Omnichannel Trading Agent: Slack Slash Commands (/snap, /trade, /quote, /screen, etc.) ---
    if ((path === "/slack/commands" || path === "/slack/slash") && request.method === "POST") {
      // Issue #147: signature verification is mandatory — unconfigured
      // is a loud 503, never a silent pass-through (see gateSlackRequest).
      const gate = await gateSlackRequest(request, env.SLACK_SIGNING_SECRET);
      if (!gate.ok) return gate.response;
      const rawBody = gate.rawBody;

      const params = new URLSearchParams(rawBody);
      const teamId = params.get("team_id") || "default_workspace";
      const targetUrl = new URL("/trading/slack/command", "https://agent.internal");
      const forwardReq = new Request(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: rawBody,
      });
      return actorGateway.dispatch(env.SEARCH_AGENT, `slack_${teamId}`, forwardReq);
    }

    // --- Omnichannel Trading Agent: Slack Events Webhook ---
    if ((path === "/slack" || path === "/slack/events") && request.method === "POST") {
      // Issue #147: signature verification is mandatory — unconfigured
      // is a loud 503, never a silent pass-through (see gateSlackRequest).
      const gate = await gateSlackRequest(request, env.SLACK_SIGNING_SECRET);
      if (!gate.ok) return gate.response;
      const rawBody = gate.rawBody;

      let parsed: any;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (parsed.type === "url_verification") {
        return Response.json({ challenge: parsed.challenge });
      }

      // Multi-tenant: Route to workspace DO or fallback receiver
      const teamId = parsed.team_id || "default_workspace";
      const targetUrl = new URL("/trading/slack/event", "https://agent.internal");
      const forwardReq = new Request(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawBody,
      });
      return actorGateway.dispatch(env.SEARCH_AGENT, `slack_${teamId}`, forwardReq);
    }

    // --- Omnichannel Trading Agent: Slack Interactive Component Actions ---
    if (path === "/slack/interactions" && request.method === "POST") {
      // Issue #147: signature verification is mandatory — unconfigured
      // is a loud 503, never a silent pass-through (see gateSlackRequest).
      const gate = await gateSlackRequest(request, env.SLACK_SIGNING_SECRET);
      if (!gate.ok) return gate.response;
      const rawBody = gate.rawBody;

      const params = new URLSearchParams(rawBody);
      const payloadRaw = params.get("payload");
      if (!payloadRaw) {
        return new Response("Missing payload", { status: 400 });
      }

      let payload: any;
      try {
        payload = JSON.parse(payloadRaw);
      } catch {
        return new Response("Invalid payload JSON", { status: 400 });
      }

      // #1077 Phase 5b slice 3: social approval cards are answered
      // here, AFTER the #147 gate above and BEFORE the trading
      // forward. A social action_id (social_approve/social_reject)
      // never reaches trading; any other action_id falls through to
      // trading exactly as before. The handler verifies the card's
      // draftId against the pending record, so a stale card cannot
      // approve a rebuilt draft. Production passes no live transport
      // (the Phase 5a gap): live publish-on-approve fails honestly
      // here exactly as the goal path does; dry-run works end to end.
      const socialParsed = parseSocialAction(payload);
      if (socialParsed.kind !== "other") {
        const socialStores = createSocialStoresFromNamespace(
          (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
        );
        if (!socialStores) {
          return new Response("Social stores unavailable", { status: 500 });
        }
        const rawEnv = env as unknown as Record<string, string | undefined>;
        // Issue #1262 Phase 2 (social convergence): a social APPROVE
        // requires a resolved principal — the clicker's Slack identity
        // linked to a trading login (Phase 1 link store). Unlinked
        // clickers get a refusal with a link hint; REJECT stays open
        // to any clicker (fail-safe: rejecting only prevents
        // publication). The handler stamps the resolved login as the
        // approver when one exists, else the legacy slack:<userId>.
        const clickerPrincipal = await resolvePrincipal(
          env,
          {
            channel: "slack",
            channelUserId: payload.user?.id ?? "",
            channelScopeId: payload.team?.id ?? "",
            text: "",
          },
          { slackLinks: slackPrincipalLinkStoreFromEnv(env) }
        );
        const outcome = await handleSocialSlackInteraction({
          payload,
          principal: clickerPrincipal,
          env: {
            SOCIAL_POSTING_ENABLED: rawEnv.SOCIAL_POSTING_ENABLED,
            SOCIAL_AUTONOMOUS_CHANNELS: rawEnv.SOCIAL_AUTONOMOUS_CHANNELS,
            SOCIAL_APPROVAL_CHANNELS: rawEnv.SOCIAL_APPROVAL_CHANNELS,
            SOCIAL_LIVE_PUBLISHING: rawEnv.SOCIAL_LIVE_PUBLISHING,
          },
          tokens: {
            X_ACCESS_TOKEN: rawEnv.X_ACCESS_TOKEN,
            THREADS_ACCESS_TOKEN: rawEnv.THREADS_ACCESS_TOKEN,
            FACEBOOK_PAGE_ACCESS_TOKEN: rawEnv.FACEBOOK_PAGE_ACCESS_TOKEN,
            INSTAGRAM_ACCESS_TOKEN: rawEnv.INSTAGRAM_ACCESS_TOKEN,
            LINKEDIN_ACCESS_TOKEN: rawEnv.LINKEDIN_ACCESS_TOKEN,
            LINKEDIN_AUTHOR_URN: rawEnv.LINKEDIN_AUTHOR_URN,
          },
          store: socialStores.ledger,
          approvals: socialStores.approvals,
          transport: undefined,
          dryRunSink: createMemoryDryRunSink(),
          nowMs: Date.now(),
        });
        if (outcome.handled) {
          return Response.json({
            response_type: "in_channel",
            replace_original: true,
            text: outcome.message,
            blocks: outcome.blocks,
          });
        }
      }

      const teamId = payload.team?.id || "default_workspace";
      const targetUrl = new URL("/trading/slack/interaction", "https://agent.internal");
      const forwardReq = new Request(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return actorGateway.dispatch(env.SEARCH_AGENT, `slack_${teamId}`, forwardReq);
    }

    // --- Omnichannel Trading Agent: Slack OAuth Install & Callback ---
    if (path === "/slack/install") {
      const clientId = env.SLACK_CLIENT_ID;
      if (!clientId) {
        return new Response("SLACK_CLIENT_ID is not configured in environment.", { status: 500 });
      }
      const redirectUri = `${env.APP_BASE_URL || "https://agent.openaimp.com"}/slack/oauth_callback`;
      const installUrl = ETradeSlackTradingService.getInstallUrl(clientId, redirectUri);
      return Response.redirect(installUrl, 302);
    }

    if (path === "/slack/oauth_callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return Response.redirect("/?tab=trading&error=missing_slack_code", 302);
      }
      const clientId = env.SLACK_CLIENT_ID || "";
      const clientSecret = env.SLACK_CLIENT_SECRET || "";
      const redirectUri = `${env.APP_BASE_URL || "https://agent.openaimp.com"}/slack/oauth_callback`;
      try {
        const tokens = await ETradeSlackTradingService.exchangeOAuthCode(code, clientId, clientSecret, redirectUri);
        // Issue #329: the team token used to be written to KV under
        // `slack_token_{teamId}`, but nothing in the Worker ever read it back —
        // pure write-quota spend. Posting goes through the Slack service itself.
        return Response.redirect(`/?tab=trading&slack=connected&team=${encodeURIComponent(tokens.teamName)}`, 302);
      } catch (err: any) {
        return Response.redirect(`/?tab=trading&error=${encodeURIComponent(err.message || "slack_oauth_failed")}`, 302);
      }
    }
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

/**
 * Issue #183: the dedicated Durable Object instance that serves
 * ANONYMOUS premium (x402-paid) traffic. It is deliberately not any
 * user's instance name: the premium handlers recognise anonymous
 * traffic by the absence of an x-user-login header (the worker sets
 * that header only from a verified session) and bind all persisted
 * payment state to the verified payer instead of the instance.
 */
export const PREMIUM_GATEWAY_INSTANCE = "premium-gateway";

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


