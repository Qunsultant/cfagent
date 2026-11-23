/**
 * Issue #2606: Autopilot parity — the jobs list reads the one run
 * surface (GET /api/runs) instead of the mas_job_outcomes sink.
 * Pins runSummaryToJobOutcome: every RunSummary.kind maps onto
 * the table's feed kind, the store's status verb survives verbatim
 * where the table knows it, and the fields the one record does
 * not carry (codedError, origin, scanned) read as null — never
 * invented. The #6006 dependency is named, not papered over.
 */
import { describe, it, expect } from "vitest";
import {
  JOB_OUTCOME_KIND_LABELS,
  runSummaryToJobOutcome,
  type JobOutcomeFeedItem,
} from "../src/client/components/AutopilotControlCenter";
import type { RunSummary } from "../src/services/runSummaries";

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    kind: "screener",
    id: "report-1",
    runId: "run-1",
    title: "Stock screen",
    summary: "10 matched",
    trigger: "scheduled",
    createdAt: "2026-11-23T08:00:00.000Z",
    status: "completed",
    resultCount: 10,
    pdfKey: "pdf-1",
    reportUrl: "https://example.invalid/reports/report-1",
    xlsxKey: null,
    xlsxUrl: null,
    csvKey: null,
    csvUrl: null,
    pdfStatus: "generated",
    pdfError: null,
    reportId: "report-1",
    scanRunId: null,
    source: "screener",
    ...overrides,
  };
}

describe("runSummaryToJobOutcome (#2606)", () => {
  it("maps every RunSummary.kind onto a labeled feed kind", () => {
    const cases: Array<[RunSummary["kind"], JobOutcomeFeedItem["kind"]]> = [
      ["screener", "stock"],
      ["options_scanner", "options"],
      ["goal", "goal"],
      ["discovery", "discovery"],
      ["report", "engine"],
    ];
    for (const [runKind, feedKind] of cases) {
      const row = runSummaryToJobOutcome(makeRun({ kind: runKind }));
      expect(row.kind).toBe(feedKind);
      expect(JOB_OUTCOME_KIND_LABELS[feedKind]).toBeTruthy();
    }
  });

  it("passes the store status verb through; unknown or missing reads unknown, never invented", () => {
    expect(runSummaryToJobOutcome(makeRun({ status: "completed" })).status).toBe("completed");
    expect(runSummaryToJobOutcome(makeRun({ status: "failed" })).status).toBe("failed");
    expect(runSummaryToJobOutcome(makeRun({ status: "partial" })).status).toBe("partial");
    expect(runSummaryToJobOutcome(makeRun({ status: "skipped" })).status).toBe("skipped");
    expect(runSummaryToJobOutcome(makeRun({ status: null })).status).toBe("unknown");
    expect(runSummaryToJobOutcome(makeRun({ status: "running" })).status).toBe("unknown");
  });

  it("normalizes the trigger onto the five dispatch modes (#5052)", () => {
    expect(runSummaryToJobOutcome(makeRun({ trigger: "scheduled" })).trigger).toBe("scheduled");
    expect(runSummaryToJobOutcome(makeRun({ trigger: "copilot" })).trigger).toBe("copilot");
    expect(runSummaryToJobOutcome(makeRun({ trigger: "manual-trigger" })).trigger).toBe("manual");
    expect(runSummaryToJobOutcome(makeRun({ trigger: null })).trigger).toBe("manual");
  });

  it("keys the row by the home-store run id, so /api/runs/details resolves it", () => {
    const row = runSummaryToJobOutcome(
      makeRun({ id: "report-9", runId: "run-9", scanRunId: "scan-9" }),
    );
    expect(row.id).toBe("run-9");
    expect(row.createdAt).toBe("2026-11-23T08:00:00.000Z");
  });

  it("carries the headline count as matched; scanned is unknown, never invented", () => {
    const row = runSummaryToJobOutcome(makeRun({ resultCount: 7 }));
    expect(row.matched).toBe(7);
    expect(row.scanned).toBeNull();
  });

  it("carries the report link and artifact keys; codedError and origin stay null until #6006", () => {
    const row = runSummaryToJobOutcome(
      makeRun({ reportUrl: "https://example.invalid/reports/report-1", pdfKey: "pdf-1", xlsxKey: "xlsx-1" }),
    );
    expect(row.reportUrl).toBe("https://example.invalid/reports/report-1");
    expect(row.pdfKey).toBe("pdf-1");
    expect(row.xlsxKey).toBe("xlsx-1");
    expect(row.codedError).toBeNull();
    expect(row.origin).toBeNull();
    expect(row.deliveryStates).toEqual({});
  });
});
