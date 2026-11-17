import { describe, it, expect, vi } from "vitest";
import {
  BROKER_CATALOG,
  TradingPlatformRegistry,
  TastytradeOAuthSession,
  TastytradeTradingPlatform,
  brokerCredentialGuidance,
  brokerPresentation,
  isBrokerId,
  resolveTastytradeBaseUrl,
  resolveTastytradeCredentials,
  storeTastytradeCredential,
  revokeTastytradeCredentials,
  verifyTastytradeAccount,
} from "../src/trading";
import type { Env } from "../src/types";

function makeMemoryDoNamespace() {
  const store = new Map<string, string>();
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const payload = (await request.json()) as { op: string; key: string; value?: string };
      if (payload.op === "get") {
        return Response.json({ ok: true, value: store.get(payload.key) ?? null });
      }
      if (payload.op === "put" && payload.value !== undefined) {
        store.set(payload.key, payload.value);
        return Response.json({ ok: true });
      }
      if (payload.op === "delete") {
        store.delete(payload.key);
        return Response.json({ ok: true });
      }
      return new Response("Bad request", { status: 400 });
    },
  };
  return {
    idFromName: () => "singleton" as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  };
}

describe("Issue #4675 (Gap 21) — Tastytrade catalog, OAuth2 seam & ITradingPlatform", () => {
  it("registers tastytrade in BROKER_CATALOG, brokerPresentation, and TradingPlatformRegistry", () => {
    expect(isBrokerId("tastytrade")).toBe(true);
    expect(BROKER_CATALOG.tastytrade.label).toBe("Tastytrade");
    expect(BROKER_CATALOG.tastytrade.credentialKind).toBe("oauth2_refresh_token");
    expect(BROKER_CATALOG.tastytrade.paperMode).toBe(true);
    expect(BROKER_CATALOG.tastytrade.copilot.supported).toBe(false);

    const pres = brokerPresentation("tastytrade");
    expect(pres.known).toBe(true);
    expect(pres.label).toBe("Tastytrade");

    const guidance = brokerCredentialGuidance("tastytrade");
    expect(guidance.kind).toBe("oauth2_refresh_token");
    expect(guidance.envNames.paper).toContain("TASTYTRADE_PAPER_REFRESH_TOKEN");

    const instance = TradingPlatformRegistry.getPlatform(
      "tastytrade",
      {} as Env,
      undefined,
      "user@example.com",
      "TEST",
    );
    expect(instance.platformId).toBe("tastytrade");
    expect(instance.name).toBe("Tastytrade");
  });

  it("resolves sandbox (TEST) vs live (PROD) host", () => {
    expect(resolveTastytradeBaseUrl({} as Env, "TEST")).toBe("https://api.cert.tastyworks.com");
    expect(resolveTastytradeBaseUrl({} as Env, "PROD")).toBe("https://api.tastyworks.com");
    expect(
      resolveTastytradeBaseUrl({ TASTYTRADE_PAPER_URL: "https://sandbox.example.com/" } as unknown as Env, "TEST"),
    ).toBe("https://sandbox.example.com");
  });

  it("refreshes OAuth2 access token proactively, sends User-Agent, adopts rotated refresh_token, and hides secrets", async () => {
    let now = 1_000_000;
    let callCount = 0;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const headers = init?.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe("cfagent/1.0");
      expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      return Response.json({
        access_token: `tok-${callCount}`,
        expires_in: 900,
        refresh_token: callCount === 1 ? "rotated-rt" : undefined,
      });
    });

    const session = new TastytradeOAuthSession({
      clientSecret: "super-secret-value",
      refreshToken: "initial-rt",
      baseUrl: "https://api.cert.tastyworks.com",
      fetchImpl: fetchMock as unknown as typeof fetch,
      nowMs: () => now,
    });

    expect(await session.getAccessToken()).toBe("tok-1");
    expect(session.currentRefreshToken).toBe("rotated-rt");
    expect(JSON.stringify(session)).not.toContain("super-secret-value");
    expect(JSON.stringify(session)).not.toContain("rotated-rt");

    // Still within validity window — reuses cached token.
    now += 300_000;
    expect(await session.getAccessToken()).toBe("tok-1");
    expect(callCount).toBe(1);

    // Within 60s refresh margin — refreshes proactively.
    now += 550_000;
    expect(await session.getAccessToken()).toBe("tok-2");
    expect(callCount).toBe(2);
  });

  it("never leaks secrets in token refresh error messages", async () => {
    const fetchMock = vi.fn(async () => new Response("invalid_grant", { status: 401 }));
    const session = new TastytradeOAuthSession({
      clientSecret: "my-client-secret-123",
      refreshToken: "my-refresh-token-456",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(session.getAccessToken()).rejects.toThrow(/HTTP 401/);
    await session.getAccessToken().catch((err: Error) => {
      expect(err.message).not.toContain("my-client-secret-123");
      expect(err.message).not.toContain("my-refresh-token-456");
    });
  });

  it("verifies, stores, resolves, and revokes per-user SessionStore credentials", async () => {
    const ns = makeMemoryDoNamespace();
    const env = { SESSION_STORE: ns } as unknown as Env;

    const verifyFetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/oauth/token")) {
        return Response.json({ access_token: "acc-1", expires_in: 900 });
      }
      return Response.json({ data: { items: [{ account: { "account-number": "5WX12345" } }] } });
    });

    const outcome = await verifyTastytradeAccount({
      baseUrl: "https://api.cert.tastyworks.com",
      clientSecret: "sec-1",
      refreshToken: "rt-1234",
      fetchImpl: verifyFetch as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ ok: true, accountNumber: "5WX12345" });

    const desc = await storeTastytradeCredential(env, {
      userLogin: "alice@example.com",
      side: "paper",
      clientSecret: "sec-1",
      refreshToken: "rt-1234",
    });
    expect(desc.refreshTokenLast4).toBe("1234");
    expect(JSON.stringify(desc)).not.toContain("sec-1");

    const resolved = await resolveTastytradeCredentials(env, "alice@example.com", "TEST");
    expect(resolved?.source).toBe("stored");
    expect(resolved?.baseUrl).toBe("https://api.cert.tastyworks.com");

    await revokeTastytradeCredentials(env, "alice@example.com");
    const afterRevoke = await resolveTastytradeCredentials(env, "alice@example.com", "TEST");
    expect(afterRevoke).toBeNull();
  });

  it("executes accounts, positions, quote, dry-run preview, placeOrder, cancel, and orderHistory", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.endsWith("/oauth/token")) {
        return Response.json({ access_token: "tt-access", expires_in: 900 });
      }
      if (u.endsWith("/customers/me/accounts")) {
        return Response.json({
          data: {
            items: [{ account: { "account-number": "5WX999", nickname: "Margin", "account-type-name": "Margin" } }],
          },
        });
      }
      if (u.endsWith("/accounts/5WX999/balances")) {
        return Response.json({
          data: { "equity-buying-power": "10000", "cash-balance": "5000", "net-liquidating-value": "15000" },
        });
      }
      if (u.endsWith("/accounts/5WX999/positions")) {
        return Response.json({
          data: {
            items: [
              {
                symbol: "AAPL",
                "instrument-type": "Equity",
                quantity: "10",
                "quantity-direction": "Long",
                "average-open-price": "180",
                "mark-price": "190",
              },
            ],
          },
        });
      }
      if (u.includes("/market-data/by-type?equity=AAPL")) {
        return Response.json({
          data: { items: [{ symbol: "AAPL", last: "190.5", bid: "190.4", ask: "190.6", "prev-close": "189.0", volume: "1000" }] },
        });
      }
      if (u.endsWith("/accounts/5WX999/orders/dry-run") && method === "POST") {
        return Response.json({
          data: {
            order: { id: "dry-1" },
            "buying-power-effect": { "change-in-buying-power": "-1900.00" },
            "fee-calculation": { "total-fees": "0.00" },
            warnings: [],
          },
        });
      }
      if (u.endsWith("/accounts/5WX999/orders") && method === "POST") {
        return Response.json({ data: { order: { id: "88123", status: "Routed" } } });
      }
      if (u.endsWith("/accounts/5WX999/orders/88123") && method === "DELETE") {
        return Response.json({ data: { status: "Cancelled" } });
      }
      if (u.endsWith("/accounts/5WX999/orders/live")) {
        return Response.json({
          data: {
            items: [
              {
                id: "88123",
                status: "Live",
                "order-type": "Limit",
                "time-in-force": "Day",
                price: "190",
                legs: [{ symbol: "AAPL", quantity: 10, action: "Buy to Open" }],
              },
            ],
          },
        });
      }
      return new Response("Unexpected", { status: 500 });
    });

    const env = {
      TASTYTRADE_CLIENT_SECRET: "sec",
      TASTYTRADE_REFRESH_TOKEN: "rt",
    } as unknown as Env;

    const platform = new TastytradeTradingPlatform(env, undefined, "user@example.com", "TEST", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const accounts = await platform.getAccounts();
    expect(accounts[0].accountId).toBe("5WX999");
    expect(accounts[0].totalAccountValue).toBe(15000);

    const pos = await platform.getPositions("5WX999");
    expect(pos.positions[0].symbol).toBe("AAPL");
    expect(pos.positions[0].quantity).toBe(10);

    const quote = await platform.getQuote("AAPL");
    expect(quote.lastPrice).toBe(190.5);

    const draft = await platform.previewOrder({
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      orderType: "LIMIT",
      limitPrice: 190,
      timeInForce: "day",
    });
    expect(draft.previewId).toBe("dry-1");
    expect(draft.estimatedTotal).toBe(1900);

    const placed = await platform.placeOrderRemote({
      orderId: draft.orderId,
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      orderType: "LIMIT",
      limitPrice: 190,
      userLogin: "user@example.com",
    });
    expect(placed.success).toBe(true);
    expect(placed.brokerOrderRef).toBe("88123");

    const cancelled = await platform.cancelOrderRemote("88123", "5WX999");
    expect(cancelled.success).toBe(true);

    const orders = await platform.getOrderHistory("open");
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("OPEN");
  });
});
