// @vitest-environment node
/**
 * #6540 Phase 2 (Config: the one universal env context) — value-equality
 * tests for `resolveUniversalContext`.
 *
 * The contract: the new resolver calls `resolveEnvironmentConfig` for
 * its core, so the core of the returned `UniversalEnvContext` must
 * deep-equal the old resolver's output for the same inputs — no setting
 * changes value. The dimensions (platform / tenant / user) and the
 * per-setting source record are the only additions, and each source
 * must name the level that actually decided the value under the one
 * 7-level cascade (run > session > user > runtime > env > file >
 * builtin).
 *
 * No `*Context` type is defined here (the context census pin forbids
 * test-only `*Context` definitions) and no `resolve*` helper is defined
 * here (the resolver census pin forbids test-only `resolve*`
 * definitions) — helpers below use plain names.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveEnvironmentConfig,
  resolveUniversalContext,
  type ResolvedEnvironment,
  type UniversalEnvContext,
} from "../src/config/environment";
import type { ExecutionContext } from "../src/security/executionContext";
import { resolvePlatformId, DEFAULT_PLATFORM_ID } from "../src/security/attributionEnvelope";
import { resolveIaaaTenant } from "../src/security/iaaaGithubEndToEnd";
import type { Env } from "../src/types";

/** The `ResolvedEnvironment` core of a universal context (no dimensions/sources). */
function coreOf(ctx: UniversalEnvContext): ResolvedEnvironment {
  return {
    name: ctx.name,
    label: ctx.label,
    isLive: ctx.isLive,
    etrade: ctx.etrade,
    payments: ctx.payments,
    serviceUserLogin: ctx.serviceUserLogin,
    agentSchedule: ctx.agentSchedule,
  };
}

/** process.env keys the resolvers read — cleared per test so sources are deterministic. */
const PROCESS_ENV_KEYS = [
  "APP_ENV",
  "ENVIRONMENT",
  "ET_BASE_URL",
  "ET_API_KEY",
  "ET_API_SECRET",
  "ETRADE_API_KEY",
  "ETRADE_CONSUMER_KEY",
  "ETRADE_API_SECRET",
  "ETRADE_CONSUMER_SECRET",
  "ET_PROD_API_KEY",
  "ETRADE_PROD_CONSUMER_KEY",
  "PROD_ET_API_KEY",
  "ET_SANDBOX_API_KEY",
  "ETRADE_SANDBOX_CONSUMER_KEY",
  "SANDBOX_ET_API_KEY",
  "PAYPAL_ENVIRONMENT",
] as const;

const savedProcessEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedProcessEnv.clear();
  for (const key of PROCESS_ENV_KEYS) {
    savedProcessEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROCESS_ENV_KEYS) {
    const saved = savedProcessEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

describe("resolveUniversalContext — value equality with resolveEnvironmentConfig (#6540)", () => {
  const cases: Array<{
    label: string;
    env: Partial<Env>;
    overrideEnv?: string;
    input?: { tenantId?: string; principalId?: string };
  }> = [
    { label: "defaults (file PROD)", env: {} },
    { label: "sandbox", env: { ETRADE_ENVIRONMENT: "sandbox" } },
    { label: "live", env: { ETRADE_ENVIRONMENT: "live" } },
    {
      label: "sandbox with credentials + base URL",
      env: {
        ETRADE_ENVIRONMENT: "sandbox",
        ET_BASE_URL: "https://apisb.etrade.com",
        ET_API_KEY: "k1",
        ET_API_SECRET: "s1",
      },
    },
    {
      label: "live with credentials + base URL",
      env: {
        ETRADE_ENVIRONMENT: "live",
        ET_BASE_URL: "https://api.etrade.com",
        ET_API_KEY: "k2",
        ET_API_SECRET: "s2",
      },
    },
    {
      label: "deceptive base URL rejected (host gating, #845/#846)",
      env: { ETRADE_ENVIRONMENT: "sandbox", ET_BASE_URL: "https://evil.com/?x=apisb.etrade.com" },
    },
    { label: "APP_ENV TEST", env: { APP_ENV: "TEST" } },
    { label: "APP_ENV PROD (equals the file default)", env: { APP_ENV: "PROD" } },
    { label: "overrideEnv TEST", env: {}, overrideEnv: "TEST" },
    { label: "overrideEnv beats a live env", env: { ETRADE_ENVIRONMENT: "live" }, overrideEnv: "TEST" },
    {
      label: "service identity + agent-schedule gating + paypal env",
      env: {
        ETRADE_ENVIRONMENT: "sandbox",
        SERVICE_USER_LOGIN: "svc-1",
        AGENT_SCHEDULE_BUDGET_THRESHOLD_CENTS: "250",
        AGENT_SCHEDULE_MIN_INTERVAL_SECONDS: "60",
        PAYPAL_ENVIRONMENT: "sandbox",
      } as Partial<Env>,
    },
    {
      label: "blank/invalid service + schedule values stay undefined",
      env: {
        SERVICE_USER_LOGIN: "  ",
        AGENT_SCHEDULE_BUDGET_THRESHOLD_CENTS: "-5",
        AGENT_SCHEDULE_MIN_INTERVAL_SECONDS: "abc",
      } as Partial<Env>,
    },
    {
      label: "request overrides do not touch the core",
      env: {},
      overrideEnv: "TEST",
      input: { tenantId: "tenant-x", principalId: "user-x" },
    },
  ];

  for (const { label, env, overrideEnv, input } of cases) {
    it(`core deep-equals the old resolver: ${label}`, () => {
      const expected = resolveEnvironmentConfig(env, overrideEnv);
      const actual = resolveUniversalContext(env, { overrideEnv, ...input });
      expect(coreOf(actual)).toEqual(expected);
    });
  }

  it("no setting changes value between TEST and PROD", () => {
    for (const name of ["TEST", "PROD"] as const) {
      const old = resolveEnvironmentConfig({}, name);
      const next = resolveUniversalContext({}, { overrideEnv: name });
      expect(next.name).toBe(old.name);
      expect(next.label).toBe(old.label);
      expect(next.isLive).toBe(old.isLive);
      expect(next.etrade).toEqual(old.etrade);
      expect(next.payments).toEqual(old.payments);
    }
  });
});

describe("resolveUniversalContext — dimensions (#6540)", () => {
  it("platform: PLATFORM_ID when set, else the cfagent default", () => {
    expect(resolveUniversalContext({}).platform).toEqual({ id: "cfagent", source: "builtin" });
    expect(resolveUniversalContext({}).platform.id).toBe(DEFAULT_PLATFORM_ID);
    expect(resolveUniversalContext({ PLATFORM_ID: "acme" }).platform).toEqual({
      id: "acme",
      source: "env",
    });
    expect(resolveUniversalContext({ PLATFORM_ID: "  " }).platform).toEqual({
      id: "cfagent",
      source: "builtin",
    });
  });

  it("platform: value equals resolvePlatformId for the same input (reuse pin)", () => {
    for (const env of [{}, { PLATFORM_ID: "acme" }, { PLATFORM_ID: "  " }] as Array<Partial<Env>>) {
      expect(resolveUniversalContext(env).platform.id).toBe(resolvePlatformId(env.PLATFORM_ID));
    }
  });

  it("tenant: IAAA_TENANT_ID when set, else the deployment default", () => {
    const ctx = resolveUniversalContext({});
    expect(ctx.tenant.id).toBe(resolveIaaaTenant({}));
    expect(ctx.tenant).toEqual({ id: "primary", source: "builtin" });
    expect(resolveUniversalContext({ IAAA_TENANT_ID: "tenant-a" }).tenant).toEqual({
      id: "tenant-a",
      source: "env",
    });
    expect(resolveUniversalContext({ IAAA_TENANT_ID: "  " }).tenant).toEqual({
      id: "primary",
      source: "builtin",
    });
  });

  it("tenant: value equals resolveIaaaTenant for the same input (reuse pin)", () => {
    for (const env of [{}, { IAAA_TENANT_ID: "tenant-a" }] as Array<Partial<Env>>) {
      expect(resolveUniversalContext(env).tenant.id).toBe(resolveIaaaTenant(env));
    }
  });

  it("tenant: per-request override wins over the env tenant (run level)", () => {
    const ctx = resolveUniversalContext({ IAAA_TENANT_ID: "tenant-a" }, { tenantId: "tenant-b" });
    expect(ctx.tenant).toEqual({ id: "tenant-b", source: "run" });
    // A blank override does not win — the env tenant stands.
    expect(
      resolveUniversalContext({ IAAA_TENANT_ID: "tenant-a" }, { tenantId: "  " }).tenant,
    ).toEqual({ id: "tenant-a", source: "env" });
  });

  it("user: no principal carried when the request supplies none", () => {
    expect(resolveUniversalContext({}).user).toEqual({ principalId: undefined, source: "builtin" });
  });

  it("user: explicit override wins over the composed identity context", () => {
    const identity = { principalId: "user-2" } as unknown as ExecutionContext;
    expect(
      resolveUniversalContext({}, { executionContext: identity }).user,
    ).toEqual({ principalId: "user-2", source: "run" });
    expect(
      resolveUniversalContext({}, { executionContext: identity, principalId: "user-1" }).user,
    ).toEqual({ principalId: "user-1", source: "run" });
  });

  it("executionContext is carried by reference, and absent when not composed", () => {
    const identity = { principalId: "user-2" } as unknown as ExecutionContext;
    const ctx = resolveUniversalContext({}, { executionContext: identity });
    expect(ctx.executionContext).toBe(identity);
    expect("executionContext" in resolveUniversalContext({})).toBe(false);
  });

  it("no identity unification: the identity tenant never becomes the config tenant", () => {
    const identity = {
      tenantId: "other-tenant",
      principalId: "user-9",
    } as unknown as ExecutionContext;
    const ctx = resolveUniversalContext({}, { executionContext: identity });
    expect(ctx.user.principalId).toBe("user-9");
    expect(ctx.tenant.id).toBe("primary");
    expect(ctx.tenant.source).toBe("builtin");
  });
});

describe("resolveUniversalContext — per-setting sources (#6540)", () => {
  it("defaults: file for the file-backed settings, builtin for the absent ones", () => {
    expect(resolveUniversalContext({}).sources).toEqual({
      environmentName: "file",
      brokerBaseUrl: "file",
      brokerApiKey: "builtin",
      brokerApiSecret: "builtin",
      paymentsMode: "file",
      paypalEnvironment: "file",
      serviceUserLogin: "builtin",
      agentScheduleBudgetCentsThreshold: "builtin",
      agentScheduleMinIntervalSeconds: "builtin",
      platformId: "builtin",
      tenantId: "builtin",
      principalId: "builtin",
    });
  });

  it("overrideEnv reports run, and the derived payments settings follow it", () => {
    const { sources } = resolveUniversalContext({}, { overrideEnv: "TEST" });
    expect(sources.environmentName).toBe("run");
    expect(sources.paymentsMode).toBe("run");
    expect(sources.paypalEnvironment).toBe("run");
    expect(sources.brokerBaseUrl).toBe("file");
  });

  it("env bindings report env for the settings they decide", () => {
    const { sources } = resolveUniversalContext({
      ETRADE_ENVIRONMENT: "sandbox",
      ET_BASE_URL: "https://apisb.etrade.com",
      ET_API_KEY: "k1",
      ET_API_SECRET: "s1",
      SERVICE_USER_LOGIN: "svc-1",
      AGENT_SCHEDULE_BUDGET_THRESHOLD_CENTS: "250",
      AGENT_SCHEDULE_MIN_INTERVAL_SECONDS: "60",
      PAYPAL_ENVIRONMENT: "sandbox",
    } as Partial<Env>);
    expect(sources).toMatchObject({
      environmentName: "env",
      brokerBaseUrl: "env",
      brokerApiKey: "env",
      brokerApiSecret: "env",
      serviceUserLogin: "env",
      agentScheduleBudgetCentsThreshold: "env",
      agentScheduleMinIntervalSeconds: "env",
      paypalEnvironment: "env",
    });
  });

  it("a rejected env base URL leaves the file source (host gating, #845/#846)", () => {
    const { sources } = resolveUniversalContext({
      ETRADE_ENVIRONMENT: "sandbox",
      ET_BASE_URL: "https://evil.com/?x=apisb.etrade.com",
    });
    expect(sources.brokerBaseUrl).toBe("file");
    expect(sources.environmentName).toBe("env");
  });

  it("a live-host env base URL in PROD reports env", () => {
    const { sources } = resolveUniversalContext({
      ETRADE_ENVIRONMENT: "live",
      ET_BASE_URL: "https://api.etrade.com",
    });
    expect(sources.brokerBaseUrl).toBe("env");
  });

  it("process.env APP_ENV does not beat the file default (candidate order)", () => {
    // The file default is consulted before process.env in the code's
    // candidate order, so while environment.config.json sets an
    // environment, a process.env APP_ENV can never win the name — the
    // old 3-level comment's "process.env is level 2" was wrong about
    // this too. Pinned as actual behavior, not as a design goal.
    process.env.APP_ENV = "TEST";
    const ctx = resolveUniversalContext({});
    expect(ctx.name).toBe("PROD");
    expect(ctx.sources.environmentName).toBe("file");
  });

  it("process.env ET_BASE_URL reports env when honored", () => {
    process.env.ET_BASE_URL = "https://apisb.etrade.com";
    const ctx = resolveUniversalContext({ ETRADE_ENVIRONMENT: "sandbox" });
    expect(ctx.etrade.baseUrl).toBe("https://apisb.etrade.com/v1");
    expect(ctx.sources.brokerBaseUrl).toBe("env");
  });

  it("an env name that equals the file default reports file", () => {
    // APP_ENV=PROD carries the same value the file already has, so the
    // file level is what the code's candidate order reports (see the
    // cascade comment on resolveEnvironmentConfig).
    expect(resolveUniversalContext({ APP_ENV: "PROD" }).sources.environmentName).toBe("file");
    expect(resolveUniversalContext({ APP_ENV: "PROD" }).name).toBe("PROD");
  });
});
