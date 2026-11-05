/**
 * Issue #3351 — Alpaca sign-in.
 *
 * What these tests defend:
 *   1. A pair is stored only after Alpaca verified it (verify-before-store), and
 *      a refusal stores nothing — so a stored credential is a claim that works.
 *   2. Trading types do not cross: a paper record never answers a live read, and
 *      signing out clears both.
 *   3. Precedence is stated: the user's pair wins, the deployment's pair is the
 *      fallback, and neither present is `none` — never paper by inference.
 *   4. No read, route payload, or description ever carries the secret.
 *   5. The status read names the source, so a surface cannot call a deployment
 *      key a user sign-in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { Env } from "../src/types";
import {
  ALPACA_CREDENTIAL_SIDES,
  alpacaCredentialKey,
  describeAlpacaCredential,
  getAlpacaCredentials,
  parseAlpacaCredential,
  revokeAlpacaCredentials,
  storeAlpacaCredentials,
} from "../src/trading/alpaca/credentialStore";
import { resolveAlpacaPair } from "../src/trading/alpaca/credentialResolution";
import { handleBrokerConnectRoutes as handleConnectRoute } from "../src/agents/routes/brokerConnect";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";

/**
 * The handler carries the router's delegation signature (request, url, path,
 * sessionId, ctx — pinned by tests/thin_router_inventory.test.ts). These tests
 * care about the path and the identity, so they adapt the call here instead of
 * repeating four positional arguments at every site.
 */
function handleBrokerConnectRoutes(
  request: Request,
  path: string,
  ctx: Parameters<typeof handleConnectRoute>[4],
): Promise<Response | null> {
  return handleConnectRoute(request, new URL(`https://app.test/api${path}`), path, "session-test", ctx);
}

/**
 * The SessionStore Durable Object as the store client sees it: one POST per
 * operation carrying `{op, ns, key, value}`, one JSON reply per call. Keys are
 * namespaced exactly as the production DO namespaces them (`ns` + key), so a
 * cross-namespace leak would fail here.
 */
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

function envWithStore(): { env: Env; rows: Map<string, string> } {
  const { namespace, rows } = fakeSessionStore();
  return { env: { SESSION_STORE: namespace } as unknown as Env, rows };
}

const plainEnv = (): Env => ({}) as unknown as Env;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("the per-user credential record (#3351)", () => {
  it("round-trips the pair for the side it was stored under", async () => {
    const { env } = envWithStore();
    await storeAlpacaCredentials(env, {
      userLogin: "trader@example.com",
      side: "paper",
      keyId: "PK1234567890",
      secretKey: "paper-secret",
      storedAt: "2026-11-05T00:00:00.000Z",
    });

    const read = await getAlpacaCredentials(env, "trader@example.com", "paper");
    expect(read?.keyId).toBe("PK1234567890");
    expect(read?.secretKey).toBe("paper-secret");
  });

  it("a paper record never answers a live read", async () => {
    const { env } = envWithStore();
    await storeAlpacaCredentials(env, {
      userLogin: "trader@example.com",
      side: "paper",
      keyId: "PK1234567890",
      secretKey: "paper-secret",
    });

    expect(await getAlpacaCredentials(env, "trader@example.com", "live")).toBeNull();
  });

  it("describes the record without the secret", async () => {
    const { env } = envWithStore();
    const stored = await storeAlpacaCredentials(env, {
      userLogin: "trader@example.com",
      side: "live",
      keyId: "AK9999999999",
      secretKey: "live-secret",
    });

    const described = describeAlpacaCredential(stored);
    expect(described).toEqual({ side: "live", keyIdLast4: "9999", storedAt: stored.storedAt });
    expect(JSON.stringify(described)).not.toContain("live-secret");
  });

  it("a malformed record reads as absent rather than half a credential", () => {
    expect(parseAlpacaCredential("not json")).toBeNull();
    expect(parseAlpacaCredential(JSON.stringify({ side: "paper", keyId: "k" }))).toBeNull();
    expect(parseAlpacaCredential(JSON.stringify({ side: "sandbox", keyId: "k", secretKey: "s", userLogin: "u", storedAt: "t" }))).toBeNull();
  });

  it("signing out clears both trading types", async () => {
    const { env, rows } = envWithStore();
    for (const side of ALPACA_CREDENTIAL_SIDES) {
      await storeAlpacaCredentials(env, {
        userLogin: "trader@example.com",
        side,
        keyId: `KEY-${side}`,
        secretKey: `secret-${side}`,
      });
    }
    expect(rows.size).toBe(2);

    await revokeAlpacaCredentials(env, "trader@example.com");

    expect(rows.size).toBe(0);
    expect(await getAlpacaCredentials(env, "trader@example.com", "paper")).toBeNull();
    expect(await getAlpacaCredentials(env, "trader@example.com", "live")).toBeNull();
  });

  it("storing without a session store fails instead of pretending", async () => {
    // A put through an unbound namespace is a silent no-op in the store client;
    // reporting a sign-in that did not happen would be the worse failure.
    await expect(
      storeAlpacaCredentials(plainEnv(), {
        userLogin: "trader@example.com",
        side: "paper",
        keyId: "K",
        secretKey: "S",
      }),
    ).rejects.toThrow(/SESSION_STORE/);
  });

  it("keys are namespaced per login and per side", () => {
    expect(alpacaCredentialKey("Trader@Example.com", "paper")).toBe("alpaca:cred:PAPER:trader@example.com");
    expect(alpacaCredentialKey("trader@example.com", "live")).toBe("alpaca:cred:LIVE:trader@example.com");
  });
});

describe("which pair the adapter uses (#3351)", () => {
  const deployed = {
    ALPACA_PAPER_API_KEY: "deployed-paper-key",
    ALPACA_PAPER_SECRET_KEY: "deployed-paper-secret",
    ALPACA_LIVE_API_KEY: "deployed-live-key",
    ALPACA_LIVE_SECRET_KEY: "deployed-live-secret",
  } as unknown as Env;

  it("a user's verified pair wins over the deployment's", async () => {
    const { env } = envWithStore();
    const scoped = { ...deployed, SESSION_STORE: (env as any).SESSION_STORE } as unknown as Env;
    await storeAlpacaCredentials(scoped, {
      userLogin: "trader@example.com",
      side: "paper",
      keyId: "USER-PAPER-KEY",
      secretKey: "user-paper-secret",
    });

    const pair = await resolveAlpacaPair(scoped, "trader@example.com", "paper");
    expect(pair.source).toBe("user");
    expect(pair.keyId).toBe("USER-PAPER-KEY");
    expect(pair.keyIdLast4).toBe("-KEY");
  });

  it("falls back to the deployment pair and says so", async () => {
    const { env } = envWithStore();
    const scoped = { ...deployed, SESSION_STORE: (env as any).SESSION_STORE } as unknown as Env;

    const pair = await resolveAlpacaPair(scoped, "trader@example.com", "live");
    expect(pair.source).toBe("deployment");
    expect(pair.keyId).toBe("deployed-live-key");
  });

  it("reports none when neither source is configured", async () => {
    const { env } = envWithStore();
    const pair = await resolveAlpacaPair(env, "trader@example.com", "live");
    expect(pair).toEqual({ source: "none", keyId: null, secretKey: null, keyIdLast4: null });
  });

  it("a half-configured deployment pair is none, not a live attempt with no key", async () => {
    const env = { ALPACA_LIVE_API_KEY: "only-a-key" } as unknown as Env;
    const pair = await resolveAlpacaPair(env, "trader@example.com", "live");
    expect(pair.source).toBe("none");
  });

  it("the status read names the source, so a deployment key is not a sign-in", async () => {
    const { env } = envWithStore();
    const platform = new AlpacaTradingPlatform(env, undefined, "trader@example.com", "TEST");
    const status = await platform.getStatus();
    expect(status.credentialSource).toBe("none");
    expect(status.configured).toBe(false);
  });

  it("the status read reports a signed-in user", async () => {
    const { env } = envWithStore();
    await storeAlpacaCredentials(env, {
      userLogin: "trader@example.com",
      side: "paper",
      keyId: "USER-PAPER-KEY",
      secretKey: "user-paper-secret",
    });

    const platform = new AlpacaTradingPlatform(env, undefined, "trader@example.com", "TEST");
    const status = await platform.getStatus();
    expect(status.credentialSource).toBe("user");
    expect(status.keyIdLast4).toBe("-KEY");
    expect(status.configured).toBe(true);
  });
});

describe("the sign-in route (#3351)", () => {
  const ctx = (env: Env) => ({
    env,
    getOrm: () => undefined,
    // TEST selection so the trading type under test is paper, without a pin.
    readSettingRaw: (key: string) => (key === "etrade:environment" ? "TEST" : null),
  });

  function connectRequest(body?: unknown, login = "trader@example.com"): Request {
    return new Request("https://app.test/api/broker/connect/alpaca", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(login ? { "x-user-login": login } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
  }

  it("refuses an anonymous caller", async () => {
    const { env } = envWithStore();
    const res = await handleBrokerConnectRoutes(connectRequest({}, ""), "/broker/connect/alpaca", ctx(env));
    expect(res?.status).toBe(401);
    expect((await res!.json()).code).toBe("FAILURE_AUTH_NO_SESSION");
  });

  it("asks for both halves of the pair", async () => {
    const { env } = envWithStore();
    const res = await handleBrokerConnectRoutes(
      connectRequest({ apiKey: "only-key" }),
      "/broker/connect/alpaca",
      ctx(env),
    );
    expect(res?.status).toBe(400);
    expect((await res!.json()).code).toBe("invalid_request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies before storing: a refused pair writes nothing", async () => {
    const { env, rows } = envWithStore();
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: "unauthorized" }));

    const res = await handleBrokerConnectRoutes(
      connectRequest({ apiKey: "BAD", secretKey: "bad" }),
      "/broker/connect/alpaca",
      ctx(env),
    );

    expect(res?.status).toBe(401);
    const body = await res!.json();
    expect(body.code).toBe("FAILURE_ALPACA_SIGNIN_REJECTED");
    expect(body.message).not.toContain("<");
    expect(rows.size).toBe(0);

    const verifyCall = fetchMock.mock.calls[0];
    expect(String(verifyCall[0])).toContain("paper-api.alpaca.markets");
  });

  it("stores a verified pair and returns only the last four", async () => {
    const { env, rows } = envWithStore();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "acct-123", status: "ACTIVE" }));

    const res = await handleBrokerConnectRoutes(
      connectRequest({ apiKey: "PK7777777777", secretKey: "shhh-secret" }),
      "/broker/connect/alpaca",
      ctx(env),
    );

    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body).toMatchObject({
      broker: "alpaca",
      side: "paper",
      configured: true,
      signedIn: true,
      source: "user",
      keyIdLast4: "7777",
      accountId: "acct-123",
    });
    expect(JSON.stringify(body)).not.toContain("shhh-secret");

    expect(rows.size).toBe(1);
    const stored = await getAlpacaCredentials(env, "trader@example.com", "paper");
    expect(stored?.keyId).toBe("PK7777777777");
  });

  it("reports the source without ever returning the secret", async () => {
    const { env } = envWithStore();
    await storeAlpacaCredentials(env, {
      userLogin: "trader@example.com",
      side: "paper",
      keyId: "PK1234567890",
      secretKey: "paper-secret",
    });

    const req = new Request("https://app.test/api/broker/connect/alpaca", {
      headers: { "x-user-login": "trader@example.com" },
    });
    const res = await handleBrokerConnectRoutes(req, "/broker/connect/alpaca", ctx(env));
    const body = await res!.json();

    expect(body).toMatchObject({
      side: "paper",
      configured: true,
      signedIn: true,
      source: "user",
      keyIdLast4: "7890",
    });
    expect(JSON.stringify(body)).not.toContain("paper-secret");
  });

  it("signing out clears both types and states what remains", async () => {
    const { env, rows } = envWithStore();
    for (const side of ALPACA_CREDENTIAL_SIDES) {
      await storeAlpacaCredentials(env, {
        userLogin: "trader@example.com",
        side,
        keyId: `KEY-${side}`,
        secretKey: `secret-${side}`,
      });
    }

    const req = new Request("https://app.test/api/broker/disconnect/alpaca", {
      method: "POST",
      headers: { "x-user-login": "trader@example.com" },
    });
    const res = await handleBrokerConnectRoutes(req, "/broker/disconnect/alpaca", ctx(env));
    const body = await res!.json();

    expect(body).toMatchObject({ disconnected: true, signedIn: false, source: "none" });
    expect(rows.size).toBe(0);
  });
});
