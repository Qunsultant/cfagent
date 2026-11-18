/**
 * Regression & pinning tests for #5043 — Silent no-ops:
 *  - G-4: D1 audit-chain prune wired into /schedules/trigger-retention
 *  - G-8: Structured logger sink failures surface loudly (never silently lost)
 *  - G-10: Queue shared-instance fallback is strictly owner/tenant-scoped
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStructuredLogger } from "../src/observability/structuredLogger";
import type { ObservabilityEvent, ObservabilitySink } from "../src/observability/observabilityPorts";
import { dispatchRunLedgerProjectQueueWork } from "../src/server/routes/queue";

describe("#5043 silent no-ops", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("G-4: /schedules/trigger-retention wires pruneAuditChainForTenant and reports d1AuditChainPrune", () => {
    const schedulesSrc = readFileSync(
      resolve(process.cwd(), "src/agents/routes/schedules.ts"),
      "utf8",
    );
    expect(schedulesSrc).toContain("pruneAuditChainForTenant");
    expect(schedulesSrc).toContain("createAuditPolicyAdapter");
    expect(schedulesSrc).toContain("d1AuditChainPrune");
  });

  it("G-8: surfaces sync and async logger sink failures without throwing to the caller", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const observed: Array<{ op: string; msg: string }> = [];

    const syncFailSink: ObservabilitySink = {
      write() {
        throw new Error("sync sink boom");
      },
    };
    const syncLogger = createStructuredLogger(syncFailSink, {
      tenantId: "primary",
      onSinkFailure: (ev, err) => {
        observed.push({ op: ev.operation, msg: err instanceof Error ? err.message : String(err) });
      },
    });
    expect(() => syncLogger.info("test.sync_op", { a: 1 })).not.toThrow();

    const asyncFailSink: ObservabilitySink = {
      async write() {
        throw new Error("async sink boom");
      },
    };
    const asyncLogger = createStructuredLogger(asyncFailSink, {
      tenantId: "primary",
      onSinkFailure: (ev, err) => {
        observed.push({ op: ev.operation, msg: err instanceof Error ? err.message : String(err) });
      },
    });
    expect(() => asyncLogger.error("test.async_op", { b: 2 })).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    expect(observed).toEqual([
      { op: "test.sync_op", msg: "sync sink boom" },
      { op: "test.async_op", msg: "async sink boom" },
    ]);
    expect(infoSpy).toHaveBeenCalledTimes(2);
    const firstPayload = JSON.parse(String(infoSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(firstPayload.type).toBe("structured_logger.sink_failed");
    const fields = firstPayload.fields as Record<string, unknown>;
    expect(fields.originalOperation).toBe("test.sync_op");
    expect((fields.droppedEvent as ObservabilityEvent).operation).toBe("test.sync_op");
  });

  it("G-10: refuses blank userLogin or tenantId before trying shared-instance fallback", async () => {
    const idFromName = vi.fn();
    const env = {
      ORCHESTRATOR_AGENT: { idFromName, get: vi.fn() },
    } as never;

    await expect(
      dispatchRunLedgerProjectQueueWork({
        env,
        project: {
          ledger: "reports",
          naturalKey: "rep-1",
          tenantId: "primary",
          userLogin: "   ",
        },
      }),
    ).rejects.toThrow(/non-empty owner scoping/);

    await expect(
      dispatchRunLedgerProjectQueueWork({
        env,
        project: {
          ledger: "reports",
          naturalKey: "rep-1",
          tenantId: "",
          userLogin: "alice",
        },
      }),
    ).rejects.toThrow(/non-empty owner scoping/);

    expect(idFromName).not.toHaveBeenCalled();
  });

  it("G-10: forwards owner-scoped input (userLogin + tenantId) to shared instance on per-user missing-row", async () => {
    const calls: Array<{ instance: string; input: unknown }> = [];
    const env = {
      ORCHESTRATOR_AGENT: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          projectQueuedRunLedger: async (input: unknown) => {
            calls.push({ instance: name, input });
            if (name === "alice") return { status: "missing-row" };
            return { status: "projected" };
          },
        }),
      },
    } as never;

    const status = await dispatchRunLedgerProjectQueueWork({
      env,
      project: {
        ledger: "reports",
        naturalKey: "rep-42",
        tenantId: "tenant-a",
        userLogin: "alice",
      },
    });

    expect(status).toBe("projected");
    expect(calls).toEqual([
      {
        instance: "alice",
        input: { ledger: "reports", naturalKey: "rep-42", tenantId: "tenant-a", userLogin: "alice" },
      },
      {
        instance: "shared_orchestrator",
        input: { ledger: "reports", naturalKey: "rep-42", tenantId: "tenant-a", userLogin: "alice" },
      },
    ]);
  });
});
