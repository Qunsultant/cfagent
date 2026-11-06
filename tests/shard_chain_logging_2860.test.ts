/**
 * Issue #2860 (audit follow-up) — sharded-chain structured
 * logging / classification.
 *
 * The scheduled sharded chain bypasses the runScreen
 * funnel, so it never got the funnel's structured run
 * logging + failure classification (screenRunAspects,
 * #2868): submission audited without a classification,
 * and no structured log event at all. This slice wires
 * the EXISTING aspects at the chain's own join points —
 * no second system:
 *  - submission success emits screen.started (trigger,
 *    universe, actor, trace = chainId);
 *  - submission failure (rejected submit, or missing
 *    port) emits screen.failed with the classifier's
 *    verdict, and the inner audit carries the same
 *    classification.
 * Results and throws are unchanged: logging never
 * fails a screen, the inner audit still rethrows, and
 * the caller failure path still runs in full.
 *
 * Behavioral assertions go through the structured log
 * lines (logScreenRunEvent writes one JSON line per
 * event), reusing the #1412 harness shape. The aspects
 * map pin asserts the chain join points are named, not
 * hidden.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";

describe("sharded-chain logging / classification (#2860)", () => {
  let mockEnv: Env;
  let mockOrm: DatabaseORM;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const mockSql = { exec: vi.fn(() => []) };
    mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
      ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
      ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
    } as unknown as Env;
    mockOrm = new DatabaseORM(mockSql as any);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function unblockedService() {
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    const publish = vi.fn(async () => {});
    (service as any).publishScreenerEvent = publish;
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    // Issue #2860 (Factor 8): the lock probe is fail-closed — an
    // unanswering probe refuses the submission. This harness tests
    // logging of wired submissions, so the probe answers not-running.
    (service as any).getScreenerAgent = vi.fn(() => ({
      isScreenRunning: async () => ({ running: false, startedAt: null }),
    }));
    return { service, publish };
  }

  function logEvents(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const call of logSpy.mock.calls) {
      for (const arg of call) {
        if (typeof arg !== "string") continue;
        try {
          const parsed = JSON.parse(arg) as Record<string, unknown>;
          if (parsed.event === "screen.started" || parsed.event === "screen.failed") out.push(parsed);
        } catch {
          // Non-JSON console lines are not run events.
        }
      }
    }
    return out;
  }

  it("a wired submission emits screen.started with trigger, universe, and actor", async () => {
    const { service } = unblockedService();
    (service as any).shardSubmit = vi.fn(async () => ({
      jobId: "test-chain",
      status: "queued" as const,
      statusUrl: "https://example.test/jobs/test-chain",
    }));
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(result.success).toBe(true);
    const started = logEvents().filter((e) => e.event === "screen.started");
    expect(started).toHaveLength(1);
    expect(started[0].trigger).toBe("scheduled");
    expect(started[0].universe).toBe("TECH");
    expect(started[0].actor_id).toBe("test_trader");
    expect(typeof started[0].trace_id).toBe("string");
  });

  it("a rejected submission emits screen.failed with the classifier verdict", async () => {
    const { service, publish } = unblockedService();
    (service as any).shardSubmit = vi.fn(async () => {
      throw new Error("E*TRADE auth token expired");
    });
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(result.success).toBe(false);
    const failed = logEvents().filter((e) => e.event === "screen.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].classification).toBe("auth");
    expect(failed[0].trigger).toBe("scheduled");
    expect(String(failed[0].error)).toContain("auth token expired");
    const busFailed = publish.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "screener.failed");
    expect(busFailed).toHaveLength(1);
  });

  it("a missing-port submission emits screen.failed (classification unknown: a config error, not a classified kind)", async () => {
    const { service } = unblockedService();
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(result.success).toBe(false);
    const failed = logEvents().filter((e) => e.event === "screen.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].classification).toBe("unknown");
    expect(String(failed[0].error)).toContain("submission port");
  });

  it("the aspects map names the chain submission join points", () => {
    const src = readFileSync("src/workflows/screenRunAspects.ts", "utf8");
    expect(src).toContain("chain submission");
  });
});
