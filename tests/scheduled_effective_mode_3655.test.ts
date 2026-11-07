/**
 * Issue #3655 (effective mode, #3668): the scheduled STOCK run record
 * carries the EFFECTIVE mode — isLive + resolver source — not just
 * the schedule's stated environment.
 *
 * Pin: an Alpaca tenant whose deployment pins ALPACA_TRADING_TYPE=live
 * but whose schedule says TEST records mode "live" with source "pin"
 * on the run (return data) and on the screen request; without the pin
 * the same TEST schedule records "paper" with source "selection".
 * The record can never claim "paper" while the run executed live.
 *
 * The tenantProviders module is mocked file-wide here (Alpaca tenant)
 * because resolveTenantProviders reads the commercial D1 store; the
 * mock preserves the real isBrokerId/BROKER_DISPLAY_NAMES.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return {
    ...actual,
    resolveTenantProviders: async () => ({ dataProviderId: "alpaca", brokerId: "alpaca" }),
    resolveTenantBroker: async () => "alpaca" as const,
  };
});

import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";

function stockSuccessResult() {
  return {
    timestamp: new Date().toISOString(),
    trigger: "scheduled",
    provider: "alpaca",
    universe: "TECH",
    sector: "ALL",
    success: true,
    totalScanned: 10,
    expectedCount: 10,
    matchedCount: 2,
    opportunities: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
    allStocks: [],
    discoveryMessage: "",
    filterSummary: "test",
  };
}

describe("scheduled stock effective mode (#3655, #3668)", () => {
  let mockOrm: DatabaseORM;

  beforeEach(() => {
    const mockSql = { exec: vi.fn(() => []) };
    mockOrm = new DatabaseORM(mockSql as any);
  });

  function stockService(env: Env) {
    const service = new ScheduledTasksService(env, mockOrm, "test_trader");
    const runScreen = vi.fn(async () => stockSuccessResult());
    (service as any).publishScreenerEvent = vi.fn(async () => {});
    (service as any).audit = vi.fn(() => {});
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    (service as any).getScreenerAgent = () => ({ runScreen });
    return { service, runScreen };
  }

  it("an Alpaca live pin beats a TEST schedule: the run records live, source pin", async () => {
    const env = {
      ALPACA_TRADING_TYPE: "live",
      ETRADE_ENVIRONMENT: "sandbox",
    } as unknown as Env;
    const { service, runScreen } = stockService(env);
    const result = await service.autonomousMarketScreen({ environment: "TEST" });
    expect(result.success).toBe(true);
    expect((result as any).data.mode).toBe("live");
    expect((result as any).data.modeSource).toBe("pin");
    expect((result as any).data.brokerId).toBe("alpaca");
    expect((result as any).data.dataProviderId).toBe("alpaca");
    const req = runScreen.mock.calls[0][0];
    expect(req.mode).toBe("live");
    expect(req.modeSource).toBe("pin");
  });

  it("without the pin, the same TEST schedule records paper, source selection", async () => {
    const env = { ETRADE_ENVIRONMENT: "sandbox" } as unknown as Env;
    const { service, runScreen } = stockService(env);
    const result = await service.autonomousMarketScreen({ environment: "TEST" });
    expect(result.success).toBe(true);
    expect((result as any).data.mode).toBe("paper");
    expect((result as any).data.modeSource).toBe("selection");
    const req = runScreen.mock.calls[0][0];
    expect(req.mode).toBe("paper");
    expect(req.modeSource).toBe("selection");
  });
});
