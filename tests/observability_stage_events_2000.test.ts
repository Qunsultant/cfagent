/**
 * Issue #2000 Phase 5 slice 4 — stage events into the #1743 stream
 * as NEW TYPE VALUES ONLY (no schema change).
 *
 * The staged path's stage vocabulary comes from the #1743 fold
 * whitelist (src/observability/observabilityPorts.ts):
 * feed, gather, analysis, deliver — each with a completed and a
 * failed form. One fold case per type; each carries counts+ids
 * only (tenantId, runId, optional count). Prompt text, thesis
 * text, identities, error messages, and any other user material
 * never survive the fold, even when a producer envelope carries
 * them. Unknown types fold to null (whitelist closed) — note in
 * particular that `serve` is NOT in the whitelist, so a serve
 * stage event folds to null by design.
 */
import { describe, it, expect } from "vitest";
import {
  foldEnvelopeToEvent,
  writeEnvelopeToSink,
} from "../src/observability/observabilityPorts";
import { InMemoryObservabilityAdapter } from "../src/observability/inMemoryObservabilityAdapter";
import type { MessageEnvelope } from "../src/messaging/messagingPorts";

function envelope(
  over: Partial<MessageEnvelope> & { type: string },
): MessageEnvelope {
  return {
    specversion: "1.0",
    id: "evt-stage-1",
    source: "test",
    time: "2026-11-02T00:00:00.000Z",
    data: {},
    ...over,
  };
}

const STAGE_TYPES = [
  "screener.stage.feed_completed",
  "screener.stage.feed_failed",
  "screener.stage.gather_completed",
  "screener.stage.gather_failed",
  "screener.stage.analysis_completed",
  "screener.stage.analysis_failed",
  "screener.stage.deliver_completed",
  "screener.stage.deliver_failed",
] as const;

describe("stage events into #1743 (slice 4, new types only)", () => {
  it.each(STAGE_TYPES)("folds %s with ids and optional count", (type) => {
    const failed = type.endsWith("_failed");
    const e = foldEnvelopeToEvent(
      envelope({
        type,
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        data: { tenantId: "tenant-a", runId: "run-1", count: 42 },
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.type).toBe(type);
    expect(e!.operation).toBe("screener.stage");
    expect(e!.level).toBe(failed ? "error" : "info");
    expect(e!.tenantId).toBe("tenant-a");
    expect(e!.runId).toBe("run-1");
    expect(e!.fields).toEqual({ count: 42 });
    expect(e!.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    if (failed) expect(e!.errorCode).toBe(type);
    else expect(e!.errorCode).toBeUndefined();
  });

  it.each(STAGE_TYPES)("folds %s without a count", (type) => {
    const e = foldEnvelopeToEvent(
      envelope({
        type,
        data: { tenantId: "tenant-a", runId: "run-1" },
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.fields).toEqual({});
  });

  it.each(STAGE_TYPES)("drops %s when tenantId is missing", (type) => {
    expect(
      foldEnvelopeToEvent(
        envelope({ type, data: { runId: "run-1", count: 1 } }),
      ),
    ).toBeNull();
  });

  it.each(STAGE_TYPES)("drops %s when runId is missing", (type) => {
    expect(
      foldEnvelopeToEvent(
        envelope({ type, data: { tenantId: "tenant-a", count: 1 } }),
      ),
    ).toBeNull();
  });

  it.each(STAGE_TYPES)("drops %s when data is not an object", (type) => {
    expect(
      foldEnvelopeToEvent(envelope({ type, data: "not-an-object" })),
    ).toBeNull();
  });

  it("omits a non-numeric count but still folds the stage event", () => {
    const e = foldEnvelopeToEvent(
      envelope({
        type: "screener.stage.feed_completed",
        data: { tenantId: "tenant-a", runId: "run-1", count: "many" },
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.fields).toEqual({});
  });

  it("never lets prompt text, thesis text, identities, or error messages survive", () => {
    const e = foldEnvelopeToEvent(
      envelope({
        type: "screener.stage.analysis_failed",
        data: {
          tenantId: "tenant-a",
          runId: "run-1",
          count: 3,
          promptKey: "prompt-secret",
          promptText: "do something secret",
          thesis: "bullish thesis text",
          thesisText: "bullish thesis text",
          appliedBy: "alice",
          decidedBy: "bob",
          userLogin: "alice",
          error: "boom: connection reset",
          errorMessage: "boom: connection reset",
        },
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.fields).toEqual({ count: 3 });
    expect(e!.errorCode).toBe("screener.stage.analysis_failed");
    const serialized = JSON.stringify(e);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("bullish");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("bob");
    expect(serialized).not.toContain("boom");
  });

  it("folds unknown stage types to null (whitelist closed)", () => {
    for (const type of [
      "screener.stage.serve_completed",
      "screener.stage.serve_failed",
      "screener.stage.feed_started",
      "screener.stage.gather",
      "screener.stage_completed",
    ]) {
      expect(
        foldEnvelopeToEvent(
          envelope({ type, data: { tenantId: "tenant-a", runId: "run-1" } }),
        ),
      ).toBeNull();
    }
  });

  it("writes a stage event through the sink and refuses an unknown type", async () => {
    const sink = new InMemoryObservabilityAdapter();
    const wrote = await writeEnvelopeToSink(
      sink,
      envelope({
        type: "screener.stage.deliver_completed",
        data: { tenantId: "tenant-a", runId: "run-1", count: 7 },
      }),
    );
    expect(wrote).toBe(true);
    const events = sink.events;
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("screener.stage.deliver_completed");
    expect(events[0].runId).toBe("run-1");
    const refused = await writeEnvelopeToSink(
      sink,
      envelope({
        type: "screener.stage.serve_completed",
        data: { tenantId: "tenant-a", runId: "run-1" },
      }),
    );
    expect(refused).toBe(false);
    expect(sink.events.length).toBe(1);
  });

  it("leaves previously-allowed types folding exactly as before", () => {
    const breaker = foldEnvelopeToEvent(
      envelope({
        type: "breaker.state_changed",
        data: {
          providerId: "yahoo",
          from: "closed",
          to: "open",
          trips: 2,
          fallbacks: 1,
        },
      }),
    );
    expect(breaker).not.toBeNull();
    expect(breaker!.operation).toBe("breaker.state_changed");
    expect(breaker!.level).toBe("warn");
    const screener = foldEnvelopeToEvent(
      envelope({
        type: "screener.completed",
        subject: "delivery-1",
        data: { event: { kind: "done" }, ownerLogin: "alice" },
      }),
    );
    expect(screener).not.toBeNull();
    expect(screener!.operation).toBe("screener.delivery");
    expect(screener!.tenantId).toBe("alice");
  });
});
