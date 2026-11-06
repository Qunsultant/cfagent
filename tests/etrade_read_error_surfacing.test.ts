/**
 * Issue #168: #155 established the lastError contract for the two
 * OPTIONS methods of ETradeRestClient (cleared on entry, set on EVERY
 * failure return, unset after success/genuine-empty) — but the same
 * discipline was missing across the client's other read methods.
 * Nearly all of them set lastError on HTTP errors yet returned
 * silently on the missing-credentials guard, in their catch blocks,
 * and on payload-less HTTP 200 bodies; lookupProduct was silent on
 * ALL paths including HTTP errors and exceptions, fetchQuote was
 * silent on missing token and missing quote data, and
 * getWatchlistDetails was silent even on HTTP errors.
 *
 * This file pins the contract for every read method: missing
 * credentials / missing params / HTTP error / network exception /
 * payload-less 200 all record a reason in lastError (with NO upstream
 * call for the guard paths), while genuine empties (payload wrapper
 * present, no items) and successes leave it unset — so consumers
 * reading getLastError() can tell "upstream failed" from "genuinely
 * nothing there", exactly as the options surfaces learned in #155.
 *
 * No assertion ever expects credential or token material in an error
 * string; one test pins the opposite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

import { ETradeRestClient } from "../src/trading/etrade/client";
import { ETradeService } from "../src/services/etrade";
import { storeAccessTokens } from "../src/security/etradeOAuth";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import type { Env } from "../src/types";

// CI hermeticity (fix for the #466 main-CI break): ci.yml injects the real
// ET_* secrets into process.env, and resolveEnvironmentConfig falls back to
// process.env when the Env object lacks a value — which silently defeats
// every "missing credentials" case below (they only pass in a credential-
// free local shell). Scrub the process-level E*TRADE vars for this file;
// makeEnv()/makeBareEnv() pass config via the Env object, which always wins
// over process.env, so credentialed cases are unaffected.
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
beforeEach(() => {
  savedProcessEnv = {};
  for (const k of SCRUBBED_ENV_KEYS) {
    savedProcessEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of SCRUBBED_ENV_KEYS) {
    if (savedProcessEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedProcessEnv[k];
  }
});

const USER = "test_trader_168";
// Fake placeholder credentials (the same convention as
// tests/etrade_options_error_surfacing.test.ts) — never real secrets.
const FAKE_KEY = "sandbox_consumer_key_168";
const FAKE_SECRET = "sandbox_consumer_secret_168";
const FAKE_TOKEN = "access_token_168";
const FAKE_TOKEN_SECRET = "access_secret_168";

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

/** Credentialed client with stored OAuth tokens, ready for fetch stubbing. */
async function makeAuthedClient(): Promise<ETradeRestClient> {
  const env = makeEnv();
  await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
  return new ETradeRestClient(env, USER);
}

function failAllFetches(status = 400, body = OAUTH_ERROR_BODY) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(body, { status }));
}

function throwAllFetches(message = "socket hangup") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error(message);
  });
}

function okJson(payload: unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));
}

// resolveEnvironmentConfig() falls back to process.env for E*TRADE
// credentials (a deliberate cascade for Node/local dev), reading every
// alias below. CI injects the real ET_API_KEY / ET_API_SECRET secrets
// into the test job's environment, so without scrubbing, the ambient
// values leak into the "missing credentials" fixtures and those tests
// fail in CI while passing locally (#490). Stub every alias to "" —
// the resolver's sanitize step treats "" as unset — for each test.
const AMBIENT_ET_CREDENTIAL_VARS = [
  "ET_API_KEY",
  "ET_API_SECRET",
  "ETRADE_API_KEY",
  "ETRADE_API_SECRET",
  "ETRADE_CONSUMER_KEY",
  "ETRADE_CONSUMER_SECRET",
  "ET_PROD_API_KEY",
  "ET_PROD_API_SECRET",
  "PROD_ET_API_KEY",
  "PROD_ET_API_SECRET",
  "ETRADE_PROD_CONSUMER_KEY",
  "ETRADE_PROD_CONSUMER_SECRET",
  "ET_SANDBOX_API_KEY",
  "ET_SANDBOX_API_SECRET",
  "SANDBOX_ET_API_KEY",
  "SANDBOX_ET_API_SECRET",
  "ETRADE_SANDBOX_CONSUMER_KEY",
  "ETRADE_SANDBOX_CONSUMER_SECRET",
];

beforeEach(() => {
  vi.restoreAllMocks();
  for (const name of AMBIENT_ET_CREDENTIAL_VARS) vi.stubEnv(name, "");
  // getValidTokens serves repeats from an isolate-level cache (#329);
  // reset it so a token stored by an earlier test cannot leak into a
  // missing-token scenario (the pattern main's own OAuth tests use).
  __resetTokenCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Shared failure modes, exercised per method family below:
//  - missing credentials → lastError set, ZERO upstream calls
//  - HTTP error           → lastError names the HTTP failure
//  - network exception    → lastError carries the failure
//  - payload-less 200     → "unexpected empty response"
//  - genuine empty        → empty result, lastError UNSET
//  - success              → data, lastError UNSET (and clears a prior error)
// ---------------------------------------------------------------------------

describe("fetchQuote — lastError contract (#168)", () => {
  it("missing credentials set lastError and return null without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.fetchQuote("AAPL")).toBeNull();
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing OAuth token sets lastError and returns null without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Credentials configured, but no env token and nothing stored in KV.
    const client = new ETradeRestClient(makeEnv(), USER);
    expect(await client.fetchQuote("AAPL")).toBeNull();
    expect(client.getLastError()).toContain("OAuth access token is missing");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing symbol sets lastError", async () => {
    const client = new ETradeRestClient(makeEnv(), USER);
    expect(await client.fetchQuote("   ")).toBeNull();
    expect(client.getLastError()).toContain("missing a symbol");
  });

  it("HTTP 400 sets lastError naming the failure", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchQuote("AAPL")).toBeNull();
    expect(client.getLastError()).toContain("Quote API Error [HTTP 400]");
  });

  it("network failure sets lastError", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.fetchQuote("AAPL")).toBeNull();
    expect(client.getLastError()).toContain("socket hangup");
  });

  it("HTTP 200 with no quote data sets lastError", async () => {
    const client = await makeAuthedClient();
    okJson({ QuoteResponse: { QuoteData: [] } });
    expect(await client.fetchQuote("AAPL")).toBeNull();
    expect(client.getLastError()).toContain("no quote data");
  });

  it("HTTP 200 with a quote but zero price returns the quote as-is with NO error (#809)", async () => {
    const client = await makeAuthedClient();
    okJson({ QuoteResponse: { QuoteData: [{ Product: { symbol: "AAPL" } }] } });
    // #809 (commit ad6534e) removed the price>0 gate: E*TRADE data is
    // presented as-is — zero prices are real when the market is closed, and
    // the caller decides how to handle them. This supersedes the #168-era
    // rejection this test pinned before ("no positive trade or bid price").
    const quote = await client.fetchQuote("AAPL");
    expect(quote).not.toBeNull();
    expect(quote!.symbol).toBe("AAPL");
    expect(quote!.lastPrice).toBe(0);
    expect(client.getLastError()).toBeFalsy();
  });

  it("success returns the quote with NO error, and clears a prior failure", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchQuote("AAPL")).toBeNull();
    expect(client.getLastError()).toBeTruthy();
    vi.restoreAllMocks();
    okJson({
      QuoteResponse: {
        QuoteData: [
          {
            Product: { symbol: "AAPL" },
            All: { symbol: "AAPL", companyName: "Apple Inc", lastTrade: 150.25, bid: 150, ask: 150.5 },
          },
        ],
      },
    });
    const quote = await client.fetchQuote("AAPL");
    expect(quote?.lastPrice).toBe(150.25);
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("fetchQuotes — lastError contract (#168)", () => {
  it("missing credentials set lastError and return [] without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.fetchQuotes(["AAPL"])).toEqual([]);
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing OAuth token sets lastError", async () => {
    const client = new ETradeRestClient(makeEnv(), USER);
    expect(await client.fetchQuotes(["AAPL"])).toEqual([]);
    expect(client.getLastError()).toContain("OAuth access token is missing");
  });

  it("an empty symbol list is a genuine empty — no error", async () => {
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.fetchQuotes([])).toEqual([]);
    expect(client.getLastError()).toBeUndefined();
  });

  it("HTTP 400 sets lastError", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchQuotes(["AAPL"])).toEqual([]);
    expect(client.getLastError()).toContain("quote request failed [HTTP 400]");
  });

  it("network failure sets lastError", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.fetchQuotes(["AAPL"])).toEqual([]);
    expect(client.getLastError()).toContain("socket hangup");
  });

  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.fetchQuotes(["AAPL"])).toEqual([]);
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("genuine empty (QuoteData: []) returns [] with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ QuoteResponse: { QuoteData: [] } });
    expect(await client.fetchQuotes(["AAPL"])).toEqual([]);
    expect(client.getLastError()).toBeUndefined();
  });

  it("success returns quotes with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({
      QuoteResponse: {
        QuoteData: [
          {
            Product: { symbol: "AAPL" },
            All: { symbol: "AAPL", companyName: "Apple Inc", lastTrade: 150.25 },
          },
        ],
      },
    });
    const quotes = await client.fetchQuotes(["AAPL"]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0].symbol).toBe("AAPL");
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("getMarketMovers — lastError contract (#168)", () => {
  it("missing credentials set lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.getMarketMovers("gainers")).toEqual([]);
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.getMarketMovers("gainers")).toEqual([]);
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("success returns symbols with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({
      MarketMoversResponse: { MarketMover: [{ Product: { symbol: "AAPL" } }, { Product: { symbol: "MSFT" } }] },
    });
    expect(await client.getMarketMovers("gainers")).toEqual(["AAPL", "MSFT"]);
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("fetchAccounts — lastError contract (#168)", () => {
  it("missing credentials set lastError and return [] without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.fetchAccounts()).toEqual([]);
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 sets lastError naming the failure", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchAccounts()).toEqual([]);
    expect(client.getLastError()).toContain("Accounts API Error [HTTP 400]");
  });

  it("network failure sets lastError", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.fetchAccounts()).toEqual([]);
    expect(client.getLastError()).toContain("accounts request failed");
    expect(client.getLastError()).toContain("socket hangup");
  });

  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.fetchAccounts()).toEqual([]);
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("genuine empty (wrapper present, no accounts) returns [] with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ AccountListResponse: { Accounts: {} } });
    expect(await client.fetchAccounts()).toEqual([]);
    expect(client.getLastError()).toBeUndefined();
  });

  it("success returns accounts with NO error, and clears a prior failure", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchAccounts()).toEqual([]);
    expect(client.getLastError()).toBeTruthy();
    vi.restoreAllMocks();
    okJson({
      AccountListResponse: {
        Accounts: {
          Account: [{ accountId: "1234", accountIdKey: "key1", accountDesc: "Brokerage", accountType: "INDIVIDUAL" }],
        },
      },
    });
    const accounts = await client.fetchAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].accountIdKey).toBe("key1");
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("fetchPortfolio — lastError contract (#168)", () => {
  it("missing credentials set lastError and return null without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.fetchPortfolio("key1")).toBeNull();
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 sets lastError naming the failure", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchPortfolio("key1")).toBeNull();
    expect(client.getLastError()).toContain("Portfolio API Error [HTTP 400]");
  });

  it("network failure sets lastError", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.fetchPortfolio("key1")).toBeNull();
    expect(client.getLastError()).toContain("portfolio request failed");
  });

  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.fetchPortfolio("key1")).toBeNull();
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("genuine empty portfolio (wrapper present, no positions) returns with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ PortfolioResponse: { AccountPortfolio: [{}] } });
    const result = await client.fetchPortfolio("key1");
    expect(result).not.toBeNull();
    expect(result?.positions).toEqual([]);
    expect(client.getLastError()).toBeUndefined();
  });

  it("HTTP 204 is a genuine empty — result with NO error", async () => {
    const client = await makeAuthedClient();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
    const result = await client.fetchPortfolio("key1");
    expect(result).not.toBeNull();
    expect(result?.positions).toEqual([]);
    expect(client.getLastError()).toBeUndefined();
  });

  it("success returns positions with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({
      PortfolioResponse: {
        Totals: { totalMarketValue: 150, cashBalance: 20 },
        AccountPortfolio: [
          { Position: [{ Product: { symbol: "AAPL", securityType: "EQ" }, quantity: 1, pricePaid: 100, marketValue: 150, totalCost: 100 }] },
        ],
      },
    });
    const result = await client.fetchPortfolio("key1");
    expect(result?.positions).toHaveLength(1);
    expect(result?.positions[0].symbol).toBe("AAPL");
    expect(client.getLastError()).toBeUndefined();
  });

  it("account discovery failure propagates the accounts error", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchPortfolio()).toBeNull();
    expect(client.getLastError()).toContain("Accounts API Error [HTTP 400]");
  });
});

describe("fetchPositionLots — lastError contract (#168)", () => {
  it("missing credentials set lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.fetchPositionLots("key1", "pos1")).toEqual([]);
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing account key / position id sets lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeEnv(), USER);
    expect(await client.fetchPositionLots("", "pos1")).toEqual([]);
    expect(client.getLastError()).toContain("missing an account key or position id");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 sets lastError", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchPositionLots("key1", "pos1")).toEqual([]);
    expect(client.getLastError()).toContain("Position Lots API Error [HTTP 400]");
  });

  it("network failure sets lastError", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.fetchPositionLots("key1", "pos1")).toEqual([]);
    expect(client.getLastError()).toContain("position lots request failed");
  });

  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.fetchPositionLots("key1", "pos1")).toEqual([]);
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("genuine empty (wrapper present, no lots) returns [] with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ PositionLotsResponse: {} });
    expect(await client.fetchPositionLots("key1", "pos1")).toEqual([]);
    expect(client.getLastError()).toBeUndefined();
  });

  it("success returns lots with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ PositionLotsResponse: { PositionLot: [{ positionId: "pos1", price: 10, originalQty: 5, remainingQty: 5 }] } });
    const lots = await client.fetchPositionLots("key1", "pos1");
    expect(lots).toHaveLength(1);
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("fetchBalance — lastError contract (#168)", () => {
  it("missing credentials set lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.fetchBalance("key1")).toBeNull();
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing account key sets lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeEnv(), USER);
    expect(await client.fetchBalance("")).toBeNull();
    expect(client.getLastError()).toContain("missing an account key");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 sets lastError", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchBalance("key1")).toBeNull();
    expect(client.getLastError()).toContain("Balance API Error [HTTP 400]");
  });

  it("network failure sets lastError", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.fetchBalance("key1")).toBeNull();
    expect(client.getLastError()).toContain("balance request failed");
  });

  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.fetchBalance("key1")).toBeNull();
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("success returns the balance with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ BalanceResponse: { Computed: { RealTimeValues: { totalAccountValue: 1000 }, cashBuyingPower: 500 } } });
    const balance = await client.fetchBalance("key1");
    expect(balance?.netAccountValue).toBe(1000);
    expect(balance?.cashBuyingPower).toBe(500);
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("fetchTransactions — lastError contract (#168)", () => {
  it("missing credentials set lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.fetchTransactions("key1")).toEqual([]);
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 sets lastError", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchTransactions("key1")).toEqual([]);
    expect(client.getLastError()).toContain("Transactions API Error [HTTP 400]");
  });

  it("network failure sets lastError", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.fetchTransactions("key1")).toEqual([]);
    expect(client.getLastError()).toContain("transactions request failed");
  });

  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.fetchTransactions("key1")).toEqual([]);
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("genuine empty (wrapper present, no transactions) returns [] with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ TransactionListResponse: {} });
    expect(await client.fetchTransactions("key1")).toEqual([]);
    expect(client.getLastError()).toBeUndefined();
  });

  it("success returns transactions with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({
      TransactionListResponse: {
        Transaction: [{ transactionId: "t1", accountId: "a1", transactionDate: 1700000000000, amount: -25.5, description: "Bought AAPL", transactionType: "Bought" }],
      },
    });
    const txns = await client.fetchTransactions("key1");
    expect(txns).toHaveLength(1);
    expect(txns[0].transactionId).toBe("t1");
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("fetchTransactionDetails — lastError contract (#168)", () => {
  it("missing credentials set lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.fetchTransactionDetails("key1", "t1")).toBeNull();
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing account key / transaction id sets lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeEnv(), USER);
    expect(await client.fetchTransactionDetails("", "t1")).toBeNull();
    expect(client.getLastError()).toContain("missing an account key or transaction id");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 sets lastError", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchTransactionDetails("key1", "t1")).toBeNull();
    expect(client.getLastError()).toContain("Transaction Details API Error [HTTP 400]");
  });

  it("network failure sets lastError", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.fetchTransactionDetails("key1", "t1")).toBeNull();
    expect(client.getLastError()).toContain("transaction details request failed");
  });

  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.fetchTransactionDetails("key1", "t1")).toBeNull();
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("success returns details with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({
      TransactionDetailsResponse: { transactionId: "t1", accountId: "a1", transactionDate: 1700000000000, amount: -25.5, description: "Bought AAPL" },
    });
    const details = await client.fetchTransactionDetails("key1", "t1");
    expect(details?.transactionId).toBe("t1");
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("fetchAlerts — lastError contract (#168)", () => {
  it("missing credentials set lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.fetchAlerts()).toEqual([]);
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 sets lastError", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchAlerts()).toEqual([]);
    expect(client.getLastError()).toContain("Alerts API Error [HTTP 400]");
  });

  it("network failure sets lastError", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.fetchAlerts()).toEqual([]);
    expect(client.getLastError()).toContain("alerts request failed");
  });

  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.fetchAlerts()).toEqual([]);
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("genuine empty (wrapper present, NO alerts) returns [] with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ AlertsResponse: {} });
    expect(await client.fetchAlerts()).toEqual([]);
    expect(client.getLastError()).toBeUndefined();
  });

  it("success returns alerts with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ AlertsResponse: { Alert: [{ id: 7, createTime: 1700000000, subject: "Price alert", status: "UNREAD" }] } });
    const alerts = await client.fetchAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe("Price alert");
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("fetchAlertDetails — lastError contract (#168)", () => {
  it("missing credentials set lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.fetchAlertDetails(7)).toBeNull();
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing alert id sets lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeEnv(), USER);
    expect(await client.fetchAlertDetails("")).toBeNull();
    expect(client.getLastError()).toContain("missing an alert id");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 sets lastError", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchAlertDetails(7)).toBeNull();
    expect(client.getLastError()).toContain("Alert Details API Error [HTTP 400]");
  });

  it("network failure sets lastError", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.fetchAlertDetails(7)).toBeNull();
    expect(client.getLastError()).toContain("alert details request failed");
  });

  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.fetchAlertDetails(7)).toBeNull();
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("success returns details with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ AlertDetailsResponse: { id: 7, createTime: 1700000000, subject: "Price alert", msgText: "AAPL hit target" } });
    const details = await client.fetchAlertDetails(7);
    expect(details?.subject).toBe("Price alert");
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("lookupProduct — lastError contract (#168, was silent on ALL paths)", () => {
  it("missing credentials set lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.lookupProduct("apple")).toEqual([]);
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("empty search term sets lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeEnv(), USER);
    expect(await client.lookupProduct("   ")).toEqual([]);
    expect(client.getLastError()).toContain("missing a search term");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 500 sets lastError (previously returned [] silently)", async () => {
    const client = await makeAuthedClient();
    failAllFetches(500, "upstream exploded");
    expect(await client.lookupProduct("apple")).toEqual([]);
    expect(client.getLastError()).toContain("Lookup API Error [HTTP 500]");
  });

  it("HTTP 400 oauth rejection sets lastError naming the failure", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.lookupProduct("apple")).toEqual([]);
    expect(client.getLastError()).toContain("HTTP 400");
    expect(client.getLastError()).toContain("oauth_problem");
  });

  it("network failure sets lastError (previously swallowed by a bare catch)", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.lookupProduct("apple")).toEqual([]);
    expect(client.getLastError()).toContain("product lookup request failed");
    expect(client.getLastError()).toContain("socket hangup");
  });

  it("payload-less 200 is a failure, not a genuine no-match", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.lookupProduct("apple")).toEqual([]);
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("genuine no-match (wrapper present, no Data) returns [] with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ LookupResponse: {} });
    expect(await client.lookupProduct("zzzqqq")).toEqual([]);
    expect(client.getLastError()).toBeUndefined();
  });

  it("success returns matches with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ LookupResponse: { Data: [{ symbol: "AAPL", description: "Apple Inc", type: "EQ" }] } });
    const results = await client.lookupProduct("apple");
    expect(results).toEqual([{ symbol: "AAPL", description: "Apple Inc", type: "EQ" }]);
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("fetchOrders — lastError contract (#168)", () => {
  it("missing credentials set lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.fetchOrders("key1")).toEqual([]);
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 sets lastError", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchOrders("key1")).toEqual([]);
    expect(client.getLastError()).toContain("Orders API Error [HTTP 400]");
  });

  it("network failure sets lastError", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.fetchOrders("key1")).toEqual([]);
    expect(client.getLastError()).toContain("orders request failed");
  });

  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.fetchOrders("key1")).toEqual([]);
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("genuine empty (wrapper present, no orders) returns [] with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ OrdersResponse: {} });
    expect(await client.fetchOrders("key1")).toEqual([]);
    expect(client.getLastError()).toBeUndefined();
  });

  it("success returns orders with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({
      OrdersResponse: {
        Order: [
          {
            orderId: 99,
            OrderDetail: [{ status: "OPEN", placedTime: 1700000000000, Instrument: [{ orderAction: "BUY", orderedQuantity: 3, Product: { symbol: "AAPL" } }] }],
          },
        ],
      },
    });
    const orders = await client.fetchOrders("key1");
    expect(orders).toHaveLength(1);
    expect(orders[0].orderId).toBe(99);
    expect(orders[0].status).toBe("OPEN");
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("fetchOrderDetails — lastError contract (#168)", () => {
  it("missing credentials set lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.fetchOrderDetails("key1", 99)).toBeNull();
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing order id sets lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeEnv(), USER);
    expect(await client.fetchOrderDetails("key1", "")).toBeNull();
    expect(client.getLastError()).toContain("missing an order id");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 sets lastError", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.fetchOrderDetails("key1", 99)).toBeNull();
    expect(client.getLastError()).toContain("Order Details API Error [HTTP 400]");
  });

  it("network failure sets lastError", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.fetchOrderDetails("key1", 99)).toBeNull();
    expect(client.getLastError()).toContain("order details request failed");
  });

  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.fetchOrderDetails("key1", 99)).toBeNull();
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("success returns the order with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({
      OrdersResponse: {
        Order: [
          {
            orderId: 99,
            OrderDetail: [{ status: "OPEN", placedTime: 1700000000000, Instrument: [{ orderAction: "BUY", orderedQuantity: 3, Product: { symbol: "AAPL" } }] }],
          },
        ],
      },
    });
    const order = await client.fetchOrderDetails("key1", 99);
    expect(order?.orderId).toBe(99);
    expect(order?.status).toBe("OPEN");
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("getWatchlists — lastError contract (#168)", () => {
  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.getWatchlists()).toEqual([]);
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("genuine empty (wrapper present, no watchlists) returns [] with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({ WatchlistResponse: {} });
    expect(await client.getWatchlists()).toEqual([]);
    expect(client.getLastError()).toBeUndefined();
  });

  it("success returns watchlists with NO error, and clears a prior failure", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.getWatchlists()).toEqual([]);
    expect(client.getLastError()).toBeTruthy();
    vi.restoreAllMocks();
    okJson({
      WatchlistResponse: { watchlist: [{ watchlistId: "w1", name: "Main", items: { item: [{ symbol: "AAPL" }, { symbol: "MSFT" }] } }] },
    });
    const lists = await client.getWatchlists();
    expect(lists).toHaveLength(1);
    expect(lists[0].symbols).toEqual(["AAPL", "MSFT"]);
    expect(client.getLastError()).toBeUndefined();
  });
});

describe("getWatchlistDetails — lastError contract (#168)", () => {
  it("missing credentials set lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.getWatchlistDetails("w1")).toBeNull();
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing watchlist id sets lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeEnv(), USER);
    expect(await client.getWatchlistDetails("")).toBeNull();
    expect(client.getLastError()).toContain("missing a watchlist id");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 sets lastError (previously returned null silently)", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.getWatchlistDetails("w1")).toBeNull();
    expect(client.getLastError()).toContain("Watchlist Details API Error [HTTP 400]");
  });

  it("network failure sets lastError", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.getWatchlistDetails("w1")).toBeNull();
    expect(client.getLastError()).toContain("watchlist detail request failed");
  });

  it("payload-less 200 is a failure, not a genuine empty", async () => {
    const client = await makeAuthedClient();
    okJson({});
    expect(await client.getWatchlistDetails("w1")).toBeNull();
    expect(client.getLastError()).toContain("unexpected empty response");
  });

  it("success returns details with NO error", async () => {
    const client = await makeAuthedClient();
    okJson({
      WatchlistDetailResponse: { watchlist: { watchlistId: "w1", name: "Main", items: { item: [{ symbol: "AAPL", price: 150 }] } } },
    });
    const details = await client.getWatchlistDetails("w1");
    expect(details?.name).toBe("Main");
    expect(details?.symbols).toEqual(["AAPL"]);
    expect(client.getLastError()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #244: deleteWatchlist was the client's one bare-boolean write
// method — missing credentials, HTTP errors, and exceptions all
// collapsed to `false` with nothing recorded. The boolean contract is
// unchanged; the method now records the reason in lastError under the
// same discipline as the reads above.
// ---------------------------------------------------------------------------

describe("deleteWatchlist — lastError contract (#244)", () => {
  it("missing credentials return false and set lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeBareEnv(), USER);
    expect(await client.deleteWatchlist("w1")).toBe(false);
    expect(client.getLastError()).toContain("consumer credentials are not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing watchlist id returns false and sets lastError without calling upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new ETradeRestClient(makeEnv(), USER);
    expect(await client.deleteWatchlist("")).toBe(false);
    expect(client.getLastError()).toContain("missing a watchlist id");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 returns false and sets lastError naming the failure (was silent)", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.deleteWatchlist("w1")).toBe(false);
    expect(client.getLastError()).toContain("Delete Watchlist Error [HTTP 400]");
  });

  it("HTTP 401 returns false and surfaces the session-expired reason", async () => {
    const client = await makeAuthedClient();
    failAllFetches(401);
    expect(await client.deleteWatchlist("w1")).toBe(false);
    expect(client.getLastError()).toContain("Session Expired");
  });

  it("network failure returns false and sets lastError (was a bare catch)", async () => {
    const client = await makeAuthedClient();
    throwAllFetches();
    expect(await client.deleteWatchlist("w1")).toBe(false);
    expect(client.getLastError()).toContain("watchlist delete request failed");
    expect(client.getLastError()).toContain("socket hangup");
  });

  it("success returns true with NO error, and clears a prior failure", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.deleteWatchlist("w1")).toBe(false);
    expect(client.getLastError()).toBeTruthy();
    vi.restoreAllMocks();
    okJson({});
    expect(await client.deleteWatchlist("w1")).toBe(true);
    expect(client.getLastError()).toBeUndefined();
  });

  it("recorded reasons never contain credential or token material", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    expect(await client.deleteWatchlist("w1")).toBe(false);
    const err = client.getLastError() ?? "";
    expect(err).not.toContain(FAKE_KEY);
    expect(err).not.toContain(FAKE_SECRET);
    expect(err).not.toContain(FAKE_TOKEN);
    expect(err).not.toContain(FAKE_TOKEN_SECRET);
  });
});

// ---------------------------------------------------------------------------
// // ---------------------------------------------------------------------------
// Service level + secret hygiene
// ---------------------------------------------------------------------------

describe("Service forwarding + error hygiene (#168)", () => {
  it("ETradeService.getLastError forwards the new non-options reasons", async () => {
    const service = new ETradeService(makeBareEnv(), undefined, USER);
    expect(await service.fetchAccountsRemote()).toEqual([]);
    expect(service.getLastError()).toContain("consumer credentials are not configured");
    expect(await service.lookupProduct("apple")).toEqual([]);
    expect(service.getLastError()).toContain("consumer credentials are not configured");
  });

  it("error strings never contain credential or token material", async () => {
    const client = await makeAuthedClient();
    failAllFetches(400);
    await client.fetchAccounts();
    await client.lookupProduct("apple");
    await client.getWatchlistDetails("w1");
    const err = client.getLastError() || "";
    expect(err).not.toContain(FAKE_KEY);
    expect(err).not.toContain(FAKE_SECRET);
    expect(err).not.toContain(FAKE_TOKEN);
    expect(err).not.toContain(FAKE_TOKEN_SECRET);
  });
});
