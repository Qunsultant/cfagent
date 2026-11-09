/**
 * Issue #3846 — paper requests must use the paper key pair.
 *
 * The deployment carries BOTH `ALPACA_LIVE_*` and `ALPACA_PAPER_*`.
 * The provider used to prefer the live pair unconditionally, so a paper
 * account call sent the live key to `paper-api.alpaca.markets` and Alpaca
 * answered 401 ("Alpaca rejected the order"). This pins side-aware selection.
 */
import { describe, expect, it } from "vitest";
import { AlpacaMarketDataProvider } from "../src/services/marketDataResearch";
import type { Env } from "../src/types";

const BOTH = {
  ALPACA_LIVE_API_KEY: "LIVE_KEY",
  ALPACA_LIVE_SECRET_KEY: "LIVE_SECRET",
  ALPACA_PAPER_API_KEY: "PAPER_KEY",
  ALPACA_PAPER_SECRET_KEY: "PAPER_SECRET",
} as unknown as Env;

describe("Alpaca credential side (#3846)", () => {
  it("paper base selects the paper pair, never the live pair", () => {
    const provider = new AlpacaMarketDataProvider({
      ...BOTH,
      ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
    } as Env);
    expect(provider.getApiKey()).toBe("PAPER_KEY");
    expect(provider.getApiSecret()).toBe("PAPER_SECRET");
  });

  it("live base selects the live pair", () => {
    const provider = new AlpacaMarketDataProvider({
      ...BOTH,
      ALPACA_BASE_URL: "https://api.alpaca.markets",
    } as Env);
    expect(provider.getApiKey()).toBe("LIVE_KEY");
    expect(provider.getApiSecret()).toBe("LIVE_SECRET");
  });

  it("ALPACA_TRADING_TYPE wins over the base URL", () => {
    const paper = new AlpacaMarketDataProvider({
      ...BOTH,
      ALPACA_TRADING_TYPE: "paper",
      ALPACA_BASE_URL: "https://api.alpaca.markets",
    } as Env);
    expect(paper.getApiKey()).toBe("PAPER_KEY");
    const live = new AlpacaMarketDataProvider({
      ...BOTH,
      ALPACA_TRADING_TYPE: "live",
      ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
    } as Env);
    expect(live.getApiKey()).toBe("LIVE_KEY");
  });

  it("unset base is paper, and a missing paper pair falls back to legacy", () => {
    const paper = new AlpacaMarketDataProvider({ ...BOTH } as Env);
    expect(paper.getApiKey()).toBe("PAPER_KEY");
    const legacy = new AlpacaMarketDataProvider({
      ALPACA_API_KEY_ID: "LEGACY_KEY",
      ALPACA_API_SECRET_KEY: "LEGACY_SECRET",
    } as Env);
    expect(legacy.getApiKey()).toBe("LEGACY_KEY");
    expect(legacy.getApiSecret()).toBe("LEGACY_SECRET");
  });
});
