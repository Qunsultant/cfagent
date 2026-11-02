/**
 * Phase 5 Slice 2 (#2000) — breaker trip subscriber.
 *
 * The subscriber consumes breaker.state_changed envelopes and
 * posts exactly once per open transition. Claim-once is keyed
 * by envelope id (the idempotency key); a second delivery of
 * the same envelope posts nothing.
 */
import { describe, it, expect } from "vitest";
import { createBreakerTripSubscriber } from "../src/breakers/breakerTripAlert";
import { toBreakerStateChangeEnvelope } from "../src/breakers/breakerPorts";
import type { MessageEnvelope } from "../src/messaging/messagingPorts";

function openEnvelope(seq = 1, providerId = "yahoo", trips = 1): MessageEnvelope {
  return toBreakerStateChangeEnvelope({
    providerId,
    from: "closed",
    to: "open",
    atMs: 1_000_000,
    transitionSeq: seq,
    trips,
    fallbacks: 0,
  });
}

function closedEnvelope(seq = 2): MessageEnvelope {
  return toBreakerStateChangeEnvelope({
    providerId: "yahoo",
    from: "half-open",
    to: "closed",
    atMs: 1_001_000,
    transitionSeq: seq,
    trips: 1,
    fallbacks: 0,
  });
}

describe("breaker trip subscriber (#2000 slice 2)", () => {
  it("posts once on an open transition, with provider and trip count in the text", async () => {
    const posted: string[] = [];
    const claimed = new Set<string>();
    const sub = createBreakerTripSubscriber({
      postText: async (text) => {
        posted.push(text);
        return { ok: true };
      },
      claimTripAlert: async (id) => {
        if (claimed.has(id)) return false;
        claimed.add(id);
        return true;
      },
    });
    const result = await sub.handleEnvelope(openEnvelope(1, "yahoo", 3));
    expect(result).toEqual({ posted: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("yahoo");
    expect(posted[0]).toContain("OPEN");
    expect(posted[0]).toContain("3");
  });

  it("skips closed and half-open transitions without claiming or posting", async () => {
    const posted: string[] = [];
    let claims = 0;
    const sub = createBreakerTripSubscriber({
      postText: async (text) => {
        posted.push(text);
        return { ok: true };
      },
      claimTripAlert: async () => {
        claims += 1;
        return true;
      },
    });
    expect(await sub.handleEnvelope(closedEnvelope(2))).toEqual({
      posted: false,
      skipped: "not-open",
    });
    expect(posted).toHaveLength(0);
    expect(claims).toBe(0);
  });

  it("skips non-breaker envelopes without claiming or posting", async () => {
    const posted: string[] = [];
    let claims = 0;
    const sub = createBreakerTripSubscriber({
      postText: async (text) => {
        posted.push(text);
        return { ok: true };
      },
      claimTripAlert: async () => {
        claims += 1;
        return true;
      },
    });
    const other: MessageEnvelope = {
      specversion: "1.0",
      id: "other-1",
      source: "test",
      type: "screener.completed",
      time: new Date(1_000_000).toISOString(),
      data: {},
    };
    expect(await sub.handleEnvelope(other)).toEqual({
      posted: false,
      skipped: "not-breaker",
    });
    expect(posted).toHaveLength(0);
    expect(claims).toBe(0);
  });

  it("a second delivery of the same envelope posts nothing (claim-once)", async () => {
    const posted: string[] = [];
    const claimed = new Set<string>();
    const sub = createBreakerTripSubscriber({
      postText: async (text) => {
        posted.push(text);
        return { ok: true };
      },
      claimTripAlert: async (id) => {
        if (claimed.has(id)) return false;
        claimed.add(id);
        return true;
      },
    });
    const envelope = openEnvelope(1);
    expect(await sub.handleEnvelope(envelope)).toEqual({ posted: true });
    expect(await sub.handleEnvelope(envelope)).toEqual({
      posted: false,
      skipped: "already-alerted",
    });
    expect(posted).toHaveLength(1);
  });

  it("distinct transition ids alert independently", async () => {
    const posted: string[] = [];
    const claimed = new Set<string>();
    const sub = createBreakerTripSubscriber({
      postText: async (text) => {
        posted.push(text);
        return { ok: true };
      },
      claimTripAlert: async (id) => {
        if (claimed.has(id)) return false;
        claimed.add(id);
        return true;
      },
    });
    expect(await sub.handleEnvelope(openEnvelope(1))).toEqual({ posted: true });
    expect(await sub.handleEnvelope(openEnvelope(2))).toEqual({ posted: true });
    expect(posted).toHaveLength(2);
  });

  it("a failed post consumes the claim (documented trade-off): no re-alert for the same transition", async () => {
    const posted: string[] = [];
    const claimed = new Set<string>();
    const sub = createBreakerTripSubscriber({
      postText: async (text) => {
        posted.push(text);
        return { ok: false, error: "webhook down" };
      },
      claimTripAlert: async (id) => {
        if (claimed.has(id)) return false;
        claimed.add(id);
        return true;
      },
    });
    const envelope = openEnvelope(1);
    const first = await sub.handleEnvelope(envelope);
    expect(first.posted).toBe(false);
    expect((first as { error?: string }).error).toContain("webhook down");
    expect(await sub.handleEnvelope(envelope)).toEqual({
      posted: false,
      skipped: "already-alerted",
    });
  });

  it("subscriber claims with a fresh token per call (token-matching store: re-delivery loses)", async () => {
    const posted: string[] = [];
    const tokens = new Map<string, string>();
    const sub = createBreakerTripSubscriber({
      postText: async (text) => {
        posted.push(text);
        return { ok: true };
      },
      claimTripAlert: async (id, _atMs, token) => {
        const existing = tokens.get(id);
        if (existing === undefined) {
          tokens.set(id, token);
          return true;
        }
        return existing === token;
      },
    });
    const envelope = openEnvelope(1);
    expect(await sub.handleEnvelope(envelope)).toEqual({ posted: true });
    // A re-delivery must NOT reuse the first call's token, or it would
    // re-claim idempotently and double-post. Fresh token => loses.
    expect(await sub.handleEnvelope(envelope)).toEqual({
      posted: false,
      skipped: "already-alerted",
    });
    expect(posted).toHaveLength(1);
  });

  it("a malformed envelope never throws", async () => {
    const sub = createBreakerTripSubscriber({
      postText: async () => ({ ok: true }),
      claimTripAlert: async () => true,
    });
    const malformed = {
      specversion: "1.0",
      id: "bad-1",
      source: "test",
      type: "breaker.state_changed",
      time: new Date(1_000_000).toISOString(),
      data: null,
    } as unknown as MessageEnvelope;
    const result = await sub.handleEnvelope(malformed);
    expect(result.posted).toBe(false);
  });
});
