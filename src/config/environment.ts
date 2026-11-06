import defaultConfig from "../../environment.config.json";
import type { Env } from "../types";

export interface EnvironmentETradeConfig {
  baseUrl: string;
  type: "sandbox" | "live";
  apiKey?: string;
  apiSecret?: string;
  // #1185 Phase B (#1066): no oauthToken/oauthTokenSecret fields — the
  // process-wide static pair was deleted so no consumer can reintroduce
  // it. Access tokens are per-user, stored in the SessionStore.
}

export interface EnvironmentPaymentsConfig {
  mode: "test" | "live";
  paypalEnvironment: "sandbox" | "live";
  stripeMode: "test" | "live";
  lemonsqueezyMode: "test" | "live";
}

export interface ResolvedEnvironment {
  name: "TEST" | "PROD" | string;
  label: string;
  isLive: boolean;
  etrade: EnvironmentETradeConfig;
  payments: EnvironmentPaymentsConfig;
  /** #1185 / #1066 — the configured service identity for unattended work, when set. */
  serviceUserLogin?: string;
}

/**
 * Derives the E*TRADE /v1 base URL from either:
 *  - a base URL like "https://apisb.etrade.com"
 *  - a full endpoint like "https://apisb.etrade.com/v1/accounts/..."
 * Always returns "https://<host>/v1"
 */

/**
 * Lower-cased hostname of a URL, or "" when it does not parse.
 * (CodeQL js/incomplete-url-substring-sanitization, #843–#847.)
 */
export function urlHostname(raw: string): string {
  try {
    return new URL(raw.trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Exact-hostname check for an E*TRADE endpoint host.
 *
 * Substring checks like `url.includes("api.etrade.com")` are bypassable:
 * `https://api.etrade.com.evil.com/` and userinfo tricks such as
 * `https://apisb.etrade.com@api.etrade.com/` (real host: api.etrade.com)
 * defeat them. Parse the URL and compare the hostname exactly instead.
 * Matches the host itself or a dot-anchored subdomain of it.
 */
export function isETradeHost(raw: string, host: string): boolean {
  const hostname = urlHostname(raw);
  return hostname === host || hostname.endsWith(`.${host}`);
}
export function resolveETradeBaseUrl(rawUrl: string): string {
  if (!rawUrl) return "https://apisb.etrade.com/v1";
  const clean = rawUrl.trim().replace(/\/$/, "");
  try {
    const parsed = new URL(clean);
    const origin = parsed.origin; // e.g. "https://apisb.etrade.com"
    return `${origin}/v1`;
  } catch {
    // `clean` is not a parseable URL — only honor it when it plainly names
    // the live host (bare host or host+path, case-insensitive), never on a
    // mere substring: "evil.com/?x=api.etrade.com" must NOT resolve to the
    // live endpoint (#847).
    const hostPart = clean.split("/")[0].split(":")[0].trim().toLowerCase().replace(/\.$/, "");
    if (hostPart === "api.etrade.com") return "https://api.etrade.com/v1";
    return "https://apisb.etrade.com/v1";
  }
}

/**
 * Resolves the active environment and E*TRADE credentials.
 *
 * Priority cascade:
 *   1. Cloudflare Worker env bindings (runtime secrets: ET_API_KEY, ET_API_SECRET, ET_BASE_URL)
 *   2. process.env (Node / local .dev.vars)
 *   3. environment.config.json default
 *
 * ET_BASE_URL is expected to be a base URL ("https://apisb.etrade.com") — NOT a path template.
 * accountIdKey must be resolved at runtime via GET /v1/accounts/list (see ETradeService.fetchAccountsRemote).
 */
export function resolveEnvironmentConfig(env?: Partial<Env>, overrideEnv?: string): ResolvedEnvironment {
  const processEnv = typeof process !== "undefined" && process?.env ? process.env : {};

  // Active environment name priority:
  // 1. Explicit overrideEnv (from request header x-environment or UI toggle)
  // 2. Explicit runtime override on env (e.g. in targeted tests or specific workers)
  // 3. environment.config.json default (developer's repository choice)
  // 4. Cloudflare Worker or process env bindings
  const envNameCandidate =
    overrideEnv ||
    (env?.ETRADE_ENVIRONMENT === "sandbox" ? "TEST" : env?.ETRADE_ENVIRONMENT === "live" ? "PROD" : undefined) ||
    (env?.APP_ENV && env.APP_ENV !== defaultConfig.environment ? env.APP_ENV : undefined) ||
    defaultConfig.environment ||
    env?.APP_ENV ||
    env?.ENVIRONMENT ||
    processEnv.APP_ENV ||
    processEnv.ENVIRONMENT ||
    "PROD";

  let activeName = envNameCandidate.toUpperCase().trim();
  if (activeName === "LIVE") activeName = "PROD";
  if (activeName === "PAPER" || activeName === "SANDBOX") activeName = "TEST";

  const envsMap = defaultConfig.environments as Record<string, any>;
  const baseDef = envsMap[activeName] || envsMap["PROD"] || envsMap["TEST"];

  // ET_BASE_URL from secret takes priority if matching the active environment
  let rawUrl = baseDef.etrade.baseUrl;
  const envUrl = env?.ET_BASE_URL || processEnv.ET_BASE_URL;
  if (envUrl) {
    // Exact-hostname gating (#845, #846): a substring match let
    // "https://evil.com/?x=apisb.etrade.com" smuggle an attacker host into
    // TEST mode. Only the genuine sandbox host is honored there.
    const envIsSandboxHost = isETradeHost(envUrl, "apisb.etrade.com");
    if (activeName === "PROD" && !envIsSandboxHost) {
      rawUrl = envUrl;
    } else if (activeName === "TEST" && envIsSandboxHost) {
      rawUrl = envUrl;
    }
  }

  const baseUrl = resolveETradeBaseUrl(rawUrl);
  // Exact-hostname liveness (#843, #844): "https://api.etrade.com.evil.com"
  // starts with the live prefix but is not the live host.
  const isLive = activeName === "PROD" || isETradeHost(baseUrl, "api.etrade.com");

  // OAuth credentials — strictly segregated by environment:
  const isProd = activeName === "PROD";

  // In PROD: prefer ET_PROD_API_KEY, falling back to ET_API_KEY if dedicated prod secret is not yet set
  const sanitize = (val: unknown): string | undefined => {
    if (typeof val !== "string") return undefined;
    const clean = val.trim();
    if (clean === "true" || clean === "false" || clean === "null" || clean === "undefined") {
      return undefined;
    }
    return clean.length > 0 ? clean : undefined;
  };

  const rawApiKey = isProd
    ? (env?.ET_PROD_API_KEY ||
       (env as any)?.ETRADE_PROD_CONSUMER_KEY ||
       (env as any)?.PROD_ET_API_KEY ||
       processEnv.ET_PROD_API_KEY ||
       processEnv.ETRADE_PROD_CONSUMER_KEY ||
       env?.ET_API_KEY ||
       (env as any)?.ETRADE_API_KEY ||
       env?.ETRADE_CONSUMER_KEY ||
       processEnv.ET_API_KEY ||
       processEnv.ETRADE_API_KEY ||
       processEnv.ETRADE_CONSUMER_KEY)
    : (env?.ET_SANDBOX_API_KEY ||
       (env as any)?.ETRADE_SANDBOX_CONSUMER_KEY ||
       (env as any)?.SANDBOX_ET_API_KEY ||
       processEnv.ET_SANDBOX_API_KEY ||
       processEnv.ETRADE_SANDBOX_CONSUMER_KEY ||
       env?.ET_API_KEY ||
       (env as any)?.ETRADE_API_KEY ||
       env?.ETRADE_CONSUMER_KEY ||
       processEnv.ET_API_KEY ||
       processEnv.ETRADE_API_KEY ||
       processEnv.ETRADE_CONSUMER_KEY);

  const rawApiSecret = isProd
    ? (env?.ET_PROD_API_SECRET ||
       (env as any)?.ETRADE_PROD_CONSUMER_SECRET ||
       (env as any)?.PROD_ET_API_SECRET ||
       processEnv.ET_PROD_API_SECRET ||
       processEnv.ETRADE_PROD_CONSUMER_SECRET ||
       env?.ET_API_SECRET ||
       (env as any)?.ETRADE_API_SECRET ||
       env?.ETRADE_CONSUMER_SECRET ||
       processEnv.ET_API_SECRET ||
       processEnv.ETRADE_API_SECRET ||
       processEnv.ETRADE_CONSUMER_SECRET)
    : (env?.ET_SANDBOX_API_SECRET ||
       (env as any)?.ETRADE_SANDBOX_CONSUMER_SECRET ||
       (env as any)?.SANDBOX_ET_API_SECRET ||
       processEnv.ET_SANDBOX_API_SECRET ||
       processEnv.ETRADE_SANDBOX_CONSUMER_SECRET ||
       env?.ET_API_SECRET ||
       (env as any)?.ETRADE_API_SECRET ||
       env?.ETRADE_CONSUMER_SECRET ||
       processEnv.ET_API_SECRET ||
       processEnv.ETRADE_API_SECRET ||
       processEnv.ETRADE_CONSUMER_SECRET);

  const apiKey = sanitize(rawApiKey);
  const apiSecret = sanitize(rawApiSecret);

  const paypalEnv = env?.PAYPAL_ENVIRONMENT || (isLive ? "live" : "sandbox");

  // #1185 / #1066 — explicit service identity for unattended work. A
  // non-secret login id, owner-set via SERVICE_USER_LOGIN; undefined when
  // unset so unattended dispatch fails closed (see
  // src/security/serviceIdentity.ts).
  const serviceUserLogin = sanitize(env?.SERVICE_USER_LOGIN);

  return {
    name: activeName,
    label: baseDef.label || (isLive ? "Live" : "Sandbox"),
    isLive,
    serviceUserLogin,
    etrade: {
      baseUrl,
      type: isLive ? "live" : "sandbox",
      apiKey,
      apiSecret,
    },
    payments: {
      mode: isLive ? "live" : "test",
      paypalEnvironment: paypalEnv,
      stripeMode: isLive ? "live" : "test",
      lemonsqueezyMode: isLive ? "live" : "test",
    },
  };
}
