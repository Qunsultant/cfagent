/**
 * Issue #618 (phase-2 P2-3.3) — the stale-task sweep from #615 is wired
 * into the orchestrator's existing maintenance path: a scheduled
 * callback sweeps both ledgers for the instance's user, onStart runs
 * one sweep immediately and ensures a persistent 6-hourly interval
 * schedule exists (idempotently).
 *
 * Source-evidence tests, the repo idiom for Durable Object wiring that
 * vitest cannot instantiate. Ledger sweep semantics themselves are
 * covered by tests/research-task-ledger.test.ts and
 * tests/screener-task-ledger.test.ts (#615).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const orchestrator = fs.readFileSync(
  path.join(process.cwd(), "src/agents/orchestrator.ts"),
  "utf8"
);

/** Slice from a marker to the next top-level method definition. */
function region(from: string, to = "\n  async "): string {
  const start = orchestrator.indexOf(from);
  expect(start, `expected to find: ${from}`).toBeGreaterThanOrEqual(0);
  const end = orchestrator.indexOf(to, start + from.length);
  return orchestrator.slice(start, end === -1 ? undefined : end);
}

describe("stale sweep wiring (#618)", () => {
  it("defines the sweepStaleLedgerTasks scheduled callback", () => {
    expect(orchestrator).toContain("async sweepStaleLedgerTasks(");
  });

  it("sweeps both ledgers for the resolved user", () => {
    const cb = region("async sweepStaleLedgerTasks(");
    expect(cb).toContain("sweepStaleResearchTasks()");
    expect(cb).toContain("sweepStaleScreenerTasks()");
    expect(cb).toContain("getScreenerExecutionContext()");
    expect(cb).toContain("payload?.userLogin");
  });

  it("isolates each ledger's sweep so one failure cannot block the other", () => {
    const cb = region("async sweepStaleLedgerTasks(");
    const catches = cb.match(/catch/g) ?? [];
    expect(catches.length).toBeGreaterThanOrEqual(2);
  });

  it("uses a 6-hour interval between automatic sweeps", () => {
    expect(orchestrator).toContain("STALE_SWEEP_INTERVAL_SECONDS = 6 * 60 * 60");
  });

  it("ensures the interval schedule idempotently (checks before creating)", () => {
    const ensure = region("async ensureStaleSweepSchedule(");
    expect(ensure).toContain("listSchedules");
    expect(ensure).toContain("sweepStaleLedgerTasks");
    expect(ensure).toContain("scheduleEvery(STALE_SWEEP_INTERVAL_SECONDS");
    // The existence check must precede creation.
    expect(ensure.indexOf("listSchedules")).toBeLessThan(ensure.indexOf("scheduleEvery("));
  });

  it("onStart runs an initial sweep and ensures the schedule", () => {
    const start = region("async onStart(");
    expect(start).toContain("sweepStaleLedgerTasks");
    expect(start).toContain("ensureStaleSweepSchedule");
  });
});

describe("retention pruning rides the sweep callback (#635)", () => {
  it("the callback also prunes both ledgers", () => {
    const cb = region("async sweepStaleLedgerTasks(");
    expect(cb).toContain("pruneExpiredResearchTasks(");
    expect(cb).toContain("pruneExpiredScreenerTasks(");
  });
});

describe("stale async-job sweep wiring (#3784)", () => {
  it("defines the sweepStaleAsyncJobs scheduled callback delegating to asyncJobs", () => {
    expect(orchestrator).toContain("async sweepStaleAsyncJobs(");
    const cb = region("async sweepStaleAsyncJobs(");
    expect(cb).toContain("sweepStaleAsyncJobs(this.asyncJobsContext())");
  });

  it("uses a 15-minute interval between automatic async-job sweeps", () => {
    expect(orchestrator).toContain("STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS = 15 * 60");
  });

  it("ensures the async-job sweep schedule idempotently (checks before creating)", () => {
    const ensure = region("async ensureStaleAsyncJobSweepSchedule(");
    expect(ensure).toContain("listSchedules");
    expect(ensure).toContain("sweepStaleAsyncJobs");
    expect(ensure).toContain("scheduleEvery(STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS");
    // The existence check must precede creation.
    expect(ensure.indexOf("listSchedules")).toBeLessThan(ensure.indexOf("scheduleEvery("));
  });

  it("onStart runs an initial async-job sweep and ensures the schedule", () => {
    const start = region("async onStart(");
    expect(start).toContain("sweepStaleAsyncJobs");
    expect(start).toContain("ensureStaleAsyncJobSweepSchedule");
  });
});
