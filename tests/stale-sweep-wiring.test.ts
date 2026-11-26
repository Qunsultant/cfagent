/**
 * Issue #618 (phase-2 P2-3.3) — the stale-task sweep from #615 is wired
 * into the orchestrator's existing maintenance path: a scheduled
 * callback sweeps both ledgers for the instance's user, onStart runs
 * one sweep immediately, and the recurring sweep is a stored monthly
 * schedule seeded by the onStart reconcile (#6503 — the 6-hourly
 * interval arm and its ensureStaleSweepSchedule are retired).
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

const management = fs.readFileSync(
  path.join(process.cwd(), "src/services/unifiedScheduleManagement.ts"),
  "utf8"
);

const catalogue = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "config/job-catalogue.json"), "utf8"),
) as { jobs: Array<Record<string, unknown>> };

function catalogueEntry(id: string) {
  const entry = catalogue.jobs.find((j) => j.id === id);
  expect(entry, `expected a catalogue entry for ${id}`).toBeDefined();
  return entry!;
}

/** Slice from a marker to the next top-level method definition. */
function region(from: string, to = "\n  async "): string {
  const start = orchestrator.indexOf(from);
  expect(start, `expected to find: ${from}`).toBeGreaterThanOrEqual(0);
  const end = orchestrator.indexOf(to, start + from.length);
  return orchestrator.slice(start, end === -1 ? undefined : end);
}

/** Slice from a marker to the next top-level function definition in the management module. */
function managementRegion(from: string, to = "\nexport "): string {
  const start = management.indexOf(from);
  expect(start, `expected to find: ${from}`).toBeGreaterThanOrEqual(0);
  const end = management.indexOf(to, start + from.length);
  return management.slice(start, end === -1 ? undefined : end);
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

  it("runs monthly as a stored schedule, not a 6-hour interval arm", () => {
    // #6503 — the 6-hour STALE_SWEEP_INTERVAL_SECONDS arm is retired:
    // the sweep is a stored platform-level schedule, monthly per
    // #6489. The catalogue entry is the source of truth for the
    // default cadence.
    const entry = catalogueEntry("sweep-stale-ledger-tasks");
    expect(entry.callback).toBe("sweepStaleLedgerTasks");
    expect(entry.defaultIntervalSeconds).toBe(2592000);
    expect(orchestrator).not.toContain("STALE_SWEEP_INTERVAL_SECONDS");
    expect(orchestrator).not.toContain("ensureStaleSweepSchedule");
  });

  it("the onStart reconcile seeds the stored schedule idempotently (get-first)", () => {
    const start = region("async onStart(");
    expect(start).toContain("reconcileSystemScheduleRecords");
    const specs = managementRegion("export function systemScheduleSeedSpecs(");
    expect(specs).toContain("STALE_LEDGER_SWEEP_RECORD_ID");
    expect(specs).toContain('callback: "sweepStaleLedgerTasks"');
    const reconcile = managementRegion("export async function reconcileSystemScheduleRecords(");
    expect(reconcile).toContain("deps.store.get(spec.id)");
    expect(reconcile).toContain("if (!existing)");
    expect(reconcile).toContain("await deps.store.save(record)");
    // The existence check must precede the seed save.
    expect(reconcile.indexOf("deps.store.get(spec.id)")).toBeLessThan(
      reconcile.indexOf("await deps.store.save(record)"),
    );
  });

  it("onStart runs an initial sweep and reconciles the stored schedule", () => {
    const start = region("async onStart(");
    expect(start).toContain("sweepStaleLedgerTasks");
    expect(start).toContain("reconcileSystemScheduleRecords");
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

  it("runs monthly as a stored schedule, not a 15-minute interval arm", () => {
    // #6503 — the 15-minute STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS
    // arm is retired: the sweep is a stored platform-level schedule,
    // monthly per #6489. The catalogue entry is the source of truth
    // for the default cadence.
    const entry = catalogueEntry("sweep-stale-async-jobs");
    expect(entry.callback).toBe("sweepStaleAsyncJobs");
    expect(entry.defaultIntervalSeconds).toBe(2592000);
    expect(orchestrator).not.toContain("STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS");
    expect(orchestrator).not.toContain("ensureStaleAsyncJobSweepSchedule");
  });

  it("the onStart reconcile seeds the stored schedule idempotently (get-first)", () => {
    const start = region("async onStart(");
    expect(start).toContain("reconcileSystemScheduleRecords");
    const specs = managementRegion("export function systemScheduleSeedSpecs(");
    expect(specs).toContain("STALE_ASYNC_JOB_SWEEP_RECORD_ID");
    expect(specs).toContain('callback: "sweepStaleAsyncJobs"');
    const reconcile = managementRegion("export async function reconcileSystemScheduleRecords(");
    expect(reconcile).toContain("deps.store.get(spec.id)");
    expect(reconcile).toContain("if (!existing)");
    expect(reconcile).toContain("await deps.store.save(record)");
    // The existence check must precede the seed save.
    expect(reconcile.indexOf("deps.store.get(spec.id)")).toBeLessThan(
      reconcile.indexOf("await deps.store.save(record)"),
    );
  });

  it("onStart runs an initial async-job sweep and reconciles the stored schedule", () => {
    const start = region("async onStart(");
    expect(start).toContain("sweepStaleAsyncJobs");
    expect(start).toContain("reconcileSystemScheduleRecords");
  });
});
