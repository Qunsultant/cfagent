/**
 * Auth & IAAA branches for the Worker entry (src/server.ts).
 *
 * Slice 3 of Qunsultant/cfagent#2902 — moves only. Each handler below is a
 * verbatim block moved out of handleFetch, in its original position in the
 * dispatch chain; it returns null when no branch matches so handleFetch
 * falls through to the next delegation exactly as the inline chain did.
 * Branch lines keep their original indentation on purpose: re-indenting
 * would shift lines inside template literals and change response bytes.
 *
 * Handler signatures take the handleFetch locals the branches used
 * (request, env, url, path); shared auth comes from ../auth. The
 * loginProviderMatch / callbackProviderMatch / reqEnv locals move inside
 * handleAuthLoginRoutes with their branches.
 */

import { sessionStore, listSessionFamilyEntries, wiredMembershipStore, deleteSession, wiredAccessRequestStore } from "../../security/session";
import { createWiredAuditStore } from "../../security/iaaaAuditStore";
import { createKvMembershipStore, listMembershipsFromEntries, grantMembership, readMembershipById } from "../../security/iaaaMembershipStore";
import { createKvPermissionDenialStore } from "../../security/iaaaPermissionDenialStore";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import { evaluateRoutePep } from "../../security/pepGateway";
import { handleLogout, renderLoginPage } from "../../oauth";
import { AUTH_OUTCOME_PARAM, parseAuthOutcome } from "../../security/authOutcome";
import { validateReturnTarget } from "../../security/returnTarget";
import { disabledLoginResponse, enabledProviders, getProvider, isWiringEnabled, resolveLoginProvider, getProviderByIssuer } from "../../security/providers";
import { getETradeRequestToken, exchangeETradeVerifier, renewETradeAccessToken, revokeRemoteAccessToken, getETradeAuthStatus, getStoredTokens, getValidTokens, renewFailureDetail, etradeIdentityFromSession, isTokenExpiredEt, listTokenFamilyEntries } from "../../services/etradeOAuth";
import { PublicClientRejectedError, completePublicOAuth, connectPublicPersonalToken, disconnectPublic, getPublicConnectionStatus, startPublicOAuth } from "../../security/publicOAuth";
import { ETradeRestClient } from "../../trading";
import { resolveEnvironmentConfig } from "../../config/environment";
import { requireAuth } from "../auth";
import type { Env } from "../../types";
import { SHARED_ORCHESTRATOR_INSTANCE } from "../../security/serviceIdentity";
import { ensureCsrfCookie } from "../../security/csrf";
import { buildAdminOverview, computeAdminCounts, isPlatformAdmin } from "../../security/iaaaAdminOverview";
import { handleSeedGovernanceRoute } from "../../data/seedGovernanceRoute";
import { actorGateway } from "../../services/cloudflareActorGateway";
import type { GovernedHaltState } from "../../data/governedHalt";
import { createUserEmailDestinationStore, normalizeEmailDestination } from "../../services/userEmailDestination";
import { clearSessionCookie } from "../../session";
import { invalidateSessionCache } from "../../security/sessionCache";
import { resolveIdleTimeoutMs } from "../../security/sessionPolicy";
import { rotateUserSessionsForEnv, sessionRotationCookie } from "../../security/sessionRotation";
import { resolveScreenerAgentName } from "../../agents/screenerAgentName";
import { quotaWindowKey, type QuotaUsageView } from "../../security/userRequestQuota";
import type { UserRequestQuotaOverride } from "../../data/userRequestQuotaPorts";
import { buildLoggedInUserRows, parseLoggedInSessionEntry } from "../../security/iaaaLoggedInUsers";
import { SESSION_REVOCATION_CROSS_ISOLATE_BOUND_MS } from "../../security/revocationTargets";
import { isAdminRoleGrant, listGrantsForReview, resolveGrantDefaultExpiryDays, runGranterRevocationPass, type GranterRevocationPassResult } from "../../security/grantRules";
import { createGrantProposalStore, resolveAdminGrantProposal } from "../../security/grantProposals";
import { requiresStepUpForAction, requiresStepUpForMint } from "../../security/iaaaGates";
import { MANAGEABLE_DENIED_PERMISSIONS, canManagePermissionDenial } from "../../security/permissionDenials";
import { ALL_ROLES, canGrantRole, PERMISSIONS, type AuthorizationScope, type Role } from "../../security/authorization";
import { approveBootstrapProposal, bootstrapProposalAuditInput, confirmBootstrapApplied, createBootstrapProposal, createKvBootstrapProposalStore, currentBootstrapEntries, findBootstrapDivergence, parseStoredBootstrapProposal, rejectBootstrapProposal, BOOTSTRAP_PROPOSAL_KEY_PREFIX, type BootstrapProposal, type BootstrapProposalAuditAction } from "../../security/bootstrapProposals";
import { parseBootstrapAdmins, resolveBootstrapEntries } from "../../security/iaaaBootstrap";
import { createWiredBindingStore } from "../../security/iaaaLogin";
import { approveProposal, createKvPolicyProposalStore, createProposal, diffPolicySnapshots, parseStoredProposal, policyProposalAuditInput, previewDecisions, promoteProposal, rejectProposal, POLICY_PROPOSAL_ACTIVE_KEY, POLICY_PROPOSAL_KEY_PREFIX, type PolicyProposal, type PolicyProposalAuditAction } from "../../security/policyProposals";
import { canRevokeRoleGrant, flattenRoleGrants, removeRoleBinding, toRoleGrantView, validateRoleGrantRequest } from "../../security/roleGrants";
import { evaluateWithObligations, type ObligationAuditWriter } from "../../security/obligations";
import { IAAA_AUDIT_POLICY_VERSION, recordAuditEvent } from "../../security/iaaaAudit";
import { parseSessionRegistryEntries } from "../../security/iaaaSessionRegistry";
import { isMailSuppressed, resolveOffboardSessions, runOffboard, setMailSuppression } from "../../security/iaaaLifecycleWiring";
import { createSubscriptionAdapter } from "../../data/createSubscriptionPorts";
import { hasUnexpiredSubscription } from "../../data/subscriptionPorts";
import { createLifecycleAdapter } from "../../data/createLifecyclePorts";
import { listApiKeys, mintApiKey, revokeApiKey } from "../../security/apiKeys";
import { sendProvisioningWelcome } from "../../services/provisioningWelcome";

import { commercialPath } from "../../data/commercialUrlCatalog";
/**
 * Slice 3 of Qunsultant/cfagent#2902 (Auth & IAAA) — moves only.
 * The login family of handleFetch, verbatim and in original order:
 * /login, /auth/login/<id>, /auth/callback/<id>, /auth/logout, the E*TRADE
 * OAuth family (/auth/etrade/* + /api/etrade/oauth/*), and the public-OAuth
 * family (/auth/public/* + /api/public/*). loginProviderMatch,
 * callbackProviderMatch and reqEnv move inside this handler with their
 * branches; reqEnv is the verbatim expression handleFetch computed.
 * Returns null when no branch matches, so handleFetch falls through to the
 * next delegation exactly as the inline chain did.
 */
export async function handleAuthLoginRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
    // --- Authentication endpoints ---
    // #945 provider registry dispatch, completed by #1254 PR-B:
    // the generic /auth/login/<id> + /auth/callback/<id> family
    // below is the ONLY login routing — the GitHub-only exact
    // /auth/login + /auth/callback branches and the wiring-off
    // legacy flow are deleted. A disabled/unregistered provider
    // gets a 403, never a fallback. Logout is unchanged.
    if (path === "/login" && request.method === "GET") {
      // #945 Google-as-plugin — composable login page: when wiring
      // is on, the page renders one button per enabled, registered
      // provider (computed here and passed in — githubOAuth.ts must
      // not import providers.ts, which would create an import
      // cycle). When nothing is enabled (wiring off, or no
      // registered provider in the list), no argument is passed and
      // the page is exactly the legacy GitHub-only page.
      const enabled = enabledProviders(env)
        .map((id) => getProvider(id))
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => ({ id: p.providerId, displayName: p.displayName ?? p.providerId }));
      // #3015: a ?target= on the login page rides into every
      // provider button (and survives a provider switch there);
      // an absent or refused target renders the plain page.
      const loginReturnTarget =
        validateReturnTarget(url.searchParams.get("target")) ?? undefined;
      return new Response(
        renderLoginPage(
          env,
          enabled.length > 0 ? enabled : undefined,
          parseAuthOutcome(url.searchParams.get(AUTH_OUTCOME_PARAM)),
          loginReturnTarget
        ), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    // #945 Google-as-plugin — generic provider routes: the only
    // login routing since #1254 PR-B deleted the exact GitHub-only
    // branches. A provider id segment dispatches through the
    // registry (wired-callback options: audit store, resolved
    // tenant, post-login enabled). Wiring OFF is a 403 — no legacy
    // flow exists for any provider — and an unknown or unlisted id
    // is a 403, never a fallback to another provider.
    const loginProviderMatch = path.match(/^\/auth\/login\/([^/]+)$/);
    if (loginProviderMatch) {
      if (!isWiringEnabled(env)) return disabledLoginResponse("wiring-disabled");
      const { provider, disabledReason } = resolveLoginProvider(env, loginProviderMatch[1]);
      if (!provider || disabledReason) {
        return disabledLoginResponse(disabledReason ?? "provider-not-registered");
      }
      // #3015: the target travels in, is validated and sealed into
      // signed state by startLogin, and is never trusted raw at
      // callback time. An absent or refused target starts a plain
      // login (default landing afterwards).
      return provider.startLogin(env, url.searchParams.get("target") ?? undefined);
    }
    const callbackProviderMatch = path.match(/^\/auth\/callback\/([^/]+)$/);
    if (callbackProviderMatch) {
      if (!isWiringEnabled(env)) return disabledLoginResponse("wiring-disabled");
      const { provider, disabledReason } = resolveLoginProvider(env, callbackProviderMatch[1]);
      if (!provider || disabledReason) {
        return disabledLoginResponse(disabledReason ?? "provider-not-registered");
      }
      return provider.handleCallback(env, request, {
        auditStore: createWiredAuditStore(env),
        auditTenantId: resolveIaaaTenant(env),
        postLoginEnabled: true,
      });
    }
    if (path === "/auth/logout") {
      // #945 GitHub end-to-end logout audit hook: when wiring is
      // ON, supply the audit seam with the resolved tenant
      // (IAAA_TENANT_ID else the documented default "primary"), so
      // the hook is no longer dormant when the env var is unset.
      // handleLogout records BEFORE deleteSession, best-effort.
      if (isWiringEnabled(env)) {
        return handleLogout(env, request, {
          wiringEnabled: true,
          auditStore: createWiredAuditStore(env),
          tenantId: resolveIaaaTenant(env),
        });
      }
      return handleLogout(env, request);
    }

    // --- E*TRADE OAuth 1.0a 3-Legged Lifecycle Endpoints ---
    const reqEnv = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase() || undefined;

    if (path === "/auth/etrade/start" || path === "/api/etrade/oauth/start") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      // #945 GitHub end-to-end PDP gate: when IAAA_PDP_ENABLED is on
      // and the session is wired, starting an integration connection
      // requires integration:connect in the resolved tenant.
      // Flag OFF or a legacy session inside its #1749 PDP grace bound takes the pre-change path;
      // a grace-expired legacy session is PDP-enforced and denied with legacy_pdp_grace_expired (see authz.md §8).
      // #1755: the four integration:connect gates share one PEP helper
      // (evaluateRoutePep) — same enforcement, same two 403 responses.
      const pep = await evaluateRoutePep({
        env,
        session,
        tenantId: resolveIaaaTenant(env),
        permission: "integration:connect",
        membershipStore: createKvMembershipStore(sessionStore(env)),
        permissionDenialStore: createKvPermissionDenialStore(sessionStore(env)),
        nowMs: Date.now(),
      });
      if (pep.enforced && !pep.allowed) {
        if (pep.graceExpired) {
          return Response.json({ error: "Legacy session PDP grace expired: re-login through wiring to restore gated actions.", code: "legacy_pdp_grace_expired" }, { status: 403 });
        }
        return Response.json({ error: "Authorization denied: integration:connect permission required." }, { status: 403 });
      }
      const callbackParam = url.searchParams.get("callback");
      const callbackUrl = callbackParam || "oob";
      try {
        const result = await getETradeRequestToken(env, session.githubLogin, callbackUrl, reqEnv);
        if (url.searchParams.get("mode") === "redirect") {
          return Response.redirect(result.authorizeUrl, 302);
        }
        return Response.json(result);
      } catch (err: any) {
        // Issue #3197: the hub reclaims a stranded pre-opened tab by
        // navigating it to the app with this code (etrade_connect_error),
        // so the code rides alongside the outcome message. BusinessError
        // carries an outcome-catalog code; other errors carry theirs or
        // none (JSON drops an undefined code).
        return Response.json({ error: err.message || "Failed to initiate E*TRADE OAuth", code: err.code }, { status: 500 });
      }
    }

    if (path === "/auth/etrade/callback") {
      const session = await requireAuth(request, env);
      if (!session) return Response.redirect("/?error=unauthorized", 302);
      const verifier = url.searchParams.get("oauth_verifier");
      if (!verifier) {
        return Response.redirect("/?tab=trading&error=missing_verifier", 302);
      }
      try {
        await exchangeETradeVerifier(env, session.githubLogin, verifier, undefined, undefined, reqEnv);
        return Response.redirect("/?tab=trading&etrade_auth=success", 302);
      } catch (err: any) {
        return Response.redirect(`/?tab=trading&error=${encodeURIComponent(err.message || "exchange_failed")}`, 302);
      }
    }

    if (path === "/api/etrade/oauth/status") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ authenticated: false });
      // Issue #2386: status resolves through the identity-aware seam,
      // so the panel label reflects the same token set renew and
      // revoke act on — never a login-only subset of it.
      const status = await getETradeAuthStatus(env, session.githubLogin, reqEnv, etradeIdentityFromSession(session));
      return Response.json(status);
    }

    if (path === "/api/etrade/diagnostics") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ authenticated: false, error: "Unauthorized: Please log in with GitHub" }, { status: 401 });

      const envConfig = resolveEnvironmentConfig(env, reqEnv);
      // Issue #2386: diagnostics reads through the same identity-aware
      // seam as status, so its token-present verdict cannot disagree
      // with the panel label for the same session.
      const valid = await getValidTokens(env, session.githubLogin, reqEnv, etradeIdentityFromSession(session));

      const client = new ETradeRestClient(env, session.githubLogin, reqEnv);
      let accounts: any[] = [];
      let balance: any = null;
      let lastError: string | null = null;

      if (valid) {
        accounts = await client.fetchAccounts();
        lastError = client.getLastError() || null;
        if (accounts.length > 0) {
          const key = accounts[0].accountKey || accounts[0].accountId;
          balance = await client.fetchBalance(key);
        }
      } else {
        lastError = client.getLastError() || `No active OAuth session in [${envConfig.name}] mode. Click 'Connect E*TRADE Account'.`;
      }

      return Response.json({
        status: accounts.length > 0 ? "healthy" : (valid ? "upstream_error" : "auth_required"),
        environment: envConfig.name,
        isLive: envConfig.isLive,
        apiUrl: envConfig.etrade.baseUrl,
        userLogin: session.githubLogin,
        credentials: {
          apiKeyConfigured: Boolean(envConfig.etrade.apiKey),
          apiKeyMasked: envConfig.etrade.apiKey ? `${envConfig.etrade.apiKey.slice(0, 4)}...${envConfig.etrade.apiKey.slice(-4)}` : "MISSING",
          apiSecretConfigured: Boolean(envConfig.etrade.apiSecret),
        },
        oauthToken: {
          present: Boolean(valid),
          storedAt: valid?.storedAt || null,
          environment: valid?.environment || envConfig.name,
          validUntilMidnightEt: "E*TRADE access tokens expire at midnight US Eastern Time",
        },
        upstreamAccounts: {
          count: accounts.length,
          accounts,
        },
        upstreamBalance: balance,
        lastError,
        timestamp: new Date().toISOString(),
      });
    }

    if (path === "/api/etrade/oauth/verifier" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      // #945 GitHub end-to-end PDP gate: completing the integration
      // connection (verifier exchange, which stores broker tokens)
      // requires integration:connect, same rule as the start route, including the #1749 legacy grace bound.
      // #1755: the four integration:connect gates share one PEP helper
      // (evaluateRoutePep) — same enforcement, same two 403 responses.
      const pep = await evaluateRoutePep({
        env,
        session,
        tenantId: resolveIaaaTenant(env),
        permission: "integration:connect",
        membershipStore: createKvMembershipStore(sessionStore(env)),
        permissionDenialStore: createKvPermissionDenialStore(sessionStore(env)),
        nowMs: Date.now(),
      });
      if (pep.enforced && !pep.allowed) {
        if (pep.graceExpired) {
          return Response.json({ error: "Legacy session PDP grace expired: re-login through wiring to restore gated actions.", code: "legacy_pdp_grace_expired" }, { status: 403 });
        }
        return Response.json({ error: "Authorization denied: integration:connect permission required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as any;
      const verifier = (body.verifier || "").trim();
      if (!verifier) return Response.json({ error: "Verifier PIN is required" }, { status: 400 });
      try {
        const tokens = await exchangeETradeVerifier(env, session.githubLogin, verifier, body.requestToken, body.requestTokenSecret, reqEnv);
        return Response.json({ success: true, environment: tokens.environment, storedAt: tokens.storedAt });
      } catch (err: any) {
        // Issue #3197: outcome code alongside the message, as on the
        // start route (BusinessError message is already the catalog
        // business message, never the raw upstream body).
        return Response.json({ error: err.message || "Failed to exchange verifier", code: err.code }, { status: 400 });
      }
    }

    if (path === "/api/etrade/oauth/renew" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      try {
        // Issue #2386: the renew failure reason is distinguished
        // BEFORE the renew call, from the same identity-aware seam
        // the renew itself reads — so a null renew maps to a real
        // cause instead of one generic 400. The pre-checks are
        // reads only; the renew call still owns the upstream
        // attempt and the write. (A token revoked or expired in
        // the gap between pre-check and renew still lands in the
        // upstream bucket; the next attempt's pre-check names it.)
        const identity = etradeIdentityFromSession(session);
        const stored = await getStoredTokens(env, session.githubLogin, reqEnv, identity);
        if (!stored) {
          const detail = renewFailureDetail("NO_TOKENS");
          return Response.json({ success: false, error: detail.message, code: detail.code }, { status: 400 });
        }
        if (isTokenExpiredEt(stored.storedAt)) {
          const detail = renewFailureDetail("TOKEN_EXPIRED");
          return Response.json({ success: false, error: detail.message, code: detail.code }, { status: 400 });
        }
        const envConfig = resolveEnvironmentConfig(env, reqEnv);
        if (!envConfig.etrade.apiKey || !envConfig.etrade.apiSecret) {
          const detail = renewFailureDetail("CREDENTIALS_MISSING");
          return Response.json({ success: false, error: detail.message, code: detail.code }, { status: 400 });
        }
        const renewed = await renewETradeAccessToken(env, session.githubLogin, reqEnv, identity);
        if (renewed) {
          return Response.json({ success: true, storedAt: renewed.storedAt });
        }
        const detail = renewFailureDetail("UPSTREAM_REJECTED");
        return Response.json({ success: false, error: detail.message, code: detail.code }, { status: 400 });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to renew token" }, { status: 500 });
      }
    }

    if (path === "/api/etrade/oauth/revoke" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      // Issue #2386: identity-aware revoke deletes the FULL resolved
      // key set (login + internal-id + alias); the result tells the
      // panel whether anything was actually deleted.
      const result = await revokeRemoteAccessToken(env, session.githubLogin, reqEnv, etradeIdentityFromSession(session));
      return Response.json(result);
    }

    // --- Public.com OAuth 2.1 Resource-Provider Lifecycle (issue #1247) ---
    // Public is a RESOURCE provider in the E*TRADE shape: tokens are
    // data-API credentials bound to the signed-in user, held in the
    // SessionStore (src/security/publicOAuth.ts), and never create a
    // login session. The pasted personal access token is the alternate
    // credential and stores through the same token-set record.
    if (path === "/auth/public/start") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      // Same #945 PDP gate as the E*TRADE start route, including the #1749 legacy grace bound.
      // #1755: the four integration:connect gates share one PEP helper
      // (evaluateRoutePep) — same enforcement, same two 403 responses.
      const pep = await evaluateRoutePep({
        env,
        session,
        tenantId: resolveIaaaTenant(env),
        permission: "integration:connect",
        membershipStore: createKvMembershipStore(sessionStore(env)),
        permissionDenialStore: createKvPermissionDenialStore(sessionStore(env)),
        nowMs: Date.now(),
      });
      if (pep.enforced && !pep.allowed) {
        if (pep.graceExpired) {
          return Response.json({ error: "Legacy session PDP grace expired: re-login through wiring to restore gated actions.", code: "legacy_pdp_grace_expired" }, { status: 403 });
        }
        return Response.json({ error: "Authorization denied: integration:connect permission required." }, { status: 403 });
      }
      try {
        const origin = new URL(request.url).origin;
        const { authorizeUrl } = await startPublicOAuth(env, session.githubLogin, origin);
        return Response.redirect(authorizeUrl, 302);
      } catch (err: any) {
        if (err instanceof PublicClientRejectedError) {
          return new Response(err.message, { status: 502 });
        }
        return new Response(
          "Could not start the Public.com sign-in: " + (err?.message || String(err)) +
            "\n\nYou can still connect with a personal access token (POST /api/public/connect).",
          { status: 502 }
        );
      }
    }

    if (path === "/auth/public/callback") {
      const session = await requireAuth(request, env);
      if (!session) return Response.redirect("/?error=unauthorized", 302);
      const errorParam = url.searchParams.get("error");
      if (errorParam) {
        const detail = url.searchParams.get("error_description") || errorParam;
        return Response.redirect(`/?tab=settings&public_error=${encodeURIComponent(detail)}`, 302);
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        return Response.redirect("/?tab=settings&public_error=missing_code_or_state", 302);
      }
      try {
        // The state is verified inside (session.ts primitives), and the
        // pending flow must belong to THIS session's login.
        const result = await completePublicOAuth(env, state, code, session.githubLogin);
        return Response.redirect(`/?tab=settings&public_connected=${result.toolCount}`, 302);
      } catch (err: any) {
        return Response.redirect(
          `/?tab=settings&public_error=${encodeURIComponent(err?.message || "exchange_failed")}`,
          302
        );
      }
    }

    if (path === "/api/public/status") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ connected: false });
      return Response.json(await getPublicConnectionStatus(env, session.githubLogin));
    }

    if (path === "/api/public/connect" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      // Same #945 PDP gate as the E*TRADE verifier route (this stores
      // a broker credential), including the #1749 legacy grace bound.
      // #1755: the four integration:connect gates share one PEP helper
      // (evaluateRoutePep) — same enforcement, same two 403 responses.
      const pep = await evaluateRoutePep({
        env,
        session,
        tenantId: resolveIaaaTenant(env),
        permission: "integration:connect",
        membershipStore: createKvMembershipStore(sessionStore(env)),
        permissionDenialStore: createKvPermissionDenialStore(sessionStore(env)),
        nowMs: Date.now(),
      });
      if (pep.enforced && !pep.allowed) {
        if (pep.graceExpired) {
          return Response.json({ error: "Legacy session PDP grace expired: re-login through wiring to restore gated actions.", code: "legacy_pdp_grace_expired" }, { status: 403 });
        }
        return Response.json({ error: "Authorization denied: integration:connect permission required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      const token = (body?.token || "").trim();
      if (!token) return Response.json({ error: "A personal access token is required." }, { status: 400 });
      try {
        // Verified against the MCP server before it is stored.
        const result = await connectPublicPersonalToken(env, session.githubLogin, token);
        return Response.json({ ok: true, toolCount: result.toolCount, tools: result.tools });
      } catch (err: any) {
        return Response.json(
          { error: "Public.com rejected that token: " + (err?.message || String(err)) },
          { status: 502 }
        );
      }
    }

    if (path === "/api/public/disconnect" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      await disconnectPublic(env, session.githubLogin);
      return Response.json({ ok: true });
    }
  return null;
}

/**
 * Slice 3 of Qunsultant/cfagent#2902 (Auth & IAAA) — moves only.
 * /api/me, /api/user/email-destination, /api/iaaa/overview and
 * /api/governance/seed-halt, verbatim and in original order.
 * Returns null when no branch matches, so handleFetch falls through to the
 * next delegation exactly as the inline chain did.
 */
export async function handleAuthMeRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
    // --- User Profile API ---
    if (path === "/api/me") {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ authenticated: false });
      }
      // Issue #3113 (#945 Q5): self-heal for pre-slice sessions —
      // mint a CSRF token cookie on this authenticated GET when the
      // request carries none, so the next mutation can carry it.
      const meCsrfCookie = ensureCsrfCookie(request);
      // #1274: login-provider display. Derived from the session's own
      // providerIssuer (set at wired login from the binding, never
      // from user input) via the provider registry — so a future
      // provider displays with only a registry entry. Legacy sessions
      // carry no internalUserId/providerIssuer, and unknown issuers
      // resolve to null, so the key is absent in both cases.
      const provider = session.internalUserId
        ? getProviderByIssuer(session.providerIssuer)
        : null;
      return Response.json({
        authenticated: true,
        login: session.githubLogin,
        name: session.githubName,
        avatar: session.githubAvatar,
        // #945 activation enabler (user-authorized): the caller's OWN
        // stable internal id, present only on wired sessions (legacy
        // sessions carry no internalUserId, so the key is absent for
        // them). requireAuth guarantees this is the caller's own
        // session; the id is an identifier, not a credential, and
        // knowing it grants nothing without a login as that user
        // plus the owner-controlled bootstrap env list. It lets the
        // owner read the exact bootstrap value after a wired login
        // instead of looking up their GitHub numeric subject.
        ...(session.internalUserId
          ? { internalUserId: session.internalUserId }
          : {}),
        ...(provider
          ? {
              provider: {
                id: provider.providerId,
                name: provider.displayName,
                issuer: provider.issuer,
              },
            }
          : {}),
      }, meCsrfCookie ? { headers: { "Set-Cookie": meCsrfCookie } } : undefined);
    }

    // Issue Qunsultant/cfagent#488 — per-user email destination as data.
    // GET/POST/DELETE /api/user/email-destination: the caller's OWN
    // screener email destination, stored in the SessionStore DO keyed by
    // the session's githubLogin (never from request input, so a caller
    // can only read or change their own record). Session-gated
    // (unauthenticated -> 401); the stored value outranks the
    // deployment-global SCREENER_EMAIL_TO / OPTIONS_EMAIL_TO at
    // delivery time (see src/services/userEmailDestination.ts). GET
    // reports only the stored value plus whether an env fallback exists
    // (names only — the global value itself is never returned).
    if (path === "/api/user/email-destination") {
      const session = await requireAuth(request, env);
      if (!session || !session.githubLogin) {
        return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      }
      const store = createUserEmailDestinationStore(sessionStore(env));
      const fallbackConfigured = Boolean(
        (env as unknown as Record<string, unknown>).OPTIONS_EMAIL_TO ||
          (env as unknown as Record<string, unknown>).SCREENER_EMAIL_TO
      );
      if (request.method === "GET") {
        try {
          const stored = await store.get(session.githubLogin);
          return Response.json({ email: stored, fallbackConfigured });
        } catch {
          return Response.json({ error: "Failed to read email destination." }, { status: 500 });
        }
      }
      if (request.method === "POST") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
        }
        const email = (body as { email?: unknown } | null)?.email;
        const normalized = normalizeEmailDestination(email);
        if (!normalized.ok) return Response.json({ error: normalized.error }, { status: 400 });
        try {
          const record = await store.set(session.githubLogin, normalized.email, session.githubLogin);
          return Response.json({ email: record.email, fallbackConfigured });
        } catch {
          return Response.json({ error: "Failed to save email destination." }, { status: 500 });
        }
      }
      if (request.method === "DELETE") {
        try {
          await store.clear(session.githubLogin);
          return Response.json({ email: null, fallbackConfigured });
        } catch {
          return Response.json({ error: "Failed to clear email destination." }, { status: 500 });
        }
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // --- IAAA Admin overview (issue #945, IAAA-UI v1: READ-ONLY) ---
    // GET /api/iaaa/overview: the caller's own memberships, the
    // tenant's platform-genesis status, recent tenant audit
    // events, and (#2173 admin-counts slice) system-wide admin
    // counts from the membership records. Gating is fail-closed
    // and server-side (see iaaaAdminOverview.ts): unauthenticated
    // → 401; legacy session (no internalUserId) or wired non-admin
    // → 403 with NO data; only a live platform-admin membership
    // returns 200. Counts are counts only — no member identities
    // (the existing GET /api/iaaa/memberships listing is the
    // surface that exposes identities to platform admins). The
    // counts list reuses that route's list-all source, so a
    // corrupt record is skipped, never fatal; an unavailable
    // listing answers 500 with a generic error and no partial
    // data. This route performs no store write of any kind.
    if (path === "/api/iaaa/overview") {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      }
      if (request.method !== "GET") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      if (!session.internalUserId) {
        return Response.json({ error: "Forbidden: IAAA admin access requires a wired session." }, { status: 403 });
      }
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
        if (!overview.allowed) {
          return Response.json({ error: "Forbidden: IAAA admin access requires platform-admin membership." }, { status: 403 });
        }
        const entries = await listSessionFamilyEntries(env, "iaaa-membership:");
        if (!entries) {
          return Response.json({ error: "IAAA admin overview unavailable." }, { status: 500 });
        }
        const adminCounts = computeAdminCounts(
          listMembershipsFromEntries(entries),
          Date.now(),
        );
        return Response.json({ ...overview, adminCounts });
      } catch {
        return Response.json({ error: "IAAA admin overview unavailable." }, { status: 500 });
      }
    }

    // --- Governance halt seed (issue #1559, slice-0 cutover) ---
    // POST /api/governance/seed-halt: the one-time cutover seed
    // for the AgentDB halt mirror. Gating reuses the IAAA admin
    // pattern exactly (requireAuth → wired session → live
    // platform-admin membership, fail-closed, no data on 403).
    // The seed runs on the shared Orchestrator instance, whose
    // mas_settings holds the canonical kill switch; it writes
    // the mirror row only, never the DO setting, and a second
    // run returns seeded:false with the same state. No boot
    // logic, no auto-run on deploy or tick.
    if (path === "/api/governance/seed-halt") {
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
          return Response.json({ error: "Governance seed unavailable." }, { status: 500 });
        }
      }
      const stub = actorGateway.stub<{
        seedGovernanceHalt(
          setBy: string,
          tenantId: string,
        ): Promise<{ seeded: boolean; state: GovernedHaltState }>;
      }>(env.ORCHESTRATOR_AGENT, SHARED_ORCHESTRATOR_INSTANCE);
      return handleSeedGovernanceRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId: resolveIaaaTenant(env),
        runSeed: ({ tenantId, setBy }) => stub.seedGovernanceHalt(setBy, tenantId),
      });
    }
  return null;
}

/**
 * Slice 3 of Qunsultant/cfagent#2902 (Auth & IAAA) — moves only.
 * The IAAA lifecycle of handleFetch, verbatim and in original order:
 * /api/iaaa/access-request* (+ decision), the membership / permission /
 * role-grant / logged-in-users / quota-usage / policy-proposal /
 * bootstrap-proposal lifecycle block, and /api/api-keys (+ /api/api-keys/*).
 * Returns null when no branch matches, so handleFetch falls through to the
 * next delegation exactly as the inline chain did.
 */
export async function handleAuthIaaaRoutes(request: Request, env: Env, url: URL, path: string): Promise<Response | null> {
    // --- Access requests (issue #1274): request access + admin decide.
    // A signed-in member asks for tenant-admin; an admin approves or
    // denies. Requests NEVER auto-grant: approval calls grantMembership
    // (with its canGrantRole enforcement), and the approval is
    // idempotent — a requester who already holds tenant-admin is
    // marked approved without a duplicate grant. Gating is fail-closed:
    // 401 unauthenticated; 403 legacy sessions, callers with no active
    // membership in the tenant (create), and callers who cannot grant
    // the requested role (list/decide). Only tenant-admin may be
    // requested in this cut; platform-admin requests are 400.
    if (
      path === "/api/iaaa/access-request" ||
      path === "/api/iaaa/access-requests" ||
      path === "/api/iaaa/access-request/decision"
    ) {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      }
      if (!session.internalUserId) {
        return Response.json({ error: "Forbidden: access requests require a wired session." }, { status: 403 });
      }
      const tenantId = resolveIaaaTenant(env);
      const membershipStore = wiredMembershipStore(env);
      const requestStore = wiredAccessRequestStore(env);
      const nowMs = Date.now();
      const callerHasActiveMembership = async (): Promise<boolean> => {
        const memberships = await membershipStore.getMembershipsByUser(session.internalUserId as string);
        return memberships.some(
          (m) =>
            m.tenantId === tenantId &&
            m.revokedAtMs === undefined &&
            m.roleBindings.some((b) => b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
        );
      };
      try {
        if (path === "/api/iaaa/access-request") {
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          if (!(await callerHasActiveMembership())) {
            return Response.json({ error: "Forbidden: access requests require an active membership." }, { status: 403 });
          }
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          const requestedRole = typeof body?.requestedRole === "string" ? body.requestedRole : "";
          const created = await requestStore.create({
            requesterInternalUserId: session.internalUserId,
            requestedRole,
            tenantId,
            nowMs,
          });
          if (!created.ok && created.code === "INVALID_ROLE") {
            return Response.json({ error: "Only tenant-admin may be requested." }, { status: 400 });
          }
          if (!created.ok && created.code === "ALREADY_PENDING") {
            return Response.json({ error: "A pending request for this role already exists.", request: created.request }, { status: 409 });
          }
          if (!created.ok) {
            return Response.json({ error: "Access request could not be created." }, { status: 400 });
          }
          return Response.json({ ok: true, request: created.request }, { status: 201 });
        }
        if (path === "/api/iaaa/access-requests") {
          if (request.method !== "GET") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const grantCheck = await canGrantRole(membershipStore, {
            granterInternalUserId: session.internalUserId,
            targetTenantId: tenantId,
            targetScope: "tenant",
            targetRole: "tenant-admin",
            nowMs,
          });
          if (grantCheck.decision === "deny") {
            return Response.json({ error: "Forbidden: listing access requests requires tenant-admin." }, { status: 403 });
          }
          return Response.json({ ok: true, requests: await requestStore.list() });
        }
        // POST /api/iaaa/access-request/decision
        if (request.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        const requestId = typeof body?.requestId === "string" ? body.requestId : "";
        const decision = body?.decision === "approve" || body?.decision === "deny" ? body.decision : "";
        if (requestId === "" || decision === "") {
          return Response.json({ error: "requestId and decision (approve|deny) are required." }, { status: 400 });
        }
        const existing = await requestStore.get(requestId);
        if (!existing) {
          return Response.json({ error: "Access request not found." }, { status: 404 });
        }
        const grantCheck = await canGrantRole(membershipStore, {
          granterInternalUserId: session.internalUserId,
          targetTenantId: tenantId,
          targetScope: "tenant",
          targetRole: existing.requestedRole,
          nowMs,
        });
        if (grantCheck.decision === "deny") {
          return Response.json({ error: "Forbidden: deciding access requests requires tenant-admin." }, { status: 403 });
        }
        if (existing.status !== "pending") {
          return Response.json({ error: "Access request is no longer pending.", request: existing }, { status: 409 });
        }
        // Issue #3113 (#945 Q5): an approval that grants is a
        // privilege change — its rotation runs below, after decide.
        let approvedGrant = false;
        if (decision === "approve") {
          const targetMemberships = await membershipStore.getMembershipsByUser(existing.requesterInternalUserId);
          const alreadyAdmin = targetMemberships.some(
            (m) =>
              m.tenantId === tenantId &&
              m.revokedAtMs === undefined &&
              m.roleBindings.some(
                (b) => b.role === "tenant-admin" && (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
              ),
          );
          if (!alreadyAdmin) {
            // Issue #3155 (Q9): an approval needs two distinct
            // approvers. The first approve records the approver
            // and leaves the request pending (no grant, no
            // rotation); the second approve grants and decides.
            // A third distinct approver can still unblock a
            // request whose grant was denied after two approvals.
            const approval = await requestStore.recordApprover(
              requestId,
              session.internalUserId as string,
              nowMs,
            );
            if (!approval.ok) {
              return Response.json(
                {
                  error:
                    approval.code === "ALREADY_APPROVER"
                      ? "This admin already approved this request."
                      : "Access request is no longer pending.",
                },
                { status: 409 },
              );
            }
            if (approval.approverCount < 2) {
              return Response.json({
                ok: true,
                pendingSecondApproval: true,
                request: approval.request,
              });
            }
            const granted = await grantMembership(membershipStore, {
              granterInternalUserId: session.internalUserId,
              internalUserId: existing.requesterInternalUserId,
              tenantId,
              roleBindings: [{ role: existing.requestedRole, scope: "tenant", grantedBy: session.internalUserId }],
              nowMs,
              defaultExpiryDays: resolveGrantDefaultExpiryDays(env.IAAA_GRANT_DEFAULT_EXPIRY_DAYS),
            });
            if (!granted.ok) {
              return Response.json({ error: "Forbidden: grant denied." }, { status: 403 });
            }
            approvedGrant = true;
          }
        }
        const decided = await requestStore.decide(requestId, decision === "approve" ? "approved" : "denied", session.internalUserId, nowMs);
        if (!decided.ok) {
          return Response.json({ error: "Access request is no longer pending." }, { status: 409 });
        }
        // Issue #3113 (#945 Q5): an approval-grant rotates the
        // requester's active sessions (old ids dead). A denial or
        // an already-admin no-op changes nothing and rotates nothing.
        let approveRotationCount = 0;
        let approveRotationUnavailable = false;
        let approveRotationCookie: string | null = null;
        if (approvedGrant) {
          const approveRotation = await rotateUserSessionsForEnv(env, existing.requesterInternalUserId, nowMs);
          approveRotationCount = approveRotation.rotated.length;
          approveRotationUnavailable = approveRotation.unavailable;
          if (approveRotation.unavailable) {
            console.warn("[iaaa] session rotation skipped: session listing unavailable");
          }
          approveRotationCookie = sessionRotationCookie(request, approveRotation);
        }
        return Response.json(
          { ok: true, request: decided.request, sessionRotation: { rotatedCount: approveRotationCount, unavailable: approveRotationUnavailable } },
          approveRotationCookie ? { headers: { "Set-Cookie": approveRotationCookie } } : undefined,
        );
      } catch {
        return Response.json({ error: "Access requests unavailable." }, { status: 500 });
      }
    }

    // --- IAAA lifecycle wiring (issue #1758, #1717): grants, revokes,
    // membership edit + list, self-service deactivation, admin offboarding.
    //
    // What was module-only before this slice, and is now callable:
    // - grantMembership (#945 machinery, previously no route) via POST
    //   /api/iaaa/membership/grant. The approvals flow itself was
    //   already wired by #1274 (access-request create/list/decide);
    //   this slice does NOT rebuild it — the panel's decide buttons
    //   keep calling that flow, and this grant route is the direct
    //   admin path for grants without a request.
    // - MembershipStore list-all (F-21) via GET /api/iaaa/memberships,
    //   backed by the sessions-namespace listing (the same listing
    //   the session registry uses); revoke + edit via POST
    //   /api/iaaa/membership/revoke and /edit.
    // - Self-service deactivation (F-17) via POST /api/iaaa/deactivate
    //   and admin offboarding via POST /api/iaaa/offboard, both
    //   running offboard+verify (iaaaLifecycleWiring.ts) over the
    //   session registry — the caller never supplies session ids.
    //
    // Gates (fail-closed, in order): requireAuth session (401);
    // wired session with internalUserId (403 for legacy sessions,
    // which carry no Slice 1 identity to revoke by); then the
    // route's admin gate. Grant/revoke gates run through the #1751
    // obligation channel (evaluateWithObligations): role:assign
    // carries step-up + audit-before-allow, membership:revoke
    // carries audit-before-allow, and a denied obligation denies
    // the route — the grantMembership canGrantRole check then
    // re-enforces the same rule at the store call. NO SELF-GRANT:
    // a caller can never grant or edit their own membership
    // through these routes, for any role, even one they already
    // hold — elevation of oneself goes through another admin.
    // Platform-admin is NOT a tenant superuser (Slice 3 policy):
    // a platform-admin grants platform-scope roles only, and a
    // tenant-admin grants tenant/workspace roles only; the panel
    // gate (platform-admin) therefore does not by itself authorize
    // tenant grants — the caller must hold the granting role in
    // scope. Membership revoke deliberately does NOT delete the
    // principal's sessions (#1750 semantics: the PDP denies on
    // its next fresh read once the membership is revoked; session
    // termination is offboarding, not revocation).
    // Deactivation/offboarding responses are 200 with the full
    // report even when verification fails: the revocation already
    // happened, and a 500 would hide exactly the report that names
    // what remains. The caller checks `verified`, not just status.
    if (
      path === "/api/iaaa/membership/grant" ||
      path === "/api/iaaa/membership/revoke" ||
      path === "/api/iaaa/membership/edit" ||
      path === "/api/iaaa/permission/deny" ||
      path === "/api/iaaa/permission/clear" ||
      path === "/api/iaaa/role-grants" ||
      path === "/api/iaaa/role-grants/grant" ||
      path === "/api/iaaa/role-grants/revoke" ||
      path === "/api/iaaa/logged-in-users" ||
      path === "/api/iaaa/logged-in-users/revoke" ||
      path === "/api/iaaa/quota-usage" ||
      path === "/api/iaaa/quota-usage/override" ||
      path === "/api/iaaa/policy-proposals" ||
      path === "/api/iaaa/policy-proposals/active" ||
      path === "/api/iaaa/policy-proposals/propose" ||
      path === "/api/iaaa/policy-proposals/approve" ||
      path === "/api/iaaa/policy-proposals/reject" ||
      path === "/api/iaaa/policy-proposals/promote" ||
      path === "/api/iaaa/policy-proposals/preview" ||
      path === "/api/iaaa/bootstrap-proposals" ||
      path === "/api/iaaa/bootstrap-proposals/current" ||
      path === "/api/iaaa/bootstrap-proposals/propose" ||
      path === "/api/iaaa/bootstrap-proposals/approve" ||
      path === "/api/iaaa/bootstrap-proposals/reject" ||
      path === "/api/iaaa/bootstrap-proposals/confirm-applied" ||
      path === "/api/iaaa/memberships" ||
      path === "/api/iaaa/deactivate" ||
      path === "/api/iaaa/offboard"
    ) {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      }
      if (!session.internalUserId) {
        return Response.json({ error: "Forbidden: lifecycle actions require a wired session." }, { status: 403 });
      }
      const tenantId = resolveIaaaTenant(env);
      const membershipStore = wiredMembershipStore(env);
      const kv = sessionStore(env);
      const nowMs = Date.now();
      const callerMemberships = await membershipStore.getMembershipsByUser(session.internalUserId);
      const callerIsPlatformAdmin = isPlatformAdmin(callerMemberships, nowMs);
      const callerCanGrantTenantAdmin = async (): Promise<boolean> => {
        const check = await canGrantRole(membershipStore, {
          granterInternalUserId: session.internalUserId as string,
          targetTenantId: tenantId,
          targetScope: "tenant",
          targetRole: "tenant-admin",
          nowMs,
        });
        return check.decision === "allow";
      };
      const wiredAuditWriter = (permission: "role:assign" | "membership:revoke"): ObligationAuditWriter => {
        return async (event) => {
          const result = await recordAuditEvent(createWiredAuditStore(env), {
            timestamp: event.nowMs,
            type: "iaaa.lifecycle",
            actorPrincipalId: event.principalId,
            actorType: "human",
            initiatingPrincipalId: event.principalId,
            tenantId: event.tenantId,
            correlationId: crypto.randomUUID(),
            action: permission,
            decision: "allow",
            policyVersion: IAAA_AUDIT_POLICY_VERSION,
            outcome: "succeeded",
          });
          return result.ok;
        };
      };
      // #2450: audit writer for permission-deny actions. Mirrors
      // wiredAuditWriter, but records the deny action itself
      // ("permission:deny" / "permission:clear") instead of the
      // role:assign permission the obligation channel evaluates.
      // The obligation evaluation still runs on role:assign (the
      // manager's authority + step-up), while the audit record
      // names the action actually taken.
      const denyAuditWriter = (action: "permission:deny" | "permission:clear"): ObligationAuditWriter => {
        return async (event) => {
          const result = await recordAuditEvent(createWiredAuditStore(env), {
            timestamp: event.nowMs,
            type: "iaaa.lifecycle",
            actorPrincipalId: event.principalId,
            actorType: "human",
            initiatingPrincipalId: event.principalId,
            tenantId: event.tenantId,
            correlationId: crypto.randomUUID(),
            action,
            decision: "allow",
            policyVersion: IAAA_AUDIT_POLICY_VERSION,
            outcome: "succeeded",
          });
          return result.ok;
        };
      };
      const offboardAudit = async (action: string, actor: string, tenant: string, atMs: number): Promise<boolean> => {
        const result = await recordAuditEvent(createWiredAuditStore(env), {
          timestamp: atMs,
          type: "iaaa.lifecycle",
          actorPrincipalId: actor,
          actorType: "human",
          initiatingPrincipalId: actor,
          tenantId: tenant,
          correlationId: crypto.randomUUID(),
          action,
          decision: "allow",
          policyVersion: IAAA_AUDIT_POLICY_VERSION,
          outcome: "succeeded",
        });
        return result.ok;
      };
      // #2688 — best-effort deny audit for role-grant denials.
      // Allows keep the obligation channel's audit-before-allow;
      // denials are recorded here so a refused grant, revoke, or
      // list is attributable (grantor, grantee, role, tenant,
      // timestamp) without ever converting a deny into an allow:
      // a failed audit write leaves the deny standing.
      const roleGrantDenyAudit = async (action: string, tenant: string): Promise<void> => {
        try {
          await recordAuditEvent(createWiredAuditStore(env), {
            timestamp: nowMs,
            type: "iaaa.lifecycle",
            actorPrincipalId: session.internalUserId as string,
            actorType: "human",
            initiatingPrincipalId: session.internalUserId as string,
            tenantId: tenant,
            correlationId: crypto.randomUUID(),
            action,
            decision: "deny",
            policyVersion: IAAA_AUDIT_POLICY_VERSION,
            outcome: "failed",
            errorCode: "ROLE_GRANT_DENIED",
          });
        } catch {
          /* denial attribution is best-effort; the deny stands */
        }
      };
      // #2836 — best-effort deny audit for logged-in-users
      // denials. Mirrors roleGrantDenyAudit: a failed audit
      // write leaves the deny standing, never converts it.
      const loggedInUsersDenyAudit = async (action: string, tenant: string): Promise<void> => {
        try {
          await recordAuditEvent(createWiredAuditStore(env), {
            timestamp: nowMs,
            type: "iaaa.lifecycle",
            actorPrincipalId: session.internalUserId as string,
            actorType: "human",
            initiatingPrincipalId: session.internalUserId as string,
            tenantId: tenant,
            correlationId: crypto.randomUUID(),
            action,
            decision: "deny",
            policyVersion: IAAA_AUDIT_POLICY_VERSION,
            outcome: "failed",
            errorCode: "LOGGED_IN_USERS_DENIED",
          });
        } catch {
          /* denial attribution is best-effort; the deny stands */
        }
      };
      const offboardDeps = () => ({
        sessions: {
          async list() {
            const entries = await listSessionFamilyEntries(env, "");
            // A null listing means the registry cannot see sessions:
            // fail closed (500) rather than offboarding against an
            // empty list and claiming success.
            if (!entries) throw new Error("session listing unavailable");
            return parseSessionRegistryEntries(entries);
          },
          async delete(sessionId: string) {
            await deleteSession(env, sessionId);
          },
        },
        memberships: membershipStore,
        delegations: null,
        apiKeys: {
          async list(login: string) {
            return (await listApiKeys(env, login)).map((k) => k.id);
          },
          async revoke(login: string, keyId: string) {
            return revokeApiKey(env, login, keyId);
          },
        },
        etrade: {
          async revoke(login: string) {
            // Upstream revoke + stored-token deletion (revokeRemote
            // still deletes stored tokens when the upstream call
            // fails, so a network failure never leaves local tokens
            // live; it is recorded only as a step outcome upstream).
            await revokeRemoteAccessToken(env, login);
          },
          async hasTokens(login: string) {
            // #2434 (step 5c): the token listing goes through
            // the token family's listing seam (port-composed
            // when TOKEN_PORTS_ENABLED is on).
            const entries = await listTokenFamilyEntries(env, "etrade:token:");
            // Cannot prove absence when the listing is unavailable:
            // fail closed to "tokens present" so verification fails
            // visibly instead of passing on an unknown store state.
            if (!entries) return true;
            return entries.some((entry) => {
              const parts = entry.key.split(":");
              return parts[parts.length - 1].toLowerCase() === login.toLowerCase();
            });
          },
        },
        suppression: {
          async set(userId: string, atMs: number) {
            await setMailSuppression(kv, userId, atMs);
          },
          async isSet(userId: string) {
            return isMailSuppressed(kv, userId);
          },
        },
        audit: {
          async emit(input: { action: string; actorInternalUserId: string; tenantId: string; nowMs: number; correlationId: string }) {
            return offboardAudit(input.action, input.actorInternalUserId, input.tenantId, input.nowMs);
          },
        },
        invalidateSession: (sessionId: string) => invalidateSessionCache(sessionId),
      });
      try {
        if (path === "/api/iaaa/memberships") {
          if (request.method !== "GET") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          if (!callerIsPlatformAdmin && !(await callerCanGrantTenantAdmin())) {
            return Response.json({ error: "Forbidden: listing memberships requires admin access." }, { status: 403 });
          }
          const entries = await listSessionFamilyEntries(env, "iaaa-membership:");
          if (!entries) {
            return Response.json({ error: "Membership listing unavailable." }, { status: 500 });
          }
          const all = listMembershipsFromEntries(entries);
          const memberships = callerIsPlatformAdmin
            ? all
            : all.filter((m) => m.tenantId === tenantId);
          return Response.json({ ok: true, memberships });
        }
        // #2688 — dedicated admin-grant surface. Distinct from the
        // #1758 membership routes in three ways: (1) only
        // platform-admin / tenant-admin bindings are listed or
        // touched, flattened per binding with grantor + grant
        // time; (2) revoke removes ONE binding, preserving sibling
        // bindings on the same membership; (3) tenant-admins are
        // first-class callers here (their own tenant, tenant-scope
        // grants only) — the IAAA panel's platform gate never
        // admitted them to a grant UI. Gates are the shared ones:
        // canGrantRole for grant and revoke, the route-level
        // self-grant refusal for grants, and the #1751 obligation
        // channel (step-up + audit-before-allow for role:assign,
        // audit-before-allow for membership:revoke, with the
        // documented platform-scope audit-before-revoke exception
        // for platform grants). A platform-admin is NOT a tenant
        // superuser: granting tenant-admin additionally requires
        // role:assign in that tenant, exactly as canGrantRole
        // decides — the issue body's shorthand does not widen it.
        if (path === "/api/iaaa/role-grants") {
          if (request.method !== "GET") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const canListTenant = await callerCanGrantTenantAdmin();
          if (!callerIsPlatformAdmin && !canListTenant) {
            await roleGrantDenyAudit("role_grant.list", tenantId);
            return Response.json({ error: "Forbidden: listing role grants requires admin access." }, { status: 403 });
          }
          // Issue #3155 (Q9): ?review=true returns the
          // granter-review queue instead of the grant list.
          // Revocation is judged over the FULL membership set
          // (a granter with a live membership anywhere is not
          // revoked); the returned queue is then filtered to
          // what this caller may see, mirroring the list below.
          if (new URL(request.url).searchParams.get("review") === "true") {
            const reviewEntries = await listSessionFamilyEntries(env, "iaaa-membership:");
            if (!reviewEntries) {
              return Response.json({ error: "Role-grant listing unavailable." }, { status: 500 });
            }
            const reviewQueue = listGrantsForReview(listMembershipsFromEntries(reviewEntries), nowMs);
            return Response.json({
              ok: true,
              reviewQueue: callerIsPlatformAdmin
                ? reviewQueue
                : reviewQueue.filter((q) => q.tenantId === tenantId),
            });
          }
          const entries = await listSessionFamilyEntries(env, "iaaa-membership:");
          if (!entries) {
            return Response.json({ error: "Role-grant listing unavailable." }, { status: 500 });
          }
          const all = listMembershipsFromEntries(entries);
          const visible = callerIsPlatformAdmin
            ? all
            : all.filter((m) => m.tenantId === tenantId);
          const grants = flattenRoleGrants(visible).filter(
            (g) => callerIsPlatformAdmin || g.scope === "tenant",
          );
          // Identity enrichment, best-effort: issuer:subject from
          // the binding user-index (never invented — a user with
          // no binding entry lists with identity null), plus the
          // grantee email captured at grant time (#2661).
          const identityByUser = new Map<string, string>();
          const emailByMembership = new Map<string, string>();
          for (const m of visible) {
            if (m.email) emailByMembership.set(m.membershipId, m.email);
          }
          const bindingEntries = await listSessionFamilyEntries(env, "iaaa-binding:user:");
          if (bindingEntries) {
            for (const entry of bindingEntries) {
              try {
                const parsed = JSON.parse(entry.value) as {
                  internalUserId?: unknown;
                  providerIssuer?: unknown;
                  providerSubject?: unknown;
                };
                if (
                  typeof parsed.internalUserId === "string" &&
                  typeof parsed.providerIssuer === "string" &&
                  typeof parsed.providerSubject === "string" &&
                  !identityByUser.has(parsed.internalUserId)
                ) {
                  identityByUser.set(
                    parsed.internalUserId,
                    `${parsed.providerIssuer}:${parsed.providerSubject}`,
                  );
                }
              } catch {
                continue;
              }
            }
          }
          return Response.json({
            ok: true,
            grants: grants.map((g) => ({
              ...g,
              identity: identityByUser.get(g.internalUserId) ?? null,
              email: emailByMembership.get(g.membershipId) ?? null,
            })),
          });
        }
        if (path === "/api/iaaa/role-grants/grant") {
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          const targetId = typeof body?.internalUserId === "string" ? body.internalUserId.trim() : "";
          const role = typeof body?.role === "string" ? body.role.trim() : "";
          const requestedTenant = typeof body?.tenantId === "string" ? body.tenantId.trim() : undefined;
          if (targetId === "" || role === "") {
            return Response.json({ error: "internalUserId and role are required." }, { status: 400 });
          }
          const emailRaw = typeof body?.email === "string" ? body.email.trim() : "";
          const granteeEmail = emailRaw === "" ? undefined : emailRaw;
          if (granteeEmail !== undefined && (granteeEmail.length > 512 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(granteeEmail))) {
            return Response.json({ error: "email must be a valid email address." }, { status: 400 });
          }
          const validated = validateRoleGrantRequest({
            granterInternalUserId: session.internalUserId as string,
            targetInternalUserId: targetId,
            role,
            tenantId: requestedTenant,
            resolvedTenantId: tenantId,
          });
          if (!validated.ok) {
            await roleGrantDenyAudit("role:assign", tenantId);
            return Response.json(
              { error: validated.error, code: validated.code },
              { status: validated.code === "SELF_GRANT" ? 403 : 400 },
            );
          }
          // Idempotent no-op, mirroring the membership grant
          // route: a live covering binding is returned, not
          // duplicated — after the same canGrantRole check, so a
          // non-granter learns nothing beyond a denial.
          const existingLive = await membershipStore.getMembershipsByUser(targetId);
          const covering = existingLive.find(
            (m) =>
              m.tenantId === validated.tenantId &&
              m.revokedAtMs === undefined &&
              m.roleBindings.some(
                (b) =>
                  b.role === validated.role &&
                  b.scope === validated.scope &&
                  (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
              ),
          );
          if (covering) {
            const check = await canGrantRole(membershipStore, {
              granterInternalUserId: session.internalUserId as string,
              targetTenantId: validated.tenantId,
              targetScope: validated.scope,
              targetRole: validated.role,
              nowMs,
            });
            if (check.decision === "deny") {
              await roleGrantDenyAudit("role:assign", validated.tenantId);
              return Response.json(
                { error: "Forbidden: grant denied.", code: check.reason, reason: check.reason },
                { status: 403 },
              );
            }
            const index = covering.roleBindings.findIndex(
              (b) => b.role === validated.role && b.scope === validated.scope,
            );
            return Response.json({
              ok: true,
              grant: toRoleGrantView(covering, index),
              alreadyGranted: true,
            });
          }
          // #3102 (#945 Q4): a real grant (past the idempotent
          // no-op check above) requires fresh authentication
          // inside the 5-minute privileged-role-assignment window.
          // This gate is tighter than the #1751 obligation default
          // (15 min), so the tighter window governs; wiring OFF
          // keeps legacy behavior.
          if (requiresStepUpForAction(session, "privileged-role-assignment", isWiringEnabled(env), nowMs)) {
            return Response.json({ error: "Step-up authentication required: please sign in again and retry." }, { status: 403 });
          }
          const evaluated = await evaluateWithObligations(membershipStore, {
            internalUserId: session.internalUserId,
            tenantId: validated.tenantId,
            permission: "role:assign",
            scope: validated.scope,
            nowMs,
            authTimeMs: session.authTimeMs,
            audit: wiredAuditWriter("role:assign"),
          });
          if (evaluated.decision === "deny") {
            await roleGrantDenyAudit("role:assign", validated.tenantId);
            return Response.json(
              { error: "Forbidden: grant denied.", code: evaluated.reason, reason: evaluated.reason },
              { status: 403 },
            );
          }
          // Issue #3155 (Q9): this surface grants admin roles
          // only, so every grant here needs two distinct
          // approvers — the first proposes (202, pending), the
          // second's identical grant confirms and mints below.
          // Both approvers pass the obligation chain above, on
          // their own calls.
          {
            const proposalStore = createGrantProposalStore(kv);
            const resolved = await resolveAdminGrantProposal(proposalStore, {
              kind: "grant",
              granteeInternalUserId: targetId,
              tenantId: validated.tenantId,
              roleBindings: [{ role: validated.role, scope: validated.scope }],
              callerInternalUserId: session.internalUserId as string,
              nowMs,
            });
            if (resolved.action !== "confirm") {
              return Response.json(
                {
                  ok: true,
                  pending: true,
                  proposalId: resolved.proposal.proposalId,
                  approvers: resolved.proposal.approvers,
                },
                { status: 202 },
              );
            }
          }
          const granted = await grantMembership(membershipStore, {
            granterInternalUserId: session.internalUserId,
            internalUserId: targetId,
            tenantId: validated.tenantId,
            roleBindings: [
              {
                role: validated.role,
                scope: validated.scope,
                grantedBy: session.internalUserId as string,
              },
            ],
            nowMs,
            defaultExpiryDays: resolveGrantDefaultExpiryDays(env.IAAA_GRANT_DEFAULT_EXPIRY_DAYS),
            ...(granteeEmail !== undefined ? { email: granteeEmail } : {}),
          });
          if (!granted.ok) {
            await roleGrantDenyAudit("role:assign", validated.tenantId);
            return Response.json(
              { error: granted.error, code: granted.code },
              { status: granted.code === "GRANT_DENIED" ? 403 : 400 },
            );
          }
          // Issue #3113 (#945 Q5): a real grant rotates the
          // affected user's active sessions (old ids dead);
          // re-issue the acting session's cookie when it rotated.
          // Counts only, never ids, in the response.
          const grantRotation = await rotateUserSessionsForEnv(env, targetId, nowMs);
          if (grantRotation.unavailable) {
            console.warn("[iaaa] session rotation skipped: session listing unavailable");
          }
          const grantRotationCookie = sessionRotationCookie(request, grantRotation);
          return Response.json(
            {
              ok: true,
              grant: toRoleGrantView(granted.membership, 0),
              sessionRotation: { rotatedCount: grantRotation.rotated.length, unavailable: grantRotation.unavailable },
            },
            { status: 201, ...(grantRotationCookie ? { headers: { "Set-Cookie": grantRotationCookie } } : {}) },
          );
        }
        if (path === "/api/iaaa/role-grants/revoke") {
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          const membershipId = typeof body?.membershipId === "string" ? body.membershipId.trim() : "";
          const bindingIndex = typeof body?.bindingIndex === "number" ? body.bindingIndex : -1;
          if (membershipId === "" || !Number.isInteger(bindingIndex) || bindingIndex < 0) {
            return Response.json({ error: "membershipId and a non-negative integer bindingIndex are required." }, { status: 400 });
          }
          const record = await readMembershipById(kv, membershipId);
          if (!record) {
            return Response.json({ error: "Membership not found." }, { status: 404 });
          }
          if (record.revokedAtMs !== undefined) {
            return Response.json({ ok: true, grantId: `${membershipId}:${bindingIndex}`, alreadyRevoked: true });
          }
          const view = toRoleGrantView(record, bindingIndex);
          if (!view) {
            return Response.json({ error: "No admin grant at that binding index." }, { status: 400 });
          }
          const revokable = await canRevokeRoleGrant(membershipStore, {
            revokerInternalUserId: session.internalUserId as string,
            grant: view,
            nowMs,
          });
          if (revokable.decision === "deny") {
            await roleGrantDenyAudit("membership:revoke", record.tenantId);
            return Response.json(
              { error: "Forbidden: revoke denied.", code: revokable.reason, reason: revokable.reason },
              { status: 403 },
            );
          }
          if (view.scope === "platform") {
            // Same platform-scope exception as the membership
            // revoke route: PDP platform grants carry no
            // membership:revoke, so a platform-scope revoke is
            // gated on live platform-admin + audit BEFORE the
            // revoke, failing closed on audit failure.
            if (!callerIsPlatformAdmin) {
              await roleGrantDenyAudit("membership:revoke", record.tenantId);
              return Response.json({ error: "Forbidden: revoking a platform grant requires platform-admin." }, { status: 403 });
            }
            const audited = await offboardAudit("membership:revoke", session.internalUserId, record.tenantId, nowMs);
            if (!audited) {
              return Response.json({ error: "Forbidden: audit-before-revoke failed.", code: "AUDIT_FAILED" }, { status: 403 });
            }
          } else {
            const evaluated = await evaluateWithObligations(membershipStore, {
              internalUserId: session.internalUserId,
              tenantId: record.tenantId,
              permission: "membership:revoke",
              scope: "tenant",
              nowMs,
              audit: wiredAuditWriter("membership:revoke"),
            });
            if (evaluated.decision === "deny") {
              await roleGrantDenyAudit("membership:revoke", record.tenantId);
              return Response.json(
                { error: "Forbidden: revoke denied.", code: evaluated.reason, reason: evaluated.reason },
                { status: 403 },
              );
            }
          }
          const removed = removeRoleBinding(record, bindingIndex);
          if (!removed.ok) {
            return Response.json({ error: removed.error, code: removed.code }, { status: 400 });
          }
          if (removed.emptied) {
            await membershipStore.revokeMembership(membershipId, nowMs);
          } else {
            await membershipStore.put(removed.membership);
          }
          // Issue #3113 (#945 Q5): a real revoke rotates the
          // affected user's active sessions (old ids dead).
          const revokeRotation = await rotateUserSessionsForEnv(env, record.internalUserId, nowMs);
          if (revokeRotation.unavailable) {
            console.warn("[iaaa] session rotation skipped: session listing unavailable");
          }
          const revokeRotationCookie = sessionRotationCookie(request, revokeRotation);
          // Issue #3155 (Q9): granter-revocation pass, mirroring
          // the membership revoke route — matrix-violating grants
          // by a now-fully-revoked user are revoked with them;
          // valid grants stay for the review queue. Never fails
          // the revoke; failures skip loudly with a reason.
          let granterRevocationPass: GranterRevocationPassResult & { auditFailures: string[]; reason?: string };
          try {
            const passEntries = await listSessionFamilyEntries(env, "iaaa-membership:");
            if (!passEntries) {
              console.warn("[iaaa] granter-revocation pass skipped: membership listing unavailable");
              granterRevocationPass = { reviewed: 0, revokedBindings: 0, revokedMemberships: [], skipped: true, auditFailures: [], reason: "listing-unavailable" };
            } else {
              const pass = await runGranterRevocationPass({
                store: membershipStore,
                allMemberships: listMembershipsFromEntries(passEntries),
                revokedUserId: record.internalUserId,
                nowMs,
              });
              const auditFailures: string[] = [];
              for (const passRevokedId of pass.revokedMemberships) {
                try {
                  const audited = await wiredAuditWriter("membership:revoke")({
                    permission: "membership:revoke",
                    principalId: session.internalUserId as string,
                    tenantId: record.tenantId,
                    decision: "allow",
                    nowMs,
                  });
                  if (!audited) {
                    console.warn(`[iaaa] granter-revocation pass audit failed for ${passRevokedId}`);
                    auditFailures.push(passRevokedId);
                  }
                } catch {
                  console.warn(`[iaaa] granter-revocation pass audit threw for ${passRevokedId}`);
                  auditFailures.push(passRevokedId);
                }
              }
              granterRevocationPass = { ...pass, auditFailures };
            }
          } catch {
            console.warn("[iaaa] granter-revocation pass failed; grants remain visible in the review queue");
            granterRevocationPass = { reviewed: 0, revokedBindings: 0, revokedMemberships: [], skipped: true, auditFailures: [], reason: "pass-error" };
          }
          return Response.json(
            { ok: true, grantId: view.grantId, emptied: removed.emptied, revoked: true, granterRevocationPass, sessionRotation: { rotatedCount: revokeRotation.rotated.length, unavailable: revokeRotation.unavailable } },
            revokeRotationCookie ? { headers: { "Set-Cookie": revokeRotationCookie } } : undefined,
          );
        }
        // #2836 — admin surface for logged-in users. GET lists
        // active sessions + per-user login history; POST revokes
        // one session. Both routes reuse this block's gates
        // exactly: requireAuth (401), wired session (403 for
        // legacy), then platform-admin OR tenant-admin in the
        // resolved tenant (the #2688 tenant-admin proxy:
        // canGrantRole for tenant-admin in scope). A tenant
        // admin sees only users with an active membership in
        // their tenant and only that tenant's login events;
        // legacy sessions (no tenant attribution) are platform
        // only. Non-admin denials are audited best-effort.
        // Sources are the existing durable records only —
        // SessionStore sessions, retained auth.login audit
        // events, iaaa-alias: records, iaaa-binding: records,
        // iaaa-membership: records. No second login record is
        // invented, and no token, secret, or payload is ever
        // returned: rows carry identity, tenant, times, counts,
        // and status only. A null listing or a throwing audit
        // read answers 500 with no partial data (fail-visible,
        // never a partial admin view).
        if (path === "/api/iaaa/logged-in-users") {
          if (request.method !== "GET") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const callerIsTenantAdmin = await callerCanGrantTenantAdmin();
          if (!callerIsPlatformAdmin && !callerIsTenantAdmin) {
            await loggedInUsersDenyAudit("logged_in_users.list", tenantId);
            return Response.json({ error: "Forbidden: listing logged-in users requires admin access." }, { status: 403 });
          }
          try {
            const sessionEntries = await listSessionFamilyEntries(env, "");
            const membershipEntries = await listSessionFamilyEntries(env, "iaaa-membership:");
            const aliasEntries = await listSessionFamilyEntries(env, "iaaa-alias:user:");
            const bindingEntries = await listSessionFamilyEntries(env, "iaaa-binding:user:");
            if (!sessionEntries || !membershipEntries || !aliasEntries || !bindingEntries) {
              return Response.json({ error: "Logged-in-users listing unavailable." }, { status: 500 });
            }
            const allEvents = await createWiredAuditStore(env).list();
            const loginEvents = allEvents
              .filter((event) => event.type === "auth.login")
              .map((event) => ({
                actorPrincipalId: event.actorPrincipalId,
                tenantId: event.tenantId,
                timestamp: event.timestamp,
                outcome: event.outcome,
              }));
            // A membership counts for tenant visibility only
            // when unrevoked AND holding at least one unexpired
            // binding; binding expiry is folded into `revoked`
            // here so the module's single-expiry test stays exact.
            const memberships = listMembershipsFromEntries(membershipEntries).map((m) => ({
              internalUserId: m.internalUserId,
              tenantId: m.tenantId,
              revoked:
                m.revokedAtMs !== undefined ||
                !m.roleBindings.some(
                  (b) => b.expiresAtMs === undefined || b.expiresAtMs > nowMs,
                ),
              expiresAtMs: undefined,
            }));
            const aliases = aliasEntries.flatMap((entry) => {
              try {
                const parsed = JSON.parse(entry.value) as {
                  internalUserId?: unknown;
                  recordedAtMs?: unknown;
                };
                if (
                  typeof parsed.internalUserId !== "string" ||
                  typeof parsed.recordedAtMs !== "number"
                ) {
                  return [];
                }
                return [{ internalUserId: parsed.internalUserId, recordedAtMs: parsed.recordedAtMs }];
              } catch {
                return [];
              }
            });
            const identityByUser: Record<string, string> = {};
            for (const entry of bindingEntries) {
              try {
                const parsed = JSON.parse(entry.value) as {
                  internalUserId?: unknown;
                  providerIssuer?: unknown;
                  providerSubject?: unknown;
                };
                if (
                  typeof parsed.internalUserId === "string" &&
                  typeof parsed.providerIssuer === "string" &&
                  typeof parsed.providerSubject === "string" &&
                  identityByUser[parsed.internalUserId] === undefined
                ) {
                  identityByUser[parsed.internalUserId] =
                    `${parsed.providerIssuer}:${parsed.providerSubject}`;
                }
              } catch {
                continue;
              }
            }
            const users = buildLoggedInUserRows({
              sessionEntries,
              loginEvents,
              aliases,
              memberships,
              identityByUser,
              scope: callerIsPlatformAdmin ? "platform" : "tenant",
              tenantId,
              nowMs,
              idleTimeoutMs: resolveIdleTimeoutMs(env.SESSION_IDLE_TIMEOUT_MS),
              resolveProvider: (issuer) => {
                const found = getProviderByIssuer(issuer);
                return found
                  ? { providerId: found.providerId, displayName: found.displayName }
                  : null;
              },
            });
            return Response.json({
              ok: true,
              scope: callerIsPlatformAdmin ? "platform" : "tenant",
              tenantId: callerIsPlatformAdmin ? undefined : tenantId,
              users,
              coverage: {
                // The count's basis, stated in the payload so no
                // consumer can mistake it for a lifetime total.
                loginCountBasis: "retained-auth-login-events",
                loginCountNote:
                  "loginCount counts retained auth.login succeeded audit events only. " +
                  "The audit store is bounded (22,000 events) and login writes are " +
                  "best-effort, so logins outside the retained window — or lost to a " +
                  "failed write — are absent. A lifetime login count needs an " +
                  "unbounded login-event record (carried follow-up tied to #2808's " +
                  "login-trace kind); it is never estimated here.",
                lastSeenNote:
                  "lastSeenMs is the last RECORDED activity; touches land at most " +
                  "once per 300s, so it lags true activity by up to 300s.",
                firstSeenNote:
                  "firstSeenMs is the first wired-login observation from the " +
                  "login-alias record, not a login history.",
              },
            });
          } catch {
            return Response.json({ error: "Logged-in-users listing unavailable." }, { status: 500 });
          }
        }
        // #2836 — admin revoke of one session. The session must
        // be currently active and in the caller's scope (tenant
        // admins: user with an active membership in their tenant;
        // legacy sessions are platform-only). Revocation is a
        // store delete + same-isolate cache invalidation, then
        // an audit record (admin, target user, session, tenant,
        // timestamp) whose success is reported honestly: a failed
        // audit write does not un-revoke, and is not hidden.
        // Bound (#1750 session-revocation target): 0 ms on the
        // revoking isolate and for wired sessions on fresh reads
        // everywhere; at most the 60s isolate-cache TTL for an
        // isolate holding a stale cached copy.
        if (path === "/api/iaaa/logged-in-users/revoke") {
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return Response.json({ error: "Invalid request body." }, { status: 400 });
          }
          const sessionId =
            typeof body === "object" && body !== null
              ? (body as { sessionId?: unknown }).sessionId
              : undefined;
          if (typeof sessionId !== "string" || sessionId.trim() === "") {
            return Response.json({ error: "sessionId is required." }, { status: 400 });
          }
          const callerIsTenantAdmin = await callerCanGrantTenantAdmin();
          if (!callerIsPlatformAdmin && !callerIsTenantAdmin) {
            await loggedInUsersDenyAudit("logged_in_users.revoke", tenantId);
            return Response.json({ error: "Forbidden: revoking sessions requires admin access." }, { status: 403 });
          }
          try {
            const sessionEntries = await listSessionFamilyEntries(env, "");
            if (!sessionEntries) {
              return Response.json({ error: "Session listing unavailable." }, { status: 500 });
            }
            const idleTimeoutMs = resolveIdleTimeoutMs(env.SESSION_IDLE_TIMEOUT_MS);
            const target = sessionEntries
              .map((entry) =>
                parseLoggedInSessionEntry(entry.key, entry.value, nowMs, idleTimeoutMs, () => null),
              )
              .find((parsed) => parsed !== null && parsed.sessionId === sessionId);
            if (!target) {
              return Response.json({ error: "No active session with that id." }, { status: 404 });
            }
            let auditTenantId = tenantId;
            if (!callerIsPlatformAdmin) {
              if (target.internalUserId === undefined) {
                await loggedInUsersDenyAudit("logged_in_users.revoke", tenantId);
                return Response.json({ error: "Forbidden: legacy sessions are platform-admin only." }, { status: 403 });
              }
              const membershipEntries = await listSessionFamilyEntries(env, "iaaa-membership:");
              if (!membershipEntries) {
                return Response.json({ error: "Membership listing unavailable." }, { status: 500 });
              }
              const inTenant = listMembershipsFromEntries(membershipEntries).some(
                (m) =>
                  m.internalUserId === target.internalUserId &&
                  m.tenantId === tenantId &&
                  m.revokedAtMs === undefined &&
                  m.roleBindings.some(
                    (b) => b.expiresAtMs === undefined || b.expiresAtMs > nowMs,
                  ),
              );
              if (!inTenant) {
                await loggedInUsersDenyAudit("logged_in_users.revoke", tenantId);
                return Response.json({ error: "Forbidden: that session is outside your tenant." }, { status: 403 });
              }
            } else if (target.internalUserId !== undefined) {
              const membershipEntries = await listSessionFamilyEntries(env, "iaaa-membership:");
              if (membershipEntries) {
                const owner = listMembershipsFromEntries(membershipEntries).find(
                  (m) =>
                    m.internalUserId === target.internalUserId &&
                    m.revokedAtMs === undefined &&
                    m.roleBindings.some(
                      (b) => b.expiresAtMs === undefined || b.expiresAtMs > nowMs,
                    ),
                );
                if (owner) auditTenantId = owner.tenantId;
              }
            }
            await deleteSession(env, sessionId);
            invalidateSessionCache(sessionId);
            const auditResult = await recordAuditEvent(createWiredAuditStore(env), {
              timestamp: nowMs,
              type: "iaaa.lifecycle",
              actorPrincipalId: session.internalUserId as string,
              actorType: "human",
              initiatingPrincipalId: session.internalUserId as string,
              tenantId: auditTenantId,
              correlationId: sessionId,
              resourceId: target.internalUserId ?? target.displayLogin,
              action: "session.revoke",
              decision: "allow",
              policyVersion: IAAA_AUDIT_POLICY_VERSION,
              outcome: "succeeded",
            }).catch(() => ({ ok: false }));
            return Response.json({
              ok: true,
              revokedSessionId: sessionId,
              audited: auditResult.ok === true,
              revokeBoundMs: SESSION_REVOCATION_CROSS_ISOLATE_BOUND_MS,
              revokeBoundNote:
                "Wired sessions deny immediately on fresh reads everywhere; " +
                "an isolate holding a stale cached copy denies within the " +
                "60s cache TTL. The revoked session id is the audit " +
                "correlation id; the target user is the resource id.",
            });
          } catch {
            return Response.json({ error: "Session revoke unavailable." }, { status: 500 });
          }
        }
        // Issue #2842 — per-user report-run quota, additive to
        // the #2836 admin surface (same guard block, same admin
        // rules, no change to the logged-in-users endpoints).
        // Counters live in the per-owner ScreenerAgent instance's
        // own SQLite, so both routes stub that instance by the
        // target's screener login (display login). The charge
        // partition defaults to the login itself (the #2426
        // rule); only a platform admin may name another
        // partition, and only when they know runs charge there.
        // A null listing or a throwing stub answers 500 with no
        // partial data, mirroring #2836.
        if (path === "/api/iaaa/quota-usage" || path === "/api/iaaa/quota-usage/override") {
          const quotaDenyAudit = async (action: string): Promise<void> => {
            try {
              await recordAuditEvent(createWiredAuditStore(env), {
                timestamp: nowMs,
                type: "iaaa.lifecycle",
                actorPrincipalId: session.internalUserId as string,
                actorType: "human",
                initiatingPrincipalId: session.internalUserId as string,
                tenantId,
                correlationId: crypto.randomUUID(),
                action,
                decision: "deny",
                policyVersion: IAAA_AUDIT_POLICY_VERSION,
                outcome: "failed",
                errorCode: "QUOTA_USAGE_DENIED",
              });
            } catch {
              /* denial attribution is best-effort; the deny stands */
            }
          };
          // Resolve a target login to its wired identity + active
          // tenant memberships (the revoke handler's rule, verbatim:
          // unrevoked + at least one unexpired binding). A login
          // with no active session row yields no identity, so a
          // tenant admin can never verify it — fail-closed.
          const quotaTargetTenancy = async (
            targetLogin: string,
          ): Promise<
            | { status: "ok"; internalUserId: string | undefined; tenantIds: string[] }
            | { status: "unavailable" }
          > => {
            const sessionEntries = await listSessionFamilyEntries(env, "");
            const membershipEntries = await listSessionFamilyEntries(env, "iaaa-membership:");
            if (!sessionEntries || !membershipEntries) return { status: "unavailable" };
            const idleTimeoutMs = resolveIdleTimeoutMs(env.SESSION_IDLE_TIMEOUT_MS);
            let internalUserId: string | undefined;
            for (const entry of sessionEntries) {
              const parsed = parseLoggedInSessionEntry(entry.key, entry.value, nowMs, idleTimeoutMs, () => null);
              if (parsed && parsed.displayLogin === targetLogin) {
                internalUserId = parsed.internalUserId;
                break;
              }
            }
            const tenantIds = listMembershipsFromEntries(membershipEntries)
              .filter(
                (m) =>
                  m.internalUserId === internalUserId &&
                  m.revokedAtMs === undefined &&
                  m.roleBindings.some(
                    (b) => b.expiresAtMs === undefined || b.expiresAtMs > nowMs,
                  ),
              )
              .map((m) => m.tenantId);
            return { status: "ok", internalUserId, tenantIds };
          };
          type QuotaAgentStub = {
            getUserRequestQuotaUsage(userLogin?: string, tenantId?: string): Promise<QuotaUsageView>;
            listUserRequestQuotaOverrides(userLogin?: string, tenantId?: string): Promise<UserRequestQuotaOverride[]>;
            grantUserRequestQuotaOverride(input: {
              tenantId?: string;
              userLogin: string;
              windowKind: "daily" | "weekly" | "monthly";
              windowKey: string;
              extraRuns: number;
              grantedBy: string;
              reason: string;
            }): Promise<UserRequestQuotaOverride>;
          };
          const quotaStub = (targetLogin: string): QuotaAgentStub =>
            actorGateway.stub<QuotaAgentStub>(
              env.SCREENER_AGENT,
              resolveScreenerAgentName(env, targetLogin),
            );
          if (path === "/api/iaaa/quota-usage") {
            if (request.method !== "GET") {
              return Response.json({ error: "Method not allowed" }, { status: 405 });
            }
            const requestedLogin = url.searchParams.get("userLogin");
            const requestedPartition = url.searchParams.get("tenantId");
            if (requestedPartition !== null && !callerIsPlatformAdmin) {
              await quotaDenyAudit("quota_usage.list");
              return Response.json({ error: "Forbidden: naming a quota partition requires platform admin access." }, { status: 403 });
            }
            let targetLogin: string;
            if (requestedLogin !== null) {
              if (requestedLogin.trim() === "") {
                return Response.json({ error: "userLogin must not be empty." }, { status: 400 });
              }
              targetLogin = requestedLogin;
              if (!callerIsPlatformAdmin) {
                const tenantAdmin = await callerCanGrantTenantAdmin();
                if (!tenantAdmin) {
                  await quotaDenyAudit("quota_usage.list");
                  return Response.json({ error: "Forbidden: looking up another user's quota requires admin access." }, { status: 403 });
                }
                const tenancy = await quotaTargetTenancy(targetLogin);
                if (tenancy.status === "unavailable") {
                  return Response.json({ error: "Quota lookup unavailable." }, { status: 500 });
                }
                if (!tenancy.tenantIds.includes(tenantId)) {
                  await quotaDenyAudit("quota_usage.list");
                  return Response.json({ error: "Forbidden: that user is outside your tenant." }, { status: 403 });
                }
              }
            } else {
              // Self: the screener login is the session's login.
              if (!session.githubLogin) {
                return Response.json({ error: "No screener login resolvable for this session." }, { status: 404 });
              }
              targetLogin = session.githubLogin;
            }
            const partition = requestedPartition ?? targetLogin;
            try {
              const stub = quotaStub(targetLogin);
              const usage = await stub.getUserRequestQuotaUsage(targetLogin, partition);
              const overrides = await stub.listUserRequestQuotaOverrides(targetLogin, partition);
              return Response.json({
                ok: true,
                scope: requestedLogin !== null ? (callerIsPlatformAdmin ? "platform" : "tenant") : "self",
                userLogin: targetLogin,
                tenantPartition: partition,
                usage,
                overrides,
              });
            } catch {
              return Response.json({ error: "Quota usage unavailable." }, { status: 500 });
            }
          }
          // POST /api/iaaa/quota-usage/override — audited admin grant.
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return Response.json({ error: "Invalid request body." }, { status: 400 });
          }
          const grant = (body ?? {}) as {
            userLogin?: unknown;
            windowKind?: unknown;
            extraRuns?: unknown;
            reason?: unknown;
            tenantId?: unknown;
          };
          if (typeof grant.userLogin !== "string" || grant.userLogin.trim() === "") {
            return Response.json({ error: "userLogin is required." }, { status: 400 });
          }
          if (grant.windowKind !== "daily" && grant.windowKind !== "weekly" && grant.windowKind !== "monthly") {
            return Response.json({ error: "windowKind must be daily, weekly, or monthly." }, { status: 400 });
          }
          if (typeof grant.extraRuns !== "number" || !Number.isInteger(grant.extraRuns) || grant.extraRuns < 1) {
            return Response.json({ error: "extraRuns must be an integer >= 1." }, { status: 400 });
          }
          if (typeof grant.reason !== "string" || grant.reason.trim() === "") {
            return Response.json({ error: "reason is required." }, { status: 400 });
          }
          if (grant.tenantId !== undefined && typeof grant.tenantId !== "string") {
            return Response.json({ error: "tenantId must be a string." }, { status: 400 });
          }
          if (!callerIsPlatformAdmin) {
            const tenantAdmin = await callerCanGrantTenantAdmin();
            if (!tenantAdmin) {
              await quotaDenyAudit("quota_usage.override");
              return Response.json({ error: "Forbidden: granting quota overrides requires admin access." }, { status: 403 });
            }
            if (grant.tenantId !== undefined) {
              return Response.json({ error: "Tenant admins grant into the login partition; only platform admins may name a partition." }, { status: 400 });
            }
            const tenancy = await quotaTargetTenancy(grant.userLogin);
            if (tenancy.status === "unavailable") {
              return Response.json({ error: "Quota override unavailable." }, { status: 500 });
            }
            if (!tenancy.tenantIds.includes(tenantId)) {
              await quotaDenyAudit("quota_usage.override");
              return Response.json({ error: "Forbidden: that user is outside your tenant." }, { status: 403 });
            }
          }
          const partition = callerIsPlatformAdmin && grant.tenantId !== undefined
            ? (grant.tenantId as string)
            : grant.userLogin;
          let override: UserRequestQuotaOverride;
          try {
            override = await quotaStub(grant.userLogin).grantUserRequestQuotaOverride({
              tenantId: partition,
              userLogin: grant.userLogin,
              windowKind: grant.windowKind,
              windowKey: quotaWindowKey(grant.windowKind, nowMs),
              extraRuns: grant.extraRuns,
              grantedBy: session.internalUserId as string,
              reason: grant.reason,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.startsWith("Invalid quota override")) {
              return Response.json({ error: message }, { status: 400 });
            }
            return Response.json({ error: "Quota override unavailable." }, { status: 500 });
          }
          // Audit-after-grant with an honest flag (the #2836
          // revoke pattern): a failed audit write does not
          // un-grant and is not hidden.
          let auditTenantId = tenantId;
          if (callerIsPlatformAdmin) {
            const tenancy = await quotaTargetTenancy(grant.userLogin);
            if (tenancy.status === "ok" && tenancy.tenantIds.length > 0) {
              auditTenantId = tenancy.tenantIds[0];
            }
          }
          const auditResult = await recordAuditEvent(createWiredAuditStore(env), {
            timestamp: nowMs,
            type: "iaaa.lifecycle",
            actorPrincipalId: session.internalUserId as string,
            actorType: "human",
            initiatingPrincipalId: session.internalUserId as string,
            tenantId: auditTenantId,
            correlationId: override.id,
            resourceId: grant.userLogin,
            action: "user_request_quota.override",
            decision: "allow",
            policyVersion: IAAA_AUDIT_POLICY_VERSION,
            outcome: "succeeded",
          }).catch(() => ({ ok: false }));
          return Response.json({ ok: true, override, audited: auditResult.ok === true });
        }
        // #2838 — PAP editor: approval-gated policy administration.
        // Platform-admin ONLY (tenant admins never administer
        // platform policy): every handler below refuses a
        // non-platform caller with 403 before touching state.
        // A proposal is inert until approved AND promoted; the
        // compiled tables stay live until a promotion completes,
        // and live adoption of a promoted snapshot goes through
        // the existing platform-only IAAA_PDP_POLICY_SNAPSHOT_JSON
        // switch (#1755) — this slice never flips live PDP policy
        // by itself. Audit order is audit-before-persist: a
        // transition whose #1760 chained audit append fails is
        // NOT persisted, so no unaudited transition exists. The
        // audit record carries the proposal's correlationId
        // verbatim (body correlationId, else the request's
        // traceparent header), joining it to #2808 traces.
        if (
          path === "/api/iaaa/policy-proposals" ||
          path === "/api/iaaa/policy-proposals/active" ||
          path === "/api/iaaa/policy-proposals/propose" ||
          path === "/api/iaaa/policy-proposals/approve" ||
          path === "/api/iaaa/policy-proposals/reject" ||
          path === "/api/iaaa/policy-proposals/promote" ||
          path === "/api/iaaa/policy-proposals/preview"
        ) {
          const papStore = createKvPolicyProposalStore(kv);
          const papAudit = async (
            action: PolicyProposalAuditAction,
            proposal: PolicyProposal,
            actor: string,
            atMs: number,
          ): Promise<boolean> => {
            const input = policyProposalAuditInput(proposal, action, actor);
            const result = await recordAuditEvent(createWiredAuditStore(env), {
              ...input,
              timestamp: atMs,
              decision: "allow",
              policyVersion: IAAA_AUDIT_POLICY_VERSION,
              outcome: "succeeded",
            });
            return result.ok;
          };
          const papDenyAudit = async (): Promise<void> => {
            try {
              await recordAuditEvent(createWiredAuditStore(env), {
                type: "iaaa.policy",
                actorPrincipalId: session.internalUserId as string,
                actorType: "human",
                initiatingPrincipalId: session.internalUserId as string,
                tenantId: "platform",
                correlationId: crypto.randomUUID(),
                action: "policy.access_denied",
                timestamp: nowMs,
                decision: "deny",
                policyVersion: IAAA_AUDIT_POLICY_VERSION,
                outcome: "failed",
                errorCode: "PAP_FORBIDDEN",
              });
            } catch {
              /* denial attribution is best-effort; the deny stands */
            }
          };
          if (!callerIsPlatformAdmin) {
            await papDenyAudit();
            return Response.json(
              { error: "Forbidden: policy administration requires platform-admin." },
              { status: 403 },
            );
          }
          if (path === "/api/iaaa/policy-proposals" && request.method === "GET") {
            const entries = await listSessionFamilyEntries(env, POLICY_PROPOSAL_KEY_PREFIX);
            if (!entries) {
              return Response.json({ error: "Policy-proposal listing unavailable." }, { status: 500 });
            }
            const proposals: PolicyProposal[] = [];
            let skippedCorrupt = 0;
            for (const entry of entries) {
              if (entry.key === POLICY_PROPOSAL_ACTIVE_KEY) continue;
              const parsed = parseStoredProposal(entry.value);
              if (parsed) proposals.push(parsed);
              else skippedCorrupt++;
            }
            proposals.sort((a, b) => a.createdAtMs - b.createdAtMs);
            return Response.json({ ok: true, proposals, skippedCorrupt });
          }
          if (path === "/api/iaaa/policy-proposals/active" && request.method === "GET") {
            const rawActive = await kv.get(POLICY_PROPOSAL_ACTIVE_KEY);
            const active = await papStore.getActiveSnapshot();
            return Response.json({
              ok: true,
              active,
              source: rawActive === null ? "compiled" : "pap-promoted",
            });
          }
          if (path === "/api/iaaa/policy-proposals/preview" && request.method === "POST") {
            const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
            const active = await papStore.getActiveSnapshot();
            const created = createProposal({
              proposer: session.internalUserId as string,
              snapshotInput: body?.snapshot,
              beforeSnapshot: active,
              nowMs,
            });
            if (!created.ok) {
              return Response.json({ error: created.error, code: created.code }, { status: 400 });
            }
            const probes = ALL_ROLES.flatMap((role) =>
              PERMISSIONS.map((permission) => ({ role, permission })),
            );
            const decisions = await previewDecisions(
              active,
              created.proposal.proposedSnapshot,
              probes,
              nowMs,
            );
            return Response.json({
              ok: true,
              beforeRef: created.proposal.beforeRef,
              afterRef: created.proposal.afterRef,
              diff: diffPolicySnapshots(active, created.proposal.proposedSnapshot),
              changedDecisions: decisions.filter((d) => d.changed),
            });
          }
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const papBody = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          const loadProposal = async (): Promise<PolicyProposal | null> => {
            const id = typeof papBody?.proposalId === "string" ? papBody.proposalId.trim() : "";
            if (id === "") return null;
            return papStore.getProposal(id);
          };
          if (path === "/api/iaaa/policy-proposals/propose") {
            const correlationId =
              (typeof papBody?.correlationId === "string" && papBody.correlationId.trim() !== ""
                ? papBody.correlationId.trim()
                : request.headers.get("traceparent") ?? undefined) ?? undefined;
            const created = createProposal({
              proposer: session.internalUserId as string,
              snapshotInput: papBody?.snapshot,
              beforeSnapshot: await papStore.getActiveSnapshot(),
              ...(correlationId !== undefined ? { correlationId } : {}),
              nowMs,
            });
            if (!created.ok) {
              return Response.json({ error: created.error, code: created.code }, { status: 400 });
            }
            if (!(await papAudit("policy.proposed", created.proposal, session.internalUserId as string, nowMs))) {
              return Response.json({ error: "Audit-before-propose failed; proposal not stored." }, { status: 500 });
            }
            await papStore.putProposal(created.proposal);
            return Response.json({ ok: true, proposal: created.proposal }, { status: 201 });
          }
          if (path === "/api/iaaa/policy-proposals/approve") {
            const proposal = await loadProposal();
            if (!proposal) return Response.json({ error: "Proposal not found." }, { status: 404 });
            const exceptionReason =
              typeof papBody?.exceptionReason === "string" ? papBody.exceptionReason : undefined;
            const approved = approveProposal(proposal, {
              approver: session.internalUserId as string,
              approverIsPlatformAdmin: callerIsPlatformAdmin,
              ...(exceptionReason !== undefined ? { exceptionReason } : {}),
              nowMs,
            });
            if (!approved.ok) {
              return Response.json(
                { error: approved.error, code: approved.code },
                { status: approved.code === "NOT_PLATFORM_ADMIN" || approved.code === "SELF_APPROVAL" ? 403 : 400 },
              );
            }
            if (!(await papAudit("policy.approved", approved.proposal, session.internalUserId as string, nowMs))) {
              return Response.json({ error: "Audit-before-approve failed; approval not stored." }, { status: 500 });
            }
            await papStore.putProposal(approved.proposal);
            return Response.json({ ok: true, proposal: approved.proposal });
          }
          if (path === "/api/iaaa/policy-proposals/reject") {
            const proposal = await loadProposal();
            if (!proposal) return Response.json({ error: "Proposal not found." }, { status: 404 });
            const rejected = rejectProposal(proposal, {
              reviewer: session.internalUserId as string,
              reviewerIsPlatformAdmin: callerIsPlatformAdmin,
              nowMs,
            });
            if (!rejected.ok) {
              return Response.json({ error: rejected.error, code: rejected.code }, { status: 400 });
            }
            if (!(await papAudit("policy.rejected", rejected.proposal, session.internalUserId as string, nowMs))) {
              return Response.json({ error: "Audit-before-reject failed; rejection not stored." }, { status: 500 });
            }
            await papStore.putProposal(rejected.proposal);
            return Response.json({ ok: true, proposal: rejected.proposal });
          }
          if (path === "/api/iaaa/policy-proposals/promote") {
            const proposal = await loadProposal();
            if (!proposal) return Response.json({ error: "Proposal not found." }, { status: 404 });
            const active = await papStore.getActiveSnapshot();
            const promoted = promoteProposal(proposal, { activeSnapshot: active, nowMs });
            if (!promoted.ok) {
              return Response.json({ error: promoted.error, code: promoted.code }, { status: 400 });
            }
            if (!(await papAudit("policy.promoted", promoted.proposal, session.internalUserId as string, nowMs))) {
              return Response.json({ error: "Audit-before-promote failed; previous policy stays active." }, { status: 500 });
            }
            await papStore.putActiveSnapshot(promoted.activeSnapshot);
            await papStore.putProposal(promoted.proposal);
            return Response.json({
              ok: true,
              proposal: promoted.proposal,
              active: promoted.activeSnapshot,
            });
          }
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        // #3077 (#945 Q3) — reviewed bootstrap changes: approval-gated
        // administration of the IAAA_BOOTSTRAP_ADMINS list. Platform-admin
        // ONLY: every handler below refuses a non-platform caller with
        // 403 before touching state. A proposal is inert: it changes
        // nothing until approved, and approval changes nothing until
        // the operator confirms application through the secrets
        // channel — this slice never writes the env var itself.
        // Audit order is audit-before-persist: a transition whose
        // #1760 chained audit append fails is NOT persisted, so no
        // unaudited transition exists. The audit record carries the
        // proposal's correlationId verbatim (body correlationId, else
        // the request's traceparent header), joining it to #2808 traces.
        // List-removal retains: removing an identifier never drops a
        // membership — it stays until explicitly revoked; the current
        // view surfaces bootstrap-granted members no longer listed.
        if (
          path === "/api/iaaa/bootstrap-proposals" ||
          path === "/api/iaaa/bootstrap-proposals/current" ||
          path === "/api/iaaa/bootstrap-proposals/propose" ||
          path === "/api/iaaa/bootstrap-proposals/approve" ||
          path === "/api/iaaa/bootstrap-proposals/reject" ||
          path === "/api/iaaa/bootstrap-proposals/confirm-applied"
        ) {
          const bootStore = createKvBootstrapProposalStore(kv);
          const bootAudit = async (
            action: BootstrapProposalAuditAction,
            proposal: BootstrapProposal,
            actor: string,
            atMs: number,
          ): Promise<boolean> => {
            const input = bootstrapProposalAuditInput(proposal, action, actor);
            const result = await recordAuditEvent(createWiredAuditStore(env), {
              ...input,
              timestamp: atMs,
              decision: "allow",
              policyVersion: IAAA_AUDIT_POLICY_VERSION,
              outcome: "succeeded",
            });
            return result.ok;
          };
          const bootDenyAudit = async (): Promise<void> => {
            try {
              await recordAuditEvent(createWiredAuditStore(env), {
                type: "iaaa.bootstrap",
                actorPrincipalId: session.internalUserId as string,
                actorType: "human",
                initiatingPrincipalId: session.internalUserId as string,
                tenantId: "platform",
                correlationId: crypto.randomUUID(),
                action: "bootstrap.access_denied",
                timestamp: nowMs,
                decision: "deny",
                policyVersion: IAAA_AUDIT_POLICY_VERSION,
                outcome: "failed",
              });
            } catch {
              /* denial attribution is best-effort; the deny stands */
            }
          };
          if (!callerIsPlatformAdmin) {
            await bootDenyAudit();
            return Response.json(
              { error: "Forbidden: bootstrap administration requires platform-admin." },
              { status: 403 },
            );
          }
          // Resolve the current env list to internal user ids (bare
          // ids pass through; provider entries resolve through the
          // Slice 1 binding store; unresolvable entries resolve to
          // nobody and are reported, never invented).
          const resolveCurrentList = async (): Promise<{
            entries: string[];
            resolvedInternalUserIds: string[];
            unresolvedEntries: string[];
          }> => {
            const entries = currentBootstrapEntries(env.IAAA_BOOTSTRAP_ADMINS);
            const parsed = entries.map((entry) => {
              const inner = entry.startsWith("platform:")
                ? entry.slice("platform:".length)
                : entry;
              return { entry, parsed: parseBootstrapAdmins(inner) };
            });
            const toResolve = parsed
              .filter((p) => p.parsed.entries.length === 1)
              .map((p) => p.parsed.entries[0]);
            const resolved = await resolveBootstrapEntries(
              createWiredBindingStore(env),
              toResolve,
            );
            const unresolvedEntries = parsed
              .filter((p) => p.parsed.entries.length !== 1)
              .map((p) => p.entry);
            for (const u of resolved.unresolved) {
              unresolvedEntries.push(
                `${u.providerIssuer}:${u.providerSubject}`,
              );
            }
            return {
              entries,
              resolvedInternalUserIds: resolved.internalUserIds,
              unresolvedEntries,
            };
          };
          if (path === "/api/iaaa/bootstrap-proposals" && request.method === "GET") {
            const entries = await listSessionFamilyEntries(env, BOOTSTRAP_PROPOSAL_KEY_PREFIX);
            if (!entries) {
              return Response.json({ error: "Bootstrap-proposal listing unavailable." }, { status: 500 });
            }
            const proposals: BootstrapProposal[] = [];
            let skippedCorrupt = 0;
            for (const entry of entries) {
              const parsed = parseStoredBootstrapProposal(entry.value);
              if (parsed) proposals.push(parsed);
              else skippedCorrupt++;
            }
            proposals.sort((a, b) => a.createdAtMs - b.createdAtMs);
            return Response.json({ ok: true, proposals, skippedCorrupt });
          }
          if (path === "/api/iaaa/bootstrap-proposals/current" && request.method === "GET") {
            const current = await resolveCurrentList();
            const memberEntries = await listSessionFamilyEntries(env, "iaaa-membership:");
            if (!memberEntries) {
              return Response.json({ error: "Membership listing unavailable." }, { status: 500 });
            }
            const divergence = findBootstrapDivergence(
              current.resolvedInternalUserIds,
              listMembershipsFromEntries(memberEntries),
              nowMs,
            );
            return Response.json({
              ok: true,
              entries: current.entries,
              resolvedInternalUserIds: current.resolvedInternalUserIds,
              unresolvedEntries: current.unresolvedEntries,
              divergence,
            });
          }
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const bootBody = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          const loadBootstrapProposal = async (): Promise<BootstrapProposal | null> => {
            const id = typeof bootBody?.proposalId === "string" ? bootBody.proposalId.trim() : "";
            if (id === "") return null;
            return bootStore.getProposal(id);
          };
          if (path === "/api/iaaa/bootstrap-proposals/propose") {
            const action =
              bootBody?.action === "add" || bootBody?.action === "remove" ? bootBody.action : null;
            if (action === null) {
              return Response.json({ error: "action must be add or remove." }, { status: 400 });
            }
            const correlationId =
              (typeof bootBody?.correlationId === "string" && bootBody.correlationId.trim() !== ""
                ? bootBody.correlationId.trim()
                : request.headers.get("traceparent") ?? undefined) ?? undefined;
            const created = createBootstrapProposal({
              proposer: session.internalUserId as string,
              action,
              identifier: typeof bootBody?.identifier === "string" ? bootBody.identifier : "",
              reason: typeof bootBody?.reason === "string" ? bootBody.reason : "",
              ...(correlationId !== undefined ? { correlationId } : {}),
              nowMs,
            });
            if (!created.ok) {
              return Response.json({ error: created.error, code: created.code }, { status: 400 });
            }
            const current = await resolveCurrentList();
            const proposalInternalId = (
              await resolveBootstrapEntries(
                createWiredBindingStore(env),
                parseBootstrapAdmins(
                  created.proposal.identifier.startsWith("platform:")
                    ? created.proposal.identifier.slice("platform:".length)
                    : created.proposal.identifier,
                ).entries,
              )
            ).internalUserIds[0];
            const listedByIdentity =
              proposalInternalId !== undefined &&
              current.resolvedInternalUserIds.includes(proposalInternalId);
            const listedByString = current.entries.includes(created.proposal.identifier);
            if (action === "add" && (listedByIdentity || listedByString)) {
              return Response.json({ error: "identifier is already in the bootstrap list." }, { status: 400 });
            }
            if (action === "remove" && !listedByIdentity && !listedByString) {
              return Response.json({ error: "identifier is not in the bootstrap list." }, { status: 400 });
            }
            let proposal = created.proposal;
            // List-removal retains: record a bootstrap-granted active
            // membership for the removed identifier, so the UI can
            // state plainly that it stays until explicitly revoked.
            if (action === "remove" && proposalInternalId !== undefined) {
              const memberships = await membershipStore.getMembershipsByUser(proposalInternalId);
              const retained = memberships.find(
                (m) =>
                  m.revokedAtMs === undefined &&
                  m.roleBindings.some(
                    (b) =>
                      (b.grantedBy === "system:bootstrap" || b.grantedBy === "system:bootstrap-genesis") &&
                      (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
                  ),
              );
              if (retained) {
                proposal = {
                  ...proposal,
                  retained: { internalUserId: proposalInternalId, membershipId: retained.membershipId },
                };
              }
            }
            if (!(await bootAudit("bootstrap.proposed", proposal, session.internalUserId as string, nowMs))) {
              return Response.json({ error: "Audit-before-propose failed; proposal not stored." }, { status: 500 });
            }
            await bootStore.putProposal(proposal);
            return Response.json({ ok: true, proposal }, { status: 201 });
          }
          if (path === "/api/iaaa/bootstrap-proposals/approve") {
            const proposal = await loadBootstrapProposal();
            if (!proposal) return Response.json({ error: "Proposal not found." }, { status: 404 });
            // #3102 (#945 Q4): approving a bootstrap proposal
            // authorizes a platform-admin grant, so it is
            // privileged role assignment (5-minute window). The
            // decision itself is unchanged; only stale sessions
            // are refused before it is written.
            if (requiresStepUpForAction(session, "privileged-role-assignment", isWiringEnabled(env), nowMs)) {
              return Response.json({ error: "Step-up authentication required: please sign in again and retry." }, { status: 403 });
            }
            const exceptionReason =
              typeof bootBody?.exceptionReason === "string" ? bootBody.exceptionReason : undefined;
            const approved = approveBootstrapProposal(proposal, {
              approver: session.internalUserId as string,
              approverIsPlatformAdmin: callerIsPlatformAdmin,
              ...(exceptionReason !== undefined ? { exceptionReason } : {}),
              nowMs,
            });
            if (!approved.ok) {
              return Response.json(
                { error: approved.error, code: approved.code },
                { status: approved.code === "NOT_PLATFORM_ADMIN" || approved.code === "SELF_APPROVAL" ? 403 : 400 },
              );
            }
            if (!(await bootAudit("bootstrap.approved", approved.proposal, session.internalUserId as string, nowMs))) {
              return Response.json({ error: "Audit-before-approve failed; approval not stored." }, { status: 500 });
            }
            await bootStore.putProposal(approved.proposal);
            return Response.json({ ok: true, proposal: approved.proposal });
          }
          if (path === "/api/iaaa/bootstrap-proposals/reject") {
            const proposal = await loadBootstrapProposal();
            if (!proposal) return Response.json({ error: "Proposal not found." }, { status: 404 });
            const rejected = rejectBootstrapProposal(proposal, {
              reviewer: session.internalUserId as string,
              reviewerIsPlatformAdmin: callerIsPlatformAdmin,
              nowMs,
            });
            if (!rejected.ok) {
              return Response.json({ error: rejected.error, code: rejected.code }, { status: 400 });
            }
            if (!(await bootAudit("bootstrap.rejected", rejected.proposal, session.internalUserId as string, nowMs))) {
              return Response.json({ error: "Audit-before-reject failed; rejection not stored." }, { status: 500 });
            }
            await bootStore.putProposal(rejected.proposal);
            return Response.json({ ok: true, proposal: rejected.proposal });
          }
          if (path === "/api/iaaa/bootstrap-proposals/confirm-applied") {
            const proposal = await loadBootstrapProposal();
            if (!proposal) return Response.json({ error: "Proposal not found." }, { status: 404 });
            const applied = confirmBootstrapApplied(proposal, {
              appliedBy: session.internalUserId as string,
              appliedByIsPlatformAdmin: callerIsPlatformAdmin,
              applicationNote: typeof bootBody?.applicationNote === "string" ? bootBody.applicationNote : undefined,
              nowMs,
            });
            if (!applied.ok) {
              return Response.json({ error: applied.error, code: applied.code }, { status: 400 });
            }
            if (!(await bootAudit("bootstrap.applied", applied.proposal, session.internalUserId as string, nowMs))) {
              return Response.json({ error: "Audit-before-confirm failed; application not recorded." }, { status: 500 });
            }
            await bootStore.putProposal(applied.proposal);
            return Response.json({ ok: true, proposal: applied.proposal });
          }
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        if (path === "/api/iaaa/membership/grant") {
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          const targetId = typeof body?.internalUserId === "string" ? body.internalUserId.trim() : "";
          const bindings = Array.isArray(body?.roleBindings) ? body.roleBindings : [];
          if (targetId === "" || bindings.length === 0) {
            return Response.json({ error: "internalUserId and a non-empty roleBindings array are required." }, { status: 400 });
          }
          // #2661 — optional grantee email. A blank email is the
          // same as absent (the panel only sends a filled field);
          // a present-but-malformed email fails closed, never
          // stored and never mailed to.
          const emailRaw = typeof body?.email === "string" ? body.email.trim() : "";
          const granteeEmail = emailRaw === "" ? undefined : emailRaw;
          if (granteeEmail !== undefined && (granteeEmail.length > 512 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(granteeEmail))) {
            return Response.json({ error: "email must be a valid email address." }, { status: 400 });
          }
          if (targetId === session.internalUserId) {
            return Response.json({ error: "Self-grant is forbidden: another admin must grant your roles.", code: "SELF_GRANT" }, { status: 403 });
          }
          const grantTenantId = typeof body?.tenantId === "string" && body.tenantId.trim() !== "" ? body.tenantId.trim() : tenantId;
          // #2661 — idempotent no-op: when the target already
          // holds every requested binding live (same tenant,
          // unrevoked, unexpired), the grant changes nothing, so
          // it writes nothing — no new record, no new audit rows,
          // no welcome. Authorization is still enforced first via
          // a read-only canGrantRole check per binding, so a
          // non-granter learns nothing beyond a denied grant
          // (the memberships list route already shows holdings to
          // granters). Step-up is skipped only because nothing is
          // granted; the normal flow below keeps its obligations.
          const requestedBindings: Array<{ role: string; scope: "platform" | "tenant"; workspaceId?: string }> = bindings.map((raw) => {
            const binding = raw as { role?: unknown; scope?: unknown; workspaceId?: unknown };
            return {
              role: binding.role as string,
              scope: binding.scope === "platform" ? "platform" : "tenant",
              workspaceId: typeof binding.workspaceId === "string" ? binding.workspaceId : undefined,
            };
          });
          const existingLive = await membershipStore.getMembershipsByUser(targetId);
          const covering = existingLive.find(
            (m) =>
              m.tenantId === grantTenantId &&
              m.revokedAtMs === undefined &&
              requestedBindings.every((rb) =>
                m.roleBindings.some(
                  (b) =>
                    b.role === rb.role &&
                    b.scope === rb.scope &&
                    (rb.workspaceId ? b.workspaceId === rb.workspaceId : true) &&
                    (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
                ),
              ),
          );
          if (covering) {
            for (const rb of requestedBindings) {
              const check = await canGrantRole(membershipStore, {
                granterInternalUserId: session.internalUserId as string,
                targetTenantId: grantTenantId,
                targetScope: rb.scope,
                targetRole: rb.role as Role,
                targetWorkspaceId: rb.workspaceId,
                nowMs,
              });
              if (check.decision === "deny") {
                return Response.json(
                  { error: "Forbidden: grant denied.", code: check.reason, reason: check.reason },
                  { status: 403 },
                );
              }
            }
            return Response.json({ ok: true, membership: covering, alreadyProvisioned: true });
          }
          // #3102 (#945 Q4): a real grant (past the idempotent
          // no-op check above) requires fresh authentication
          // inside the 5-minute privileged-role-assignment window,
          // tighter than the #1751 obligation default (15 min).
          // Wiring OFF keeps legacy behavior.
          if (requiresStepUpForAction(session, "privileged-role-assignment", isWiringEnabled(env), nowMs)) {
            return Response.json({ error: "Step-up authentication required: please sign in again and retry." }, { status: 403 });
          }
          for (const raw of bindings) {
            const binding = raw as { role?: unknown; scope?: unknown; workspaceId?: unknown };
            const scope = binding.scope === "platform" ? "platform" : "tenant";
            const evaluated = await evaluateWithObligations(membershipStore, {
              internalUserId: session.internalUserId,
              tenantId: grantTenantId,
              permission: "role:assign",
              scope,
              resourceScope:
                binding.scope === "workspace" && typeof binding.workspaceId === "string"
                  ? { workspaceId: binding.workspaceId }
                  : undefined,
              nowMs,
              authTimeMs: session.authTimeMs,
              audit: wiredAuditWriter("role:assign"),
            });
            if (evaluated.decision === "deny") {
              return Response.json(
                { error: "Forbidden: grant denied.", code: evaluated.reason, reason: evaluated.reason },
                { status: 403 },
              );
            }
          }
          // Issue #3155 (Q9): tenant-admin and platform-admin
          // grants need two distinct approvers. The first admin's
          // grant proposes (202, pending) and mints nothing; the
          // second admin's identical grant confirms the proposal
          // and falls through to mint below. Both approvers pass
          // the obligation chain above, on their own calls.
          // Non-admin grants skip this block and mint immediately.
          if (isAdminRoleGrant(requestedBindings)) {
            const proposalStore = createGrantProposalStore(kv);
            const resolved = await resolveAdminGrantProposal(proposalStore, {
              kind: "grant",
              granteeInternalUserId: targetId,
              tenantId: grantTenantId,
              roleBindings: requestedBindings.map((b) => ({
                role: b.role as Role,
                scope: b.scope,
                ...(b.workspaceId ? { workspaceId: b.workspaceId } : {}),
              })),
              callerInternalUserId: session.internalUserId as string,
              nowMs,
            });
            if (resolved.action !== "confirm") {
              return Response.json(
                {
                  ok: true,
                  pending: true,
                  proposalId: resolved.proposal.proposalId,
                  approvers: resolved.proposal.approvers,
                },
                { status: 202 },
              );
            }
          }
          const granted = await grantMembership(membershipStore, {
            granterInternalUserId: session.internalUserId,
            internalUserId: targetId,
            tenantId: grantTenantId,
            roleBindings: bindings.map((raw) => {
              const binding = raw as { role: string; scope: string; workspaceId?: string };
              return {
                role: binding.role as Role,
                scope: binding.scope as AuthorizationScope,
                ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
                grantedBy: session.internalUserId as string,
              };
            }),
            nowMs,
            defaultExpiryDays: resolveGrantDefaultExpiryDays(env.IAAA_GRANT_DEFAULT_EXPIRY_DAYS),
            ...(granteeEmail !== undefined ? { email: granteeEmail } : {}),
          });
          if (!granted.ok) {
            return Response.json(
              { error: granted.error, code: granted.code },
              { status: granted.code === "GRANT_DENIED" ? 403 : 400 },
            );
          }
          // #2661 — welcome trigger on provisioning: a successful
          // grant that captured a grantee email best-effort sends
          // the tier-selected welcome. The send never blocks or
          // fails the grant — its outcome rides along in the
          // response. No email → no welcome attempt. No-ops never
          // reach here, so re-grants never re-welcome.
          let welcome;
          if (granteeEmail !== undefined) {
            welcome = await sendProvisioningWelcome(env, {
              userId: targetId,
              email: granteeEmail,
              tenantId: grantTenantId,
            });
          }
          // Issue #3113 (#945 Q5): a real grant rotates the
          // affected user's active sessions (old ids dead).
          const memberGrantRotation = await rotateUserSessionsForEnv(env, targetId, nowMs);
          if (memberGrantRotation.unavailable) {
            console.warn("[iaaa] session rotation skipped: session listing unavailable");
          }
          const memberGrantRotationCookie = sessionRotationCookie(request, memberGrantRotation);
          return Response.json(
            {
              ok: true,
              membership: granted.membership,
              ...(welcome ? { welcome } : {}),
              sessionRotation: { rotatedCount: memberGrantRotation.rotated.length, unavailable: memberGrantRotation.unavailable },
            },
            { status: 201, ...(memberGrantRotationCookie ? { headers: { "Set-Cookie": memberGrantRotationCookie } } : {}) },
          );
        }
        if (path === "/api/iaaa/membership/revoke") {
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          const membershipId = typeof body?.membershipId === "string" ? body.membershipId.trim() : "";
          if (membershipId === "") {
            return Response.json({ error: "membershipId is required." }, { status: 400 });
          }
          const record = await readMembershipById(kv, membershipId);
          if (!record) {
            return Response.json({ error: "Membership not found." }, { status: 404 });
          }
          const isPlatformScope = record.roleBindings.some((b) => b.scope === "platform");
          if (isPlatformScope) {
            // PDP platform grants carry no membership:revoke, so a
            // platform-scope revoke is gated on live platform-admin
            // membership + a wired audit record written BEFORE the
            // revoke (fail closed on audit failure). This is the
            // documented platform-scope exception, not a PDP bypass
            // for tenant memberships, which use the obligation
            // channel below.
            if (!callerIsPlatformAdmin) {
              return Response.json({ error: "Forbidden: revoking a platform membership requires platform-admin." }, { status: 403 });
            }
            const audited = await offboardAudit("membership:revoke", session.internalUserId, record.tenantId, nowMs);
            if (!audited) {
              return Response.json({ error: "Forbidden: audit-before-revoke failed.", code: "AUDIT_FAILED" }, { status: 403 });
            }
          } else {
            const evaluated = await evaluateWithObligations(membershipStore, {
              internalUserId: session.internalUserId,
              tenantId: record.tenantId,
              permission: "membership:revoke",
              scope: "tenant",
              nowMs,
              audit: wiredAuditWriter("membership:revoke"),
            });
            if (evaluated.decision === "deny") {
              return Response.json(
                { error: "Forbidden: revoke denied.", code: evaluated.reason, reason: evaluated.reason },
                { status: 403 },
              );
            }
          }
          const revoked = await membershipStore.revokeMembership(membershipId, nowMs);
          if (!revoked) {
            return Response.json({ error: "Membership not found." }, { status: 404 });
          }
          // Issue #3113 (#945 Q5): a real revoke rotates the
          // affected user's active sessions (old ids dead).
          const memberRevokeRotation = await rotateUserSessionsForEnv(env, record.internalUserId, nowMs);
          if (memberRevokeRotation.unavailable) {
            console.warn("[iaaa] session rotation skipped: session listing unavailable");
          }
          const memberRevokeRotationCookie = sessionRotationCookie(request, memberRevokeRotation);
          // Issue #3155 (Q9): granter-revocation pass. Once this
          // revoke leaves the revoked user with no live
          // memberships, matrix-violating grants they made are
          // revoked with them; valid grants stay for the review
          // queue. The pass never fails the revoke: a missing
          // listing or a pass error skips it loudly, and audit
          // failures are counted in the response, not hidden.
          let granterRevocationPass: GranterRevocationPassResult & { auditFailures: string[]; reason?: string };
          try {
            const passEntries = await listSessionFamilyEntries(env, "iaaa-membership:");
            if (!passEntries) {
              console.warn("[iaaa] granter-revocation pass skipped: membership listing unavailable");
              granterRevocationPass = { reviewed: 0, revokedBindings: 0, revokedMemberships: [], skipped: true, auditFailures: [], reason: "listing-unavailable" };
            } else {
              const pass = await runGranterRevocationPass({
                store: membershipStore,
                allMemberships: listMembershipsFromEntries(passEntries),
                revokedUserId: record.internalUserId,
                nowMs,
              });
              const auditFailures: string[] = [];
              for (const passRevokedId of pass.revokedMemberships) {
                try {
                  const audited = await wiredAuditWriter("membership:revoke")({
                    permission: "membership:revoke",
                    principalId: session.internalUserId as string,
                    tenantId: record.tenantId,
                    decision: "allow",
                    nowMs,
                  });
                  if (!audited) {
                    console.warn(`[iaaa] granter-revocation pass audit failed for ${passRevokedId}`);
                    auditFailures.push(passRevokedId);
                  }
                } catch {
                  console.warn(`[iaaa] granter-revocation pass audit threw for ${passRevokedId}`);
                  auditFailures.push(passRevokedId);
                }
              }
              granterRevocationPass = { ...pass, auditFailures };
            }
          } catch {
            console.warn("[iaaa] granter-revocation pass failed; grants remain visible in the review queue");
            granterRevocationPass = { reviewed: 0, revokedBindings: 0, revokedMemberships: [], skipped: true, auditFailures: [], reason: "pass-error" };
          }
          return Response.json(
            { ok: true, membershipId, revoked: true, granterRevocationPass, sessionRotation: { rotatedCount: memberRevokeRotation.rotated.length, unavailable: memberRevokeRotation.unavailable } },
            memberRevokeRotationCookie ? { headers: { "Set-Cookie": memberRevokeRotationCookie } } : undefined,
          );
        }
        if (path === "/api/iaaa/membership/edit") {
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          const membershipId = typeof body?.membershipId === "string" ? body.membershipId.trim() : "";
          const bindings = Array.isArray(body?.roleBindings) ? body.roleBindings : [];
          if (membershipId === "" || bindings.length === 0) {
            return Response.json({ error: "membershipId and a non-empty roleBindings array are required." }, { status: 400 });
          }
          const record = await readMembershipById(kv, membershipId);
          if (!record) {
            return Response.json({ error: "Membership not found." }, { status: 404 });
          }
          if (record.internalUserId === session.internalUserId) {
            return Response.json({ error: "Self-edit is forbidden: another admin must edit your membership.", code: "SELF_GRANT" }, { status: 403 });
          }
          // Grant first, revoke second: a failed grant leaves the
          // old membership intact; a failed revoke after a
          // successful grant is reported (oldRevoked: false) rather
          // than hidden, so the principal never silently holds both.
          for (const raw of bindings) {
            const binding = raw as { scope?: unknown; workspaceId?: unknown };
            const scope = binding.scope === "platform" ? "platform" : "tenant";
            const evaluated = await evaluateWithObligations(membershipStore, {
              internalUserId: session.internalUserId,
              tenantId: record.tenantId,
              permission: "role:assign",
              scope,
              resourceScope:
                binding.scope === "workspace" && typeof binding.workspaceId === "string"
                  ? { workspaceId: binding.workspaceId }
                  : undefined,
              nowMs,
              authTimeMs: session.authTimeMs,
              audit: wiredAuditWriter("role:assign"),
            });
            if (evaluated.decision === "deny") {
              return Response.json(
                { error: "Forbidden: edit denied.", code: evaluated.reason, reason: evaluated.reason },
                { status: 403 },
              );
            }
          }
          // Issue #3155 (Q9): edits that add tenant-admin or
          // platform-admin bindings need two distinct approvers.
          // The first admin's edit proposes (202, pending) and
          // changes nothing; the second admin's identical edit
          // confirms and runs the grant-then-revoke sequence
          // below. Both approvers pass the obligation chain
          // above, on their own calls. Non-admin edits apply
          // immediately.
          if (
            isAdminRoleGrant(
              bindings.map((raw) => {
                const binding = raw as { role?: unknown };
                return { role: typeof binding.role === "string" ? binding.role : "" };
              }),
            )
          ) {
            const proposalStore = createGrantProposalStore(kv);
            const resolved = await resolveAdminGrantProposal(proposalStore, {
              kind: "edit",
              targetMembershipId: membershipId,
              granteeInternalUserId: record.internalUserId,
              tenantId: record.tenantId,
              roleBindings: bindings.map((raw) => {
                const binding = raw as { role: string; scope?: string; workspaceId?: string };
                return {
                  role: binding.role as Role,
                  scope: (binding.scope ?? "tenant") as AuthorizationScope,
                  ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
                };
              }),
              callerInternalUserId: session.internalUserId as string,
              nowMs,
            });
            if (resolved.action !== "confirm") {
              return Response.json(
                {
                  ok: true,
                  pending: true,
                  proposalId: resolved.proposal.proposalId,
                  approvers: resolved.proposal.approvers,
                },
                { status: 202 },
              );
            }
          }
          const granted = await grantMembership(membershipStore, {
            granterInternalUserId: session.internalUserId,
            internalUserId: record.internalUserId,
            tenantId: record.tenantId,
            workspaceId: record.workspaceId,
            roleBindings: bindings.map((raw) => {
              const binding = raw as { role: string; scope: string; workspaceId?: string };
              return {
                role: binding.role as Role,
                scope: binding.scope as AuthorizationScope,
                ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
                grantedBy: session.internalUserId as string,
              };
            }),
            nowMs,
            defaultExpiryDays: resolveGrantDefaultExpiryDays(env.IAAA_GRANT_DEFAULT_EXPIRY_DAYS),
          });
          if (!granted.ok) {
            return Response.json(
              { error: granted.error, code: granted.code },
              { status: granted.code === "GRANT_DENIED" ? 403 : 400 },
            );
          }
          const oldRevoked = await membershipStore.revokeMembership(membershipId, nowMs);
          // Issue #3113 (#945 Q5): an edit is a privilege change —
          // rotate the affected user's active sessions (old ids dead).
          const editRotation = await rotateUserSessionsForEnv(env, granted.membership.internalUserId, nowMs);
          if (editRotation.unavailable) {
            console.warn("[iaaa] session rotation skipped: session listing unavailable");
          }
          const editRotationCookie = sessionRotationCookie(request, editRotation);
          return Response.json(
            {
              ok: true,
              membership: granted.membership,
              oldRevoked,
              ...(oldRevoked ? {} : { warning: "New membership granted but the old record could not be revoked; the principal currently holds both." }),
              sessionRotation: { rotatedCount: editRotation.rotated.length, unavailable: editRotation.unavailable },
            },
            editRotationCookie ? { headers: { "Set-Cookie": editRotationCookie } } : undefined,
          );
        }
        // #2450 — per-user integration:connect denial. The blanket
        // member grant gives every member connect; these routes let
        // a tenant-admin revoke it for one member (deny) and restore
        // it (clear), without touching the member's other grants.
        // The revoke control's UI belongs to the user management
        // module (#2462); these routes are the layer it will call.
        if (path === "/api/iaaa/permission/deny") {
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          const targetId = typeof body?.internalUserId === "string" ? body.internalUserId.trim() : "";
          const permission = typeof body?.permission === "string" && body.permission.trim() !== "" ? body.permission.trim() : "integration:connect";
          if (targetId === "") {
            return Response.json({ error: "internalUserId is required." }, { status: 400 });
          }
          if (!(MANAGEABLE_DENIED_PERMISSIONS as readonly string[]).includes(permission)) {
            return Response.json({ error: "Only integration:connect may be denied per user in this slice." }, { status: 400 });
          }
          if (targetId === session.internalUserId) {
            return Response.json({ error: "Self-denial is forbidden: another admin must deny your permissions.", code: "SELF_DENY" }, { status: 403 });
          }
          const denyTenantId = typeof body?.tenantId === "string" && body.tenantId.trim() !== "" ? body.tenantId.trim() : tenantId;
          const managed = await canManagePermissionDenial(membershipStore, {
            managerInternalUserId: session.internalUserId,
            targetTenantId: denyTenantId,
            nowMs,
          });
          if (managed.decision === "deny") {
            return Response.json(
              { error: "Forbidden: denial denied.", code: managed.reason, reason: managed.reason },
              { status: 403 },
            );
          }
          const obligated = await evaluateWithObligations(membershipStore, {
            internalUserId: session.internalUserId,
            tenantId: denyTenantId,
            permission: "role:assign",
            scope: "tenant",
            nowMs,
            authTimeMs: session.authTimeMs,
            audit: denyAuditWriter("permission:deny"),
          });
          if (obligated.decision === "deny") {
            return Response.json(
              { error: "Forbidden: denial obligation failed.", code: obligated.reason, reason: obligated.reason },
              { status: 403 },
            );
          }
          const denialStore = createKvPermissionDenialStore(sessionStore(env));
          const existing = (await denialStore.getDenialsByUser(targetId)).find(
            (d) => d.tenantId === denyTenantId && d.permission === "integration:connect",
          );
          if (existing) {
            return Response.json({ ok: true, denial: existing, alreadyDenied: true });
          }
          const denial = await denialStore.putDenial({
            denialId: crypto.randomUUID(),
            internalUserId: targetId,
            tenantId: denyTenantId,
            permission: "integration:connect",
            deniedBy: session.internalUserId,
            deniedAtMs: nowMs,
          });
          // Issue #3113 (#945 Q5): a deny changes what the user's
          // sessions may do — rotate the affected user's sessions.
          const denyRotation = await rotateUserSessionsForEnv(env, targetId, nowMs);
          if (denyRotation.unavailable) {
            console.warn("[iaaa] session rotation skipped: session listing unavailable");
          }
          const denyRotationCookie = sessionRotationCookie(request, denyRotation);
          return Response.json(
            { ok: true, denial, sessionRotation: { rotatedCount: denyRotation.rotated.length, unavailable: denyRotation.unavailable } },
            { status: 201, ...(denyRotationCookie ? { headers: { "Set-Cookie": denyRotationCookie } } : {}) },
          );
        }
        if (path === "/api/iaaa/permission/clear") {
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          const targetId = typeof body?.internalUserId === "string" ? body.internalUserId.trim() : "";
          const permission = typeof body?.permission === "string" && body.permission.trim() !== "" ? body.permission.trim() : "integration:connect";
          if (targetId === "") {
            return Response.json({ error: "internalUserId is required." }, { status: 400 });
          }
          if (!(MANAGEABLE_DENIED_PERMISSIONS as readonly string[]).includes(permission)) {
            return Response.json({ error: "Only integration:connect may be cleared per user in this slice." }, { status: 400 });
          }
          if (targetId === session.internalUserId) {
            return Response.json({ error: "Self-clear is forbidden: another admin must restore your permissions.", code: "SELF_GRANT" }, { status: 403 });
          }
          const denyTenantId = typeof body?.tenantId === "string" && body.tenantId.trim() !== "" ? body.tenantId.trim() : tenantId;
          const managed = await canManagePermissionDenial(membershipStore, {
            managerInternalUserId: session.internalUserId,
            targetTenantId: denyTenantId,
            nowMs,
          });
          if (managed.decision === "deny") {
            return Response.json(
              { error: "Forbidden: clear denied.", code: managed.reason, reason: managed.reason },
              { status: 403 },
            );
          }
          const obligated = await evaluateWithObligations(membershipStore, {
            internalUserId: session.internalUserId,
            tenantId: denyTenantId,
            permission: "role:assign",
            scope: "tenant",
            nowMs,
            authTimeMs: session.authTimeMs,
            audit: denyAuditWriter("permission:clear"),
          });
          if (obligated.decision === "deny") {
            return Response.json(
              { error: "Forbidden: clear obligation failed.", code: obligated.reason, reason: obligated.reason },
              { status: 403 },
            );
          }
          const denialStore = createKvPermissionDenialStore(sessionStore(env));
          const existing = (await denialStore.getDenialsByUser(targetId)).find(
            (d) => d.tenantId === denyTenantId && d.permission === "integration:connect",
          );
          if (!existing) {
            return Response.json({ ok: true, cleared: false });
          }
          await denialStore.clearDenial(existing.denialId);
          // Issue #3113 (#945 Q5): clearing a deny restores what
          // the user's sessions may do — rotate them as well.
          const clearRotation = await rotateUserSessionsForEnv(env, targetId, nowMs);
          if (clearRotation.unavailable) {
            console.warn("[iaaa] session rotation skipped: session listing unavailable");
          }
          const clearRotationCookie = sessionRotationCookie(request, clearRotation);
          return Response.json(
            { ok: true, cleared: true, denialId: existing.denialId, sessionRotation: { rotatedCount: clearRotation.rotated.length, unavailable: clearRotation.unavailable } },
            clearRotationCookie ? { headers: { "Set-Cookie": clearRotationCookie } } : undefined,
          );
        }
        if (path === "/api/iaaa/deactivate") {
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          if (body?.confirm !== "deactivate") {
            return Response.json({ error: "Deactivation requires { confirm: \"deactivate\" }." }, { status: 400 });
          }
          // Issue #2660 (monetization Phase 2.5): the subscription gate.
          // Deactivation revokes the identity a subscription bills against,
          // so an unexpired subscription must block deactivation explicitly:
          // never silently canceled (cancel mechanics belong to 2.7) and
          // never silently kept charging (the user would have no session
          // left with which to cancel). Logins come from the principal's
          // own sessions — the same discovery runOffboard uses, never a
          // caller-supplied identity. The gate reads AGENT_DB only (#1819:
          // zero new SessionStore reads). Nothing is revoked before the
          // gate, and a KNOWN active subscription always blocks (409).
          // Deliberate non-fail-closed case: when the subscription store
          // is unavailable (or a login's read throws), deactivation still
          // proceeds — deactivation is security revocation first, and
          // blocking it on a billing-store outage would leave compromised
          // sessions/keys unrevocable. The unverified state is recorded
          // in the response's subscriptionGate field, never silent, so
          // the interaction is stated even when it cannot be checked.
          const deps = offboardDeps();
          const listed = await deps.sessions.list();
          const resolved = resolveOffboardSessions(listed, session.internalUserId.trim(), []);
          const logins = [...new Set(resolved.map((e) => e.githubLogin))];
          const subscriptionGate: {
            checked: boolean;
            loginsWithActive: string[];
            unverified: Array<{ login?: string; reason: string }>;
          } = { checked: true, loginsWithActive: [], unverified: [] };
          const subs = createSubscriptionAdapter(env);
          if (!subs) {
            subscriptionGate.checked = false;
            subscriptionGate.unverified.push({ reason: "subscription-store-unavailable" });
          } else {
            for (const login of logins) {
              try {
                const rows = await subs.listSubscriptions(login);
                if (hasUnexpiredSubscription(rows, nowMs)) subscriptionGate.loginsWithActive.push(login);
              } catch (err: any) {
                subscriptionGate.checked = false;
                subscriptionGate.unverified.push({ login, reason: err?.message ?? "unknown error" });
              }
            }
          }
          if (subscriptionGate.loginsWithActive.length > 0) {
            return Response.json(
              {
                error:
                  "Deactivation blocked: an active subscription is still billing this identity. Cancel it first, then deactivate.",
                code: "DeactivationBlockedByActiveSubscription",
                cancelRoute: commercialPath("subscriptionCancel"),
                loginsWithActive: subscriptionGate.loginsWithActive,
              },
              { status: 409 },
            );
          }
          const report = await runOffboard(deps, {
            internalUserId: session.internalUserId,
            tenantId,
            nowMs,
            actorInternalUserId: session.internalUserId,
            auditAction: "iaaa.deactivate",
          });
          // Issue #2660: commercial-plane mail suppression. The iaaa Kv
          // flag runOffboard sets is not consulted by any commercial mail
          // path, so the scheduled digest pass would keep mailing a
          // deactivated principal. Flip the lifecycle preference row for
          // each discovered login instead: the pass enumerates
          // digestEnabled=1 rows only, and the send-time checks enforce
          // both flags. Per-login containment: one login's failure never
          // blocks the others, and every outcome is reported in the
          // response, never silent. A suppression failure after a
          // completed offboard is surfaced here; operator recovery is
          // POST lifecycle/preferences (an operator may write prefs).
          // No extra audit marker is emitted: offboardAudit hardcodes
          // outcome "succeeded", which would misdescribe a partial
          // suppression failure — the response body is the record, and
          // the offboard itself is audited by runOffboard's audit step.
          const commercialSuppression: {
            suppressed: string[];
            noRow: string[];
            failed: Array<{ login: string; error: string }>;
          } = { suppressed: [], noRow: [], failed: [] };
          const lifecycle = createLifecycleAdapter(env);
          if (!lifecycle) {
            for (const login of logins) {
              commercialSuppression.failed.push({ login, error: "lifecycle-store-unavailable" });
            }
          } else {
            for (const login of logins) {
              try {
                const flipped = await lifecycle.suppressMailForUser(login);
                if (flipped) commercialSuppression.suppressed.push(login);
                else commercialSuppression.noRow.push(login);
              } catch (err: any) {
                commercialSuppression.failed.push({ login, error: err?.message ?? "unknown error" });
              }
            }
          }
          return Response.json(
            { ok: true, ...report, subscriptionGate, commercialSuppression },
            { headers: { "Set-Cookie": clearSessionCookie() } },
          );
        }
        // POST /api/iaaa/offboard — admin offboarding of another principal
        // (or, with the caller's own id, the admin path to self-offboard).
        if (request.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        const targetId = typeof body?.internalUserId === "string" ? body.internalUserId.trim() : "";
        const loginHint = typeof body?.login === "string" ? body.login.trim() : "";
        if (targetId === "" && loginHint === "") {
          return Response.json({ error: "internalUserId or login is required." }, { status: 400 });
        }
        if (!callerIsPlatformAdmin && !(await callerCanGrantTenantAdmin())) {
          return Response.json({ error: "Forbidden: offboarding requires admin access." }, { status: 403 });
        }
        // A login-only offboard targets legacy sessions for that
        // login; it needs a principal id for the membership/key
        // stores, so without an internalUserId it offboards the
        // legacy session set under a login-scoped principal id.
        // Wired sessions are never selected by login (see the
        // wiring module's identity rules).
        const principalId = targetId !== "" ? targetId : `login:${loginHint}`;
        const report = await runOffboard(offboardDeps(), {
          internalUserId: principalId,
          tenantId,
          nowMs,
          actorInternalUserId: session.internalUserId,
          extraLogins: loginHint !== "" ? [loginHint] : [],
          auditAction: "iaaa.offboard",
        });
        return Response.json({ ok: true, ...report });
      } catch {
        return Response.json({ error: "IAAA lifecycle action unavailable." }, { status: 500 });
      }
    }

    // --- API Keys (issue #180): per-user keys for the MCP transport ---
    // Session-required, and a session can only ever list, mint, or revoke
    // its OWN keys (the #154 pattern: identity = session login only).
    // Minting returns the plaintext secret exactly once; the server stores
    // only its SHA-256 hash (src/security/apiKeys.ts).
    if (path === "/api/api-keys") {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ error: "Unauthorized: Please log in with GitHub" }, { status: 401 });
      }
      const login = session.githubLogin;

      if (request.method === "GET") {
        return Response.json({ keys: await listApiKeys(env, login) });
      }
      if (request.method === "POST") {
        // #945 Phase 2b-part1 step-up pilot: minting a credential
        // is a sensitive action. Wiring ON + stale authentication
        // (including every legacy session, which has no authTimeMs)
        // fails closed with 403 and mints nothing; the user
        // re-authenticates and retries. Listing and revoking keys
        // are deliberately NOT gated: revocation especially must
        // never be blocked by staleness.
        // #945 GitHub end-to-end: minting is NOT additionally PDP
        // gated — no Slice 3 permission maps to credential minting
        // (there is no credential:issue permission), so step-up
        // remains the sole gate here. See the defaults doc.
        if (requiresStepUpForMint(session, isWiringEnabled(env), Date.now())) {
          return Response.json({ error: "Step-up authentication required: please sign in again and retry." }, { status: 403 });
        }
        const body = (await request.json().catch(() => ({}))) as { label?: unknown };
        const label = typeof body.label === "string" ? body.label : "";
        const minted = await mintApiKey(env, login, label);
        return Response.json({ key: minted.key, secret: minted.secret }, { status: 201 });
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    if (path.startsWith("/api/api-keys/")) {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ error: "Unauthorized: Please log in with GitHub" }, { status: 401 });
      }
      if (request.method === "DELETE") {
        const keyId = decodeURIComponent(path.slice("/api/api-keys/".length));
        const revoked = keyId ? await revokeApiKey(env, session.githubLogin, keyId) : false;
        if (!revoked) return Response.json({ error: "API key not found." }, { status: 404 });
        return Response.json({ ok: true });
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
  return null;
}
