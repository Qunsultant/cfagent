/**
 * Issue #223: autonomous options analysis joins the screener event bus.
 *
 * The stock screen publishes screener.completed / screener.failed (#210);
 * options runs only ever sent direct Slack/email/webhook messages, so bus
 * subscribers (digests, future consumers) never saw them. The service now
 * publishes options.completed / options.failed through the same bus helper.
 * Delivery itself stays on the existing direct A2A path — these tests pin
 * the events, not the sends.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { Env } from "../src/types";
import type { ETradeOptionChain } from "../src/types";

function chainFixture(symbol: string): ETradeOptionChain {
  return {
    symbol,
    underlyingPrice: 130,
    quoteTime: Date.now(),
    selectedExpiry: { year: 2026, month: 11, day: 20 },
    pairs: [
      {
        call: {
          symbol, optionType: "CALL", strikePrice: 130, bid: 5.5, ask: 5.8,
          volume: 800, openInterest: 2000, impliedVolatility: 0.45,
          delta: 0.52, gamma: 0.04, theta: -0.05, vega: 0.12, rho: 0.02,
        },
        put: {
          symbol, optionType: "PUT", strikePrice: 130, bid: 5.4, ask: 5.7,
          volume: 600, openInterest: 1800, impliedVolatility: 0.45,
          delta: -0.48, gamma: 0.04, theta: -0.05, vega: 0.12, rho: -0.02,
        },
      },
    ],
  } as ETradeOptionChain;
}

describe("autonomousOptionsAnalysis event-bus publication (#223)", () => {
  let mockEnv: Env;
  let mockOrm: DatabaseORM;

  beforeEach(() => {
    const mockSql = { exec: vi.fn(() => []) };
    mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
      ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
      ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
    } as unknown as Env;
    mockOrm = new DatabaseORM(mockSql as any);
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: chainFixture("AAPL") });
  });

  function spiedService() {
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    const publish = vi.fn(async () => {});
    (service as any).publishScreenerEvent = publish;
    return { service, publish };
  }

  it("publishes options.completed after a successful run", async () => {
    const { service, publish } = spiedService();
    const result = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL"],
      thesis: "bullish",
      riskProfile: "balanced",
    });
    expect(result.success).toBe(true);
    const events = publish.mock.calls.map((c) => c[0]);
    const completed = events.find((e: any) => e.type === "options.completed");
    expect(completed).toBeDefined();
    expect(completed.thesis).toBe("bullish");
    expect(completed.trigger).toBe("scheduled");
    expect(completed.symbols).toEqual(["AAPL"]);
    expect(completed.totalScanned).toBe(1);
    expect(typeof completed.summary).toBe("string");
    expect(Array.isArray(completed.opportunities)).toBe(true);
  });

  it("publishes options.failed when the run fails", async () => {
    DynamicOptionsScreener.setTestChainsFixture({});
    const { service, publish } = spiedService();
    const result = await service.autonomousOptionsAnalysis({
      symbols: ["ZZZZ"],
      thesis: "bearish",
      riskProfile: "balanced",
    });
    expect(result.success).toBe(false);
    const events = publish.mock.calls.map((c) => c[0]);
    const failed = events.find((e: any) => e.type === "options.failed");
    expect(failed).toBeDefined();
    expect(failed.thesis).toBe("bearish");
    expect(typeof failed.error).toBe("string");
    expect(failed.error.length).toBeGreaterThan(0);
  });
});
