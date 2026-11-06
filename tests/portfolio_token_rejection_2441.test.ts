/**
 * Issue #2441 (program #2442 slice S2) — portfolio E*TRADE 401
 * token_rejected never propagates: the client recorded the rejection
 * and kept serving the same dead token on every load.
 *
 * This file pins the fix:
 * - A 401 (or a 403 carrying oauth_problem=token_rejected) on alerts /
 *   accounts drops the stored token (all key scopes the seam can reach)
 *   and invalidates the isolate cache, so a subsequent read cannot
 *   re-serve it; the client records the rejection and surfaces a
 *   reconnect signal instead of the same stale "Session Expired" on
 *   every visit.
 * - A 403 WITHOUT a token_rejected marker is not a dead token: it is
 *   recorded exactly as before and the stored token is untouched.
 * - The client carries identity like the panel seam (#2386), so
 *   portfolio reads see the same token the panel sees: a token stored
 *   only under an internal-id key is invisible to an identity-less
 *   client and visible to the client carrying that identity.
 * - Unknown logins fail closed and never receive another login's token.
 * - The rejection propagation is broker-dispatched, not E*TRADE-only:
 *   an unknown broker is a fail-closed no-op that touches nothing
 *   (owner broker-agnostic rule, 2026-10-30; S4 generalizes the dispatch).
 * - No token or secret material ever appears in a recorded error.
 *
 * Deliberately NOT in this slice: renewal-then-retry after a rejection.
 * Renewal presents the stored pair to /oauth/renew_access_token, so a
 * pair E*TRADE already rejected cannot renew itself; the correct action
 * is drop + reconnect signal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

import { ETradeRestClient } from "../src/trading/etrade/client";
import { ETradeService } from "../src/services/etrade";
import {
  getValidTokens,
  storeAccessTokens,
} from "../src/security/etradeOAuth";
import { propagateBrokerTokenRejection } from "../src/security/brokerTokenRejection";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import type { Env } from "../src/types";

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

const USER = "test_trader_2441";
const INTERNAL_ID = "internal_2441";
const FAKE_KEY = "sandbox_consumer_key_2441";
const FAKE_SECRET = "sandbox_consumer_secret_2441";
const FAKE_TOKEN = "sandbox_access_token_2441";
const FAKE_TOKEN_SECRET = "sandbox_access_secret_2441";

const TOKEN_REJECTED_BODY = JSON.stringify({
  Error: { code: 1003, message: "oauth_problem=token_rejected" },
});
const GENERIC_FORBIDDEN_BODY = JSON.stringify({
  Error: { code: 1004, message: "forbidden" },
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

function makeEnvWithStore(): { env: Env; store: Map<string, string> } {
  const kv = makeKv();
  const { namespace, store } = makeFakeSessionStore();
  const env = {
    APP_NAME: "cfagent-test",
    APP_BASE_URL: "https://agent.openaimp.com",
    APP_ENV: "TEST",
    ET_API_KEY: FAKE_KEY,
    ET_API_SECRET: FAKE_SECRET,
    ET_BASE_URL: "https://apisb.etrade.com/v1",
    SESSION_STORE: namespace,
    ETRADE_KV: kv,
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    ASSETS: {} as any,
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
  } as Env;
  return { env, store };
}

async function makeAuthedClient(env: Env): Promise<ETradeRestClient> {
  await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
  return new ETradeRestClient(env, USER);
}

function stubFetch(status: number, body: string) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(body, { status }));
}

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
  __resetTokenCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("401 token_rejected propagation (#2441)", () => {
  it("401 on alerts drops the dead token and records a reconnect signal", async () => {
    const { env } = makeEnvWithStore();
    const client = await makeAuthedClient(env);
    stubFetch(401, TOKEN_REJECTED_BODY);
    expect(await client.fetchAlerts()).toEqual([]);
    expect(client.getLastError()).toContain("Session Expired");
    expect(client.getLastError()).toContain("reconnect");
    const rejection = client.getTokenRejection();
    expect(rejection).not.toBeNull();
    expect(rejection?.endpoint).toBe("alerts");
    expect(rejection?.dropped).toBe(true);
    // A subsequent read cannot re-serve the dead token.
    expect(await getValidTokens(env, USER)).toBeNull();
  });

  it("401 on accounts drops the dead token", async () => {
    const { env } = makeEnvWithStore();
    const client = await makeAuthedClient(env);
    stubFetch(401, TOKEN_REJECTED_BODY);
    expect(await client.fetchAccounts()).toEqual([]);
    expect(client.getTokenRejection()?.endpoint).toBe("accounts");
    expect(client.getTokenRejection()?.dropped).toBe(true);
    expect(await getValidTokens(env, USER)).toBeNull();
  });

  it("403 with a token_rejected marker drops the token; 403 without it does not", async () => {
    const { env } = makeEnvWithStore();
    const client = await makeAuthedClient(env);
    stubFetch(403, TOKEN_REJECTED_BODY);
    await client.fetchAlerts();
    expect(client.getTokenRejection()?.dropped).toBe(true);
    expect(await getValidTokens(env, USER)).toBeNull();

    const { env: env2 } = makeEnvWithStore();
    const client2 = await makeAuthedClient(env2);
    stubFetch(403, GENERIC_FORBIDDEN_BODY);
    await client2.fetchAlerts();
    expect(client2.getLastError()).toBeTruthy();
    expect(client2.getTokenRejection()).toBeNull();
    expect(await getValidTokens(env2, USER)).not.toBeNull();
  });

  it("recorded reasons never contain token or secret material", async () => {
    const { env } = makeEnvWithStore();
    const client = await makeAuthedClient(env);
    stubFetch(401, TOKEN_REJECTED_BODY);
    await client.fetchAlerts();
    const err = client.getLastError() ?? "";
    expect(err).not.toContain(FAKE_TOKEN);
    expect(err).not.toContain(FAKE_TOKEN_SECRET);
    expect(err).not.toContain(FAKE_SECRET);
  });
});

describe("client identity pass-through (#2441)", () => {
  it("a token stored only under an internal-id key is visible only to the client carrying that identity", async () => {
    const { env, store } = makeEnvWithStore();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET, undefined, {
      internalUserId: INTERNAL_ID,
    });
    // Leave only the internal-id key: delete the login-scoped twin.
    store.delete(`etrade:etrade:token:TEST:${USER}`);

    const fetchSpy = stubFetch(401, TOKEN_REJECTED_BODY);
    const noIdentity = new ETradeRestClient(env, USER);
    await noIdentity.fetchAlerts();
    const noIdentityHeader = String(
      (fetchSpy.mock.calls[0]?.[1] as any)?.headers?.Authorization ?? ""
    );
    expect(noIdentityHeader).not.toContain(FAKE_TOKEN);

    fetchSpy.mockClear();
    const withIdentity = new ETradeRestClient(env, USER, undefined, {
      internalUserId: INTERNAL_ID,
    });
    await withIdentity.fetchAlerts();
    const identityHeader = String(
      (fetchSpy.mock.calls[0]?.[1] as any)?.headers?.Authorization ?? ""
    );
    expect(identityHeader).toContain(FAKE_TOKEN);
    // And the identity-carrying client's rejection drops the internal-id token.
    expect(await getValidTokens(env, USER, undefined, { internalUserId: INTERNAL_ID })).toBeNull();
  });

  it("unknown logins fail closed and never receive another login's token", async () => {
    const { env } = makeEnvWithStore();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    const fetchSpy = stubFetch(401, TOKEN_REJECTED_BODY);
    const stranger = new ETradeRestClient(env, "stranger_login_2441");
    await stranger.fetchAlerts();
    const header = String(
      (fetchSpy.mock.calls[0]?.[1] as any)?.headers?.Authorization ?? ""
    );
    expect(header).not.toContain(FAKE_TOKEN);
    expect(await getValidTokens(env, "stranger_login_2441")).toBeNull();
    // The other login's token is untouched by the stranger's rejection.
    expect(await getValidTokens(env, USER)).not.toBeNull();
  });

  it("ETradeService forwards identity to its client", async () => {
    const { env } = makeEnvWithStore();
    const service = new ETradeService(env, env, USER, undefined, undefined, {
      identity: { internalUserId: INTERNAL_ID },
    });
    expect(service.client.identity).toEqual({ internalUserId: INTERNAL_ID });
  });
});

describe("broker-dispatched rejection propagation (#2441)", () => {
  it("an unknown broker is a fail-closed no-op that touches nothing", async () => {
    const { env } = makeEnvWithStore();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    const result = await propagateBrokerTokenRejection({
      broker: "not_a_broker",
      env,
      userLogin: USER,
    });
    expect(result.handled).toBe(false);
    expect(result.dropped).toBe(false);
    expect(await getValidTokens(env, USER)).not.toBeNull();
  });

  it("the etrade branch drops the stored token", async () => {
    const { env } = makeEnvWithStore();
    await storeAccessTokens(env, USER, FAKE_TOKEN, FAKE_TOKEN_SECRET);
    const result = await propagateBrokerTokenRejection({
      broker: "etrade",
      env,
      userLogin: USER,
    });
    expect(result.handled).toBe(true);
    expect(result.dropped).toBe(true);
    expect(await getValidTokens(env, USER)).toBeNull();
  });
});
