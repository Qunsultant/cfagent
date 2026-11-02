/**
 * Phase 5 Slice 1 (#2000) — persist helper + wiring.
 *
 * The persist helper is additive: the console dead-letter
 * record is always emitted first by the caller; persistence
 * never breaks the drop/ack path (it never throws), and a
 * null store is a plain no-op (today's console-only behavior).
 */
import { describe, it, expect, vi } from "vitest";
import { InMemoryDeadLetterStoreAdapter } from "../src/data/inMemoryDeadLetterStoreAdapter";
import { persistDeadLetterLanding } from "../src/messaging/deadLetterPersist";
import { createDeadLetterRecord } from "../src/messaging/deadLetter";
import { createScreenerEventsWorkHandler } from "../src/messaging/screenerEventsConsumer";
import { CfQueueMessagingAdapter, consumeCfBatch, dispatchSubscriberBatch } from "../src/messaging/cfQueueMessagingAdapter";

const ENVELOPE = {
  specversion: "1.0",
  id: "env-1",
  source: "test",
  type: "options_analysis",
  time: "2026-11-02T00:00:00.000Z",
  data: { taskType: "options_analysis", payload: { userLogin: "op1" } },
  jobid: "job-1",
};

describe("dead-letter persist helper (#2000 slice 1)", () => {
  it("inserts exactly once per landing and runs the depth check after insert", async () => {
    const store = new InMemoryDeadLetterStoreAdapter();
    const sendAlert = vi.fn(async () => {});
    const record = createDeadLetterRecord({ queue: "screener-events", reason: "no_handler", messageId: "env-1", runId: "job-1" });
    await persistDeadLetterLanding({ store, threshold: 10, sendAlert, nowMs: 5000 }, record, ENVELOPE);
    expect(await store.unreplayedCount()).toBe(1);
    const row = (await store.listUnreplayed(10))[0];
    expect(JSON.parse(row.envelopeJson as string)).toEqual(ENVELOPE);
    expect(sendAlert).not.toHaveBeenCalled();
    // Nine more landings cross the threshold: exactly one alert.
    for (let i = 0; i < 9; i++) {
      await persistDeadLetterLanding({ store, threshold: 10, sendAlert, nowMs: 6000 + i }, createDeadLetterRecord({ queue: "screener-events", reason: "no_handler", messageId: `m-${i}` }), null);
    }
    expect(await store.unreplayedCount()).toBe(10);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it("a failing store never throws; a null store is a no-op", async () => {
    const failing = {
      insert: async () => { throw new Error("d1 down"); },
      listUnreplayed: async () => [],
      getById: async () => null,
      markReplayed: async () => false,
      unreplayedCount: async () => 0,
      claimDepthIncident: async () => false,
      clearDepthIncident: async () => false,
    };
    const sendAlert = vi.fn(async () => {});
    await expect(
      persistDeadLetterLanding({ store: failing as never, threshold: 10, sendAlert, nowMs: 5000 }, createDeadLetterRecord({ queue: "screener-events", reason: "no_handler" }), null),
    ).resolves.toBeUndefined();
    expect(sendAlert).not.toHaveBeenCalled();
    await expect(
      persistDeadLetterLanding({ store: null, threshold: 10, sendAlert, nowMs: 5000 }, createDeadLetterRecord({ queue: "screener-events", reason: "no_handler" }), null),
    ).resolves.toBeUndefined();
  });

  it("the work handler persists no_handler and denied drops, never processed work", async () => {
    const persisted: Array<{ reason: string; envelope: unknown }> = [];
    const persist = vi.fn(async (record: { reason: string }, envelope: unknown) => {
      persisted.push({ reason: record.reason, envelope });
    });
    const handler = createScreenerEventsWorkHandler({
      dispatchOptionsAnalysis: async () => "dispatched",
      onDeadLetter: { record: () => {} },
      persistDeadLetter: persist,
    });
    // Unknown type -> no_handler drop with the full envelope.
    const unknownEnvelope = { ...ENVELOPE, type: "unknown_type", data: {} };
    await handler(unknownEnvelope);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].reason).toBe("no_handler");
    expect(persisted[0].envelope).toEqual(unknownEnvelope);
    // Denied dispatch -> denied drop with the full envelope.
    const deniedHandler = createScreenerEventsWorkHandler({
      dispatchOptionsAnalysis: async () => "denied",
      onDeadLetter: { record: () => {} },
      persistDeadLetter: persist,
    });
    await deniedHandler(ENVELOPE);
    expect(persisted).toHaveLength(2);
    expect(persisted[1].reason).toBe("denied");
    expect(persisted[1].envelope).toEqual(ENVELOPE);
    // Processed work -> no persist call.
    const okHandler = createScreenerEventsWorkHandler({
      dispatchOptionsAnalysis: async () => "dispatched",
      onDeadLetter: { record: () => {} },
      persistDeadLetter: persist,
    });
    await okHandler(ENVELOPE);
    expect(persisted).toHaveLength(2);
  });

  it("the bridges persist undecodable drops with a null envelope", async () => {
    const persisted: Array<{ reason: string; envelope: unknown }> = [];
    const persist = vi.fn(async (record: { reason: string }, envelope: unknown) => {
      persisted.push({ reason: record.reason, envelope });
    });
    const adapter = new CfQueueMessagingAdapter({ send: async () => {} });
    const makeMsg = (body: unknown) => ({
      body,
      ack: vi.fn(),
      retry: vi.fn(),
    });
    // consumeCfBatch: an undecodable body drops with a record.
    await consumeCfBatch(
      { queue: "screener-events", messages: [makeMsg("not-an-envelope")] },
      adapter,
      async () => "processed" as const,
      persist,
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0].reason).toBe("undecodable");
    expect(persisted[0].envelope).toBeNull();
    // dispatchSubscriberBatch: an undecodable body drops with a record.
    await dispatchSubscriberBatch(
      { queue: "screener-events-delivery", messages: [makeMsg(42)] },
      "sub-1",
      {},
      new Set<string>(),
      persist,
    );
    expect(persisted).toHaveLength(2);
    expect(persisted[1].reason).toBe("undecodable");
    expect(persisted[1].envelope).toBeNull();
  });
});
