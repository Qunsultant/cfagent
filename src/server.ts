import type { Env } from "./types";

import { csrfGateResult } from "./security/csrf";

import { actorGateway } from "./services/cloudflareActorGateway";
import { withRequestObservability } from "./observability/aspects";

import { serveStaticAsset } from "./security/staticAssets";
import { withErrorBoundary } from "./security/workerErrorBoundary";

import { TICKER_INSTANCE_NAME } from "./agents/ticker-agent";

import { handleCloudflareEmailMessage } from "./trading";

import {
  checkPublicRestThrottle,
  createIngressThrottle
} from "./api/ingress";

import { dispatchWsUpgrade } from "./api/wsRoutes";
import {
  levelsForApiIngressMode,
  resolveApiIngressMode,
} from "./config/apiIngressModes";

import { handleVoiceWebSocketConnection, createOrchestratorVoiceTurnForwarder } from "./trading";

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

import { requireAuth } from "./server/auth";
import { handleCoreEarlyRoutes, handleCoreLateRoutes, ensureBreakerDurability } from "./server/routes/core";
import { handleAuthMeRoutes, handleAuthIaaaRoutes } from "./server/routes/auth";
import { handlePrivacyRoutes, handlePrivacyChainsRoutes, handlePrivacyReportsRoutes } from "./server/routes/privacy";
import { handleTradingScheduleRoutes, handleTradingOmniRoutes, handleTradingQuotesRoutes, handleTradingApproveRoutes } from "./server/routes/trading";
import { handleMessagingSagaRoutes, handleMessagingSocialRoutes, handleMessagingSlackRoutes } from "./server/routes/messaging";
import { handlePlatformTelemetryRoutes, handlePlatformRetrievalRoutes, handlePlatformMcpRoutes, handlePlatformPaymentsRoutes, handlePlatformBrowserRoutes } from "./server/routes/platform";
import { handleScheduledEvent, handleQueueBatch } from "./server/routes/queue";
import { createStructuredLogger } from "./observability/structuredLogger";
import { createObservabilitySink } from "./observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "server",
});
// Slice 9 (#2902): the agent/DO/workflow exports live in
// src/server/exports.ts (per-class justifications there); server.ts
// re-exports them because wrangler requires every bound DO class to
// be exported from the entrypoint (Q3, contract §8.3).
export { OrchestratorAgent } from "./server/exports";
export { TickerAgent, TICKER_INSTANCE_NAME } from "./server/exports";
export { OptionsScannerMCP } from "./server/exports";
export { BrowserAgent } from "./server/exports";
export { SlackAgent } from "./server/exports";
export { AiSearchAgent } from "./server/exports";
export { SandboxAgent } from "./server/exports";
export { PaymentsAgent } from "./server/exports";
export { ScheduledAgent } from "./server/exports";
export { ScreenerAgent } from "./server/exports";
export { ResearchAgent } from "./server/exports";
export { TradingAgent } from "./server/exports";
export { TradingTradeWorkflow } from "./server/exports";
export { ScreenerScreenWorkflow } from "./server/exports";
export { PaymentWorkflow } from "./server/exports";
export { CrossDomainSagaWorkflow } from "./server/exports";
export { JobPipelineWorkflow } from "./server/exports";
export { ReportAssetAgent } from "./server/exports";
export { SessionStore } from "./server/exports";
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
        handleVoiceWebSocketConnection(serverWs, env, undefined, userLogin, forwardVoiceTurn).catch((err: unknown) =>
          structuredLog.warn("voice.connection_failed", {
            message: "Voice WebSocket connection failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        );

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
    // (ORCHESTRATOR_AGENT), /checkout/sandbox, / + /index.html, static fallback.
    // The late handler is the dispatcher terminus: it always returns (its
    // last statement is the original static-asset fallback), so its result
    // is returned directly, exactly as the inline tail did.
    return handleCoreLateRoutes(request, env, url, path);
}

export { PREMIUM_GATEWAY_INSTANCE } from "./server/exports";
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


