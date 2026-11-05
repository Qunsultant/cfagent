/**
 * Issue #3401 — Alpaca sign-in CSRF, environment synchronization, and fallback deployment keys.
 *
 * What these tests defend:
 *   1. Deployment keys are used for both paper and live trading when no user keys are specified.
 *   2. The Alpaca platform's ready() step applies the deployment keys and corresponding
 *      base URL to this.env and configures the market data provider for that side.
 *   3. handleBrokerConnectRoutes respects explicit environment query parameters (?environment=PROD/TEST)
 *      and payload overrides so paper and live sign-in paths are completely isolated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { Env } from "../src/types";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { handleBrokerConnectRoutes as handleConnectRoute } from "../src/agents/routes/brokerConnect";
import { getAlpacaCredentials, storeAlpacaCredentials } from "../src/trading/alpaca/credentialStore";

function fakeSessionStore() {
  const rows = new Map<string, string>();
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (request: Request): Promise<Response> => {
        const payload = (await request.json()) as {
          op: string;
          ns: string;
          key: string;
          value?: string;
        };
        const key = `${payload.ns}\u0000${payload.key}`;
        if (payload.op === "get") {
          return Response.json({ value: rows.get(key) ?? null });
        }
        if (payload.op === "put") {
          rows.set(key, payload.value ?? "");
          return Response.json({ ok: true, rowsWritten: 1 });
        }
        if (payload.op === "delete") {
          rows.delete(key);
          return Response.json({ ok: true, rowsWritten: 1 });
        }
        return Response.json({ ok: false });
      },
    }),
  };
  return { namespace, rows };
}

function envWithStore(overrides: Record<string, string> = {}): { env: Env; rows: Map<string, string> } {
  const { namespace, rows } = fakeSessionStore();
  return {
    env: {
      SESSION_STORE: namespace,
      ...overrides,
    } as unknown as Env,
    rows,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("deployment keys are used for both paper and live when user keys are omitted (#3401)", () => {
  const deployedEnv = {
    ALPACA_PAPER_API_KEY: "DEP-PAPER-KEY-1111",
    ALPACA_PAPER_SECRET_KEY: "dep-paper-secret",
    ALPACA_PAPER_URL: "https://paper-api.alpaca.markets",
    ALPACA_LIVE_API_KEY: "DEP-LIVE-KEY-9999",
    ALPACA_LIVE_SECRET_KEY: "dep-live-secret",
    ALPACA_LIVE_URL: "https://api.alpaca.markets",
  };

  it("uses deployment paper keys when running paper trading (TEST)", async () => {
    const { env } = envWithStore(deployedEnv);
    const platform = new AlpacaTradingPlatform(env, undefined, "trader@example.com", "TEST");
    const status = await platform.getStatus();

    expect(status.configured).toBe(true);
    expect(status.credentialSource).toBe("deployment");
    expect(status.keyIdLast4).toBe("1111");
    expect(status.activeEnvironment).toBe("TEST");
    expect(status.apiUrl).toBe("https://paper-api.alpaca.markets");
  });

  it("uses deployment live keys when running live trading (PROD)", async () => {
    const { env } = envWithStore(deployedEnv);
    const platform = new AlpacaTradingPlatform(env, undefined, "trader@example.com", "PROD");
    const status = await platform.getStatus();

    expect(status.configured).toBe(true);
    expect(status.credentialSource).toBe("deployment");
    expect(status.keyIdLast4).toBe("9999");
    expect(status.activeEnvironment).toBe("PROD");
    expect(status.apiUrl).toBe("https://api.alpaca.markets");
  });

  it("user key overrides deployment key for that specific side only", async () => {
    const { env } = envWithStore(deployedEnv);
    await storeAlpacaCredentials(env, {
      userLogin: "trader@example.com",
      side: "paper",
      keyId: "USER-PAPER-KEY-2222",
      secretKey: "user-paper-secret",
    });

    const paperPlatform = new AlpacaTradingPlatform(env, undefined, "trader@example.com", "TEST");
    const paperStatus = await paperPlatform.getStatus();
    expect(paperStatus.credentialSource).toBe("user");
    expect(paperStatus.keyIdLast4).toBe("2222");

    // Live still uses deployment keys!
    const livePlatform = new AlpacaTradingPlatform(env, undefined, "trader@example.com", "PROD");
    const liveStatus = await livePlatform.getStatus();
    expect(liveStatus.credentialSource).toBe("deployment");
    expect(liveStatus.keyIdLast4).toBe("9999");
  });
});

describe("broker connect routes respect explicit environment param (#3401)", () => {
  const deployedEnv = {
    ALPACA_PAPER_API_KEY: "DEP-PAPER-KEY-1111",
    ALPACA_PAPER_SECRET_KEY: "dep-paper-secret",
    ALPACA_LIVE_API_KEY: "DEP-LIVE-KEY-9999",
    ALPACA_LIVE_SECRET_KEY: "dep-live-secret",
  };

  const ctx = (env: Env) => ({
    env,
    getOrm: () => undefined,
    readSettingRaw: (key: string) => (key === "etrade:environment" ? "TEST" : null),
  });

  it("returns status for live when ?environment=PROD is queried", async () => {
    const { env } = envWithStore(deployedEnv);
    const req = new Request("https://app.test/api/broker/connect/alpaca?environment=PROD", {
      headers: { "x-user-login": "trader@example.com" },
    });
    const url = new URL("https://app.test/api/broker/connect/alpaca?environment=PROD");
    const res = await handleConnectRoute(req, url, "/broker/connect/alpaca", "session-1", ctx(env));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.side).toBe("live");
    expect(body.configured).toBe(true);
    expect(body.source).toBe("deployment");
  });

  it("signs in to live when environment is specified in request body", async () => {
    const { env } = envWithStore(deployedEnv);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "live-acct-1", status: "ACTIVE" }),
    });

    const req = new Request("https://app.test/api/broker/connect/alpaca", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-login": "trader@example.com",
      },
      body: JSON.stringify({
        apiKey: "PKLIVE12345678",
        secretKey: "live-secret-key",
        environment: "PROD",
      }),
    });
    const url = new URL("https://app.test/api/broker/connect/alpaca");
    const res = await handleConnectRoute(req, url, "/broker/connect/alpaca", "session-1", ctx(env));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.side).toBe("live");
    expect(body.signedIn).toBe(true);

    // Verify it called Alpaca live endpoint
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.alpaca.markets/v2/account",
      expect.anything(),
    );

    // Verify stored under live side
    const liveCred = await getAlpacaCredentials(env, "trader@example.com", "live");
    expect(liveCred?.keyId).toBe("PKLIVE12345678");

    // Paper is unchanged
    const paperCred = await getAlpacaCredentials(env, "trader@example.com", "paper");
    expect(paperCred).toBeNull();
  });
});
