import { describe, expect, it, vi } from "vitest";
import {
  createAlpacaDataProvider,
  fetchAlpacaNewsArticles,
} from "../src/trading/dataProviders/adapters";
import { dataProviderSupportsCapability } from "../src/services/optionsProviderContext";
import { AlpacaMarketDataProvider } from "../src/services/marketDataResearch";
import type { Env } from "../src/types";

describe("Alpaca news & Gap 20 data gaps (#4674)", () => {
  it("declares news capability on Alpaca in DATA_PROVIDER_CAPABILITIES and adapter", () => {
    expect(dataProviderSupportsCapability("alpaca", "news")).toBe(true);
    expect(dataProviderSupportsCapability("alpaca", "fundamentals")).toBe(false);
    const provider = createAlpacaDataProvider(
      new AlpacaMarketDataProvider({} as Env),
      {} as Env,
    );
    expect(provider.capabilities).toContain("news");
    expect(typeof provider.getNews).toBe("function");
  });

  it("fetchAlpacaNewsArticles fails closed when credentials are missing", async () => {
    await expect(fetchAlpacaNewsArticles("AAPL", {} as Env)).rejects.toThrow(
      /credentials/i,
    );
  });

  it("fetchAlpacaNewsArticles maps /v1beta1/news articles and tags provenance as alpaca", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          news: [
            {
              id: 1,
              headline: "Apple launches new hardware",
              source: "benzinga",
              created_at: "2026-11-17T08:00:00Z",
              url: "https://example.com/apple-news",
              summary: "Details about the launch.",
            },
            {
              id: 2,
              headline: "",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const env = {
        ALPACA_API_KEY: "alpaca-key",
        ALPACA_SECRET_KEY: "alpaca-secret",
      } as unknown as Env;
      const provider = createAlpacaDataProvider(
        new AlpacaMarketDataProvider(env),
        env,
      );
      const envelope = await provider.getNews!("aapl");
      expect(envelope.providerId).toBe("alpaca");
      expect(envelope.capability).toBe("news");
      expect(envelope.result).toHaveLength(1);
      expect(envelope.result[0]).toMatchObject({
        headline: "Apple launches new hardware",
        source: "benzinga",
        publishedAt: "2026-11-17T08:00:00.000Z",
        symbol: "AAPL",
        url: "https://example.com/apple-news",
        summary: "Details about the launch.",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://data.alpaca.markets/v1beta1/news?symbols=AAPL&limit=5",
        expect.objectContaining({
          headers: expect.objectContaining({
            "APCA-API-KEY-ID": "alpaca-key",
            "APCA-API-SECRET-KEY": "alpaca-secret",
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
