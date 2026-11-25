/**
 * Issue #6466 part 1 — every run stage shows its elapsed time, always.
 *
 * The stage read already returns startedAt / endedAt / durationMs for every
 * stage; the panel rendered the time only when durationMs was a number, so a
 * running or timed-out stage showed nothing. The pure rule pinned here:
 *
 * - a recorded durationMs wins (finished, or failed with a duration) — the
 *   recorded truth, whatever the status;
 * - a running stage shows live elapsed time from startedAt (now - started);
 * - a timed-out / failed / stopped stage without a duration shows
 *   endedAt - startedAt;
 * - a stage that never started shows nothing (null) — never an invented 0.
 *
 * TDD Red first: the module (src/client/options/researchStageElapsed.ts)
 * does not exist yet, so this file fails at import.
 */
import { describe, it, expect } from "vitest";
import { elapsedMsForStage } from "../src/client/options/researchStageElapsed";

const T = Date.parse("2026-11-24T12:24:00Z");

describe("#6466 — stage elapsed time", () => {
  it("a finished stage shows its recorded duration", () => {
    expect(
      elapsedMsForStage(
        { status: "completed", startedAt: new Date(T).toISOString(), endedAt: new Date(T + 3720).toISOString(), durationMs: 3720 },
        T + 10_000,
      ),
    ).toBe(3720);
  });

  it("a recorded 0 ms duration is 0, never null", () => {
    expect(
      elapsedMsForStage(
        { status: "completed", startedAt: new Date(T).toISOString(), endedAt: new Date(T).toISOString(), durationMs: 0 },
        T + 10_000,
      ),
    ).toBe(0);
  });

  it("a failed stage with a recorded duration shows the duration", () => {
    expect(
      elapsedMsForStage(
        { status: "failed", startedAt: new Date(T).toISOString(), endedAt: new Date(T + 5000).toISOString(), durationMs: 5000 },
        T + 10_000,
      ),
    ).toBe(5000);
  });

  it("a running stage shows live elapsed time from its start", () => {
    expect(
      elapsedMsForStage(
        { status: "running", startedAt: new Date(T).toISOString(), endedAt: null, durationMs: null },
        T + 9000,
      ),
    ).toBe(9000);
  });

  it("a running stage with no start time shows nothing", () => {
    expect(
      elapsedMsForStage({ status: "running", startedAt: null, endedAt: null, durationMs: null }, T + 9000),
    ).toBeNull();
  });

  it("a failed stage without a duration shows start-to-end", () => {
    expect(
      elapsedMsForStage(
        { status: "failed", startedAt: new Date(T).toISOString(), endedAt: new Date(T + 45_000).toISOString(), durationMs: null },
        T + 60_000,
      ),
    ).toBe(45_000);
  });

  it("a stopped stage without a duration shows start-to-end", () => {
    expect(
      elapsedMsForStage(
        { status: "stopped", startedAt: new Date(T).toISOString(), endedAt: new Date(T + 12_000).toISOString(), durationMs: null },
        T + 60_000,
      ),
    ).toBe(12_000);
  });

  it("a pending stage that never started shows nothing", () => {
    expect(
      elapsedMsForStage({ status: "pending", startedAt: null, endedAt: null, durationMs: null }, T + 60_000),
    ).toBeNull();
  });

  it("a start time in the future clamps to 0, never negative", () => {
    expect(
      elapsedMsForStage(
        { status: "running", startedAt: new Date(T + 5000).toISOString(), endedAt: null, durationMs: null },
        T,
      ),
    ).toBe(0);
  });
});
