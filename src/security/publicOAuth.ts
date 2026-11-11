/**
 * Public.com Security Layer: OAuth 2.1 Token Lifecycle (RESOURCE provider).
 *
 * Public is a RESOURCE provider in the E*TRADE shape (etradeOAuth.ts
 * is the model): its tokens are data-API credentials bound to the
 * signed-in user, stored server-side only, and they NEVER create or
 * replace a login session — this module imports no login machinery
 * (no createSession, no wired-login tail). It is deliberately NOT a
 * LoginProvider and is not registered in the #945 provider registry.
 *
 * Protocol mechanics live in the SHARED core (oauth2Core.ts): PKCE
 * S256, RFC 8414 discovery (elicited from the MCP server's 401
 * challenge, RFC 9728), authorization-URL building, code exchange,
 * refresh grant. CSRF state uses the established session.ts
 * createState/verifyState primitives. This module owns only what is
 * Public-specific: the token-set record + its SessionStore keys, the
 * pending-flow record, discovery against the MCP resource, the
 * Client ID Metadata Document, and the token source the data
 * provider's adapter consumes.
 *
 * Client identity: Public publishes no RFC 7591 registration
 * endpoint, so the client identifies via a Client ID Metadata
 * Document (draft-ietf-oauth-client-id-metadata-document) served by
 * this app at /.well-known/oauth-client-id-metadata-document; the
 * client_id IS that URL on the app origin.
 *
 * PROVENANCE / HONEST LIMIT (verified live in the sibling repo
 * OpenAIMP/cfpay): Public's authorization server rejects every
 * client_id not registered with them directly — the metadata-document
 * mechanism is refused in practice even though their metadata
 * advertises support for it. The connect flow below is built to the
 * documented protocol and DETECTS that rejection before redirecting
 * the browser (PublicClientRejectedError carries the explanation);
 * the credential path verified working end-to-end is the pasted
 * personal access token, which stores through the SAME token-set
 * record (kind "personal") so the adapter has exactly ONE token
 * source either way.
 */

import type { Env } from "../types";
import { SESSION_LIMITS } from "../config/sessionLimits";
import { createStoreKv, type DoNamespaceLike } from "../data/durableKv";
import { type KvLike } from "./kvResilience";
import {
  createTokenPorts,
  isTokenPortsEnabled,
} from "../data/createTokenPorts";
import type { PublicTokenPort } from "../data/tokenPorts";
import { createState, verifyState } from "./session";
import {
  buildAuthorizationUrl,
  discoverAuthorizationServerFromResource,
  exchangeAuthorizationCode,
  refreshAccessToken,
  createPkcePair,
  type AuthorizationServerMetadata,
} from "./oauth2Core";
import { PublicMcpClient, PUBLIC_MCP_URL } from "../mcps/public/publicMcp";

export const DEFAULT_PUBLIC_OAUTH_SCOPES = "openid offline_access marketdata trading.read trading.write";

/** Path serving this app's Client ID Metadata Document; the client_id is <origin> + this path. */
export const PUBLIC_CLIENT_METADATA_PATH = "/.well-known/oauth-client-id-metadata-document";
export const PUBLIC_CALLBACK_PATH = "/auth/public/callback";

const PENDING_MAX_AGE_MS = SESSION_LIMITS.publicOAuthPendingMaxAgeMs;
const EXPIRY_SKEW_MS = SESSION_LIMITS.oauthExpirySkewMs;

/**
 * Shown when Public refuses this client_id (see the header's
 * provenance note). The authorize-endpoint probe in startPublicOAuth
 * turns a dead-end error on Public's site into this explanation.
 */
export const PUBLIC_CLIENT_REJECTED_MESSAGE = [
  "Public.com will not authorise this application.",
  "",
  "Their authorization server accepts only clients registered with them directly,",
  "and provides no endpoint to register one. A Client ID Metadata Document is not",
  "accepted either, despite their metadata advertising support for it.",
  "",
  "To use Public.com here, connect with a personal access token instead:",
  "create one on the API settings page of your Public account and paste it",
  "via the Public connect API (POST /api/public/connect). That path is verified working.",
].join("\n");

export class PublicClientRejectedError extends Error {
  constructor() {
    super(PUBLIC_CLIENT_REJECTED_MESSAGE);
    this.name = "PublicClientRejectedError";
  }
}

/* ------------------------------ token set ---------------------------- */

export interface PublicTokenSet {
  /** "oauth" = Connect Public grant; "personal" = pasted personal access token. */
  kind: "oauth" | "personal";
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry (ms epoch) for OAuth access tokens; absent for personal tokens. */
  expiresAt?: number;
  clientId?: string;
  issuer?: string;
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  storedAt: string;
  userLogin: string;
  /** #4035: when the credential was verified against the MCP server. */
  verifiedAt?: string;
  /** #4035: the tool names the verification observed (tools/list). */
  verifiedTools?: string[];
}

export interface PublicOAuthPending {
  state: string;
  codeVerifier: string;
  clientId: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  redirectUri: string;
  userLogin: string;
  createdAt: number;
}

// Token storage keys (SessionStore DO, namespace "public") — the
// etrade keying idiom: provider-prefixed, login-scoped. Public has no
// TEST/PROD split (one hosted MCP server), so no env segment.
export const publicTokenKey = (userLogin: string): string => `public:token:${userLogin}`;
const publicPendingKey = (state: string): string => `public:oauth_pending:${state}`;

function getKv(env: Env): KvLike {
  return createStoreKv({
    namespace: env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
    namespaceName: "public",
    legacyFallback: false,
  });
}

/**
 * Issue #2434 (#1976 step 5c): the token family's Public port.
 * When TOKEN_PORTS_ENABLED is on, the storage functions below
 * delegate to it (over the SAME SessionStore DO and kv_store
 * table); when off, this module's direct funnel composition
 * above is the serving path, unchanged. Signatures never
 * change either way — existing callers are untouched.
 */
function publicTokenPort(env: Env): PublicTokenPort {
  return createTokenPorts(env).public;
}

/** Stores a confirmed token set in the SessionStore DO. */
export async function storePublicTokens(env: Env, tokenSet: PublicTokenSet): Promise<void> {
  if (isTokenPortsEnabled(env)) {
    await publicTokenPort(env).storeTokenSet(tokenSet);
    return;
  }
  await getKv(env).put(publicTokenKey(tokenSet.userLogin), JSON.stringify(tokenSet));
}

/** Retrieves the stored token set for a user, or null. */
export async function getStoredPublicTokens(
  env: Env,
  userLogin: string
): Promise<PublicTokenSet | null> {
  if (isTokenPortsEnabled(env)) {
    return publicTokenPort(env).getTokenSet(userLogin);
  }
  const raw = await getKv(env).get(publicTokenKey(userLogin));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PublicTokenSet;
    return typeof parsed?.accessToken === "string" && parsed.accessToken
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Deletes the stored token set locally (no upstream call). */
export async function revokeStoredPublicTokens(env: Env, userLogin: string): Promise<void> {
  if (isTokenPortsEnabled(env)) {
    await publicTokenPort(env).deleteTokenSet(userLogin);
    return;
  }
  await getKv(env).delete(publicTokenKey(userLogin));
}

/**
 * Stores a pasted personal access token through the SAME token-set
 * record the OAuth grant uses (kind "personal"), so every consumer —
 * the adapter's token source above all — reads exactly one record.
 */
export async function storePublicPersonalToken(
  env: Env,
  userLogin: string,
  token: string,
  verification?: { verifiedAt: string; tools: string[] },
): Promise<void> {
  await storePublicTokens(env, {
    kind: "personal",
    accessToken: token,
    storedAt: new Date().toISOString(),
    userLogin,
    ...(verification
      ? { verifiedAt: verification.verifiedAt, verifiedTools: [...verification.tools] }
      : {}),
  });
}

/**
 * Best-effort upstream revocation of an OAuth grant, then the local
 * record is dropped regardless (etradeOAuth.ts revoke pattern).
 */
export async function revokePublicTokens(
  env: Env,
  userLogin: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const record = await getStoredPublicTokens(env, userLogin);
  if (record?.kind === "oauth" && record.revocationEndpoint && record.clientId) {
    try {
      await fetchImpl(record.revocationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: record.accessToken,
          client_id: record.clientId,
        }).toString(),
      });
    } catch {
      /* the local record is dropped below regardless */
    }
  }
  await revokeStoredPublicTokens(env, userLogin);
}

/* --------------------------- token source ---------------------------- */

function isExpired(set: PublicTokenSet, skewMs = EXPIRY_SKEW_MS): boolean {
  return typeof set.expiresAt === "number" && Date.now() + skewMs >= set.expiresAt;
}

/**
 * Reduce a stored token set to a usable access token, refreshing an
 * expired OAuth set through the shared core and persisting the new
 * set. Returns null when nothing usable exists (no record, an
 * expired set with no refresh token, or a failed refresh) — callers
 * report "not connected" honestly rather than sending a dead token.
 */
async function usableAccessToken(
  env: Env,
  set: PublicTokenSet,
  fetchImpl: typeof fetch
): Promise<string | null> {
  if (set.kind === "personal") return set.accessToken;
  if (!isExpired(set)) return set.accessToken;
  if (!set.refreshToken || !set.tokenEndpoint || !set.clientId) return null;
  try {
    const refreshed = await refreshAccessToken(
      {
        tokenEndpoint: set.tokenEndpoint,
        refreshToken: set.refreshToken,
        clientId: set.clientId,
      },
      fetchImpl
    );
    await storePublicTokens(env, {
      ...set,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? set.refreshToken,
      expiresAt: refreshed.expiresAt,
      storedAt: new Date().toISOString(),
    });
    return refreshed.accessToken;
  } catch {
    return null;
  }
}

/**
 * Issue #4048: the deployment credential, when the operator configured
 * one (PUBLIC_API_KEY, synced by deploy.yml like ALPACA_*). It is a
 * FALLBACK, never an override: a user's own stored token always wins,
 * and the status surface names which source is in use so nobody
 * mistakes a shared deployment key for their personal account. Reads
 * only — the Public trade commands refuse a deployment-sourced credential.
 */
export function publicDeploymentToken(env: Env): string | null {
  const raw = (env as unknown as Record<string, unknown>).PUBLIC_API_KEY;
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  return token.length > 10 ? token : null;
}

/**
 * THE adapter's token source: the signed-in user's usable Public
 * access token, or null. Reads exactly the record the connect paths
 * write. One login's stored token is never served to another login;
 * the deployment key (#4048) is the one documented exception — it is
 * shared by every login on the deployment, which is why the status
 * surface and every read name the source it served from.
 */
export async function getPublicAccessToken(
  env: Env,
  userLogin: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  if (!userLogin) return null;
  const set = await getStoredPublicTokens(env, userLogin);
  if (!set) return publicDeploymentToken(env);
  return usableAccessToken(env, set, fetchImpl);
}

/** #4048: whose credential would serve this login's Public reads. */
export type PublicCredentialSource = "user" | "deployment" | null;

/**
 * Issue #4048: NAMES the credential that would serve this login — the
 * login's own stored token ("user"), else the deployment key
 * ("deployment"), else null. Never returns the token itself, so the
 * source can travel in a status body, a tool result or an audit row.
 */
export async function getPublicCredentialSource(
  env: Env,
  userLogin: string
): Promise<PublicCredentialSource> {
  if (!userLogin) return null;
  const set = await getStoredPublicTokens(env, userLogin);
  if (set) return "user";
  return publicDeploymentToken(env) ? "deployment" : null;
}

/* --------------------- credential-reference seam --------------------- */

/** The reference an operator configures for the canonical per-user token record. */
export function suggestedPublicCredentialRef(userLogin: string): string {
  return `sessionstore:public:${publicTokenKey(userLogin)}`;
}

export type PublicCredentialResolution =
  | { ok: true; accessToken: string }
  | { ok: false; error: string };

/**
 * Resolve a lifecycle credential REFERENCE to a usable access token
 * (the verify action's seam). The reference names WHERE the token
 * lives, never its value:
 *   sessionstore:<ns>:<key...> — a token-set record in the
 *     SessionStore (the canonical public key is the connect flow's
 *     own record; other keys holding the same record shape work too).
 *   env:NAME / bare NAME — an environment variable holding a personal
 *     access token (headless deployments).
 * Anything else is an honest failure naming the problem.
 */
export async function resolvePublicCredentialRef(
  env: Env,
  userLogin: string,
  credentialRef: string | null | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<PublicCredentialResolution> {
  if (!credentialRef) {
    return {
      ok: false,
      error:
        `no credential reference is configured for provider "public"; configure one to verify ` +
        `(the connect flow's token record is named by the reference "${suggestedPublicCredentialRef(userLogin)}").`,
    };
  }
  if (credentialRef.startsWith("sessionstore:")) {
    const rest = credentialRef.slice("sessionstore:".length);
    const sep = rest.indexOf(":");
    const ns = sep === -1 ? rest : rest.slice(0, sep);
    const key = sep === -1 ? "" : rest.slice(sep + 1);
    if (!ns || !key) {
      return { ok: false, error: `credential reference "${credentialRef}" is not a complete sessionstore reference (expected sessionstore:<namespace>:<key>).` };
    }
    // Issue #2434: with TOKEN_PORTS_ENABLED on, the per-call
    // bucket read is the port's readRefRecord operation (the
    // referenced bucket composed by the family's root); off,
    // the per-call funnel composition here serves, unchanged.
    let raw: string | null;
    if (isTokenPortsEnabled(env)) {
      raw = await publicTokenPort(env).readRefRecord(ns, key);
    } else {
      const kv = createStoreKv({
        namespace: env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
        namespaceName: ns,
        legacyFallback: false,
      });
      raw = await kv.get(key);
    }
    if (!raw) {
      return {
        ok: false,
        error: `no Public token is stored at the configured reference "${credentialRef}"; connect Public (or paste a personal access token) first.`,
      };
    }
    let set: PublicTokenSet | null = null;
    try {
      const parsed = JSON.parse(raw) as PublicTokenSet;
      if (typeof parsed?.accessToken === "string" && parsed.accessToken) set = parsed;
    } catch {
      set = null;
    }
    if (!set) {
      return {
        ok: false,
        error: `the record at the configured reference "${credentialRef}" is not a Public token set.`,
      };
    }
    const token = await usableAccessToken(env, set, fetchImpl);
    if (!token) {
      return {
        ok: false,
        error: "the Public token at the configured reference is expired and could not be refreshed; reconnect Public.",
      };
    }
    return { ok: true, accessToken: token };
  }
  const envName = credentialRef.startsWith("env:")
    ? credentialRef.slice("env:".length)
    : /^[A-Z][A-Z0-9_]{2,}$/.test(credentialRef)
      ? credentialRef
      : null;
  if (envName) {
    const value = (env as unknown as Record<string, unknown>)[envName];
    if (typeof value === "string" && value.trim() !== "") {
      return { ok: true, accessToken: value };
    }
    return {
      ok: false,
      error: `the environment variable named by the configured reference "${credentialRef}" is not set; no Public token is available.`,
    };
  }
  return {
    ok: false,
    error: `credential reference "${credentialRef}" uses a form the Public verifier cannot resolve (expected "sessionstore:<namespace>:<key>" or "env:NAME").`,
  };
}

/* ------------------------- client metadata --------------------------- */

/** The client_id this deployment presents: the metadata document's own URL. */
export function publicClientId(origin: string): string {
  return `${origin}${PUBLIC_CLIENT_METADATA_PATH}`;
}

/**
 * Client ID Metadata Document served by this app. The document's
 * `iss` must equal the client_id, and it describes exactly that
 * client (cfpay's proven shape, at the well-known path).
 */
export function publicClientMetadataDocument(origin: string): Record<string, unknown> {
  return {
    iss: publicClientId(origin),
    client_name: "cfagent (OpenAIMP)",
    response_types: ["code"],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
    redirect_uris: [`${origin}${PUBLIC_CALLBACK_PATH}`],
    scope: DEFAULT_PUBLIC_OAUTH_SCOPES,
  };
}

/* ------------------------------ pending ------------------------------ */

async function storePublicOAuthPending(env: Env, pending: PublicOAuthPending): Promise<void> {
  if (isTokenPortsEnabled(env)) {
    await publicTokenPort(env).storePending(pending);
    return;
  }
  await getKv(env).put(publicPendingKey(pending.state), JSON.stringify(pending), {
    expirationTtl: Math.floor(PENDING_MAX_AGE_MS / 1000),
  });
}

export async function getPublicOAuthPending(
  env: Env,
  state: string
): Promise<PublicOAuthPending | null> {
  if (isTokenPortsEnabled(env)) {
    return publicTokenPort(env).getPending(state);
  }
  const raw = await getKv(env).get(publicPendingKey(state));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PublicOAuthPending;
  } catch {
    return null;
  }
}

async function clearPublicOAuthPending(env: Env, state: string): Promise<void> {
  if (isTokenPortsEnabled(env)) {
    await publicTokenPort(env).deletePending(state);
    return;
  }
  await getKv(env).delete(publicPendingKey(state));
}

function isFreshPending(pending: PublicOAuthPending | null): pending is PublicOAuthPending {
  return Boolean(
    pending &&
      typeof pending.createdAt === "number" &&
      Date.now() - pending.createdAt < PENDING_MAX_AGE_MS
  );
}

/* ------------------------------- flow -------------------------------- */

/**
 * Start the connect flow: discover the authorization server from the
 * MCP resource, mint the CSRF state (session.ts) + PKCE pair (shared
 * core), store the pending record, and return the authorize URL.
 *
 * The authorize endpoint is PROBED before the caller redirects the
 * browser to it: Public rejects an unregistered client_id with a
 * bare invalid_request, and probing is the only way to know — a
 * rejection raises PublicClientRejectedError with the explanation
 * (cfpay's production-verified behaviour).
 */
export async function startPublicOAuth(
  env: Env,
  userLogin: string,
  origin: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ authorizeUrl: string }> {
  const as: AuthorizationServerMetadata = await discoverAuthorizationServerFromResource(
    PUBLIC_MCP_URL,
    fetchImpl
  );
  const clientId = publicClientId(origin);
  const redirectUri = `${origin}${PUBLIC_CALLBACK_PATH}`;
  const state = await createState(env);
  const { verifier, challenge } = await createPkcePair();
  const authorizeUrl = buildAuthorizationUrl({
    authorizationEndpoint: as.authorization_endpoint,
    clientId,
    redirectUri,
    state,
    codeChallenge: challenge,
    scopes: DEFAULT_PUBLIC_OAUTH_SCOPES,
    resource: PUBLIC_MCP_URL,
  });
  try {
    const probe = await fetchImpl(authorizeUrl, { redirect: "manual" });
    if (probe.status === 400 && (await probe.text()).includes("client_id")) {
      throw new PublicClientRejectedError();
    }
  } catch (err) {
    if (err instanceof PublicClientRejectedError) throw err;
    // Not conclusive: a transient probe error must not block sign-in.
  }
  await storePublicOAuthPending(env, {
    state,
    codeVerifier: verifier,
    clientId,
    issuer: as.issuer,
    tokenEndpoint: as.token_endpoint,
    revocationEndpoint: as.revocation_endpoint,
    redirectUri,
    userLogin,
    createdAt: Date.now(),
  });
  return { authorizeUrl };
}

/**
 * Complete the connect flow from the callback. Fail-closed order (the
 * oidcProvider discipline): the session.ts state is verified BEFORE
 * any pending read or upstream call; the pending must be fresh and
 * must belong to the SAME login that started the flow (the
 * pre-existing session's login — Public never chooses the identity).
 * The exchanged token set is verified against the MCP server
 * (tools/list) BEFORE it is stored: a credential that cannot list
 * tools is not useful and is never saved (cfpay's rule).
 */
export async function completePublicOAuth(
  env: Env,
  state: string,
  code: string,
  expectedUserLogin: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ userLogin: string; toolCount: number }> {
  if (!(await verifyState(env, state))) {
    throw new Error("Invalid or expired OAuth state. Start again from the Public connect action.");
  }
  const pending = await getPublicOAuthPending(env, state);
  if (!isFreshPending(pending)) {
    throw new Error("Invalid or expired OAuth state. Start again from the Public connect action.");
  }
  if (pending.userLogin !== expectedUserLogin) {
    await clearPublicOAuthPending(env, state);
    throw new Error("The Public connect flow was started under a different login; refusing to store its tokens.");
  }
  const tokens = await exchangeAuthorizationCode(
    {
      tokenEndpoint: pending.tokenEndpoint,
      code,
      redirectUri: pending.redirectUri,
      clientId: pending.clientId,
      codeVerifier: pending.codeVerifier,
    },
    fetchImpl
  );
  const client = new PublicMcpClient({
    accessTokenProvider: async () => tokens.accessToken,
    fetchImpl,
  });
  const tools = await client.listTools();
  await storePublicTokens(env, {
    kind: "oauth",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    clientId: pending.clientId,
    issuer: pending.issuer,
    tokenEndpoint: pending.tokenEndpoint,
    revocationEndpoint: pending.revocationEndpoint,
    storedAt: new Date().toISOString(),
    userLogin: pending.userLogin,
  });
  await clearPublicOAuthPending(env, state);
  return { userLogin: pending.userLogin, toolCount: tools.length };
}

/* ------------------------- connection helpers ------------------------ */

/** Connection status for the API surface: never the token itself, only a 4+4 hint. */
export async function getPublicConnectionStatus(
  env: Env,
  userLogin: string
): Promise<{
  connected: boolean;
  /** #4048: true only when a check actually observed this credential work. */
  verified: boolean;
  method: "oauth" | "personal" | "deployment" | null;
  /** #4048: whose credential served the read. */
  source: PublicCredentialSource;
  tokenHint: string | null;
  mcpUrl: string;
  verifiedAt: string | null;
  toolCount: number;
  tools: string[];
}> {
  const set = await getStoredPublicTokens(env, userLogin);
  const deployment = set ? null : publicDeploymentToken(env);
  if (!set && deployment) {
    return {
      // #4048: configured, not verified — nothing has checked this key yet,
      // and the deployment key is shared by every tenant, so it never gets
      // a token hint (the deployment-pair precedent exposes none either).
      connected: true,
      verified: false,
      method: "deployment" as const,
      source: "deployment" as const,
      tokenHint: null,
      mcpUrl: PUBLIC_MCP_URL,
      verifiedAt: null,
      toolCount: 0,
      tools: [],
    };
  }
  return {
    connected: Boolean(set),
    verified: Boolean(set?.verifiedAt),
    source: set ? ("user" as const) : null,
    method: set ? (set.kind === "oauth" ? "oauth" : "personal") : null,
    tokenHint: set ? `${set.accessToken.slice(0, 4)}...${set.accessToken.slice(-4)}` : null,
    mcpUrl: PUBLIC_MCP_URL,
    // #4035: proof the connection was verified, and what it observed.
    verifiedAt: set?.verifiedAt ?? null,
    toolCount: set?.verifiedTools?.length ?? 0,
    tools: set?.verifiedTools ?? [],
  };
}

/**
 * Connect with a pasted personal access token: verified against the
 * MCP server (tools/list) BEFORE it is stored — a token that cannot
 * list tools is not saved, so the surface never claims a connection
 * that does not work (cfpay's rule).
 */
export async function connectPublicPersonalToken(
  env: Env,
  userLogin: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ toolCount: number; tools: string[] }> {
  const client = new PublicMcpClient({
    accessTokenProvider: async () => token,
    fetchImpl,
  });
  const tools = await client.listTools();
  const toolNames = tools.map((t) => t.name);
  // #4035: the verification is evidence, not a boolean — the status
  // surface can say when the credential was checked and what it saw.
  await storePublicPersonalToken(env, userLogin, token, {
    verifiedAt: new Date().toISOString(),
    tools: toolNames,
  });
  return { toolCount: toolNames.length, tools: toolNames };
}

/** Disconnect: best-effort upstream revocation, then drop the record. */
export async function disconnectPublic(
  env: Env,
  userLogin: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  await revokePublicTokens(env, userLogin, fetchImpl);
}
