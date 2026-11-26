// @vitest-environment node
/**
 * #6550 Phase 3 (Config: move the vars into the file) — value-equality
 * tests for the 50 moved Worker text vars.
 *
 * The contract: no setting changes value. Each moved var resolves to
 * its wrangler.jsonc value when the env carries nothing (the file
 * value), and a still-set env var still wins. `CF_DEPLOY_VERSION`
 * stays a live env var (deploy-stamped) and its resolved value is
 * unchanged. `WORKSPACE_ROOT` moves verbatim at the owner's direction
 * (reserved for a future PortThink agent capability — see the
 * `_workspaceComment` in `environment.config.json`), despite zero read
 * sites in src/ today.
 *
 * Table-driven: one row per moved var — the wrangler string, the file
 * section/key, the resolved value on the file path, and an env probe
 * (value + expected resolution) on the env-wins path. No `*Context`
 * type is defined here and no `resolve*` helper is defined here (the
 * census pins forbid test-only `*Context` / `resolve*` definitions).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  resolveEnvironmentConfig,
  resolveUniversalContext,
  fileBackedEnvValue,
} from "../src/config/environment";
import { hostVersionFromEnv } from "../src/agents/orchestrator/asyncJobs";
import type { Env } from "../src/types";

/** One moved var: wrangler string, file home, resolved file value, env probe. */
type MovedRow = [
  varName: string,
  section: string,
  key: string,
  fileValue: string | number | boolean,
  envProbe: string,
  envResolved: string | number | boolean,
];

const BOOTSTRAP =
  "platform,tenant:https://github.com:82253453,platform,tenant:https://accounts.google.com:116080816274398642624";

const MOVED: MovedRow[] = [
  ["AI_SEARCH_INSTANCE", "aiSearch", "instance", "screener-search", "env-instance", "env-instance"],
  ["AI_SEARCH_CACHE_TTL_MS", "aiSearch", "cacheTtlMs", 7200000, "12345", 12345],
  ["AI_SEARCH_CACHE_MAX_ENTRIES", "aiSearch", "cacheMaxEntries", 1000, "42", 42],
  ["KNOWLEDGE_SERVING_ENABLED", "aiSearch", "knowledgeServingEnabled", true, "0", false],
  ["AI_SEARCH_REPORT_INDEXING_ENABLED", "aiSearch", "reportIndexingEnabled", true, "0", false],
  ["AI_SEARCH_CORPUS_INDEXING_ENABLED", "aiSearch", "corpusIndexingEnabled", true, "0", false],
  ["STOCK_COPILOT_PAPER_ENABLED", "stockCopilot", "paperEnabled", true, "0", false],
  ["STOCK_COPILOT_AROUND_THE_CLOCK", "stockCopilot", "aroundTheClock", false, "true", true],
  ["AGENT_CAPABILITIES_DISABLED", "agent", "capabilitiesDisabled", "", "x:cap", "x:cap"],
  ["AGENT_CONFIG_PINS", "agent", "configPins", "", "s:e", "s:e"],
  ["CHAT_NLQ_MODE", "agent", "chatNlqMode", "off", "on", "on"],
  ["SCREENER_ND_MODE", "agent", "screenerNdMode", "on", "off", "off"],
  ["COPILOT_CHANNELS", "agent", "copilotChannels", "stock:voice=on", "stock:voice=off", "stock:voice=off"],
  ["COPILOT_VOICE_BACKEND", "agent", "copilotVoiceBackend", "", "stock=model", "stock=model"],
  ["APP_NAME", "app", "name", "NextGenTP", "EnvApp", "EnvApp"],
  ["QUOTES_REST_FALLBACK_MS", "polling", "quotesRestFallbackMs", 300000, "60000", 60000],
  ["QUOTES_WS_RECONNECT_BASE_MS", "polling", "quotesWsReconnectBaseMs", 5000, "1000", 1000],
  ["QUOTES_WS_RECONNECT_CAP_MS", "polling", "quotesWsReconnectCapMs", 120000, "60000", 60000],
  ["OPTIONS_FLOWS_POLL_MS", "polling", "optionsFlowsPollMs", 3000000000000, "60000", 60000],
  ["OPTIONS_LATEST_POLL_MS", "polling", "optionsLatestPollMs", 3000000000000, "60000", 60000],
  ["CHAT_AUTO_REFRESH_FLOOR_S", "polling", "chatAutoRefreshFloorS", 30, "60", 60],
  ["GOAL_TRACK_POLL_MS", "polling", "goalTrackPollMs", 3000000000000, "60000", 60000],
  ["GOAL_TRACK_DEADLINE_MS", "polling", "goalTrackDeadlineMs", 3600000, "60000", 60000],
  ["TICKER_PUSH_INTERVAL_S", "polling", "tickerPushIntervalS", 3000, "60", 60],
  ["TICKER_PUSH_STALE_AFTER_INTERVALS", "polling", "tickerPushStaleAfterIntervals", 2, "5", 5],
  ["MAS_MAX_STEPS", "ai", "masMaxSteps", 2, "7", 7],
  ["AI_MODEL", "ai", "model", "@cf/zai-org/glm-4.7-flash", "env-model", "env-model"],
  ["CF_WALLET_NETWORK", "wallet", "network", "base-sepolia", "base", "base"],
  ["CF_WALLET_FACILITATOR", "wallet", "facilitator", "https://x402.org/facilitator", "https://env.example/facilitator", "https://env.example/facilitator"],
  ["IAAA_WIRING_ENABLED", "iaaa", "wiringEnabled", true, "0", false],
  ["IAAA_WIRED_FRESHNESS_MS", "iaaa", "wiredFreshnessMs", 3000000000000, "60000", 60000],
  ["IAAA_GRANT_DEFAULT_EXPIRY_DAYS", "iaaa", "grantDefaultExpiryDays", 90, "30", 30],
  ["IAAA_ENABLED_PROVIDERS", "iaaa", "enabledProviders", "github,google", "github", "github"],
  ["IAAA_BOOTSTRAP_ADMINS", "iaaa", "bootstrapAdmins", BOOTSTRAP, "tenant:https://github.com:1", "tenant:https://github.com:1"],
  ["IAAA_STALE_CLEANUP_MODE", "iaaa", "staleCleanupMode", "dry-run", "execute", "execute"],
  ["IAAA_MEMBERSHIP_INDEX_REPAIR_MODE", "iaaa", "membershipIndexRepairMode", "execute", "dry-run", "dry-run"],
  ["IAAA_PDP_ENABLED", "iaaa", "pdpEnabled", true, "0", false],
  ["COMMERCIAL_STORE_OPERATORS", "commercial", "storeOperators", "OpenAIMP", "EnvLogin", "EnvLogin"],
  ["SOCIAL_POSTING_ENABLED", "social", "postingEnabled", false, "1", true],
  ["SOCIAL_LIVE_PUBLISHING", "social", "livePublishing", false, "1", true],
  ["SOCIAL_AUTONOMOUS_CHANNELS", "social", "autonomousChannels", "threads", "x", "x"],
  ["SERVICE_USER_LOGIN", "service", "userLogin", "svc-background", "svc-env", "svc-env"],
  ["FEATURE_SCREENER", "features", "screener", true, "0", false],
  ["FEATURE_GOAL_WORKFLOW", "features", "goalWorkflow", true, "0", false],
  ["FEATURE_PAYMENT_ASSURANCE", "features", "paymentAssurance", true, "0", false],
  ["FEATURE_OPTIONS_SCREENER", "features", "optionsScreener", true, "0", false],
  ["FEATURE_MONETIZATION", "features", "monetization", true, "0", false],
  ["FEATURE_SANDBOX", "features", "sandbox", false, "1", true],
  ["FEATURE_WORKSPACE", "features", "workspace", true, "0", false],
  ["WORKSPACE_ROOT", "workspace", "root", "/workspace", "/env-workspace", "/env-workspace"],
];

describe("Phase 3 value equality — the 50 moved vars (#6550)", () => {
  it("the table covers exactly the 50 moved vars (no duplicates, no gaps)", () => {
    expect(MOVED.length).toBe(50);
    expect(new Set(MOVED.map(([v]) => v)).size).toBe(50);
  });

  for (const [varName, section, key, fileValue, envProbe, envResolved] of MOVED) {
    it(`file path: ${varName} resolves to its wrangler value`, () => {
      const resolved = resolveEnvironmentConfig({});
      const actual = (resolved.workerSettings as Record<string, Record<string, unknown>>)[section][key];
      expect(actual).toBe(fileValue);
    });

    it(`env-wins path: ${varName} still wins when set`, () => {
      const env = { [varName]: envProbe } as Partial<Env>;
      const resolved = resolveEnvironmentConfig(env);
      const actual = (resolved.workerSettings as Record<string, Record<string, unknown>>)[section][key];
      expect(actual).toBe(envResolved);
    });
  }

  it("SERVICE_USER_LOGIN: the top-level field mirrors the service section", () => {
    expect(resolveEnvironmentConfig({}).serviceUserLogin).toBe("svc-background");
    expect(resolveEnvironmentConfig({ SERVICE_USER_LOGIN: "svc-env" }).serviceUserLogin).toBe("svc-env");
  });

  it("the universal context carries the same worker settings", () => {
    const fromCore = resolveEnvironmentConfig({});
    const fromUniversal = resolveUniversalContext({});
    expect(fromUniversal.workerSettings).toEqual(fromCore.workerSettings);
    expect(fromUniversal.serviceUserLogin).toBe(fromCore.serviceUserLogin);
  });

  it("WORKSPACE_ROOT is reserved for a future PortThink agent capability (file comment)", () => {
    const text = readFileSync("environment.config.json", "utf-8");
    expect(text).toContain("reserved for a future PortThink agent capability");
    expect(resolveEnvironmentConfig({}).workerSettings.workspace.root).toBe("/workspace");
  });
});

describe("Phase 3 value equality — CF_DEPLOY_VERSION stays live (#6550)", () => {
  const SHA = "a".repeat(40);

  it("a stamped 40-hex SHA resolves as the host version", () => {
    expect(hostVersionFromEnv({ CF_DEPLOY_VERSION: SHA })).toBe(SHA);
  });

  it("the unstamped placeholder resolves as unknown, never as a version", () => {
    expect(hostVersionFromEnv({ CF_DEPLOY_VERSION: "<DEPLOY_VERSION>" })).toBeNull();
  });

  it("wrangler.jsonc still declares CF_DEPLOY_VERSION as its sole live var", () => {
    const text = readFileSync("wrangler.jsonc", "utf-8");
    const live = [...text.matchAll(/^\s*"([A-Z_][A-Z0-9_]*)":/gm)].map((m) => m[1]);
    expect(live).toEqual(["CF_DEPLOY_VERSION"]);
  });
});

describe("Phase 3 value equality — wrangler comments name every moved var (#6550)", () => {
  it("each moved var leaves a comment with its name, old value, and file location", () => {
    const text = readFileSync("wrangler.jsonc", "utf-8");
    for (const [varName, section, key] of MOVED) {
      const line = text
        .split("\n")
        .find((l) => l.trimStart().startsWith(`// "${varName}":`));
      expect(line, `wrangler.jsonc has a moved-var comment for ${varName}`).toBeDefined();
      expect(line).toContain(`defaults.${section}.${key}`);
    }
  });

  it("WORKSPACE_ROOT is not dropped: its comment records the move and the reservation", () => {
    const text = readFileSync("wrangler.jsonc", "utf-8");
    const line = text
      .split("\n")
      .find((l) => l.includes('"WORKSPACE_ROOT"') && l.trimStart().startsWith("//"));
    expect(line).toBeDefined();
    expect(line).toContain("defaults.workspace.root");
    expect(line).toContain("PortThink");
  });

  it("keep_vars is false, so the commented-out vars actually leave the deployed env", () => {
    const text = readFileSync("wrangler.jsonc", "utf-8");
    expect(text).toContain('"keep_vars": false');
    expect(text).not.toContain('"keep_vars": true');
  });
});

describe("Phase 3 value equality — the string view over the resolved context (#6550)", () => {
  it("file path renders each moved var as its wrangler string", () => {
    expect(fileBackedEnvValue({}, "CHAT_NLQ_MODE")).toBe("off");
    expect(fileBackedEnvValue({}, "AI_SEARCH_CACHE_TTL_MS")).toBe("7200000");
    expect(fileBackedEnvValue({}, "FEATURE_SCREENER")).toBe("1");
    expect(fileBackedEnvValue({}, "MAS_MAX_STEPS")).toBe("2");
    expect(fileBackedEnvValue({}, "WORKSPACE_ROOT")).toBe("/workspace");
  });

  it("env path renders the still-set env string", () => {
    expect(fileBackedEnvValue({ CHAT_NLQ_MODE: "on" }, "CHAT_NLQ_MODE")).toBe("on");
    expect(fileBackedEnvValue({ AI_SEARCH_CACHE_TTL_MS: "12345" }, "AI_SEARCH_CACHE_TTL_MS")).toBe("12345");
  });

  it("an unknown name returns undefined (non-moved vars behave as before)", () => {
    expect(fileBackedEnvValue({}, "FEATURE_VOICE_TRADING")).toBeUndefined();
    expect(fileBackedEnvValue({}, "SOCIAL_APPROVAL_CHANNELS")).toBeUndefined();
  });
});
