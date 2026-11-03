import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startPolling } from "../src/client/polling";

/**
 * Issue #2376 slice 1 — polling convergence.
 *
 * The shared polling contract (startPolling / usePolling) covers every
 * live-update surface, but surfaces that fetch on mount (saga status,
 * journey gates, checkout status) need the first fetch immediately, not
 * after one cadence. The `immediate` knob is that contract extension:
 * run once at subscribe, then follow the cadence. Default false preserves
 * the existing schedule (first run after the cadence) for every current
 * caller.
 */

function makeDoc(initial: "visible" | "hidden" = "visible") {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initial as Document["visibilityState"],
    addEventListener: (_event: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_event: string, fn: () => void) => listeners.delete(fn),
    setVisibility(state: "visible" | "hidden") {
      doc.visibilityState = state as Document["visibilityState"];
      for (const fn of listeners) fn();
    },
  };
  return doc;
}

describe("polling contract: immediate first run (#2376 slice 1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs immediately at subscribe, then follows the cadence", async () => {
    const run = vi.fn();
    const stop = startPolling(run, { fastMs: 30_000, idleMs: 30_000, immediate: true, doc: makeDoc() });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);

    stop();
  });

  it("defaults to the existing schedule: first run only after the cadence", async () => {
    const run = vi.fn();
    const stop = startPolling(run, { fastMs: 30_000, idleMs: 30_000, doc: makeDoc() });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);

    stop();
  });

  it("immediate respects a hidden tab: no run until visible, then runs at once", async () => {
    const run = vi.fn();
    const doc = makeDoc("hidden");
    const stop = startPolling(run, { fastMs: 30_000, idleMs: 30_000, immediate: true, doc });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).not.toHaveBeenCalled();

    doc.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    stop();
  });

  it("stop() after an immediate run prevents all later runs", async () => {
    const run = vi.fn();
    const stop = startPolling(run, { fastMs: 30_000, idleMs: 30_000, immediate: true, doc: makeDoc() });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("an immediate run that throws does not break the schedule", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("transient"));
    const stop = startPolling(run, { fastMs: 30_000, idleMs: 30_000, immediate: true, doc: makeDoc() });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(2);

    stop();
  });

  it("an immediate run that flips isBusy switches cadence on the next arm", async () => {
    let busy = false;
    const run = vi.fn();
    const stop = startPolling(run, {
      fastMs: 5_000,
      idleMs: 30_000,
      isBusy: () => busy,
      immediate: true,
      doc: makeDoc(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    busy = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(3);

    stop();
  });
});
