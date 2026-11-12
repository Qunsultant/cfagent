/** @vitest-environment jsdom */
/**
 * Issue #4262 (S4, option A) — what ran and what it produced, in one row.
 *
 * Pins:
 *  - 4262S4-P01 a report run the ledger already carries is the same run (the
 *    ledger row wins); a run with no ledger twin becomes one ledger row stamped
 *    `kind: "reports"` with its artifact states carried verbatim.
 *  - 4262S4-P02 the artifact states survive the fold: a recorded key links, a
 *    missing key is an honest dash, a recorded leg failure keeps its reason.
 *  - 4262S4-P03 the Docs & Reports address is a folded view: `?tab=docs`
 *    redirects to the one ledger with kind=reports.
 *  - 4262S4-P04 the ledger renders the Documents cell for a report row and the
 *    run's details dialog is reachable from that row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { attachReportRuns } from "../src/client/runLedgerReportRuns";
import { legacySchedulesRedirect } from "../src/client/schedulesHomeView";
import { ScheduleRunLedgerPanel } from "../src/client/ScheduleRunLedgerPanel";
import type { JobRunRecord } from "../src/data/jobRunRecordPorts";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function docRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "rep-1",
    runId: "rep-1",
    createdAt: "2026-11-12T11:00:00.000Z",
    trigger: "manual",
    kind: "screener",
    source: "screener",
    runSource: "stock",
    title: "Docs run",
    status: "success",
    reportUrl: "/api/runs/artifact?key=pdf-1",
    xlsxUrl: null,
    csvUrl: null,
    pdfStatus: null,
    pdfError: null,
    xlsxStatus: null,
    xlsxError: null,
    csvStatus: null,
    csvError: null,
    ...overrides,
  };
}

function ledgerRow(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    system: "orchestrator-schedule",
    jobId: "sched-1",
    operation: "trading.screen_stocks",
    started: "2026-11-12T09:00:00.000Z",
    finished: "2026-11-12T09:01:00.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    trigger: "scheduled",
    ...(overrides as object),
  } as JobRunRecord;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal("fetch", vi.fn());
  window.history.replaceState({}, "", "/?tab=schedules&view=runs");
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
}

function stub(ledger: unknown[], workflow: unknown[], reports: unknown[], details?: unknown): void {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/ledger/runs")) return new Response(JSON.stringify({ runs: ledger }), { status: 200 });
      if (url.includes("/api/workflow-runs")) return new Response(JSON.stringify({ runs: workflow }), { status: 200 });
      if (url.includes("/api/runs/details")) return new Response(JSON.stringify({ detail: details ?? null }), { status: 200 });
      if (url.includes("/api/runs")) return new Response(JSON.stringify({ runs: reports }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    },
  );
}

describe("4262S4-P01 attachment and kind", () => {
  it("drops a report run the ledger already carries by runId", () => {
    const entries = attachReportRuns([ledgerRow({ asyncJobId: "rep-1" })], [docRun()]);
    expect(entries).toHaveLength(0);
  });

  it("adapts a report run with no ledger twin as kind=reports", () => {
    const [entry] = attachReportRuns([ledgerRow()], [docRun()]);
    expect(entry.row.kind).toBe("reports");
    expect(entry.row.jobId).toBe("rep-1");
    expect(entry.row.descriptor).toBe("Docs run");
  });
});

describe("4262S4-P02 artifact states survive the fold", () => {
  it("carries the link, the dash and the recorded failure reason", () => {
    const [entry] = attachReportRuns(
      [],
      [
        docRun({
          reportUrl: "/api/runs/artifact?key=pdf-1",
          xlsxUrl: null,
          csvUrl: null,
          csvStatus: "failed",
          csvError: "renderer exploded",
        }),
      ],
    );
    expect(entry.docs.pdfUrl).toBe("/api/runs/artifact?key=pdf-1");
    expect(entry.docs.xlsxUrl).toBeNull();
    expect(entry.docs.csvStatus).toBe("failed");
    expect(entry.docs.csvError).toBe("renderer exploded");
  });
});

describe("4262S4-P03 the docs address is a folded view", () => {
  it("redirects ?tab=docs to the ledger with kind=reports", () => {
    expect(legacySchedulesRedirect("?tab=docs")).toEqual({
      tab: "schedules",
      view: "runs",
      params: { kind: "reports" },
    });
  });
});

describe("4262S4-P04 the ledger renders what the run produced", () => {
  it("shows the artifact links and the failed state in the row", async () => {
    stub(
      [],
      [],
      [
        docRun(),
        docRun({
          id: "rep-2",
          runId: "rep-2",
          reportUrl: null,
          csvStatus: "failed",
          csvError: "renderer exploded",
        }),
      ],
    );
    await render(<ScheduleRunLedgerPanel kind="reports" />);
    await settle();
    const text = (container!.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("rep-1");
    expect(text).toContain("rep-2");
    const pdfLinks = Array.from(container!.querySelectorAll("a")).filter((a) =>
      (a.textContent ?? "").trim() === "PDF",
    );
    expect(pdfLinks.length).toBe(1);
    expect(text).toContain("failed");
  });

  it("opens the run's details dialog from the report row", async () => {
    // The details payload shape is the docs modal's own business; this pin
    // proves the report row ROUTES to that dialog's fetch (the modal renders
    // its error state for a null detail, which is why no sections are stubbed).
    stub([], [], [docRun()], null);
    await render(<ScheduleRunLedgerPanel kind="reports" />);
    await settle();
    const rowButton = Array.from(container!.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "rep-1",
    );
    expect(rowButton).toBeDefined();
    await act(async () => {
      rowButton!.click();
    });
    await settle();
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
      (call) => String(call[0]).includes("/api/runs/details?runId=rep-1"),
    )).toBe(true);
  });
});
