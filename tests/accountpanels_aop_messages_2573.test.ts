/** @vitest-environment jsdom */
/**
 * Issue #2573: AccountPanels broker errors through the outcome catalog.
 *
 * Pins the three cases the old route tests did not cover, plus the
 * client/panel end of the contract:
 *
 * (a) Missing OAuth token (the live symptom:
 *     `oauth_problem=parameter_absent`) -> 401
 *     FAILURE_AUTH_TOKEN_MISSING, with no `oauth_problem` text in
 *     the response body. This is distinct from "missing consumer
 *     credentials" (bare env): here the consumer key/secret ARE
 *     configured, but no token is stored for the user.
 * (b) Upstream 400/500 for alerts and transactions -> the new
 *     per-section coded message, no raw upstream body in the body
 *     (covered for the routes in
 *     tests/etrade_read_routes_error_surfacing.test.ts after its
 *     #2573 update; the client translation is pinned here).
 * (c) Genuine empty (no recorded error) still returns 200 with an
 *     empty list (also covered in the route file; one case here
 *     guards the missing-token harness from masking it).
 * (d) The panel renders the coded message, not the raw error:
 *     `AccountPanels` fed coded 502 bodies renders the coded
 *     business messages and no raw broker text.
 *
 * The classification is structural, not string-matching: the client
 * records `lastErrorKind` at the point of failure
 * (`generateOAuthHeader` -> token_missing,
 * `handleUpstreamAuthError` -> token_expired), and the route layer
 * maps that kind plus the section to a catalog code. No test here
 * asserts on the raw `lastError` string itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { makeFakeSessionStore } from "./fake-session-store";
import { handleEtradeBrokerActivityRoutes, type EtradeBrokerRouteContext } from "../src/agents/routes/etradeBroker";
import { handleWatchlistsRoutes, type WatchlistsRouteContext } from "../src/agents/routes/watchlists";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import { storeAccessTokens } from "../src/security/etradeOAuth";
import type { Env } from "../src/types";
import { fetchAlerts, fetchTransactions, fetchWatchlists, ACCOUNT_PANEL_FALLBACK_MESSAGE } from "../src/client/accountApi";
import { AccountPanels } from "../src/client/AccountPanels";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AMBIENT_ET_CREDENTIAL_VARS = [
  "ET_API_KEY", "ET_API_SECRET", "ETRADE_API_KEY", "ETRADE_API_SECRET",
  "ETRADE_CONSUMER_KEY", "ETRADE_CONSUMER_SECRET", "ET_PROD_API_KEY",
  "ET_PROD_API_SECRET", "PROD_ET_API_KEY", "PROD_ET_API_SECRET",
  "ETRADE_PROD_CONSUMER_KEY", "ETRADE_PROD_CONSUMER_SECRET",
  "ET_SANDBOX_API_KEY", "ET_SANDBOX_API_SECRET", "SANDBOX_ET_API_KEY",
  "SANDBOX_ET_API_SECRET", "ETRADE_SANDBOX_CONSUMER_KEY",
  "ETRADE_SANDBOX_CONSUMER_SECRET", "ET_BASE_URL", "ET_PROD_BASE_URL",
];

beforeEach(() => {
  vi.restoreAllMocks();
  for (const name of AMBIENT_ET_CREDENTIAL_VARS) vi.stubEnv(name, "");
  __resetTokenCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const USER = "test_trader_2573";
const FAKE_KEY = "sandbox_consumer_key_2573";
const FAKE_SECRET = "sandbox_consumer_secret_2573";
const FAKE_TOKEN = "sandbox_access_token_2573";
const FAKE_TOKEN_SECRET = "sandbox_access_token_secret_2573";

/** Live symptom body: token absent, not token rejected. */
const PARAMETER_ABSENT_BODY = JSON.stringify({
  Error: { message: "oauth_problem=parameter_absent,oauth_parameters_absent=oauth_token" },
});
const TOKEN_REJECTED_BODY = JSON.stringify({
  Error: { code: 1003, message: "oauth_problem=token_rejected" },
});

function makeKv() {
  const storage: Record<string, string> = {};
  return {
    get: vi.fn(async (k: string) => storage[k] || null),
    put: vi.fn(async (k: string, v: string) => { storage[k] = v; }),
    delete: vi.fn(async (k: string) => { delete storage[k]; }),
  } as any;
}

/** Env WITH sandbox consumer credentials, but NO stored user token. */
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

async function makeAuthedEnv(): Promise<Env> {
  const env = makeEnv();
  await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
  return env;
}

function makeOrm(): DatabaseORM {
  const orm = new DatabaseORM(new MockSqlStorage());
  orm.initializeSchema("test_session_2573");
  return orm;
}

function brokerCtx(env: Env, orm: DatabaseORM): EtradeBrokerRouteContext {
  return {
    env,
    getOrm: () => orm,
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
  return { env, getOrm: () => orm, requestedEnv: undefined } as WatchlistsRouteContext;
}

const req = (path: string) =>
  new Request(`https://agent.internal${path}`, { method: "GET", headers: { "x-user-login": USER } });
const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

function failAllFetches(status: number, body: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body, { status }));
}

describe("missing token -> coded auth message (#2573a)", () => {
  it("alerts with no stored token and upstream 400 parameter_absent -> 401 FAILURE_AUTH_TOKEN_MISSING, no oauth_problem in body", async () => {
    failAllFetches(400, PARAMETER_ABSENT_BODY);
    const path = "/api/etrade/alerts";
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(makeEnv(), makeOrm()));
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_AUTH_TOKEN_MISSING");
    expect(body.message).toBe("Authentication required. Please reconnect your brokerage account.");
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("oauth_problem");
  });

  it("transactions with no stored token and upstream 400 parameter_absent -> 401 FAILURE_AUTH_TOKEN_MISSING", async () => {
    failAllFetches(400, PARAMETER_ABSENT_BODY);
    const path = "/api/etrade/transactions";
    const res = await handleEtradeBrokerActivityRoutes(
      req(path), urlOf(path), path, USER,
      brokerCtx(makeEnv({ ETRADE_ACCOUNT_ID_KEY: "key1" }), makeOrm()),
    );
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_AUTH_TOKEN_MISSING");
    expect(JSON.stringify(body)).not.toContain("oauth_problem");
  });

  it("watchlists with no stored token and upstream 400 parameter_absent -> 401 FAILURE_AUTH_TOKEN_MISSING", async () => {
    failAllFetches(400, PARAMETER_ABSENT_BODY);
    const path = "/api/etrade/watchlists";
    const res = await handleWatchlistsRoutes(req(path), urlOf(path), path, USER, watchlistsCtx(makeEnv(), makeOrm()));
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_AUTH_TOKEN_MISSING");
    expect(JSON.stringify(body)).not.toContain("oauth_problem");
  });

  it("rejected token (401 token_rejected) -> 401 FAILURE_AUTH_TOKEN_EXPIRED, no oauth_problem in body", async () => {
    failAllFetches(401, TOKEN_REJECTED_BODY);
    const path = "/api/etrade/alerts";
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_AUTH_TOKEN_EXPIRED");
    expect(body.message).toBe("E*TRADE connection expired. Please reconnect your account in Settings.");
    expect(JSON.stringify(body)).not.toContain("oauth_problem");
  });

  it("genuine empty alerts (wrapper present, no alerts) still returns 200, unchanged", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ AlertsResponse: {} }), { status: 200 }));
    const path = "/api/etrade/alerts";
    const res = await handleEtradeBrokerActivityRoutes(req(path), urlOf(path), path, USER, brokerCtx(await makeAuthedEnv(), makeOrm()));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ count: 0, alerts: [] });
  });
});

describe("accountApi translation (#2573b/d)", () => {
  function stubPanelFetch() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/etrade/alerts")) {
        return Response.json({ code: "FAILURE_ETRADE_ALERTS_UNAVAILABLE", message: "Broker alerts are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.", retryable: true }, { status: 502 });
      }
      if (url.includes("/etrade/transactions")) {
        return Response.json({ code: "FAILURE_ETRADE_TRANSACTIONS_UNAVAILABLE", message: "Broker transactions are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.", retryable: true }, { status: 502 });
      }
      if (url.includes("/etrade/watchlists")) {
        return Response.json({ code: "FAILURE_ETRADE_WATCHLISTS_UNAVAILABLE", message: "Broker watchlists are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.", retryable: true }, { status: 502 });
      }
      if (url.includes("/etrade/orders/remote")) {
        return Response.json({ code: "FAILURE_ETRADE_ORDERS_UNAVAILABLE", message: "Broker orders are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.", retryable: true }, { status: 502 });
      }
      throw new Error(`unstubbed fetch: ${url}`);
    });
  }

  it("coded 502 body -> fetchAlerts rejects with the coded message, not the raw string", async () => {
    stubPanelFetch();
    await expect(fetchAlerts("TEST")).rejects.toThrow(
      "[FAILURE_ETRADE_ALERTS_UNAVAILABLE] Broker alerts are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.",
    );
  });

  it("legacy raw error body -> fetchTransactions rejects with the generic coded fallback, never the raw string", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: "E*TRADE Transactions API Error [HTTP 400]: oauth_problem=parameter_absent" }, { status: 502 }),
    );
    const err = await fetchTransactions("TEST").catch((e) => e);
    expect(err.message).toBe(ACCOUNT_PANEL_FALLBACK_MESSAGE);
    expect(err.message).not.toContain("oauth_problem");
    expect(err.message).toContain("FAILURE_ETRADE_UPSTREAM");
  });

  it("legacy raw error body -> fetchWatchlists rejects with the generic coded fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: "E*TRADE OAuth Token Missing: oauth_problem=parameter_absent" }, { status: 502 }),
    );
    const err = await fetchWatchlists("TEST").catch((e) => e);
    expect(err.message).toBe(ACCOUNT_PANEL_FALLBACK_MESSAGE);
    expect(err.message).not.toContain("oauth_problem");
  });
});

describe("AccountPanels renders coded messages (#2573d)", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function flush(ms = 30) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  async function waitForText(text: string, timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (container.textContent?.includes(text)) return;
      await flush(50);
    }
    throw new Error(`Timed out waiting for "${text}". Panel text: ${container.textContent?.slice(0, 800)}`);
  }

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container?.remove();
  });

  it("coded 502 bodies for all four panels render as coded messages, with no raw broker text", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("/etrade/alerts")) {
        return Response.json({ code: "FAILURE_ETRADE_ALERTS_UNAVAILABLE", message: "Broker alerts are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.", retryable: true }, { status: 502 });
      }
      if (url.includes("/etrade/transactions")) {
        return Response.json({ code: "FAILURE_ETRADE_TRANSACTIONS_UNAVAILABLE", message: "Broker transactions are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.", retryable: true }, { status: 502 });
      }
      if (url.includes("/etrade/watchlists")) {
        return Response.json({ code: "FAILURE_ETRADE_WATCHLISTS_UNAVAILABLE", message: "Broker watchlists are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.", retryable: true }, { status: 502 });
      }
      if (url.includes("/etrade/orders/remote")) {
        return Response.json({ code: "FAILURE_ETRADE_ORDERS_UNAVAILABLE", message: "Broker orders are temporarily unavailable. Please try again, and reconnect your E*TRADE account if the problem persists.", retryable: true }, { status: 502 });
      }
      throw new Error(`unstubbed fetch: ${url}`);
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(AccountPanels, { activeEnv: "TEST" }));
    });
    await waitForText("Broker alerts are temporarily unavailable");
    await waitForText("Broker transactions are temporarily unavailable");
    await waitForText("Broker watchlists are temporarily unavailable");
    await waitForText("Broker orders are temporarily unavailable");
    expect(container.textContent).not.toContain("oauth_problem");
    expect(container.textContent).not.toContain("API Error [HTTP");
    expect(container.textContent).toContain("FAILURE_ETRADE_ALERTS_UNAVAILABLE");
  });
});
