/**
 * Issue #959 (screening consolidation S1, umbrella #958): ONE validated
 * criteria/payload schema per screening kind, shared by REST, NLQ and
 * schedule creation.
 *
 * These tests pin the S1 contract:
 *  1. The real request payloads harvested from every current client
 *     surface (ScreenersHub, RawContractsScreener, serverDiscovery,
 *     ScannerPanel, ScheduledOptionsManager, the MCP scanner tool's
 *     forwarded body) validate clean through the shared schemas in
 *     src/trading/screeningSchemas.ts — the compatibility fixtures.
 *  2. Mis-shaped payloads (unknown keys, mis-typed fields, legacy client
 *     field names that never reached the engine) are rejected with the
 *     offending field NAMED — never silently dropped or coerced.
 *  3. PARITY: the same criteria driven through the REST schedule-create
 *     route, the NLQ scheduling executor, and the shared builder produce
 *     the IDENTICAL armed payload per schedule kind.
 *  4. The NLQ port's hardcoded legacy payload {sector:"Technology",
 *     maxItems:5} is gone: a criteria-less NLQ market screen arms only
 *     the schema-built identity stamps.
 *  5. The REST interactive screen routes validate through the same
 *     schemas (a mis-shaped body is a 400 naming the field, and the
 *     engine is never invoked).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { MockSqlStorage } from "./mock-sql";
import { makeFakeSessionStore } from "./fake-session-store";

// The orchestrator extends AIChatAgent from @cloudflare/ai-chat, whose real
// module graph pulls in `cloudflare:` protocol imports the node test loader
// cannot resolve. Mock it with a plain base class (the same pattern as
// tests/schedules_create_route.test.ts).
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

// Capturing fakes for the options screen route: the REAL
// DynamicOptionsScreener would try to reach E*TRADE; the parity question
// is which FILTER object crosses the route boundary, so capture it.
//
// #3186: the capture seam moved from screenOptions(filter) to
// fetchChains(filter) — the pipeline's chainFetch stage calls the
// latter, never the former. The mock keeps the REAL module's other
// exports (evaluateContracts / aggregateScreenResult, which the
// pipeline's enrich/screen stages call) and fakes only the engine
// class itself.
const capturedFetchChainsFilters: any[] = [];
vi.mock("../src/trading/optionsScreener", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    DynamicOptionsScreener: class FakeDynamicOptionsScreener {
      constructor(_client: unknown) {}
      async fetchChains(filter: any) {
        capturedFetchChainsFilters.push(filter);
        return {
          chains: [],
          filter,
          fetchErrors: [],
          deferredSymbols: [],
          symbols: filter.underlyingSymbols ?? [],
          warnings: [],
        };
      }
      evaluateChains() {
        throw new Error("not used in these tests");
      }
    },
  };
});
vi.mock("../src/services/etrade", () => {
  return {
    ETradeService: class FakeETradeService {
      client = {};
      constructor(..._args: unknown[]) {}
    },
  };
});

import {
  parseStockScreenerFilter,
  parseStockScreenRequest,
  parseOptionScreenerFilter,
  parseOptionsScreenRequest,
  parseStrategyRequest,
  parseNoViewStrategyRequest,
  parseOptionsDiscoveryRequest,
  parseUnifiedOptionsRequest,
  parseScanRequestTemplate,
  buildSchedulePayload,
} from "../src/trading/screeningSchemas";
import { UNIVERSES } from "../src/trading/universes";
import { validateStrategyRequest } from "../src/trading/options/strategyRiskAgent";
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
import { OrchestratorAgent } from "../src/agents/orchestrator";
import { handleEtradeBrokerRoutes } from "../src/agents/routes/etradeBroker";
import { handleEtradeOptionsRoutes } from "../src/agents/routes/etradeOptions";
import { DatabaseORM } from "../src/orm";
import {
  executeNLQQueryAsync,
  type NLQPlan,
  type NLQSchedulingPort,
} from "../src/agents/nlq";
import type { AgentScheduleItem } from "../src/types";

/* ------------------------------------------------------------------ */
/* Compatibility fixtures — the payloads the live surfaces send today  */
/* ------------------------------------------------------------------ */

// ScreenersHub (src/client/ScreenersHub.tsx) → POST /api/etrade/screen
// and /api/market-data/screen. `minScore` is an envelope field the hub sends;
// no server code reads it today.
const SCREENERS_HUB_BODY = {
  universe: "NASDAQ100",
  sector: "Technology",
  minScore: 25,
  search: "semi",
  limit: 20,
  minPrice: 10,
  maxPrice: 500,
  gainersOnly: true,
};

// RawContractsScreener (src/client/options/RawContractsScreener.tsx) →
// POST /api/trading/options/screen, with the sort keys corrected to the
// canonical OptionScreenSortKey values (#959 client fix: "impliedVolatility"
// → "iv"; the legacy "openInterest"/"strike" values had no engine
// comparator and were silently discarded by the engine's sanitizer).
const RAW_CONTRACTS_BODY = {
  underlyingSymbols: ["NVDA"],
  contractType: "CALL",
  minDte: 7,
  maxDte: 45,
  minVolume: 100,
  minOpenInterest: 500,
  maxSpreadPct: 20,
  limit: 5000,
  sortBy: "iv",
  pushToSlack: true,
};

// serverDiscovery.ts buildStrategyRequest (Options Research "Strategy
// Discovery") → POST /api/trading/options/strategies.
const SERVER_DISCOVERY_BODY = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 200,
  targetDate: "2026-12-18",
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 1000,
  minRewardRisk: 2,
  allowedStrategies: ["all"],
  maxDte: 60,
  candidateLimit: 24,
};

// ScannerPanel / scannerApi.ts → POST /api/trading/options/unified
// (action "opportunities"; pushToSlack is a route envelope field).
const SCANNER_PANEL_BODY = {
  action: "opportunities",
  symbols: ["NVDA", "AAPL"],
  mode: "per_name_best",
  maxSymbols: 10,
  pushToSlack: true,
};

// cloudflareWalletsScanner screen_options tool: the body it forwards to
// POST /api/trading/options/screen for args {underlying:"NVDA",
// maxUnderlyings:5, contractType:"CALL", minDelta:0.2, maxDelta:0.6,
// minOpenInterest:100, maxDTE:45, minDTE:7, minVolume:50,
// maxSpreadPct:25, maxQuoteAgeSeconds:300, limit:25}.
const MCP_FORWARDED_BODY = {
  underlyingSymbols: ["NVDA"],
  maxUnderlyings: 5,
  contractType: "CALL",
  minDelta: 0.2,
  maxDelta: 0.6,
  minOpenInterest: 100,
  maxDte: 45,
  minDte: 7,
  minVolume: 50,
  maxSpreadPct: 25,
  maxQuoteAgeSeconds: 300,
  limit: 25,
};

// ScheduledOptionsManager market-screen filters AFTER the #959 client
// fix (maxPe → maxPeRatio, trend → momentum with canonical values).
const MANAGER_FILTERS_FIXED = { minPrice: 5, maxPrice: 250, minMarketCap: 1_000_000_000, maxPeRatio: 30, momentum: "bullish_breakout" };
// …and the legacy shape the manager sent before the fix: `maxPe` and
// `trend` are NOT StockScreenerFilter fields and were silently ignored
// by the engine (the schema now rejects them, naming the fields).
const MANAGER_FILTERS_LEGACY = { minPrice: 5, maxPe: 30, trend: "bullish" };

const VALID_STRATEGY_REQUEST = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 210,
  targetDate: "2027-01-15",
  expectedIvDirection: "rise",
  maxPlannedLoss: 750,
  minRewardRisk: 1.8,
  allowedStrategies: ["bull_call_spread"],
  minDte: 20,
  maxDte: 60,
};

const VALID_NO_VIEW_SET = { symbol: "NVDA", maxPlannedLoss: 500, minRewardRisk: 1.5 };

/* ------------------------------------------------------------------ */
/* 1–2. Fixtures validate; mis-shapes are rejected naming the field    */
/* ------------------------------------------------------------------ */

describe("#959 shared screening schemas — compatibility fixtures", () => {
  it("ScreenersHub stock body validates; universe/minScore split out of the filter", () => {
    const parsed = parseStockScreenRequest(SCREENERS_HUB_BODY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.universe).toBe("NASDAQ100");
    expect(parsed.value.minScore).toBe(25);
    expect(parsed.value.filters).toEqual({
      sector: "Technology",
      search: "semi",
      limit: 20,
      minPrice: 10,
      maxPrice: 500,
      gainersOnly: true,
    });
    expect(parsed.value.filters).not.toHaveProperty("universe");
    expect(parsed.value.filters).not.toHaveProperty("minScore");
  });

  it("stock screen defaults the universe to NASDAQ100 when omitted", () => {
    const parsed = parseStockScreenRequest({ sector: "Energy" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.universe).toBe("NASDAQ100");
  });

  it("rejects a mis-typed stock filter field, naming it", () => {
    const parsed = parseStockScreenRequest({ minPrice: "10" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("minPrice");
  });

  it("rejects an unknown stock filter key, naming it", () => {
    const parsed = parseStockScreenerFilter({ sector: "Technology", bogusKey: 1 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("bogusKey");
  });

  it("rejects the manager's legacy filter names (maxPe/trend), naming them; the fixed shape validates", () => {
    const legacy = parseStockScreenerFilter(MANAGER_FILTERS_LEGACY);
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) {
      expect(legacy.error).toContain("maxPe");
      expect(legacy.error).toContain("trend");
    }
    const fixed = parseStockScreenerFilter(MANAGER_FILTERS_FIXED);
    expect(fixed.ok).toBe(true);
  });

  it("rejects a non-canonical momentum value the legacy trend select produced", () => {
    const parsed = parseStockScreenerFilter({ momentum: "bullish" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("momentum");
  });

  it("RawContractsScreener options body validates with the canonical sort key", () => {
    const parsed = parseOptionsScreenRequest(RAW_CONTRACTS_BODY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.filter.sortBy).toBe("iv");
    expect(parsed.value.pushToSlack).toBe(true);
    expect(parsed.value.filter).not.toHaveProperty("pushToSlack");
  });

  it("rejects legacy sortBy values that have no engine comparator, naming sortBy", () => {
    for (const sortBy of ["openInterest", "impliedVolatility", "strike"]) {
      const parsed = parseOptionsScreenRequest({ underlyingSymbols: ["NVDA"], sortBy });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("sortBy");
    }
  });

  it("the MCP scanner tool's forwarded body validates to the identical filter", () => {
    const parsed = parseOptionsScreenRequest(MCP_FORWARDED_BODY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { underlyingSymbols, maxUnderlyings, contractType, minDelta, maxDelta, minOpenInterest, maxDte, minDte, minVolume, maxSpreadPct, maxQuoteAgeSeconds, limit } = MCP_FORWARDED_BODY;
    expect(parsed.value.filter).toEqual({ underlyingSymbols, maxUnderlyings, contractType, minDelta, maxDelta, minOpenInterest, maxDte, minDte, minVolume, maxSpreadPct, maxQuoteAgeSeconds, limit });
  });

  it("rejects an unknown options filter key, naming it", () => {
    const parsed = parseOptionScreenerFilter({ underlyingSymbols: ["NVDA"], deltaMin: 0.2 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("deltaMin");
  });

  it("serverDiscovery strategy body validates through the discovery schema", () => {
    const parsed = parseOptionsDiscoveryRequest(SERVER_DISCOVERY_BODY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.request.symbol).toBe("NVDA");
    expect(parsed.value.request.allowedStrategies).toEqual(["all"]);
  });

  it("strategy schema rejects an unresolvable strategy name, naming allowedStrategies", () => {
    const parsed = parseStrategyRequest({ ...VALID_STRATEGY_REQUEST, allowedStrategies: ["not_a_strategy"] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("allowedStrategies");
  });

  it("strategy schema rejects maxDte below minDte, naming maxDte", () => {
    const parsed = parseStrategyRequest({ ...VALID_STRATEGY_REQUEST, minDte: 50, maxDte: 10 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("maxDte");
  });

  it("no-view schema accepts a constraint-only set and rejects view fields, naming them", () => {
    expect(parseNoViewStrategyRequest(VALID_NO_VIEW_SET).ok).toBe(true);
    const withView = parseNoViewStrategyRequest({ ...VALID_NO_VIEW_SET, thesis: "bullish" });
    expect(withView.ok).toBe(false);
    if (!withView.ok) expect(withView.error).toContain("thesis");
  });

  it("ScannerPanel unified body validates; pushToSlack splits into the envelope", () => {
    const parsed = parseUnifiedOptionsRequest(SCANNER_PANEL_BODY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.request.action).toBe("opportunities");
    expect(parsed.value.request).not.toHaveProperty("pushToSlack");
    expect(parsed.value.pushToSlack).toBe(true);
  });

  it("unified schema validates per-symbol expected-move overrides and stated targets", () => {
    const parsed = parseUnifiedOptionsRequest({
      action: "opportunities",
      symbols: ["NVDA"],
      perSymbol: { NVDA: { thesis: "bullish", target: { kind: "em", multiple: 1.5 } } },
      statedTarget: { price: 250, symbol: "NVDA" },
    });
    expect(parsed.ok).toBe(true);
  });

  it("unified schema rejects an unknown action, naming action", () => {
    const parsed = parseUnifiedOptionsRequest({ action: "bogus", symbols: ["NVDA"] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("action");
  });

  it("scan request template (NLQ OpportunityScanner seam) validates and rejects a missing thesis", () => {
    const template = {
      thesis: "bullish",
      targetDate: "2027-01-15",
      expectedIvDirection: "rise",
      maxPlannedLoss: 750,
      minRewardRisk: 1.8,
      allowedStrategies: ["all"],
      minDte: 20,
      maxDte: 60,
    };
    expect(parseScanRequestTemplate(template).ok).toBe(true);
    const missing = parseScanRequestTemplate({ ...template, thesis: undefined });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("thesis");
  });

  it("validateStrategyRequest keeps its pinned generic message via the shared schema", () => {
    expect(validateStrategyRequest(VALID_STRATEGY_REQUEST as any)).toBeNull();
    expect(validateStrategyRequest({ ...VALID_STRATEGY_REQUEST, thesis: "sideways" } as any)).toBe(
      "Invalid strategy request. Supply a thesis, target, date, risk cap, reward/risk minimum, and allowed strategies."
    );
  });
});

/* ------------------------------------------------------------------ */
/* 3. Schedule payload builder — the route's semantics, one site       */
/* ------------------------------------------------------------------ */

describe("#959 schedule payload builder", () => {
  const identity = { userLogin: "parity_user", environment: "TEST", trigger: "scheduled" as const };

  it("market screen: criteria + identity assemble the route's payload shape", () => {
    const built = buildSchedulePayload(
      "autonomousMarketScreen",
      { universe: "NASDAQ100", sector: "Technology", maxItems: 5 },
      identity
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value).toEqual({
      sector: "Technology",
      universe: "NASDAQ100",
      maxItems: 5,
      userLogin: "parity_user",
      environment: "TEST",
      trigger: "scheduled",
    });
  });

  it("options analysis: explicit symbols keep maxItems default = symbol count, no universe stamped", () => {
    const built = buildSchedulePayload(
      "autonomousOptionsAnalysis",
      { symbols: ["NVDA"], thesis: "bullish" },
      identity
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value).toEqual({
      symbols: ["NVDA"],
      thesis: "bullish",
      maxItems: 1,
      userLogin: "parity_user",
      environment: "TEST",
      trigger: "scheduled",
    });
  });

  it("options analysis: no symbols defaults universe NASDAQ100 and its defaultMaxSymbols", () => {
    const built = buildSchedulePayload("autonomousOptionsAnalysis", {}, identity);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value).toEqual({
      universe: "NASDAQ100",
      maxItems: UNIVERSES.NASDAQ100.defaultMaxSymbols,
      userLogin: "parity_user",
      environment: "TEST",
      trigger: "scheduled",
    });
  });

  it("discovery saved-request: requests carried verbatim, maxItems defaults to 0 (route-faithful)", () => {
    const built = buildSchedulePayload(
      "autonomousStrategyDiscovery",
      { requests: [VALID_STRATEGY_REQUEST] },
      identity
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value).toEqual({
      requests: [VALID_STRATEGY_REQUEST],
      maxItems: 0,
      userLogin: "parity_user",
      environment: "TEST",
      trigger: "scheduled",
    });
  });

  it("discovery no-view and profile-derived models build through the same builder", () => {
    const noView = buildSchedulePayload(
      "autonomousStrategyDiscovery",
      { inputModel: "no-view", constraintSets: [VALID_NO_VIEW_SET] },
      identity
    );
    expect(noView.ok).toBe(true);
    const derived = buildSchedulePayload(
      "autonomousStrategyDiscovery",
      { inputModel: "profile-derived", profileId: "profile-1", symbols: ["NVDA", "AAPL"] },
      identity
    );
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.value.maxItems).toBe(2);
  });

  it("reproduces the create route's exact error strings", () => {
    const cases: Array<[string, unknown, string]> = [
      ["autonomousMarketScreen", { universe: "BOGUS" }, "Unknown screening universe 'BOGUS'."],
      ["autonomousMarketScreen", { universe: "ALL" }, "Choose one specific universe for a scheduled screen."],
      ["autonomousOptionsAnalysis", { symbols: ["bad symbol!"] }, "symbols must be an array of valid ticker strings."],
      ["autonomousOptionsAnalysis", { maxItems: "five" }, "maxItems must be a whole number from 0 to 10000."],
      ["autonomousOptionsAnalysis", { maxItems: 10001 }, "maxItems must be a whole number from 0 to 10000."],
      [
        "autonomousStrategyDiscovery",
        { inputModel: "saved-request", constraintSets: [VALID_NO_VIEW_SET] },
        'payload.constraintSets belongs to the no-view discovery input model (inputModel "no-view") and cannot be combined with saved requests or a profile.',
      ],
      [
        "autonomousStrategyDiscovery",
        { inputModel: "no-view", requests: [VALID_STRATEGY_REQUEST], constraintSets: [VALID_NO_VIEW_SET] },
        "No-view discovery schedules carry payload.constraintSets only — requests, symbols, watchlistName and profileId belong to the other discovery input models.",
      ],
      [
        "autonomousStrategyDiscovery",
        { requests: [{ ...VALID_STRATEGY_REQUEST, thesis: "sideways" }] },
        "Saved discovery request 1 (NVDA) is invalid: Invalid strategy request. Supply a thesis, target, date, risk cap, reward/risk minimum, and allowed strategies.",
      ],
      [
        "autonomousStrategyDiscovery",
        { inputModel: "no-view", constraintSets: [{ ...VALID_NO_VIEW_SET, thesis: "bullish" }] },
        "No-view constraint set 1 (NVDA) is invalid: Invalid no-view strategy request. Supply a symbol, risk cap, reward/risk minimum, and constraints only — no thesis, target price, target date, or IV direction.",
      ],
      [
        "autonomousStrategyDiscovery",
        { inputModel: "sometimes" },
        'Unknown discovery inputModel \'sometimes\'. Use "saved-request", "profile-derived", or "no-view".',
      ],
    ];
    for (const [callback, criteria, message] of cases) {
      const built = buildSchedulePayload(callback, criteria, identity);
      expect(built.ok).toBe(false);
      if (!built.ok) expect(built.error).toBe(message);
    }
  });

  it("rejects unknown criteria keys, naming them (identity fields are stamped, never criteria)", () => {
    const built = buildSchedulePayload("autonomousOptionsAnalysis", { symbols: ["NVDA"], userLogin: "spoofed" }, identity);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toContain("userLogin");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Cross-entry parity — REST route vs NLQ executor vs builder       */
/* ------------------------------------------------------------------ */

class FakeSchedulingPort implements NLQSchedulingPort {
  items: AgentScheduleItem[] = [];
  calls: Array<{ method: string; args: unknown[] }> = [];
  private seq = 0;
  async schedule(when: Date | string | number, callback: string, payload?: unknown, options?: { idempotent?: boolean }): Promise<AgentScheduleItem> {
    this.calls.push({ method: "schedule", args: [when, callback, payload, options] });
    const item: AgentScheduleItem = {
      id: `fake-port-id-${++this.seq}`,
      callback,
      payload,
      type: typeof when === "number" ? "delayed" : typeof when === "string" ? "cron" : "scheduled",
      time: Math.floor(Date.now() / 1000) + 3600,
      ...(typeof when === "string" ? { cron: when } : {}),
      ...(typeof when === "number" ? { delayInSeconds: when } : {}),
    };
    this.items.push(item);
    return item;
  }
  async scheduleEvery(intervalSeconds: number, callback: string, payload?: unknown): Promise<AgentScheduleItem> {
    this.calls.push({ method: "scheduleEvery", args: [intervalSeconds, callback, payload] });
    const item: AgentScheduleItem = {
      id: `fake-port-id-${++this.seq}`,
      callback,
      payload,
      type: "interval",
      intervalSeconds,
      time: Math.floor(Date.now() / 1000) + intervalSeconds,
    };
    this.items.push(item);
    return item;
  }
  async cancelSchedule(id: string): Promise<boolean> {
    this.calls.push({ method: "cancelSchedule", args: [id] });
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    return true;
  }
  async listSchedules(): Promise<AgentScheduleItem[]> {
    this.calls.push({ method: "listSchedules", args: [] });
    return [...this.items];
  }
}

describe("#959 cross-entry schedule parity (REST route / NLQ / builder)", () => {
  const authenticatedLogin = "parity_user";
  const storedTestTokens = JSON.stringify({
    accessToken: "test-access-token",
    accessTokenSecret: "test-access-token-secret",
    storedAt: new Date().toISOString(),
    environment: "TEST",
    userLogin: authenticatedLogin,
  });
  let scheduleCalls: any[];
  let orm: DatabaseORM;
  const sessionId = "parity_user";
  const env = { APP_ENV: "TEST" } as any;

  beforeEach(() => {
    scheduleCalls = [];
    orm = new DatabaseORM(new MockSqlStorage() as any);
  });

  function makeAgent() {
    const sql = new MockSqlStorage();
    const ctx = { storage: { sql }, id: { toString: () => "screening-schema-parity" } } as any;
    const agent: any = Object.create(OrchestratorAgent.prototype);
    agent.ctx = ctx;
    const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
    seedSession("etrade", `etrade:token:TEST:${authenticatedLogin}`, storedTestTokens);
    agent.env = { APP_ENV: "TEST", SESSION_STORE: sessionStoreNs } as any;
    agent.schedule = async (when: any, callback: string, payload: any, options: any) => {
      scheduleCalls.push([when, callback, payload, options]);
      return { id: `real-schedule-${scheduleCalls.length}`, callback, payload };
    };
    agent.scheduleEvery = async (intervalSeconds: number, callback: string, payload: any) => {
      scheduleCalls.push([intervalSeconds, callback, payload]);
      return { id: `real-interval-${scheduleCalls.length}`, callback, payload };
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

  it("options analysis: REST-armed payload equals the builder's for the same criteria + identity", async () => {
    const agent = makeAgent();
    const { status } = await postCreate(agent, {
      scheduleType: "cron",
      cron: "0 14 * * 1-5",
      callback: "autonomousOptionsAnalysis",
      payload: { symbols: ["NVDA"], thesis: "bullish" },
    });
    expect(status).toBe(200);
    expect(scheduleCalls).toHaveLength(1);
    const built = buildSchedulePayload(
      "autonomousOptionsAnalysis",
      { symbols: ["NVDA"], thesis: "bullish" },
      // Issue #3655: the REST route stamps brokerId/dataProviderId/
      // mode server-side from the tenant selection (fixture's
      // unbound store falls back to the platform default — alpaca
      // data since #3990, etrade broker for this fixture's etrade
      // session; TEST → paper), so the builder's identity must carry
      // the same resolved values for parity — the builder stamps
      // identity values, never a default.
      { userLogin: authenticatedLogin, environment: "TEST", trigger: "scheduled", brokerId: "etrade", dataProviderId: "alpaca", mode: "paper" }
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Issue #3121 S1 — the REST route stamps creation provenance
    // onto the armed payload; the builder is the criteria→payload
    // function, so parity is compared on the criteria payload with
    // provenance asserted separately (same shape in both tests).
    const armedOptions = scheduleCalls[0][2] as Record<string, unknown>;
    expect(armedOptions.provenance).toEqual(
      expect.objectContaining({
        origin: "user",
        createdBy: authenticatedLogin,
        createdAt: expect.any(String),
      }),
    );
    const { provenance: _droppedOptions, ...optionsCriteria } = armedOptions;
    expect(optionsCriteria).toEqual(built.value);
  });

  it("discovery saved-request: REST-armed payload equals the builder's", async () => {
    const agent = makeAgent();
    const { status } = await postCreate(agent, {
      scheduleType: "cron",
      cron: "0 14 * * 1-5",
      callback: "autonomousStrategyDiscovery",
      payload: { requests: [VALID_STRATEGY_REQUEST] },
    });
    expect(status).toBe(200);
    expect(scheduleCalls).toHaveLength(1);
    const built = buildSchedulePayload(
      "autonomousStrategyDiscovery",
      { requests: [VALID_STRATEGY_REQUEST] },
      // Issue #3655: same resolved-identity stamping as the options
      // parity test above (etrade broker / alpaca data / paper for
      // this fixture, #3990).
      { userLogin: authenticatedLogin, environment: "TEST", trigger: "scheduled", brokerId: "etrade", dataProviderId: "alpaca", mode: "paper" }
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const armedDiscovery = scheduleCalls[0][2] as Record<string, unknown>;
    expect(armedDiscovery.provenance).toEqual(
      expect.objectContaining({
        origin: "user",
        createdBy: authenticatedLogin,
        createdAt: expect.any(String),
      }),
    );
    const { provenance: _droppedDiscovery, ...discoveryCriteria } = armedDiscovery;
    expect(discoveryCriteria).toEqual(built.value);
  });

  it("REST create still enforces its explicit-universe policy for stock schedules (route policy over the shared builder)", async () => {
    const agent = makeAgent();
    const { status, body } = await postCreate(agent, {
      scheduleType: "cron",
      cron: "0 14 * * 1-5",
      callback: "autonomousMarketScreen",
      payload: { sector: "Technology" },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("Stock schedules require one explicit universe.");
    expect(scheduleCalls).toHaveLength(0);
  });

  it("NLQ market screen with NO criteria arms only the schema-built identity stamps (legacy hardcoded payload gone)", async () => {
    const port = new FakeSchedulingPort();
    const plan: NLQPlan = {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "interval",
        intervalSeconds: 300,
        callback: "autonomousMarketScreen",
        description: "Scheduled market screen",
      },
    };
    const result = await executeNLQQueryAsync(orm, sessionId, plan, env, sessionId, undefined, {
      schedulingPort: port,
    });
    expect(result.status).toBe("scheduled");
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].method).toBe("scheduleEvery");
    // #3122: the NLQ executor stamps agent provenance on the armed
    // payload; the rest is exactly the schema-built identity stamps.
    const { provenance, ...identity } = port.calls[0].args[2] as Record<string, unknown>;
    expect(identity).toEqual({ userLogin: sessionId, trigger: "scheduled" });
    expect(provenance).toMatchObject({ agentId: "nlq", createdBy: sessionId, origin: "agent" });
    expect(typeof (provenance as Record<string, unknown>).createdAt).toBe("string");
  });

  it("NLQ options analysis WITH criteria arms the builder's payload (parity with the builder arm)", async () => {
    const port = new FakeSchedulingPort();
    const plan: NLQPlan = {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "cron",
        cron: "30 13 * * 1-5",
        callback: "autonomousOptionsAnalysis",
        description: "Weekday options analysis",
        symbols: ["NVDA"],
        thesis: "bullish",
      } as NLQPlan["scheduleData"],
    };
    const result = await executeNLQQueryAsync(orm, sessionId, plan, env, sessionId, undefined, {
      schedulingPort: port,
    });
    expect(result.status).toBe("scheduled");
    const built = buildSchedulePayload(
      "autonomousOptionsAnalysis",
      { symbols: ["NVDA"], thesis: "bullish" },
      { userLogin: sessionId, trigger: "scheduled" }
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // #3122: the NLQ executor stamps agent provenance on the armed
    // payload; the rest is exactly the builder's payload.
    const { provenance, ...armed } = port.calls[0].args[2] as Record<string, unknown>;
    expect(armed).toEqual(built.value);
    expect(provenance).toMatchObject({ agentId: "nlq", createdBy: sessionId, origin: "agent" });
    expect(typeof (provenance as Record<string, unknown>).createdAt).toBe("string");
  });

  it("NLQ schedule creation with mis-shaped criteria fails explicitly and arms nothing", async () => {
    const port = new FakeSchedulingPort();
    const plan: NLQPlan = {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "interval",
        intervalSeconds: 300,
        callback: "autonomousMarketScreen",
        description: "Bad universe screen",
        universe: "BOGUS",
      } as NLQPlan["scheduleData"],
    };
    const result = await executeNLQQueryAsync(orm, sessionId, plan, env, sessionId, undefined, {
      schedulingPort: port,
    });
    expect(result.status).toBe("error");
    expect(result.summary).toContain("Unknown screening universe 'BOGUS'.");
    expect(port.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 5. REST interactive routes validate through the same schemas        */
/* ------------------------------------------------------------------ */

describe("#959 REST interactive screen routes share the schemas", () => {
  const runScreenCalls: any[] = [];
  const fakeScreenerAgent = {
    async runScreen(req: any) {
      runScreenCalls.push(req);
      return {
        success: true,
        universe: req.universe,
        totalScanned: 0,
        matchedCount: 0,
        opportunities: [],
        allStocks: [],
        discoveryMessage: "fake run",
        timestamp: new Date().toISOString(),
      };
    },
    async runSharded() {
      throw new Error("not used in these tests");
    },
    async storeOptionsPdf() {
      return "fake-pdf-key";
    },
  };

  // The session gate's authenticated login for these route calls
  // (issue #1185: route handlers fail closed without it).
  const authenticatedLogin = "parity_user";

  function brokerCtx() {
    return {
      env: {} as any,
      getOrm: () => ({}) as any,
      audit: () => {},
      getScreenerAgent: () => fakeScreenerAgent,
      persistScreenerReportCanonical: () => {},
    } as any;
  }

  beforeEach(() => {
    runScreenCalls.length = 0;
    capturedFetchChainsFilters.length = 0;
  });

  it("POST /api/etrade/screen rejects a mis-typed filter with a 400 naming the field; engine never runs", async () => {
    const req = new Request("https://agent.test/api/etrade/screen", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-login": authenticatedLogin },
      body: JSON.stringify({ minPrice: "10" }),
    });
    const res = await handleEtradeBrokerRoutes(req, new URL(req.url), "/api/etrade/screen", "sess-1", brokerCtx());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as any;
    expect(body.error).toContain("minPrice");
    expect(runScreenCalls).toHaveLength(0);
  });

  it("POST /api/etrade/screen hands the engine exactly the shared schema's validated filter + universe", async () => {
    const req = new Request("https://agent.test/api/etrade/screen", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-login": authenticatedLogin },
      body: JSON.stringify(SCREENERS_HUB_BODY),
    });
    const res = await handleEtradeBrokerRoutes(req, new URL(req.url), "/api/etrade/screen", "sess-1", brokerCtx());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(runScreenCalls).toHaveLength(1);
    const parsed = parseStockScreenRequest(SCREENERS_HUB_BODY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(runScreenCalls[0].filters).toEqual(parsed.value.filters);
    expect(runScreenCalls[0].universe).toBe(parsed.value.universe);
  });

  it("GET /api/etrade/screen rejects a NaN numeric param with a 400 naming the field", async () => {
    const url = new URL("https://agent.test/api/etrade/screen?minRsi=abc");
    const req = new Request(url, {
      method: "GET",
      headers: { "x-user-login": authenticatedLogin },
    });
    const res = await handleEtradeBrokerRoutes(req, url, "/api/etrade/screen", "sess-1", brokerCtx());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as any;
    expect(body.error).toContain("minRsi");
    expect(runScreenCalls).toHaveLength(0);
  });

  function optionsCtx() {
    const sql = new MockSqlStorage();
    // #3186: the pipeline persists all 8 stage artifacts via
    // storage.put/get, so the ctx storage is Map-backed (the
    // tests/manual_options_screen_workflow_3186.test.ts pattern);
    // sql-only storage dies at plan.persist.
    const store = new Map<string, unknown>();
    return {
      env: {} as any,
      getOrm: () => ({ storeCanonicalReport: () => {} }) as any,
      agentCtx: {
        storage: {
          sql,
          get: async (key: string) => store.get(key),
          put: async (key: string, value: unknown) => {
            store.set(key, value);
          },
        },
      },
      ensureTables: () => sql,
      audit: () => {},
      getScreenerAgent: () => fakeScreenerAgent,
      requestedEnv: undefined,
    } as any;
  }

  it("POST /api/trading/options/screen rejects a legacy sortBy with a 400 naming sortBy; screener never runs", async () => {
    const req = new Request("https://agent.test/api/trading/options/screen", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-login": authenticatedLogin },
      body: JSON.stringify({ underlyingSymbols: ["NVDA"], sortBy: "openInterest", pushToSlack: false }),
    });
    const res = await handleEtradeOptionsRoutes(req, new URL(req.url), "/api/trading/options/screen", "sess-1", optionsCtx());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as any;
    expect(body.error).toContain("sortBy");
    expect(capturedFetchChainsFilters).toHaveLength(0);
  });

  it("POST /api/trading/options/screen hands the screener exactly the shared schema's validated filter", async () => {
    // Old pin captured the filter at the retired screenOptions(filter)
    // seam; #3186 step 3d moved the capture to fetchChains(filter) —
    // the pipeline's chainFetch stage calls it after re-validating the
    // route-parsed filter. This pin proves the validated filter still
    // reaches the screener exactly.
    const req = new Request("https://agent.test/api/trading/options/screen", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-login": authenticatedLogin },
      body: JSON.stringify({ ...RAW_CONTRACTS_BODY, pushToSlack: false }),
    });
    const res = await handleEtradeOptionsRoutes(req, new URL(req.url), "/api/trading/options/screen", "sess-1", optionsCtx());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(capturedFetchChainsFilters).toHaveLength(1);
    const parsed = parseOptionsScreenRequest(RAW_CONTRACTS_BODY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(capturedFetchChainsFilters[0]).toEqual(parsed.value.filter);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Single definition site — structural pins (house grep idiom)      */
/* ------------------------------------------------------------------ */

describe("#959 single definition site", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("the NLQ executor no longer carries the hardcoded legacy schedule payload", () => {
    const src = read("../src/agents/nlq/execution.ts");
    expect(src).not.toMatch(/sector:\s*"Technology",\s*maxItems:\s*5/);
    expect(src).toContain("buildSchedulePayload");
  });

  it("every entry point module CALLS the shared schema module (call-level pins — comments do not satisfy them)", () => {
    const entryPointCalls: Array<[string, RegExp]> = [
      ["../src/agents/routes/schedules.ts", /buildSchedulePayload\(/],
      // Issue #2809: the two REST stock-screen routes call the
      // single spec builder, which itself calls the shared schema.
      ["../src/agents/routes/etradeBroker.ts", /buildStockScreenRunSpec\(/],
      ["../src/agents/routes/marketDataResearch.ts", /buildStockScreenRunSpec\(/],
      ["../src/workflows/stockScreenRunSpec.ts", /parseStockScreenRequest\(/],
      ["../src/agents/routes/etradeOptions.ts", /parseOptionsScreenRequest\(/],
      ["../src/agents/routes/etradeOptions.ts", /parseUnifiedOptionsRequest\(/],
      ["../src/agents/routes/etradeOptions.ts", /parseOptionsDiscoveryRequest\(/],
      ["../src/agents/routes/premium.ts", /parseOptionsScreenRequest\(/],
      ["../src/agents/nlq/execution.ts", /buildSchedulePayload\(/],
      ["../src/agents/nlq/execution.ts", /parseStockScreenerFilter\(/],
      ["../src/agents/nlq/execution.ts", /parseOptionScreenerFilter\(/],
      ["../src/agents/nlqOptionsStrategy.ts", /parseScanRequestTemplate\(/],
      ["../src/mcps/scanner/cloudflareWalletsScanner.ts", /optionScreenerFilterFields\./],
      ["../src/mcps/openaimp/agenticPaymentCommands.ts", /optionScreenerFilterFields\./],
      ["../src/mcps/openaimp/agenticPaymentCommands.ts", /parseOptionScreenerFilter\(/],
      ["../src/trading/options/strategyRiskAgent.ts", /checkStrategyRequestFields\(/],
      ["../src/trading/options/strategyRiskAgent.ts", /checkNoViewRequestFields\(/],
    ];
    for (const [rel, pattern] of entryPointCalls) {
      expect(read(rel), `${rel} must call ${pattern}`).toMatch(pattern);
    }
  });

  it("screenerPipeline no longer claims to be the single entry point for ALL stock screening (D12)", () => {
    const src = read("../src/trading/screenerPipeline.ts");
    expect(src).not.toContain("single entry point for ALL stock screening");
    expect(src).toContain("screeningSchemas");
  });

  it("ScheduledAgent documents its explicit non-screening scope (D10)", () => {
    const src = read("../src/agents/scheduled-agent.ts");
    expect(src).toMatch(/NOT a screening scheduler/);
  });
});
