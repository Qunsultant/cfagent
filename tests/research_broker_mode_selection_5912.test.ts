// @vitest-environment node
/**
 * Issue #5912 — a research run can name its venue and mode.
 *
 * Pins:
 *  - 5912-P01 the provider resolves the SELECTED broker and mode through the
 *    platform registry (no hardcoded "etrade" at the call site);
 *  - 5912-P02 no selection keeps today's behaviour: the configured default
 *    broker, no environment override;
 *  - 5912-P03 the run records the venue/mode it used on the report, so a row
 *    can name them instead of guessing;
 *  - 5912-P04 an unknown broker refuses by name (the registry's own
 *    fail-closed rule), before any quote is attempted.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { TradingPlatformRegistry } from "../src/trading";
import { PlatformResearchDataProvider } from "../src/services/researchProviders";
import { runResearchPipeline, type ResearchDataProvider } from "../src/services/researchPipeline";
import { RESEARCH_CONFIG_DEFAULTS, type ResearchConfig } from "../src/services/researchConfig";
import { DEFAULT_TENANT_PROVIDERS } from "../src/data/commercialPorts";

afterEach(() => vi.restoreAllMocks());

const config: ResearchConfig = {
  ...RESEARCH_CONFIG_DEFAULTS,
  universe: "NASDAQ100",
  oodaMaxIterations: 2,
} as ResearchConfig;

function stubProvider(): ResearchDataProvider {
  return {
    getRegime: async () => ({ regime: "neutral", notes: [], asOf: Date.now() }),
    getUniverseSymbols: async () => ["AAPL"],
    getQuote: async () => null,
    getTechnicals: async () => null,
    getCatalysts: async () => null,
    getChain: async () => {
      throw new Error("no chain");
    },
  } as unknown as ResearchDataProvider;
}

describe("5912-P01 the provider resolves the selected broker and mode", () => {
  it("passes the broker id and mode override to the registry", () => {
    const spy = vi
      .spyOn(TradingPlatformRegistry, "getPlatform")
      .mockReturnValue({} as never);

    new PlatformResearchDataProvider(
      {} as never,
      "trader@example.com",
      undefined,
      undefined,
      { brokerId: "alpaca", mode: "paper" },
    );

    expect(spy).toHaveBeenCalledWith(
      "alpaca",
      expect.anything(),
      undefined,
      "trader@example.com",
      "paper",
    );
  });
});

describe("5974-P02 no selection uses the shared platform default", () => {
  it("resolves the shared broker default in paper mode", () => {
    const spy = vi
      .spyOn(TradingPlatformRegistry, "getPlatform")
      .mockReturnValue({} as never);

    new PlatformResearchDataProvider({} as never, "trader@example.com");

    expect(spy).toHaveBeenCalledWith(
      DEFAULT_TENANT_PROVIDERS.brokerId,
      expect.anything(),
      undefined,
      "trader@example.com",
      "paper",
    );
  });
});

describe("5912-P03 the run records the venue and mode it used", () => {
  it("carries brokerId/mode on the report", async () => {
    const report = await runResearchPipeline(
      { provider: stubProvider() },
      config,
      {
        trigger: "manual",
        userLogin: "trader@example.com",
        now: Date.parse("2026-11-20T17:35:02Z"),
        brokerId: "alpaca",
        mode: "paper",
      },
    );

    expect(report.brokerId).toBe("alpaca");
    expect(report.mode).toBe("paper");
  });

  it("omits them when the run named none (today's default path)", async () => {
    const report = await runResearchPipeline(
      { provider: stubProvider() },
      config,
      {
        trigger: "manual",
        userLogin: "trader@example.com",
        now: Date.parse("2026-11-20T17:35:02Z"),
      },
    );

    expect(report.brokerId).toBeUndefined();
    expect(report.mode).toBeUndefined();
  });
});

describe("5912-P04 an unknown broker refuses by name", () => {
  it("throws before any quote is attempted", () => {
    expect(
      () =>
        new PlatformResearchDataProvider(
          { TRADING_MODE: "live" } as never,
          "trader@example.com",
          undefined,
          undefined,
          { brokerId: "not-a-broker" as never },
        ),
    ).toThrow(/not-a-broker|no platform|registered/i);
  });
});
