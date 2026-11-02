/** @vitest-environment jsdom */
/**
 * Issue #1326: one run-detail view (natural home ScreenersHub, which
 * already has run-status labels and a runs list) showing outcome,
 * partial qualification (stock #462 stamp), artifacts (PDF/XLSX links
 * + pdfStatus/pdfError), and delivery status per channel including
 * held/approved state.
 *
 * Pins:
 *  - outcome renders: status badge, matched/total counts, trigger,
 *    universe/sector, timestamp
 *  - a partial run shows its qualification PROMINENTLY: quoted vs
 *    requested counts, failed symbols, failure reasons
 *  - a failed artifact shows its coded error, not a silent missing link
 *  - a generated PDF renders its download link
 *  - delivery rows show channel + status incl. held (pending) and
 *    approved; an empty delivery list renders an honest empty state
 *  - ScreenersHub wires the view into the selected-run area (source pin)
 *
 * Harness follows tests/pdf_report_link_honesty.test.tsx: react-dom/client
 * in jsdom, direct component renders.
 */
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { RunDetailView, type RunDetailRun, type RunDetailConfirmation } from "../src/client/RunDetailView";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
}

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
});

const baseRun: RunDetailRun = {
  timestamp: "2026-10-25T10:00:00.000Z",
  trigger: "scheduled",
  universe: "nasdaq100",
  sector: "Technology",
  success: true,
  totalScanned: 100,
  matchedCount: 7,
  reportUrl: "/api/screener/report.pdf?key=abc",
  pdfStatus: "generated",
};

const held: RunDetailConfirmation = {
  confirmationId: "conf-1",
  kind: "screener",
  status: "pending",
  createdAt: "2026-10-25T10:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  detail: "Screener follow-up",
};

const approved: RunDetailConfirmation = {
  confirmationId: "conf-2",
  kind: "email",
  status: "approved",
  createdAt: "2026-10-25T09:00:00.000Z",
  decidedAt: "2026-10-25T09:30:00.000Z",
  decidedBy: "ceos",
  detail: "dhmprstw@gmail.com · report.pdf",
};

describe("Issue #1326 — RunDetailView", () => {
  it("renders the outcome: status, counts, trigger, universe/sector", async () => {
    await render(<RunDetailView run={baseRun} confirmations={[]} confirmationsLoading={false} />);
    const text = container.textContent || "";
    expect(text).toContain("Complete");
    expect(text).toContain("7");
    expect(text).toContain("100");
    expect(text).toContain("scheduled");
    expect(text).toContain("NASDAQ100");
    expect(text).toContain("Technology");
  });

  it("a partial run shows its qualification prominently", async () => {
    const run: RunDetailRun = {
      ...baseRun,
      partial: {
        quotedCount: 47,
        requestedCount: 100,
        failedSymbols: ["AAPL", "MSFT"],
        failureReasons: { other: 53 },
      },
    };
    await render(<RunDetailView run={run} confirmations={[]} confirmationsLoading={false} />);
    const text = container.textContent || "";
    expect(text).toContain("Partial");
    expect(text).toContain("47");
    expect(text).toContain("100");
    expect(text).toContain("AAPL");
    expect(text).toContain("MSFT");
  });

  it("a failed PDF shows its coded error, not a silent missing link", async () => {
    const run: RunDetailRun = {
      ...baseRun,
      reportUrl: undefined,
      pdfKey: undefined,
      pdfStatus: "failed",
      pdfError: "FAILURE_REPORT_XLSX_GENERATION: PDF generation failed for the stored run",
    };
    await render(<RunDetailView run={run} confirmations={[]} confirmationsLoading={false} />);
    const text = container.textContent || "";
    expect(text).toContain("FAILURE_REPORT_XLSX_GENERATION");
    expect(container.querySelector('a[href*="report.pdf"]')).toBeNull();
  });

  it("a failed XLSX shows its coded error via Notice (#2247)", async () => {
    const run: RunDetailRun = {
      ...baseRun,
      xlsxStatus: "failed",
      xlsxError: "[FAILURE_REPORT_XLSX_GENERATION] The XLSX report could not be generated. — blob store down",
    };
    await render(<RunDetailView run={run} confirmations={[]} confirmationsLoading={false} />);
    const text = container.textContent || "";
    expect(text).toContain("FAILURE_REPORT_XLSX_GENERATION");
    expect(text).toContain("XLSX unavailable");
    expect(container.querySelector(".ui-notice")).not.toBeNull();
  });

  it("a generated PDF renders its download link", async () => {
    await render(<RunDetailView run={baseRun} confirmations={[]} confirmationsLoading={false} />);
    const link = container.querySelector('a[href*="report.pdf"]');
    expect(link).not.toBeNull();
    expect(link!.textContent || "").toContain("PDF");
  });

  it("delivery rows show channel and status incl. held and approved", async () => {
    await render(<RunDetailView run={baseRun} confirmations={[held, approved]} confirmationsLoading={false} />);
    const text = container.textContent || "";
    expect(text).toContain("Held for review");
    expect(text).toContain("Approved");
    expect(text).toContain("screener");
    expect(text).toContain("email");
  });

  it("an empty delivery list renders an honest empty state", async () => {
    await render(<RunDetailView run={baseRun} confirmations={[]} confirmationsLoading={false} />);
    expect(container.textContent || "").toContain("No delivery record linked to this run.");
  });

  it("StockHub wires the view into the selected-run area (source pin, #2896)", () => {
    const hub = readFileSync("src/client/StockHub.tsx", "utf8");
    expect(hub).toContain("RunDetailView");
  });
});
