/**
 * Core dispatcher branches for the Worker entry (src/server.ts).
 *
 * Slice 2 of Qunsultant/cfagent#2902 — moves only. Each handler below is a
 * verbatim block moved out of handleFetch, in its original position in the
 * dispatch chain; it returns null when no branch matches so handleFetch
 * falls through to the next delegation exactly as the inline chain did.
 * Branch lines keep their original indentation on purpose: re-indenting
 * would shift lines inside template literals (e.g. the /checkout/sandbox
 * HTML) and change response bytes.
 *
 * Handler signatures take the handleFetch locals the branches used
 * (request, env, url, path); shared auth comes from ../auth.
 */

import type { Env } from "../../types";
import { publicClientMetadataDocument } from "../../security/publicOAuth";
import { getAllFeatureFlags } from "../../config/featureFlags";
import { requireAuth, authenticateRequest } from "../auth";
import { renewSession, setSessionCookie } from "../../session";
import { invalidateSessionCache } from "../../security/sessionCache";
import { ensureCsrfCookie } from "../../security/csrf";
import { sessionStore } from "../../security/session";
import { createWiredAuditStore } from "../../security/iaaaAuditStore";
import { createKvMembershipStore } from "../../security/iaaaMembershipStore";
import { IAAA_AUDIT_POLICY_VERSION, recordAuditEvent } from "../../security/iaaaAudit";
import { actorGateway } from "../../services/cloudflareActorGateway";
import { buildOpenApiSpec, SWAGGER_UI_HTML } from "../../security/openapiSpec";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { bearerTokenFromRequest, serviceTokenStore, verifyServiceToken } from "../../security/serviceTokens";
import { fetchStaticAsset } from "../../security/staticAssets";
import { AUTH_OUTCOME_PARAM, authOutcomeLoginUrl, parseAuthOutcome } from "../../security/authOutcome";
import { validateReturnTarget } from "../../security/returnTarget";
import { getProviderByIssuer } from "../../security/providers";
import { renderLandingPage } from "../../landing";
import { resolvePollingConfigFromEnv } from "../../pollingConfig";
import { SERVER_PALETTE } from "../../theme/serverPalette";

// Slice 8 (#2902): ensureBreakerDurability imports (moved from src/server.ts).
import { createBreakerStateStoreAdapter, ensureBreakerStateSchema } from "../../data/createBreakerStateStorePorts";
import { configureDefaultBreakerDurability } from "../../breakers/createBreakerPorts";
import { createBreakerTripSubscriber } from "../../breakers/breakerTripAlert";
import { postSlackText, resourceSlackPost } from "../../agents/resourceGoals";
import type { SlackDeliveryEnv } from "../../agents/social/delivery";

/**
 * Slice 2 of Qunsultant/cfagent#2902 (Core dispatcher) — moves only.
 * The early Core branches of handleFetch, verbatim and in original order:
 * /.well-known OAuth client metadata, /a2a/* + /.well-known/*, /api/features.
 * Returns null when no branch matches, so handleFetch falls through to the
 * next delegation exactly as the inline chain did.
 */
export async function handleCoreEarlyRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
    // Issue #1247: Public.com Client ID Metadata Document — the
    // OAuth client_id for the Public resource provider IS this URL
    // (no RFC 7591 registration exists; see src/security/publicOAuth.ts).
    // Served ahead of the A2A well-known branch, which would otherwise
    // claim every /.well-known/* path. Public by design: the
    // authorization server fetches it unauthenticated.
    if (path === "/.well-known/oauth-client-id-metadata-document") {
      const origin = new URL(request.url).origin;
      return new Response(JSON.stringify(publicClientMetadataDocument(origin)), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // PR #2 — A2A routing (issue #160): agent discovery + JSON-RPC dispatch
    if (path.startsWith("/a2a/") || path.startsWith("/.well-known/")) {
      const { handleA2A } = await import("../../a2a");
      return handleA2A(request, env as any);
    }

    // Issue #1806: Cloudflare feature flags — dynamic feature flags query
    if (path === "/api/features" && request.method === "GET") {
      const session = await requireAuth(request, env).catch(() => null);
      const features = await getAllFeatureFlags(env, { userLogin: session?.githubLogin });
      return Response.json({ features });
    }
  return null;
}

/**
 * Slice 2 of Qunsultant/cfagent#2902 (Core dispatcher) — moves only.
 * The /health + /api/health branch, verbatim, in its original position
 * (after the public-OAuth branches, before /api/qa/investigate).
 * reqEnv is recomputed here from request/url with the verbatim expression
 * that handleFetch computed before the E*TRADE branches; the expression is
 * pure, so the value is identical.
 */
export async function handleCoreHealthRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
    // Verbatim reqEnv expression from handleFetch (computed before the E*TRADE branches).
    const reqEnv = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase() || undefined;
    // --- Factor 14 Telemetry: Health & Observability Endpoint ---
    if (path === "/health" || path === "/api/health") {
      return Response.json({
        status: "healthy",
        service: "cfagent-multi-agent-studio",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        environment: reqEnv,
        runtime: "cloudflare-workers",
        telemetry: {
          durableObjects: "healthy",
          mcp: "available",
          apiFirst: true,
          fifteenFactorCompliant: true,
        },
      });
    }
  return null;
}

/**
 * Slice 2 of Qunsultant/cfagent#2902 (Core dispatcher) — moves only.
 * The late Core tail of handleFetch, verbatim and in original order:
 * /openapi.json + /api/docs, the /api/* fallthrough to the Orchestrator
 * (ORCHESTRATOR_AGENT) — which stays after every explicit /api/* branch exactly
 * as today — /checkout/sandbox (KEEP PUBLIC, #2052), the / + /index.html
 * branch, and the static-asset fallback. The authenticateRequest call that
 * preceded the root branch stays inside this handler, at the same point.
 */
export async function handleCoreLateRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response> {
    // --- OpenAPI + Swagger spike (issue #1024 Phase 1) ---
    // GET /openapi.json serves the generated spec; GET /api/docs serves
    // the Swagger UI page against it. PROVISIONAL gating: both routes
    // require an authenticated session (unauthenticated → 401). The
    // #1024 design decision on docs exposure is still open; this
    // session gate is the safe spike default, not the final decision.
    // Placed before the generic /api/ forwarder so /api/docs is not
    // forwarded to the DO.
    if (path === "/openapi.json" || path === "/api/docs") {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      }
      if (request.method !== "GET") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      if (path === "/openapi.json") {
        return Response.json(buildOpenApiSpec());
      }
      return new Response(SWAGGER_UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // --- Forwarded Durable Object APIs (NLQ, Audit, Memory, Clear, Referrals, Ads, Payments) ---
    if (path.startsWith("/api/")) {
      const session = await requireAuth(request, env);
      // Issue #2681: session first, then a tenant-bound service token.
      // A verified token forwards as the service login with
      // x-principal-kind "service-token", so DO routes can tell a
      // token caller from a session caller (token callers never
      // administer the service identity). Tenant-tier tokens are
      // usable only when the server-resolved tenant equals the
      // token's tenant (verifyServiceToken enforces that; the tenant
      // never comes from a request header). A denied token is
      // indistinguishable from a missing one to the caller, and is
      // attributed best-effort to the IAAA chain — the decision is
      // already deny, so an audit-store failure never converts it
      // into an allow. The presented secret and its hash are never
      // logged or audited.
      let userLogin = session?.githubLogin ?? null;
      let principalKind: "session" | "service-token" = "session";
      if (!userLogin) {
        const presented = bearerTokenFromRequest(request);
        const verified = await verifyServiceToken(
          serviceTokenStore(env),
          createKvMembershipStore(sessionStore(env)),
          presented,
          resolveIaaaTenant(env),
          Date.now(),
        ).catch(() => null);
        if (verified) {
          userLogin = verified.serviceLogin;
          principalKind = "service-token";
        } else if (presented) {
          console.warn("[service-token] denied: invalid, expired, revoked, unprovisioned, or cross-tenant token");
          try {
            await recordAuditEvent(createWiredAuditStore(env), {
              timestamp: Date.now(),
              type: "service_token.denied",
              actorPrincipalId: "unknown-service-token",
              actorType: "service",
              initiatingPrincipalId: "unknown-service-token",
              tenantId: resolveIaaaTenant(env),
              correlationId: crypto.randomUUID(),
              action: "service_token.use",
              decision: "deny",
              policyVersion: IAAA_AUDIT_POLICY_VERSION,
              outcome: "failed",
              errorCode: "SERVICE_TOKEN_DENIED",
            });
          } catch {
            /* denial attribution is best-effort; the deny stands */
          }
        }
      }
      if (!userLogin) return new Response("Unauthorized", { status: 401 });

      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");

      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.delete("x-user-login");
      forwardReq.headers.delete("x-principal-kind");
      forwardReq.headers.set("x-user-login", userLogin);
      forwardReq.headers.set("x-principal-kind", principalKind);
      const isImmediateSync = /^\/(?:clear|reset|memory|audit|chat|etrade|broker|trading|screener|options|workflow-runs|tenant|external-ads|categories|referrals|revenue|ads|platform|environment|workspace|stock-copilot)(?:\/|\?|$)/i.test(subPath);
      // #1724: the caller's `x-delivery-mode` header (copied through
      // by the Request construction above) adjusts eligibility ONLY:
      // "queued" grants x-async-eligible even to an immediate-prefix
      // request, "sync" suppresses it even for a non-immediate one.
      // The DO entry remains the decider (it resolves the same header
      // in run > session > user > env > per-prefix-legacy order); the
      // Worker never reroutes the special branches above, and an
      // unrecognized value keeps legacy marking (the DO/MCP decision
      // then fails closed with a jobs.config_error audit).
      const deliveryOverride = (request.headers.get("x-delivery-mode") || "").trim().toLowerCase();
      if (deliveryOverride !== "sync" && (deliveryOverride === "queued" || !isImmediateSync)) {
        forwardReq.headers.set("x-async-eligible", "1");
      }
      return actorGateway.dispatch(env.ORCHESTRATOR_AGENT, userLogin, forwardReq);
    }

    // --- Simulated Sandbox Terminal for Payment Gateways ---
    // #2052: all five query params are attacker-controlled and land in
    // HTML text positions — escape at interpolation (& first, then < >
    // "). The route stays public by owner decision 2026-11-01
    // (KEEP PUBLIC); escaping + CSP are the fix, not gating. The
    // Authorize href keeps raw values under encodeURIComponent, the
    // correct encoding for a URL query context.
    // Styling (#3146): Carbon v11 Gray 100 tokens inlined below — this page
    // allows no external resources, so Carbon's React components and the
    // IBM Plex font cannot load here; the visual system is Carbon's tokens,
    // spacing, type scale, and button treatment on the same markup. CSP
    // and escaping are unchanged.
    if (path === "/checkout/sandbox") {
      const escapeHtml = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const provider = (url.searchParams.get("provider") || "stripe").toUpperCase();
      const draftId = url.searchParams.get("id") || "pay_demo";
      const amount = url.searchParams.get("amt") || "25.00";
      const currency = url.searchParams.get("curr") || "USD";
      const customer = decodeURIComponent(url.searchParams.get("cust") || "Enterprise Customer");
      const sig = url.searchParams.get("sig") || "0x_demo_signature";

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(provider)} Payment Terminal — Multi-Agent Studio</title>
  <style>
    body {
      margin: 0; padding: 0; background: ${SERVER_PALETTE.carbonBackground}; color: ${SERVER_PALETTE.carbonTextPrimary};
      font-family: 'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif;
      display: flex; align-items: center; justify-content: center; min-height: 100vh;
    }
    .card {
      background: ${SERVER_PALETTE.carbonLayer01}; border: 1px solid ${SERVER_PALETTE.carbonBorderSubtle};
      border-radius: 0; padding: 2rem; max-width: 440px; width: 90%; box-sizing: border-box;
    }
    .badge { display: inline-block; background: ${SERVER_PALETTE.carbonTagBlueBg}; color: ${SERVER_PALETTE.carbonTagBlueText}; padding: 0.25rem 0.5rem; border-radius: 0; font-size: 0.75rem; font-weight: 400; letter-spacing: 0.02rem; text-transform: uppercase; margin-bottom: 1rem; }
    h2 { margin: 0 0 0.5rem 0; font-size: 1.25rem; font-weight: 400; color: ${SERVER_PALETTE.carbonTextPrimary}; }
    .amount { font-size: 2rem; font-weight: 400; color: ${SERVER_PALETTE.carbonTextPrimary}; margin: 1rem 0; }
    .did-box { background: ${SERVER_PALETTE.carbonBackground}; border: 1px solid ${SERVER_PALETTE.carbonBorderSubtle}; border-radius: 0; padding: 1rem; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 0.75rem; color: ${SERVER_PALETTE.carbonTextSecondary}; word-break: break-all; margin-bottom: 1.5rem; }
    .btn { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 3rem; padding: 0 1rem; border-radius: 0; font-size: 0.875rem; font-weight: 400; cursor: pointer; text-align: center; text-decoration: none; border: 0; margin-bottom: 0.75rem; box-sizing: border-box; }
    .btn-pay { background: ${SERVER_PALETTE.carbonButtonPrimary}; color: ${SERVER_PALETTE.onGradient}; }
    .btn-pay:hover { background: ${SERVER_PALETTE.carbonButtonPrimaryHover}; }
    .btn-cancel { background: transparent; color: ${SERVER_PALETTE.carbonLinkPrimary}; }
    .btn-cancel:hover { background: ${SERVER_PALETTE.carbonLayerHover01}; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">${escapeHtml(provider)} Sandbox Terminal</span>
    <h2>Secure Payment Authorization</h2>
    <p style="color: ${SERVER_PALETTE.carbonTextSecondary}; font-size: 0.875rem; margin: 0;">Recipient: Multi-Agent Studio (${escapeHtml(customer)})</p>
    <div class="amount">$${escapeHtml(amount)} <span style="font-size: 1rem; color: ${SERVER_PALETTE.carbonTextSecondary};">${escapeHtml(currency)}</span></div>
    <div class="did-box">
      <div><strong>Proposer:</strong> did:agent:openaimp:payments</div>
      <div><strong>Intent Hash:</strong> ${escapeHtml(sig)}...</div>
    </div>
    <a href="/?payment=success&draft=${encodeURIComponent(draftId)}&provider=${encodeURIComponent(provider)}" class="btn btn-pay">
      ✓ Authorize & Complete Payment
    </a>
    <a href="/?payment=cancel" class="btn btn-cancel">Cancel Transaction</a>
  </div>
</body>
</html>`;
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // #2052: the page is self-contained (inline <style> only, no
          // scripts, no external resources), so default-deny with an
          // inline-style allowance is both tight and sufficient.
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        },
      });
    }

    // --- Serve App or Login Page ---
    // The root route needs both halves of the auth result: the session renders
    // the shell, and the id that actually resolved it re-issues the cookie.
    const auth = await authenticateRequest(request, env);
    const session = auth?.session ?? null;
    if (path === "/" || path === "/index.html") {
      if (!session) {
        // #2402: a just-created session that cannot be read back is
        // the #2280 loop — never render the landing page and let the
        // boot redirect silently again. This redirect is pure URL
        // logic (no SessionStore read), so the message renders even
        // under quota exhaustion. Any other no-session visit (never
        // signed in, expired) keeps the landing page unchanged.
        if (
          parseAuthOutcome(url.searchParams.get(AUTH_OUTCOME_PARAM)) ===
          "signed_in"
        ) {
          // #3015: a just-created session that cannot be read back
          // still preserves a deep link: the current request URL
          // (outcome stripped, validated) rides on the login
          // redirect as ?target=, so the retry lands back on the
          // bookmarked page instead of the default. A plain /
          // visit keeps the redirect byte-identical.
          const unreadableTarget = validateReturnTarget(
            `${url.pathname}${url.search}`
          );
          const targetSuffix =
            unreadableTarget && unreadableTarget !== "/"
              ? `&target=${encodeURIComponent(unreadableTarget)}`
              : "";
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${authOutcomeLoginUrl("session_unreadable")}${targetSuffix}`,
            },
          });
        }
        // #3015: a signed-out deep-link visit is served this page,
        // so the page carries the target on its sign-in links
        // (path + query; the browser never sends a fragment). A
        // plain / visit passes no target and the page is
        // byte-identical to before.
        const landingTarget = validateReturnTarget(
          `${url.pathname}${url.search}`
        );
        return new Response(renderLandingPage(env.APP_NAME, resolvePollingConfigFromEnv(env), landingTarget && landingTarget !== "/" ? landingTarget : undefined), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            // Auth HTML must never be replayed from a cache: a stale landing
            // page on refresh looks like a sign-out even with a live cookie.
            "Cache-Control": "no-store",
          },
        });
      }

      // Qunsultant/cfagent#1775 (Adapter S1): ASSETS fetch via the
      // static-asset port (fetchStaticAsset), not the binding
      // directly. Response handling below is verbatim.
      const asset = await fetchStaticAsset(request, env);
      if (asset.ok) {
        const html = await asset.text();
        // Issue #1759: the client renders the user DID from the
        // session's provider (getDisplayUserDid), so the injected
        // user carries the provider id — from the same registry
        // source as /api/me, never from user input. Legacy
        // sessions (no internalUserId) carry no providerId and the
        // client falls back to the legacy GitHub derivation.
        const bootProvider = session.internalUserId
          ? getProviderByIssuer(session.providerIssuer)
          : null;
        const safeUser = JSON.stringify({
          login: session.githubLogin,
          name: session.githubName,
          avatar: session.githubAvatar,
          ...(bootProvider ? { providerId: bootProvider.providerId } : {}),
        }).replace(/</g, "\\u003c");

        // Issue #1806: Inject evaluated feature flags for zero-latency client boot
        const flags = await getAllFeatureFlags(env, { userLogin: session.githubLogin });
        const safeFeatures = JSON.stringify(flags).replace(/</g, "\\u003c");

        // #2402: one-time boot confirmation. The code is allowlisted
        // here and the display name comes from the verified session,
        // never from the URL; main.tsx strips the parameter on boot
        // so a refresh never reshows it.
        const bootOutcome =
          parseAuthOutcome(url.searchParams.get(AUTH_OUTCOME_PARAM)) ===
          "signed_in"
            ? `window.__AUTH_OUTCOME__="signed_in";`
            : "";
        // Issue #2419: inject externalized polling cadences for the app
        // bundle, resolved from wrangler vars (defaults when unset).
        const safePolling = JSON.stringify(resolvePollingConfigFromEnv(env)).replace(/</g, "\\u003c");
        const userScript = `<script>window.__USER__=${safeUser};window.__FEATURES__=${safeFeatures};window.__POLLING_CONFIG__=${safePolling};${bootOutcome}</script>`;
        const modified = html.replace("</head>", `${userScript}</head>`);
        // Re-issue the id that actually authenticated this request. With a
        // stale duplicate cookie in the header, the first value is not
        // necessarily the live one.
        const sessionId = auth!.sessionId;

        // Sliding session (#2215 follow-up): an active user should not be
        // forced to sign in every 7 days. When the absolute window is
        // within two days of expiry (and the 30-day cap is not reached),
        // slide it in place — same session id, so other tabs stay valid.
        // Best-effort: a failed renewal must never fail the page load.
        try {
          if (await renewSession(env, sessionId, session)) {
            invalidateSessionCache(sessionId);
          }
        } catch (renewErr) {
          console.warn("[session] renewal failed; page served with the existing session", renewErr);
        }

        // Issue #3113 (#945 Q5): re-issue the session cookie and,
        // for pre-slice sessions, mint a CSRF token cookie alongside.
        const pageHeaders = new Headers({
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        pageHeaders.append("Set-Cookie", setSessionCookie(sessionId));
        const renewalCsrf = ensureCsrfCookie(request);
        if (renewalCsrf) pageHeaders.append("Set-Cookie", renewalCsrf);
        return new Response(modified, { headers: pageHeaders });
      }
    }

    // Qunsultant/cfagent#1775 (Adapter S1): fallthrough serve via
    // the static-asset port, not the binding directly.
    return fetchStaticAsset(request, env);
}

/**
 * Slice 8 of Qunsultant/cfagent#2902 (Queue / scheduled) — moves only.
 * ensureBreakerDurability moves here from src/server.ts (contract
 * section 2.5: Core prelude) so the entry's fetch handler and the
 * queue/scheduled handlers in ./queue can both call it without a
 * server.ts cycle. Verbatim below.
 */
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
export function ensureBreakerDurability(env: Env): void {
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
