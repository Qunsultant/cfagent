/**
 * #945 Wiring Phase 1 — login provider registry + config-gated enablement.
 *
 * The point of this module: a new provider plugs in WITHOUT changing the
 * system. server.ts never hard-codes a provider in the wired path — it
 * asks this registry for the provider named by config and dispatches
 * through the adapter's startLogin/handleCallback. Adding a provider
 * later means: (1) write an adapter implementing LoginProvider,
 * (2) register it (see registerProvider), (3) add its id to
 * IAAA_ENABLED_PROVIDERS. No change to server.ts dispatch, no change
 * to any existing adapter.
 *
 * How to register a future provider (Auth0, Google, another social login):
 *   import { defaultRegistry } from "./providers";
 *   defaultRegistry.registerProvider({
 *     providerId: "auth0",
 *     protocol: "oidc",
 *     issuer: "https://<tenant>.auth0.com/",
 *     startLogin: async (env) => { ...redirect to the provider... },
 *     handleCallback: async (env, request) => { ...validate, bind, session... },
 *   });
 * The adapter owns its own token/profile validation and its own
 * binding (issuer + provider-stable subject, never login/email). An id
 * listed in IAAA_ENABLED_PROVIDERS with no registered adapter is
 * ignored: resolveLoginProvider reports "provider-not-registered" and
 * login is refused — it never falls back to another provider.
 *
 * Enablement / rollback (config only, no code change):
 * - IAAA_WIRING_ENABLED: "1" or "true" (case-insensitive, trimmed) = on.
 *   Anything else, including absence, = off. Default: off.
 * - IAAA_ENABLED_PROVIDERS: comma-separated provider ids. Default when
 *   wiring is on and no list is set: ["github"]. Duplicates and empty
 *   entries are dropped; ids are trimmed and lower-cased.
 * - Rollback = set IAAA_WIRING_ENABLED off, or remove the provider id
 *   from IAAA_ENABLED_PROVIDERS. Sessions already created by the wired
 *   flow keep working: the wired session fields are optional and the
 *   legacy fields are unchanged (see iaaaLogin.ts).
 *
 * Registered providers: "github", "google", and "apple", all
 * declarative createOidcProvider calls in this module (#1254
 * rationalized GitHub onto the factory; its deltas are options,
 * not code; #2686 registers Apple the same way — its deltas are
 * options too: ID-token profile, state-as-nonce, response_mode,
 * and a minted client-secret JWT, see oidcProvider.ts).
 * #1254 PR-B deleted the wiring-off legacy GitHub flow and the
 * exact /auth/login + /auth/callback routes: every provider,
 * GitHub included, is served only by the generic registry routes.
 * No PDP, delegation, or audit wiring lives here. To onboard
 * another provider, see docs/architecture/security/apple-login-2686.md
 * for the worked Apple example (the generic onboarding shape).
 */
import type { Env } from "../types";
import type { AuditStore } from "./iaaaAudit";
import { mintAppleClientSecret } from "./appleClientSecret";
import { authOutcomeLoginUrl } from "./authOutcome";
import { createOidcProvider } from "./oidcProvider";

/**
 * #945 GitHub end-to-end — options a dispatch site may pass to a
 * provider callback. All optional: a provider called without them
 * behaves exactly as before (no audit recording, no post-login
 * work). server.ts passes all three for the wired GitHub callback:
 * the audit store + resolved tenant switch login audit on, and
 * postLoginEnabled switches alias recording + bootstrap-on-login on.
 */
export interface LoginCallbackOptions {
  auditStore?: AuditStore;
  auditTenantId?: string;
  postLoginEnabled?: boolean;
  /**
   * #3015: the return target recovered from the signed OAuth
   * state, or null. The wired tail validates it again at use
   * time before any redirect; null keeps the default landing.
   */
  returnTarget?: string | null;
}

/** A login provider adapter. startLogin begins the flow; handleCallback finishes it. */
export interface LoginProvider {
  /**
   * #3015: startLogin optionally seals a return target into the
   * signed OAuth state. An absent or refused target starts a
   * plain login (default landing afterwards) — never an error.
   */
  startLogin(env: Env, returnTarget?: string): Promise<Response>;
  providerId: string;
  /** "oidc" for ID-token providers, "oauth2" for OAuth2 + profile-fetch providers (GitHub). */
  protocol: "oidc" | "oauth2";
  /** Validated issuer for the provider (used for binding, never for display). */
  issuer: string;
  /** Human-readable name for the login page button. Optional; falls back to providerId. */
  displayName?: string;
  handleCallback(env: Env, request: Request, options?: LoginCallbackOptions): Promise<Response>;
}

/** A registry of LoginProviders. The default registry is the production one. */
export class ProviderRegistry {
  private readonly providers = new Map<string, LoginProvider>();

  /** Register an adapter. Returns false (and registers nothing) for an invalid or duplicate id. */
  registerProvider(provider: LoginProvider): boolean {
    if (!provider || typeof provider.providerId !== "string") return false;
    const id = provider.providerId.trim().toLowerCase();
    if (!id || this.providers.has(id)) return false;
    if (typeof provider.startLogin !== "function" || typeof provider.handleCallback !== "function") {
      return false;
    }
    this.providers.set(id, { ...provider, providerId: id });
    return true;
  }

  getProvider(providerId: string): LoginProvider | null {
    if (typeof providerId !== "string") return null;
    return this.providers.get(providerId.trim().toLowerCase()) ?? null;
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }
}

/** Fresh, empty registry (tests and future registration sites). */
export function createProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry();
}

/** The production registry, shipped with GitHub and Google registered. */
export const defaultRegistry: ProviderRegistry = (() => {
  const registry = new ProviderRegistry();
  // GitHub, rationalized onto the factory in #1254: the same
  // declarative shape as Google, with GitHub's genuine deltas as
  // options — OAuth2 + profile fetch (no ID token), numeric `id`
  // subject, `login` login key, `avatar_url` avatar, its versioned
  // userinfo Accept (#1265), no response_type on the authorize
  // request, no credentials gate (its credentials are required
  // core Env config), and the generic /auth/callback/github
  // redirect (PR-B removed PR-A's legacy-path override together
  // with the legacy routes and flow).
  registry.registerProvider(
    createOidcProvider({
      providerId: "github",
      issuer: "https://github.com",
      displayName: "GitHub",
      protocol: "oauth2",
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      userinfoEndpoint: "https://api.github.com/user",
      clientIdEnv: "GITHUB_CLIENT_ID",
      clientSecretEnv: "GITHUB_CLIENT_SECRET",
      scope: "read:user",
      subjectField: "id",
      loginKeyField: "login",
      avatarField: "avatar_url",
      userinfoAccept: "application/vnd.github+json",
      includeResponseType: false,
      requireConfiguredCredentials: false,
    })
  );
  // Google, the worked plugin example: one factory call, no other
  // file changed to register it. True identity is Slice 1
  // (https://accounts.google.com, sub); the verified email is only
  // the adapter-supplied legacy login key, never identity. The
  // client id/secret are owner-set secrets (Cloudflare dashboard
  // or `wrangler secret put`), never committed: until they exist,
  // startLogin fails closed with an error page and no button
  // appears (the button is gated on the enabled list, which the
  // owner changes in a separate enablement step).
  registry.registerProvider(
    createOidcProvider({
      providerId: "google",
      issuer: "https://accounts.google.com",
      displayName: "Google",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
      clientIdEnv: "GOOGLE_CLIENT_ID",
      clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      scope: "openid email profile",
      subjectField: "sub",
      loginKeyField: "email",
      requireEmailVerified: true,
    })
  );
  // Apple (#2686), the same declarative shape: one factory call,
  // no other file changed to register it. True identity is Slice 1
  // (https://appleid.apple.com, sub); the email — real or private-
  // relay — is only the adapter-supplied legacy login key, never
  // identity, so a relay→real email change never moves the binding.
  // Apple deltas, all factory options (see oidcProvider.ts): no
  // userinfo endpoint (profile from the id_token), nonce bound to
  // the login attempt's state, response_mode=query (Apple's `user`
  // name payload arrives only via form_post, which this slice does
  // not use — display name falls back to the login key, and no
  // flow depends on re-reading a name), and a client-secret JWT
  // minted per exchange from the .p8 key (no stored secret can
  // silently expire). The APPLE_* values are owner-set secrets
  // (Cloudflare dashboard or `wrangler secret put`), never
  // committed: until they exist, startLogin fails closed and no
  // button appears. Surfacing is the wiring flag + the enabled
  // list: adding "apple" to IAAA_ENABLED_PROVIDERS shows the
  // button when wiring is on, and wiring off hides it — the button
  // is never ungated. Login via Apple grants no admin role by
  // itself, like every other provider (owner clarification on
  // #2686). Cross-provider account linking is NOT in this slice.
  registry.registerProvider(
    createOidcProvider({
      providerId: "apple",
      issuer: "https://appleid.apple.com",
      displayName: "Apple",
      protocol: "oidc",
      authorizationEndpoint: "https://appleid.apple.com/auth/authorize",
      tokenEndpoint: "https://appleid.apple.com/auth/token",
      clientIdEnv: "APPLE_CLIENT_ID",
      scope: "name email",
      subjectField: "sub",
      loginKeyField: "email",
      requireEmailVerified: true,
      profileFromIdToken: true,
      useStateAsNonce: true,
      extraAuthorizeParams: { response_mode: "query" },
      clientSecretResolver: async (env: Env) => {
        const record = env as unknown as Record<string, unknown>;
        const teamId = typeof record["APPLE_TEAM_ID"] === "string" ? (record["APPLE_TEAM_ID"] as string) : "";
        const keyId = typeof record["APPLE_KEY_ID"] === "string" ? (record["APPLE_KEY_ID"] as string) : "";
        const privateKeyPem = typeof record["APPLE_PRIVATE_KEY"] === "string" ? (record["APPLE_PRIVATE_KEY"] as string) : "";
        const clientId = typeof record["APPLE_CLIENT_ID"] === "string" ? (record["APPLE_CLIENT_ID"] as string) : "";
        // A throw inside mint (bad key, missing input) is caught by
        // the factory's resolver handling and fails the login closed.
        return mintAppleClientSecret({
          teamId,
          keyId,
          privateKeyPem,
          clientId,
          nowMs: Date.now(),
        });
      },
    })
  );
  return registry;
})();

/** Registry-backed lookups against the default registry. */
export function getProvider(providerId: string): LoginProvider | null {
  return defaultRegistry.getProvider(providerId);
}

/**
 * Issue #1274 — issuer → provider display lookup, registry-backed.
 * The session carries providerIssuer (set at wired login from the
 * binding, never from user input); this resolves it to the registered
 * adapter's id + display name for /api/me. Unknown issuers return
 * null — the caller omits the provider field rather than guessing.
 * A future provider needs only a registry entry to display.
 */
export function getProviderByIssuer(
  issuer: unknown,
): Pick<LoginProvider, "providerId" | "displayName" | "issuer"> | null {
  if (typeof issuer !== "string" || issuer.trim() === "") return null;
  for (const id of defaultRegistry.listProviders()) {
    const provider = defaultRegistry.getProvider(id);
    if (provider && provider.issuer === issuer) {
      return {
        providerId: provider.providerId,
        displayName: provider.displayName ?? provider.providerId,
        issuer: provider.issuer,
      };
    }
  }
  return null;
}

export function listProviders(): string[] {
  return defaultRegistry.listProviders();
}

/** True only when IAAA_WIRING_ENABLED is "1" or "true" (case-insensitive, trimmed). */
export function isWiringEnabled(env: Partial<Env> | null | undefined): boolean {
  const raw = env?.IAAA_WIRING_ENABLED;
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Enabled provider ids from config. Defaults to ["github"] when wiring is
 * on and no list is set. Unknown ids are kept here — the registry, not
 * the parser, is what refuses them (see resolveLoginProvider).
 */
export function enabledProviders(env: Partial<Env> | null | undefined): string[] {
  if (!isWiringEnabled(env)) return [];
  const raw = env?.IAAA_ENABLED_PROVIDERS;
  if (typeof raw !== "string" || raw.trim() === "") return ["github"];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** True only when wiring is on, the id is in the enabled list, AND an adapter is registered. */
export function isProviderEnabled(
  env: Partial<Env> | null | undefined,
  providerId: string
): boolean {
  if (!isWiringEnabled(env)) return false;
  if (typeof providerId !== "string") return false;
  const id = providerId.trim().toLowerCase();
  if (!enabledProviders(env).includes(id)) return false;
  return defaultRegistry.getProvider(id) !== null;
}

export type DisabledReason =
  | "wiring-disabled"
  | "provider-not-enabled"
  | "provider-not-registered";

export interface ResolvedLoginProvider {
  provider: LoginProvider | null;
  disabledReason: DisabledReason | null;
}

/**
 * Resolve a provider for dispatch: wiring off → wiring-disabled; id not
 * in the enabled list → provider-not-enabled; id not registered →
 * provider-not-registered. Never falls back to another provider.
 */
export function resolveLoginProvider(
  env: Partial<Env> | null | undefined,
  providerId: string
): ResolvedLoginProvider {
  if (!isWiringEnabled(env)) {
    return { provider: null, disabledReason: "wiring-disabled" };
  }
  if (typeof providerId !== "string" || !enabledProviders(env).includes(providerId.trim().toLowerCase())) {
    return { provider: null, disabledReason: "provider-not-enabled" };
  }
  const provider = defaultRegistry.getProvider(providerId);
  if (!provider) {
    return { provider: null, disabledReason: "provider-not-registered" };
  }
  return { provider, disabledReason: null };
}

/**
 * #2402: the response a disabled login gets. No provider fallback.
 * Previously a bare 403 text body — silent in the same way the
 * #2280 loop was silent. Now a redirect to the login page carrying
 * the outcome code, so the login page itself shows the user-safe
 * message (wiring-disabled, or provider-unavailable for the other
 * two reasons). No store read, no provider internals in the message.
 */
export function disabledLoginResponse(reason: DisabledReason): Response {
  const code =
    reason === "wiring-disabled" ? "wiring_disabled" : "provider_unavailable";
  return new Response(null, {
    status: 302,
    headers: { Location: authOutcomeLoginUrl(code) },
  });
}
