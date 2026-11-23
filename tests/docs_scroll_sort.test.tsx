/** @vitest-environment jsdom */
/**
 * Docs and Reports — scroll + sort contract.
 *
 * Pins:
 *  - the page is the scroll container inside the shell (a constrained
 *    flex item with its own overflow), so a long run list is reachable
 *    instead of being clipped by `.tab-viewport`;
 *  - the table header is sortable: each header is a button, the active
 *    column carries `aria-sort`, clicking toggles asc/desc, and choosing
 *    a new column starts from its natural direction;
 *  - sorting is honest: rows a store did not record (null run type, no
 *    artifact) sort last in either direction, never invented;
 *  - the default order is unchanged: newest run first.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import {
  DOCUMENT_SORT_DEFAULT,
  nextDocumentSort,
  sortDocumentRows,
  toDocumentRows,
  type DocumentRow,
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
  } as RunSummary;
}

function row(over: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: "rep-1",
    runId: "screener:2026-10-27T13:05:00.000Z",
    createdAt: "2026-10-27T13:05:00.000Z",
    runType: "scheduled",
    rawTrigger: "scheduled",
    runSource: "stock",
    title: "Market screen",
    status: "completed",
    pdfUrl: "/pdf",
    xlsxUrl: "/xlsx",
    csvUrl: "/csv",
    pdfStatus: "generated",
    pdfError: null,
    xlsxStatus: "generated",
    xlsxError: null,
    csvStatus: "generated",
    csvError: null,
    ...over,
  };
}

// --- pure sorting ---------------------------------------------------------

describe("sortDocumentRows", () => {
  it("defaults to newest first and does not mutate the input", () => {
    const rows = [
      row({ id: "old", createdAt: "2026-10-26T10:00:00.000Z" }),
      row({ id: "new", createdAt: "2026-10-27T10:00:00.000Z" }),
    ];
    const sorted = sortDocumentRows(rows, DOCUMENT_SORT_DEFAULT);
    expect(sorted.map((r) => r.id)).toEqual(["new", "old"]);
    expect(rows.map((r) => r.id)).toEqual(["old", "new"]);
  });

  it("sorts by run source label alphabetically in both directions", () => {
    const rows = [
      row({ id: "s", runSource: "stock" }),
      row({ id: "g", runSource: "goal" }),
      row({ id: "o", runSource: "options" }),
    ];
    expect(sortDocumentRows(rows, { key: "runSource", dir: "asc" }).map((r) => r.runSource)).toEqual([
      "goal",
      "options",
      "stock",
    ]);
    expect(sortDocumentRows(rows, { key: "runSource", dir: "desc" }).map((r) => r.runSource)).toEqual([
      "stock",
      "options",
      "goal",
    ]);
  });

  it("puts artifact-present rows first in descending order and missing rows last ascending", () => {
    const rows = [
      row({ id: "missing", pdfUrl: null }),
      row({ id: "present", pdfUrl: "/pdf" }),
    ];
    expect(sortDocumentRows(rows, { key: "pdf", dir: "desc" }).map((r) => r.id)).toEqual([
      "present",
      "missing",
    ]);
    expect(sortDocumentRows(rows, { key: "pdf", dir: "asc" }).map((r) => r.id)).toEqual([
      "missing",
      "present",
    ]);
  });

  it("keeps an unrecorded run type last in either direction", () => {
    const rows = [
      row({ id: "unknown", runType: null, rawTrigger: null }),
      row({ id: "manual", runType: "manual" }),
      row({ id: "scheduled", runType: "scheduled" }),
    ];
    expect(sortDocumentRows(rows, { key: "runType", dir: "asc" }).map((r) => r.id)).toEqual([
      "manual",
      "scheduled",
      "unknown",
    ]);
    expect(sortDocumentRows(rows, { key: "runType", dir: "desc" }).map((r) => r.id)).toEqual([
      "scheduled",
      "manual",
      "unknown",
    ]);
  });

  it("sorts run ids lexically and breaks ties deterministically", () => {
    const rows = [
      row({ id: "b", runId: "run-b", createdAt: "2026-10-27T10:00:00.000Z" }),
      row({ id: "a", runId: "run-a", createdAt: "2026-10-27T10:00:00.000Z" }),
    ];
    expect(sortDocumentRows(rows, { key: "runId", dir: "asc" }).map((r) => r.id)).toEqual(["a", "b"]);
    // Equal timestamps fall back to the row id, newest-first style (desc).
    expect(sortDocumentRows(rows, DOCUMENT_SORT_DEFAULT).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("maps the default direction of each column sensibly", () => {
    expect(nextDocumentSort(DOCUMENT_SORT_DEFAULT, "createdAt")).toEqual({ key: "createdAt", dir: "asc" });
    expect(nextDocumentSort({ key: "runSource", dir: "asc" }, "pdf")).toEqual({ key: "pdf", dir: "desc" });
    expect(nextDocumentSort({ key: "runSource", dir: "asc" }, "runType")).toEqual({ key: "runType", dir: "asc" });
    expect(nextDocumentSort({ key: "runId", dir: "desc" }, "runId")).toEqual({ key: "runId", dir: "asc" });
  });
});

// --- render harness -------------------------------------------------------

const realFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;
let payload: unknown = { count: 0, runs: [] };

function stubFetch() {
  globalThis.fetch = vi.fn(async () => Response.json(payload));
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

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

function headerByText(label: string): HTMLTableCellElement {
  const headers = [...container.querySelectorAll("th")];
  const header = headers.find((th) => (th.textContent ?? "").includes(label));
  if (!header) throw new Error(`header not found: ${label}`);
  return header as HTMLTableCellElement;
}

function columnTexts(selector: string): string[] {
  return [...container.querySelectorAll(`tbody tr ${selector}`)].map((el) => el.textContent ?? "");
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  stubFetch();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  globalThis.fetch = realFetch;
});

describe("DocsAndReportsPanel scroll + sort", () => {
  it("owns the page scroll instead of growing past the shell", async () => {
    payload = { count: 0, runs: [] };
    await renderPanel();
    expect(container.querySelector(".ui-page-frame")).not.toBeNull();

    const css = readFileSync("src/client/components/ui/primitives.css", "utf8");
    const pageRule = css.match(/\.ui-page-frame\s*\{([^}]*)\}/)?.[1] ?? "";
    // Constrained flex item (shrinkable, zero min-height) + its own scroll.
    expect(pageRule).toContain("flex: 1 1 auto");
    expect(pageRule).toContain("min-height: 0");
    expect(pageRule).toMatch(/overflow:\s*auto/);

    const frameRule = css.match(/\.ui-scroll-frame\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(frameRule).toMatch(/overflow:\s*auto/);
    expect(frameRule).toMatch(/max-height:/);
  });

  it("renders every header as a sort button and marks the default sort", async () => {
    payload = { count: 1, runs: [run()] };
    await renderPanel();

    const headers = [...container.querySelectorAll("th")];
    // Issue #2534: the Run Details column adds an eighth header; it
    // is an action column, not a sort column, so only the original
    // seven headers carry sort buttons. Issue #5102 (F5 of #5094):
    // the Account column is the ninth header (and the eighth sort
    // button).
    expect(headers).toHaveLength(9);
    expect(headers.filter((th) => th.querySelector("button"))).toHaveLength(8);
    expect(headers.some((th) => th.textContent?.includes("Run Details"))).toBe(true);
    expect(headers.some((th) => th.textContent?.includes("Account"))).toBe(true);
    for (const th of headers.filter((h) => !h.textContent?.includes("Run Details"))) {
      expect(th.querySelector("button")).not.toBeNull();
    }
    expect(headerByText("Date-Time").getAttribute("aria-sort")).toBe("descending");
    expect(headerByText("Run Source").hasAttribute("aria-sort")).toBe(false);
    // The header stays visible while the table scrolls inside its frame.
    expect(container.querySelector("th.sticky-head")).not.toBeNull();
    // The header stays visible while the table scrolls inside its frame.
    expect(container.querySelector("th.sticky-head")).not.toBeNull();
  });

  it("sorts by run source on click and toggles direction", async () => {
    payload = {
      count: 3,
      runs: [
        run({ id: "stock", reportId: "stock", runId: "run-stock", kind: "screener", source: "screener" }),
        run({
          id: "goal",
          reportId: "goal",
          runId: "run-goal",
          kind: "goal",
          source: "goal_screen",
          createdAt: "2026-10-26T10:00:00.000Z",
        }),
        run({
          id: "options",
          reportId: "options",
          runId: "run-options",
          kind: "options_scanner",
          source: "options_scanner",
          createdAt: "2026-10-25T10:00:00.000Z",
        }),
      ],
    };
    await renderPanel();
    // Default: newest first (stock > goal > options by date).
    expect(columnTexts("td:nth-child(3)")).toEqual(["Stock", "Goal", "Options"]);

    const header = headerByText("Run Source");
    await click(header.querySelector("button")!);
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(columnTexts("td:nth-child(3)")).toEqual(["Goal", "Options", "Stock"]);

    await click(header.querySelector("button")!);
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(columnTexts("td:nth-child(3)")).toEqual(["Stock", "Options", "Goal"]);
    // Only one column is marked as sorted.
    expect(headerByText("Date-Time").hasAttribute("aria-sort")).toBe(false);
  });

  it("sorts by artifact presence and keeps unrecorded artifacts together", async () => {
    payload = {
      count: 3,
      runs: [
        run({ id: "none", reportId: "none", runId: "run-none", reportUrl: null }),
        run({ id: "pdf", reportId: "pdf", runId: "run-pdf" }),
        run({
          id: "failed",
          reportId: "failed",
          runId: "run-failed",
          reportUrl: null,
          pdfStatus: "failed",
          pdfError: "render failed",
        }),
      ],
    };
    await renderPanel();

    const header = headerByText("PDF");
    await click(header.querySelector("button")!);
    expect(header.getAttribute("aria-sort")).toBe("descending");
    // Issue #5102 (F5 of #5094): the Account column is the fourth
    // column, so the Run ID column moved from 7th to 8th.
    expect(columnTexts("td:nth-child(8) code")[0]).toBe("run-pdf");
    // Both unrecorded rows follow; ordering between them stays newest first.
    expect(columnTexts("td:nth-child(8) code").slice(1)).toEqual(["run-none", "run-failed"]);
  });

  it("announces the active sort in the count line", async () => {
    payload = { count: 1, runs: [run()] };
    await renderPanel();
    expect(container.querySelector(".ui-meta")!.textContent).toContain("sorted by Date-Time");
    await click(headerByText("Run Type").querySelector("button")!);
    expect(container.querySelector(".ui-meta")!.textContent).toContain("sorted by Run Type");
  });
});
