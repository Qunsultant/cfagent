import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import type { Env } from "../src/types";
import { ETradeRestClient } from "../src/trading/etrade/client";
import { storeAccessTokens } from "../src/security/etradeOAuth";

/**
 * Issue #462: quote errors must be captured per call. One ETradeRestClient
 * serves a whole screener run while quotes fetch concurrently; errors used
 * to travel via the shared mutable `lastError` field, so concurrent calls
 * overwrote and cleared each other's failures and the screener report
 * could not name why symbols failed.
 */
describe("ETradeRestClient.fetchQuoteDetailed — per-call errors under concurrency (#462)", () => {
  let env: Env;
  let kvStorage: Record<string, string>;
  const userLogin = "test_trader_concurrency";

  beforeEach(() => {
    vi.restoreAllMocks();
    kvStorage = {};
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
      GITHUB_CLIENT_ID: "gh_id",
      GITHUB_CLIENT_SECRET: "gh_secret",
      AI_SEARCH_ENDPOINT: "https://ai.example.com",
      SESSION_STORE: sessionStoreNs,
      ETRADE_KV: mockKv,
      ORCHESTRATOR_AGENT: {} as any,
      ASSETS: {} as any,
      AI: {} as any,
      APP_ENV: "TEST",
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_456",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      ETRADE_ACCOUNT_ID_KEY: "ACCOUNT_KEY_XYZ999",
    } as Env;
  });

  it("attributes each concurrent failure to its own symbol, regardless of completion order", async () => {
    await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
    const client = new ETradeRestClient(env, userLogin);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      const sym = decodeURIComponent(url.split("/market/quote/")[1] || "").replace(/\.json$/, "");
      if (sym === "AAA") {
        // Slowest: upstream HTTP 500. Under the old shared-lastError design
        // its error was overwritten by the faster calls before it was read.
        await new Promise((r) => setTimeout(r, 30));
        return new Response("upstream exploded", { status: 500 });
      }
      if (sym === "BBB") {
        // Fastest: HTTP 200 with no quote payload.
        await new Promise((r) => setTimeout(r, 5));
        return new Response(JSON.stringify({ QuoteResponse: { QuoteData: [] } }), { status: 200 });
      }
      // CCC: valid quote, resolves in between.
      await new Promise((r) => setTimeout(r, 15));
      return new Response(
        JSON.stringify({
          QuoteResponse: {
            QuoteData: [
              {
                All: {
                  symbol: "CCC",
                  companyName: "CCC Corp",
                  lastTrade: 123.45,
                  bid: 123.4,
                  ask: 123.5,
                  totalVolume: 1000,
                },
                Product: { symbol: "CCC" },
              },
            ],
          },
        }),
        { status: 200 }
      );
    });

    const [aaa, bbb, ccc] = await Promise.all([
      client.fetchQuoteDetailed("AAA"),
      client.fetchQuoteDetailed("BBB"),
      client.fetchQuoteDetailed("CCC"),
    ]);

    expect(aaa.quote).toBeNull();
    expect(aaa.error).toContain("Quote API Error [HTTP 500]");
    expect(aaa.error).toContain("upstream exploded");

    expect(bbb.quote).toBeNull();
    expect(bbb.error).toContain("returned no quote data for BBB");

    expect(ccc.error).toBeNull();
    expect(ccc.quote?.symbol).toBe("CCC");
    expect(ccc.quote?.lastPrice).toBe(123.45);
  });

  it("fetchQuote wrapper still returns the quote and mirrors the error for sequential callers", async () => {
    await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
    const client = new ETradeRestClient(env, userLogin);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("boom", { status: 503 })
    );
    const quote = await client.fetchQuote("ZZZ");
    expect(quote).toBeNull();
    expect(client.getLastError()).toContain("Quote API Error [HTTP 503]");
  });

  it("reports a missing OAuth token as this call's error without any network call", async () => {
    const client = new ETradeRestClient(env, "no_tokens_user");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await client.fetchQuoteDetailed("NVDA");
    expect(res.quote).toBeNull();
    expect(res.error).toContain("OAuth access token is missing for NVDA");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
