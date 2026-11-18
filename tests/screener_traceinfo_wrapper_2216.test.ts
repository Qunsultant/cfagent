/**
 * Issue #2216 (#1969 P1): the scheduled wrappers pass the run's trace
 * to the guard, so the guard alert, the bridged outcome, and the audit
 * event all carry the same run identity.
 *
 * The guard function itself is mocked here (its rendering is pinned in
 * screener_traceinfo_2216.test.ts); this file pins the wrapper side:
 * the options wrapper builds the trace from its own run id + the
 * schedule id it was given, and hands it to the guard. The mock fn is
 * created inside the factory (no top-level variable in it) and read
 * back through the mocked import binding.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/services/etradeAuthPreflight", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    guardScheduledETradeAuth: vi.fn(async () => ({
      blocked: true as const,
      error: "[FAILURE_AUTH_NO_SESSION] test blocked",
      alerted: true as const,
    })),
  };
});

import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { guardScheduledETradeAuth } from "../src/services/etradeAuthPreflight";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";
import type { ScreenerTrace } from "../src/services/screenerTrace";

const guardMock = vi.mocked(guardScheduledETradeAuth);

describe("#2216 options wrapper passes its trace to the guard", () => {
  let mockEnv: Env;
  let mockOrm: DatabaseORM;

  beforeEach(() => {
    const mockSql = { exec: vi.fn(() => []) };
    mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
    } as unknown as Env;
    mockOrm = new DatabaseORM(mockSql as any);
    guardMock.mockClear();
  });

  it("builds the trace from the run id + schedule id and passes it through", async () => {
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    (service as any).publishScreenerEvent = vi.fn(async () => {});
    const result = await service.autonomousOptionsAnalysis({
      scheduleId: "_D6hWyU_S",
      universe: "NASDAQ100",
      thesis: "bullish",
      riskProfile: "balanced",
    });
    expect(result.success).toBe(false);
    expect(guardMock).toHaveBeenCalledTimes(1);
    const opts = guardMock.mock.calls[0][0] as {
      trace?: ScreenerTrace;
    };
    expect(opts.trace).toBeDefined();
    expect(opts.trace!.scheduleId).toBe("_D6hWyU_S");
    expect(opts.trace!.workflow).toBe("autonomousOptionsAnalysis");
    expect(opts.trace!.stage).toBe("auth guard");
    expect(opts.trace!.trigger).toBe("scheduled");
    expect(opts.trace!.runAs).toBe("test_trader");
    expect(opts.trace!.runId).toMatch(/^run:/);  // #5175 slice 3: scheduled analysis run id mints run:
    expect(opts.trace!.firedAt).toBeDefined();
    expect(opts.trace!.universe).toBe("NASDAQ100");
    expect(opts.trace!.thesis).toBe("bullish");
  });
});
