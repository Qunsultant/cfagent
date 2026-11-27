/**
 * Regression & pinning tests for #5043 — Silent no-ops:
 *  - G-4: D1 audit-chain prune wired into /schedules/trigger-retention
 *  - G-8: Structured logger sink failures surface loudly (never silently lost)
 *  - G-10: (retired by #6101) the run-ledger project queue transport is gone
 *    with the projector; the owner-scoped dispatch + shared-instance
 *    fallback it pinned has no surviving code path
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStructuredLogger } from "../src/observability/structuredLogger";
import type { ObservabilityEvent, ObservabilitySink } from "../src/observability/observabilityPorts";
import * as queueRoutes from "../src/server/routes/queue";

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

  it("G-10 (retired by #6101): the run-ledger project queue transport is gone — no dispatch entry point, no project routing", () => {
    // Issue #6101 retires the #6099 projector by removing the DO write it
    // copies from, and with it the projector's three carriers — ORM hooks,
    // queue transport, sweep (RETHINK.md §(c)). The queue transport's entry
    // point (dispatchRunLedgerProjectQueueWork) and its handleQueueBatch
    // call site are deleted by design; the deletion of the projector
    // family (projectQueuedRunLedger, reconcileRunLedgerProjection,
    // runLedgerProjectionHooks/Posting/QueueTransport) is pinned in
    // orchestrator_class_inventory.test.ts. The owner-scoped dispatch +
    // shared-instance fallback these two tests pinned has no surviving
    // code path to scope, so the tests become a pin of the retirement:
    // re-introducing the transport fails here instead of silently
    // reviving a DO-copy path.
    const queueSrc = readFileSync(
      resolve(process.cwd(), "src/server/routes/queue.ts"),
      "utf8",
    );
    expect(queueSrc).not.toContain("dispatchRunLedgerProjectQueueWork");
    expect(queueSrc).not.toContain("projectQueuedRunLedger");
    // Namespace import (static, so the module loads at collection time):
    // the entry point must not be exported at all.
    expect(
      (queueRoutes as unknown as Record<string, unknown>).dispatchRunLedgerProjectQueueWork,
    ).toBeUndefined();
  });
});
