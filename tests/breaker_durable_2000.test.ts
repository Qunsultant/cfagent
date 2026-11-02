/**
 * Phase 5 Slice 2 (#2000) — durable breaker adapter.
 *
 * The conformance suite runs against BOTH the in-memory
 * adapter and the durable adapter (same machine, plus
 * persistence): a behavior difference between them is a
 * defect in the wrapper, not a test difference. The
 * durability tests then prove what the wrapper adds:
 * cross-isolate trip visibility, cold-start survival, reset
 * persistence, and the documented sub-threshold caveat.
 *
 * Clock injected — no real waiting. withRetry sleeps are
 * stubbed (noSleep) so failure runs complete instantly.
 */
import { describe, it, expect } from "vitest";
import {
  BreakerOpenError,
  type BreakerPolicy,
  type CircuitBreaker,
} from "../src/breakers/breakerPorts";
import { InMemoryCircuitBreaker } from "../src/breakers/inMemoryBreakerAdapter";
import { DurableCircuitBreaker } from "../src/breakers/durableBreakerAdapter";
import { InMemoryBreakerStateStoreAdapter } from "../src/data/inMemoryBreakerStateStoreAdapter";
import type { BreakerStateStore } from "../src/breakers/breakerStateStorePorts";
import {
  configureDefaultBreakerDurability,
  createDurableBreakerRegistry,
  defaultBreakerRegistry,
  __resetDefaultBreakerDurability,
  __resetDefaultBreakerRegistry,
} from "../src/breakers/createBreakerPorts";

const policy: BreakerPolicy = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  halfOpenMaxProbes: 1,
};

function clock(startMs = 1_000_000) {
  let now = startMs;
  return {
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const noSleep = async () => {};
/** Single-attempt retry: one fn invocation per execute (default policy retries 3x). */
const once = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
const boom = () => Promise.reject(new Error("provider down"));
/** NOTE: withRetry passes the attempt index into fn — ignore args, or the value becomes 1. */
const ok = () => Promise.resolve("live");

type MakeBreaker = (providerId: string, c: ReturnType<typeof clock>) => CircuitBreaker;

function makers(store: BreakerStateStore): Array<{ name: string; make: MakeBreaker }> {
  return [
    {
      name: "in-memory",
      make: (providerId, c) => new InMemoryCircuitBreaker(providerId, policy, { nowMs: c.nowMs }),
    },
    {
      name: "durable",
      make: (providerId, c) =>
        new DurableCircuitBreaker(providerId, policy, store, { nowMs: c.nowMs }),
    },
  ];
}

describe("breaker conformance: durable preserves the machine (#2000 slice 2)", () => {
  it("trips closed -> open on threshold, then rejects instantly without calling", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    for (const { make } of makers(store)) {
      const c = clock();
      const b = make("yahoo", c);
      let calls = 0;
      const failing = () => {
        calls += 1;
        return boom();
      };
      for (let i = 0; i < 3; i++) {
        await expect(b.execute(failing, { sleep: noSleep, retryPolicy: once })).rejects.toThrow("provider down");
      }
      expect(b.getState()).toBe("open");
      await expect(b.execute(ok, { sleep: noSleep })).rejects.toBeInstanceOf(BreakerOpenError);
      expect(calls).toBe(3);
    }
  });

  it("half-open probe success closes; probe failure re-opens", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    for (const { make } of makers(store)) {
      const c = clock();
      const b = make("yahoo", c);
      for (let i = 0; i < 3; i++) {
        await expect(b.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
      }
      c.advance(30_000);
      await expect(b.execute(ok, { sleep: noSleep })).resolves.toEqual({
        status: "success",
        value: "live",
        state: "closed",
      });
      for (let i = 0; i < 3; i++) {
        await expect(b.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
      }
      c.advance(30_000);
      await expect(b.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
      expect(b.getState()).toBe("open");
    }
  });

  it("permanent failures never count toward the trip threshold", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    for (const { make } of makers(store)) {
      const c = clock();
      const b = make("yahoo", c);
      const shouldRetry = () => false;
      for (let i = 0; i < 5; i++) {
        await expect(
          b.execute(boom, { sleep: noSleep, shouldRetry })
        ).rejects.toThrow("provider down");
      }
      expect(b.getState()).toBe("closed");
    }
  });

  it("open gate serves the fallback instead of throwing", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    for (const { make } of makers(store)) {
      const c = clock();
      const b = make("yahoo", c);
      for (let i = 0; i < 3; i++) {
        await expect(b.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
      }
      await expect(
        b.execute(ok, { sleep: noSleep, fallback: () => "cached" })
      ).resolves.toEqual({ status: "fallback", value: "cached", reason: "open", state: "open" });
    }
  });

  it("reset returns to closed and keeps lifetime totals", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    for (const { make } of makers(store)) {
      const c = clock();
      const b = make("yahoo", c);
      for (let i = 0; i < 3; i++) {
        await expect(b.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
      }
      b.reset();
      expect(b.getState()).toBe("closed");
      expect(b.snapshot().totalTrips).toBe(1);
    }
  });
});

describe("durable breaker: cross-isolate visibility (#2000 slice 2)", () => {
  it("a trip in one instance gates a second instance over the same store (provider never called)", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    const c = clock();
    const a = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    for (let i = 0; i < 3; i++) {
      await expect(a.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    }
    await a.drain();
    expect((await store.load("yahoo"))?.state).toBe("open");

    const b = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    let calls = 0;
    await expect(
      b.execute(
        () => {
          calls += 1;
          return ok();
        },
        { sleep: noSleep, retryPolicy: once }
      )
    ).rejects.toBeInstanceOf(BreakerOpenError);
    expect(calls).toBe(0);
  });

  it("cold start: a fresh instance hydrates the persisted open state on first execute", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    const c = clock();
    const a = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    for (let i = 0; i < 3; i++) {
      await expect(a.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    }
    await a.drain();
    // "Recycle": drop instance A entirely; B is a brand-new object.
    const b = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    await expect(b.execute(ok, { sleep: noSleep })).rejects.toBeInstanceOf(BreakerOpenError);
    expect(b.snapshot().totalTrips).toBe(1);
  });

  it("cold start with an expired trip: a failing probe re-opens (discriminates hydration)", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    const c = clock();
    const a = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    for (let i = 0; i < 3; i++) {
      await expect(a.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    }
    await a.drain();
    c.advance(31_000);
    // A fresh instance with NO hydration would see 1 failure as closed;
    // a hydrated instance probes in half-open and re-opens on failure.
    const b = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    await expect(b.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    expect(b.getState()).toBe("open");
    await expect(b.execute(ok, { sleep: noSleep })).rejects.toBeInstanceOf(BreakerOpenError);
  });

  it("cold start with an expired trip: a probe success closes (behavior pin)", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    const c = clock();
    const a = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    for (let i = 0; i < 3; i++) {
      await expect(a.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    }
    await a.drain();
    c.advance(31_000);
    const b = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    await expect(b.execute(ok, { sleep: noSleep })).resolves.toEqual({
      status: "success",
      value: "live",
      state: "closed",
    });
  });

  it("an operator reset persists: a fresh instance stays closed after it", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    const c = clock();
    const a = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    for (let i = 0; i < 3; i++) {
      await expect(a.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    }
    await a.drain();
    a.reset();
    await a.drain();
    const b = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    await expect(b.execute(ok, { sleep: noSleep })).resolves.toEqual({
      status: "success",
      value: "live",
      state: "closed",
    });
  });

  it("DOCUMENTED CAVEAT: sub-threshold failure counts are not durable (recycle resets the count, never un-trips)", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    const c = clock();
    const a = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    for (let i = 0; i < 2; i++) {
      await expect(a.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    }
    await a.drain();
    // No trip persisted (2 < 3): the fresh instance starts its own count.
    const b = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    await expect(b.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    expect(b.getState()).toBe("closed");
    await expect(b.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    expect(b.getState()).toBe("closed");
    await expect(b.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    expect(b.getState()).toBe("open");
  });

  it("store errors never fail a provider call (degrade to in-memory, logged)", async () => {
    const failingStore: BreakerStateStore = {
      load: () => Promise.reject(new Error("d1 down")),
      save: () => Promise.reject(new Error("d1 down")),
      claimTripAlert: () => Promise.reject(new Error("d1 down")),
    };
    const c = clock();
    const b = new DurableCircuitBreaker("yahoo", policy, failingStore, { nowMs: c.nowMs });
    await expect(b.execute(ok, { sleep: noSleep })).resolves.toEqual({
      status: "success",
      value: "live",
      state: "closed",
    });
    for (let i = 0; i < 3; i++) {
      await expect(b.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    }
    expect(b.getState()).toBe("open");
    await b.drain();
  });

  it("transition sequence survives recycle (no envelope-id collision with the previous isolate)", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    const c = clock();
    const a = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    for (let i = 0; i < 3; i++) {
      await expect(a.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    }
    await a.drain();
    expect((await store.load("yahoo"))?.transitionSeq).toBe(1);
    // Recycle + reset + re-trip: the next trip must carry seq 2+, never 1 again.
    const b = new DurableCircuitBreaker("yahoo", policy, store, { nowMs: c.nowMs });
    b.reset();
    await b.drain();
    for (let i = 0; i < 3; i++) {
      await expect(b.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    }
    await b.drain();
    const seq = (await store.load("yahoo"))?.transitionSeq ?? 0;
    expect(seq).toBeGreaterThan(1);
  });
});

describe("durable registry factory (#2000 slice 2)", () => {
  it("trips persist across registry instances sharing one store", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    const c = clock();
    const r1 = createDurableBreakerRegistry(store, { nowMs: c.nowMs });
    const yahoo1 = r1.breakerFor("yahoo") as DurableCircuitBreaker;
    for (let i = 0; i < 3; i++) {
      await expect(yahoo1.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    }
    await yahoo1.drain();
    const r2 = createDurableBreakerRegistry(store, { nowMs: c.nowMs });
    await expect(r2.breakerFor("yahoo").execute(ok, { sleep: noSleep })).rejects.toBeInstanceOf(
      BreakerOpenError
    );
  });

  it("tripAlert receives the open envelope via the registry emit chain", async () => {
    const store = new InMemoryBreakerStateStoreAdapter();
    const c = clock();
    const seen: Array<{ type: string; to: unknown }> = [];
    const r = createDurableBreakerRegistry(store, {
      nowMs: c.nowMs,
      tripAlert: (envelope) => {
        seen.push({ type: envelope.type, to: (envelope.data as any)?.to });
      },
    });
    const yahoo = r.breakerFor("yahoo") as DurableCircuitBreaker;
    for (let i = 0; i < 3; i++) {
      await expect(yahoo.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    }
    expect(seen).toEqual([{ type: "breaker.state_changed", to: "open" }]);
  });

  it("configureDefaultBreakerDurability makes the shared registry durable (first use wins)", async () => {
    __resetDefaultBreakerRegistry();
    __resetDefaultBreakerDurability();
    const store = new InMemoryBreakerStateStoreAdapter();
    const c = clock();
    configureDefaultBreakerDurability({ store });
    const r1 = defaultBreakerRegistry({ nowMs: c.nowMs });
    const yahoo1 = r1.breakerFor("yahoo") as DurableCircuitBreaker;
    for (let i = 0; i < 3; i++) {
      await expect(yahoo1.execute(boom, { sleep: noSleep })).rejects.toThrow("provider down");
    }
    await yahoo1.drain();
    expect((await store.load("yahoo"))?.state).toBe("open");
    __resetDefaultBreakerRegistry();
    __resetDefaultBreakerDurability();
  });
});
