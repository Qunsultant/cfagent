/**
 * #928 (parent #913 S10) — Research chain fallback under the demo gate.
 *
 * PlatformResearchDataProvider.getChain fell through on live E*TRADE chain
 * failure to buildCalibratedOptionChains WITHOUT consulting
 * isDemoCalibratedChainsEnabled(), while every other calibrated consumer
 * honors the gate. The fix gates the calibrated path:
 * - gate OFF (PROD default) + live chain failing => NO calibrated chain;
 *   the run gets the explicit unavailable snapshot (provenance "unavailable",
 *   empty expiries, no legs, no substitute numbers).
 * - gate ON + live chain failing => calibrated chain, as before.
 *
 * Provenance note: ChainProvenance is "live" | "calibrated" | "unavailable"
 * (src/services/researchGates.ts). There is no "calibrated-demo" member at
 * the ChainSnapshot layer — downstream layers map "calibrated" to the
 * "calibrated-demo" dataSource (e.g. recommendationKernel). The gate-on pin
 * therefore asserts "calibrated", the demo-regime calibrated chain; widening
 * the union would mislabel demo chains as live downstream.
 */
import { describe, it, expect, afterEach } from "vitest";
import { PlatformResearchDataProvider } from "../src/services/researchProviders";
import type { Env } from "../src/types";

function failingPlatform() {
  return {
    getOptionExpireDates: async () => {
      throw new Error("live chain down");
    },
    getOptionChains: async () => {
      throw new Error("live chain down");
    },
  };
}

function livePlatform() {
  const now = Date.now();
  const d = new Date(now + 35 * 86_400_000);
  const iso = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  return {
    getOptionExpireDates: async () => [iso],
    getOptionChains: async () => ({
      underlyingPrice: 100,
      pairs: [
        {
          call: {
            strikePrice: 100,
            bid: 4.8,
            ask: 5.0,
            impliedVolatility: 0.42,
            volume: 100,
            openInterest: 500,
          },
        },
      ],
    }),
  };
}

function providerWith(platform: unknown) {
  const provider = new PlatformResearchDataProvider({} as Env, "tester");
  (provider as unknown as { platform: unknown }).platform = platform;
  return provider;
}

afterEach(() => {
  delete process.env.CFAGENT_DEMO_CALIBRATED_CHAINS;
});

describe("research chain demo gate (#928)", () => {
  it("gate OFF + live chain failing => unavailable, never a calibrated chain", async () => {
    delete process.env.CFAGENT_DEMO_CALIBRATED_CHAINS;
    const chain = await providerWith(failingPlatform()).getChain("AAA");
    expect(chain.provenance).toBe("unavailable");
    expect(chain.expiries).toEqual([]);
    expect(chain.underlyingPrice).toBe(0);
    expect(chain.expiries.flatMap((e) => e.legs)).toEqual([]);
  });

  it("gate ON + live chain failing => calibrated chain, as before", async () => {
    process.env.CFAGENT_DEMO_CALIBRATED_CHAINS = "1";
    const chain = await providerWith(failingPlatform()).getChain("AAA");
    expect(chain.provenance).toBe("calibrated");
    expect(chain.expiries.length).toBeGreaterThan(0);
  });

  it("control: live chain succeeding => live chain, gate-independent", async () => {
    delete process.env.CFAGENT_DEMO_CALIBRATED_CHAINS;
    const chain = await providerWith(livePlatform()).getChain("AAA");
    expect(chain.provenance).toBe("live");
    expect(chain.expiries.length).toBeGreaterThan(0);
  });
});
