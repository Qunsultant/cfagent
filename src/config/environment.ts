import defaultConfig from "../../environment.config.json";
import type { Env } from "../types";
import { resolvePlatformId } from "../security/attributionEnvelope";
import { DEPLOYMENT_DEFAULT_TENANT_ID } from "./tenantDefaults";
import type { OtelResolutionSource } from "./otelModes";
import type { ExecutionContext } from "../security/executionContext";

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
  /**
   * Issue #3122 — owner-configured approval gating values for agent
   * schedules. Each is undefined when its variable is unset or invalid:
   * the classifier binds the class (fail-closed). The owner sets the
   * values at enablement; no default is invented here.
   */
  agentSchedule?: {
    budgetCentsThreshold?: number;
    minIntervalSeconds?: number;
  };
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
 * Resolves the active environment and broker credentials.
 *
 * Priority cascade — the one cascade for all config (the OTEL
 * 7-level statement, adopted for all config; #6540):
 *   run > session > user > runtime > env > file > built-in safe default
 *
 * How this resolver's inputs map onto it today:
 *   run — overrideEnv, the explicit per-request override (request
 *     header x-environment or UI toggle).
 *   session / user / runtime — no input wired in this resolver yet;
 *     those levels fall through (the runtime level is the
 *     tenant-override level; its home is still an open owner
 *     decision, per the survey).
 *   env — Worker env bindings and process.env (Node / local
 *     .dev.vars): ETRADE_ENVIRONMENT, APP_ENV / ENVIRONMENT, and
 *     the credential / base-URL bindings.
 *   file — environment.config.json default (developer's repository
 *     choice).
 *   builtin — "PROD" when every level above is blank.
 *
 * ET_BASE_URL is expected to be a base URL ("https://apisb.etrade.com") — NOT a path template.
 * accountIdKey must be resolved at runtime via GET /v1/accounts/list (see ETradeService.fetchAccountsRemote).
 */
export function resolveEnvironmentConfig(env?: Partial<Env>, overrideEnv?: string): ResolvedEnvironment {
  const processEnv = typeof process !== "undefined" && process?.env ? process.env : {};

  // Active environment name priority — the one 7-level cascade
  // (run > session > user > runtime > env > file > builtin), mapped
  // onto this resolver's inputs:
  //   run — explicit overrideEnv (request header x-environment / UI toggle)
  //   env — ETRADE_ENVIRONMENT, then APP_ENV when it differs from the file default
  //   file — environment.config.json default (developer's repository choice)
  //   env — APP_ENV / ENVIRONMENT, then process.env APP_ENV / ENVIRONMENT
  //   builtin — "PROD"
  // session / user / runtime have no input wired here yet and fall
  // through. APP_ENV is consulted on both sides of the file default,
  // but only wins before it when it differs from the file value — so
  // the effective order is still env > file (when APP_ENV equals the
  // file value, either level yields the same name).
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

  // Issue #3122 — agent-schedule approval gating values. A non-negative
  // integer parses; anything else (unset, blank, non-numeric, negative)
  // is undefined, and the classifier binds the class (fail-closed).
  const parseNonNegativeInt = (raw: unknown): number | undefined => {
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    const value = Number(trimmed);
    return Number.isSafeInteger(value) ? value : undefined;
  };
  const agentSchedule = {
    budgetCentsThreshold: parseNonNegativeInt(
      (env as Record<string, unknown>)?.AGENT_SCHEDULE_BUDGET_THRESHOLD_CENTS,
    ),
    minIntervalSeconds: parseNonNegativeInt(
      (env as Record<string, unknown>)?.AGENT_SCHEDULE_MIN_INTERVAL_SECONDS,
    ),
  };

  return {
    name: activeName,
    label: baseDef.label || (isLive ? "Live" : "Sandbox"),
    isLive,
    serviceUserLogin,
    agentSchedule,
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

// ---------------------------------------------------------------------------
// Phase 2 — the one universal env context (#6540)
// ---------------------------------------------------------------------------

/**
 * Phase 2 of the universal-context programme (#6540; owner decision
 * 2026-11-25: the JSON file IS the context carrier — `environment
 * .config.json`, extended, resolved once per request into one typed
 * `UniversalEnvContext`).
 *
 * This slice defines the type and the single resolver. It does NOT
 * change any read site: `resolveEnvironmentConfig` keeps working
 * exactly as before, and `resolveUniversalContext` calls it and adds
 * the dimensions + the per-setting source record around its result,
 * so the core values are identical by construction (pinned by
 * `tests/universal_env_context_6540.test.ts`).
 *
 * Dimensions (survey decomposition:
 * `docs/architecture/survey/target-state-counts.md` §2 and
 * `docs/architecture/survey/per-domain-end-state.md` D1):
 *  - platform — the deployment platform id (PLATFORM_ID env,
 *    default "cfagent").
 *  - tenant — the config tenant (IAAA_TENANT_ID env, default
 *    "primary"). The tenant-override home stays undecided: this
 *    dimension is resolved from the existing tenant config; no new
 *    store is created here.
 *  - user — the executing principal, carried as a reference only.
 *    No identity unification: the resolver never resolves identity
 *    itself; when the caller has a validated `ExecutionContext` it
 *    is referenced (see `executionContext` below) and its
 *    principalId is carried, nothing more.
 *  - environment — the inherited `ResolvedEnvironment` core
 *    (name / label / isLive, plus the broker and payments
 *    sections): the environment dimension IS the core, not a
 *    second copy of it.
 *
 * NOT in this slice (later phases, per D1): the `etapi`, `otel`
 * and `flags` sections, the per-domain mode sections, and the
 * broker-provider / request-operation / channels dimensions —
 * each lands with the phase that resolves it. Nested section
 * types are not separate contexts (survey §1.1), so the
 * dimension types below deliberately carry no `Context` name.
 */

/** Platform dimension: the deployment platform id and where it came from. */
export interface UniversalPlatformDimension {
  /**
   * Platform id from PLATFORM_ID when set, else the
   * "cfagent" default (`DEFAULT_PLATFORM_ID`). Deployment
   * config, never login-resolved and never broker-derived
   * (see `resolvePlatformId`).
   */
  id: string;
  source: OtelResolutionSource;
}

/** Tenant dimension: the config tenant id and where it came from. */
export interface UniversalTenantDimension {
  /**
   * Tenant id: the per-request override when given, else
   * IAAA_TENANT_ID when set, else the deployment default
   * (`DEPLOYMENT_DEFAULT_TENANT_ID`, "primary"). Resolved
   * from the existing tenant config — the same trim-or-default
   * as `resolveIaaaTenant`; no new store. The tenant-override
   * home (D1 table, runtime level) stays an open owner
   * decision, so this dimension deliberately does NOT read
   * any override store.
   */
  id: string;
  source: OtelResolutionSource;
}

/** User dimension: the executing principal, carried as a reference only. */
export interface UniversalUserDimension {
  /**
   * Executing principal id when the caller supplies one (an
   * explicit per-request override, or the principalId of the
   * composed `ExecutionContext`); undefined when the request
   * carries no principal. This is a carried reference, not a
   * resolution: identity is resolved by
   * `resolveExecutionContext`, never here, and the env context
   * never merges identities.
   */
  principalId?: string;
  source: OtelResolutionSource;
}

/**
 * Resolution source recorded per setting, reusing the
 * `OtelResolutionSource` vocabulary (`run | session | user |
 * runtime | env | file | builtin`) — the one cascade's source
 * enum, not a new one. Keys are the setting names; the broker
 * keys (`brokerBaseUrl`, `brokerApiKey`, `brokerApiSecret`)
 * record the core broker section's base URL / credentials.
 * Levels this resolver cannot report today: `session`,
 * `user`, `runtime` — no input wired here yet, so no setting
 * reports them (see the cascade comment on
 * `resolveEnvironmentConfig`).
 */
export interface UniversalSettingSources {
  environmentName: OtelResolutionSource;
  brokerBaseUrl: OtelResolutionSource;
  brokerApiKey: OtelResolutionSource;
  brokerApiSecret: OtelResolutionSource;
  paymentsMode: OtelResolutionSource;
  paypalEnvironment: OtelResolutionSource;
  serviceUserLogin: OtelResolutionSource;
  agentScheduleBudgetCentsThreshold: OtelResolutionSource;
  agentScheduleMinIntervalSeconds: OtelResolutionSource;
  platformId: OtelResolutionSource;
  tenantId: OtelResolutionSource;
  principalId: OtelResolutionSource;
}

/**
 * The one universal env context: the `ResolvedEnvironment`
 * core plus the platform / tenant / user dimensions and the
 * per-setting source record. Resolved once per request by
 * `resolveUniversalContext`.
 */
export interface UniversalEnvContext extends ResolvedEnvironment {
  /** Platform dimension (deployment platform id). */
  platform: UniversalPlatformDimension;
  /** Tenant dimension (config tenant id). */
  tenant: UniversalTenantDimension;
  /** User dimension (executing principal, reference only). */
  user: UniversalUserDimension;
  /** Resolution source recorded per setting. */
  sources: UniversalSettingSources;
  /**
   * The validated identity context this env context is composed
   * with, when the caller has one. A reference only: the env
   * context does not read identity out of it beyond carrying
   * `user.principalId`, and it never supplies identity itself.
   * Composition at the API / MCP / DO-route boundaries
   * (`resolvePlatformContext`) is a later phase.
   */
  executionContext?: ExecutionContext;
}

/**
 * Input to `resolveUniversalContext`: the request overrides.
 * The JSON file is the carrier; these overrides are the
 * per-request (`run`-level) inputs the survey names
 * (tenant, user, overrideEnv). No other override is accepted
 * here — session / user / runtime overrides land with the
 * phases that wire those levels.
 */
export interface ResolveUniversalInput {
  /** Per-request environment override (run level). */
  overrideEnv?: string;
  /** Per-request tenant override (run level); wins over IAAA_TENANT_ID. */
  tenantId?: string;
  /** Per-request principal override (run level); wins over the composed context. */
  principalId?: string;
  /** Validated identity context to compose with (reference only). */
  executionContext?: ExecutionContext;
}

function trimmedOrUndefined(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Source of the resolved environment name, mirroring the
 * candidate order in `resolveEnvironmentConfig` exactly —
 * the two MUST stay in step (pinned by the source tests in
 * `tests/universal_env_context_6540.test.ts`). session /
 * user / runtime report nothing here: no input wired yet.
 */
function sourceOfEnvironmentName(
  env: Partial<Env> | undefined,
  overrideEnv: string | undefined,
  processEnv: Record<string, string | undefined>,
): OtelResolutionSource {
  if (overrideEnv) return "run";
  if (env?.ETRADE_ENVIRONMENT === "sandbox" || env?.ETRADE_ENVIRONMENT === "live") return "env";
  if (env?.APP_ENV && env?.APP_ENV !== defaultConfig.environment) return "env";
  if (defaultConfig.environment) return "file";
  if (env?.APP_ENV) return "env";
  if (env?.ENVIRONMENT) return "env";
  if (processEnv.APP_ENV) return "env";
  if (processEnv.ENVIRONMENT) return "env";
  return "builtin";
}

/**
 * Source of the resolved broker base URL, mirroring the
 * host-gating in `resolveEnvironmentConfig`: an env base URL
 * is honored only for the matching environment (live host in
 * PROD, sandbox host in TEST); anything else leaves the file
 * value in place, so the source is the file.
 */
function sourceOfBrokerBaseUrl(
  env: Partial<Env> | undefined,
  processEnv: Record<string, string | undefined>,
  resolvedName: string,
): OtelResolutionSource {
  const envUrl = env?.ET_BASE_URL || processEnv.ET_BASE_URL;
  if (!envUrl) return "file";
  const envIsSandboxHost = isETradeHost(envUrl, "apisb.etrade.com");
  if (resolvedName === "PROD" && !envIsSandboxHost) return "env";
  if (resolvedName === "TEST" && envIsSandboxHost) return "env";
  return "file";
}

/**
 * The one universal resolver: the extended
 * `resolveEnvironmentConfig` (survey §2.2 — the function the
 * universal resolver *is*). It calls `resolveEnvironmentConfig`
 * for the core (reuse first: no second implementation of the
 * environment / credential resolution exists), then adds the
 * platform / tenant / user dimensions and the per-setting
 * source record around that result. No setting changes value:
 * the core of the returned context deep-equals
 * `resolveEnvironmentConfig` for the same inputs.
 *
 * No read site changes in this slice: callers keep calling
 * `resolveEnvironmentConfig`; this resolver is the home the
 * later phases resolve against.
 */
export function resolveUniversalContext(
  env?: Partial<Env>,
  input: ResolveUniversalInput = {},
): UniversalEnvContext {
  const resolved = resolveEnvironmentConfig(env, input.overrideEnv);
  const processEnv = typeof process !== "undefined" && process?.env ? process.env : {};

  const platformId = resolvePlatformId(env?.PLATFORM_ID);
  const platformSource: OtelResolutionSource =
    trimmedOrUndefined(env?.PLATFORM_ID) !== undefined ? "env" : "builtin";

  const tenantOverride = trimmedOrUndefined(input.tenantId);
  const tenantEnv = trimmedOrUndefined(env?.IAAA_TENANT_ID);
  const tenantId = tenantOverride ?? tenantEnv ?? DEPLOYMENT_DEFAULT_TENANT_ID;
  const tenantSource: OtelResolutionSource =
    tenantOverride !== undefined ? "run" : tenantEnv !== undefined ? "env" : "builtin";

  // The principal is carried, never resolved: an explicit
  // override wins, else the composed identity context's
  // principalId, else absent. The tenant deliberately does NOT
  // come from the composed context — the config tenant and the
  // identity tenant are separate authorities until the
  // composition phase (#6172) rules on them.
  const principalOverride = trimmedOrUndefined(input.principalId);
  const principalId = principalOverride ?? input.executionContext?.principalId;
  const principalSource: OtelResolutionSource =
    principalId !== undefined ? "run" : "builtin";

  const environmentNameSource = sourceOfEnvironmentName(env, input.overrideEnv, processEnv);
  const brokerBaseUrlSource = sourceOfBrokerBaseUrl(env, processEnv, resolved.name);
  const paypalEnv = trimmedOrUndefined(env?.PAYPAL_ENVIRONMENT);

  return {
    ...resolved,
    platform: { id: platformId, source: platformSource },
    tenant: { id: tenantId, source: tenantSource },
    user: { principalId, source: principalSource },
    sources: {
      environmentName: environmentNameSource,
      brokerBaseUrl: brokerBaseUrlSource,
      brokerApiKey: resolved.etrade.apiKey !== undefined ? "env" : "builtin",
      brokerApiSecret: resolved.etrade.apiSecret !== undefined ? "env" : "builtin",
      // The payments mode is derived from the liveness of the
      // resolved environment, so it follows the environment
      // decision's source.
      paymentsMode: environmentNameSource,
      paypalEnvironment: paypalEnv !== undefined ? "env" : environmentNameSource,
      serviceUserLogin: resolved.serviceUserLogin !== undefined ? "env" : "builtin",
      agentScheduleBudgetCentsThreshold:
        resolved.agentSchedule?.budgetCentsThreshold !== undefined ? "env" : "builtin",
      agentScheduleMinIntervalSeconds:
        resolved.agentSchedule?.minIntervalSeconds !== undefined ? "env" : "builtin",
      platformId: platformSource,
      tenantId: tenantSource,
      principalId: principalSource,
    },
    ...(input.executionContext ? { executionContext: input.executionContext } : {}),
  };
}
