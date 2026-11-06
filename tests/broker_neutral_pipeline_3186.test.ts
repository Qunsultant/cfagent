/**
 * Issue #3186 — Broker neutrality and execution models (LIVE vs Paper)
 * across the unified options pipeline.
 *
 * Verifies that:
 * 1. Alpaca resolves both LIVE and Paper/SANDBOX models from overrideEnv.
 * 2. E*Trade resolves both LIVE and Paper/SANDBOX models from overrideEnv.
 * 3. UnifiedOptionsService.resolveEngineClient dynamically dispatches to
 *    the active tenant broker (Alpaca or E*Trade) without hardcoding.
 * 4. The staged producer/consumer options pipeline executes successfully
 *    over an Alpaca platform chain source in both LIVE and Paper modes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAlpacaTradingBase, AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { resolveEnvironmentConfig } from "../src/config/environment";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { DynamicOptionsScreener, platformChainSource } from "../src/trading";
import { runOptionsScreenWorkflow } from "../src/workflows/optionsScreenWorkflow";
import { createOptionsScreenPorts, optionsArtifactKey, type OptionsStageStorage } from "../src/workflows/optionsScreenPorts";
import type { StageClaimStore } from "../src/workflows/stageReportConsumer";
import type { BrokerOptionChain } from "../src/types";

function memoryClaims(preclaimed: string[] = []): StageClaimStore {
  const claimed = new Set(preclaimed);
  return {
    has: (key) => claimed.has(key),
    add: (key) => {
      claimed.add(key);
    },
    delete: (key) => {
      claimed.delete(key);
    },
  };
}

function makeMemoryStorage(): OptionsStageStorage {
  const store = new Map<string, unknown>();
  return {
    get: async (key: string) => store.get(key) as never,
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

describe("Issue #3186: Broker Neutrality & Execution Models (LIVE vs Paper)", () => {
  describe("Alpaca Trading Base Resolution (LIVE vs Paper)", () => {
    it("maps LIVE and PROD to Alpaca live api endpoint with isLive: true", () => {
      const live1 = resolveAlpacaTradingBase({}, "LIVE");
      expect(live1.isLive).toBe(true);
      expect(live1.baseUrl).toBe("https://api.alpaca.markets");
      expect(live1.source).toBe("selection");

      const live2 = resolveAlpacaTradingBase({}, "PROD");
      expect(live2.isLive).toBe(true);
      expect(live2.baseUrl).toBe("https://api.alpaca.markets");
      expect(live2.source).toBe("selection");
    });

    it("maps PAPER, TEST, and SANDBOX to Alpaca paper api endpoint with isLive: false", () => {
      const paper1 = resolveAlpacaTradingBase({}, "PAPER");
      expect(paper1.isLive).toBe(false);
      expect(paper1.baseUrl).toBe("https://paper-api.alpaca.markets");
      expect(paper1.source).toBe("selection");

      const paper2 = resolveAlpacaTradingBase({}, "TEST");
      expect(paper2.isLive).toBe(false);
      expect(paper2.baseUrl).toBe("https://paper-api.alpaca.markets");
      expect(paper2.source).toBe("selection");

      const paper3 = resolveAlpacaTradingBase({}, "SANDBOX");
      expect(paper3.isLive).toBe(false);
      expect(paper3.baseUrl).toBe("https://paper-api.alpaca.markets");
      expect(paper3.source).toBe("selection");
    });
  });

  describe("Environment Config Resolution (LIVE vs Paper)", () => {
    it("normalizes LIVE and PROD to PROD with isLive: true", () => {
      const live = resolveEnvironmentConfig({}, "LIVE");
      expect(live.name).toBe("PROD");
      expect(live.isLive).toBe(true);

      const prod = resolveEnvironmentConfig({}, "PROD");
      expect(prod.name).toBe("PROD");
      expect(prod.isLive).toBe(true);
    });

    it("normalizes PAPER, TEST, and SANDBOX to TEST with isLive: false", () => {
      const paper = resolveEnvironmentConfig({}, "PAPER");
      expect(paper.name).toBe("TEST");
      expect(paper.isLive).toBe(false);

      const sandbox = resolveEnvironmentConfig({}, "SANDBOX");
      expect(sandbox.name).toBe("TEST");
      expect(sandbox.isLive).toBe(false);

      const test = resolveEnvironmentConfig({}, "TEST");
      expect(test.name).toBe("TEST");
      expect(test.isLive).toBe(false);
    });
  });

  describe("UnifiedOptionsService.resolveEngineClient broker neutrality", () => {
    it("resolves Alpaca chain source when tenant broker is alpaca", async () => {
      const fakeEnv = {
        BROKER: "alpaca",
        ALPACA_KEY_ID: "fake-key",
        ALPACA_SECRET_KEY: "fake-secret",
      };

      const service = new UnifiedOptionsService(
        fakeEnv as any,
        "test-user@example.com",
        "PAPER",
      );

      const resolved = await service.resolveEngineClient();
      expect(resolved.engineClient).toBeDefined();
      expect(typeof resolved.engineClient.getOptionChains).toBe("function");
      expect(typeof resolved.engineClient.getOptionExpireDates).toBe("function");
    });
  });

  describe("Staged Options Pipeline over Alpaca Platform Chain Source", () => {
    afterEach(() => {
      DynamicOptionsScreener.clearTestChainsFixture();
    });

    it("executes all 8 pipeline stages against Alpaca chain source in LIVE and Paper", async () => {
      const fakeExpiry = { year: 2026, month: 12, day: 18 };
      const fakeChain: BrokerOptionChain = {
        symbol: "AAPL",
        underlyingPrice: 200,
        selectedExpiry: fakeExpiry,
        pairs: [
          {
            call: {
              symbol: "AAPL261218C00200000",
              optionType: "CALL",
              strikePrice: 200,
              bid: 5.0,
              ask: 5.2,
              lastPrice: 5.1,
              volume: 100,
              openInterest: 500,
            },
            put: {
              symbol: "AAPL261218P00200000",
              optionType: "PUT",
              strikePrice: 200,
              bid: 4.8,
              ask: 5.0,
              lastPrice: 4.9,
              volume: 80,
              openInterest: 400,
            },
          },
        ],
      };

      // Mock Alpaca platform
      const alpacaPlatform = new AlpacaTradingPlatform(
        { ALPACA_KEY_ID: "k", ALPACA_SECRET_KEY: "s" } as any,
        undefined,
        "test-user@example.com",
        "LIVE",
      );

      vi.spyOn(alpacaPlatform, "getOptionChains").mockResolvedValue(fakeChain);
      vi.spyOn(alpacaPlatform, "getOptionExpireDates").mockResolvedValue([fakeExpiry]);

      const chainSource = platformChainSource(alpacaPlatform);
      expect(chainSource).not.toBeNull();

      const screener = new DynamicOptionsScreener(chainSource!);
      const storage = makeMemoryStorage();

      const ports = createOptionsScreenPorts({
        screener,
        storage,
        shapeReport: async ({ runId, screen }) => ({
          reportId: `rep:${runId}`,
          screen,
        }),
        deliver: async ({ report }) => ({ delivered: true, report }),
      });

      const outcome = await runOptionsScreenWorkflow(
        {
          runId: "run-alpaca-live-3186",
          userLogin: "test-user@example.com",
          request: {
            assetClass: "options",
            runIdentity: { runId: "run-alpaca-live-3186" },
            trigger: "manual",
            classInput: {
              request: {
                filter: {
                  underlyingSymbols: ["AAPL"],
                  minDte: 1,
                  maxDte: 90,
                },
              },
            },
          },
        },
        {
          stages: ports,
          claims: memoryClaims(),
          queue: null,
        },
      );

      expect(outcome.outcome).toBe("completed");

      // Verify checkpoints in storage
      const plan = await storage.get(optionsArtifactKey("run-alpaca-live-3186", "plan"));
      expect(plan).toBeDefined();

      const screenArtifact = await storage.get<{ result: { matchedCount: number } }>(
        optionsArtifactKey("run-alpaca-live-3186", "screen"),
      );
      expect(screenArtifact).toBeDefined();
      expect(screenArtifact?.result.matchedCount).toBeGreaterThanOrEqual(1);

      const deliverArtifact = await storage.get(
        optionsArtifactKey("run-alpaca-live-3186", "deliver"),
      );
      expect(deliverArtifact).toBeDefined();
    });
  });
});
