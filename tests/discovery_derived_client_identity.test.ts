import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Issue #672: record every ETradeService construction so the test can
// observe the identity/environment the profile-derived branch builds
// its E*TRADE client with. The bare construction (env only) silently
// resolves tokens for "default_trader" in the default environment.
const ctorCalls = vi.hoisted(() => [] as any[][]);

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

vi.mock("../src/services/etrade", async (importActual) => {
  const actual: any = await importActual();
  class RecordingETradeService extends actual.ETradeService {
    constructor(...args: any[]) {
      ctorCalls.push(args);
      super(...args);
    }
  }
  return { ...actual, ETradeService: RecordingETradeService };
});

import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import {
  InMemoryDiscoveryRunStore,
} from "../src/trading/options/discoveryRunStore";
import {
  InMemoryStrategyProfileStore,
} from "../src/trading/options/strategyProfileStore";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import type { Env, ETradeOptionChain } from "../src/types";

const USER = "derived_trader";
const RUN_OWNER = "run_owner";

const SCRUBBED_ENV_KEYS = [
  "ET_API_KEY",
  "ET_API_SECRET",
  "ET_BASE_URL",
  "ET_PROD_API_KEY",
  "ET_PROD_API_SECRET",
  "PROD_ET_API_KEY",
  "PROD_ET_API_SECRET",
];

const NVDA_CHAIN: ETradeOptionChain = {
  symbol: "NVDA",
  underlyingPrice: 130,
  quoteTime: Date.now(),
  selectedExpiry: { year: 2027, month: 6, day: 18 },
  pairs: [
    {
      call: {
        symbol: "NVDA",
        optionType: "CALL",
        strikePrice: 130,
        bid: 5.5,
        ask: 5.8,
        volume: 800,
        openInterest: 2000,
        impliedVolatility: 0.45,
        delta: 0.52,
        gamma: 0.04,
        theta: -0.05,
        vega: 0.12,
        rho: 0.02,
      },
      put: {
        symbol: "NVDA",
        optionType: "PUT",
        strikePrice: 130,
        bid: 5.4,
        ask: 5.7,
        volume: 600,
        openInterest: 1800,
        impliedVolatility: 0.45,
        delta: -0.48,
        gamma: 0.04,
        theta: -0.05,
        vega: 0.12,
        rho: -0.02,
      },
    },
    {
      call: {
        symbol: "NVDA",
        optionType: "CALL",
        strikePrice: 140,
        bid: 2.5,
        ask: 2.8,
        volume: 1200,
        openInterest: 3500,
        impliedVolatility: 0.42,
        delta: 0.35,
        gamma: 0.03,
        theta: -0.04,
        vega: 0.10,
        rho: 0.01,
      },
    },
  ],
} as ETradeOptionChain;

function makeEnv(): Env {
  return {
    ETRADE_ENVIRONMENT: "sandbox",
    ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
    ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
    ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
  } as unknown as Env;
}

function makeOrm() {
  return {
    trades: {},
    events: { create: vi.fn() },
    messages: { create: vi.fn() },
    watchlists: { findMany: vi.fn(() => []) },
  } as any;
}

const FULL_PROFILE_SPEC = {
  thesis: "bullish" as const,
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  minDte: 1,
  maxDte: 365,
  allowedStrategies: ["long_call", "long_put"] as any,
};

let savedProcessEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedProcessEnv = {};
  for (const k of SCRUBBED_ENV_KEYS) {
    savedProcessEnv[k] = process.env[k];
    delete process.env[k];
  }
  __resetTokenCache();
  DynamicOptionsScreener.setTestChainsFixture({ NVDA: NVDA_CHAIN });
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("network disabled in tests");
  }));
  ctorCalls.length = 0;
});

afterEach(() => {
  for (const k of SCRUBBED_ENV_KEYS) {
    if (savedProcessEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedProcessEnv[k];
  }
  vi.unstubAllGlobals();
});

describe("profile-derived discovery client identity (#672)", () => {
  it("constructs the E*TRADE client with the service ORM, the run owner's login and the run's environment", async () => {
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-identity" });
    const profileStore = new InMemoryStrategyProfileStore({
      idFactory: () => "prof-identity",
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });
    const profile = await profileStore.create(RUN_OWNER, "Income", FULL_PROFILE_SPEC as any);
    const orm = makeOrm();
    const service = new ScheduledTasksService(makeEnv(), orm, USER, undefined, undefined, runStore, profileStore);

    const result = await service.autonomousStrategyDiscovery({
      inputModel: "profile-derived",
      symbols: ["NVDA"],
      profileId: profile.id,
      trigger: "scheduled",
      scheduleId: "sched-identity",
      userLogin: RUN_OWNER,
      environment: "TEST",
    });

    expect(result.success).toBe(true);
    expect(ctorCalls).toHaveLength(1);
    const [ormArg, , loginArg, environmentArg] = ctorCalls[0];
    expect(ormArg).toBe(orm);
    expect(loginArg).toBe(RUN_OWNER);
    expect(environmentArg).toBe("TEST");
  });
});
