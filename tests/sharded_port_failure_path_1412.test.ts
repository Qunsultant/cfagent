/**
 * Issue #1412 (job-truth program #1332): a sharded run without the
 * async-job submission port must go through the same failure path as
 * any other failure — audit + session message + screener.failed bus
 * event — instead of returning { success: false } from
 * autonomousMarketScreenSharded while autonomousMarketScreen returns
 * it bare. The port requirement stays: a missing-port run must still
 * fail honestly and NEVER execute unsharded under a sharded label.
 * Wired runs are untouched: a wired submission still queues the chain
 * with no failure event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";

describe("autonomousMarketScreen sharded missing-port failure path (#1412)", () => {
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
  });

  function unblockedService() {
    // No shard-submit port: the last constructor parameter is absent,
    // exactly the shape that hits the missing-port path.
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    const publish = vi.fn(async () => {});
    (service as any).publishScreenerEvent = publish;
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    // Issue #2860 (Factor 8): the lock probe is fail-closed — an
    // unanswering probe refuses the submission. This harness tests
    // the port/failure paths, so the probe answers not-running.
    const getScreenerAgent = vi.fn(() => ({
      isScreenRunning: async () => ({ running: false, startedAt: null }),
    }));
    (service as any).getScreenerAgent = getScreenerAgent;
    return { service, publish, getScreenerAgent };
  }

  it("a sharded run without the port publishes screener.failed with the port error instead of returning silently", async () => {
    const { service, publish } = unblockedService();
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(result.success).toBe(false);
    expect(String((result as any).error)).toContain("submission port");
    const failed = publish.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "screener.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain("submission port");
    expect(failed[0].trigger).toBe("scheduled");
  });

  it("a sharded run without the port never executes unsharded under a sharded label", async () => {
    const { service, getScreenerAgent } = unblockedService();
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(result.success).toBe(false);
    expect(getScreenerAgent).not.toHaveBeenCalled();
  });

  it("a wired sharded run still submits the chain with no failure event", async () => {
    const { service, publish } = unblockedService();
    const shardSubmit = vi.fn(async () => ({
      jobId: "test-chain",
      status: "queued" as const,
      statusUrl: "https://example.test/jobs/test-chain",
    }));
    (service as any).shardSubmit = shardSubmit;
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(shardSubmit).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect((result as any).data.sharded).toBe(true);
    const failed = publish.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "screener.failed");
    expect(failed).toHaveLength(0);
  });

  it("a wired sharded run whose submission rejects publishes screener.failed instead of returning silently (#1851)", async () => {
    const { service, publish } = unblockedService();
    const shardSubmit = vi.fn(async () => {
      throw new Error("submit boom");
    });
    (service as any).shardSubmit = shardSubmit;
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(result.success).toBe(false);
    const failed = publish.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "screener.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain("submit boom");
    expect(failed[0].trigger).toBe("scheduled");
  });
});
