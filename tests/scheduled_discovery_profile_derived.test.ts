import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

// The orchestrator extends AIChatAgent from @cloudflare/ai-chat, whose
// real module graph pulls in `cloudflare:` protocol imports the node
// test loader cannot resolve. Mock it with a plain base class (the
// same pattern as tests/scheduled_strategy_discovery.test.ts).
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

// Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
// Agents SDK actors now — mock the SDK with a plain base class
// (the api_chat_route.test.ts idiom) so the real module graph's
// `cloudflare:` imports never reach the node loader.
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
import { OrchestratorAgent, CREATABLE_SCHEDULE_CALLBACKS } from "../src/agents/orchestrator";
import { handleSchedulesRoutes, type SchedulesRouteContext } from "../src/agents/routes/schedules";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import {
  estimateExpectedMove,
  estimateExpectedMovePct,
  type ExpectedMoveContract,
} from "../src/trading/options/opportunityScanner";
import { deriveDiscoveryRequest } from "../src/trading/options/discoveryDerivation";
import {
  InMemoryDiscoveryRunStore,
  SqlDiscoveryRunStore,
  type DiscoveryRunInput,
  type DiscoverySqlExecutor,
} from "../src/trading/options/discoveryRunStore";
import {
  InMemoryStrategyProfileStore,
  SqlStrategyProfileStore,
  type StrategyProfile,
} from "../src/trading/options/strategyProfileStore";
import type { OptionsDataSnapshot } from "../src/trading/options/optionsDataAgent";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import { MockSqlStorage } from "./mock-sql";
import { makeFakeSessionStore } from "./fake-session-store";
import type { Env, ETradeOptionChain } from "../src/types";
import type { StrategyRequest } from "../src/trading/options/strategyEngine";

/**
 * Issue #533 (PR-533A) — profile-derived scheduled discovery.
 *
 * The second input model for the discovery callback: a schedule arms
 * { symbols | watchlistName } + profileId; at fire time the service
 * resolves the profile, derives each symbol's target from its own
 * live chain (spot × (1 + k·EM), k from the resolved scanner config
 * for the profile's thesis, EM from the scanner's estimator over the
 * profile's DTE window), constructs the StrategyRequest, and runs the
 * unchanged pipeline. Symbols whose inputs cannot be derived honestly
 * ABSTAIN with the reason recorded — never a fabricated target, and
 * the scanner's legacy targetFactors fallback is never consulted.
 *
 * These tests pin: the EM estimator seam (R6), the pure derivation
 * builder (R5), the run-record extensions (R7), the service's
 * pre-execution failures + status matrix (R3/R4/R8), and the routes
 * (R2 arm-time validation, R9 trigger passthrough).
 */

// ---------------------------------------------------------------------
// Hermeticity (the #168/#244 lesson, same as the PR-E test file).
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
const OTHER_USER = "other_trader";

const NVDA_CHAIN: ETradeOptionChain = {
  symbol: "NVDA",
  underlyingPrice: 130,
  quoteTime: Date.now(),
  selectedExpiry: { year: 2026, month: 11, day: 20 },
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

function makeOrm(watchlistRows: Array<Record<string, unknown>> = []) {
  return {
    trades: {},
    events: { create: vi.fn() },
    messages: { create: vi.fn() },
    watchlists: {
      findMany: vi.fn((args: any = {}) =>
        watchlistRows.filter((r) => !args?.where?.userLogin || r.userLogin === args.where.userLogin)
      ),
    },
  } as any;
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

// ---------------------------------------------------------------------
// R6 — the EM estimator seam
// ---------------------------------------------------------------------
const EM_NOW = new Date("2026-10-20T00:00:00.000Z");

function emContract(overrides: Partial<ExpectedMoveContract> = {}): ExpectedMoveContract {
  return {
    symbol: "NVDA-C",
    strikePrice: 130,
    expirationDate: "2026-11-20",
    impliedVolatility: 0.45,
    ...overrides,
  };
}

describe("estimateExpectedMove (R6)", () => {
  it("carries the chosen contract's IV, expiry and window alongside the pct", () => {
    const est = estimateExpectedMove([emContract()], 130, EM_NOW);
    expect(est).not.toBeNull();
    expect(est!.atmIv).toBe(0.45);
    expect(est!.windowExpiry).toBe("2026-11-20");
    expect(est!.windowDays).toBe(31);
    expect(est!.pct).toBeCloseTo(0.45 * Math.sqrt(31 / 365), 12);
  });

  it("picks the most-ATM contract, not the highest IV", () => {
    const est = estimateExpectedMove(
      [
        emContract({ symbol: "FAR", strikePrice: 200, impliedVolatility: 0.9 }),
        emContract({ symbol: "NEAR", strikePrice: 131, impliedVolatility: 0.2 }),
      ],
      130,
      EM_NOW,
    );
    expect(est!.atmIv).toBe(0.2);
    expect(est!.windowExpiry).toBe("2026-11-20");
  });

  it("breaks distance ties by earliest expiry, then lowest strike, then symbol", () => {
    const byExpiry = estimateExpectedMove(
      [
        emContract({ symbol: "LATE", expirationDate: "2026-12-18", impliedVolatility: 0.5 }),
        emContract({ symbol: "EARLY", expirationDate: "2026-11-20", impliedVolatility: 0.4 }),
      ],
      130,
      EM_NOW,
    );
    expect(byExpiry!.atmIv).toBe(0.4);
    expect(byExpiry!.windowExpiry).toBe("2026-11-20");

    const byStrike = estimateExpectedMove(
      [
        emContract({ symbol: "HIGH", strikePrice: 110, impliedVolatility: 0.9 }),
        emContract({ symbol: "LOW", strikePrice: 90, impliedVolatility: 0.3 }),
      ],
      100,
      EM_NOW,
    );
    expect(byStrike!.atmIv).toBe(0.3);

    const bySymbol = estimateExpectedMove(
      [
        emContract({ symbol: "B", impliedVolatility: 0.7 }),
        emContract({ symbol: "A", impliedVolatility: 0.2 }),
      ],
      130,
      EM_NOW,
    );
    expect(bySymbol!.atmIv).toBe(0.2);
  });

  it.each([
    ["no contracts", []],
    ["no usable IV (zero)", [emContract({ impliedVolatility: 0 })]],
    ["no usable IV (absent)", [emContract({ impliedVolatility: undefined as any })]],
    ["expiry today", [emContract({ expirationDate: "2026-10-20" })]],
    ["expiry in the past", [emContract({ expirationDate: "2026-10-01" })]],
    ["unparseable expiry", [emContract({ expirationDate: "not-a-date" })]],
  ])("returns null when %s", (_label, contracts) => {
    expect(estimateExpectedMove(contracts as ExpectedMoveContract[], 130, EM_NOW)).toBeNull();
    expect(estimateExpectedMovePct(contracts as ExpectedMoveContract[], 130, EM_NOW)).toBeNull();
  });

  it("returns null for a non-positive or non-finite spot", () => {
    expect(estimateExpectedMove([emContract()], 0, EM_NOW)).toBeNull();
    expect(estimateExpectedMove([emContract()], -5, EM_NOW)).toBeNull();
    expect(estimateExpectedMove([emContract()], NaN, EM_NOW)).toBeNull();
  });

  it("estimateExpectedMovePct stays bit-identical to the estimate's pct", () => {
    const chain = [
      emContract({ symbol: "X1", strikePrice: 128, impliedVolatility: 0.5, expirationDate: "2026-12-18" }),
      emContract({ symbol: "X2", strikePrice: 130, impliedVolatility: 0.45, expirationDate: "2026-11-20" }),
      emContract({ symbol: "X3", strikePrice: 145, impliedVolatility: 0.3, expirationDate: "2026-11-20" }),
    ];
    expect(estimateExpectedMovePct(chain, 130, EM_NOW)).toBe(estimateExpectedMove(chain, 130, EM_NOW)!.pct);
  });
});

// ---------------------------------------------------------------------
// R5 — the pure derivation builder
// ---------------------------------------------------------------------
const MULTIPLES = { bullish: 0.6, bearish: -0.6, large_move: 1.2, range_bound: 0 } as const;

function profile(overrides: Partial<StrategyProfile> = {}): StrategyProfile {
  return {
    id: "prof-1",
    userLogin: USER,
    name: "Income",
    version: 3,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    thesis: "bullish",
    maxPlannedLoss: 500,
    minRewardRisk: 1,
    ...overrides,
  };
}

function chainContract(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "NVDA-C-130",
    optionType: "CALL",
    strikePrice: 130,
    expirationDate: "2026-11-20",
    impliedVolatility: 0.45,
    underlyingPrice: 130,
    bid: 5.5,
    ask: 5.8,
    ...overrides,
  } as any;
}

function snapshot(contracts: any[], overrides: Partial<OptionsDataSnapshot> = {}): OptionsDataSnapshot {
  return {
    symbol: "NVDA",
    contracts,
    dataSource: "live",
    screen: { underlyingsScanned: 1, contractsEvaluated: contracts.length, contractsMatched: contracts.length },
    rejections: [],
    ...overrides,
  };
}

describe("deriveDiscoveryRequest (R5)", () => {
  const now = EM_NOW;
  const pct = 0.45 * Math.sqrt(31 / 365);

  it("derives the bullish target as spot x (1 + 0.6 x EM), 2dp, with the full derivation record", () => {
    const out = deriveDiscoveryRequest({ symbol: "NVDA", snapshot: snapshot([chainContract()]), profile: profile(), emMultiples: MULTIPLES, now });
    expect(out.derived).toBe(true);
    if (!out.derived) throw new Error("expected derived");
    expect(out.derivation).toEqual({
      source: "profile-derived",
      spot: 130,
      spotSource: "chain",
      atmIv: 0.45,
      expectedMovePct: pct,
      windowExpiry: "2026-11-20",
      windowDays: 31,
      emMultiple: 0.6,
      thesis: "bullish",
      targetPrice: 140.23,
      profileRef: { id: "prof-1", name: "Income", version: 3 },
    });
    expect(out.request.targetPrice).toBe(140.23);
    expect(out.request.targetDate).toBe("2026-11-20");
  });

  it.each([
    ["bearish", -0.6, 119.77],
    ["large_move", 1.2, 150.46],
    ["range_bound", 0, 130],
  ] as const)("derives the %s target from the thesis multiple", (thesis, _k, expected) => {
    const out = deriveDiscoveryRequest({
      symbol: "NVDA",
      snapshot: snapshot([chainContract()]),
      profile: profile({ thesis }),
      emMultiples: MULTIPLES,
      now,
    });
    expect(out.derived).toBe(true);
    if (!out.derived) throw new Error("expected derived");
    expect(out.request.targetPrice).toBe(expected);
    expect(out.derivation.emMultiple).toBe(MULTIPLES[thesis]);
  });

  it("reads the multiple from the supplied resolved config, not a literal", () => {
    const out = deriveDiscoveryRequest({
      symbol: "NVDA",
      snapshot: snapshot([chainContract()]),
      profile: profile(),
      emMultiples: { ...MULTIPLES, bullish: 1 },
      now,
    });
    expect(out.derived).toBe(true);
    if (!out.derived) throw new Error("expected derived");
    expect(out.derivation.emMultiple).toBe(1);
    expect(out.request.targetPrice).toBe(Number((130 * (1 + pct)).toFixed(2)));
  });

  it("assembles the StrategyRequest from the profile exactly (defaults: IV unchanged, strategies [\"all\"])", () => {
    const out = deriveDiscoveryRequest({ symbol: "NVDA", snapshot: snapshot([chainContract()]), profile: profile(), emMultiples: MULTIPLES, now });
    expect(out.derived).toBe(true);
    if (!out.derived) throw new Error("expected derived");
    expect(out.request).toEqual({
      symbol: "NVDA",
      thesis: "bullish",
      targetPrice: 140.23,
      targetDate: "2026-11-20",
      expectedIvDirection: "unchanged",
      maxPlannedLoss: 500,
      minRewardRisk: 1,
      allowedStrategies: ["all"],
    });
  });

  it("passes through the profile's optional request fields when set", () => {
    const out = deriveDiscoveryRequest({
      symbol: "NVDA",
      snapshot: snapshot([chainContract()]),
      profile: profile({
        expectedIvDirection: "fall",
        allowedStrategies: ["long_call", "long_put"],
        optimizationBias: 25,
        minDte: 7,
        maxDte: 60,
        eventPolicy: "exclude",
      }),
      emMultiples: MULTIPLES,
      now,
    });
    expect(out.derived).toBe(true);
    if (!out.derived) throw new Error("expected derived");
    expect(out.request).toMatchObject({
      expectedIvDirection: "fall",
      allowedStrategies: ["long_call", "long_put"],
      optimizationBias: 25,
      minDte: 7,
      maxDte: 60,
      eventPolicy: "exclude",
    });
  });

  it("abstains on a snapshot validation error, with that text as the reason", () => {
    const out = deriveDiscoveryRequest({
      symbol: "NVDA",
      snapshot: snapshot([], { validationError: "chain unavailable: session expired" }),
      profile: profile(),
      emMultiples: MULTIPLES,
      now,
    });
    expect(out).toEqual({ derived: false, reason: "chain unavailable: session expired" });
  });

  it("abstains on an empty chain with recorded fetch errors, naming them", () => {
    const out = deriveDiscoveryRequest({
      symbol: "NVDA",
      snapshot: snapshot([], {
        screen: {
          underlyingsScanned: 1,
          contractsEvaluated: 0,
          contractsMatched: 0,
          fetchErrors: [{ symbol: "NVDA", reason: "oauth_problem=session_revoked" } as any],
        },
      }),
      profile: profile(),
      emMultiples: MULTIPLES,
      now,
    });
    expect(out.derived).toBe(false);
    if (out.derived) throw new Error("expected abstention");
    expect(out.reason).toContain("oauth_problem=session_revoked");
  });

  it("abstains when the chain carries no live quote (no positive underlying price)", () => {
    const out = deriveDiscoveryRequest({
      symbol: "NVDA",
      snapshot: snapshot([chainContract({ underlyingPrice: 0 })]),
      profile: profile(),
      emMultiples: MULTIPLES,
      now,
    });
    expect(out).toEqual({ derived: false, reason: "no live quote for NVDA" });
  });

  it("abstains when the chain has no usable IV", () => {
    const out = deriveDiscoveryRequest({
      symbol: "NVDA",
      snapshot: snapshot([chainContract({ impliedVolatility: 0 })]),
      profile: profile(),
      emMultiples: MULTIPLES,
      now,
    });
    expect(out).toEqual({
      derived: false,
      reason: "no usable IV in the live chain for NVDA — no expected move can be derived",
    });
  });

  it("abstains every symbol when the profile carries no thesis (D1)", () => {
    const out = deriveDiscoveryRequest({
      symbol: "NVDA",
      snapshot: snapshot([chainContract()]),
      profile: profile({ thesis: undefined }),
      emMultiples: MULTIPLES,
      now,
    });
    expect(out).toEqual({ derived: false, reason: "profile carries no thesis" });
  });

  it("abstains when the profile does not set the risk caps (D3), with the derivation shown", () => {
    for (const p of [profile({ maxPlannedLoss: undefined }), profile({ minRewardRisk: undefined })]) {
      const out = deriveDiscoveryRequest({
        symbol: "NVDA",
        snapshot: snapshot([chainContract()]),
        profile: p,
        emMultiples: MULTIPLES,
        now,
      });
      expect(out.derived).toBe(false);
      if (out.derived) throw new Error("expected abstention");
      expect(out.reason).toBe("profile does not set maxPlannedLoss/minRewardRisk");
      expect(out.derivation?.targetPrice).toBe(140.23);
    }
  });

  it("abstains when the derived target is not positive (extreme bearish EM)", () => {
    // IV 500% over a 365-day window: EM = 5.0, so the bearish target
    // is 10 x (1 - 0.6 x 5.0) = -20 — not a price.
    const out = deriveDiscoveryRequest({
      symbol: "NVDA",
      snapshot: snapshot([
        chainContract({ underlyingPrice: 10, strikePrice: 10, impliedVolatility: 5, expirationDate: "2027-10-20" }),
      ]),
      profile: profile({ thesis: "bearish" }),
      emMultiples: MULTIPLES,
      now,
    });
    expect(out.derived).toBe(false);
    if (out.derived) throw new Error("expected abstention");
    expect(out.reason).toBe("derived target is not positive");
  });

  it("abstains with the validation message when the constructed request is invalid — never patches it", () => {
    // Profile validation allows minDte 0; StrategyRequest validation
    // requires minDte >= 1. The conflict abstains (R5 step 7).
    const out = deriveDiscoveryRequest({
      symbol: "NVDA",
      snapshot: snapshot([chainContract()]),
      profile: profile({ minDte: 0, maxDte: 60 }),
      emMultiples: MULTIPLES,
      now,
    });
    expect(out.derived).toBe(false);
    if (out.derived) throw new Error("expected abstention");
    expect(out.reason).toContain("Invalid strategy request");
    expect(out.derivation?.targetPrice).toBe(140.23);
  });
});

// ---------------------------------------------------------------------
// R7 — run-record extensions in both stores
// ---------------------------------------------------------------------
function derivedRunInput(overrides: Partial<DiscoveryRunInput> = {}): DiscoveryRunInput {
  const request: StrategyRequest = {
    symbol: "NVDA",
    thesis: "bullish",
    targetPrice: 140.23,
    targetDate: "2026-11-20",
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 500,
    minRewardRisk: 1,
    allowedStrategies: ["all"],
  };
  return {
    createdAt: "2026-10-20T12:00:00.000Z",
    trigger: "scheduled",
    userLogin: USER,
    inputModel: "profile-derived",
    profileRef: { id: "prof-1", name: "Income", version: 3 },
    requests: [request],
    outcomes: [
      {
        symbol: "NVDA",
        status: "completed",
        request,
        ranked: [],
        derivation: {
          source: "profile-derived",
          spot: 130,
          spotSource: "chain",
          atmIv: 0.45,
          expectedMovePct: 0.1311,
          windowExpiry: "2026-11-20",
          windowDays: 31,
          emMultiple: 0.6,
          thesis: "bullish",
          targetPrice: 140.23,
          profileRef: { id: "prof-1", name: "Income", version: 3 },
        },
        snapshot: {
          dataSource: "live",
          screen: { underlyingsScanned: 1, contractsEvaluated: 3, contractsMatched: 3 },
        },
      },
      {
        symbol: "MSFT",
        status: "abstained",
        error: "no usable IV in the live chain for MSFT — no expected move can be derived",
      },
      {
        symbol: "AAPL",
        status: "failed",
        request: { ...request, symbol: "AAPL" },
        error: "chain fetch failed",
      },
    ],
    status: "partial",
    ...overrides,
  };
}

// Statement-exact fake SQL for the discovery store (mirrors the PR-E
// test file's FakeDiscoverySql) extended with the profile store's
// fixed statement set, so route tests can run both stores over one
// executor exactly as the DO does.
interface FakeDiscoveryRow {
  id: string;
  created_at: string;
  status: string;
  user_login: string | null;
  summary_json: string;
  run_json: string;
}
interface FakeProfileRow {
  id: string;
  user_login: string;
  name: string;
  version: number;
  spec_json: string;
  created_at: string;
  updated_at: string;
}

class FakeSql implements DiscoverySqlExecutor {
  discoveryRows: FakeDiscoveryRow[] = [];
  profileRows: FakeProfileRow[] = [];
  /**
   * Issue #4275: the real-SQLite fallback for statements outside the
   * two stores this fake emulates. The trigger route wires the ctx
   * sql handle as the firer's engineSql, so the engine's
   * job-pipeline tables live on the same handle — in prod, one DO
   * handle serves all stores, and this fallback mirrors that. A
   * mistyped discovery/profile statement still fails loudly (its
   * table does not exist in the fallback).
   */
  private readonly fallback = new DatabaseSync(":memory:");

  private sortedDiscovery(): FakeDiscoveryRow[] {
    return [...this.discoveryRows].sort((a, b) =>
      a.created_at !== b.created_at
        ? a.created_at < b.created_at
          ? 1
          : -1
        : a.id < b.id
          ? 1
          : a.id > b.id
            ? -1
            : 0,
    );
  }

  exec(query: string, ...params: unknown[]): Iterable<unknown> {
    const q = query.replace(/\s+/g, " ").trim();
    // DDL for the two emulated stores is swallowed (the fake needs
    // no tables); DDL for anything else runs on the fallback, so
    // the engine's tables actually exist when its DML arrives.
    if (
      (q.startsWith("CREATE TABLE") || q.startsWith("CREATE INDEX")) &&
      (q.includes("mas_discovery_runs") || q.includes("mas_strategy_profiles"))
    ) {
      return [];
    }
    // Discovery store statements.
    if (q.startsWith("INSERT INTO mas_discovery_runs")) {
      const [id, created_at, status, user_login, summary_json, run_json] = params as [
        string, string, string, string | null, string, string,
      ];
      if (!this.discoveryRows.some((r) => r.id === id)) {
        this.discoveryRows.push({ id, created_at, status, user_login, summary_json, run_json });
      }
      return [];
    }
    if (q.startsWith("SELECT summary_json, run_json FROM mas_discovery_runs WHERE id = ?")) {
      return this.discoveryRows
        .filter((r) => r.id === params[0])
        .map((r) => ({ summary_json: r.summary_json, run_json: r.run_json }));
    }
    if (q.startsWith("SELECT summary_json FROM mas_discovery_runs WHERE")) {
      const [scope, limit, offset] = params as [string | null, number, number];
      return this.sortedDiscovery()
        .filter((r) => r.user_login == null || (scope != null && r.user_login === scope))
        .slice(offset, offset + limit)
        .map((r) => ({ summary_json: r.summary_json }));
    }
    if (q.startsWith("SELECT COUNT(*)") && q.includes("mas_discovery_runs")) {
      return [{ count: this.discoveryRows.length }];
    }
    if (q.startsWith("DELETE FROM mas_discovery_runs WHERE created_at < ?")) {
      const cutoff = params[0] as string;
      this.discoveryRows = this.discoveryRows.filter((r) => !(r.created_at < cutoff));
      return [];
    }
    if (q.startsWith("DELETE FROM mas_discovery_runs WHERE id NOT IN")) {
      const keep = new Set(this.sortedDiscovery().slice(0, params[0] as number).map((r) => r.id));
      this.discoveryRows = this.discoveryRows.filter((r) => keep.has(r.id));
      return [];
    }
    // Strategy profile store statements.
    if (q.startsWith("INSERT INTO mas_strategy_profiles")) {
      const [id, user_login, name, version, spec_json, created_at, updated_at] = params as [
        string, string, string, number, string, string, string,
      ];
      this.profileRows.push({ id, user_login, name, version, spec_json, created_at, updated_at });
      return [];
    }
    if (q.startsWith("SELECT id, user_login, name, version, spec_json, created_at, updated_at FROM mas_strategy_profiles WHERE user_login = ? AND id = ?")) {
      return this.profileRows.filter((r) => r.user_login === params[0] && r.id === params[1]);
    }
    if (q.startsWith("SELECT id, user_login, name, version, spec_json, created_at, updated_at FROM mas_strategy_profiles WHERE user_login = ?")) {
      return this.profileRows.filter((r) => r.user_login === params[0]);
    }
    if (q.startsWith("UPDATE mas_strategy_profiles")) {
      const [name, version, spec_json, updated_at, user_login, id] = params as [
        string, number, string, string, string, string,
      ];
      const row = this.profileRows.find((r) => r.user_login === user_login && r.id === id);
      if (row) Object.assign(row, { name, version, spec_json, updated_at });
      return [];
    }
    if (q.startsWith("DELETE FROM mas_strategy_profiles")) {
      this.profileRows = this.profileRows.filter((r) => !(r.user_login === params[0] && r.id === params[1]));
      return [];
    }
    // Issue #4275: anything outside the two emulated stores runs on
    // real SQLite (the engine's job-pipeline tables, via the wired
    // engineSql handle).
    const stmt = this.fallback.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

describe("discovery run stores — profile-derived records (R7)", () => {
  it("round-trips a derived run in both stores: inputModel, profileRef, abstained outcome, counts", async () => {
    const idSequence = () => {
      let n = 0;
      return () => `derived-${++n}`;
    };
    const stores = [
      new SqlDiscoveryRunStore(new FakeSql(), { idFactory: idSequence() }),
      new InMemoryDiscoveryRunStore({ idFactory: idSequence() }),
    ];
    for (const store of stores) {
      const saved = await store.save(derivedRunInput());
      expect(saved.inputModel).toBe("profile-derived");
      expect(saved.profileRef).toEqual({ id: "prof-1", name: "Income", version: 3 });
      expect(saved.requestCount).toBe(1);
      expect(saved.completedCount).toBe(1);
      expect(saved.failedCount).toBe(1);
      expect((saved as any).abstainedCount).toBe(1);
      expect(saved.symbols).toEqual(["NVDA", "MSFT", "AAPL"]);

      const got = await store.get(saved.id, { userLogin: USER });
      expect(got).not.toBeNull();
      expect(got!.requests).toHaveLength(1);
      expect(got!.outcomes.map((o) => o.status)).toEqual(["completed", "abstained", "failed"]);
      const abstained = got!.outcomes[1];
      expect(abstained.symbol).toBe("MSFT");
      expect(abstained.request).toBeUndefined();
      expect(abstained.error).toContain("no usable IV");
      expect(got!.outcomes[0].derivation?.targetPrice).toBe(140.23);
      expect(got!.outcomes[0].derivation?.spotSource).toBe("chain");
    }
  });

  it("stamps saved-request runs from the input, with a zero abstained count", async () => {
    const store = new InMemoryDiscoveryRunStore({ idFactory: () => "saved-1" });
    const saved = await store.save({
      createdAt: "2026-10-20T12:00:00.000Z",
      trigger: "scheduled",
      userLogin: USER,
      inputModel: "saved-request",
      requests: [
        {
          symbol: "NVDA",
          thesis: "bullish",
          targetPrice: 200,
          targetDate: "2027-12-18",
          expectedIvDirection: "unchanged",
          maxPlannedLoss: 500,
          minRewardRisk: 1,
          allowedStrategies: ["long_call"],
        },
      ],
      outcomes: [
        {
          symbol: "NVDA",
          status: "completed",
          request: {
            symbol: "NVDA",
            thesis: "bullish",
            targetPrice: 200,
            targetDate: "2027-12-18",
            expectedIvDirection: "unchanged",
            maxPlannedLoss: 500,
            minRewardRisk: 1,
            allowedStrategies: ["long_call"],
          },
          ranked: [],
        },
      ],
      status: "completed",
    });
    expect(saved.inputModel).toBe("saved-request");
    expect(saved.profileRef).toBeUndefined();
    expect((saved as any).abstainedCount).toBe(0);
    expect(saved.failedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------
// R3/R4/R5/R8 — the service's profile-derived path
// ---------------------------------------------------------------------
const FULL_PROFILE_SPEC = {
  thesis: "bullish" as const,
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  minDte: 1,
  maxDte: 365,
  allowedStrategies: ["long_call", "long_put"] as any,
};

async function makeProfileStore(spec: Record<string, unknown>, name = "Income") {
  const store = new InMemoryStrategyProfileStore({
    idFactory: () => "prof-derived-1",
    now: () => new Date("2026-10-01T00:00:00.000Z"),
  });
  const created = await store.create(USER, name, spec as any);
  return { store, profile: created };
}

function derivedService(store: InMemoryDiscoveryRunStore, profileStore?: any, orm = makeOrm()) {
  return new ScheduledTasksService(makeEnv(), orm, USER, undefined, undefined, store, profileStore);
}

describe("ScheduledTasksService.autonomousStrategyDiscovery — profile-derived (#533)", () => {
  it("derives, runs and persists a completed profile-derived run with the full derivation", async () => {
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-derived" });
    const { store: profileStore, profile: prof } = await makeProfileStore(FULL_PROFILE_SPEC);
    const orm = makeOrm();
    const service = derivedService(runStore, profileStore, orm);
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "profile-derived",
      symbols: ["NVDA"],
      profileId: prof.id,
      trigger: "scheduled",
      scheduleId: "sched-derived-1",
      userLogin: USER,
      environment: "TEST",
    });

    expect(result.success).toBe(true);
    expect(result.data?.runId).toBe("run-derived");
    expect(result.data?.status).toBe("completed");
    expect(result.data?.completedCount).toBe(1);
    expect(result.data?.failedCount).toBe(0);
    expect((result.data as any)?.abstained).toEqual([]);

    const runs = await runStore.list({ userLogin: USER });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "run-derived",
      inputModel: "profile-derived",
      profileRef: { id: prof.id, name: "Income", version: 1 },
      scheduleId: "sched-derived-1",
      status: "completed",
      requestCount: 1,
      abstainedCount: 0,
      symbols: ["NVDA"],
    });

    const stored = await runStore.get("run-derived", { userLogin: USER });
    const outcome = stored!.outcomes[0];
    expect(outcome.status).toBe("completed");
    const derivation = outcome.derivation!;
    expect(derivation.source).toBe("profile-derived");
    expect(derivation.spot).toBe(130);
    expect(derivation.spotSource).toBe("chain");
    expect(derivation.atmIv).toBe(0.45);
    expect(derivation.windowExpiry).toBe("2026-11-20");
    expect(derivation.emMultiple).toBe(0.6);
    expect(derivation.thesis).toBe("bullish");
    // The window is counted from the run's own timestamp to the
    // chosen expiry; EM and target follow the pinned formula.
    const days = Math.ceil((Date.parse("2026-11-20T00:00:00.000Z") - Date.parse(stored!.createdAt)) / 86_400_000);
    expect(derivation.windowDays).toBe(days);
    const pct = 0.45 * Math.sqrt(days / 365);
    expect(derivation.expectedMovePct).toBeCloseTo(pct, 10);
    expect(derivation.targetPrice).toBe(Number((130 * (1 + 0.6 * pct)).toFixed(2)));

    // The constructed request is stored verbatim and matches the derivation.
    expect(stored!.requests).toHaveLength(1);
    expect(stored!.requests[0]).toMatchObject({
      symbol: "NVDA",
      thesis: "bullish",
      targetPrice: derivation.targetPrice,
      targetDate: "2026-11-20",
      expectedIvDirection: "unchanged",
      maxPlannedLoss: 500,
      minRewardRisk: 1,
      allowedStrategies: ["long_call", "long_put"],
      minDte: 1,
      maxDte: 365,
    });
    expect(outcome.request).toEqual(stored!.requests[0]);

    // Completion audit carries the model, the profile and abstentions.
    expect(orm.events.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "options.strategy_discovery_completed",
        payload: expect.objectContaining({
          inputModel: "profile-derived",
          profileRef: { id: prof.id, name: "Income", version: 1 },
          abstained: [],
        }),
      })
    );
  });

  it("records a symbol whose chain cannot be derived as an abstention in a partial run", async () => {
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-derived-partial" });
    const { store: profileStore, profile: prof } = await makeProfileStore(FULL_PROFILE_SPEC);
    const service = derivedService(runStore, profileStore);
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "profile-derived",
      symbols: ["NVDA", "MSFT"],
      profileId: prof.id,
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
    });

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("partial");
    expect(result.data?.completedCount).toBe(1);
    expect(result.data?.failedCount).toBe(0);
    const abstained = (result.data as any)?.abstained as Array<{ symbol: string; reason: string }>;
    expect(abstained).toHaveLength(1);
    expect(abstained[0].symbol).toBe("MSFT");
    expect(abstained[0].reason.length).toBeGreaterThan(0);

    const stored = await runStore.get("run-derived-partial", { userLogin: USER });
    expect(stored!.status).toBe("partial");
    expect(stored!.symbols).toEqual(["NVDA", "MSFT"]);
    expect(stored!.requestCount).toBe(1);
    expect((stored as any).abstainedCount).toBe(1);
    expect(stored!.outcomes.map((o) => [o.symbol, o.status])).toEqual([
      ["NVDA", "completed"],
      ["MSFT", "abstained"],
    ]);
    expect(stored!.outcomes[1].request).toBeUndefined();
    expect(stored!.outcomes[1].error).toBe(abstained[0].reason);
    // Only the constructed request is stored — the abstention invented none.
    expect(stored!.requests.map((r) => r.symbol)).toEqual(["NVDA"]);
  });

  it("an all-abstained fire persists a failed run and takes the failure path", async () => {
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-derived-failed" });
    const { store: profileStore, profile: prof } = await makeProfileStore(FULL_PROFILE_SPEC);
    const orm = makeOrm();
    const service = derivedService(runStore, profileStore, orm);
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "profile-derived",
      symbols: ["MSFT"],
      profileId: prof.id,
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
    });

    expect(result.success).toBe(false);
    expect(result.data?.runId).toBe("run-derived-failed");
    expect(result.data?.status).toBe("failed");
    expect((result.data as any)?.abstained).toHaveLength(1);

    const stored = await runStore.get("run-derived-failed", { userLogin: USER });
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("failed");
    expect(stored!.outcomes[0].status).toBe("abstained");
    expect(stored!.requests).toEqual([]);
    expect(orm.events.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "options.strategy_discovery_failed" })
    );
  });

  it("abstains every symbol when the profile carries no thesis (D1) — run persists as failed", async () => {
    const { thesis: _thesis, ...noThesis } = FULL_PROFILE_SPEC;
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-no-thesis" });
    const { store: profileStore, profile: prof } = await makeProfileStore(noThesis);
    const service = derivedService(runStore, profileStore);
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "profile-derived",
      symbols: ["NVDA"],
      profileId: prof.id,
      userLogin: USER,
      environment: "TEST",
    });
    expect(result.success).toBe(false);
    const stored = await runStore.get("run-no-thesis", { userLogin: USER });
    expect(stored!.outcomes[0].status).toBe("abstained");
    expect(stored!.outcomes[0].error).toBe("profile carries no thesis");
  });

  it("abstains with the D3 reason when the profile lacks the risk caps, showing the derivation", async () => {
    const { maxPlannedLoss: _cap, ...noCap } = FULL_PROFILE_SPEC;
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-no-cap" });
    const { store: profileStore, profile: prof } = await makeProfileStore(noCap);
    const service = derivedService(runStore, profileStore);
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "profile-derived",
      symbols: ["NVDA"],
      profileId: prof.id,
      userLogin: USER,
      environment: "TEST",
    });
    expect(result.success).toBe(false);
    const stored = await runStore.get("run-no-cap", { userLogin: USER });
    expect(stored!.outcomes[0].status).toBe("abstained");
    expect(stored!.outcomes[0].error).toBe("profile does not set maxPlannedLoss/minRewardRisk");
    expect(stored!.outcomes[0].derivation?.targetPrice).toBeGreaterThan(0);
    expect(stored!.requests).toEqual([]);
  });

  it.each([
    ["profile not found for the owner", { profileId: "prof-does-not-exist" }],
    ["profileId missing", { profileId: undefined }],
    ["an empty explicit symbol list", { symbols: [] as string[] }],
    ["both symbols and watchlistName", { symbols: ["NVDA"], watchlistName: "My List" }],
    ["a watchlist name that does not exist", { symbols: undefined, watchlistName: "Nope" }],
    [
      "more than 25 resolved symbols",
      { symbols: Array.from({ length: 26 }, (_, i) => `S${i + 1}`) },
    ],
  ])("pre-execution failure (%s) persists NOTHING", async (_label, patch: any) => {
    const runStore = new InMemoryDiscoveryRunStore();
    const { store: profileStore, profile: prof } = await makeProfileStore(FULL_PROFILE_SPEC);
    const service = derivedService(runStore, profileStore);
    const payload: any = {
      inputModel: "profile-derived",
      symbols: ["NVDA"],
      profileId: prof.id,
      userLogin: USER,
      environment: "TEST",
      ...patch,
    };
    if (patch.symbols === undefined && !("symbols" in patch)) delete payload.symbols;
    if (patch.symbols === undefined && "symbols" in patch) delete payload.symbols;
    const result = await service.autonomousStrategyDiscovery(payload);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(await runStore.list({ userLogin: USER })).toHaveLength(0);
  });

  it("fails honestly when constructed without a profile store, persisting nothing", async () => {
    const runStore = new InMemoryDiscoveryRunStore();
    const service = derivedService(runStore, undefined);
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "profile-derived",
      symbols: ["NVDA"],
      profileId: "prof-derived-1",
      userLogin: USER,
      environment: "TEST",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Strategy profile store not configured");
    expect(await runStore.list({ userLogin: USER })).toHaveLength(0);
  });

  it("resolves a watchlist name against the owner's stored watchlists at fire time (D4)", async () => {
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-watchlist" });
    const { store: profileStore, profile: prof } = await makeProfileStore(FULL_PROFILE_SPEC);
    const orm = makeOrm([
      { id: "wl-other", name: "My List", userLogin: OTHER_USER, symbolsJson: JSON.stringify(["MSFT"]) },
      { id: "wl-1", name: "My List", userLogin: USER, symbolsJson: JSON.stringify(["NVDA"]) },
    ]);
    const service = derivedService(runStore, profileStore, orm);
    const result = await service.autonomousStrategyDiscovery({
      inputModel: "profile-derived",
      watchlistName: "my list",
      profileId: prof.id,
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
    });
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("completed");
    expect(result.data?.symbols).toEqual(["NVDA"]);
    const stored = await runStore.get("run-watchlist", { userLogin: USER });
    expect(stored!.symbols).toEqual(["NVDA"]);
  });
});

// ---------------------------------------------------------------------
// R2 — create-route validation for the profile-derived payload
// ---------------------------------------------------------------------
describe("POST /api/schedules/create with a profile-derived discovery payload (#533)", () => {
  const authenticatedLogin = "derived_create_user";
  const storedTestTokens = JSON.stringify({
    accessToken: "test-access-token",
    accessTokenSecret: "test-access-token-secret",
    storedAt: new Date().toISOString(),
    environment: "TEST",
    userLogin: authenticatedLogin,
  });
  let scheduleEveryCalls: any[];

  function makeAgent() {
    const sql = new MockSqlStorage();
    const ctx = {
      storage: { sql },
      id: { toString: () => "derived-create-route-test" },
    } as any;
    const agent: any = Object.create(OrchestratorAgent.prototype);
    agent.ctx = ctx;
    // #604: tokens live in the SessionStore DO (ns "etrade"), not KV —
    // same seeding pattern as tests/schedules_create_route.test.ts.
    const { namespace: sessionStoreNs, seed: seedSession } =
      makeFakeSessionStore();
    seedSession(
      "etrade",
      `etrade:token:TEST:${authenticatedLogin}`,
      storedTestTokens
    );
    agent.env = {
      APP_ENV: "TEST",
      SESSION_STORE: sessionStoreNs,
    } as any;
    agent.schedule = async (when: any, callback: string, payload: any) => {
      return { id: "real-schedule-1", callback, payload };
    };
    agent.scheduleEvery = async (intervalSeconds: number, callback: string, payload: any) => {
      scheduleEveryCalls.push([intervalSeconds, callback, payload]);
      return { id: "real-interval-1", callback, payload };
    };
    return agent;
  }

  async function postCreate(agent: any, body: Record<string, unknown>) {
    const res = await agent.onRequest(
      new Request("https://agent.test/api/schedules/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": authenticatedLogin },
        body: JSON.stringify(body),
      })
    );
    return { status: res.status, body: (await res.json()) as any };
  }

  beforeEach(() => {
    scheduleEveryCalls = [];
  });

  it("accepts a profile-derived payload with explicit symbols", async () => {
    const agent = makeAgent();
    const { status, body } = await postCreate(agent, {
      scheduleType: "interval",
      intervalSeconds: 3600,
      callback: "autonomousStrategyDiscovery",
      payload: { inputModel: "profile-derived", symbols: ["NVDA", "MSFT"], profileId: "prof-1" },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(scheduleEveryCalls).toHaveLength(1);
    expect(scheduleEveryCalls[0][2]).toMatchObject({
      inputModel: "profile-derived",
      symbols: ["NVDA", "MSFT"],
      profileId: "prof-1",
      userLogin: authenticatedLogin,
    });
  });

  it("accepts a profile-derived payload with a watchlist name", async () => {
    const agent = makeAgent();
    const { status } = await postCreate(agent, {
      scheduleType: "interval",
      intervalSeconds: 3600,
      callback: "autonomousStrategyDiscovery",
      payload: { inputModel: "profile-derived", watchlistName: "My List", profileId: "prof-1" },
    });
    expect(status).toBe(200);
    expect(scheduleEveryCalls[0][2]).toMatchObject({ watchlistName: "My List", profileId: "prof-1" });
  });

  it("still accepts an explicit saved-request payload", async () => {
    const agent = makeAgent();
    const { status } = await postCreate(agent, {
      scheduleType: "interval",
      intervalSeconds: 3600,
      callback: "autonomousStrategyDiscovery",
      payload: {
        inputModel: "saved-request",
        requests: [
          {
            symbol: "NVDA",
            thesis: "bullish",
            targetPrice: 200,
            targetDate: "2027-12-18",
            expectedIvDirection: "unchanged",
            maxPlannedLoss: 500,
            minRewardRisk: 1,
            allowedStrategies: ["long_call"],
          },
        ],
      },
    });
    expect(status).toBe(200);
    expect(scheduleEveryCalls).toHaveLength(1);
  });

  it.each([
    ["both symbols and watchlistName", { inputModel: "profile-derived", symbols: ["NVDA"], watchlistName: "My List", profileId: "prof-1" }],
    ["neither symbols nor watchlistName", { inputModel: "profile-derived", profileId: "prof-1" }],
    ["no profileId", { inputModel: "profile-derived", symbols: ["NVDA"] }],
    ["an empty profileId", { inputModel: "profile-derived", symbols: ["NVDA"], profileId: "  " }],
    ["an empty symbols list", { inputModel: "profile-derived", symbols: [], profileId: "prof-1" }],
    ["more than 25 symbols", { inputModel: "profile-derived", symbols: Array.from({ length: 26 }, (_, i) => `S${i + 1}`), profileId: "prof-1" }],
    ["an invalid ticker", { inputModel: "profile-derived", symbols: ["bad ticker!"], profileId: "prof-1" }],
    ["an empty watchlist name", { inputModel: "profile-derived", watchlistName: " ", profileId: "prof-1" }],
    ["an unknown inputModel", { inputModel: "derived-please", symbols: ["NVDA"], profileId: "prof-1" }],
  ])("rejects %s (400, no schedule created)", async (_label, payload) => {
    const agent = makeAgent();
    const { status, body } = await postCreate(agent, {
      scheduleType: "interval",
      intervalSeconds: 3600,
      callback: "autonomousStrategyDiscovery",
      payload,
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(scheduleEveryCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// R9 — the trigger route forwards profile-derived payloads
// ---------------------------------------------------------------------
describe("POST /schedules/trigger-discovery with a profile-derived payload (#533)", () => {
  function makeCtx(sql: FakeSql, orm: any) {
    return {
      env: makeEnv(),
      agentCtx: { storage: { sql } },
      audit: vi.fn(),
      listSchedules: vi.fn(async () => []),
      cancelSchedule: vi.fn(async () => true),
      getScheduleById: vi.fn(async () => undefined),
      schedule: vi.fn(async () => ({ id: "sched-1" })),
      scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
      getScreenerExecutionContext: vi.fn(async () => ({ userLogin: USER, environment: "TEST" as const })),
      getOrm: () => orm,
      autonomousMarketScreen: vi.fn(async () => undefined),
      autoRenewETradeTokens: vi.fn(async () => undefined),
      creatableScheduleCallbacks: [...CREATABLE_SCHEDULE_CALLBACKS],
      accountScopedScheduleCallbacks: new Set<string>(CREATABLE_SCHEDULE_CALLBACKS),
    } as unknown as SchedulesRouteContext;
  }

  async function postTrigger(ctx: any, body: Record<string, unknown>) {
    const path = "/api/schedules/trigger-discovery";
    const req = new Request(`https://agent.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-login": USER },
      body: JSON.stringify(body),
    });
    const res = await handleSchedulesRoutes(req, new URL(`https://agent.test${path}`), path, "session-1", ctx);
    return { status: res!.status, body: (await res!.json()) as any };
  }

  it("fires a profile-derived payload and persists a manual-trigger derived run", async () => {
    const sql = new FakeSql();
    const profileStore = new SqlStrategyProfileStore(sql, { idFactory: () => "prof-trigger-1" });
    const prof = await profileStore.create(USER, "Income", FULL_PROFILE_SPEC as any);
    const ctx = makeCtx(sql, makeOrm());

    const { status, body } = await postTrigger(ctx, {
      inputModel: "profile-derived",
      symbols: ["NVDA"],
      profileId: prof.id,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("completed");
    expect(body.data.abstained).toEqual([]);

    const store = new SqlDiscoveryRunStore(sql);
    const runs = await store.list({ userLogin: USER });
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("manual-trigger");
    expect(runs[0].inputModel).toBe("profile-derived");
    expect(runs[0].profileRef).toEqual({ id: prof.id, name: "Income", version: 1 });
  });

  it("surfaces abstentions in the trigger response alongside failures", async () => {
    const sql = new FakeSql();
    const profileStore = new SqlStrategyProfileStore(sql, { idFactory: () => "prof-trigger-2" });
    const prof = await profileStore.create(USER, "Income", FULL_PROFILE_SPEC as any);
    const ctx = makeCtx(sql, makeOrm());

    const { status, body } = await postTrigger(ctx, {
      inputModel: "profile-derived",
      symbols: ["NVDA", "MSFT"],
      profileId: prof.id,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("partial");
    expect(body.data.failures).toEqual([]);
    expect(body.data.abstained).toHaveLength(1);
    expect(body.data.abstained[0].symbol).toBe("MSFT");
    expect(typeof body.data.abstained[0].reason).toBe("string");
  });
});
