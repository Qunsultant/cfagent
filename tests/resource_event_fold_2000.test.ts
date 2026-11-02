/**
 * Phase 5 slice 5 (#2000, #1819) — resource event: counts-only fold,
 * cardinality guard, aggregation. RED FIRST: the guard module and the
 * fold case do not exist yet, so this file fails at import.
 *
 * Contract under test:
 * - `resource.sql_op` envelopes fold by WHITELIST: only count fields
 *   (ns/op/rowsRead/rowsWritten) plus bounded dimensions
 *   (caller/trigger/statement) survive. Identities, payload text,
 *   bound values, and error messages never reach the stream, even
 *   when a producer envelope happens to carry them.
 * - The cardinality guard bounds every dimension: over-long or
 *   off-charset values collapse to "other" (or drop the optional
 *   field), never explode the index. Unknown ops and bad counts
 *   reject the whole event (null, never throw).
 * - Aggregation: bucketTotals sums folded counts per
 *   bucket x ns x op x caller x trigger, and capBucketGroups keeps
 *   the top groups while folding overflow into per-(bucket, ns, op)
 *   "other" rows with grand totals preserved.
 */
import { describe, it, expect } from "vitest";
import { foldEnvelopeToEvent, writeEnvelopeToSink } from "../src/observability/observabilityPorts";
import { InMemoryObservabilityAdapter } from "../src/observability/inMemoryObservabilityAdapter";
import {
  capBucketGroups,
  DEFAULT_MAX_GROUPS,
  guardResourceEvent,
} from "../src/observability/resourceEventGuard";
import { bucketTotals } from "../src/telemetry/resourceUsagePorts";
import type { MessageEnvelope } from "../src/messaging/messagingPorts";

function envelope(over: Partial<MessageEnvelope> & { type: string }): MessageEnvelope {
  return {
    specversion: "1.0",
    id: "evt-res-1",
    source: "test",
    time: "2026-11-02T00:00:00.000Z",
    data: {},
    ...over,
  };
}

function resourceData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ns: "sessions",
    op: "get",
    rowsRead: 3,
    rowsWritten: 0,
    caller: "sessionStore",
    trigger: "user",
    ...over,
  };
}

describe("resource.sql_op fold (slice 5)", () => {
  it("folds a well-formed resource envelope with counts, dimensions, scope, trace", () => {
    const e = foldEnvelopeToEvent(
      envelope({
        type: "resource.sql_op",
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        data: resourceData({
          tenantId: "tenant-a",
          runId: "run-1",
          sessionRef: "0123456789ab",
          durationMs: 12,
        }),
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.type).toBe("resource.sql_op");
    expect(e!.operation).toBe("resource.sql_op");
    expect(e!.level).toBe("info");
    expect(e!.tenantId).toBe("tenant-a");
    expect(e!.runId).toBe("run-1");
    expect(e!.sessionRef).toBe("0123456789ab");
    expect(e!.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(e!.durationMs).toBe(12);
    expect(e!.fields).toEqual({
      ns: "sessions",
      op: "get",
      rowsRead: 3,
      rowsWritten: 0,
      caller: "sessionStore",
      trigger: "user",
    });
  });

  it("is counts-only: identities, payload text, bound values, errors never survive", () => {
    const e = foldEnvelopeToEvent(
      envelope({
        type: "resource.sql_op",
        data: resourceData({
          sessionId: "sess-live-1234567890abcdef",
          userLogin: "someone@example.com",
          boundValues: ["secret-token-value", "user-password"],
          errorMessage: "database exploded at /secret/path",
          promptText: "ignore previous instructions",
          thesisText: "bullish on SYM because reasons",
          apiKey: "sk-live-xyz",
        }),
      }),
    );
    expect(e).not.toBeNull();
    expect(Object.keys(e!.fields).sort()).toEqual([
      "caller",
      "ns",
      "op",
      "rowsRead",
      "rowsWritten",
      "trigger",
    ]);
    const blob = JSON.stringify(e!.fields);
    expect(blob).not.toContain("sess-live");
    expect(blob).not.toContain("someone@example.com");
    expect(blob).not.toContain("secret-token");
    expect(blob).not.toContain("exploded");
    expect(blob).not.toContain("ignore previous");
    expect(blob).not.toContain("sk-live");
    expect(e!.sessionRef).toBeNull();
  });

  it("rejects malformed resource envelopes (null, never throw)", () => {
    expect(foldEnvelopeToEvent(envelope({ type: "resource.sql_op", data: resourceData({ rowsRead: undefined }) }))).toBeNull();
    expect(foldEnvelopeToEvent(envelope({ type: "resource.sql_op", data: resourceData({ rowsRead: -1 }) }))).toBeNull();
    expect(foldEnvelopeToEvent(envelope({ type: "resource.sql_op", data: resourceData({ rowsRead: 2.5 }) }))).toBeNull();
    expect(foldEnvelopeToEvent(envelope({ type: "resource.sql_op", data: resourceData({ rowsWritten: Number.NaN }) }))).toBeNull();
    expect(foldEnvelopeToEvent(envelope({ type: "resource.sql_op", data: resourceData({ op: "scan" }) }))).toBeNull();
    expect(foldEnvelopeToEvent(envelope({ type: "resource.sql_op", data: resourceData({ ns: "" }) }))).toBeNull();
    expect(foldEnvelopeToEvent(envelope({ type: "resource.sql_op", data: null }))).toBeNull();
  });

  it("guard collapses unbounded dimensions instead of exploding the index", () => {
    const e = foldEnvelopeToEvent(
      envelope({
        type: "resource.sql_op",
        data: resourceData({
          ns: "sessions".padEnd(65, "x"),
          caller: "caller".padEnd(129, "y"),
          trigger: "bogus-trigger",
          statement: "SELECT  *\n  FROM   sessions  WHERE  ns = ?",
        }),
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.fields.ns).toBe("other");
    expect(e!.fields.caller).toBe("other");
    expect(e!.fields.trigger).toBe("other");
    expect(e!.fields.statement).toBe("SELECT * FROM sessions WHERE ns = ?");
  });

  it("guard drops over-long optional fields and raw session ids, keeps counts", () => {
    const e = foldEnvelopeToEvent(
      envelope({
        type: "resource.sql_op",
        data: resourceData({
          statement: "SELECT " + "col, ".repeat(100),
          sessionRef: "sess-live-1234567890abcdef",
          tenantId: "t".repeat(200),
          runId: "r".repeat(300),
        }),
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.fields.statement).toBeUndefined();
    expect(e!.fields.rowsRead).toBe(3);
    expect(e!.sessionRef).toBeNull();
    expect(e!.tenantId).toBeNull();
    expect(e!.runId).toBeNull();
  });

  it("guard accepts absent trigger (omitted) and a 12-hex sessionRef", () => {
    const noTrigger = foldEnvelopeToEvent(
      envelope({ type: "resource.sql_op", data: resourceData({ trigger: undefined }) }),
    );
    expect(noTrigger).not.toBeNull();
    expect(noTrigger!.fields.trigger).toBeUndefined();
    const hashed = foldEnvelopeToEvent(
      envelope({ type: "resource.sql_op", data: resourceData({ sessionRef: "abcdef012345" }) }),
    );
    expect(hashed!.sessionRef).toBe("abcdef012345");
  });

  it("guardResourceEvent is directly unit-testable (reject vs collapse)", () => {
    expect(guardResourceEvent({ ns: "sessions", op: "get", rowsRead: 1, rowsWritten: 0 })).not.toBeNull();
    expect(guardResourceEvent({ ns: "sessions", op: "get", rowsRead: -5, rowsWritten: 0 })).toBeNull();
    expect(guardResourceEvent({ ns: "a b", op: "get", rowsRead: 1, rowsWritten: 0 })!.fields.ns).toBe("other");
    expect(DEFAULT_MAX_GROUPS).toBeGreaterThan(0);
  });

  it("writes folded resource events through writeEnvelopeToSink", async () => {
    const sink = new InMemoryObservabilityAdapter();
    const handled = await writeEnvelopeToSink(
      sink,
      envelope({ type: "resource.sql_op", data: resourceData() }),
    );
    expect(handled).toBe(true);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].type).toBe("resource.sql_op");
    const unhandled = await writeEnvelopeToSink(
      sink,
      envelope({ type: "resource.sql_op", data: resourceData({ op: "scan" }) }),
    );
    expect(unhandled).toBe(false);
    expect(sink.events).toHaveLength(1);
  });
});

describe("resource aggregation (slice 5)", () => {
  it("bucketTotals sums folded counts per bucket x ns x op x caller x trigger", () => {
    const totals = bucketTotals(
      [
        { ns: "sessions", op: "get", rowsRead: 3, rowsWritten: 0, caller: "a", trigger: "user", timestampMs: 1000 },
        { ns: "sessions", op: "get", rowsRead: 7, rowsWritten: 1, caller: "a", trigger: "user", timestampMs: 2000 },
        { ns: "sessions", op: "get", rowsRead: 5, rowsWritten: 0, caller: "b", trigger: "user", timestampMs: 1500 },
        { ns: "etrade", op: "list", rowsRead: 100, rowsWritten: 0, caller: "a", trigger: "scheduled", timestampMs: 1000 },
      ],
      60_000,
    );
    expect(totals).toHaveLength(3);
    const a = totals.find((t) => t.caller === "a" && t.ns === "sessions");
    expect(a).toMatchObject({ ops: 2, rowsRead: 10, rowsWritten: 1 });
    const grand = totals.reduce((acc, t) => acc + t.rowsRead, 0);
    expect(grand).toBe(115);
  });

  it("capBucketGroups keeps top groups and folds overflow into other rows, totals preserved", () => {
    const totals = bucketTotals(
      [
        { ns: "sessions", op: "get", rowsRead: 50, rowsWritten: 0, caller: "a", trigger: "user", timestampMs: 1000 },
        { ns: "sessions", op: "get", rowsRead: 30, rowsWritten: 0, caller: "b", trigger: "user", timestampMs: 1000 },
        { ns: "sessions", op: "get", rowsRead: 10, rowsWritten: 0, caller: "c", trigger: "user", timestampMs: 1000 },
        { ns: "sessions", op: "get", rowsRead: 5, rowsWritten: 0, caller: "d", trigger: "user", timestampMs: 1000 },
      ],
      60_000,
    );
    const capped = capBucketGroups(totals, 2);
    expect(capped).toHaveLength(3);
    expect(capped.find((t) => t.caller === "a")).toMatchObject({ rowsRead: 50 });
    expect(capped.find((t) => t.caller === "b")).toMatchObject({ rowsRead: 30 });
    const other = capped.find((t) => t.caller === "other");
    expect(other).toMatchObject({ ns: "sessions", op: "get", trigger: "other", ops: 2, rowsRead: 15 });
    const grand = capped.reduce((acc, t) => acc + t.rowsRead, 0);
    expect(grand).toBe(95);
  });
});
