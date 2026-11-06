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
  it("emits one JSON line with the standards fields and no invented tenant", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
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
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(spy.mock.calls[0][0]));
    expect(line.trace_id).toBe("trace-1");
    expect(line.agent_id).toBe("screener-agent");
    expect(line.actor_id).toBe("alice");
    expect(line.event).toBe("screen.completed");
    expect(line.matched_count).toBe(3);
    expect(line.duration_ms).toBe(42);
    expect(line).not.toHaveProperty("tenant_id");
  });

  it("carries classification and error on failures", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logScreenRunEvent({
      event: "screen.failed",
      trigger: "scheduled",
      universe: "TECH",
      traceId: "trace-2",
      classification: "provider",
      error: "E*TRADE unavailable",
    });
    const line = JSON.parse(String(spy.mock.calls[0][0]));
    expect(line.classification).toBe("provider");
    expect(line.error).toBe("E*TRADE unavailable");
  });

  it("never throws, even when logging itself throws", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
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
