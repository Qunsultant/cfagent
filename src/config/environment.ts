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
  /**
   * Phase 3 (#6550) — the 50 moved Worker text vars, resolved once per
   * request from `environment.config.json` `defaults` (see
   * `MovedWorkerSettings`). Env wins when the var is still set — the
   * one cascade's env > file — so a dashboard-set var still overrides
   * the file, exactly as it overrode the wrangler value before the
   * move. `CF_DEPLOY_VERSION` is NOT here: it stays a deploy-injected
   * env var (see the var-count pin), and the file's unread `payments`
   * section is untouched (open decision, not wired here).
   */
  workerSettings: MovedWorkerSettings;
}

/**
 * Phase 3 (#6550) — the moved Worker text vars, grouped exactly as
 * the survey §1.5 groups them (recon §2.5). Typed values (numbers /
 * booleans, not strings): the file is JSON, so every read site that
 * used to parse a wrangler string now reads the typed value. The
 * section types deliberately carry no `Context` name (the context
 * census pin counts `*Context` definitions) and no section is a
 * separate context: they are fields of the one `ResolvedEnvironment`
 * core, inherited by `UniversalEnvContext` through the spread in
 * `resolveUniversalContext`.
 */
export interface AiSearchSettings {
  instance: string;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  knowledgeServingEnabled: boolean;
  reportIndexingEnabled: boolean;
  corpusIndexingEnabled: boolean;
}

export interface StockCopilotSettings {
  paperEnabled: boolean;
  aroundTheClock: boolean;
}

export interface AgentSettings {
  capabilitiesDisabled: string;
  configPins: string;
  chatNlqMode: string;
  screenerNdMode: string;
  copilotChannels: string;
  copilotVoiceBackend: string;
}

export interface AppSettings {
  name: string;
}

export interface PollingSettings {
  quotesRestFallbackMs: number;
  quotesWsReconnectBaseMs: number;
  quotesWsReconnectCapMs: number;
  optionsFlowsPollMs: number;
  optionsLatestPollMs: number;
  chatAutoRefreshFloorS: number;
  goalTrackPollMs: number;
  goalTrackDeadlineMs: number;
  tickerPushIntervalS: number;
  tickerPushStaleAfterIntervals: number;
}

export interface AiSettings {
  masMaxSteps: number;
  /**
   * Phase 3 (#6550) — moved verbatim from `AI_MODEL`. This duplicates
   * `defaults.etapi.ai.defaultModel` (same value today); the duplication
   * is pre-existing and is NOT resolved here — deduplication is a
   * separate decision, not this slice. `getEtapiConfig` keeps reading
   * the etapi home; `resolveAiModelName` reads this home.
   */
  model: string;
}

export interface WalletSettings {
  network: string;
  facilitator: string;
}

export interface IaaaSettings {
  wiringEnabled: boolean;
  wiredFreshnessMs: number;
  grantDefaultExpiryDays: number;
  enabledProviders: string;
  bootstrapAdmins: string;
  staleCleanupMode: string;
  /**
   * Moved verbatim as `"execute"` (the live one-time-rebuild value) —
   * NOT "corrected" to `"dry-run"` in the move (#6550).
   */
  membershipIndexRepairMode: string;
  pdpEnabled: boolean;
}

export interface CommercialSettings {
  storeOperators: string;
}

export interface SocialSettings {
  postingEnabled: boolean;
  livePublishing: boolean;
  autonomousChannels: string;
}

export interface ServiceSettings {
  userLogin: string;
}

export interface FeatureSettings {
  screener: boolean;
  goalWorkflow: boolean;
  paymentAssurance: boolean;
  optionsScreener: boolean;
  monetization: boolean;
  sandbox: boolean;
  workspace: boolean;
}

/** Phase 3 (#6550): WORKSPACE_ROOT, kept at the owner's direction — reserved for a future PortThink agent capability, not read by any site today. */
export interface WorkspaceSettings {
  root: string;
}

export interface MovedWorkerSettings {
  aiSearch: AiSearchSettings;
  stockCopilot: StockCopilotSettings;
  agent: AgentSettings;
  app: AppSettings;
  polling: PollingSettings;
  ai: AiSettings;
  wallet: WalletSettings;
  iaaa: IaaaSettings;
  commercial: CommercialSettings;
  social: SocialSettings;
  service: ServiceSettings;
  features: FeatureSettings;
  workspace: WorkspaceSettings;
}

/** The file-backed `defaults` sections the moved vars live in (Phase 3, #6550). */
interface MovedFileSections {
  aiSearch?: Partial<AiSearchSettings>;
  stockCopilot?: Partial<StockCopilotSettings>;
  agent?: Partial<AgentSettings>;
  app?: Partial<AppSettings>;
  polling?: Partial<PollingSettings>;
  ai?: Partial<AiSettings>;
  wallet?: Partial<WalletSettings>;
  iaaa?: Partial<IaaaSettings>;
  commercial?: Partial<CommercialSettings>;
  social?: Partial<SocialSettings>;
  service?: Partial<ServiceSettings>;
  features?: Partial<FeatureSettings>;
  workspace?: Partial<WorkspaceSettings>;
}

/**
 * Render one moved setting as its wrangler string, for the read sites
 * that parse raw strings (the modes engine's `envVar` bindings, the
 * capability-manifest disable list, the agent-config pins). Booleans
 * render `"1"` / `"0"`, numbers render decimal, strings render as-is —
 * the exact strings the wrangler vars carried.
 */
function movedSettingAsString(
  section: string,
  key: string,
  settings: MovedWorkerSettings,
): string {
  const value = (settings as unknown as Record<string, Record<string, unknown>>)[section]?.[key];
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value : "";
}

/**
 * The moved var names and where each lives in the resolved context.
 * The single table the string view (`fileBackedEnvValue`) and the
 * per-setting source record both read, so a var cannot be moved in
 * one and forgotten in the other.
 */
const MOVED_VAR_LOCATIONS: ReadonlyArray<readonly [string, string, string]> = [
  ["AI_SEARCH_INSTANCE", "aiSearch", "instance"],
  ["AI_SEARCH_CACHE_TTL_MS", "aiSearch", "cacheTtlMs"],
  ["AI_SEARCH_CACHE_MAX_ENTRIES", "aiSearch", "cacheMaxEntries"],
  ["KNOWLEDGE_SERVING_ENABLED", "aiSearch", "knowledgeServingEnabled"],
  ["AI_SEARCH_REPORT_INDEXING_ENABLED", "aiSearch", "reportIndexingEnabled"],
  ["AI_SEARCH_CORPUS_INDEXING_ENABLED", "aiSearch", "corpusIndexingEnabled"],
  ["STOCK_COPILOT_PAPER_ENABLED", "stockCopilot", "paperEnabled"],
  ["STOCK_COPILOT_AROUND_THE_CLOCK", "stockCopilot", "aroundTheClock"],
  ["AGENT_CAPABILITIES_DISABLED", "agent", "capabilitiesDisabled"],
  ["AGENT_CONFIG_PINS", "agent", "configPins"],
  ["CHAT_NLQ_MODE", "agent", "chatNlqMode"],
  ["SCREENER_ND_MODE", "agent", "screenerNdMode"],
  ["COPILOT_CHANNELS", "agent", "copilotChannels"],
  ["COPILOT_VOICE_BACKEND", "agent", "copilotVoiceBackend"],
  ["APP_NAME", "app", "name"],
  ["QUOTES_REST_FALLBACK_MS", "polling", "quotesRestFallbackMs"],
  ["QUOTES_WS_RECONNECT_BASE_MS", "polling", "quotesWsReconnectBaseMs"],
  ["QUOTES_WS_RECONNECT_CAP_MS", "polling", "quotesWsReconnectCapMs"],
  ["OPTIONS_FLOWS_POLL_MS", "polling", "optionsFlowsPollMs"],
  ["OPTIONS_LATEST_POLL_MS", "polling", "optionsLatestPollMs"],
  ["CHAT_AUTO_REFRESH_FLOOR_S", "polling", "chatAutoRefreshFloorS"],
  ["GOAL_TRACK_POLL_MS", "polling", "goalTrackPollMs"],
  ["GOAL_TRACK_DEADLINE_MS", "polling", "goalTrackDeadlineMs"],
  ["TICKER_PUSH_INTERVAL_S", "polling", "tickerPushIntervalS"],
  ["TICKER_PUSH_STALE_AFTER_INTERVALS", "polling", "tickerPushStaleAfterIntervals"],
  ["MAS_MAX_STEPS", "ai", "masMaxSteps"],
  ["AI_MODEL", "ai", "model"],
  ["CF_WALLET_NETWORK", "wallet", "network"],
  ["CF_WALLET_FACILITATOR", "wallet", "facilitator"],
  ["IAAA_WIRING_ENABLED", "iaaa", "wiringEnabled"],
  ["IAAA_WIRED_FRESHNESS_MS", "iaaa", "wiredFreshnessMs"],
  ["IAAA_GRANT_DEFAULT_EXPIRY_DAYS", "iaaa", "grantDefaultExpiryDays"],
  ["IAAA_ENABLED_PROVIDERS", "iaaa", "enabledProviders"],
  ["IAAA_BOOTSTRAP_ADMINS", "iaaa", "bootstrapAdmins"],
  ["IAAA_STALE_CLEANUP_MODE", "iaaa", "staleCleanupMode"],
  ["IAAA_MEMBERSHIP_INDEX_REPAIR_MODE", "iaaa", "membershipIndexRepairMode"],
  ["IAAA_PDP_ENABLED", "iaaa", "pdpEnabled"],
  ["COMMERCIAL_STORE_OPERATORS", "commercial", "storeOperators"],
  ["SOCIAL_POSTING_ENABLED", "social", "postingEnabled"],
  ["SOCIAL_LIVE_PUBLISHING", "social", "livePublishing"],
  ["SOCIAL_AUTONOMOUS_CHANNELS", "social", "autonomousChannels"],
  ["SERVICE_USER_LOGIN", "service", "userLogin"],
  ["FEATURE_SCREENER", "features", "screener"],
  ["FEATURE_GOAL_WORKFLOW", "features", "goalWorkflow"],
  ["FEATURE_PAYMENT_ASSURANCE", "features", "paymentAssurance"],
  ["FEATURE_OPTIONS_SCREENER", "features", "optionsScreener"],
  ["FEATURE_MONETIZATION", "features", "monetization"],
  ["FEATURE_SANDBOX", "features", "sandbox"],
  ["FEATURE_WORKSPACE", "features", "workspace"],
  ["WORKSPACE_ROOT", "workspace", "root"],
];

/**
 * The string view over the resolved context, for the read sites that
 * parse raw strings (the modes engine's `envVar` bindings via
 * `envRawValue`, the capability-manifest disable list, the
 * agent-config pins): the env value wins when the record still
 * carries the var (non-blank string, or a number / boolean), else the
 * resolved file value rendered as its wrangler string. Unknown names
 * return `undefined`, so non-moved vars behave exactly as before.
 * This is a view over `resolveEnvironmentConfig`, not a second
 * implementation: the file value comes from the same resolved
 * `workerSettings` every typed reader uses.
 */
export function fileBackedEnvValue(
  env: Partial<Env> | Record<string, unknown> | null | undefined,
  varName: string,
): string | undefined {
  if (env && typeof env === "object") {
    const raw = (env as Record<string, unknown>)[varName];
    if (typeof raw === "string" && raw.trim() !== "") return raw;
    if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  }
  const location = MOVED_VAR_LOCATIONS.find(([name]) => name === varName);
  if (!location) return undefined;
  const settings = resolveEnvironmentConfig(env as Partial<Env> | undefined).workerSettings;
  return movedSettingAsString(location[1], location[2], settings);
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

  // Phase 3 (#6550) — the 50 moved Worker text vars, resolved from
  // environment.config.json `defaults` with the env level winning
  // when the var is still set (the one cascade's env > file). Each
  // field's env parse mirrors its read sites' parse exactly, so a
  // still-set var resolves to the same value it resolved to from
  // wrangler; an unset var resolves to the file value, which IS the
  // wrangler value that was moved. The file sections are read
  // defensively (Partial): a missing file key falls back to the moved
  // value (duplicated here only as a missing-key guard, so a missing
  // key can never silently change a deployed value), never to a crash.
  const envRecord = env as unknown as Record<string, unknown> | undefined;
  const fileSections = (defaultConfig.defaults ?? {}) as unknown as MovedFileSections;
  // "1"/"true"/"on" (trimmed, case-insensitive) — the aiSearch /
  // stockCopilot / feature-flag idiom (isKnowledgeServingEnabled,
  // EnvFeatureFlagAdapter step 2).
  const pickOnOffFlag = (raw: unknown, fileVal: boolean): boolean => {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") {
      const norm = raw.trim().toLowerCase();
      // Phase 3 (#6550): the old read sites were TOTAL parses — any
      // string other than the true set meant OFF. A non-blank but
      // unrecognized env value ("yes", "on" for the 1/true idiom)
      // still means OFF, exactly as before; only a BLANK or absent
      // env falls through to the file value.
      if (norm === "") return fileVal;
      if (norm === "1" || norm === "true" || norm === "on") return true;
      return false;
    }
    return fileVal;
  };
  // "1"/"true" only — the IAAA wiring / PDP idiom (isWiringEnabled,
  // isPdpEnabled) and the social idiom (parseSocialConfig, the
  // publisher: `=== "1" || === "true"`, no "on").
  const pickOneTrueFlag = (raw: unknown, fileVal: boolean): boolean => {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") {
      const norm = raw.trim().toLowerCase();
      if (norm === "") return fileVal;
      if (norm === "1" || norm === "true") return true;
      return false;
    }
    return fileVal;
  };
  // "true" only (case-insensitive) — the around-the-clock idiom
  // (resolveCopilotSessions / isAroundTheClock: `=== "true"`).
  const pickTrueOnlyFlag = (raw: unknown, fileVal: boolean): boolean => {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") {
      const norm = raw.trim().toLowerCase();
      if (norm === "") return fileVal;
      if (norm === "true") return true;
      return false;
    }
    return fileVal;
  };
  const pickText = (raw: unknown, fileVal: string): string => {
    if (typeof raw === "string" && raw.trim() !== "") return raw;
    if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
    return fileVal;
  };
  const pickPositiveNumber = (raw: unknown, fileVal: number): number => {
    const n =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
          ? Number(raw)
          : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : fileVal;
  };
  const pickPositiveInt = (raw: unknown, fileVal: number): number => {
    const n =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
          ? Number.parseInt(raw, 10)
          : Number.NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fileVal;
  };
  const pickNonNegativeNumber = (raw: unknown, fileVal: number): number => {
    if (typeof raw === "string" && raw.trim() === "") return fileVal;
    const n = typeof raw === "number" ? raw : raw == null ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fileVal;
  };
  // MAS_MAX_STEPS only: Number(raw) with NaN propagating, exactly as
  // resolveMasMaxSteps does today (the shadow sanitizes; see
  // src/agents/chatPrompt.ts) — a non-numeric env value stays NaN.
  const pickNumberRaw = (raw: unknown, fileVal: number): number => {
    if (typeof raw === "string" && raw.trim() !== "") return Number(raw);
    if (typeof raw === "number") return raw;
    return fileVal;
  };
  const fileFlag = (section: keyof MovedFileSections, key: string, fallback: boolean): boolean => {
    const v = (fileSections[section] as Record<string, unknown> | undefined)?.[key];
    return typeof v === "boolean" ? v : fallback;
  };
  const fileNumber = (section: keyof MovedFileSections, key: string, fallback: number): number => {
    const v = (fileSections[section] as Record<string, unknown> | undefined)?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  const fileText = (section: keyof MovedFileSections, key: string, fallback: string): string => {
    const v = (fileSections[section] as Record<string, unknown> | undefined)?.[key];
    return typeof v === "string" ? v : fallback;
  };
  const workerSettings: MovedWorkerSettings = {
    aiSearch: {
      instance: pickText(envRecord?.AI_SEARCH_INSTANCE, fileText("aiSearch", "instance", "screener-search")),
      cacheTtlMs: pickPositiveNumber(envRecord?.AI_SEARCH_CACHE_TTL_MS, fileNumber("aiSearch", "cacheTtlMs", 7200000)),
      cacheMaxEntries: Math.floor(
        pickPositiveNumber(envRecord?.AI_SEARCH_CACHE_MAX_ENTRIES, fileNumber("aiSearch", "cacheMaxEntries", 1000)),
      ),
      knowledgeServingEnabled: pickOnOffFlag(envRecord?.KNOWLEDGE_SERVING_ENABLED, fileFlag("aiSearch", "knowledgeServingEnabled", true)),
      reportIndexingEnabled: pickOnOffFlag(envRecord?.AI_SEARCH_REPORT_INDEXING_ENABLED, fileFlag("aiSearch", "reportIndexingEnabled", true)),
      corpusIndexingEnabled: pickOnOffFlag(envRecord?.AI_SEARCH_CORPUS_INDEXING_ENABLED, fileFlag("aiSearch", "corpusIndexingEnabled", true)),
    },
    stockCopilot: {
      paperEnabled: pickOnOffFlag(envRecord?.STOCK_COPILOT_PAPER_ENABLED, fileFlag("stockCopilot", "paperEnabled", true)),
      aroundTheClock: pickTrueOnlyFlag(envRecord?.STOCK_COPILOT_AROUND_THE_CLOCK, fileFlag("stockCopilot", "aroundTheClock", false)),
    },
    agent: {
      capabilitiesDisabled: pickText(envRecord?.AGENT_CAPABILITIES_DISABLED, fileText("agent", "capabilitiesDisabled", "")),
      configPins: pickText(envRecord?.AGENT_CONFIG_PINS, fileText("agent", "configPins", "")),
      chatNlqMode: pickText(envRecord?.CHAT_NLQ_MODE, fileText("agent", "chatNlqMode", "off")),
      screenerNdMode: pickText(envRecord?.SCREENER_ND_MODE, fileText("agent", "screenerNdMode", "on")),
      copilotChannels: pickText(envRecord?.COPILOT_CHANNELS, fileText("agent", "copilotChannels", "stock:voice=on")),
      copilotVoiceBackend: pickText(envRecord?.COPILOT_VOICE_BACKEND, fileText("agent", "copilotVoiceBackend", "")),
    },
    app: {
      name: pickText(envRecord?.APP_NAME, fileText("app", "name", "NextGenTP")),
    },
    polling: {
      quotesRestFallbackMs: pickPositiveNumber(envRecord?.QUOTES_REST_FALLBACK_MS, fileNumber("polling", "quotesRestFallbackMs", 300000)),
      quotesWsReconnectBaseMs: pickPositiveNumber(envRecord?.QUOTES_WS_RECONNECT_BASE_MS, fileNumber("polling", "quotesWsReconnectBaseMs", 5000)),
      quotesWsReconnectCapMs: pickPositiveNumber(envRecord?.QUOTES_WS_RECONNECT_CAP_MS, fileNumber("polling", "quotesWsReconnectCapMs", 120000)),
      optionsFlowsPollMs: pickPositiveNumber(envRecord?.OPTIONS_FLOWS_POLL_MS, fileNumber("polling", "optionsFlowsPollMs", 3000000000000)),
      optionsLatestPollMs: pickPositiveNumber(envRecord?.OPTIONS_LATEST_POLL_MS, fileNumber("polling", "optionsLatestPollMs", 3000000000000)),
      chatAutoRefreshFloorS: pickPositiveNumber(envRecord?.CHAT_AUTO_REFRESH_FLOOR_S, fileNumber("polling", "chatAutoRefreshFloorS", 30)),
      goalTrackPollMs: pickPositiveNumber(envRecord?.GOAL_TRACK_POLL_MS, fileNumber("polling", "goalTrackPollMs", 3000000000000)),
      goalTrackDeadlineMs: pickPositiveNumber(envRecord?.GOAL_TRACK_DEADLINE_MS, fileNumber("polling", "goalTrackDeadlineMs", 3600000)),
      tickerPushIntervalS: pickPositiveInt(envRecord?.TICKER_PUSH_INTERVAL_S, fileNumber("polling", "tickerPushIntervalS", 3000)),
      tickerPushStaleAfterIntervals: pickPositiveInt(envRecord?.TICKER_PUSH_STALE_AFTER_INTERVALS, fileNumber("polling", "tickerPushStaleAfterIntervals", 2)),
    },
    ai: {
      masMaxSteps: pickNumberRaw(envRecord?.MAS_MAX_STEPS, fileNumber("ai", "masMaxSteps", 2)),
      model: pickText(envRecord?.AI_MODEL, fileText("ai", "model", "@cf/zai-org/glm-4.7-flash")),
    },
    wallet: {
      network: pickText(envRecord?.CF_WALLET_NETWORK, fileText("wallet", "network", "base-sepolia")),
      facilitator: pickText(envRecord?.CF_WALLET_FACILITATOR, fileText("wallet", "facilitator", "https://x402.org/facilitator")),
    },
    iaaa: {
      wiringEnabled: pickOneTrueFlag(envRecord?.IAAA_WIRING_ENABLED, fileFlag("iaaa", "wiringEnabled", true)),
      wiredFreshnessMs: pickNonNegativeNumber(envRecord?.IAAA_WIRED_FRESHNESS_MS, fileNumber("iaaa", "wiredFreshnessMs", 3000000000000)),
      grantDefaultExpiryDays: pickPositiveInt(envRecord?.IAAA_GRANT_DEFAULT_EXPIRY_DAYS, fileNumber("iaaa", "grantDefaultExpiryDays", 90)),
      enabledProviders: pickText(envRecord?.IAAA_ENABLED_PROVIDERS, fileText("iaaa", "enabledProviders", "github,google")),
      bootstrapAdmins: pickText(envRecord?.IAAA_BOOTSTRAP_ADMINS, fileText("iaaa", "bootstrapAdmins", "platform,tenant:https://github.com:82253453,platform,tenant:https://accounts.google.com:116080816274398642624")),
      staleCleanupMode: pickText(envRecord?.IAAA_STALE_CLEANUP_MODE, fileText("iaaa", "staleCleanupMode", "dry-run")),
      membershipIndexRepairMode: pickText(envRecord?.IAAA_MEMBERSHIP_INDEX_REPAIR_MODE, fileText("iaaa", "membershipIndexRepairMode", "execute")),
      pdpEnabled: pickOneTrueFlag(envRecord?.IAAA_PDP_ENABLED, fileFlag("iaaa", "pdpEnabled", true)),
    },
    commercial: {
      storeOperators: pickText(envRecord?.COMMERCIAL_STORE_OPERATORS, fileText("commercial", "storeOperators", "OpenAIMP")),
    },
    social: {
      postingEnabled: pickOneTrueFlag(envRecord?.SOCIAL_POSTING_ENABLED, fileFlag("social", "postingEnabled", false)),
      livePublishing: pickOneTrueFlag(envRecord?.SOCIAL_LIVE_PUBLISHING, fileFlag("social", "livePublishing", false)),
      autonomousChannels: pickText(envRecord?.SOCIAL_AUTONOMOUS_CHANNELS, fileText("social", "autonomousChannels", "threads")),
    },
    service: {
      // Set from `serviceUserLogin` below (one computation, two views).
      userLogin: "",
    },
    features: {
      screener: pickOnOffFlag(envRecord?.FEATURE_SCREENER, fileFlag("features", "screener", true)),
      goalWorkflow: pickOnOffFlag(envRecord?.FEATURE_GOAL_WORKFLOW, fileFlag("features", "goalWorkflow", true)),
      paymentAssurance: pickOnOffFlag(envRecord?.FEATURE_PAYMENT_ASSURANCE, fileFlag("features", "paymentAssurance", true)),
      optionsScreener: pickOnOffFlag(envRecord?.FEATURE_OPTIONS_SCREENER, fileFlag("features", "optionsScreener", true)),
      monetization: pickOnOffFlag(envRecord?.FEATURE_MONETIZATION, fileFlag("features", "monetization", true)),
      sandbox: pickOnOffFlag(envRecord?.FEATURE_SANDBOX, fileFlag("features", "sandbox", false)),
      workspace: pickOnOffFlag(envRecord?.FEATURE_WORKSPACE, fileFlag("features", "workspace", true)),
    },
    // Phase 3 (#6550): WORKSPACE_ROOT is kept at the owner's direction
    // (reserved for a future PortThink agent capability) — moved
    // verbatim, no read site consumes it today.
    workspace: {
      root: pickText(envRecord?.WORKSPACE_ROOT, fileText("workspace", "root", "/workspace")),
    },
  };

  // #1185 / #1066 — explicit service identity for unattended work. A
  // non-secret login id, owner-set via SERVICE_USER_LOGIN; undefined when
  // unset so unattended dispatch fails closed (see
  // src/security/serviceIdentity.ts). Phase 3 (#6550): the file value
  // is the fallback now that the var moved — an unset env reads
  // `defaults.service.userLogin` ("svc-background"), never undefined
  // in production; the env value still wins when set.
  const serviceUserLogin =
    sanitize(env?.SERVICE_USER_LOGIN) ?? fileText("service", "userLogin", "svc-background");
  workerSettings.service.userLogin = serviceUserLogin;

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
    workerSettings,
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
  /**
   * Phase 3 (#6550) — one source per moved var (the 50 names in
   * `MOVED_VAR_LOCATIONS`): `"env"` when the record still carries the
   * var, else `"file"`. The file always provides a value now, so no
   * moved var ever reports `"builtin"`.
   */
  movedSettings: Record<string, OtelResolutionSource>;
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

  // Phase 3 (#6550) — the moved vars' sources: env when the record
  // still carries the var (non-blank), else the file (which always
  // provides a value now). SERVICE_USER_LOGIN is decided the same
  // way the core decides the value: an env value the core's
  // `sanitize` accepts reports "env", anything else the file.
  const envRecord = env as unknown as Record<string, unknown> | undefined;
  const movedSettingsSources: Record<string, OtelResolutionSource> = {};
  for (const [name] of MOVED_VAR_LOCATIONS) {
    const raw = envRecord?.[name];
    movedSettingsSources[name] =
      (typeof raw === "string" ? raw.trim() !== "" : raw !== undefined) ? "env" : "file";
  }
  const serviceUserLoginSource: OtelResolutionSource =
    resolved.serviceUserLogin !== undefined
      ? trimmedOrUndefined(env?.SERVICE_USER_LOGIN) !== undefined &&
        !["true", "false", "null", "undefined"].includes(
          (env?.SERVICE_USER_LOGIN as string).trim(),
        )
        ? "env"
        : "file"
      : "builtin";

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
      serviceUserLogin: serviceUserLoginSource,
      agentScheduleBudgetCentsThreshold:
        resolved.agentSchedule?.budgetCentsThreshold !== undefined ? "env" : "builtin",
      agentScheduleMinIntervalSeconds:
        resolved.agentSchedule?.minIntervalSeconds !== undefined ? "env" : "builtin",
      movedSettings: movedSettingsSources,
      platformId: platformSource,
      tenantId: tenantSource,
      principalId: principalSource,
    },
    ...(input.executionContext ? { executionContext: input.executionContext } : {}),
  };
}
