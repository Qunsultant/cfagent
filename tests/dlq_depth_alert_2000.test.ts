/**
 * Phase 5 Slice 1 (#2000) — DLQ depth alert.
 *
 * Working default (not a ruling): depth = the count of
 * un-replayed dead-letter store rows; the alert fires through
 * postSlackText when that count crosses the threshold, exactly
 * once per incident (the stuck-alert claim-once pattern).
 * Dashboard-native queue alerts are complementary, not required.
 */
import { describe, it, expect, vi } from "vitest";
import { InMemoryDeadLetterStoreAdapter } from "../src/data/inMemoryDeadLetterStoreAdapter";
import { maybeAlertDlqDepth } from "../src/messaging/dlqDepthAlert";

async function storeWith(n: number) {
  const store = new InMemoryDeadLetterStoreAdapter();
  for (let i = 0; i < n; i++) {
    await store.insert({ queue: "screener-events", reason: "no_handler", messageId: `m-${i}`, createdAtMs: 1000 + i });
  }
  return store;
}

describe("DLQ depth alert (#2000 slice 1)", () => {
  it("does not fire below the threshold", async () => {
    const store = await storeWith(9);
    const sendAlert = vi.fn(async () => {});
    expect(await maybeAlertDlqDepth({ store, threshold: 10, sendAlert, nowMs: 5000 })).toBe(false);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("fires exactly once at the threshold, not on later landings while the incident is open", async () => {
    const store = await storeWith(9);
    const sendAlert = vi.fn(async () => {});
    await store.insert({ queue: "screener-events", reason: "no_handler", messageId: "m-9", createdAtMs: 2000 });
    expect(await maybeAlertDlqDepth({ store, threshold: 10, sendAlert, nowMs: 5000 })).toBe(true);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(String(sendAlert.mock.calls[0][0])).toContain("10");
    await store.insert({ queue: "screener-events", reason: "no_handler", messageId: "m-10", createdAtMs: 3000 });
    expect(await maybeAlertDlqDepth({ store, threshold: 10, sendAlert, nowMs: 6000 })).toBe(false);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it("clears when depth drops below threshold, then re-arms on the next crossing", async () => {
    const store = await storeWith(10);
    const sendAlert = vi.fn(async () => {});
    expect(await maybeAlertDlqDepth({ store, threshold: 10, sendAlert, nowMs: 5000 })).toBe(true);
    // Replay everything: depth falls to zero, incident clears silently.
    for (const row of await store.listUnreplayed(20)) {
      await store.markReplayed({ id: row.id, outcome: "replayed", atMs: 6000, token: `t-${row.id}` });
    }
    expect(await maybeAlertDlqDepth({ store, threshold: 10, sendAlert, nowMs: 7000 })).toBe(false);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    // A fresh crossing alerts again.
    await storeWith(0).then(async () => {});
    for (let i = 0; i < 10; i++) {
      await store.insert({ queue: "screener-events", reason: "no_handler", messageId: `n-${i}`, createdAtMs: 8000 + i });
    }
    expect(await maybeAlertDlqDepth({ store, threshold: 10, sendAlert, nowMs: 9000 })).toBe(true);
    expect(sendAlert).toHaveBeenCalledTimes(2);
  });

  it("threshold 0 disables the alert entirely", async () => {
    const store = await storeWith(100);
    const sendAlert = vi.fn(async () => {});
    expect(await maybeAlertDlqDepth({ store, threshold: 0, sendAlert, nowMs: 5000 })).toBe(false);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("claim-first: a failed delivery does not re-alert while the incident is open", async () => {
    const store = await storeWith(10);
    const failing = vi.fn(async () => {
      throw new Error("slack down");
    });
    // Claimed even though delivery failed (stuck-alert trade-off).
    expect(await maybeAlertDlqDepth({ store, threshold: 10, sendAlert: failing, nowMs: 5000 })).toBe(true);
    expect(failing).toHaveBeenCalledTimes(1);
    const second = vi.fn(async () => {});
    expect(await maybeAlertDlqDepth({ store, threshold: 10, sendAlert: second, nowMs: 6000 })).toBe(false);
    expect(second).not.toHaveBeenCalled();
  });
});
