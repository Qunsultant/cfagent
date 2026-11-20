import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The orchestrator extends AIChatAgent from @cloudflare/ai-chat, whose
// real module graph pulls in `cloudflare:` protocol imports the node
// test loader cannot resolve. Mock it with a plain base class (the
// same pattern as tests/scheduled_discovery_profile_derived.test.ts).
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

// Issue #672: capture every ETradeService construction. A full fake
// (the tests/agentic_payments_identity_binding.test.ts pattern from
// #183 — an importOriginal wrapper trips this repo's transform cache
// in the node loader). The fake's client mirrors ETradeRestClient's
// own constructor defaults (src/trading/etrade/client.ts: userLogin
// "default_trader" when none is passed, overrideEnv passed through),
// so a bare `new ETradeService(env)` is captured carrying exactly the
// wrong identity it would carry in production. The pipeline only
// touches etrade.client (fixture chains short-circuit any client
// call) and etrade.getLastError(), both provided here.
const etradeCapture = vi.hoisted(() => ({
  constructions: [] as Array<{
    args: unknown[];
    clientUserLogin: unknown;
    clientOverrideEnv: unknown;
  }>,
}));
vi.mock("../src/services/etrade", () => ({
  ETradeService: class FakeETradeService {
    client: { userLogin: string; overrideEnv?: string };
    constructor(...args: any[]) {
      // Issue #1185: mirror the production constructor — an explicit
      // userLogin is required; there is no default identity.
      const userLogin = args[2] as string | undefined;
      if (!userLogin) {
        throw new Error("ETradeService requires an explicit userLogin (issue #1185: no default identity).");
      }
      this.client = {
        userLogin,
        overrideEnv: args[3] as string | undefined,
      };
      etradeCapture.constructions.push({
        args,
        clientUserLogin: this.client.userLogin,
        clientOverrideEnv: this.client.overrideEnv,
      });
    }
    getLastError() {
      return null;
    }
  },
}));

import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { InMemoryDiscoveryRunStore } from "../src/trading/options/discoveryRunStore";
import { InMemoryStrategyProfileStore } from "../src/trading/options/strategyProfileStore";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import type { Env, ETradeOptionChain } from "../src/types";

/**
 * Issue #672 — the profile-derived branch of scheduled discovery
 * built its E*TRADE client BARE (`new ETradeService(this.env)`):
 * no ORM, and the constructor's defaults silently substituted
 * userLogin "default_trader" and NO environment override, while the
 * saved-request, no-view and IV-collector siblings in the same file
 * all construct `new ETradeService(orm, env, userLogin, environment)`
 * under the schedule owner's identity (#447/#461 class). Derivation
 * snapshots and the derived runs therefore fetched under the wrong
 * identity/environment whenever they fetched at all.
 *
 * The pre-existing #533 suites cannot see this: they serve chains
 * from DynamicOptionsScreener's test fixture, which bypasses the
 * client entirely. These tests pin the construction itself — the
 * exact seam the #183 identity-binding suite used — so a regression
 * to the bare form fails here even though every fixture-driven
 * outcome stays green.
 */

// ---------------------------------------------------------------------
// Hermeticity (the #168/#244 lesson, same as the #533 test file).
// ---------------------------------------------------------------------
const SCRUBBED_ENV_KEYS = [
  "ET_API_KEY",
  "ET_API_SECRET",
  "ET_BASE_URL",
  "ET_PROD_API_KEY",
  "ET_PROD_API_SECRET",
  "PROD_ET_API_KEY",
  "PROD_ET_API_SECRET",
] as const;
let savedProcessEnv: Record<string, string | undefined> = {};

const USER = "derived_trader";

// Same date rule as the #533 fixture: the chain expiry must stay in the
// future relative to the real clock — evaluateContracts drops chains
// whose selectedExpiry is past, so a hardcoded expiry silently empties
// the discovery run once the date passes. 30 days out is inside the
// profile DTE window used here.
const FIXTURE_EXPIRY_DATE = new Date(Date.now() + 30 * 86_400_000);
const FIXTURE_EXPIRY = {
  year: FIXTURE_EXPIRY_DATE.getUTCFullYear(),
  month: FIXTURE_EXPIRY_DATE.getUTCMonth() + 1,
  day: FIXTURE_EXPIRY_DATE.getUTCDate(),
};

const NVDA_CHAIN: ETradeOptionChain = {
  symbol: "NVDA",
  underlyingPrice: 130,
  quoteTime: Date.now(),
  selectedExpiry: FIXTURE_EXPIRY,
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

async function makeProfileStore() {
  const store = new InMemoryStrategyProfileStore({
    idFactory: () => "prof-672",
    now: () => new Date("2026-10-01T00:00:00.000Z"),
  });
  const created = await store.create(USER, "Income", FULL_PROFILE_SPEC as any);
  return { store, profile: created };
}

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
});

afterEach(() => {
  for (const k of SCRUBBED_ENV_KEYS) {
    if (savedProcessEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedProcessEnv[k];
  }
  vi.unstubAllGlobals();
});

describe("profile-derived discovery — E*TRADE client identity (#672)", () => {
  it("constructs the client with the owner's ORM, login and environment — never bare env", async () => {
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-672" });
    const { store: profileStore, profile: prof } = await makeProfileStore();
    const orm = makeOrm();
    const env = makeEnv();
    const service = new ScheduledTasksService(
      env,
      orm,
      USER,
      undefined,
      undefined,
      runStore,
      profileStore
    );

    const before = etradeCapture.constructions.length;
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "profile-derived",
      symbols: ["NVDA"],
      profileId: prof.id,
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
    });

    // The fire itself still derives + completes through the real
    // service/pipeline — only the E*TRADE service is the fake.
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("completed");

    const made = etradeCapture.constructions.slice(before);
    expect(made).toHaveLength(1);
    const [construction] = made;
    // The sibling construction, verbatim: (orm, env, userLogin, environment).
    expect(construction.args).toHaveLength(4);
    expect(construction.args[0]).toBe(orm);
    expect(construction.args[1]).toBe(env);
    expect(construction.args[2]).toBe(USER);
    expect(construction.args[3]).toBe("TEST");
    // And the identity actually landed on the client the pipeline
    // uses — the bare form put "default_trader" + no override here.
    expect(construction.clientUserLogin).toBe(USER);
    expect(construction.clientOverrideEnv).toBe("TEST");
  });

  it("threads the service's own login when the payload carries none, and passes an absent environment through", async () => {
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-672-b" });
    const { store: profileStore, profile: prof } = await makeProfileStore();
    const orm = makeOrm();
    const env = makeEnv();
    const service = new ScheduledTasksService(
      env,
      orm,
      USER,
      undefined,
      undefined,
      runStore,
      profileStore
    );

    const before = etradeCapture.constructions.length;
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "profile-derived",
      symbols: ["NVDA"],
      profileId: prof.id,
      trigger: "scheduled",
      // no userLogin, no environment — the resolved identity is the
      // service's own, exactly as the sibling paths resolve it.
    });

    expect(result.success).toBe(true);
    const made = etradeCapture.constructions.slice(before);
    expect(made).toHaveLength(1);
    const [construction] = made;
    expect(construction.args).toHaveLength(4);
    expect(construction.args[0]).toBe(orm);
    expect(construction.args[2]).toBe(USER);
    expect(construction.args[3]).toBeUndefined();
    expect(construction.clientUserLogin).toBe(USER);
    expect(construction.clientOverrideEnv).toBeUndefined();
  });
});
