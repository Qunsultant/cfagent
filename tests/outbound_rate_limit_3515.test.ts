import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import type { Env } from "../src/types";
import { storeAccessTokens } from "../src/security/etradeOAuth";
import { ETradeRestClient } from "../src/trading/etrade/client";
import { AlpacaMarketDataProvider } from "../src/services/marketDataResearch";
import {
  fetchAlpacaOptionContracts,
  type AlpacaOptionsConfig,
} from "../src/trading/alpaca/optionsData";
import {
  createOutboundRateLimiter,
  getSharedOutboundLimiter,
  resetSharedOutboundLimiters,
  resolveOutboundRateLimitConfig,
  OutboundRateLimitError,
} from "../src/security/outboundRateLimiter";

/**
 * Issue #3515 S1 — outgoing rate limiting (§7.2).
 *
 * The audit (slice 0) found the incoming token bucket real
 * (src/security/rateLimiter.ts) and the outgoing half NOT FOUND on
 * every external connector. This file pins the new outbound limiter
 * and its wiring at each client's central seam: E*TRADE REST client,
 * Alpaca provider (+ options data plane), and the LLM model-turn
 * seams (generateTextModelTurn / executeModelCall).
 */
vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({ text: "hello" })),
  generateObject: vi.fn(async () => ({ object: {} })),
  stepCountIs: vi.fn(() => "stop-when-stub"),
}));

import { generateText } from "ai";
import { generateTextModelTurn } from "../src/actors/actorTurnRunner";
import { executeModelCall } from "../src/gateway/gatewayModelCall";

const mockedGenerateText = vi.mocked(generateText);

describe("outbound rate limiter unit (#3515 S1)", () => {
  beforeEach(() => {
    resetSharedOutboundLimiters();
    vi.restoreAllMocks();
  });

  function fakeClockLimiter(opts: { maxRequests: number; windowMs: number; maxWaitMs: number }) {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const limiter = createOutboundRateLimiter(undefined, "etrade", {
      ...opts,
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    return { limiter, sleeps, advance: (ms: number) => (now += ms), now: () => now };
  }

  it("allows a full burst, then waits for a refill and proceeds", async () => {
    const { limiter, sleeps } = fakeClockLimiter({ maxRequests: 2, windowMs: 1_000, maxWaitMs: 5_000 });
    await limiter.acquire();
    await limiter.acquire();
    // Third acquire: bucket empty, one token refills after 500ms.
    await limiter.acquire();
    expect(sleeps).toEqual([500]);
  });

  it("refills continuously: a full window restores the whole burst", async () => {
    const { limiter, sleeps, advance } = fakeClockLimiter({ maxRequests: 2, windowMs: 1_000, maxWaitMs: 5_000 });
    await limiter.acquire();
    await limiter.acquire();
    advance(1_000);
    await limiter.acquire();
    await limiter.acquire();
    expect(sleeps).toEqual([]);
  });

  it("throws a typed error when the bounded wait is exhausted, without sleeping past the bound", async () => {
    const { limiter, sleeps } = fakeClockLimiter({ maxRequests: 1, windowMs: 60_000, maxWaitMs: 100 });
    await limiter.acquire();
    let caught: unknown;
    try {
      await limiter.acquire();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OutboundRateLimitError);
    const typed = caught as OutboundRateLimitError;
    expect(typed.connector).toBe("etrade");
    expect(typed.retryAfterMs).toBeGreaterThan(0);
    expect(typed.message).toContain("Outbound rate limit");
    expect(sleeps).toEqual([]);
  });

  it("keeps per-instance budgets independent", async () => {
    const a = fakeClockLimiter({ maxRequests: 1, windowMs: 60_000, maxWaitMs: 0 });
    const b = fakeClockLimiter({ maxRequests: 1, windowMs: 60_000, maxWaitMs: 0 });
    await a.limiter.acquire();
    // b is a different client instance: its own burst is untouched.
    await expect(b.limiter.acquire()).resolves.toBeUndefined();
    await expect(a.limiter.acquire()).rejects.toBeInstanceOf(OutboundRateLimitError);
  });

  it("resolves conservative defaults with no env", () => {
    expect(resolveOutboundRateLimitConfig(undefined, "etrade")).toEqual({
      maxRequests: 120,
      windowMs: 60_000,
      maxWaitMs: 10_000,
    });
    expect(resolveOutboundRateLimitConfig(undefined, "alpaca").maxRequests).toBe(120);
    expect(resolveOutboundRateLimitConfig(undefined, "llm").maxRequests).toBe(120);
  });

  it("honors per-connector env knobs and falls back on invalid values", () => {
    expect(
      resolveOutboundRateLimitConfig({ ETRADE_OUTBOUND_RPM: "5" }, "etrade").maxRequests,
    ).toBe(5);
    expect(
      resolveOutboundRateLimitConfig({ ALPACA_OUTBOUND_RPM: "7" }, "alpaca").maxRequests,
    ).toBe(7);
    expect(resolveOutboundRateLimitConfig({ LLM_OUTBOUND_RPM: "9" }, "llm").maxRequests).toBe(9);
    expect(
      resolveOutboundRateLimitConfig(
        { ETRADE_OUTBOUND_RPM: "abc", OUTBOUND_RATE_LIMIT_MAX_WAIT_MS: "250" },
        "etrade",
      ),
    ).toEqual({ maxRequests: 120, windowMs: 60_000, maxWaitMs: 250 });
    // Zero / negative RPM is not a limit: default applies, never fail-closed.
    expect(resolveOutboundRateLimitConfig({ ETRADE_OUTBOUND_RPM: "0" }, "etrade").maxRequests).toBe(120);
    // A zero max wait is an explicit fail-fast: honored, not defaulted.
    expect(
      resolveOutboundRateLimitConfig({ OUTBOUND_RATE_LIMIT_MAX_WAIT_MS: "0" }, "etrade").maxWaitMs,
    ).toBe(0);
  });

  it("memoizes one shared limiter per connector until reset", () => {
    const first = getSharedOutboundLimiter("llm");
    expect(getSharedOutboundLimiter("llm")).toBe(first);
    resetSharedOutboundLimiters();
    expect(getSharedOutboundLimiter("llm")).not.toBe(first);
  });
});

function validQuoteResponse(symbol: string): Response {
  return new Response(
    JSON.stringify({
      QuoteResponse: {
        QuoteData: [
          {
            All: {
              symbol,
              companyName: `${symbol} Corp`,
              lastTrade: 10.5,
              bid: 10.4,
              ask: 10.6,
              totalVolume: 100,
            },
            Product: { symbol },
          },
        ],
      },
    }),
    { status: 200 },
  );
}

describe("outgoing throttle at the E*TRADE client seam (#3515 S1)", () => {
  let env: Env;
  const userLogin = "test_trader_outbound_3515";

  beforeEach(() => {
    vi.restoreAllMocks();
    const kvStorage: Record<string, string> = {};
    const mockKv = {
      get: vi.fn(async (k: string) => kvStorage[k] || null),
      put: vi.fn(async (k: string, v: string) => {
        kvStorage[k] = v;
      }),
      delete: vi.fn(async (k: string) => {
        delete kvStorage[k];
      }),
    } as any;
    const { namespace: sessionStoreNs } = makeFakeSessionStore();
    env = {
      APP_NAME: "cfagent-test",
      APP_BASE_URL: "https://agent.openaimp.com",
      SESSION_SECRET: "test_session_secret_123",
      SESSION_STORE: sessionStoreNs,
      ETRADE_KV: mockKv,
      ORCHESTRATOR_AGENT: {} as any,
      ASSETS: {} as any,
      AI: {} as any,
      APP_ENV: "TEST",
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_456",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
    } as Env;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throttles the second quote on one client when the bucket is spent (fail-fast, per-call error)", async () => {
    (env as Record<string, string>).ETRADE_OUTBOUND_RPM = "1";
    (env as Record<string, string>).OUTBOUND_RATE_LIMIT_MAX_WAIT_MS = "0";
    await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
    const client = new ETradeRestClient(env, userLogin);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      const sym = decodeURIComponent(url.split("/market/quote/")[1] || "").replace(/\.json$/, "");
      return validQuoteResponse(sym || "AAA");
    });

    const first = await client.fetchQuoteDetailed("AAA");
    expect(first.error).toBeNull();
    expect(first.quote?.symbol).toBe("AAA");

    const second = await client.fetchQuoteDetailed("BBB");
    expect(second.quote).toBeNull();
    expect(second.error).toContain("Outbound rate limit");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not throttle ordinary use under the default limits", async () => {
    await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
    const client = new ETradeRestClient(env, userLogin);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      const sym = decodeURIComponent(url.split("/market/quote/")[1] || "").replace(/\.json$/, "");
      return validQuoteResponse(sym || "AAA");
    });
    const [a, b] = await Promise.all([
      client.fetchQuoteDetailed("AAA"),
      client.fetchQuoteDetailed("BBB"),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
  });
});

describe("outgoing throttle at the Alpaca provider seam (#3515 S1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSharedOutboundLimiters();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throttles the second account read on one provider when the bucket is spent", async () => {
    const env = {
      ALPACA_OUTBOUND_RPM: "1",
      OUTBOUND_RATE_LIMIT_MAX_WAIT_MS: "0",
      ALPACA_API_KEY: "test_key_id",
      ALPACA_API_SECRET_KEY: "test_secret",
    } as unknown as Env;
    const provider = new AlpacaMarketDataProvider(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ id: "acct-1", status: "ACTIVE" }), { status: 200 }),
    );

    const first = await provider.getAccount();
    expect(first.success).toBe(true);

    const second = await provider.getAccount();
    expect(second.success).toBe(false);
    expect(second.message).toContain("Outbound rate limit");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throttles the Alpaca options data plane through the provider's limiter", async () => {
    const provider = new AlpacaMarketDataProvider({
      ALPACA_OUTBOUND_RPM: "1",
      OUTBOUND_RATE_LIMIT_MAX_WAIT_MS: "0",
      ALPACA_API_KEY: "test_key_id",
      ALPACA_API_SECRET_KEY: "test_secret",
    } as unknown as Env);
    const cfg: AlpacaOptionsConfig = {
      tradingUrl: "https://paper-api.alpaca.markets",
      dataUrl: "https://data.alpaca.markets",
      headers: { "APCA-API-KEY-ID": "test_key_id", "APCA-API-SECRET-KEY": "test_secret" },
      rateLimiter: provider.outboundLimiter,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          option_contracts: [
            {
              symbol: "AAPL260116C00200000",
              underlying_symbol: "AAPL",
              expiration_date: "2026-01-16",
              strike_price: 200,
              type: "call",
            },
          ],
          next_page_token: "tok-next",
        }),
        { status: 200 },
      ),
    );

    // Page 1 consumes the single token; page 2 must fail closed with the typed error.
    await expect(fetchAlpacaOptionContracts(cfg, { symbol: "AAPL" })).rejects.toBeInstanceOf(
      OutboundRateLimitError,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves the options data plane unthrottled when no limiter is supplied", async () => {
    const cfg: AlpacaOptionsConfig = {
      tradingUrl: "https://paper-api.alpaca.markets",
      dataUrl: "https://data.alpaca.markets",
      headers: { "APCA-API-KEY-ID": "k", "APCA-API-SECRET-KEY": "s" },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          option_contracts: [
            {
              symbol: "AAPL260116C00200000",
              underlying_symbol: "AAPL",
              expiration_date: "2026-01-16",
              strike_price: 200,
              type: "call",
            },
          ],
          next_page_token: null,
        }),
        { status: 200 },
      ),
    );
    const rows = await fetchAlpacaOptionContracts(cfg, { symbol: "AAPL" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.symbol).toBe("AAPL260116C00200000");
  });
});

describe("outgoing throttle at the LLM model-turn seams (#3515 S1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSharedOutboundLimiters();
    mockedGenerateText.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throttles the second actor turn when the shared LLM bucket is spent", async () => {
    getSharedOutboundLimiter("llm", { maxRequests: 1, maxWaitMs: 0 });
    const turn = {
      model: { modelId: "@cf/meta/llama-3.1-8b-instruct" },
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
    } as any;

    const first = await generateTextModelTurn(turn);
    expect(first.text).toBe("hello");
    await expect(generateTextModelTurn(turn)).rejects.toBeInstanceOf(OutboundRateLimitError);
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
  });

  it("throttles the second gateway model call when the shared LLM bucket is spent", async () => {
    getSharedOutboundLimiter("llm", { maxRequests: 1, maxWaitMs: 0 });
    const model = { modelId: "@cf/meta/llama-3.1-8b-instruct" };
    const input = { model: "@cf/meta/llama-3.1-8b-instruct", prompt: "hi" } as any;

    const first = await executeModelCall(model, input);
    expect(first.text).toBe("hello");
    await expect(executeModelCall(model, input)).rejects.toBeInstanceOf(OutboundRateLimitError);
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
  });

  it("does not throttle ordinary use under the default LLM limits", async () => {
    const turn = {
      model: { modelId: "@cf/meta/llama-3.1-8b-instruct" },
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
    } as any;
    const res = await generateTextModelTurn(turn);
    expect(res.text).toBe("hello");
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
  });
});
