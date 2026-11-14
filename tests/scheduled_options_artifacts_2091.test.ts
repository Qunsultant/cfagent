// @vitest-environment node
/**
 * Issue #2091 — scheduled options runs show no stored artifacts in Docs.
 *
 * The scheduled options path is the sharded chain now, and its store leg DOES
 * write artifacts: one canonical `mas_reports` row per format, with a body of
 * `{ format, key, fileName }`. The Docs/Reports read only understood the flat
 * `pdfKey`/`xlsxKey`/`csvKey` body shape, so those rows rendered as an
 * unexplained all-"—" line — the exact symptom the issue was filed for, with
 * the artifacts sitting in storage the whole time.
 *
 * Pins:
 *  - 2091-P01 a chain row records its OWN format's key onto the summary, and
 *    leaves the other two empty (never a cross-format link).
 *  - 2091-P02 the per-format urls build from it, per source route.
 *  - 2091-P03 the flat legacy body keeps mapping exactly as before.
 *  - 2091-P04 three format rows for one run produce three rows with one live
 *    link each (the run's full set, in Docs).
 */
import { describe, expect, it } from "vitest";
import { runSummaryFromReport } from "../src/services/runSummaries";
import {
  scheduledReportPdfUrl,
  type ScheduledReportHit,
} from "../src/services/scheduledReports";

function chainHit(format: "pdf" | "xlsx" | "csv", key: string): ScheduledReportHit {
  return {
    id: `rep-${format}`,
    runId: "options:chain-2091",
    title: `Options scanner — bullish (${format})`,
    source: "options_scanner",
    summary: "Sharded options screen: bullish, 3 shards.",
    body: JSON.stringify({ format, key, fileName: `report.${format}`, chainId: "chain-2091", trigger: "scheduled" }),
    createdAt: "2026-11-14T12:00:00.000Z",
    generationId: `options:chain-2091:${format}`,
    userLogin: "analyst",
  } as ScheduledReportHit;
}

describe("2091-P01 a chain row maps only its own format", () => {
  it("pdf row", () => {
    const summary = runSummaryFromReport(chainHit("pdf", "options:chain-2091:pdf:1"));
    expect(summary.pdfKey).toBe("options:chain-2091:pdf:1");
    expect(summary.xlsxKey).toBeNull();
    expect(summary.csvKey).toBeNull();
    expect(summary.reportUrl).toContain("/api/options/report.pdf?key=");
  });

  it("xlsx row", () => {
    const summary = runSummaryFromReport(chainHit("xlsx", "options:chain-2091:xlsx:1"));
    expect(summary.xlsxKey).toBe("options:chain-2091:xlsx:1");
    expect(summary.xlsxUrl).toContain("/api/options/report.xlsx?key=");
    expect(summary.pdfKey).toBeNull();
    expect(summary.reportUrl ?? null).toBeNull();
  });

  it("csv row", () => {
    const summary = runSummaryFromReport(chainHit("csv", "options:chain-2091:csv:1"));
    expect(summary.csvKey).toBe("options:chain-2091:csv:1");
    expect(summary.csvUrl).toContain("/api/options/report.csv?key=");
    expect(summary.pdfKey).toBeNull();
  });
});

describe("2091-P02 the pdf link builds from the chain shape", () => {
  it("resolves through the options route for an options chain", () => {
    expect(
      scheduledReportPdfUrl("options_scanner", JSON.stringify({ format: "pdf", key: "options:pdf:9" })),
    ).toBe(`/api/options/report.pdf?key=${encodeURIComponent("options:pdf:9")}`);
  });

  it("does not build a pdf link from an xlsx row", () => {
    expect(
      scheduledReportPdfUrl("options_scanner", JSON.stringify({ format: "xlsx", key: "options:xlsx:9" })),
    ).toBeUndefined();
  });
});

describe("2091-P03 the flat legacy body is untouched", () => {
  it("still maps all three keys and urls", () => {
    const hit = {
      ...chainHit("pdf", "ignored"),
      body: JSON.stringify({
        pdfKey: "options:pdf:legacy",
        xlsxKey: "options:xlsx:legacy",
        csvKey: "options:csv:legacy",
        trigger: "manual",
      }),
    };
    const summary = runSummaryFromReport(hit);
    expect(summary.pdfKey).toBe("options:pdf:legacy");
    expect(summary.xlsxKey).toBe("options:xlsx:legacy");
    expect(summary.csvKey).toBe("options:csv:legacy");
    expect(summary.reportUrl).toContain("options%3Apdf%3Alegacy");
  });
});

describe("2091-P04 one run, three formats, three live links", () => {
  it("each format row carries exactly one artifact link", () => {
    const rows = (["pdf", "xlsx", "csv"] as const).map((format) => ({
      format,
      summary: runSummaryFromReport(chainHit(format, `options:chain-2091:${format}:1`)),
    }));
    const links = rows.map(({ summary }) => [summary.reportUrl, summary.xlsxUrl, summary.csvUrl]);
    for (const [index, row] of links.entries()) {
      const live = row.filter((url) => typeof url === "string" && url.length > 0);
      expect(live, rows[index].format).toHaveLength(1);
    }
    expect(new Set(links.map((row) => row.find(Boolean))).size).toBe(3);
  });
});
