import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

// The orchestrator extends AIChatAgent from @cloudflare/ai-chat, whose real
// module graph pulls in `cloudflare:` protocol imports the node test loader
// cannot resolve. Mock it with a plain base class (same pattern as
// tests/api_chat_route.test.ts).
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

// Partial mock of the E*TRADE facade: the real ETradeService would hit OAuth
// and network; the strategy handler only needs `.client`. Everything else in
// the module stays real.
vi.mock("../src/services/etrade", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    ETradeService: class MockETradeService {
      client: Record<string, unknown> = {};
      constructor(..._args: unknown[]) {}
    },
  };
});

// Partial mock of the trading boundary: stub ONLY the network-touching
// screener; keep the real validateStrategyRequest + recommendOptionStrategies
// (the engine under test) and everything else. Mocking the boundary index
// itself — never a deep trading path (tests/trading-boundary.test.ts).
vi.mock("../src/trading", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    DynamicOptionsScreener: class MockDynamicOptionsScreener {
      constructor(..._args: unknown[]) {}
      async screenOptions(_filter: unknown) {
        return {
          contracts: CANNED_CONTRACTS,
          scannedAt: "2026-10-19T00:00:00.000Z",
          totalUnderlyingsScanned: 1,
          totalContractsEvaluated: CANNED_CONTRACTS.length,
          matchedCount: CANNED_CONTRACTS.length,
          quoteQuality: "ok",
          fetchErrors: [],
          warnings: [],
          validationError: null,
          status: "ok",
          rejections: [],
        };
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
import { OrchestratorAgent } from "../src/agents/orchestrator";
import { handleOptionsStrategyRecommend } from "../src/agents/routes/etradeOptions";
import { handleEnvironmentSwitch } from "../src/agents/routes/brokerEnvironment";
import { MockSqlStorage } from "./mock-sql";

/**
 * Issue #314 — the two advertised E*TRADE routes.
 *
 * (1) POST /api/broker/etrade/environment — the fallback in
 * ETradeDynamicMenu.tsx posted here and 404'd. It now delegates to the same
 * single-owner handler as /api/environment/switch: same contract, same
 * validation, same auth.
 *
 * (2) POST /api/etrade/options/strategy — advertised in
 * docs/ANALYSIS_AND_EXECUTION_WORKFLOWS.md (Workflow A2) but never
 * implemented. It now delegates to the same single-owner strategy-discovery
 * handler as /trading/options/recommend: E*TRADE chain snapshot ->
 * screened contracts -> the real recommendOptionStrategies engine
 * (Black-Scholes Greeks, model-implied POP, EV, payoff curves). No field is
 * fabricated; the engine's real output shape is returned.
 */

// Four canned contracts: two strikes x call/put, one expiry, tight spreads,
// FRESH quotes — enough for the engine to build ranked candidates.
const CANNED_CONTRACTS: any[] = [
  {
    symbol: "NVDA261218C00185000",
    underlyingSymbol: "NVDA",
    underlyingPrice: 180,
    optionType: "CALL",
    strikePrice: 185,
    expirationDate: "2026-12-18",
    daysToExpiration: 60,
    bid: 1.9,
    ask: 2.1,
    impliedVolatility: 0.5,
    delta: 0.42,
    openInterest: 1200,
    volume: 300,
    spreadPct: 10,
    moneyness: "OTM",
    strikeDistancePct: 2.78,
    quoteFreshness: "FRESH",
    technicalSignal: "none",
    highlightReason: "fixture",
  },
  {
    symbol: "NVDA261218P00175000",
    underlyingSymbol: "NVDA",
    underlyingPrice: 180,
    optionType: "PUT",
    strikePrice: 175,
    expirationDate: "2026-12-18",
    daysToExpiration: 60,
    bid: 1.7,
    ask: 1.9,
    impliedVolatility: 0.48,
    delta: -0.4,
    openInterest: 900,
    volume: 250,
    spreadPct: 11.8,
    moneyness: "OTM",
    strikeDistancePct: 2.78,
    quoteFreshness: "FRESH",
    technicalSignal: "none",
    highlightReason: "fixture",
  },
  {
    symbol: "NVDA261218C00180000",
    underlyingSymbol: "NVDA",
    underlyingPrice: 180,
    optionType: "CALL",
    strikePrice: 180,
    expirationDate: "2026-12-18",
    daysToExpiration: 60,
    bid: 4.4,
    ask: 4.6,
    impliedVolatility: 0.52,
    delta: 0.52,
    openInterest: 2100,
    volume: 800,
    spreadPct: 4.5,
    moneyness: "ATM",
    strikeDistancePct: 0,
    quoteFreshness: "FRESH",
    technicalSignal: "none",
    highlightReason: "fixture",
  },
  {
    symbol: "NVDA261218P00180000",
    underlyingSymbol: "NVDA",
    underlyingPrice: 180,
    optionType: "PUT",
    strikePrice: 180,
    expirationDate: "2026-12-18",
    daysToExpiration: 60,
    bid: 4.2,
    ask: 4.4,
    impliedVolatility: 0.52,
    delta: -0.48,
    openInterest: 1900,
    volume: 700,
    spreadPct: 4.8,
    moneyness: "ATM",
    strikeDistancePct: 0,
    quoteFreshness: "FRESH",
    technicalSignal: "none",
    highlightReason: "fixture",
  },
];

const VALID_STRATEGY_BODY = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 200,
  targetDate: "2027-12-18",
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  minDte: 30,
  maxDte: 90,
  allowedStrategies: ["long_call", "long_put"],
  candidateLimit: 5,
};

function strategyDeps() {
  return {
    orm: {} as any,
    env: { APP_ENV: "TEST" } as any,
    sessionKey: "etrade-314-test",
    requestedEnv: undefined as "TEST" | "PROD" | undefined,
  };
}

function makeAgent() {
  const sql = new MockSqlStorage();
  const ctx = {
    storage: { sql },
    id: { toString: () => "etrade-314-test" },
  } as any;
  const agent: any = Object.create(OrchestratorAgent.prototype);
  agent.ctx = ctx;
  agent.env = { APP_ENV: "TEST" } as any;
  agent.sessionKey = () => "etrade-314-test";
  agent.getOrm = () => ({}) as any;
  return agent;
}

function apiPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://agent.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("environment switcher — both spellings delegate to one handler (#314)", () => {
  // Issue #2482: the switch persists the selection, so direct calls
  // need a settings-backed context. Each request gets a fresh store so
  // iterations cannot leak a persisted value into each other.
  const stubCtx = () => {
    const store = new Map<string, string>();
    return {
      store,
      ctx: {
        readSettingRaw: (key: string) => store.get(key) ?? null,
        writeSetting: (key: string, value: string) => {
          store.set(key, value);
        },
        env: {},
      },
    };
  };

  it("returns the identical contract for TEST/PROD/invalid bodies", async () => {
    for (const body of [
      { environment: "TEST" },
      { environment: "PROD" },
      { environment: "test" },
      { environment: "BOGUS" },
      {},
    ]) {
      const reqA = apiPost("/api/environment/switch", body);
      const reqB = apiPost("/api/broker/etrade/environment", body);
      const resA = await handleEnvironmentSwitch(reqA, stubCtx().ctx);
      const resB = await handleEnvironmentSwitch(reqB, stubCtx().ctx);
      expect(resB.status).toBe(resA.status);
      expect(await resB.json()).toEqual(await resA.json());
    }
    const ok = await (
      await handleEnvironmentSwitch(
        apiPost("/api/broker/etrade/environment", { environment: "TEST" }),
        stubCtx().ctx,
      )
    ).json();
    expect(ok).toEqual({ success: true, environment: "TEST" });
    const bad = await handleEnvironmentSwitch(
      apiPost("/api/broker/etrade/environment", { environment: "BOGUS" }),
      stubCtx().ctx,
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/TEST or PROD/);
  });

  it("registers both route spellings in the extracted broker module", () => {
    // Slice #359-09 moved the environment block into
    // src/agents/routes/etradeBroker.ts (with handleEnvironmentSwitch).
    const src = readFileSync("src/agents/routes/etradeBroker.ts", "utf8");
    expect(src).toContain('path.endsWith("/environment/switch")');
    expect(src).toContain('path.endsWith("/broker/etrade/environment")');
    expect(src).toContain("return handleEnvironmentSwitch(request, ctx);");
    // Issue #2482: GET on either spelling reads the selection back.
    expect(src).toContain("return handleBrokerEnvironmentGet(ctx);");
  });
});

describe("options strategy discovery — /api/etrade/options/strategy (#314)", () => {
  it("answers synchronously through the real engine (200, ranked candidates)", async () => {
    const agent = makeAgent();
    const res = await agent.onRequest(apiPost("/api/etrade/options/strategy", VALID_STRATEGY_BODY, { "x-user-login": "octocat" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ranked_candidates");
    expect(json.modelVersion).toBe("options-risk-v2");
    expect(json.candidates.length).toBeGreaterThan(0);
    const first = json.candidates[0];
    // Engine-computed fields — never fabricated: Greeks, model-implied POP,
    // EV, payoff curve, score breakdown, assumptions.
    expect(first.legs.length).toBeGreaterThan(0);
    expect(first.netGreeks).toMatchObject({ delta: expect.any(Number), gamma: expect.any(Number), theta: expect.any(Number), vega: expect.any(Number) });
    expect(typeof first.modelImpliedProbabilityOfProfit).toBe("number");
    expect(typeof first.score).toBe("number");
    expect(first.scoreBreakdown).toBeDefined();
    expect(Array.isArray(first.payoffCurve)).toBe(true);
    expect(first.payoffCurve.length).toBeGreaterThan(0);
    expect(Array.isArray(first.scenarios)).toBe(true);
    expect(Array.isArray(json.assumptions)).toBe(true);
    expect(Array.isArray(json.evaluations)).toBe(true);
    // Screen metadata from the same pipeline as /trading/options/recommend.
    expect(json.screen.underlyingsScanned).toBe(1);
    expect(json.contracts.length).toBe(CANNED_CONTRACTS.length);
  });

  it("is immediate-sync (not a 202 job) like its read-only siblings", async () => {
    const agent = makeAgent();
    const res = await agent.onRequest(apiPost("/api/etrade/options/strategy", VALID_STRATEGY_BODY));
    expect(res.status).not.toBe(202);
  });

  it("returns byte-identical results to the canonical spelling for the same body", async () => {
    const a = await handleOptionsStrategyRecommend(
      apiPost("/api/trading/options/recommend", VALID_STRATEGY_BODY),
      strategyDeps()
    );
    const b = await handleOptionsStrategyRecommend(
      apiPost("/api/etrade/options/strategy", VALID_STRATEGY_BODY),
      strategyDeps()
    );
    expect(b.status).toBe(a.status);
    const ja = await a.json();
    const jb = await b.json();
    // generatedAt timestamps differ per call; everything else must be identical.
    delete ja.generatedAt;
    delete jb.generatedAt;
    expect(jb).toEqual(ja);
  });

  it("rejects invalid strategy requests with 400 (shared validation)", async () => {
    // Shape violations hit validateStrategyRequest's single message; numeric
    // guards throw their own specific messages — both surface as 400.
    const shapeViolations = [
      { ...VALID_STRATEGY_BODY, symbol: "  " },
      { ...VALID_STRATEGY_BODY, thesis: "sideways" },
      { ...VALID_STRATEGY_BODY, allowedStrategies: [] },
      { ...VALID_STRATEGY_BODY, allowedStrategies: ["not_a_strategy"] },
      null,
    ];
    for (const bad of shapeViolations) {
      const res = await handleOptionsStrategyRecommend(apiPost("/api/etrade/options/strategy", bad), strategyDeps());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/strategy request/i);
    }
    const neg = await handleOptionsStrategyRecommend(
      // Issue #1185: the numeric guard sits behind the identity gate —
      // the request carries the session-gate header like production traffic.
      apiPost("/api/etrade/options/strategy", { ...VALID_STRATEGY_BODY, maxPlannedLoss: -5 }, { "x-user-login": "alice" }),
      strategyDeps()
    );
    expect(neg.status).toBe(400);
    expect((await neg.json()).error).toMatch(/maxPlannedLoss/);
  });

  it("registers the advertised spelling and the immediate-sync exception", () => {
    // (Slice #359-11 moved the options routes into
    // src/agents/routes/etradeOptions.ts; the pin follows the ownership.
    // routeRequest delegates to handleEtradeOptionsRoutes at the exact
    // original position. The immediate-endpoint regex still lives in
    // orchestrator.ts — outside this slice's domain.)
    const src = readFileSync("src/agents/routes/etradeOptions.ts", "utf8");
    expect(src).toContain('path.endsWith("/etrade/options/strategy")');
    const orch = readFileSync("src/agents/orchestrator.ts", "utf8");
    expect(orch).toMatch(/etrade\\\/options\\\/strategy/);
    // #2942: the delegation moved with routeRequest into orchestrator/routeRequest.ts.
    expect(readFileSync("src/agents/orchestrator/routeRequest.ts", "utf8")).toContain("handleEtradeOptionsRoutes(request, url, path, sessionId,");
  });

  it("imports trading only through the boundary index (tests/trading-boundary.test.ts)", () => {
    const src = readFileSync("src/agents/orchestrator.ts", "utf8");
    const deep = src.match(/from "\.\.\/trading\/[^"]+"/g) || [];
    expect(deep).toEqual([]);
  });
});
