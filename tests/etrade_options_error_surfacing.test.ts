/**
 * Issue #155: the E*TRADE options endpoints returned HTTP 200 with
 * EMPTY payloads on upstream failure — expire-dates `{count:0,
 * dates:[]}`, chains `{underlyingPrice:0, pairs:[]}` — indistinguishable
 * from a symbol that genuinely has no expirations or no chain. That is
 * exactly how the 2026-10-16 daily scan outage presented (three runs,
 * signed in, markets open, empty 200s) and why the 2026-10-17
 * oauth_problem 400s were invisible at every surface.
 *
 * Root cause: the client's options methods returned []/null on several
 * failure paths WITHOUT setting `lastError` (missing credentials most
 * notably; also network throws in chains and payload-less 200 bodies),
 * and the two options routes never consulted the error that the
 * service's existing `getLastError()` already forwarded.
 *
 * The fix, pinned here at every layer:
 * - Client: `lastError` is cleared on entry and set on EVERY failure
 *   return of getOptionChains / getOptionExpireDates (missing
 *   credentials, missing symbol, HTTP error, network throw, and an
 *   HTTP 200 whose body carries no payload wrapper at all). A genuine
 *   empty (wrapper present, no dates/pairs) leaves it unset.
 * - Service: the pre-existing `ETradeService.getLastError()` chain
 *   (service → platform → client) is exercised against the options
 *   calls to prove the forwarding reaches the new failure reasons.
 * - Routes: failure-empties become `502 {error, symbol}` naming the
 *   cause; genuine empties keep the exact previous 200 payloads.
 * - Consumers: the screener's fetchErrors and the IV collector's failed
 *   outcomes (which already carried a reason slot fed by lastError) now
 *   receive the real provider reason end-to-end.
 *
 * No assertion in this file ever expects credential or token material
 * in an error surface; one test pins the opposite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

// src/agents/orchestrator.ts pulls in `cloudflare:`-adjacent SDK entry
// points the node test loader cannot resolve. Mock them with plain
// stand-ins (same pattern as tests/payment_webhook_default_deny.test.ts).
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
vi.mock("agents", () => {
  // Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
  // Agents SDK actors now, so the mock must export the Agent base
  // the classes extend (previously Think, aliased to a stub).
  return {
    routeAgentRequest: async () => null,
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
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import { ETradeRestClient } from "../src/trading/etrade/client";
import { ETradeService } from "../src/services/etrade";
import { storeAccessTokens } from "../src/security/etradeOAuth";
import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { OptionsDataAgent } from "../src/trading/options/optionsDataAgent";
import { collectIvHistory } from "../src/trading/options/ivCollector";
import { InMemoryIvHistoryStore } from "../src/trading/options/ivHistoryStore";
import type { Env } from "../src/types";

const USER = "test_trader_155";
// Fake placeholder credentials (the same convention as
// tests/etrade_all_endpoints.test.ts) — never real secrets.
const FAKE_KEY = "sandbox_consumer_key_155";
const FAKE_SECRET = "sandbox_consumer_secret_155";
const FAKE_TOKEN = "access_token_155";
const FAKE_TOKEN_SECRET = "access_secret_155";

const OAUTH_ERROR_BODY = JSON.stringify({
  Error: { code: 1003, message: "oauth_problem=token_rejected" },
});

function makeKv() {
  const storage: Record<string, string> = {};
  return {
    get: vi.fn(async (k: string) => storage[k] || null),
    put: vi.fn(async (k: string, v: string) => {
      storage[k] = v;
    }),
    delete: vi.fn(async (k: string) => {
      delete storage[k];
    }),
  } as any;
}

/** Env WITH sandbox consumer credentials configured. */
function makeEnv(overrides: Record<string, unknown> = {}): Env {
  const kv = makeKv();
  const { namespace: sessionStoreNs } = makeFakeSessionStore();
  return {
    APP_NAME: "cfagent-test",
    APP_BASE_URL: "https://agent.openaimp.com",
    APP_ENV: "TEST",
    ET_API_KEY: FAKE_KEY,
    ET_API_SECRET: FAKE_SECRET,
    ET_BASE_URL: "https://apisb.etrade.com/v1",
    SESSION_STORE: sessionStoreNs,
    ETRADE_KV: kv,
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    ASSETS: {} as any,
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ...overrides,
  } as Env;
}

/** Env with NO E*TRADE consumer credentials at all. */
function makeBareEnv(): Env {
  const kv = makeKv();
  const { namespace: sessionStoreNs } = makeFakeSessionStore();
  return {
    APP_NAME: "cfagent-test",
    APP_BASE_URL: "https://agent.openaimp.com",
    APP_ENV: "TEST",
    ET_BASE_URL: "https://apisb.etrade.com/v1",
    SESSION_STORE: sessionStoreNs,
    ETRADE_KV: kv,
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    ASSETS: {} as any,
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
  } as Env;
}

function failAllFetches(status = 400, body = OAUTH_ERROR_BODY) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(body, { status }));
}

const EXPIRE_DATES_OK = JSON.stringify({
  OptionExpireDateResponse: {
    ExpirationDate: [{ year: 2026, month: 11, day: 20, expiryType: "MONTHLY" }],
  },
});

const CHAIN_OK = JSON.stringify({
  OptionChainResponse: {
    nearPrice: 142.5,
    OptionPair: [
      {
        Call: { symbol: "NVDA--261120C00145000", strikePrice: 145, bid: 5.2, ask: 5.4 },
        Put: { symbol: "NVDA--261120P00145000", strikePrice: 145, bid: 6.1, ask: 6.3 },
      },
    ],
  },
});

// `resolveEnvironmentConfig()` (src/config/environment.ts) resolves E*TRADE
// consumer credentials from `process.env` as a documented fallback (Node /
// local .dev.vars), after the Worker Env bindings. The CI job exports the
// real ET_API_KEY / ET_API_SECRET into `process.env`, so a bare Env alone
// does NOT yield a credential-free client there — the missing-credentials
// preflight never fires and the "bare env" tests below fail against the
// live sandbox. Strip every variable the resolver consults for the duration
// of this file and restore the originals afterwards. Every other test in
// this file passes explicit credentials via Env (which take priority over
// `process.env`), so they are unaffected.
const CREDENTIAL_ENV_VARS = [
  "ET_API_KEY",
  "ET_API_SECRET",
  "ETRADE_API_KEY",
  "ETRADE_API_SECRET",
  "ETRADE_CONSUMER_KEY",
  "ETRADE_CONSUMER_SECRET",
  "ET_SANDBOX_API_KEY",
  "ET_SANDBOX_API_SECRET",
  "ETRADE_SANDBOX_CONSUMER_KEY",
  "ETRADE_SANDBOX_CONSUMER_SECRET",
  "SANDBOX_ET_API_KEY",
  "SANDBOX_ET_API_SECRET",
  "ET_PROD_API_KEY",
  "ET_PROD_API_SECRET",
  "ETRADE_PROD_CONSUMER_KEY",
  "ETRADE_PROD_CONSUMER_SECRET",
  "PROD_ET_API_KEY",
  "PROD_ET_API_SECRET",
];
let savedCredentialEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.restoreAllMocks();
  savedCredentialEnv = {};
  for (const key of CREDENTIAL_ENV_VARS) {
    savedCredentialEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of CREDENTIAL_ENV_VARS) {
    const saved = savedCredentialEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  savedCredentialEnv = {};
});

// ---------------------------------------------------------------------------
// Client level
// ---------------------------------------------------------------------------

describe("ETradeRestClient options calls — lastError contract (#155)", () => {
  it("expire-dates: missing credentials set lastError and return [] without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    const dates = await client.getOptionExpireDates("NVDA");
    expect(dates).toEqual([]);
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("chains: missing credentials set lastError and return null without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    const chain = await client.getOptionChains({ symbol: "NVDA" });
    expect(chain).toBeNull();
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("expire-dates: HTTP 400 oauth rejection sets lastError naming the failure", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    failAllFetches(400);
    const client = new ETradeRestClient(env, USER);
    const dates = await client.getOptionExpireDates("NVDA");
    expect(dates).toEqual([]);
    expect(client.getLastError()).toContain("Option Expire Date API Error [HTTP 400]");
    expect(client.getLastError()).toContain("oauth_problem");
  });

  it("chains: HTTP 400 oauth rejection sets lastError naming the failure", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    failAllFetches(400);
    const client = new ETradeRestClient(env, USER);
    const chain = await client.getOptionChains({ symbol: "NVDA" });
    expect(chain).toBeNull();
    expect(client.getLastError()).toContain("Option Chains API Error [HTTP 400]");
    expect(client.getLastError()).toContain("oauth_problem");
  });

  it("charges and blocks the .json fallback as a second real fetch attempt", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("bad request", { status: 400 }));
    const client = new ETradeRestClient(env, USER);
    const budget = {
      limit: 1,
      used: 0,
      exhausted: false,
      tryConsume() {
        if (this.used >= this.limit) {
          this.exhausted = true;
          return false;
        }
        this.used++;
        return true;
      },
    };

    expect(await client.getOptionChains({ symbol: "NVDA" }, budget)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(budget.used).toBe(1);
    expect(budget.exhausted).toBe(true);
    expect(client.getLastError()).toContain("Subrequest budget exhausted");
  });

  it("expire-dates: a network failure sets lastError", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("socket hangup");
    });
    const client = new ETradeRestClient(env, USER);
    const dates = await client.getOptionExpireDates("NVDA");
    expect(dates).toEqual([]);
    expect(client.getLastError()).toContain("socket hangup");
  });

  it("chains: a network failure sets lastError", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("socket hangup");
    });
    const client = new ETradeRestClient(env, USER);
    const chain = await client.getOptionChains({ symbol: "NVDA" });
    expect(chain).toBeNull();
    expect(client.getLastError()).toContain("option chains request failed");
    expect(client.getLastError()).toContain("socket hangup");
  });

  it("expire-dates: HTTP 200 with no payload wrapper is a failure, not a genuine empty", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    failAllFetches(200, "{}");
    const client = new ETradeRestClient(env, USER);
    const dates = await client.getOptionExpireDates("NVDA");
    expect(dates).toEqual([]);
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("chains: HTTP 200 with no payload wrapper is a failure, not a genuine empty", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    failAllFetches(200, "{}");
    const client = new ETradeRestClient(env, USER);
    const chain = await client.getOptionChains({ symbol: "NVDA" });
    expect(chain).toBeNull();
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("expire-dates: genuine empty (wrapper present, no dates) returns [] with NO error", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ OptionExpireDateResponse: {} }), { status: 200 })
    );
    const client = new ETradeRestClient(env, USER);
    const dates = await client.getOptionExpireDates("NVDA");
    expect(dates).toEqual([]);
    expect(client.getLastError()).toBeUndefined();
  });

  it("chains: genuine empty (wrapper present, no pairs) returns an empty chain with NO error", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ OptionChainResponse: { nearPrice: 42.5 } }), { status: 200 })
    );
    const client = new ETradeRestClient(env, USER);
    const chain = await client.getOptionChains({ symbol: "NVDA" });
    expect(chain).not.toBeNull();
    expect(chain?.underlyingPrice).toBe(42.5);
    expect(chain?.pairs).toEqual([]);
    expect(client.getLastError()).toBeUndefined();
  });

  it("expire-dates: a success after a failure clears lastError", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    const client = new ETradeRestClient(env, USER);
    failAllFetches(400);
    expect(await client.getOptionExpireDates("NVDA")).toEqual([]);
    expect(client.getLastError()).toBeTruthy();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(EXPIRE_DATES_OK, { status: 200 })
    );
    const dates = await client.getOptionExpireDates("NVDA");
    expect(dates).toHaveLength(1);
    expect(client.getLastError()).toBeUndefined();
  });

  it("chains: a success after a failure clears lastError", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    const client = new ETradeRestClient(env, USER);
    failAllFetches(400);
    expect(await client.getOptionChains({ symbol: "NVDA" })).toBeNull();
    expect(client.getLastError()).toBeTruthy();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(CHAIN_OK, { status: 200 })
    );
    const chain = await client.getOptionChains({ symbol: "NVDA" });
    expect(chain?.pairs).toHaveLength(1);
    expect(client.getLastError()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Service level
// ---------------------------------------------------------------------------

describe("ETradeService.getLastError forwarding (#155)", () => {
  it("forwards the missing-credentials error from both options calls", async () => {
    const service = new ETradeService(makeBareEnv(), undefined, USER);
    await service.getOptionExpireDates("NVDA");
    expect(service.getLastError()).toContain("consumer credentials are not configured");
    const chain = await service.getOptionChains({ symbol: "NVDA" });
    expect(chain).toBeNull();
    expect(service.getLastError()).toContain("consumer credentials are not configured");
  });

  it("forwards an upstream failure, and is undefined after a genuine empty", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    const service = new ETradeService(env, undefined, USER);
    failAllFetches(400);
    expect(await service.getOptionChains({ symbol: "NVDA" })).toBeNull();
    expect(service.getLastError()).toContain("HTTP 400");
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ OptionChainResponse: { nearPrice: 42.5 } }), { status: 200 })
    );
    const chain = await service.getOptionChains({ symbol: "NVDA" });
    expect(chain?.pairs).toEqual([]);
    expect(service.getLastError()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Route level
// ---------------------------------------------------------------------------

describe("/etrade/options routes — failure is a 502, genuine empty stays 200 (#155)", () => {
  const makeAgent = (env: Env) => {
    const sql = new MockSqlStorage();
    const ctx = {
      id: { toString: () => "options_routes_155" },
      storage: { sql },
      waitUntil: vi.fn(),
    };
    return new OrchestratorAgent(ctx as any, env);
  };

  const get = (agent: OrchestratorAgent, path: string) =>
    agent.onRequest(
      new Request(`https://agent.internal${path}`, {
        method: "GET",
        headers: { "x-user-login": USER },
      })
    );

  it("expire-dates: missing credentials → 502 naming the cause", async () => {
    const agent = makeAgent(makeBareEnv());
    const res = await get(agent, "/etrade/options/expire-dates?symbol=NVDA");
    expect(res.status).toBe(502);
    const json = (await res.json()) as any;
    expect(json.error).toContain("consumer credentials are not configured");
    expect(json.symbol).toBe("NVDA");
    expect(json.dates).toBeUndefined();
  });

  it("expire-dates: upstream oauth 400 → 502 naming the HTTP failure", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    failAllFetches(400);
    const agent = makeAgent(env);
    const res = await get(agent, "/etrade/options/expire-dates?symbol=NVDA");
    expect(res.status).toBe(502);
    const json = (await res.json()) as any;
    expect(json.error).toContain("HTTP 400");
    expect(json.error).toContain("oauth_problem");
  });

  it("expire-dates: genuine empty → 200 {count:0, dates:[]} byte-compatible", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ OptionExpireDateResponse: {} }), { status: 200 })
    );
    const agent = makeAgent(env);
    const res = await get(agent, "/etrade/options/expire-dates?symbol=NVDA");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0, dates: [] });
  });

  it("expire-dates: success → 200 with the dates, unchanged", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(EXPIRE_DATES_OK, { status: 200 })
    );
    const agent = makeAgent(env);
    const res = await get(agent, "/etrade/options/expire-dates?symbol=NVDA");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.count).toBe(1);
    expect(json.dates[0]).toMatchObject({ year: 2026, month: 11, day: 20 });
  });

  it("chains: missing credentials → 502 naming the cause", async () => {
    const agent = makeAgent(makeBareEnv());
    const res = await get(agent, "/etrade/options/chains?symbol=NVDA");
    expect(res.status).toBe(502);
    const json = (await res.json()) as any;
    expect(json.error).toContain("consumer credentials are not configured");
    expect(json.symbol).toBe("NVDA");
    expect(json.pairs).toBeUndefined();
  });

  it("chains: upstream oauth 400 → 502 naming the HTTP failure", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    failAllFetches(400);
    const agent = makeAgent(env);
    const res = await get(agent, "/etrade/options/chains?symbol=NVDA");
    expect(res.status).toBe(502);
    const json = (await res.json()) as any;
    expect(json.error).toContain("HTTP 400");
    expect(json.error).toContain("oauth_problem");
  });

  it("chains: genuine empty → 200 {symbol, underlyingPrice, pairs: []} byte-compatible", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ OptionChainResponse: { nearPrice: 42.5 } }), { status: 200 })
    );
    const agent = makeAgent(env);
    const res = await get(agent, "/etrade/options/chains?symbol=NVDA");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ symbol: "NVDA", underlyingPrice: 42.5, pairs: [] });
  });

  it("chains: success → 200 with pairs, unchanged", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(CHAIN_OK, { status: 200 })
    );
    const agent = makeAgent(env);
    const res = await get(agent, "/etrade/options/chains?symbol=NVDA");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.underlyingPrice).toBe(142.5);
    expect(json.pairs).toHaveLength(1);
    expect(json.pairs[0].call.strikePrice).toBe(145);
  });

  it("502 bodies never contain credential or token material", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    failAllFetches(400);
    const agent = makeAgent(env);
    for (const path of ["/etrade/options/expire-dates?symbol=NVDA", "/etrade/options/chains?symbol=NVDA"]) {
      const res = await get(agent, path);
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain(FAKE_SECRET);
      expect(text).not.toContain(FAKE_TOKEN);
      expect(text).not.toContain(FAKE_TOKEN_SECRET);
    }
  });
});

// ---------------------------------------------------------------------------
// Consumer level — scanner + IV collector
// ---------------------------------------------------------------------------

describe("Consumers — the failure reason reaches scanner and collector outcomes (#155)", () => {
  it("screener fetchErrors carry the real reason when credentials are missing", async () => {
    const client = new ETradeRestClient(makeBareEnv(), USER);
    const screener = new DynamicOptionsScreener(client);
    const result = await screener.screenOptions({ underlyingSymbols: ["NVDA"] });
    expect(result.fetchErrors?.length).toBeGreaterThan(0);
    expect(result.fetchErrors?.[0].symbol).toBe("NVDA");
    expect(result.fetchErrors?.[0].reason).toContain("consumer credentials are not configured");
  });

  it("screener fetchErrors carry the upstream reason on oauth rejection", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    failAllFetches(400);
    const client = new ETradeRestClient(env, USER);
    const screener = new DynamicOptionsScreener(client);
    const result = await screener.screenOptions({ underlyingSymbols: ["NVDA"] });
    expect(result.fetchErrors?.length).toBeGreaterThan(0);
    expect(result.fetchErrors?.[0].reason).toContain("HTTP 400");
  });

  it("IV collector records a failed outcome WITH the provider reason (production wiring shape)", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    failAllFetches(400);
    // Mirrors ScheduledTasksService.collectDailyIvHistory's fetchChain.
    const etrade = new ETradeService(env, undefined, USER);
    const dataAgent = new OptionsDataAgent(new DynamicOptionsScreener(etrade.client));
    const fetchChain = async (symbol: string) => {
      const snapshot = await dataAgent.loadSnapshot({ symbol });
      const fetchReasons = (snapshot.screen.fetchErrors ?? [])
        .filter((e) => e.symbol === symbol)
        .map((e) => e.reason);
      const error =
        snapshot.validationError ??
        (fetchReasons.length ? fetchReasons.join("; ") : undefined);
      return { contracts: snapshot.contracts, ...(error ? { error } : {}) };
    };

    const report = await collectIvHistory({
      store: new InMemoryIvHistoryStore(),
      fetchChain,
      curatedSymbols: ["NVDA"],
      watchlistSymbols: [],
    });
    expect(report.failed).toBe(1);
    expect(report.outcomes[0].status).toBe("failed");
    expect(report.outcomes[0].reason).toContain("HTTP 400");
  });
});
