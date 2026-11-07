/**
 * Issue #2608: message catalog alignment — the Run Details messages
 * are folded into the single outcome catalog
 * (src/outcomes/outcomeCatalog.json, top-level "runDetailMessages"),
 * resolved through the single resolver in
 * src/outcomes/outcomeAspects.ts. Pins:
 *  - the deprecated RUN_DETAIL_MESSAGE_CATALOG in runDetails.ts IS
 *    the catalog-file section (one catalog, one object — not a
 *    second catalog kept in sync by hand);
 *  - the deprecated resolveRunDetailMessage wrapper resolves
 *    identically to the single resolver, for every code;
 *  - buildRunDetail reports catalogVersion "2" (v1 was the
 *    standalone catalog; v2 is the fold) and its reasons carry the
 *    catalog file's wording;
 *  - RUN_STAGE_FAILED's {stage} param uses the existing StageName
 *    vocabulary (#2601 kept it) — no new enum is invented here; the
 *    full Docs↔StageName mapping belongs to #3334, not this slice.
 */
import { describe, expect, it } from "vitest";
import catalog from "../src/outcomes/outcomeCatalog.json";
import {
  getRunDetailMessageCatalog,
  resolveRunDetailMessage as resolveFromCatalog,
  RUN_DETAIL_MESSAGE_CATALOG_VERSION,
} from "../src/outcomes/outcomeAspects";
import {
  buildRunDetail,
  resolveRunDetailMessage,
  RUN_DETAIL_MESSAGE_CATALOG,
} from "../src/services/runDetails";
import { STAGE_NAMES } from "../src/messaging/messagingPorts";
import type { RunSummary } from "../src/services/runSummaries";

const runMessages = (
  catalog as {
    runDetailMessages: Record<string, Record<string, unknown>>;
  }
).runDetailMessages;

const SAMPLE_PARAMS: Record<string, Record<string, string>> = {
  RUN_NO_ARTIFACT_RECORDED: { format: "PDF" },
  RUN_PDF_FAILED: { error: ": boom" },
  RUN_XLSX_FAILED: { error: ": boom" },
  RUN_CSV_FAILED: { error: ": boom" },
  RUN_CAPTURE_MISSING: { capture: ": cap-1" },
  RUN_CONNECTOR_UNAVAILABLE: { connector: ": connector-1" },
  RUN_PROVIDER_FETCH_FAILED: { provider: ": etrade" },
  RUN_STAGE_FAILED: { stage: "analysis", error: ": boom" },
  RUN_NEVER_ATTEMPTED: { format: "PDF" },
  RUN_LEGACY_UNKNOWN: { store: "mas_reports" },
};

function summary(over: Partial<RunSummary> = {}): RunSummary & { body?: unknown } {
  return {
    kind: "options_scanner",
    id: "rep-1",
    runId: "options:2026-10-31T09:20:56.666Z",
    title: "Options scan — bullish",
    summary: "Scanned 20 symbols, 5 with trades.",
    trigger: "scheduled",
    createdAt: "2026-10-31T09:20:56.666Z",
    status: "completed",
    resultCount: 5,
    pdfKey: "options:pdf:rep-1",
    reportUrl: "/api/options/report.pdf?key=options%3Apdf%3Arep-1",
    xlsxKey: "options:xlsx:rep-1",
    xlsxUrl: "/api/options/report.xlsx?key=options%3Axlsx%3Arep-1",
    csvKey: "options:csv:rep-1",
    csvUrl: "/api/options/report.csv?key=options%3Acsv%3Arep-1",
    pdfStatus: "generated",
    pdfError: null,
    xlsxStatus: "generated",
    xlsxError: null,
    csvStatus: "generated",
    csvError: null,
    reportId: "rep-1",
    scanRunId: "da875555-5e46-4729-a5c9-f76c45e61a2e",
    discoveryRunId: null,
    source: "options_scanner",
    ...over,
  } as RunSummary & { body?: unknown };
}

describe("run detail catalog fold (#2608)", () => {
  it("the deprecated local catalog IS the catalog-file section — one catalog, not two", () => {
    expect(RUN_DETAIL_MESSAGE_CATALOG).toBe(runMessages);
    expect(RUN_DETAIL_MESSAGE_CATALOG).toBe(getRunDetailMessageCatalog());
    expect(Object.keys(RUN_DETAIL_MESSAGE_CATALOG)).toHaveLength(18);
    expect(RUN_DETAIL_MESSAGE_CATALOG_VERSION).toBe("2");
  });

  it("the deprecated wrapper resolves identically to the single resolver, for every code", () => {
    for (const code of Object.keys(runMessages)) {
      const params = SAMPLE_PARAMS[code] ?? {};
      expect(resolveRunDetailMessage(code, params)).toEqual(
        resolveFromCatalog(code, params),
      );
    }
    expect(resolveRunDetailMessage("RUN_DOES_NOT_EXIST")).toEqual(
      resolveFromCatalog("RUN_DOES_NOT_EXIST"),
    );
  });

  it("buildRunDetail reports catalogVersion 2 and reasons in the catalog file's wording", () => {
    const detail = buildRunDetail(
      summary({
        status: "failed",
        pdfKey: null,
        reportUrl: null,
        pdfStatus: "failed",
        pdfError: "boom",
        xlsxKey: null,
        xlsxUrl: null,
        xlsxStatus: null,
        csvKey: null,
        csvUrl: null,
        csvStatus: null,
      }),
    );
    expect(detail.catalogVersion).toBe("2");
    const pdf = detail.reasons.find((r) => r.code === "RUN_PDF_FAILED");
    expect(pdf?.text).toBe(
      resolveFromCatalog("RUN_PDF_FAILED", { error: ": boom" }).text,
    );
    expect(pdf?.action).toBe(runMessages.RUN_PDF_FAILED.action);
  });

  it("RUN_STAGE_FAILED's {stage} param uses the existing StageName vocabulary — no new enum", () => {
    // The only stage value buildRunDetail emits for RUN_STAGE_FAILED
    // is "analysis", which is a member of the #2601-kept StageName
    // vocabulary (feed | gather | analysis | store | serve | deliver)
    // and of the Docs six-stage list alike. No new enum is invented
    // here; mapping the two vocabularies is #3334's work.
    expect(STAGE_NAMES).toContain("analysis");
    const detail = buildRunDetail(
      summary({ status: "failed", pdfStatus: null, xlsxStatus: null, csvStatus: null }),
    );
    const reason = detail.reasons.find((r) => r.code === "RUN_STAGE_FAILED");
    expect(reason?.text).toContain("The analysis stage failed for this run.");
    expect(reason?.text).not.toContain("{stage}");
  });
});
