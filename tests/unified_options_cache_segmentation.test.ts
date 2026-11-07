/**
 * Issue #986 (built inside #982/S2): UnifiedOptionsService's module-level
 * MEMORY_CACHE is shared across ALL service instances. Before this fix the
 * cache key segmented by action/symbols/thesis/risk/target/mode/perSymbol/
 * profile/limit/statedTarget/DTE/offset — but NOT by the instance's
 * userLogin, NOT by req.filter, and NOT by the instance's environment
 * override. Once S2 routed the paid premium scan and NLQ screens through
 * execute(), a second payer/user with the same symbols+limit within the
 * TTL could be served the first request's cached result without E*TRADE
 * ever being constructed under their identity.
 *
 * These pins hold the segmentation:
 *  (a) differing filter, same user + symbols → NOT a cache hit, and the
 *      second result is the second filter's own result;
 *  (b) differing userLogin (two service instances — the module-level
 *      cache is the trap), identical request → NOT a cache hit;
 *  (c) differing overrideEnv (two instances, same user), identical
 *      request → NOT a cache hit;
 *  (d) truly identical requests on one instance → the second IS a cache
 *      hit (guard against over-segmentation).
 *
 * Each test uses its own symbol so the module-level cache cannot leak
 * state between tests.
 */
import { describe, it, expect, afterEach, vi} from "vitest";
// Issue #3460 slice 3: the unified service reads the broker through the
// presence-aware seam (no default). These tests drive the E*TRADE path,
// so the selection is explicit here instead of relying on the default.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    readTenantBrokerSelection: async () => ({
      status: "ok",
      brokerId: "etrade",
    }),
  };
});

import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { Env } from "../src/types";

function chainFixture(symbol: string) {
  return {
    symbol,
    underlyingPrice: 130,
    quoteTime: Date.now(),
    selectedExpiry: { year: 2026, month: 11, day: 20 },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 135,
          bid: 4.5,
          ask: 4.8,
          volume: 500,
          openInterest: 1200,
          impliedVolatility: 0.45,
          delta: 0.55,
          gamma: 0.04,
          theta: -0.05,
          vega: 0.12,
          rho: 0.02,
        },
      },
    ],
  } as any;
}

const mockEnv = { ETRADE_ENVIRONMENT: "sandbox" } as unknown as Env;

describe("UnifiedOptionsService cache segmentation (#986)", () => {
  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
  });

  it("(a) differing filter is not served the first screen's cached result", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ ZZQA: chainFixture("ZZQA") });
    const service = new UnifiedOptionsService(mockEnv, "cache-user-a");

    const first = await service.execute({ action: "screen", symbol: "ZZQA", filter: {} });
    expect(first.meta.cached).toBe(false);
    expect(first.data.matchedCount).toBe(1);

    // Same user, same symbol — only the filter changed (delta floor above
    // the fixture contract's 0.55). The un-fixed key had no filter
    // segment, so this was served the first screen's result.
    const second = await service.execute({
      action: "screen",
      symbol: "ZZQA",
      filter: { minDelta: 0.9 },
    });
    expect(second.meta.cached).toBe(false);
    expect(second.data.matchedCount).toBe(0);
  });

  it("(b) a second user's identical request is not served the first user's cache", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ ZZQB: chainFixture("ZZQB") });
    const svcA = new UnifiedOptionsService(mockEnv, "cache-user-a");
    const svcB = new UnifiedOptionsService(mockEnv, "cache-user-b");
    const req = { action: "screen", symbol: "ZZQB", filter: {} } as const;

    const first = await svcA.execute({ ...req });
    expect(first.meta.cached).toBe(false);

    // The cache is module-level: without a userLogin segment, svcB's
    // identical request hits svcA's entry and E*TRADE is never
    // constructed under B's identity.
    const second = await svcB.execute({ ...req });
    expect(second.meta.cached).toBe(false);
    expect(second.data.matchedCount).toBe(1);
  });

  it("(c) a differing environment override is not served the other environment's cache", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ ZZQC: chainFixture("ZZQC") });
    const svcProd = new UnifiedOptionsService(mockEnv, "cache-user-a", "PROD");
    const svcTest = new UnifiedOptionsService(mockEnv, "cache-user-a", "TEST");
    const req = { action: "screen", symbol: "ZZQC", filter: {} } as const;

    const first = await svcProd.execute({ ...req });
    expect(first.meta.cached).toBe(false);
    expect(first.meta.environment).toBe("PROD");

    const second = await svcTest.execute({ ...req });
    expect(second.meta.cached).toBe(false);
    expect(second.meta.environment).toBe("TEST");
  });

  it("(d) truly identical requests on one instance still hit the cache", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ ZZQD: chainFixture("ZZQD") });
    const service = new UnifiedOptionsService(mockEnv, "cache-user-a");
    const req = { action: "screen", symbol: "ZZQD", filter: { minVolume: 100 } } as const;

    const first = await service.execute({ ...req });
    expect(first.meta.cached).toBe(false);

    const second = await service.execute({ ...req });
    expect(second.meta.cached).toBe(true);
    expect(second.data.matchedCount).toBe(first.data.matchedCount);
  });
});
