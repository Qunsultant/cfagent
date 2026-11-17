/**
 * IBKR Hosted MCP OAuth 2.1 + PKCE + DCR Lifecycle & v1 Read-Only Guard
 * (issues #4676 / #3410, Gap 22).
 *
 * Security invariants:
 * - Tokens live ONLY in the SessionStore Durable Object (namespace "ibkr").
 * - Tokens never appear in logs, chat responses, exceptions, or client state.
 * - Region gating: IN and JP are refused cleanly with IBKR_REGION_UNAVAILABLE.
 * - v1 is strictly read-only (`mcp.read`); any write/order/trade tool is
 *   refused fail-closed at the Copilot/allowlist layer.
 */
import type { Env } from "../types";
import { IBKR_CONFIG, resolveIbkrMcpUrl } from "../config/ibkr";
import { SESSION_LIMITS } from "../config/sessionLimits";
import { createStoreKv, type DoNamespaceLike } from "../data/durableKv";
import { createState, verifyState } from "./session";
import {
  buildAuthorizationUrl,
  createPkcePair,
  discoverAuthorizationServerFromResource,
  exchangeAuthorizationCode,
  refreshAccessToken,
  type AuthorizationServerMetadata,
} from "./oauth2Core";

export const IBKR_NAMESPACE = "ibkr";
export const IBKR_SINGLE_PLATFORM_NOTICE =
  "Authorizing Interactive Brokers in Copilot disconnects any other connected AI platform (such as Claude or ChatGPT), because IBKR allows one AI platform connection per account at a time. IBKR MCP access is live-account only (no paper scoping) and v1 is read-only.";

export interface IbkrTokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly clientId: string;
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly storedAt: string;
  readonly userLogin: string;
  readonly accountId?: string;
  readonly verifiedTools?: string[];
}

export interface IbkrOAuthPending {
  readonly state: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly redirectUri: string;
  readonly userLogin: string;
  readonly createdAtMs: number;
}

export interface IbkrConnectionDescription {
  readonly connected: boolean;
  readonly accountId?: string;
  readonly storedAt?: string;
  readonly verifiedTools: readonly string[];
  readonly readOnlyV1: true;
  readonly singlePlatformNotice: string;
}

export interface IbkrRegionCheckResult {
  readonly allowed: boolean;
  readonly code?: "IBKR_REGION_UNAVAILABLE";
  readonly message?: string;
}

export function checkIbkrRegionAvailability(countryCode?: string | null): IbkrRegionCheckResult {
  const normalized = (countryCode ?? "").trim().toUpperCase();
  if (normalized && IBKR_CONFIG.blockedRegions.includes(normalized)) {
    return {
      allowed: false,
      code: "IBKR_REGION_UNAVAILABLE",
      message: `Interactive Brokers MCP is not available in region ${normalized}.`,
    };
  }
  return { allowed: true };
}

/**
 * Fail-closed v1 read-only tool allowlist check.
 *
 * Strips the SDK `tool_ibkr_` namespace prefix if present. Never permits
 * order placement, cancellation, modification, or transfer tools in v1.
 */
export function isIbkrToolAllowedV1(
  toolName: string,
  pinnedAllowlist?: readonly string[],
): boolean {
  const bare = toolName.replace(/^tool_ibkr_/, "").trim().toLowerCase();
  if (!bare) return false;

  if (IBKR_CONFIG.v1BlockedToolTerms.some((term) => bare.includes(term))) {
    return false;
  }

  if (pinnedAllowlist && pinnedAllowlist.length > 0) {
    return pinnedAllowlist.some((allowed) => allowed.toLowerCase() === bare);
  }

  return IBKR_CONFIG.v1ReadOnlyPrefixes.some((prefix) => bare.startsWith(prefix));
}

export function filterIbkrV1Tools(
  toolNames: readonly string[],
  pinnedAllowlist?: readonly string[],
): string[] {
  return toolNames.filter((name) => isIbkrToolAllowedV1(name, pinnedAllowlist));
}

function getIbkrKv(env: Env) {
  const ns = (env as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE;
  if (!ns) return null;
  return createStoreKv({
    namespace: ns,
    namespaceName: IBKR_NAMESPACE,
    legacyFallback: false,
  });
}

function tokenKey(userLogin: string): string {
  return `ibkr:token:${userLogin.toLowerCase()}`;
}

function pendingKey(state: string): string {
  return `ibkr:pending:${state}`;
}

export async function getIbkrTokenSet(env: Env, userLogin: string): Promise<IbkrTokenSet | null> {
  const kv = getIbkrKv(env);
  if (!kv || !userLogin) return null;
  const raw = await kv.get(tokenKey(userLogin));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<IbkrTokenSet>;
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken.trim()) return null;
    return parsed as IbkrTokenSet;
  } catch {
    return null;
  }
}

export async function storeIbkrTokenSet(env: Env, tokenSet: IbkrTokenSet): Promise<void> {
  const kv = getIbkrKv(env);
  if (!kv) {
    throw new Error("SessionStore Durable Object is not bound; cannot store IBKR tokens.");
  }
  await kv.put(tokenKey(tokenSet.userLogin), JSON.stringify(tokenSet));
}

export async function revokeIbkrConnection(env: Env, userLogin: string): Promise<void> {
  const kv = getIbkrKv(env);
  if (!kv || !userLogin) return;
  await kv.delete(tokenKey(userLogin));
}

export async function recordIbkrDiscoveredTools(
  env: Env,
  userLogin: string,
  rawTools: readonly string[],
): Promise<string[]> {
  const existing = await getIbkrTokenSet(env, userLogin);
  if (!existing) return [];
  const filtered = filterIbkrV1Tools(rawTools);
  await storeIbkrTokenSet(env, {
    ...existing,
    verifiedTools: filtered,
  });
  return filtered;
}

export async function describeIbkrConnection(
  env: Env,
  userLogin: string,
): Promise<IbkrConnectionDescription> {
  const tokenSet = await getIbkrTokenSet(env, userLogin);
  return {
    connected: Boolean(tokenSet),
    accountId: tokenSet?.accountId,
    storedAt: tokenSet?.storedAt,
    verifiedTools: tokenSet?.verifiedTools ?? [],
    readOnlyV1: true,
    singlePlatformNotice: IBKR_SINGLE_PLATFORM_NOTICE,
  };
}

async function registerDynamicClient(
  metadata: AuthorizationServerMetadata & { registration_endpoint?: string },
  redirectUri: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (!metadata.registration_endpoint) {
    throw new Error("IBKR authorization server metadata did not publish a DCR registration_endpoint.");
  }
  const resp = await fetchImpl(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "cfagent Copilot (IBKR MCP)",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: IBKR_CONFIG.readOnlyScopes,
    }),
    signal: AbortSignal.timeout(IBKR_CONFIG.requestTimeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`IBKR dynamic client registration failed (HTTP ${resp.status}).`);
  }
  const data = (await resp.json().catch(() => null)) as { client_id?: unknown } | null;
  if (!data || typeof data.client_id !== "string" || !data.client_id.trim()) {
    throw new Error("IBKR dynamic client registration response missing client_id.");
  }
  return data.client_id;
}

export async function startIbkrOAuth(input: {
  env: Env;
  userLogin: string;
  origin: string;
  countryCode?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{ authorizationUrl: string; state: string; notice: string }> {
  const region = checkIbkrRegionAvailability(input.countryCode);
  if (!region.allowed) {
    throw new Error(region.message || "IBKR MCP is unavailable in this region.");
  }

  const kv = getIbkrKv(input.env);
  if (!kv) {
    throw new Error("SessionStore Durable Object is not bound; cannot initiate IBKR OAuth.");
  }

  const doFetch = input.fetchImpl ?? fetch;
  const mcpUrl = resolveIbkrMcpUrl(input.env);
  const metadata = await discoverAuthorizationServerFromResource(mcpUrl, doFetch);
  const redirectUri = `${input.origin.replace(/\/+$/, "")}${IBKR_CONFIG.callbackPath}`;
  const clientId = await registerDynamicClient(
    metadata as AuthorizationServerMetadata & { registration_endpoint?: string },
    redirectUri,
    doFetch,
  );
  const pkce = await createPkcePair();
  const state = await createState(input.env);

  const pending: IbkrOAuthPending = {
    state,
    codeVerifier: pkce.verifier,
    clientId,
    issuer: metadata.issuer,
    tokenEndpoint: metadata.token_endpoint,
    redirectUri,
    userLogin: input.userLogin,
    createdAtMs: Date.now(),
  };
  await kv.put(pendingKey(state), JSON.stringify(pending));

  const authorizationUrl = buildAuthorizationUrl({
    authorizationEndpoint: metadata.authorization_endpoint,
    clientId,
    redirectUri,
    scopes: IBKR_CONFIG.readOnlyScopes,
    state,
    codeChallenge: pkce.challenge,
    resource: mcpUrl,
  });

  return {
    authorizationUrl,
    state,
    notice: IBKR_SINGLE_PLATFORM_NOTICE,
  };
}

export async function completeIbkrOAuthCallback(input: {
  env: Env;
  code: string;
  state: string;
  fetchImpl?: typeof fetch;
}): Promise<IbkrConnectionDescription> {
  const kv = getIbkrKv(input.env);
  if (!kv) {
    throw new Error("SessionStore Durable Object is not bound; cannot complete IBKR OAuth.");
  }

  const stateValid = await verifyState(input.env, input.state);
  if (!stateValid) {
    throw new Error("Invalid or expired IBKR OAuth state.");
  }

  const rawPending = await kv.get(pendingKey(input.state));
  if (!rawPending) {
    throw new Error("IBKR OAuth pending session not found or already consumed.");
  }
  await kv.delete(pendingKey(input.state));

  const pending = JSON.parse(rawPending) as IbkrOAuthPending;
  const maxAgeMs = SESSION_LIMITS.publicOAuthPendingMaxAgeMs;
  if (Date.now() - pending.createdAtMs > maxAgeMs) {
    throw new Error("IBKR OAuth authorization flow expired; please restart connection.");
  }

  const tokens = await exchangeAuthorizationCode(
    {
      tokenEndpoint: pending.tokenEndpoint,
      clientId: pending.clientId,
      code: input.code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
    },
    input.fetchImpl ?? fetch,
  );

  const tokenSet: IbkrTokenSet = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    clientId: pending.clientId,
    issuer: pending.issuer,
    tokenEndpoint: pending.tokenEndpoint,
    storedAt: new Date().toISOString(),
    userLogin: pending.userLogin,
  };
  await storeIbkrTokenSet(input.env, tokenSet);
  return describeIbkrConnection(input.env, pending.userLogin);
}

export async function getIbkrAccessToken(
  env: Env,
  userLogin: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const tokenSet = await getIbkrTokenSet(env, userLogin);
  if (!tokenSet) return null;

  const skewMs = SESSION_LIMITS.oauthExpirySkewMs;
  if (!tokenSet.expiresAt || Date.now() < tokenSet.expiresAt - skewMs) {
    return tokenSet.accessToken;
  }
  if (!tokenSet.refreshToken) {
    return null;
  }

  const refreshed = await refreshAccessToken(
    {
      tokenEndpoint: tokenSet.tokenEndpoint,
      clientId: tokenSet.clientId,
      refreshToken: tokenSet.refreshToken,
    },
    options.fetchImpl ?? fetch,
  );

  const updated: IbkrTokenSet = {
    ...tokenSet,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? tokenSet.refreshToken,
    expiresAt: refreshed.expiresAt ?? tokenSet.expiresAt,
  };
  await storeIbkrTokenSet(env, updated);
  return updated.accessToken;
}
