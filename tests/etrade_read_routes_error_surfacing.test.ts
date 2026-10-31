/**
 * Issue #243: #155 fixed the two OPTIONS routes and #168 completed the
 * client-side lastError contract, but five E*TRADE read routes still
 * answered an ambiguous empty 200 WITHOUT consulting
 * `etrade.getLastError()`:
 *   GET /etrade/accounts        {count: 0, accounts: []}
 *   GET /etrade/orders/remote   {count: 0, orders: []}
 *   GET /etrade/alerts          {count: 0, alerts: []}
 *   GET /etrade/lookup          {count: 0, items: []}
 *   GET /etrade/watchlists      {count: 0, watchlists: []}
 * and GET /etrade/watchlist/details mapped ANY null result to
 * 404 "Watchlist not found" — including upstream failures, so an
 * expired session read as "your watchlist doesn't exist".
 *
 * (The sibling GET /etrade/orders route reads the LOCAL trade-ledger
 * table, not the broker — it has no upstream failure mode and is out
 * of scope here; the broker-backed orders read is /orders/remote.)
 *
 * The fix follows the #155 pattern at the route layer only: when the
 * result is empty (or null, for details) AND the service recorded an
 * error, the route answers 502 {error} naming the cause; a genuine
 * empty / genuine not-found keeps the exact previous payload. For
 * watchlists the merged result is remote+local: a NON-empty merged
 * list is real data (e.g. local durable watchlists served while the
 * remote read failed) and is returned exactly as before — only the
 * empty-and-failed case changes.
 *
 * Consumers were surveyed before the change (see #243): the only
 * in-repo HTTP consumers are src/client/accountApi.ts (whose getJson
 * throws on non-200 with the body's error) feeding AccountPanels.tsx
 * loaders that already render per-panel error states, plus the
 * watchlist-details click handler, which catches to the same null it
 * showed for the old 404. NLQ/MCP use ETradeService directly, not
 * these routes. No consumer depends on failure looking like empty.
 *
 * These tests drive the REAL route handlers -> real ETradeService ->
 * real ETradeRestClient with the upstream fetch stubbed, per route:
 * failure (missing credentials / HTTP error) -> 502 naming the cause;
 * genuine empty -> the byte-identical previous 200; details upstream
 * failure -> 502, genuine not-found -> the previous 404.
 *
 * Issue #517: the same handler's three sibling routes kept the
 * ambiguous shapes after #243 — GET /etrade/transactions answered an
 * empty 200 on upstream failure, and GET /etrade/transactions/:id
 * and GET /etrade/alerts/:id mapped ANY null to 404. They now follow
 * the identical split. The consumer survey was repeated for these
 * routes (see #517): accountApi.ts getJson throws on non-200 with the
 * body's error for all three; the transactions panel loader renders
 * the message through its error state, and both detail click
 * handlers catch to the same null they showed for the old 404 — no
 * consumer depends on failure looking like empty or not-found.
 *
 * Detail-route contract note (the #168 client contract, the same
 * call #243 made for watchlist/details): the client records an
 * error for EVERY null detail result — including an upstream 404
 * after the .json fallback retry — so an upstream 404 surfaces here
 * as 502 naming the recorded reason. The routes' 404 remains for a
 * null with NO recorded error (the genuine not-found case); with the
 * current client that branch is defensive — no client path returns
 * a clean null — so it is preserved verbatim in the route rather
 * than exercised by a live scenario below.
 *
 * No assertion ever expects credential or token material in an error
 * surface; one test pins the opposite.
 *
 * Issue #2573: the failure body changed from `{ error: <raw
 * lastError> }` (which pasted the raw upstream body, e.g.
 * `oauth_problem=...`, into the UI) to the coded form
 * `{ code, message, retryable }` from the single outcome catalog
 * (see src/agents/routes/brokerCodedError.ts), with the catalog
 * httpStatus (502 for the per-section codes). The tests below were
 * updated to that contract in this slice: every former
 * `body.error` assertion now asserts the section code and its
 * catalog business message, and asserts the raw upstream text is
 * ABSENT. Genuine-empty, genuine-not-found, and success assertions
 * are unchanged, as are the failure-vs-empty distinctions themselves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

import {
  handleEtradeBrokerRoutes,
  handleEtradeBrokerActivityRoutes,
  type EtradeBrokerRouteContext,
} from "../src/agents/routes/etradeBroker";
import {
  handleWatchlistsRoutes,
  type WatchlistsRouteContext,
} from "../src/agents/routes/watchlists";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { storeAccessTokens } from "../src/security/etradeOAuth";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import type { Env } from "../src/types";

// CI hermeticity (the #466/#490 lesson, copied from
// tests/etrade_read_error_surfacing.test.ts): ci.yml injects the real
// ET_* secrets into process.env, and resolveEnvironmentConfig falls
// back to process.env when the Env object lacks a value — which would
// silently defeat every "missing credentials" case below. Scrub the
// process-level aliases; makeEnv()/makeBareEnv() pass config via the
// Env object, which always wins over process.env.
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
  "ET_BASE_URL",
  "ET_PROD_BASE_URL",
];

beforeEach(() => {
  vi.restoreAllMocks();
  for (const name of AMBIENT_ET_CREDENTIAL_VARS) vi.stubEnv(name, "");
  // getValidTokens serves repeats from an isolate-level cache (#329);
  // reset it so a token stored by an earlier test cannot leak into a
  // missing-token scenario.
  __resetTokenCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const USER = "test_trader_243";
// Fake placeholder credentials (the convention of the #155/#168
// files) — never real secrets.
const FAKE_KEY = "sandbox_consumer_key_243";
const FAKE_SECRET = "sandbox_consumer_secret_243";
const FAKE_TOKEN = "sandbox_access_token_243";
const FAKE_TOKEN_SECRET = "sandbox_access_token_secret_243";

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
    SEARCH_AGENT: {} as any,
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
    SEARCH_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    ASSETS: {} as any,
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
  } as Env;
}

/** Credentialed env with stored OAuth tokens, ready for fetch stubbing. */
async function makeAuthedEnv(): Promise<Env> {
  const env = makeEnv();
  await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
  return env;
}

function makeOrm(): DatabaseORM {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema("test_session_243");
  return orm;
}

function brokerCtx(env: Env, orm: DatabaseORM): EtradeBrokerRouteContext {
  return {
    env,
    getOrm: () => orm,
    // Issue #2482: handlers resolve the broker environment from the
    // persisted selection; fixtures without a selection read the
    // deployment default from env.
    readSettingRaw: () => null,
    audit: vi.fn(),
    getScreenerAgent: () => ({}) as any,
    persistScreenerReportCanonical: vi.fn(),
    evaluateAndRecordAutopilotVerdict: async () => ({ verdict: { executionAllowed: true } }) as any,
    getAutopilotState: () => ({ running: false }),
    incrementAutopilotOrdersToday: vi.fn(),
    schedule: async () => ({ id: "sched-1" }) as any,
    cancelSchedule: async () => {},
  } as EtradeBrokerRouteContext;
}

function watchlistsCtx(env: Env, orm: DatabaseORM): WatchlistsRouteContext {
  return {
    env,
    getOrm: () => orm,
    requestedEnv: undefined,
  } as WatchlistsRouteContext;
}

// Issue #1185: requests model the production session gate — src/server.ts
// sets x-user-login from the verified session (here, USER, the login the
// authed env seeds its stored token under); handlers fail closed without it.
const req = (path: string) =>
  new Request(`https://agent.internal${path}`, { method: "GET", headers: { "x-user-login": USER } });
const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

function failAllFetches(status = 400, body = OAUTH_ERROR_BODY) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(body, { status }));
}

function okJson(payload: unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }));
}

/** URL-aware stub: payload chosen by a matcher over the request URL. */
function stubFetchByUrl(routes: Array<{ match: string; payload: unknown; status?: number }>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = String(input?.url ?? input);
    for (const r of routes) {
      if (url.includes(r.match)) {
        return new Response(JSON.stringify(r.payload), { status: r.status ?? 200 });
      }
    }
    return new Response("{}", { status: 200 });
  });
}

describe("GET /etrade/accounts — failure vs genuine empty (#243)", () => {
  const path = "/api/etrade/accounts";

  it("missing credentials → 502 naming the cause, no upstream call (was 200 count 0)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleEtradeBrokerRoutes(req(path), urlOf(path), path, USER, brokerCtx(makeBareEnv(), makeOrm()));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_ACCOUNTS_UNAVAILABLE");
    expect(body.message).toBe("Broker accounts are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 oauth rejection → 502 naming the failure", async () => {
    failAllFetches(400);
    const res = await handleEtradeBrokerRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_ACCOUNTS_UNAVAILABLE");
    expect(body.message).toBe("Broker accounts are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("oauth_problem");
  });

  it("genuine empty (wrapper present, no accounts) → the exact previous 200", async () => {
    okJson({ AccountListResponse: { Accounts: {} } });
    const res = await handleEtradeBrokerRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ count: 0, accounts: [] });
  });

  it("success → 200 with the accounts, unchanged", async () => {
    okJson({
      AccountListResponse: {
        Accounts: {
          Account: [{ accountId: "1234", accountIdKey: "key1", accountDesc: "Brokerage", accountType: "INDIVIDUAL" }],
        },
      },
    });
    const res = await handleEtradeBrokerRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.count).toBe(1);
    expect(body.accounts[0].accountIdKey).toBe("key1");
  });
});

describe("GET /etrade/orders/remote — failure vs genuine empty (#243)", () => {
  const path = "/api/etrade/orders/remote";

  it("missing credentials → 502 naming the cause, no upstream call (was 200 count 0)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleEtradeBrokerRoutes(req(path), urlOf(path), path, USER, brokerCtx(makeBareEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_ORDERS_UNAVAILABLE");
    expect(body.message).toBe("Broker orders are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 on the account-resolution sub-call → 502 naming the failure", async () => {
    failAllFetches(400);
    const res = await handleEtradeBrokerRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_ORDERS_UNAVAILABLE");
    expect(body.message).toBe("Broker orders are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
  });

  it("genuine empty (account resolves, no orders) → the exact previous 200", async () => {
    stubFetchByUrl([
      { match: "/orders", payload: { OrdersResponse: {} } },
      {
        match: "/accounts",
        payload: {
          AccountListResponse: {
            Accounts: {
              Account: [{ accountId: "1234", accountIdKey: "key1", accountDesc: "Brokerage", accountType: "INDIVIDUAL" }],
            },
          },
        },
      },
    ]);
    const res = await handleEtradeBrokerRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ count: 0, orders: [] });
  });
});

describe("GET /etrade/alerts — failure vs genuine empty (#243)", () => {
  const path = "/api/etrade/alerts";

  it("missing credentials → 502 naming the cause, no upstream call (was 200 count 0)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(makeBareEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_ALERTS_UNAVAILABLE");
    expect(body.message).toBe("Broker alerts are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("genuine empty (wrapper present, no alerts) → the exact previous 200", async () => {
    okJson({ AlertsResponse: {} });
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ count: 0, alerts: [] });
  });
});

describe("GET /etrade/lookup — failure vs genuine no-match (#243)", () => {
  // The handler's path argument is the bare pathname (as routeRequest
  // passes it); the query rides on the Request/URL only.
  const path = "/api/etrade/lookup";
  const full = "/api/etrade/lookup?search=apple";

  it("missing credentials → 502 naming the cause, no upstream call (was 200 count 0)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleEtradeBrokerActivityRoutes(req(full), urlOf(full), path, USER, brokerCtx(makeBareEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_UPSTREAM");
    expect(body.message).toBe("Broker data is temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 500 → 502 naming the failure", async () => {
    failAllFetches(500, "upstream exploded");
    const res = await handleEtradeBrokerActivityRoutes(req(full), urlOf(full), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_UPSTREAM");
    expect(body.message).toBe("Broker data is temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
  });

  it("genuine no-match (wrapper present, no Data) → the exact previous 200", async () => {
    okJson({ LookupResponse: {} });
    const res = await handleEtradeBrokerActivityRoutes(req(full), urlOf(full), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ count: 0, items: [] });
  });
});

describe("GET /etrade/watchlists — failure vs genuine empty (#243)", () => {
  const path = "/api/etrade/watchlists";

  it("missing credentials + empty local store → 502 naming the cause (was 200 count 0)", async () => {
    const res = await handleWatchlistsRoutes(req(path), urlOf(path), path, USER, watchlistsCtx(makeBareEnv(), makeOrm()));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_WATCHLISTS_UNAVAILABLE");
    expect(body.message).toBe("Broker watchlists are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
  });

  it("genuine empty (empty remote + empty local) → the exact previous 200", async () => {
    okJson({ WatchlistResponse: {} });
    const res = await handleWatchlistsRoutes(req(path), urlOf(path), path, USER, watchlistsCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ count: 0, watchlists: [] });
  });

  it("remote failure + a local durable watchlist → 200 serving the local data, as before", async () => {
    const orm = makeOrm();
    orm.saveWatchlist({ name: "Local One", userLogin: USER, symbols: ["AAPL"] });
    failAllFetches(400);
    const res = await handleWatchlistsRoutes(req(path), urlOf(path), path, USER, watchlistsCtx(await makeAuthedEnv(), orm));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.count).toBe(1);
    expect(body.watchlists[0].name).toBe("Local One");
    expect(body.watchlists[0].source).toBe("local_durable_sqlite");
  });
});

describe("GET /etrade/watchlist/details — failure vs genuine not-found (#243)", () => {
  const numericPath = "/api/etrade/watchlist/details?id=12345";

  it("numeric id + missing credentials → 502 naming the cause (was 404 'not found')", async () => {
    const res = await handleWatchlistsRoutes(req(numericPath), urlOf(numericPath), "/api/etrade/watchlist/details", USER, watchlistsCtx(makeBareEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_WATCHLISTS_UNAVAILABLE");
    expect(body.message).toBe("Broker watchlists are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
    expect(body.message).not.toContain("not found");
  });

  it("numeric id + HTTP 400 → 502 naming the failure (was 404 'not found')", async () => {
    failAllFetches(400);
    const res = await handleWatchlistsRoutes(req(numericPath), urlOf(numericPath), "/api/etrade/watchlist/details", USER, watchlistsCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_WATCHLISTS_UNAVAILABLE");
    expect(body.message).toBe("Broker watchlists are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
  });

  it("genuine not-found (name id, no local entry, no recorded error) → the exact previous 404", async () => {
    const namePath = "/api/etrade/watchlist/details?id=NoSuchList";
    const res = await handleWatchlistsRoutes(req(namePath), urlOf(namePath), "/api/etrade/watchlist/details", USER, watchlistsCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(404);
    expect(await res!.json()).toEqual({ error: "Watchlist 'NoSuchList' not found" });
  });

  it("numeric id + upstream success → 200 with the details, unchanged", async () => {
    okJson({
      WatchlistDetailResponse: { watchlist: { watchlistId: 12345, name: "Main", items: { item: [{ symbol: "AAPL", price: 150 }] } } },
    });
    const res = await handleWatchlistsRoutes(req(numericPath), urlOf(numericPath), "/api/etrade/watchlist/details", USER, watchlistsCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.name).toBe("Main");
    expect(body.symbols).toEqual(["AAPL"]);
  });
});

describe("error-surface hygiene (#243)", () => {
  it("502 bodies never contain credential or token material", async () => {
    failAllFetches(400);
    const path = "/api/etrade/accounts";
    const res = await handleEtradeBrokerRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
    for (const secret of [FAKE_KEY, FAKE_SECRET, FAKE_TOKEN, FAKE_TOKEN_SECRET]) {
      expect(JSON.stringify(body)).not.toContain(secret);
    }
  });
});

describe("GET /etrade/transactions — failure vs genuine empty (#517)", () => {
  const path = "/api/etrade/transactions";

  /** Credentialed env with a preset account key, so the client calls
   * the transactions endpoint directly (no account-resolution leg). */
  async function makeAuthedEnvWithKey(): Promise<Env> {
    const env = makeEnv({ ETRADE_ACCOUNT_ID_KEY: "key1" });
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    return env;
  }

  it("missing credentials → 502 naming the cause, no upstream call (was 200 count 0)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(makeBareEnv(), makeOrm()));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_TRANSACTIONS_UNAVAILABLE");
    expect(body.message).toBe("Broker transactions are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 oauth rejection → 502 naming the failure", async () => {
    failAllFetches(400);
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnvWithKey(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_TRANSACTIONS_UNAVAILABLE");
    expect(body.message).toBe("Broker transactions are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("oauth_problem");
  });

  it("genuine empty (account resolves, wrapper present, no transactions) → the exact previous 200", async () => {
    stubFetchByUrl([
      { match: "/transactions", payload: { TransactionListResponse: {} } },
      {
        match: "/accounts/list",
        payload: {
          AccountListResponse: {
            Accounts: {
              Account: [{ accountId: "1234", accountIdKey: "key1", accountDesc: "Brokerage", accountType: "INDIVIDUAL" }],
            },
          },
        },
      },
    ]);
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ count: 0, transactions: [] });
  });

  it("success → 200 with the transactions, unchanged", async () => {
    okJson({
      TransactionListResponse: {
        Transaction: { transactionId: 987, accountId: "1234", transactionDate: 1700000000000, amount: 42.5, description: "ACH DEPOSIT", transactionType: "ACH" },
      },
    });
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnvWithKey(), makeOrm()));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.count).toBe(1);
    expect(body.transactions[0].transactionId).toBe("987");
    expect(body.transactions[0].description).toBe("ACH DEPOSIT");
  });
});

describe("GET /etrade/transactions/:id — failure vs genuine not-found (#517)", () => {
  const path = "/api/etrade/transactions/txn_001";
  const ACCOUNT_LIST = {
    AccountListResponse: {
      Accounts: {
        Account: [{ accountId: "1234", accountIdKey: "key1", accountDesc: "Brokerage", accountType: "INDIVIDUAL" }],
      },
    },
  };

  it("missing credentials → 502 naming the cause, no upstream call (was 404 'not found')", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(makeBareEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_TRANSACTIONS_UNAVAILABLE");
    expect(body.message).toBe("Broker transactions are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
    expect(body.message).not.toContain("not found");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 oauth rejection → 502 naming the failure (was 404 'not found')", async () => {
    stubFetchByUrl([
      { match: "/transactions/", payload: { Error: { code: 1003, message: "oauth_problem=token_rejected" } }, status: 400 },
      { match: "/accounts/list", payload: ACCOUNT_LIST },
    ]);
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_TRANSACTIONS_UNAVAILABLE");
    expect(body.message).toBe("Broker transactions are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("oauth_problem");
  });

  it("upstream 404 → 502 naming the recorded reason (the #168 contract records it as a failure; the route 404 is for a null with no recorded error)", async () => {
    stubFetchByUrl([
      { match: "/transactions/", payload: { Error: { code: 404, message: "resource not found" } }, status: 404 },
      { match: "/accounts/list", payload: ACCOUNT_LIST },
    ]);
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_TRANSACTIONS_UNAVAILABLE");
    expect(body.message).toBe("Broker transactions are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
  });

  it("success → 200 with the details, unchanged", async () => {
    stubFetchByUrl([
      {
        match: "/transactions/",
        payload: {
          TransactionDetailsResponse: { transactionId: "txn_001", accountId: "1234", transactionDate: 1700000000000, amount: -25.5, description: "Dividend" },
        },
      },
      { match: "/accounts/list", payload: ACCOUNT_LIST },
    ]);
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.transactionId).toBe("txn_001");
    expect(body.description).toBe("Dividend");
    expect(body.amount).toBe(-25.5);
  });
});

describe("GET /etrade/alerts/:id — failure vs genuine not-found (#517)", () => {
  const path = "/api/etrade/alerts/5001";

  it("missing credentials → 502 naming the cause, no upstream call (was 404 'not found')", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(makeBareEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_ALERTS_UNAVAILABLE");
    expect(body.message).toBe("Broker alerts are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
    expect(body.message).not.toContain("not found");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 400 oauth rejection → 502 naming the failure (was 404 'not found')", async () => {
    failAllFetches(400);
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_ALERTS_UNAVAILABLE");
    expect(body.message).toBe("Broker alerts are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("oauth_problem");
  });

  it("upstream 404 → 502 naming the recorded reason (same #168 contract as transaction details)", async () => {
    failAllFetches(404);
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
        expect(body.code).toBe("FAILURE_ETRADE_ALERTS_UNAVAILABLE");
    expect(body.message).toBe("Broker alerts are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.");
    expect(body.error).toBeUndefined();
  });

  it("success → 200 with the details, unchanged", async () => {
    okJson({
      AlertDetailsResponse: { id: 5001, createTime: 1700000000, subject: "Price alert", msgText: "AAPL crossed 150" },
    });
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.id).toBe(5001);
    expect(body.subject).toBe("Price alert");
  });
});

describe("error-surface hygiene (#517)", () => {
  it("transactions and alert-details 502 bodies never contain credential or token material", async () => {
    failAllFetches(400);
    const env = makeEnv({ ETRADE_ACCOUNT_ID_KEY: "key1" });
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    for (const path of ["/api/etrade/transactions", "/api/etrade/alerts/5001"]) {
      const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(env, makeOrm()));
      expect(res!.status).toBe(502);
      const body = (await res!.json()) as any;
      for (const secret of [FAKE_KEY, FAKE_SECRET, FAKE_TOKEN, FAKE_TOKEN_SECRET]) {
        expect(JSON.stringify(body)).not.toContain(secret);
      }
    }
  });
});
