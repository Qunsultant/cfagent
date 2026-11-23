/** @vitest-environment jsdom */
/**
 * Docs and Reports page: the per-run document index.
 *
 * Pins:
 *  - the Runs-API rows map to the four screener-workflow families
 *    (stock / options / goal / strategy) and nothing else — research
 *    reports and IV collection are not relabeled into this page;
 *  - run type is the recorded trigger normalized to manual/scheduled,
 *    and a store that records no trigger renders an honest "—";
 *  - every artifact link comes from the url the run recorded, so a
 *    missing PDF/XLSX/CSV is a "—" and never a broken link;
 *  - the table renders date-time, run type, run source, the three
 *    artifact links and the run id, newest first;
 *  - empty and failed loads are stated, not faked.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  documentRunSource,
  documentRunType,
  formatRunTimestamp,
  toDocumentRows,
} from "../src/client/docsAndReports";
import { DocsAndReportsPanel } from "../src/client/DocsAndReportsPanel";
import type { RunSummary } from "../src/services/runSummaries";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    kind: "screener",
    id: "rep-1",
    runId: "screener:2026-10-27T13:05:00.000Z",
    title: "Market screen — NASDAQ100",
    summary: "Scanned 100 symbols, 12 matched.",
    trigger: "scheduled",
    createdAt: "2026-10-27T13:05:00.000Z",
    status: "completed",
    resultCount: 12,
    pdfKey: "screener:pdf:rep-1",
    reportUrl: "/api/screener/report.pdf?key=screener%3Apdf%3Arep-1",
    xlsxKey: "screener:xlsx:rep-1",
    xlsxUrl: "/api/screener/report.xlsx?key=screener%3Axlsx%3Arep-1",
    csvKey: "screener:csv:rep-1",
    csvUrl: "/api/screener/report.csv?key=screener%3Acsv%3Arep-1",
    pdfStatus: "generated",
    pdfError: null,
    reportId: "rep-1",
    scanRunId: null,
    discoveryRunId: null,
    source: "screener",
    ...over,
  };
}

describe("document run source", () => {
  it("maps every screener-workflow kind to its family", () => {
    expect(documentRunSource({ kind: "screener", source: "screener" })).toBe("stock");
    expect(documentRunSource({ kind: "options_scanner", source: "options_scanner" })).toBe("options");
    expect(documentRunSource({ kind: "goal", source: "goal_screen" })).toBe("goal");
    expect(documentRunSource({ kind: "discovery", source: "discovery" })).toBe("strategy");
  });

  it("falls back to the store's own source label for detail-only rows", () => {
    expect(documentRunSource({ kind: "report", source: "options_screen" })).toBe("options");
    expect(documentRunSource({ kind: "report", source: "goal_screen" })).toBe("goal");
  });

  it("prefers the family recorded on the run over the kind derivation (#2062)", () => {
    expect(documentRunSource({ kind: "report", source: "research_report", runSource: "goal" })).toBe("goal");
    expect(documentRunSource({ kind: "report", source: "research_report", runSource: "unknown" })).toBeNull();
  });

  it("excludes non-screener products instead of relabeling them", () => {
    expect(documentRunSource({ kind: "report", source: "research_report" })).toBeNull();
    expect(documentRunSource({ kind: "report", source: "iv_collection" })).toBeNull();
    expect(toDocumentRows([run({ kind: "report", source: "research_report", id: "r2" })])).toEqual([]);
  });
});

describe("document run type", () => {
  it("normalizes recorded triggers", () => {
    expect(documentRunType({ trigger: "manual" })).toBe("manual");
    expect(documentRunType({ trigger: "manual-trigger" })).toBe("manual");
    expect(documentRunType({ trigger: "scheduled" })).toBe("scheduled");
    expect(documentRunType({ trigger: "cron" })).toBe("scheduled");
  });

  it("stays null when no trigger was recorded, never guessing scheduled", () => {
    expect(documentRunType({ trigger: null })).toBeNull();
    expect(documentRunType({ trigger: "" })).toBeNull();
    expect(documentRunType({ trigger: "preset" })).toBeNull();
  });
});

describe("toDocumentRows", () => {
  it("keeps the recorded artifact urls and leaves unrecorded ones null", () => {
    const [withArtifacts, without] = toDocumentRows([
      run(),
      run({
        id: "scan-1",
        kind: "options_scanner",
        source: "options_scanner",
        runId: "scan-1",
        trigger: null,
        reportUrl: "/api/options/report.pdf?key=options%3Apdf%3Ascan-1",
        xlsxUrl: null,
        csvUrl: null,
        createdAt: "2026-10-27T12:00:00.000Z",
      }),
    ]);
    expect(withArtifacts.pdfUrl).toBe("/api/screener/report.pdf?key=screener%3Apdf%3Arep-1");
    expect(withArtifacts.xlsxUrl).toContain("/api/screener/report.xlsx");
    expect(withArtifacts.csvUrl).toContain("/api/screener/report.csv");
    expect(without.xlsxUrl).toBeNull();
    expect(without.csvUrl).toBeNull();
    expect(without.runType).toBeNull();
  });

  it("orders newest first", () => {
    const rows = toDocumentRows([
      run({ id: "old", runId: "old", createdAt: "2026-10-26T10:00:00.000Z" }),
      run({ id: "new", runId: "new", createdAt: "2026-10-27T10:00:00.000Z" }),
    ]);
    expect(rows.map((r) => r.runId)).toEqual(["new", "old"]);
  });
});

describe("formatRunTimestamp", () => {
  it("renders a locale date-time and passes invalid values through", () => {
    expect(formatRunTimestamp("2026-10-27T13:05:00.000Z")).not.toBe("");
    expect(formatRunTimestamp("not-a-date")).toBe("not-a-date");
    expect(formatRunTimestamp("")).toBe("—");
  });
});

// --- render harness -------------------------------------------------------

const realFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;
let payload: unknown = { count: 0, runs: [] };
let status = 200;

function stubFetch() {
  globalThis.fetch = vi.fn(async () => {
    if (status !== 200) return Response.json({ error: "boom" }, { status });
    return Response.json(payload);
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPanel() {
  root = createRoot(container);
  await act(async () => {
    root.render(<DocsAndReportsPanel />);
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  status = 200;
  stubFetch();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  globalThis.fetch = realFetch;
});

describe("DocsAndReportsPanel", () => {
  it("renders one row per run with the required columns and links", async () => {
    payload = {
      count: 2,
      runs: [
        run(),
        run({
          id: "rep-2",
          reportId: "rep-2",
          kind: "goal",
          source: "goal_screen",
          runId: "goal-42",
          trigger: "manual",
          createdAt: "2026-10-26T09:30:00.000Z",
          reportUrl: "/api/screening/goal-screen/report.pdf?key=goal_screen%3Apdf%3A42",
          xlsxUrl: "/api/screening/goal-screen/report.xlsx?key=goal_screen%3Axlsx%3A42",
          csvUrl: null,
        }),
      ],
    };
    await renderPanel();

    const headers = [...container.querySelectorAll("th button > span:first-child")].map((el) => el.textContent);
    // Issue #5102 (F5 of #5094): the Account column sits after Run
    // Source, before the artifact columns.
    expect(headers).toEqual(["Date-Time", "Run Type", "Run Source", "Account", "PDF", "XLSX", "CSV", "Run ID"]);

    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);

    const first = rows[0];
    expect(first.textContent).toContain("Scheduled");
    expect(first.textContent).toContain("Stock");
    expect(first.textContent).toContain("screener:2026-10-27T13:05:00.000Z");
    const links = [...first.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual([
      "/api/screener/report.pdf?key=screener%3Apdf%3Arep-1",
      "/api/screener/report.xlsx?key=screener%3Axlsx%3Arep-1",
      "/api/screener/report.csv?key=screener%3Acsv%3Arep-1",
    ]);

    const second = rows[1];
    expect(second.textContent).toContain("Manual");
    expect(second.textContent).toContain("Goal");
    // CSV was not recorded for this run: no link, an honest dash instead.
    expect([...second.querySelectorAll("a")]).toHaveLength(2);
    expect(second.textContent).toContain("—");
  });

  it("renders a recorded leg failure as failed, not a bare dash (#2088)", async () => {
    payload = {
      count: 1,
      runs: [
        run({
          xlsxKey: null,
          xlsxUrl: null,
          xlsxStatus: "failed",
          xlsxError: "blob store unavailable",
          csvKey: null,
          csvUrl: null,
          csvStatus: null,
          csvError: null,
        }),
      ],
    };
    await renderPanel();

    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // XLSX failed: a failure badge, not a link and not a bare dash.
    expect(row.textContent).toContain("failed");
    const failed = row.querySelector('span[title="blob store unavailable"]');
    expect(failed).not.toBeNull();
    expect(failed!.getAttribute("title")).toBe("blob store unavailable");
    // CSV simply unrecorded: still an honest dash, and only the PDF links.
    expect([...row.querySelectorAll("a")]).toHaveLength(1);
    expect(row.textContent).toContain("—");
  });

  it("states an empty index instead of fabricating rows", async () => {
    payload = { count: 0, runs: [] };
    await renderPanel();
    expect(container.textContent).toContain("No screener documents yet");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
  });

  it("surfaces a load failure and offers a retry", async () => {
    status = 500;
    await renderPanel();
    expect(container.textContent).toContain("Documents unavailable");
    expect(container.textContent).toContain("HTTP 500");
    expect(container.textContent).toContain("Retry");
  });

  it("names stores the API could not read", async () => {
    payload = {
      count: 1,
      runs: [run()],
      storeErrors: { scans: "skipped: no authenticated user identity available" },
    };
    await renderPanel();
    expect(container.textContent).toContain("Some run stores were skipped");
    expect(container.textContent).toContain("scans:");
  });
});
