/**
 * Pinning test for #5042 — Options strategy screen durable run record & NLQ parity (H-1, H-2).
 */
import { describe, expect, it, vi } from "vitest";
import { runOptionsStrategyScreenViaDoor } from "../src/agents/orchestrator/meshOptionsStrategyDoor";

describe("#5042 options strategy screen durable run record", () => {
  it("threads pipelineStorage, engineSql, and env into runOptionsStrategyAction for durable engine recording", async () => {
    const fakeSql = { exec: vi.fn() };
    const fakeStorage = { sql: fakeSql, get: vi.fn(), put: vi.fn() };
    const fakeEnv = { WORKFLOW_HOST: "test" };
    const runOptionsStrategy = vi.fn().mockResolvedValue({
      count: 0,
      status: "no_opportunities",
      summary: "none",
      rows: [],
      scanRunId: "strategy-run-5042",
      persisted: true,
    });

    const result = await runOptionsStrategyScreenViaDoor(
      {
        orm: {} as never,
        env: fakeEnv as never,
        storage: fakeStorage as never,
        resolveUniverseSymbols: async () => ["AAPL"],
        createEtradeService: () =>
          ({
            client: {},
            fetchQuoteRemote: async () => ({ lastPrice: 200 }),
            getWatchlists: async () => [],
            screenMarketsAsync: async () => ({ stocks: [] }),
          }) as never,
        runOptionsStrategy: runOptionsStrategy as never,
      },
      "alice",
      { universe: "NASDAQ100" },
    );

    expect(result.scanRunId).toBe("strategy-run-5042");
    expect(result.persisted).toBe(true);
    expect(runOptionsStrategy).toHaveBeenCalledTimes(1);
    const deps = runOptionsStrategy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(deps.userLogin).toBe("alice");
    expect(deps.pipelineStorage).toBe(fakeStorage);
    expect(deps.engineSql).toBe(fakeSql);
    expect(deps.env).toBe(fakeEnv);
  });
});
