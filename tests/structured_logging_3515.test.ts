/**
 * Issue #3515 S2 — structured logging foundation (§2.2).
 *
 * The slice 0 audit found NO central structured logger in the tree
 * (grep for structuredLog / createLogger: zero hits) and 4 of the 7
 * mandatory attributes absent from the observability event schema
 * (actor_id, agent_id, component, timestamp_iso8601). This file pins
 * the new logger: `createStructuredLogger` in
 * src/observability/structuredLogger.ts.
 *
 * TDD red first: the module does not exist yet, so this file fails
 * at import. The logger is the seam the S3 console.* migration
 * adopts — one logger, scope defaults carried once, never
 * re-derived per call site.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createStructuredLogger,
  type StructuredLogger,
} from "../src/observability/structuredLogger";
import { InMemoryObservabilityAdapter } from "../src/observability/inMemoryObservabilityAdapter";
import {
  ConsoleObservabilitySink,
  type ObservabilityEvent,
  type ObservabilitySink,
} from "../src/observability/observabilityPorts";

function recordingSink() {
  const events: ObservabilityEvent[] = [];
  const sink: ObservabilitySink = {
    write: (event) => {
      events.push(event);
    },
    writeBatch: (list) => {
      for (const event of list) events.push(event);
    },
  };
  return { sink, events };
}

describe("createStructuredLogger — the 7 mandatory attributes", () => {
  it("emits all 7 mandatory attributes on every event", () => {
    const { sink, events } = recordingSink();
    const logger = createStructuredLogger(sink, {
      tenantId: "tenant-a",
      actorId: "actor-1",
      agentId: "screener",
      component: "screener-agent",
      traceId: "a".repeat(32),
      nowMs: () => 1_791_158_400_000,
    });
    logger.info("screener.completed", { count: 3 });

    expect(events).toHaveLength(1);
    const e = events[0];
    // trace_id / tenant_id / actor_id / agent_id / timestamp_iso8601 /
    // severity / component — the §2.2 mandatory seven.
    expect(e.traceId).toBe("a".repeat(32));
    expect(e.tenantId).toBe("tenant-a");
    expect(e.actorId).toBe("actor-1");
    expect(e.agentId).toBe("screener");
    expect(e.timestampMs).toBe(1_791_158_400_000);
    expect(e.timestampIso).toBe("2026-10-05T00:00:00.000Z");
    expect(e.level).toBe("info");
    expect(e.component).toBe("screener-agent");
    expect(e.operation).toBe("screener.completed");
    expect(e.type).toBe("screener.completed");
    expect(e.fields).toEqual({ count: 3 });
  });

  it("derives timestamp_iso8601 from timestampMs, never a second clock", () => {
    const { sink, events } = recordingSink();
    const logger = createStructuredLogger(sink, { nowMs: () => 0 });
    logger.warn("test.epoch");
    expect(events[0].timestampMs).toBe(0);
    expect(events[0].timestampIso).toBe("1970-01-01T00:00:00.000Z");
  });

  it("absent scope stays null — never fabricated", () => {
    const { sink, events } = recordingSink();
    const logger = createStructuredLogger(sink);
    logger.info("test.unscoped");
    const e = events[0];
    expect(e.tenantId).toBeNull();
    expect(e.actorId).toBeNull();
    expect(e.agentId).toBeNull();
    expect(e.component).toBeNull();
    expect(e.runId).toBeNull();
    expect(e.sessionRef).toBeNull();
    // A trace id is a correlator, not scope: a fresh one is minted,
    // never an empty string.
    expect(e.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("per-call overrides win over context defaults", () => {
    const { sink, events } = recordingSink();
    const logger = createStructuredLogger(sink, {
      tenantId: "tenant-a",
      actorId: "actor-1",
      component: "screener-agent",
      traceId: "a".repeat(32),
    });
    logger.info(
      "screener.completed",
      {},
      { tenantId: "tenant-b", component: "goal-leg", traceId: "b".repeat(32) },
    );
    const e = events[0];
    expect(e.tenantId).toBe("tenant-b");
    expect(e.component).toBe("goal-leg");
    expect(e.traceId).toBe("b".repeat(32));
    // Untouched defaults survive the override.
    expect(e.actorId).toBe("actor-1");
  });

  it("maps warn / error to severity and carries errorCode on error", () => {
    const { sink, events } = recordingSink();
    const logger: StructuredLogger = createStructuredLogger(sink, {
      nowMs: () => 1_791_158_400_000,
    });
    logger.warn("test.slow", { ms: 900 });
    logger.error("test.failed", {}, { errorCode: "screener.failed" });
    expect(events[0].level).toBe("warn");
    expect(events[0].errorCode).toBeUndefined();
    expect(events[1].level).toBe("error");
    expect(events[1].errorCode).toBe("screener.failed");
    expect(events[1].timestampIso).toBe("2026-10-05T00:00:00.000Z");
  });

  it("a throwing sink never fails the caller", () => {
    const throwing: ObservabilitySink = {
      write: () => {
        throw new Error("sink down");
      },
      writeBatch: () => {
        throw new Error("sink down");
      },
    };
    const logger = createStructuredLogger(throwing);
    expect(() => logger.info("test.sink-down")).not.toThrow();
    expect(() => logger.error("test.sink-down")).not.toThrow();
  });

  it("events flow through the port adapter with fields redacted", () => {
    const adapter = new InMemoryObservabilityAdapter();
    const logger = createStructuredLogger(adapter, {
      tenantId: "tenant-a",
      component: "test",
    });
    logger.info("test.secret", { apiKey: "sk-live-should-not-leak", count: 1 });
    expect(adapter.events).toHaveLength(1);
    const e = adapter.events[0];
    expect(e.fields.apiKey).toBe("***");
    expect(e.fields.count).toBe(1);
    // The 7 attributes survive the adapter untouched.
    expect(e.tenantId).toBe("tenant-a");
    expect(e.component).toBe("test");
    expect(e.timestampIso).toBe(new Date(e.timestampMs).toISOString());
  });

  it("the unbound fallback sink carries the 7 attributes as JSON", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    });
    try {
      const logger = createStructuredLogger(new ConsoleObservabilitySink(), {
        tenantId: "tenant-a",
        component: "test",
        nowMs: () => 1_791_158_400_000,
      });
      logger.info("test.console", { count: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.tenantId).toBe("tenant-a");
    expect(parsed.component).toBe("test");
    expect(parsed.timestampIso).toBe("2026-10-05T00:00:00.000Z");
    expect(parsed.level).toBe("info");
  });
});
