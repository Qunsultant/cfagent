/**
 * Platform & commerce branches for the Worker entry (src/server.ts).
 *
 * Slice 7 of Qunsultant/cfagent#2902 — moves only. Each handler below is a
 * verbatim block moved out of handleFetch, in its original position in the
 * dispatch chain; it returns null when no branch matches so handleFetch
 * falls through to the next delegation exactly as the inline chain did.
 * Branch lines keep their original indentation on purpose: re-indenting
 * would shift lines inside template literals and change response bytes.
 *
 * Handler signatures take the handleFetch locals the branches used
 * (request, env, url, path); shared auth comes from ../auth. The
 * telemetry handler's enrichment-quality read uses the inline
 * import("./enrichment/enrichmentPorts") type reference, rewritten to
 * the routes/ relative path by the extractor.
 */

import { sessionStore, wiredMembershipStore } from "../../security/session";
import type { ActorNamespaceLike } from "../../services/actorGatewayPorts";
import { createWiredAuditStore } from "../../security/iaaaAuditStore";
import { buildAdminOverview } from "../../security/iaaaAdminOverview";
import { actorGateway } from "../../services/cloudflareActorGateway";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { writeEnvelopeToSink } from "../../observability/observabilityPorts";
import { handleTelemetryDecisionActionRoute, handleTelemetryDecisionsRoute, handleTelemetryReconcileRoute, handleTelemetrySummaryRoute } from "../../telemetry/telemetryRoute";
import type { TrackRecordIdeaInput } from "../../telemetry/telemetryProjection";
import { createTelemetryAdapter, ensureTelemetryTables } from "../../telemetry/createTelemetryPorts";
import { defaultBreakerRegistry } from "../../breakers/createBreakerPorts";
import { gatewayStatsSnapshot } from "../../gateway/createGatewayPorts";
import { retrievalStatsSnapshot } from "../../telemetry/retrievalStats";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { resolveDoNameForUser } from "../../security/iaaaMigration";
import { requireAuth } from "../auth";
import type { Env, TransactionSnapData } from "../../types";
import { bearerKeyFromRequest, verifyApiKey } from "../../security/apiKeys";
import { ETradeBrowserService } from "../../services/browserAgent";
import { resolveSnapIdentity } from "../../config/restTwinsModes";

import { COMMERCIAL_BARE_PREFIX, PAYMENTS_API_PREFIX } from "../../data/commercialUrlCatalog";
/**
 * Slice 7 of Qunsultant/cfagent#2902 (Platform & commerce) — moves only.
 * Moved with the premium handler in handlePlatformPaymentsRoutes below
 * (its only use in the entry); re-exported from src/server.ts so the
 * existing `import { PREMIUM_GATEWAY_INSTANCE } from "../src/server"`
 * in tests/agentic_payments_identity_binding.test.ts keeps working.
 * Verbatim from src/server.ts.
 */
/**
 * Issue #183: the dedicated Durable Object instance that serves
 * ANONYMOUS premium (x402-paid) traffic. It is deliberately not any
 * user's instance name: the premium handlers recognise anonymous
 * traffic by the absence of an x-user-login header (the worker sets
 * that header only from a verified session) and bind all persisted
 * payment state to the verified payer instead of the instance.
 */
export const PREMIUM_GATEWAY_INSTANCE = "premium-gateway";

/**
 * Slice 7 of Qunsultant/cfagent#2902 (Platform & commerce) — moves only.
 * The telemetry & calibration family of handleFetch, verbatim and in
 * original order: /api/telemetry/summary, /api/telemetry/decisions,
 * /api/telemetry/reconcile, and
 * /api/telemetry/decisions/:id/(decide|apply|supersede|expire). Returns
 * null when no branch matches, so handleFetch falls through to the next
 * delegation exactly as the inline chain did.
 */
export async function handlePlatformTelemetryRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
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
        let enrichmentQuality: import("../../enrichment/enrichmentPorts").EnrichmentQualitySummary | null = null;
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
            const fres = await actorGateway.dispatch(env.ORCHESTRATOR_AGENT, doLogin, freq);
            if (fres.ok) {
              const data = (await fres.json().catch(() => null)) as {
                quality?: import("../../enrichment/enrichmentPorts").EnrichmentQualitySummary;
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
  return null;
}

/**
 * Slice 7 of Qunsultant/cfagent#2902 (Platform & commerce) — moves only.
 * The market-graph population route of handleFetch, verbatim:
 * POST /api/retrieval/populate-market-graph. Returns null when no
 * branch matches, so handleFetch falls through to the next delegation
 * exactly as the inline chain did.
 */
export async function handlePlatformRetrievalRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
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
      const { handlePopulateMarketGraphRoute } = await import("../../retrieval/populateMarketGraphRoute");
      const { createMarketGraphAdapter, ensureMarketGraphTables } =
        await import("../../retrieval/createRetrievalPorts");
      const { populateFromCuratedUniverse } = await import("../../retrieval/marketGraphPopulation");
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
  return null;
}

/**
 * Slice 7 of Qunsultant/cfagent#2902 (Platform & commerce) — moves only.
 * The MCP family of handleFetch, verbatim and in original order: /mcp
 * and /api/mcp (JSON-RPC 2.0 & discovery), /mcp/scanner and
 * /mcp/scanner/* (x402 pay-per-use options scanner). Returns null when
 * no branch matches, so handleFetch falls through to the next
 * delegation exactly as the inline chain did.
 */
export async function handlePlatformMcpRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
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

      const resp = await actorGateway.dispatch(env.ORCHESTRATOR_AGENT, userLogin, forwardReq);
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
      // continuity (superseded by `x-scanner-session`); dropping it would strand in-flight clients on a
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
  return null;
}

/**
 * Slice 7 of Qunsultant/cfagent#2902 (Platform & commerce) — moves only.
 * The payments family of handleFetch, verbatim and in original order:
 * the OPTIONS preflight for /api/premium/, /api/payments/agentic/ and
 * /payments/agentic/commercial/, the agentic wallet API
 * (/api/payments/agentic/* plus the /payments/agentic/commercial/*
 * alias), the premium paid endpoints (/api/premium/*), and the
 * external payment webhook listeners (/api/payments/webhook and
 * /payments/webhook). Returns null when no branch matches, so
 * handleFetch falls through to the next delegation exactly as the
 * inline chain did. PREMIUM_GATEWAY_INSTANCE (the dedicated DO
 * instance for anonymous x402-paid premium traffic) moves with this
 * handler: it is defined below and re-exported from src/server.ts so
 * existing imports keep working.
 */
export async function handlePlatformPaymentsRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
    // --- Cloudflare Agentic Payments: CORS preflight (premium + wallet families) ---
    // Issue #2787: the commercial family answers its bare spelling too
    // (/payments/agentic/commercial/*), so its preflight is aliased here
    // exactly like its dispatch below.
    if ((path.startsWith("/api/premium/") || path.startsWith(PAYMENTS_API_PREFIX) || path.startsWith(COMMERCIAL_BARE_PREFIX)) && request.method === "OPTIONS") {
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
    if (path.startsWith(PAYMENTS_API_PREFIX) || path.startsWith(COMMERCIAL_BARE_PREFIX)) {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);

      const resp = await actorGateway.dispatch(env.ORCHESTRATOR_AGENT, userLogin, forwardReq);
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

      const resp = await actorGateway.dispatch(env.ORCHESTRATOR_AGENT, instanceName, forwardReq);
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
      return actorGateway.dispatch(env.ORCHESTRATOR_AGENT, "system_webhook_receiver", new Request(targetUrl, request));
    }
  return null;
}

/**
 * Slice 7 of Qunsultant/cfagent#2902 (Platform & commerce) — moves only.
 * The browser-agent snapshot family of handleFetch, verbatim and in
 * original order: POST /api/browser/snapshot and /browser/snapshot,
 * POST /api/browser/transaction-snap, /browser/transaction-snap and
 * /api/browser/snap/transaction. Placed in Platform per the Q2 answer
 * (contract §3 Slice 7 note; browser-agent platform surface, moved as
 * a whole, never split). Returns null when no branch matches, so
 * handleFetch falls through to the next delegation exactly as the
 * inline chain did.
 */
export async function handlePlatformBrowserRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
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
        return actorGateway.dispatch(env.ORCHESTRATOR_AGENT, userLogin, forwardReq);
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }
  return null;
}
