/**
 * #945 Google-as-plugin — generic OIDC/OAuth2 provider factory.
 *
 * A login provider that speaks the standard authorization-code flow
 * is one factory call, not a new module: createOidcProvider turns
 * endpoint + env + field-mapping options into a LoginProvider that
 * plugs into the registry (providers.ts) and the generic wired tail
 * (iaaaLogin.ts completeWiredLogin). Google is the worked OIDC
 * example; GitHub registers through the same factory since #1254
 * PR-A, with its genuine deltas expressed as options (below).
 *
 * What the factory owns (per provider instance):
 * - startLogin: redirect to the provider's authorization endpoint
 *   with client_id, redirect_uri, response_type=code, scope, and a
 *   server-side state (createState from ./session). The redirect
 *   URI is ${APP_BASE_URL || "https://agent.openaimp.com"}/auth/callback/<providerId>.
 *   A provider
 *   with the credentials gate on (the default) fails start with a
 *   redirect to the login page carrying the signin_failed outcome
 *   when its client id/secret env is missing — never a redirect to
 *   a flow that cannot complete, and never a bare error page (#2402).
 * - handleCallback: state verification, code exchange at the token
 *   endpoint THROUGH the shared oauth2 core
 *   (exchangeAuthorizationCodeConfidential in ./oauth2Core —
 *   client_secret_post, form-encoded responses tolerated),
 *   userinfo fetch with the fresh access token, validation, and
 *   normalization to the generic profile shape. Secrets are sent
 *   only in the token request body; nothing here logs a secret,
 *   a token, or a code.
 *
 * Fail-closed validation (#2402: every failure below redirects to
 * the login page with the signin_failed outcome, technical detail
 * in the server log only; no session, no binding in any case):
 * - provider error parameter, missing code/state, or bad state →
 *   login redirect, no upstream call on a bad state.
 * - token endpoint failure or a missing access token → login
 *   redirect (the upstream status is logged, not surfaced).
 * - a missing/unverified email when requireEmailVerified is set →
 *   login redirect, here in the factory (the tail has no such rule).
 * - a missing/blank subject or login-key field is NOT re-decided
 *   here: the profile is handed to the generic wired tail, whose
 *   fail-closed rules (including the MISSING_SUBJECT_ID failure
 *   audit) own those cases identically for every adapter. The
 *   email is NEVER identity: it is only the adapter-supplied
 *   legacy login key; true identity is the Slice 1 (issuer,
 *   subject) binding in the generic tail.
 *
 * GitHub deltas (#1254 PR-A), each an option, none speculative:
 * - protocol "oauth2" (profile fetch, no ID token);
 * - avatarField "avatar_url" (Google: "picture");
 * - userinfoAccept "application/vnd.github+json" (Google: the
 *   "application/json" default) — #1265: the factory's userinfo
 *   fetch also sends a User-Agent ("ai-search-agent", the legacy
 *   flow's value) for every provider, because GitHub's API 403s
 *   requests without one; PR-A initially sent neither header and
 *   wired GitHub login failed at the profile step in production;
 * - subjectField "id" (numeric, coerced by the normalizer),
 *   loginKeyField "login", no email-verified gate;
 * - includeResponseType false — GitHub's authorize request never
 *   carried response_type, and its redirect bytes are pinned;
 * - requireConfiguredCredentials false — GitHub's credentials are
 *   required core Env config and its legacy start never gated on
 *   them; the exchange still fails closed upstream.
 * (#1254 PR-B deleted the redirectPathOverride option with its
 * only consumer, PR-A's legacy-callback bridge.)
 *
 * Apple deltas (#2686), each an option, none a parallel login path:
 * - profileFromIdToken: Apple has no userinfo endpoint, so the
 *   profile comes from the token response's id_token (decoded, not
 *   signature-verified — see decodeIdTokenPayload: the token arrives
 *   from the provider's token endpoint over TLS as the result of
 *   OUR confidential code exchange, exactly the trust the userinfo
 *   fetch has always relied on; no endpoint accepts a client-
 *   supplied id_token, so a forged token alone cannot create a
 *   session. Full JWKS signature verification is a later slice,
 *   and would apply to Google's ignored id_token too, for
 *   consistency — it is not smuggled in for one provider);
 * - useStateAsNonce: the authorize request carries nonce=<state>
 *   and the callback verifies the id_token's nonce claim against
 *   the already-verified state — the state's random UUID is the
 *   per-attempt unpredictable value, so no new nonce store and no
 *   state-format change. A nonce without an ID-token profile is a
 *   misconfiguration and fails closed at start (nothing to verify
 *   against);
 * - extraAuthorizeParams: response_mode=query (Apple's `user` name
 *   payload arrives only via form_post, which this slice does not
 *   use — see the #2686 doc: display name falls back to the login
 *   key, and the implementation never depends on re-reading a name);
 * - clientSecretResolver: Apple's token endpoint requires an ES256
 *   JWT minted from the .p8 key (see ./appleClientSecret), not a
 *   static secret — the resolver mints per exchange, so no stored
 *   secret can silently expire.
 */
import type { Env } from "../types";
import { authOutcomeLoginUrl } from "./authOutcome";
import type { LoginCallbackOptions, LoginProvider } from "./providers";
import { completeWiredLogin, type NormalizedLoginProfile } from "./iaaaLogin";
import {
  createState,
  verifyState,
  createStateWithReturnTarget,
  extractStateReturnTarget,
} from "./session";
import { exchangeAuthorizationCodeConfidential, OAuth2Error } from "./oauth2Core";

/** Error carrying the HTTP status the callback should answer with. */
export class OidcAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Options for one factory-built provider. Env names are keys, not values. */
export interface OidcProviderOptions {
  providerId: string;
  issuer: string;
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /**
   * Userinfo endpoint. Unused (and may be omitted) when
   * profileFromIdToken is set; the userinfo path fails closed
   * when it is missing.
   */
  userinfoEndpoint?: string;
  /** Env key holding the OAuth client id (e.g. "GOOGLE_CLIENT_ID"). */
  clientIdEnv: string;
  /**
   * Env key holding the OAuth client secret (never committed, never logged).
   * Optional when clientSecretResolver is set (the resolver owns the secret).
   */
  clientSecretEnv?: string;
  /**
   * #2686 — resolve the exchange secret at call time instead of
   * reading a static env secret (Apple's ES256 client-secret JWT,
   * minted per exchange). A throw or an undefined/empty return
   * means "not configured": the credentials gate fails closed.
   */
  clientSecretResolver?: (env: Env) => Promise<string | undefined> | string | undefined;
  /**
   * #2686 — when true, the profile comes from the token response's
   * id_token instead of a userinfo fetch (Apple has no userinfo
   * endpoint). The id_token is decoded, never signature-verified
   * (see the header comment for the trust model).
   */
  profileFromIdToken?: boolean;
  /**
   * #2686 — when true, the authorize request carries nonce=<state>
   * and the callback verifies the id_token's nonce claim against
   * the verified state. Requires profileFromIdToken; otherwise the
   * provider is misconfigured and start fails closed.
   */
  useStateAsNonce?: boolean;
  /**
   * Extra authorize-request parameters, set before the standard
   * ones (so a collision can never override client_id,
   * redirect_uri, response_type, scope, or state).
   */
  extraAuthorizeParams?: Record<string, string>;
  scope: string;
  /** Registry protocol tag. Default "oidc"; "oauth2" for profile-fetch providers (GitHub). */
  protocol?: "oidc" | "oauth2";
  /** Userinfo field carrying the stable subject. Default "sub". */
  subjectField?: string;
  /** Userinfo field carrying the legacy login key (e.g. "email"). */
  loginKeyField: string;
  /** Userinfo field carrying the avatar URL. Default "picture"; GitHub uses "avatar_url". */
  avatarField?: string;
  /**
   * Accept header sent on the userinfo request. Default
   * "application/json"; GitHub registers
   * "application/vnd.github+json" — the versioned media type its
   * legacy flow sent (#1265).
   */
  userinfoAccept?: string;
  /** When true, the userinfo email_verified flag must be true. */
  requireEmailVerified?: boolean;
  /** When false, the authorize request omits response_type (GitHub's legacy shape). Default true. */
  includeResponseType?: boolean;
  /**
   * When true (default), start and callback fail closed with a
   * "not configured" page when the client id/secret env is missing.
   * GitHub sets false: its credentials are required core Env config
   * and its legacy flow never gated on them.
   */
  requireConfiguredCredentials?: boolean;
}

function readEnvString(env: Env, key: string | undefined): string | undefined {
  if (!key) return undefined;
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * #2686 — resolve the exchange secret: a resolver (Apple's minted
 * JWT) wins over a static env secret. A resolver throw is "not
 * configured", never a reason to proceed without a secret.
 */
async function resolveClientSecret(env: Env, options: OidcProviderOptions): Promise<string | undefined> {
  if (options.clientSecretResolver) {
    try {
      const secret = await options.clientSecretResolver(env);
      return typeof secret === "string" && secret.trim() !== "" ? secret : undefined;
    } catch {
      return undefined;
    }
  }
  return readEnvString(env, options.clientSecretEnv);
}

/**
 * #2686 — decode an ID-token payload without verifying its
 * signature. Trust model (see header): the token arrives from the
 * provider's token endpoint over TLS as the result of this
 * server's confidential code exchange — the same trust the
 * userinfo fetch has always relied on. Returns null on any
 * malformed input; the caller fails closed.
 */
function decodeIdTokenPayload(idToken: string): Record<string, unknown> | null {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const json = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
    ) as unknown;
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    return json as Record<string, unknown>;
  } catch {
    return null;
  }
}

function redirectUri(env: Env, options: OidcProviderOptions): string {
  const base = env.APP_BASE_URL || "https://agent.openaimp.com";
  return `${base}/auth/callback/${options.providerId}`;
}

/**
 * #2402: a provider-flow failure no longer strands the user on a
 * bare error page (or, worse, nowhere — the #2280 loop). It redirects
 * to the login page carrying the generic signin_failed outcome, so
 * the login page shows the user-safe message. The technical message
 * and status go to the server log only, never to the user. The
 * fail-closed semantics are unchanged: no session, no binding.
 */
function errorPage(message: string, status = 400): Response {
  console.warn(`[auth] sign-in failed (status ${status}): ${message}`);
  return new Response(null, {
    status: 302,
    headers: { Location: authOutcomeLoginUrl("signin_failed") },
  });
}

/** Which fail-closed rule a normalization failure came from. */
export type NormalizeFailureKind = "profile" | "subject" | "loginKey" | "emailVerified";

/**
 * Normalize a raw userinfo document to the generic profile shape.
 * Returns an error message (and the rule that produced it) on the
 * first fail-closed violation, so the caller never reaches the
 * wired tail with an unproven profile.
 */
export function normalizeUserinfo(
  raw: unknown,
  options: Pick<
    OidcProviderOptions,
    "subjectField" | "loginKeyField" | "requireEmailVerified" | "avatarField"
  >
): { ok: true; profile: NormalizedLoginProfile } | { ok: false; error: string; kind: NormalizeFailureKind } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Provider userinfo was not a usable profile document", kind: "profile" };
  }
  const doc = raw as Record<string, unknown>;
  const subjectField = options.subjectField ?? "sub";
  const subjectRaw = doc[subjectField];
  const subject =
    typeof subjectRaw === "string"
      ? subjectRaw
      : typeof subjectRaw === "number" && Number.isFinite(subjectRaw)
        ? String(subjectRaw)
        : "";
  if (subject.trim() === "") {
    return { ok: false, error: "Provider profile did not include a stable subject id; login cannot be bound", kind: "subject" };
  }
  const loginKeyRaw = doc[options.loginKeyField];
  const loginKey = typeof loginKeyRaw === "string" ? loginKeyRaw : "";
  if (loginKey.trim() === "") {
    return { ok: false, error: "Provider profile did not include a usable login key; login cannot be bound", kind: "loginKey" };
  }
  if (options.requireEmailVerified) {
    const verified = doc["email_verified"];
    if (verified !== true && verified !== "true") {
      return { ok: false, error: "Provider email is not verified; login cannot be bound", kind: "emailVerified" };
    }
  }
  const nameRaw = doc["name"];
  const pictureRaw = doc[options.avatarField ?? "picture"];
  return {
    ok: true,
    profile: {
      subject,
      loginKey,
      displayName: typeof nameRaw === "string" && nameRaw.trim() !== "" ? nameRaw : loginKey,
      avatarUrl: typeof pictureRaw === "string" ? pictureRaw : "",
    },
  };
}

/**
 * Best-effort profile extraction for the delegation path: when
 * normalization fails on the subject or login key, the generic
 * wired tail re-decides the failure (its rules, its audit). The
 * extracted fields carry whatever the document actually held, so
 * the tail sees a valid subject alongside a blank login key (and
 * vice versa) exactly as the provider sent them.
 */
function extractPartialProfile(
  raw: unknown,
  options: OidcProviderOptions
): NormalizedLoginProfile {
  const doc =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const subjectRaw = doc[options.subjectField ?? "sub"];
  const subject =
    typeof subjectRaw === "string"
      ? subjectRaw
      : typeof subjectRaw === "number" && Number.isFinite(subjectRaw)
        ? String(subjectRaw)
        : "";
  const loginKeyRaw = doc[options.loginKeyField];
  const loginKey = typeof loginKeyRaw === "string" ? loginKeyRaw : "";
  const avatarRaw = doc[options.avatarField ?? "picture"];
  return {
    subject,
    loginKey,
    displayName: loginKey,
    avatarUrl: typeof avatarRaw === "string" ? avatarRaw : "",
  };
}

/** Build a LoginProvider from OIDC/OAuth2 authorization-code options. */
export function createOidcProvider(options: OidcProviderOptions): LoginProvider {
  const subjectField = options.subjectField ?? "sub";
  const credentialsGate = options.requireConfiguredCredentials ?? true;

  async function startLogin(env: Env, returnTarget?: string): Promise<Response> {
    const clientId = readEnvString(env, options.clientIdEnv);
    const clientSecret = await resolveClientSecret(env, options);
    if (credentialsGate && (!clientId || !clientSecret)) {
      return errorPage(
        `${options.displayName} login is not configured (missing OAuth client credentials)`,
        500
      );
    }
    // #2686: a nonce with no ID-token profile has nothing to verify
    // against — misconfiguration, fail closed before redirecting.
    if (options.useStateAsNonce && !options.profileFromIdToken) {
      return errorPage(`${options.displayName} login is misconfigured (nonce without ID-token profile)`, 500);
    }
    // #3015: seal a validated return target into the signed state;
    // an absent or refused target starts a plain login (default
    // landing afterwards) — the target never blocks login. For
    // state-as-nonce providers the state IS the nonce, echoed back
    // verbatim, so the target rides along untouched.
    const state =
      (returnTarget !== undefined
        ? await createStateWithReturnTarget(env, returnTarget)
        : null) ?? (await createState(env));
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.extraAuthorizeParams ?? {})) {
      params.set(key, value);
    }
    // With the credentials gate off (GitHub), a missing client id
    // serializes exactly as the legacy flow serialized it.
    params.set("client_id", String(clientId));
    params.set("redirect_uri", redirectUri(env, options));
    if (options.includeResponseType ?? true) params.set("response_type", "code");
    params.set("scope", options.scope);
    params.set("state", state);
    if (options.useStateAsNonce) params.set("nonce", state);
    return new Response(null, {
      status: 302,
      headers: { Location: `${options.authorizationEndpoint}?${params}` },
    });
  }

  async function handleCallback(
    env: Env,
    request: Request,
    callbackOptions?: LoginCallbackOptions
  ): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      return errorPage(`${options.displayName} authentication was cancelled or failed: ${error}`, 400);
    }
    if (!code || !state) {
      return errorPage("Missing required authorization code or state parameter", 400);
    }
    const isValidState = await verifyState(env, state);
    if (!isValidState) {
      return errorPage("Invalid or expired OAuth state session. Please try signing in again.", 403);
    }

    // #3015: recover the return target from the signed state. The
    // raw state is never trusted for the landing — only a target
    // that verifies (signature + expiry) and re-validates here is
    // passed on, and the wired tail validates it once more before
    // any redirect uses it.
    const tailOptions = {
      auditStore: callbackOptions?.auditStore,
      auditTenantId: callbackOptions?.auditTenantId,
      postLoginEnabled: callbackOptions?.postLoginEnabled,
      returnTarget: await extractStateReturnTarget(env, state),
    };

    try {
      const clientId = readEnvString(env, options.clientIdEnv);
      const clientSecret = await resolveClientSecret(env, options);
      if (credentialsGate && (!clientId || !clientSecret)) {
        return errorPage(
          `${options.displayName} login is not configured (missing OAuth client credentials)`,
          500
        );
      }
      let tokenSet: Awaited<ReturnType<typeof exchangeAuthorizationCodeConfidential>>;
      try {
        tokenSet = await exchangeAuthorizationCodeConfidential({
          tokenEndpoint: options.tokenEndpoint,
          code,
          redirectUri: redirectUri(env, options),
          clientId: clientId ?? "",
          clientSecret,
        });
      } catch (err) {
        if (err instanceof OAuth2Error) {
          if (err.status !== undefined) {
            throw new OidcAuthError(
              `Token exchange failed with upstream status ${err.status}`,
              502
            );
          }
          throw new OidcAuthError(
            err.errorDescription ||
              err.errorCode ||
              `${options.displayName} did not grant an access token`,
            400
          );
        }
        throw err;
      }
      // #2686 — ID-token profile path (Apple has no userinfo
      // endpoint): the profile is the token response's id_token.
      // The access token is discarded; no provider token is ever
      // retained, so there is nothing to revoke later (see the
      // #2686 doc). Subject/login-key/email-verified failures
      // follow exactly the userinfo path's rules below.
      if (options.profileFromIdToken) {
        const idToken = tokenSet.idToken;
        if (!idToken) {
          throw new OidcAuthError(`${options.displayName} did not return an ID token`, 502);
        }
        const rawProfile = decodeIdTokenPayload(idToken);
        if (!rawProfile) {
          throw new OidcAuthError(`${options.displayName} returned an unusable ID token`, 502);
        }
        if (options.useStateAsNonce && rawProfile["nonce"] !== state) {
          throw new OidcAuthError("ID token nonce does not match the login attempt", 400);
        }
        const normalized = normalizeUserinfo(rawProfile, {
          subjectField,
          loginKeyField: options.loginKeyField,
          requireEmailVerified: options.requireEmailVerified,
          avatarField: options.avatarField,
        });
        if (!normalized.ok) {
          if (normalized.kind === "emailVerified") {
            return errorPage(normalized.error, 400);
          }
          return await completeWiredLogin(
            env,
            options.issuer,
            extractPartialProfile(rawProfile, options),
            tailOptions
          );
        }
        return await completeWiredLogin(env, options.issuer, normalized.profile, tailOptions);
      }
      if (!options.userinfoEndpoint) {
        throw new OidcAuthError(
          `${options.displayName} login is misconfigured (no userinfo endpoint)`,
          500
        );
      }
      const accessToken = tokenSet.accessToken;
      const profileResp = await fetch(options.userinfoEndpoint, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: options.userinfoAccept ?? "application/json",
          // GitHub's API rejects requests with no User-Agent (403),
          // so every factory provider sends one (#1265). The value
          // is the legacy GitHub flow's, kept for continuity; it is
          // inert for providers that don't require it.
          "User-Agent": "ai-search-agent",
        },
      });
      if (!profileResp.ok) {
        throw new OidcAuthError(
          `Failed to fetch user profile from ${options.displayName}`,
          502
        );
      }
      const rawProfile: unknown = await profileResp.json();
      const normalized = normalizeUserinfo(rawProfile, {
        subjectField,
        loginKeyField: options.loginKeyField,
        requireEmailVerified: options.requireEmailVerified,
        avatarField: options.avatarField,
      });
      if (!normalized.ok) {
        if (normalized.kind === "emailVerified") {
          return errorPage(normalized.error, 400);
        }
        // Subject / login-key / unusable-document failures are the
        // generic wired tail's fail-closed rules (including the
        // MISSING_SUBJECT_ID failure audit recording). Delegate
        // with the extracted fields so the tail decides — and
        // audits — identically for every adapter.
        return await completeWiredLogin(
          env,
          options.issuer,
          extractPartialProfile(rawProfile, options),
          tailOptions
        );
      }
      // The userinfo fetch with the fresh access token IS the proof
      // of control; the generic tail binds (issuer, subject) and
      // creates the session. Nothing is persisted before this call.
      return await completeWiredLogin(env, options.issuer, normalized.profile, tailOptions);
    } catch (err) {
      if (err instanceof OidcAuthError) return errorPage(err.message, err.status);
      const message = err instanceof Error ? err.message : "Unexpected OAuth authentication error";
      return errorPage(message, 500);
    }
  }

  return {
    providerId: options.providerId,
    protocol: options.protocol ?? "oidc",
    issuer: options.issuer,
    displayName: options.displayName,
    startLogin,
    handleCallback,
  };
}
