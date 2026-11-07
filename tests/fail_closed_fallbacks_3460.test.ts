import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingPlatformRegistry } from "../src/trading";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { createRefusingOptionsScreener } from "../src/trading/screeningProvider";
import { createProductionScreeningRegistry } from "../src/services/screeningRuntime";

/**
 * Issue #3460 slice 2 — the silent E*TRADE fallbacks, fail-closed.
 *
 * Three fallbacks in one family, each now a named refusal instead of
 * silently screening E*TRADE data:
 *  1. `resolveEngineClient()`: a non-E*TRADE broker whose platform
 *     has no options chain source used to fall through to the
 *     E*TRADE client. Now it throws `provider_unsupported`.
 *  2. The goal leg: a non-E*TRADE tenant with no neutral chain
 *     source used to screen E*TRADE chains. Now it runs on a
 *     refusing screener — stocks-only goals proceed; any options
 *     leg throws `provider_unsupported` naming the broker.
 *  3. `TradingPlatformRegistry.getPlatform()`: an unregistered id
 *     used to fall back to E*TRADE. Now it throws `not registered`.
 */

const tenant = {
  broker: "test-noplane",
  selection: () =>
    ({ status: "ok", brokerId: "test-noplane" }) as const,
};

vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return { ...actual, readTenantBrokerSelection: async () => tenant.selection() };
});

describe("TradingPlatformRegistry.getPlatform — no E*TRADE fallback", () => {
  it("throws for an unregistered broker id instead of returning E*TRADE", () => {
    expect(() =>
      TradingPlatformRegistry.getPlatform(
        "definitely-not-a-broker" as never,
        {} as never,
        undefined,
        "alice",
      ),
    ).toThrow("Trading platform [definitely-not-a-broker] is not registered.");
  });
});

describe("UnifiedOptionsService.resolveEngineClient — no options plane", () => {
  beforeEach(() => {
    tenant.selection = () =>
      ({ status: "ok", brokerId: "test-noplane" }) as const;
    // A registered platform that omits the options data plane: no
    // getOptionChains / getOptionExpireDates at all.
    TradingPlatformRegistry.register("test-noplane" as never, () => ({}) as never);
  });

  it("throws provider_unsupported naming the broker instead of falling back to E*TRADE", async () => {
    const service = new UnifiedOptionsService(
      {} as never,
      "test-user@example.com",
      "PAPER",
    );
    await expect(service.resolveEngineClient()).rejects.toThrow(
      /provider_unsupported: broker "test-noplane" does not provide an options chain source/,
    );
  });

  it("refuses with a named error when the tenant has not configured a broker (#3460 S3)", async () => {
    tenant.selection = () =>
      ({
        status: "unconfigured",
        error: "no broker selection: the tenant has not configured a broker",
      }) as const;
    const service = new UnifiedOptionsService(
      {} as never,
      "test-user@example.com",
      "PAPER",
    );
    await expect(service.resolveEngineClient()).rejects.toThrow(
      /no broker selection: the tenant has not configured a broker/,
    );
  });
});

describe("createRefusingOptionsScreener — the goal leg's fail-closed screener", () => {
  it("throws provider_unsupported from screenOptions and fetchChains", async () => {
    const screener = createRefusingOptionsScreener("test-noplane");
    await expect(screener.screenOptions({})).rejects.toThrow(
      /provider_unsupported: broker "test-noplane" does not provide an options chain source/,
    );
    await expect(screener.fetchChains({})).rejects.toThrow(
      /provider_unsupported: broker "test-noplane" does not provide an options chain source/,
    );
  });

  it("fails the options leg visibly while the stock leg still screens", async () => {
    const stockStub = {
      screenMarkets: async () => ({
        status: "matches_found",
        matches: [],
      }),
    };
    const registry = createProductionScreeningRegistry({
      stockScreener: stockStub as never,
      optionsScreener: createRefusingOptionsScreener("test-noplane"),
    });
    await expect(
      registry.screen({ assetClass: "options", filter: {} }),
    ).rejects.toThrow(/provider_unsupported/);
    const stocks = await registry.screen({ assetClass: "stocks", filter: {} });
    expect(stocks.result.status).toBe("matches_found");
  });
});
