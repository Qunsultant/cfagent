/**
 * Issue #1785: a scheduled options scan over a universe too large for one
 * Worker invocation's subrequest budget must route to the sharded path
 * instead of running monolithically and deferring 97 of 100 symbols.
 *
 * Routing rule (see the constant in scheduledTasks.ts): a scheduled run
 * whose resolved symbol count exceeds what one budget covers at the
 * measured per-symbol cost takes the sharded branch. Explicit
 * `sharded: true` still shards regardless of size; small scheduled
 * runs and manual runs keep today's monolithic path.
 *
 * Issue #4780: the sharded path is the one engine job now — the chain
 * dispatches as `options-chain:<chainId>` through
 * startOptionsChainWorkflow (one call carrying the whole chain), not
 * as one paced per-symbol async job per symbol. The per-symbol
 * staggering lives in the chain job's feed node (sharded shape,
 * sequential units, one journaled workflow step per unit).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";
import type { ShardChainContext } from "../src/types";

describe("scheduled options scan sharding (#1785, #4780)", () => {
  let mockEnv: Env;
  let mockOrm: DatabaseORM;

  beforeEach(() => {
    mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
      ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
      ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
    } as unknown as Env;
    const mockSql = { exec: vi.fn(() => []) };
    mockOrm = new DatabaseORM(mockSql as any);
  });

  function makeService(started: Array<{ chain: ShardChainContext }>) {
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    // Issue #4780: the chain submits through the engine seam — one
    // startOptionsChainWorkflow call carrying the whole chain. The
    // fake echoes the chain job id, as the real seam does.
    (service as any).startOptionsChainWorkflow = async (
      _env: unknown,
      input: { chain: ShardChainContext },
    ) => {
      started.push(input);
      return { instanceId: "wf-1", jobId: `options-chain:${input.chain.chainId}` };
    };
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    (service as any).getScreenerAgent = () => ({ claimScheduledExecution: async () => true });
    (service as any).publishScreenerEvent = vi.fn(async () => {});
    return { service };
  }

  function makeSymbols(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `SYM${String(i).padStart(3, "0")}`);
  }

  it("a 100-symbol scheduled scan routes to the sharded path: one chain job carrying 100 symbols", async () => {
    const started: Array<{ chain: ShardChainContext }> = [];
    const { service } = makeService(started);
    const result = await service.autonomousOptionsAnalysis({
      symbols: makeSymbols(100),
      thesis: "bullish",
      riskProfile: "balanced",
      trigger: "scheduled",
    });
    expect((result.data as any)?.sharded).toBe(true);
    expect((result.data as any)?.chainId).toBeTruthy();
    expect(started).toHaveLength(1);
    expect(started[0].chain.options?.symbols).toHaveLength(100);
    expect(new Set(started[0].chain.options?.symbols).size).toBe(100);
    expect((result.data as any)?.jobId).toBe(
      `options-chain:${(result.data as any)?.chainId}`,
    );
    expect(String((result.data as any)?.summary)).toContain("one engine chain job");
  });

  it("a small scheduled scan keeps the monolithic path (no chain started)", async () => {
    const started: Array<{ chain: ShardChainContext }> = [];
    const { service } = makeService(started);
    const result = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL", "MSFT"],
      thesis: "bullish",
      riskProfile: "balanced",
      trigger: "scheduled",
    });
    expect(started).toHaveLength(0);
    expect((result.data as any)?.sharded).not.toBe(true);
  });

  it("explicit sharded: true still shards regardless of size", async () => {
    const started: Array<{ chain: ShardChainContext }> = [];
    const { service } = makeService(started);
    const result = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL", "MSFT"],
      thesis: "bullish",
      riskProfile: "balanced",
      trigger: "scheduled",
      sharded: true,
    });
    expect((result.data as any)?.sharded).toBe(true);
    expect(started).toHaveLength(1);
    expect(started[0].chain.options?.symbols).toEqual(["AAPL", "MSFT"]);
  });

  it("a large scheduled scan without the workflow residency fails honestly instead of running partial", async () => {
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    (service as any).getScreenerAgent = () => ({ claimScheduledExecution: async () => true });
    (service as any).publishScreenerEvent = vi.fn(async () => {});
    // The function's catch converts the start seam's refusal (no
    // AGENT_DB / JOB_PIPELINE_WORKFLOW in this env) into a failure
    // result + options.failed event (never a partial success).
    const result = await service.autonomousOptionsAnalysis({
      symbols: makeSymbols(100),
      thesis: "bullish",
      riskProfile: "balanced",
      trigger: "scheduled",
    });
    expect(result.success).toBe(false);
    expect(String((result as any).error)).toContain("job_pipeline_workflow_not_configured");
  });
});
