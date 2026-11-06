/**
 * Issue #2860 (15-factor re-audit, Factor 8 Concurrency) — fail-closed
 * chain lock / active-chain probes in autonomousMarketScreenSharded.
 *
 * The re-audit's remaining Factor 8 gap: both probes failed OPEN — a
 * probe that could not answer let the sharded chain proceed ungated
 * (a deliberate availability choice, documented in scheduledTasks.ts).
 * Fully-compliant remediation (user decision 2026-11-06, NOT the
 * risk-accepted alternative): a probe that cannot answer REFUSES the
 * submission — the skipped shape the caller already honors, with the
 * new skippedReason "gate-unavailable" and an audit record, so the
 * refusal is visible instead of silent. Per-owner locking still gates
 * execution where the probe answers (already-running, unchanged).
 *
 * Boundary, stated plainly: when platformDeps.sql is absent the
 * active-chain probe is not configured at all (only the lock probe
 * applies — the pre-#1993 host shape); fail-closed covers a probe
 * that was attempted and threw, not an unconfigured probe. That
 * boundary is pinned by the last test below.
 */
import { describe, it, expect, vi } from "vitest";

async function gatedService(opts: {
  running?: boolean;
  lockThrows?: boolean;
  /** Rows the active-chain scan returns (undefined = no platform sql). */
  activeChainRows?: Array<Record<string, unknown>>;
  activeChainThrows?: boolean;
}) {
  const { ScheduledTasksService } = await import("../src/services/scheduledTasks");
  const { DatabaseORM } = await import("../src/orm");
  const mockEnv = {
    ETRADE_ENVIRONMENT: "sandbox",
    ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
  } as any;
  const platformDeps =
    opts.activeChainRows === undefined && !opts.activeChainThrows
      ? undefined
      : ({
          sql: {
            exec: (query: string) => {
              if (opts.activeChainThrows) throw new Error("async-job store unavailable");
              if (String(query).includes("mas_async_jobs")) return opts.activeChainRows ?? [];
              return [];
            },
          },
        } as any);
  const service = new ScheduledTasksService(
    mockEnv,
    new DatabaseORM({ exec: () => [] } as any),
    "test_trader",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    platformDeps,
  );
  (service as any).publishScreenerEvent = vi.fn(async () => {});
  (service as any).guardScheduledAuth = async () => ({ blocked: false });
  (service as any).getScreenerAgent = () => ({
    isScreenRunning: async () => {
      if (opts.lockThrows) throw new Error("lock store unavailable");
      const running = opts.running ?? false;
      return { running, startedAt: running ? Date.now() : null };
    },
  });
  const shardSubmit = vi.fn(async () => ({
    jobId: "test-chain",
    status: "queued" as const,
    statusUrl: "https://example.test/jobs/test-chain",
  }));
  (service as any).shardSubmit = shardSubmit;
  return { service, shardSubmit };
}

describe("fail-closed chain probes (#2860 Factor 8)", () => {
  it("refuses submission when the lock probe cannot answer (no submit, gate-unavailable)", async () => {
    const { service, shardSubmit } = await gatedService({ lockThrows: true });
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(shardSubmit).not.toHaveBeenCalled();
    expect((result as any).skipped).toBe(true);
    expect((result as any).skippedReason).toBe("gate-unavailable");
  });

  it("refuses submission when the active-chain probe cannot answer (no submit, gate-unavailable)", async () => {
    const { service, shardSubmit } = await gatedService({ activeChainThrows: true });
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(shardSubmit).not.toHaveBeenCalled();
    expect((result as any).skipped).toBe(true);
    expect((result as any).skippedReason).toBe("gate-unavailable");
  });

  it("still refuses with already-running when the lock probe answers held", async () => {
    const { service, shardSubmit } = await gatedService({ running: true });
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(shardSubmit).not.toHaveBeenCalled();
    expect((result as any).skippedReason).toBe("already-running");
  });

  it("still refuses with already-running when the active-chain probe answers active", async () => {
    const { service, shardSubmit } = await gatedService({
      activeChainRows: [
        {
          payload_json: JSON.stringify({
            chain: { userLogin: "test_trader", universe: "TECH" },
          }),
        },
      ],
    });
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(shardSubmit).not.toHaveBeenCalled();
    expect((result as any).skippedReason).toBe("already-running");
  });

  it("still submits when both probes answer clear", async () => {
    const { service, shardSubmit } = await gatedService({ activeChainRows: [] });
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(shardSubmit).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it("submits when no platform sql is configured (lock probe only — the unconfigured-probe boundary)", async () => {
    const { service, shardSubmit } = await gatedService({});
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(shardSubmit).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});
