/**
 * Issue #2868 (AOP slice under #2764) — pins for the two
 * once-only aspect implementations: failure classification
 * and structured run logging. The aspect map itself
 * (SCREEN_RUN_ASPECTS) names the pre-existing join points;
 * these tests pin the new pieces, not the map's prose.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  SCREEN_RUN_ASPECTS,
  classifyScreenFailure,
  logScreenRunEvent,
} from "../src/workflows/screenRunAspects";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyScreenFailure", () => {
  it("classifies already-running as retryable, ahead of any other reading", () => {
    expect(
      classifyScreenFailure(
        new Error("Screen already running for NASDAQ100 (started 12s ago). Please wait for it to complete."),
      ),
    ).toBe("retryable");
  });

  it("classifies auth/token failures as auth", () => {
    expect(classifyScreenFailure(new Error("No authenticated E*TRADE account is associated with this scheduled screen."))).toBe("auth");
    expect(classifyScreenFailure(new Error("E*TRADE token renewal failed"))).toBe("auth");
    expect(classifyScreenFailure(new Error("E*TRADE auth dead"))).toBe("auth");
  });

  it("classifies provider outages as provider", () => {
    expect(classifyScreenFailure(new Error("E*TRADE unavailable"))).toBe("provider");
    expect(classifyScreenFailure(new Error("Yahoo Finance unavailable"))).toBe("provider");
  });

  it("classifies malformed input as validation and the rest as unknown", () => {
    expect(classifyScreenFailure(new Error("symbol is required"))).toBe("validation");
    expect(classifyScreenFailure(new Error("something entirely new broke"))).toBe("unknown");
    expect(classifyScreenFailure("plain string failure")).toBe("unknown");
  });
});

describe("logScreenRunEvent", () => {
  // Issue #3515 S3 batch 5: the run event rides the S2 structured
  // logger now — the console-info JSON fallback carries the
  // ObservabilityEvent (operation + level + fields), not the old
  // hand-built line. Same fields, same severities.
  function structuredEvents(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, any>> {
    const out: Array<Record<string, any>> = [];
    for (const call of spy.mock.calls) {
      try {
        const parsed = JSON.parse(String(call[0])) as Record<string, any>;
        if (parsed && typeof parsed.operation === "string") out.push(parsed);
      } catch {
        // Non-JSON console.info lines are not structured events.
      }
    }
    return out;
  }

  it("emits one structured event with the standards fields and no invented tenant", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logScreenRunEvent({
      event: "screen.completed",
      trigger: "manual",
      universe: "NASDAQ100",
      userLogin: "alice",
      traceId: "trace-1",
      success: true,
      matchedCount: 3,
      durationMs: 42,
    });
    const events = structuredEvents(spy).filter(
      (e) => e.operation === "screenRunAspects.screen_run_event",
    );
    expect(events).toHaveLength(1);
    const line = events[0];
    expect(line.level).toBe("info");
    expect(line.component).toBe("workflows/screenRunAspects");
    expect(line.traceId).toBe("trace-1");
    expect(line.agentId).toBe("screener-agent");
    expect(line.actorId).toBe("alice");
    expect(line.fields.event).toBe("screen.completed");
    expect(line.fields.matchedCount).toBe(3);
    expect(line.fields.durationMs).toBe(42);
    expect(line.tenantId).toBeNull();
    spy.mockRestore();
  });

  it("carries classification and error on failures", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logScreenRunEvent({
      event: "screen.failed",
      trigger: "scheduled",
      universe: "TECH",
      traceId: "trace-2",
      classification: "provider",
      error: "E*TRADE unavailable",
    });
    const events = structuredEvents(spy).filter(
      (e) => e.operation === "screenRunAspects.screen_run_event",
    );
    expect(events).toHaveLength(1);
    const line = events[0];
    expect(line.fields.classification).toBe("provider");
    expect(line.fields.error).toBe("E*TRADE unavailable");
    spy.mockRestore();
  });

  it("never throws, even when logging itself throws", () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("log sink down");
    });
    expect(() =>
      logScreenRunEvent({
        event: "screen.started",
        trigger: "manual",
        universe: "TECH",
        traceId: "trace-3",
      }),
    ).not.toThrow();
  });

  it("names one join point per concern, with no second implementation claimed", () => {
    expect(Object.keys(SCREEN_RUN_ASPECTS).sort()).toEqual([
      "authScoping",
      "delivery",
      "failureClassification",
      "logging",
      "paidRun",
      "partialResultMarking",
      "provenance",
      "retry",
      // Issue #2860 (Factor 14): the metrics accumulator join point.
      "telemetry",
    ]);
    for (const aspect of Object.values(SCREEN_RUN_ASPECTS)) {
      expect(aspect.joinPoint.length).toBeGreaterThan(0);
    }
  });
});
