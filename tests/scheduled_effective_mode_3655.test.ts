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

// Issue #4278: the screen runs through the one engine seam, not the
// agent's runScreen. The seam fake delegates to the stub agent's
// runScreen: it flattens the seam input back into the runScreen
// request (provider/sector ride the spec on the routes, the
// overrides on the scheduled path) and returns the stub's result
// as the engine run's one shard. The seam itself is pinned in
// tests/stock_entry_routing_4278.test.ts.
const delegateSeamFake = (runScreen: (req: any) => Promise<any>) => async (input: any) => {
  const flat = {
    trigger: input.spec.trigger,
    sector: input.commandOverrides?.sector ?? input.spec.filters?.sector,
    universe: input.spec.universe,
    maxSymbols: input.commandOverrides?.maxSymbols,
    filters: input.spec.filters,
    userLogin: input.userLogin,
    environment: input.environment,
    portfolioContext: input.portfolioContext,
    provider: input.commandOverrides?.provider ?? input.spec.provider,
    broker: input.commandOverrides?.broker,
    ...(input.commandOverrides?.mode
      ? { mode: input.commandOverrides.mode, modeSource: input.commandOverrides.modeSource }
      : {}),
  };
  const result = await runScreen(flat);
  return {
    results: [result],
    collation: null,
    jobId: input.spec?.jobId ?? "test-job",
    workflowId: "wf-1",
  };
};

  function stockService(env: Env) {
    const service = new ScheduledTasksService(env, mockOrm, "test_trader");
    const runScreen = vi.fn(async () => stockSuccessResult());
    (service as any).publishScreenerEvent = vi.fn(async () => {});
    (service as any).audit = vi.fn(() => {});
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    (service as any).getScreenerAgent = () => ({ runScreen });
    (service as any).runStockScreenViaEngine = delegateSeamFake(runScreen);
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
