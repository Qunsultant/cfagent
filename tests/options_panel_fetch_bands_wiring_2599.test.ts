/**
 * Issue #2599 (F7): discoverPanel wiring pin.
 *
 * The band builder is unit-pinned in
 * tests/options_panel_fetch_bands_2599.test.ts; here the panel
 * path itself is pinned: discoverPanel forwards the derived
 * expirationDteBands to the snapshot loader (the route adapter
 * passes them through to OptionsDataAgent), so a bullish panel
 * run that wants LEAPS actually fetches the 365-550 band. Agent
 * doubles are inert (empty candidates) — this test owns the
 * fetch params, not ranking.
 */
import { describe, expect, it } from "vitest";
import { RecommendationService } from "../src/services/recommendationKernel";

describe("discoverPanel fetch bands wiring (#2599 F7)", () => {
  it("forwards derived LEAPS bands to the snapshot loader", async () => {
    const seen: unknown[] = [];
    const service = new RecommendationService();
    await service.discoverPanel({
      dataAgent: {
        loadSnapshot: async (params: unknown) => {
          seen.push(params);
          return {
            symbol: "TSLA",
            dataSource: "live",
            contracts: [],
            screen: { underlyingsScanned: 0, contractsEvaluated: 0, contractsMatched: 0 },
            rejections: [],
            validationError: undefined,
          };
        },
      },
      riskAgent: {
        buildStrategies: () => ({ candidates: [], evaluations: [], nameLedger: [], excluded: [] }),
        screenStrategies: () => [],
        riskReport: () => ({}),
      },
      recommender: {
        rank: () => [],
        pickBestTrade: () => ({ status: "none" }),
      },
      request: {
        symbol: "TSLA",
        thesis: "bullish",
        targetPrice: 300,
        targetDate: "2026-12-18",
        expectedIvDirection: "unchanged",
        maxPlannedLoss: 1000,
        minRewardRisk: 1.5,
        allowedStrategies: ["leaps_call"],
      },
    } as never);
    expect(seen).toHaveLength(1);
    const params = seen[0] as { expirationDteBands?: Array<{ minDte: number; maxDte: number }> };
    expect(params.expirationDteBands).toBeDefined();
    expect(params.expirationDteBands).toContainEqual(
      expect.objectContaining({ minDte: 365, maxDte: 550 }),
    );
    expect(params.expirationDteBands![0]).toMatchObject({ minDte: 0, maxDte: 90 });
  });
});
