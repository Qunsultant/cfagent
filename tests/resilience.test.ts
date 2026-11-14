/**
 * Issue #1181 (#1173 R1): the shared resilience executor.
 * Pins: exponential schedule with cap + jitter, success after
 * failures, exhaustion rethrows the LAST error unwrapped,
 * shouldRetry stops permanent failures, onRetry events carry the
 * growing delays. Sleep/rng injected — no real waiting.
 */
import { describe, expect, it, vi } from "vitest";
import { computeBackoffDelayMs, withRetry } from "../src/services/resilience";
import type { RetryPolicy } from "../src/services/pipelinePolicy";

const policy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0 };
const noSleep = async () => {};

describe("computeBackoffDelayMs", () => {
  it("doubles per retry: base, 2×base, 4×base", () => {
    expect(computeBackoffDelayMs(policy, 1)).toBe(100);
    expect(computeBackoffDelayMs(policy, 2)).toBe(200);
    expect(computeBackoffDelayMs(policy, 3)).toBe(400);
  });

  it("caps at maxDelayMs", () => {
    const capped: RetryPolicy = { ...policy, maxDelayMs: 250 };
    expect(computeBackoffDelayMs(capped, 3)).toBe(250);
    expect(computeBackoffDelayMs(capped, 9)).toBe(250);
  });

  it("jitter stays within ±ratio of the schedule (seeded rng)", () => {
    const jittery: RetryPolicy = { ...policy, jitterRatio: 0.25 };
    // rng 1 → +25%, rng 0 → −25%.
    expect(computeBackoffDelayMs(jittery, 1, () => 1)).toBe(125);
    expect(computeBackoffDelayMs(jittery, 1, () => 0)).toBe(75);
    expect(computeBackoffDelayMs(jittery, 1, () => 0.5)).toBe(100);
  });
});

describe("withRetry", () => {
  it("returns the first success without retrying", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(withRetry(fn, policy, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("succeeds after transient failures, sleeping the backoff schedule", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 3) throw new Error(`boom ${n}`);
      return "recovered";
    });
    await expect(
      withRetry(fn, policy, { sleep: async (ms) => { sleeps.push(ms); } })
    ).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("exhaustion rethrows the last error unwrapped", async () => {
    const last = new Error("final failure");
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      throw n === 3 ? last : new Error(`boom ${n}`);
    });
    await expect(withRetry(fn, policy, { sleep: noSleep })).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("shouldRetry=false stops immediately (permanent failure)", async () => {
    const fn = vi.fn(async () => {
      throw new Error("auth dead");
    });
    await expect(
      withRetry(fn, policy, { sleep: noSleep, shouldRetry: () => false })
    ).rejects.toThrow("auth dead");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("onRetry events carry attempt, cap, delay, and the error", async () => {
    const events: unknown[] = [];
    const fn = vi.fn(async () => {
      throw new Error("nope");
    });
    await expect(
      withRetry(fn, policy, {
        sleep: noSleep,
        label: "yahoo:AAPL",
        onRetry: (e) => events.push(e),
      })
    ).rejects.toThrow("nope");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ label: "yahoo:AAPL", attempt: 1, maxAttempts: 3, delayMs: 100, error: "nope" });
    expect(events[1]).toMatchObject({ attempt: 2, delayMs: 200 });
  });

  it("maxAttempts=1 means a single try", async () => {
    const fn = vi.fn(async () => {
      throw new Error("once");
    });
    await expect(
      withRetry(fn, { ...policy, maxAttempts: 1 }, { sleep: noSleep })
    ).rejects.toThrow("once");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
describe("withRetry attempt history (#4417)", () => {
  it("fires onAttempt for every failed attempt, including the terminal one", async () => {
    const seen: Array<{ attempt: number; message: string }> = [];
    const fn = vi.fn(async (attempt: number) => {
      throw new Error(`attempt ${attempt} failed`);
    });
    await expect(
      withRetry(fn, { ...policy, maxAttempts: 3 }, {
        sleep: noSleep,
        onAttempt: (attempt, error) => {
          seen.push({ attempt, message: error instanceof Error ? error.message : String(error) });
        },
      }),
    ).rejects.toThrow("attempt 3 failed");
    expect(seen).toEqual([
      { attempt: 1, message: "attempt 1 failed" },
      { attempt: 2, message: "attempt 2 failed" },
      { attempt: 3, message: "attempt 3 failed" },
    ]);
  });

  it("a throwing onAttempt never masks the retry's own error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("real failure");
    });
    await expect(
      withRetry(fn, { ...policy, maxAttempts: 1 }, {
        sleep: noSleep,
        onAttempt: () => {
          throw new Error("history writer exploded");
        },
      }),
    ).rejects.toThrow("real failure");
  });
});