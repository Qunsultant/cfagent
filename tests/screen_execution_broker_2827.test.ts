/**
 * Issue #2827 (Phase 2 Slice 2 under #2764) — pins for
 * ScreenExecutionBroker, the one REST async-or-sync branch.
 * No behaviour change: the broker must reproduce exactly
 * what the two REST routes assembled by hand, with the
 * pinned divergence (deliver/provider) carried from the
 * Slice 1 spec, not re-literalised here.
 */
import { describe, expect, it, vi } from "vitest";
import { startStockScreenWorkflowOrNull } from "../src/workflows/screenExecutionBroker";
import type { StockScreenRunSpec } from "../src/workflows/stockScreenRunSpec";

function spec(overrides: Partial<StockScreenRunSpec> = {}): StockScreenRunSpec {
  return {
    source: "etrade",
    deliver: true,
    filters: {} as StockScreenRunSpec["filters"],
    universe: "NASDAQ100",
    asyncRequested: true,
    delivery: {},
    ...overrides,
  } as StockScreenRunSpec;
}

function fakeHandle() {
  return {
    workflowId: "wf-1",
    jobId: "job-1",
    status: "waiting" as const,
    existing: false,
    statusUrl: "/api/jobs/history?chainId=job-1",
  };
}

describe("startStockScreenWorkflowOrNull", () => {
  it("asyncRequested false returns null and never calls the starter", async () => {
    const starter = vi.fn(async () => fakeHandle());
    const result = await startStockScreenWorkflowOrNull({
      env: {} as never,
      spec: spec({ asyncRequested: false }),
      userLogin: "alice",
      environment: "PROD",
      portfolioContext: true,
      starter,
    });
    expect(result).toBeNull();
    expect(starter).not.toHaveBeenCalled();
  });

  it("async true builds a run-screen parent command with deliver/provider/filters from the spec", async () => {
    const starter = vi.fn(async () => fakeHandle());
    const result = await startStockScreenWorkflowOrNull({
      env: {} as never,
      spec: spec({ source: "market-data", deliver: false, provider: "yahoo" }),
      userLogin: "alice",
      starter,
    });
    expect(result).not.toBeNull();
    expect(starter).toHaveBeenCalledTimes(1);
    const command = starter.mock.calls[0][1];
    expect(command.type).toBe("run-screen");
    expect(command.role).toBe("parent");
    expect(command.source).toBe("manual");
    expect(command.trigger).toBe("manual");
    expect(command.userLogin).toBe("alice");
    expect(command.deliver).toBe(false);
    expect(command.provider).toBe("yahoo");
    expect(command.shards).toEqual([{ shardId: "NASDAQ100", universe: "NASDAQ100" }]);
    expect(command.jobId).toBe(result!.jobId);
    expect(result!.handle.workflowId).toBe("wf-1");
    // Market-data previously passed no environment/portfolioContext keys.
    expect("environment" in command).toBe(false);
    expect("portfolioContext" in command).toBe(false);
  });

  it("ALL fans out to shardable universes, single universe to one shard", async () => {
    const starter = vi.fn(async () => fakeHandle());
    await startStockScreenWorkflowOrNull({
      env: {} as never,
      spec: spec({ universe: "ALL" }),
      userLogin: "alice",
      starter,
    });
    const shards = starter.mock.calls[0][1].shards;
    expect(shards.length).toBeGreaterThan(1);
    expect(shards.every((s) => s.shardId === s.universe)).toBe(true);
  });

  it("starter null (unbound / start failure) returns null for sync fallback", async () => {
    const starter = vi.fn(async () => null);
    const result = await startStockScreenWorkflowOrNull({
      env: {} as never,
      spec: spec(),
      userLogin: "alice",
      starter,
    });
    expect(result).toBeNull();
  });

  it("an ND starter throw propagates — never converted to a sync fallback", async () => {
    const starter = vi.fn(async () => {
      throw new Error("Non-deterministic screen command refused");
    });
    await expect(
      startStockScreenWorkflowOrNull({
        env: {} as never,
        spec: spec({ screenMode: "non-deterministic", screenIntent: "find momentum" }),
        userLogin: "alice",
        starter,
      }),
    ).rejects.toThrow("Non-deterministic screen command refused");
  });

  it("E*TRADE environment and portfolioContext ride the command when provided", async () => {
    const starter = vi.fn(async () => fakeHandle());
    await startStockScreenWorkflowOrNull({
      env: {} as never,
      spec: spec(),
      userLogin: "alice",
      environment: "TEST",
      portfolioContext: true,
      starter,
    });
    const command = starter.mock.calls[0][1];
    expect(command.environment).toBe("TEST");
    expect(command.portfolioContext).toBe(true);
    expect(command.deliver).toBe(true);
    expect(command.provider).toBeUndefined();
  });
});
