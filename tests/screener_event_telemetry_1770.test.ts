/**
 * Issue #1770 (slice C): screener-loop outcomes reach the EXISTING
 * Analytics Engine sink. foldEnvelopeToEvent already maps
 * screener.completed/failed envelopes to screener.delivery telemetry
 * events, but no screener-loop caller wrote them before — the loop
 * emitted nothing. These tests pin the new bus/queue-path emission
 * helper; the chained followup path is excluded by design (it owns
 * its own delivery errors) and is not covered here.
 */
import { describe, it, expect, vi } from "vitest";
import { writeScreenerEventTelemetry } from "../src/services/scheduledTasks";
import type {
  ScreenerCompletedEvent,
  ScreenerFailedEvent,
} from "../src/events/screenerEvents";

vi.mock("agents", () => ({
  Agent: class {},
}));

function fakeDataset(captured: unknown[]) {
  return {
    writeDataPoint: (point: unknown) => {
      captured.push(point);
    },
  };
}

const completedEvent = (): ScreenerCompletedEvent => ({
  type: "screener.completed",
  timestamp: "2026-11-02T00:00:00.000Z",
  sector: "ALL",
  totalScanned: 10,
  matchedCount: 2,
  opportunities: [],
  deliveryId: "scheduled:TECH:2026-11-02T00:00",
});

const failedEvent = (): ScreenerFailedEvent => ({
  type: "screener.failed",
  timestamp: "2026-11-02T00:00:00.000Z",
  sector: "ALL",
  error: "boom",
  deliveryId: "scheduled:TECH:2026-11-02T00:00",
});

describe("writeScreenerEventTelemetry (#1770 slice C)", () => {
  it("writes a screener.delivery point for a completed run", async () => {
    const captured: any[] = [];
    const ok = await writeScreenerEventTelemetry(
      { OBSERVABILITY: fakeDataset(captured) },
      "trader1",
      completedEvent(),
    );
    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    // blobs per eventToDataPoint: [type, level, operation, runId,
    // sessionRef, traceId, errorCode, actorId, agentId, component,
    // timestampIso, fieldsJson]. The fold keeps the envelope type
    // and puts "screener.delivery" in operation.
    expect(captured[0].blobs[0]).toBe("screener.completed");
    expect(captured[0].blobs[1]).toBe("info");
    expect(captured[0].blobs[2]).toBe("screener.delivery");
    expect(captured[0].blobs[6]).toBe("");
  });

  it("writes an error-level point with the failure code for a failed run", async () => {
    const captured: any[] = [];
    const ok = await writeScreenerEventTelemetry(
      { OBSERVABILITY: fakeDataset(captured) },
      "trader1",
      failedEvent(),
    );
    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].blobs[0]).toBe("screener.failed");
    expect(captured[0].blobs[1]).toBe("error");
    expect(captured[0].blobs[2]).toBe("screener.delivery");
    expect(captured[0].blobs[6]).toBe("screener.failed");
  });

  it("writes nothing for an options event (the fold maps only screener.*)", async () => {
    const captured: any[] = [];
    const ok = await writeScreenerEventTelemetry(
      { OBSERVABILITY: fakeDataset(captured) },
      "trader1",
      {
        type: "options.completed",
        timestamp: "2026-11-02T00:00:00.000Z",
        sector: "ALL",
        totalScanned: 5,
        matchedCount: 0,
        opportunities: [],
      } as any,
    );
    expect(ok).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it("never rejects when the dataset throws (Safe sink swallows; the run must not fail)", async () => {
    const captured: any[] = [];
    const throwing = {
      writeDataPoint: () => {
        throw new Error("dataset down");
      },
    };
    const ok = await writeScreenerEventTelemetry(
      { OBSERVABILITY: throwing },
      "trader1",
      completedEvent(),
    );
    // The write is best-effort: it resolves, and nothing crashes
    // the caller, whether the sink reports success or swallows.
    expect(typeof ok).toBe("boolean");
    expect(captured).toHaveLength(0);
  });

  it("works without a binding (console fallback sink, no throw)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = await writeScreenerEventTelemetry({}, "trader1", completedEvent());
    expect(ok).toBe(true);
    warn.mockRestore();
  });
});
