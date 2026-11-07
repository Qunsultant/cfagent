/**
 * Issue #3655 — scheduled screener jobs are broker independent.
 *
 * Pins:
 * (a) an Alpaca-broker tenant's scheduled options run never touches
 *     E*TRADE — the broker guard resolves Alpaca credentials instead
 *     of the E*TRADE preflight, and the sharded chain source resolves
 *     the Alpaca chain source instead of createETradeService;
 * (b) a missing Alpaca credential fails loud and coded, naming Alpaca,
 *     never E*TRADE;
 * (c) a scheduled stock run for Alpaca resolves the Alpaca provider;
 * (d) the schedule payload carries broker + data provider + mode,
 *     stamped server-side (identity wins over caller-supplied values);
 * (e) the Alpaca stock-quote path acquires through the Alpaca adapter
 *     and reports Alpaca provenance, never E*TRADE;
 * (f) the run record carries the EFFECTIVE mode (isLive + resolver
 *     source pin/selection/inference, #3668): an Alpaca live pin beats
 *     a TEST schedule, so the record says live with source "pin",
 *     never "paper".
 */
import { describe, expect, it, vi } from "vitest";
import { guardScheduledBrokerAuth } from "../src/services/scheduledBrokerGuard";
import { resolveScheduledEffectiveMode } from "../src/services/scheduledEffectiveMode";
import {
  resolveShardChainSource,
} from "../src/services/shardExecutors";
import { resolveScheduledStockProvider } from "../src/services/scheduledTasks";
import {
  acquireUniverse,
  alpacaQuoteProviderFromRoute,
  bindAlpacaQuoteDeps,
} from "../src/trading/screenerPipeline";
import {
  buildSchedulePayload,
  marketScreenScheduleCriteriaSchema,
  optionsAnalysisScheduleCriteriaSchema,
} from "../src/trading/screeningSchemas";
import type { OptionChainSource } from "../src/trading/optionChainSource";

const ALPACA_SELECTION = {
  resolved: true as const,
  selection: {
    connectionId: "alpaca:TEST:alice",
    brokerId: "alpaca" as const,
    environment: "TEST" as const,
    mode: "paper" as const,
    externalAccountId: "acc-1",
  },
};

describe("scheduled broker guard (#3655)", () => {
  it("an Alpaca tenant with credentials is not blocked and never runs the E*TRADE guard", async () => {
    const result = await guardScheduledBrokerAuth({
      env: {},
      userLogin: "alice",
      readers: {
        readBroker: async () => ({ status: "ok", brokerId: "alpaca" }),
        resolveSelection: async () => ALPACA_SELECTION,
      },
    });
    expect(result.blocked).toBe(false);
    expect(result.legacy).toBe(false);
    if (!result.blocked) expect(result.brokerId).toBe("alpaca");
  });

  it("a missing Alpaca credential blocks loud and coded, naming Alpaca, never E*TRADE", async () => {
    const result = await guardScheduledBrokerAuth({
      env: {},
      userLogin: "alice",
      readers: {
        readBroker: async () => ({ status: "ok", brokerId: "alpaca" }),
        resolveSelection: async () => ({
          resolved: false,
          code: "CONNECTION_NOT_BOUND",
          error: "no credential: connection alpaca:TEST:alice has no stored credential for this login",
        }),
      },
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.error).toContain("FAILURE_AUTH_TOKEN_MISSING");
      expect(result.error).toContain("Alpaca");
      expect(result.error).not.toContain("E*TRADE");
      expect(result.error).toContain("CONNECTION_NOT_BOUND");
      expect(result.code).toBe("CONNECTION_NOT_BOUND");
    }
  });

  it("an E*TRADE broker keeps the legacy E*TRADE preflight", async () => {
    const result = await guardScheduledBrokerAuth({
      env: {},
      userLogin: "alice",
      readers: {
        readBroker: async () => ({ status: "ok", brokerId: "etrade" }),
        resolveSelection: async () => {
          throw new Error("resolveScreenSelection must not run for etrade");
        },
      },
    });
    expect(result).toEqual({ brokerId: "etrade", blocked: false, legacy: true });
  });

  it("an unconfigured broker selection preserves the legacy guard", async () => {
    const result = await guardScheduledBrokerAuth({
      env: {},
      userLogin: "alice",
      readers: {
        readBroker: async () => ({
          status: "unconfigured",
          error: "no broker selection: the tenant has not configured a broker",
        }),
        resolveSelection: async () => {
          throw new Error("resolveScreenSelection must not run when unconfigured");
        },
      },
    });
    expect(result).toEqual({ brokerId: null, blocked: false, legacy: true });
  });
});

describe("sharded options chain source (#3655)", () => {
  const fakeChainSource = {
    getOptionExpireDates: async () => [],
    getOptionChains: async () => [],
  } as unknown as OptionChainSource;

  it("an Alpaca chain never calls createETradeService", async () => {
    const createETradeService = vi.fn(() => {
      throw new Error("createETradeService must not run for an Alpaca chain");
    });
    const source = await resolveShardChainSource(
      {
        env: {},
        orm: undefined as never,
        createETradeService: createETradeService as never,
        getChainSourceForBroker: (broker) =>
          broker === "alpaca" ? fakeChainSource : null,
      },
      {
        chainId: "chain-1",
        universe: "NASDAQ100",
        userLogin: "alice",
        timestamp: new Date().toISOString(),
        channels: [],
        brokerId: "alpaca",
        dataProviderId: "alpaca",
        mode: "paper",
      }
    );
    expect(source).toBe(fakeChainSource);
    expect(createETradeService).not.toHaveBeenCalled();
  });

  it("an Alpaca broker with no chain source throws provider_unsupported naming Alpaca", async () => {
    await expect(
      resolveShardChainSource(
        {
          env: {},
          orm: undefined as never,
          createETradeService: (() => {
            throw new Error("must not run");
          }) as never,
          getChainSourceForBroker: () => null,
        },
        {
          chainId: "chain-1",
          universe: "NASDAQ100",
          userLogin: "alice",
          timestamp: new Date().toISOString(),
          channels: [],
          brokerId: "alpaca",
        }
      )
    ).rejects.toThrow(/provider_unsupported: broker "alpaca"/);
  });

  it("an E*TRADE chain still uses the E*TRADE factory", async () => {
    const client = { id: "etrade-client" };
    const source = await resolveShardChainSource(
      {
        env: {},
        orm: undefined as never,
        createETradeService: (() => ({ client })) as never,
      },
      {
        chainId: "chain-1",
        universe: "NASDAQ100",
        userLogin: "alice",
        timestamp: new Date().toISOString(),
        channels: [],
        brokerId: "etrade",
      }
    );
    expect(source).toBe(client as never);
  });
});

describe("scheduled stock provider resolution (#3655)", () => {
  it("resolves Alpaca from the tenant dataProviderId when the payload names none", () => {
    expect(resolveScheduledStockProvider(undefined, "alpaca")).toBe("alpaca");
  });

  it("an explicit payload provider wins over the tenant selection", () => {
    expect(resolveScheduledStockProvider("yahoo", "alpaca")).toBe("yahoo");
    expect(resolveScheduledStockProvider("alpaca", "etrade")).toBe("alpaca");
  });

  it("a data provider with no stock-screen adapter falls back to the legacy default", () => {
    expect(resolveScheduledStockProvider(undefined, "public")).toBe("etrade");
    expect(resolveScheduledStockProvider(undefined, "nasdaq")).toBe("etrade");
    expect(resolveScheduledStockProvider(undefined, undefined)).toBe("etrade");
  });
});

describe("schedule payload broker + mode (#3655)", () => {
  it("stamps brokerId, dataProviderId, and mode from the server-resolved identity", () => {
    const built = buildSchedulePayload(
      "autonomousMarketScreen",
      { universe: "NASDAQ100" },
      {
        userLogin: "alice",
        environment: "TEST",
        trigger: "scheduled",
        brokerId: "alpaca",
        dataProviderId: "alpaca",
        mode: "paper",
      }
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value.brokerId).toBe("alpaca");
      expect(built.value.dataProviderId).toBe("alpaca");
      expect(built.value.mode).toBe("paper");
    }
  });

  it("identity values win over caller-supplied criteria values", () => {
    const built = buildSchedulePayload(
      "autonomousMarketScreen",
      { universe: "NASDAQ100", brokerId: "etrade", mode: "live" },
      {
        userLogin: "alice",
        environment: "TEST",
        trigger: "scheduled",
        brokerId: "alpaca",
        mode: "paper",
      }
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value.brokerId).toBe("alpaca");
      expect(built.value.mode).toBe("paper");
    }
  });

  it("the stock criteria schema accepts provider alpaca and broker/mode fields", () => {
    const parsed = marketScreenScheduleCriteriaSchema.safeParse({
      universe: "NASDAQ100",
      provider: "alpaca",
      brokerId: "alpaca",
      mode: "paper",
    });
    expect(parsed.success).toBe(true);
  });

  it("the options criteria schema accepts broker/mode fields", () => {
    const parsed = optionsAnalysisScheduleCriteriaSchema.safeParse({
      symbols: ["NVDA"],
      brokerId: "alpaca",
      mode: "paper",
    });
    expect(parsed.success).toBe(true);
  });

  it("the stock criteria schema still rejects an unknown provider", () => {
    const parsed = marketScreenScheduleCriteriaSchema.safeParse({
      universe: "NASDAQ100",
      provider: "bogus",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("Alpaca stock quotes (#3655)", () => {
  it("alpaca mode acquires through the Alpaca-bound deps and reports Alpaca provenance", async () => {
    const quoteDeps = bindAlpacaQuoteDeps(
      {
        getQuote: async (symbol: string) => ({
          result: {
            symbol,
            lastPrice: 100,
            companyName: `${symbol} Inc`,
          },
        }),
      } as never,
      { runId: "run-1", userLogin: "alice" }
    );
    const acquired = await acquireUniverse({
      mode: "alpaca",
      symbols: [
        { symbol: "NVDA", companyName: "NVIDIA" },
        { symbol: "AAPL", companyName: "Apple" },
      ] as never,
      maxSymbols: 2,
      quoteDeps,
    });
    expect(acquired.provider).toBe("alpaca");
    expect(acquired.quotes).toHaveLength(2);
    expect(acquired.discovery.message).toContain("Alpaca");
    expect(acquired.discovery.message).not.toContain("E*TRADE");
  });

  it("alpacaQuoteProviderFromRoute refuses a disabled alpaca provider naming Alpaca", () => {
    const registry = {
      get: () => ({ capabilities: ["quotes"] }),
    } as never;
    expect(() =>
      alpacaQuoteProviderFromRoute(
        registry,
        [{ id: "alpaca", lifecycleState: "disabled", enabled: false }] as never,
        [{ capability: "quotes" }] as never
      )
    ).toThrow(/Alpaca-mode quote resolution failed: the alpaca provider is not enabled/);
  });
});

describe("effective mode (#3655, #3668)", () => {
  it("an Alpaca live pin beats a TEST schedule: effective mode is live, source pin", async () => {
    const effective = await resolveScheduledEffectiveMode({
      env: { ALPACA_TRADING_TYPE: "live" } as never,
      brokerId: "alpaca",
      environment: "TEST",
    });
    expect(effective).toEqual({ mode: "live", isLive: true, modeSource: "pin" });
  });

  it("an Alpaca paper pin beats a PROD schedule: effective mode is paper, source pin", async () => {
    const effective = await resolveScheduledEffectiveMode({
      env: { ALPACA_TRADING_TYPE: "paper" } as never,
      brokerId: "alpaca",
      environment: "PROD",
    });
    expect(effective).toEqual({ mode: "paper", isLive: false, modeSource: "pin" });
  });

  it("Alpaca with no pin follows the schedule environment, source selection", async () => {
    expect(
      await resolveScheduledEffectiveMode({ env: {}, brokerId: "alpaca", environment: "TEST" })
    ).toEqual({ mode: "paper", isLive: false, modeSource: "selection" });
    expect(
      await resolveScheduledEffectiveMode({ env: {}, brokerId: "alpaca", environment: "PROD" })
    ).toEqual({ mode: "live", isLive: true, modeSource: "selection" });
  });

  it("Alpaca with no pin and no environment infers from the base URL, source inference", async () => {
    expect(
      await resolveScheduledEffectiveMode({
        env: { ALPACA_BASE_URL: "https://api.alpaca.markets" } as never,
        brokerId: "alpaca",
        environment: undefined,
      })
    ).toEqual({ mode: "live", isLive: true, modeSource: "inference" });
    expect(
      await resolveScheduledEffectiveMode({
        env: { ALPACA_BASE_URL: "https://paper-api.alpaca.markets" } as never,
        brokerId: "alpaca",
        environment: undefined,
      })
    ).toEqual({ mode: "paper", isLive: false, modeSource: "inference" });
  });

  it("E*TRADE follows the schedule environment, source selection; no environment resolves to nothing", async () => {
    expect(
      await resolveScheduledEffectiveMode({ env: {}, brokerId: "etrade", environment: "TEST" })
    ).toEqual({ mode: "paper", isLive: false, modeSource: "selection" });
    expect(
      await resolveScheduledEffectiveMode({ env: {}, brokerId: "etrade", environment: "PROD" })
    ).toEqual({ mode: "live", isLive: true, modeSource: "selection" });
    expect(
      await resolveScheduledEffectiveMode({ env: {}, brokerId: "etrade", environment: undefined })
    ).toBeUndefined();
  });
});
