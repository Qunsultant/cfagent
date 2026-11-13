/**
 * Issue #1412 (job-truth program #1332), re-pointed by issue #4280
 * ([One engine] #3550 S5): a sharded run without the workflow port
 * must go through the same failure path as any other failure — audit +
 * session message + screener.failed bus event — instead of returning
 * { success: false } from autonomousMarketScreenSharded while
 * autonomousMarketScreen returns it bare. The port requirement stays:
 * a missing-port run must still fail honestly (coded
 * WorkflowError("unavailable")) and NEVER execute unsharded under a
 * sharded label. The old shard-submit port guard is gone with the
 * chain — the seam owns the unavailable failure now (its gates run
 * first: the agent probe IS called before the port check, so the old
 * "getScreenerAgent not called" pin is replaced by a "no run exists"
 * pin below). Wired runs are untouched: a wired submission still
 * queues the run with no failure event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";

describe("autonomousMarketScreen sharded missing-port failure path (#1412, #4280)", () => {
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
    // No workflow binding on the env: the seam's createWorkflowPorts
    // returns null, exactly the shape that hits the unavailable path.
    // The service's submit-seam injectable is absent, so the real
    // seam runs.
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    const publish = vi.fn(async () => {});
    (service as any).publishScreenerEvent = publish;
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    // Issue #2860 (Factor 8): the lock probe is fail-closed — an
    // unanswering probe refuses the submission. This harness tests
    // the port/failure paths, so the probe answers not-running, and
    // the quota gate answers allowed.
    const getScreenerAgent = vi.fn(() => ({
      isScreenRunning: async () => ({ running: false, startedAt: null }),
      chargeScreenQuota: async () => ({}),
    }));
    (service as any).getScreenerAgent = getScreenerAgent;
    return { service, publish, getScreenerAgent };
  }

  it("a sharded run without the workflow port publishes screener.failed with the coded unavailable error instead of returning silently", async () => {
    const { service, publish } = unblockedService();
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(result.success).toBe(false);
    expect(String((result as any).error)).toContain("unavailable");
    const failed = publish.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "screener.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain("unavailable");
    expect(failed[0].trigger).toBe("scheduled");
  });

  it("a sharded run without the port refuses at the seam's port check, after the gates — no run exists to announce", async () => {
    const { service, getScreenerAgent } = unblockedService();
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(result.success).toBe(false);
    // Issue #4280: the seam's gate 2 probe runs BEFORE the port
    // check, so the agent IS called now — the refusal is the port
    // check, not the gate. What must not exist is a run: no data
    // shape, no chain id.
    expect(getScreenerAgent).toHaveBeenCalled();
    expect((result as any).data).toBeUndefined();
    expect(String((result as any).error)).toContain("unavailable");
  });

  it("a wired sharded run still submits through the seam with no failure event", async () => {
    const { service, publish } = unblockedService();
    // The fake echoes the job id the service passed in, as the real
    // seam does (commandOverrides.jobId = chainId) — the assertion
    // below pins that the returned chain id IS the submitted job id.
    const submit = vi.fn(async (input: { commandOverrides: { jobId: string } }) => ({
      jobId: input.commandOverrides.jobId,
      workflowId: "wf-test-chain",
    }));
    (service as any).submitStockScreenViaEngine = submit;
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect((result as any).data.sharded).toBe(true);
    expect((result as any).data.chainId).toBe(
      (submit.mock.calls[0][0] as { commandOverrides: { jobId: string } }).commandOverrides.jobId,
    );
    const failed = publish.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "screener.failed");
    expect(failed).toHaveLength(0);
  });

  it("a wired sharded run whose submission rejects publishes screener.failed instead of returning silently (#1851)", async () => {
    const { service, publish } = unblockedService();
    const submit = vi.fn(async () => {
      throw new Error("submit boom");
    });
    (service as any).submitStockScreenViaEngine = submit;
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(result.success).toBe(false);
    const failed = publish.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "screener.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain("submit boom");
    expect(failed[0].trigger).toBe("scheduled");
  });
});
