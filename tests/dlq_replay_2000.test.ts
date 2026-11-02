/**
 * Phase 5 Slice 1 (#2000) — DLQ replay.
 *
 * Working default (not a ruling): replay reads from the
 * dead-letter store, never from the platform DLQ queues
 * (consumer-less by design, unpeekable from a Worker).
 * Replay re-sends the identical envelope object, so the
 * envelope id — the idempotency key per ADR 0003 M4 — is
 * intact by construction; the store row is marked replayed
 * so a record can never be replayed twice.
 */
import { describe, it, expect, vi } from "vitest";
import { InMemoryDeadLetterStoreAdapter } from "../src/data/inMemoryDeadLetterStoreAdapter";
import { replayDeadLetter } from "../src/messaging/deadLetterReplay";

const ENVELOPE = {
  specversion: "1.0",
  id: "env-1",
  source: "test",
  type: "options_analysis",
  time: "2026-11-02T00:00:00.000Z",
  data: { taskType: "options_analysis", payload: { userLogin: "op1" } },
  jobid: "job-1",
};

function sender() {
  const calls: unknown[] = [];
  return {
    calls,
    send: vi.fn(async (body: unknown) => {
      calls.push(body);
    }),
  };
}

describe("DLQ replay (#2000 slice 1)", () => {
  it("replays a no_handler record with the identical envelope id and marks it replayed", async () => {
    const store = new InMemoryDeadLetterStoreAdapter();
    const row = await store.insert({
      queue: "screener-events",
      reason: "no_handler",
      messageId: "env-1",
      envelope: ENVELOPE,
      createdAtMs: 1000,
    });
    const s = sender();
    const result = await replayDeadLetter(
      { store, senders: { "screener-events": s }, nowMs: 5000 },
      row.id,
    );
    expect(result.ok).toBe(true);
    // Idempotency key intact: the sender receives the identical envelope.
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toEqual(ENVELOPE);
    expect((s.calls[0] as { id: string }).id).toBe("env-1");
    const after = (await store.getById(row.id))!;
    expect(after.replayedAtMs).toBe(5000);
    expect(after.replayOutcome).toBe("replayed");
  });

  it("a replayed record can never be replayed twice", async () => {
    const store = new InMemoryDeadLetterStoreAdapter();
    const row = await store.insert({ queue: "screener-events", reason: "no_handler", messageId: "env-1", envelope: ENVELOPE, createdAtMs: 1000 });
    const s = sender();
    expect((await replayDeadLetter({ store, senders: { "screener-events": s }, nowMs: 5000 }, row.id)).ok).toBe(true);
    const second = await replayDeadLetter({ store, senders: { "screener-events": s }, nowMs: 6000 }, row.id);
    expect(second).toEqual({ ok: false, code: "already_replayed" });
    expect(s.calls).toHaveLength(1);
  });

  it("undecodable, denied, and invalid_envelope records are refused with a coded reason and never sent", async () => {
    const store = new InMemoryDeadLetterStoreAdapter();
    const s = sender();
    for (const reason of ["undecodable", "denied", "invalid_envelope"] as const) {
      const row = await store.insert({ queue: "screener-events", reason, messageId: "x", envelope: ENVELOPE, createdAtMs: 1000 });
      const result = await replayDeadLetter({ store, senders: { "screener-events": s }, nowMs: 5000 }, row.id);
      expect(result).toEqual({ ok: false, code: reason });
      expect((await store.getById(row.id))!.replayedAtMs).toBeNull();
    }
    expect(s.calls).toHaveLength(0);
  });

  it("unknown record, missing envelope, unknown queue, and send failure are refused with coded reasons", async () => {
    const store = new InMemoryDeadLetterStoreAdapter();
    const s = sender();
    expect(await replayDeadLetter({ store, senders: { "screener-events": s }, nowMs: 5000 }, "nope")).toEqual({
      ok: false,
      code: "unknown_record",
    });
    const noEnv = await store.insert({ queue: "screener-events", reason: "no_handler", messageId: null, createdAtMs: 1000 });
    expect(await replayDeadLetter({ store, senders: { "screener-events": s }, nowMs: 5000 }, noEnv.id)).toEqual({
      ok: false,
      code: "no_envelope",
    });
    const noSender = await store.insert({ queue: "screener-events-delivery", reason: "no_handler", messageId: "env-1", envelope: ENVELOPE, createdAtMs: 1000 });
    expect(await replayDeadLetter({ store, senders: { "screener-events": s }, nowMs: 5000 }, noSender.id)).toEqual({
      ok: false,
      code: "unknown_queue",
    });
    const failing = { send: vi.fn(async () => { throw new Error("queue down"); }) };
    const failRow = await store.insert({ queue: "screener-events", reason: "no_handler", messageId: "env-1", envelope: ENVELOPE, createdAtMs: 1000 });
    expect(await replayDeadLetter({ store, senders: { "screener-events": failing }, nowMs: 5000 }, failRow.id)).toEqual({
      ok: false,
      code: "send_failed",
    });
    // A failed send leaves the record un-replayed (retryable by the operator).
    expect((await store.getById(failRow.id))!.replayedAtMs).toBeNull();
  });

  it("a stored envelope that fails validation is refused as invalid_envelope", async () => {
    const store = new InMemoryDeadLetterStoreAdapter();
    const s = sender();
    const row = await store.insert({
      queue: "screener-events",
      reason: "no_handler",
      messageId: "env-1",
      envelope: { specversion: "1.0", id: "", source: "", type: "", time: "", data: null },
      createdAtMs: 1000,
    });
    expect(await replayDeadLetter({ store, senders: { "screener-events": s }, nowMs: 5000 }, row.id)).toEqual({
      ok: false,
      code: "invalid_envelope",
    });
    expect(s.calls).toHaveLength(0);
  });
});
