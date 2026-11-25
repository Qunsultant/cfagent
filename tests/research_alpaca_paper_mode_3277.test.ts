// @vitest-environment node
/**
 * Issue #3277 — an OODA run's explicit Alpaca paper selection applies to the
 * provider instance created for that durable J-stack research run, even when
 * the Worker is pinned to live for other capabilities.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TradingPlatformRegistry } from "../src/trading";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { PlatformResearchDataProvider } from "../src/services/researchProviders";
import type { Env } from "../src/types";

afterEach(() => vi.restoreAllMocks());

describe("OODA Alpaca paper selection (#3277)", () => {
  it("uses paper credentials and the paper API host when the deployment is pinned live", async () => {
    const env = {
      ALPACA_TRADING_TYPE: "live",
      ALPACA_BASE_URL: "https://api.alpaca.markets",
      ALPACA_PAPER_API_KEY: "PAPERKEY1234",
      ALPACA_PAPER_SECRET_KEY: "paper-secret",
      ALPACA_PAPER_URL: "https://paper-api.alpaca.markets",
      ALPACA_LIVE_API_KEY: "LIVEKEY5678",
      ALPACA_LIVE_SECRET_KEY: "live-secret",
      ALPACA_LIVE_URL: "https://api.alpaca.markets",
    } as unknown as Env;
    const getPlatform = vi.spyOn(TradingPlatformRegistry, "getPlatform");

    new PlatformResearchDataProvider(env, "researcher@example.com", undefined, undefined, {
      brokerId: "alpaca",
      mode: "paper",
    });

    expect(getPlatform).toHaveBeenCalledWith(
      "alpaca",
      env,
      undefined,
      "researcher@example.com",
      "paper",
    );
    const platform = new AlpacaTradingPlatform(env, undefined, "researcher@example.com", "paper");
    const status = await platform.getStatus();

    expect(status.environment).toBe("paper");
    expect(status.apiUrl).toBe("https://paper-api.alpaca.markets");
    expect(status.keyIdLast4).toBe("1234");
    expect((platform as any).alpacaData.getApiKey()).toBe("PAPERKEY1234");
  });

  it("only scopes the pin for an explicit Alpaca paper research selection", () => {
    const env = { ALPACA_TRADING_TYPE: "live" } as unknown as Env;
    const getPlatform = vi.spyOn(TradingPlatformRegistry, "getPlatform");

    new PlatformResearchDataProvider(env, "researcher@example.com", undefined, undefined, {
      brokerId: "etrade",
      mode: "paper",
    });

    expect(getPlatform.mock.calls[0][1]).toBe(env);
  });

  it("does not borrow live credentials when the paper pair is missing", async () => {
    const env = {
      ALPACA_TRADING_TYPE: "live",
      ALPACA_LIVE_API_KEY: "LIVEKEY5678",
      ALPACA_LIVE_SECRET_KEY: "live-secret",
      ALPACA_LIVE_URL: "https://api.alpaca.markets",
    } as unknown as Env;
    const platform = new AlpacaTradingPlatform(env, undefined, "researcher@example.com", "paper");
    const status = await platform.getStatus();

    expect(status.environment).toBe("paper");
    expect(status.configured).toBe(false);
    expect((platform as any).alpacaData.getApiKey()).toBe("");
  });

  it("keeps the legacy single pair when no mode-specific credentials are configured", async () => {
    const platform = new AlpacaTradingPlatform({
      ALPACA_API_KEY: "LEGACYKEY1234",
      ALPACA_SECRET_KEY: "legacy-secret",
    } as unknown as Env, undefined, "researcher@example.com", "paper");
    const status = await platform.getStatus();

    expect(status.configured).toBe(true);
    expect(status.environment).toBe("paper");
    expect(status.keyIdLast4).toBe("1234");
    expect((platform as any).alpacaData.getApiKey()).toBe("LEGACYKEY1234");
  });
});
