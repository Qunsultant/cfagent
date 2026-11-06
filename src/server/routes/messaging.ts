/**
 * Messaging & social branches for the Worker entry (src/server.ts).
 *
 * Slice 6 of Qunsultant/cfagent#2902 — moves only. Each handler below is a
 * verbatim block moved out of handleFetch, in its original position in the
 * dispatch chain; it returns null when no branch matches so handleFetch
 * falls through to the next delegation exactly as the inline chain did.
 * Branch lines keep their original indentation on purpose: re-indenting
 * would shift lines inside template literals and change response bytes.
 *
 * Handler signatures take the handleFetch locals the branches used
 * (request, env, url, path); shared auth comes from ../auth. The saga
 * handler additionally takes the handleFetch ingress `throttle`, which
 * the NLQ webhook branch passes to handleNlqWebhookRequest.
 */

import type { Env } from "../../types";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { routeAgentRequest } from "agents";
import { isFeatureEnabled, createFeatureDisabledResponse, matchFeatureForRoute } from "../../config/featureFlags";
import { timingSafeEqual, gateSlackRequest } from "../../security/webhookSecurity";
import { createIngressThrottle, pickWebhookSignature } from "../../api/ingress";
import { handleCoreHealthRoutes } from "../../server/routes/core";
import { handleAuthLoginRoutes } from "../../server/routes/auth";
import { isAllowedOrigin, requireAuth } from "../auth";
import type { DoNamespaceLike } from "../../data/durableKv";
import { zonedDateParts } from "../../schedule";
import { SOCIAL_BRIEF_MAX_CHARS, createSocialBriefStoreFromNamespace, isBriefDate } from "../../agents/social/briefStore";
import { createSocialStoresFromNamespace } from "../../agents/social/durableStores";
import { KNOWN_SOCIAL_CHANNELS, parseSocialConfig } from "../../agents/social/config";
import { createMemoryDryRunSink, resolvePostUrl, resolveSubmissionEndpoint } from "../../agents/social/publisher";
import { createFetchSocialTransport } from "../../agents/social/liveTransport";
import { approveAndPublish, rejectSocialDraft } from "../../agents/social/approvalActions";
import { checkAllTokenHealth } from "../../agents/social/tokenHealth";
import { handleSocialSlackInteraction, parseSocialAction } from "../../agents/social/interactions";
import { actorGateway } from "../../services/cloudflareActorGateway";
import { ETradeSlackTradingService, resolvePrincipal, slackPrincipalLinkStoreFromEnv, ETradeEmailTradingService } from "../../trading";
import { sanitizeInboundText } from "../../security/promptInjectionSanitize";
import { nlqWebhookBodySchema } from "../../api/ingressSchemas";
import { deriveNlqNonce, sharedMemoryReplayStore, validateEmailRecipient } from "../../security/webhookReplay";
import { ETradeWebhookService } from "../../services/tradingWebhooks";

/**
 * Slice 6 of Qunsultant/cfagent#2902 (Messaging & social) — moves only.
 * The NLQ inbound webhook's single-owner handler and its service
 * identity, moved with this slice per contract §2.5 (its only caller
 * is the NLQ webhook branches in handleMessagingSagaRoutes below).
 * Verbatim from src/server.ts, in its original position relative to
 * the moved branches: module level, before handleFetch.
 */
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
  const response = await actorGateway.dispatch(env.ORCHESTRATOR_AGENT, userLogin, forwarded);
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
 * Slice 6 of Qunsultant/cfagent#2902 (Messaging & social) — moves only.
 * The saga / NLQ / QA / memory family of handleFetch, verbatim and in
 * original order: /api/saga/journey-gates, /api/saga/journey-decision,
 * /api/saga/start, /api/saga/<id>/status, /nlq/webhook,
 * /api/trading/nlq/webhook, /api/nlq/webhook (all three spellings
 * delegate to handleNlqWebhookRequest, moved with this slice),
 * /api/qa/investigate, /api/memory/search. Returns null when no branch
 * matches, so handleFetch falls through to the next delegation exactly
 * as the inline chain did. The `throttle` parameter is the handleFetch
 * ingress throttle the NLQ branch passes to handleNlqWebhookRequest.
 */
export async function handleMessagingSagaRoutes(request: Request, env: Env, url: URL, path: string, throttle: (route: string, maxRequests: number, windowMs: number) => Response | null): Promise<Response | null> {
    // Issue #2041 S2: saga journey-gate routes (panel + chat
    // surfaces). Session login comes from requireAuth; the
    // handler 401s when absent (never a synthetic identity).
    if (path === "/api/saga/journey-gates" || path === "/api/saga/journey-decision") {
      const { handleSagaJourneyRoutes } = await import("../../agents/routes/sagaJourney");
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
      const { handleSagaEntryRoutes } = await import("../../agents/routes/sagaEntry");
      const { handleSagaStatusRoutes } = await import("../../agents/routes/sagaStatus");
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
      const { investigateQAFailure } = await import("../../qa/investigate");
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
      const { VectorMemory } = await import("../../memory/vector-memory");
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
            await import("../../retrieval/createRetrievalPorts");
          const { expandGraphContext } = await import("../../retrieval/hybridRetrieval");
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
        const { toRetrievalCompletedEnvelope } = await import("../../retrieval/hybridRetrieval");
        const { ingestRetrievalCompleted } = await import("../../telemetry/retrievalStats");
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
  return null;
}

/**
 * Slice 6 of Qunsultant/cfagent#2902 (Messaging & social) — moves only.
 * The social family of handleFetch, verbatim and in original order:
 * /api/social/brief, /api/social/approval, /api/social/approvals,
 * /api/social/posts, /api/social/token-health. Returns null when no
 * branch matches, so handleFetch falls through to the next delegation
 * exactly as the inline chain did.
 */
export async function handleMessagingSocialRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
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
  return null;
}

/**
 * Slice 6 of Qunsultant/cfagent#2902 (Messaging & social) — moves only.
 * The Slack family of handleFetch, verbatim and in original order:
 * /slack/commands, /slack/slash, /slack, /slack/events,
 * /slack/interactions, /slack/install, /slack/oauth_callback. Returns
 * null when no branch matches, so handleFetch falls through to the
 * next delegation exactly as the inline chain did.
 */
export async function handleMessagingSlackRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
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
      return actorGateway.dispatch(env.ORCHESTRATOR_AGENT, `slack_${teamId}`, forwardReq);
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
      return actorGateway.dispatch(env.ORCHESTRATOR_AGENT, `slack_${teamId}`, forwardReq);
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
      return actorGateway.dispatch(env.ORCHESTRATOR_AGENT, `slack_${teamId}`, forwardReq);
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
  return null;
}
