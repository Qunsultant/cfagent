/**
 * Issue #1065 (consolidation S6): ONE client exporter.
 *
 * The five legacy exporter modules (screenerExport, scannerExport,
 * discoveryExport, options/optionsIdeasExport, options/
 * optionsDataExporter) converged into src/client/runExport.ts: a
 * per-kind column-map registry, one CSV builder, one JSON builder,
 * shared filename builders, and the only export download helpers.
 *
 * These pins are BYTE-equivalence pins. The expected outputs in
 * tests/run_export_goldens.json were captured from the LEGACY
 * builders on pre-S6 main over the edge-rich inputs in
 * tests/fixtures/runExportFixtures.ts (commas, quotes, CR/LF,
 * unicode, null/undefined cells, zeros, empty sets, partial /
 * failed / abstained / derived / no-view outcomes, invalid
 * timestamps). Regeneration procedure:
 * tests/fixtures/generateRunExportGoldens.ts. Any future drift
 * between the shared module and these captures is a behaviour
 * change, not a refactor — it must be deliberate and re-captured
 * with justification.
 *
 * The XLS workbooks are pinned by sha256 + length; the generator
 * proved the builders byte-deterministic (two builds, same hash),
 * so a hash pin is a byte-equivalence pin.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import goldens from "./run_export_goldens.json";
import {
  EXPORT_COLUMN_MAPS,
  createOptionsIdeasReportXls,
  createRawOptionsIdeasXls,
  createRetrievedOptionsDataXls,
  csvEscape,
  datedXlsFilename,
  discoveryCandidatesCsv,
  discoveryExportFilename,
  discoveryRunHasCandidates,
  discoveryRunJson,
  discoveryTriggerLabel,
  formatConstraintSetLine,
  scanExportFilename,
  scanExportRunFromResult,
  scanExportRunFromStored,
  scanResultsCsv,
  scanRunJson,
  screenAllStocksCsv,
  screenExportFilename,
  screenRunJson,
  screenStandoutsCsv,
} from "../src/client/runExport";
import {
  DISCOVERY_FAILED,
  DISCOVERY_NOVIEW,
  DISCOVERY_VIEWED_PARTIAL,
  SCAN_EMPTY_FITS,
  SCAN_LIVE_RESPONSE,
  SCAN_STORED_FIT,
  SCAN_STORED_PER_NAME,
  SCREEN_BAD_TIMESTAMP,
  SCREEN_EMPTY_ALL_SECTOR,
  SCREEN_PARTIAL,
  SCREEN_RUN,
  XLS_RAW_GROUPED,
  XLS_RAW_PLAIN,
  XLS_REPORT,
  XLS_REPORT_MINIMAL,
  XLS_RETRIEVED,
} from "./fixtures/runExportFixtures";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ROOT = process.cwd();

describe("csvEscape (#1065, ex-#125 PR-B semantics)", () => {
  it("matches the legacy captures case for case", () => {
    const inputs: unknown[] = [
      "NVDA", 187.5, 0, null, undefined, "", "Acme, Inc", 'Say "Holdings" Co',
      "Line1\nLine2", "Carriage\rReturn", "Ünïcode ✓", "trailing,", ",leading",
    ];
    expect(inputs.map((v) => csvEscape(v))).toEqual(goldens.csvEscapeCases);
  });
});

describe("screen exports (#1065 golden equivalence)", () => {
  it("standouts CSV is byte-identical to the legacy builder", () => {
    expect([SCREEN_RUN, SCREEN_PARTIAL, SCREEN_EMPTY_ALL_SECTOR].map(screenStandoutsCsv))
      .toEqual(goldens.screen.standoutsCsv);
  });
  it("all-stocks CSV is byte-identical to the legacy builder", () => {
    expect([SCREEN_RUN, SCREEN_PARTIAL, SCREEN_EMPTY_ALL_SECTOR].map(screenAllStocksCsv))
      .toEqual(goldens.screen.allStocksCsv);
  });
  it("run JSON is byte-identical to the legacy builder", () => {
    expect([SCREEN_RUN, SCREEN_PARTIAL].map(screenRunJson)).toEqual(goldens.screen.runJson);
  });
  it("filenames match the legacy scheme incl. the untrimmed invalid-timestamp fallback", () => {
    const actual = [SCREEN_RUN, SCREEN_PARTIAL, SCREEN_EMPTY_ALL_SECTOR, SCREEN_BAD_TIMESTAMP].map((run) => ({
      standouts: screenExportFilename(run, "standouts"),
      allStocks: screenExportFilename(run, "all-stocks"),
      runJson: screenExportFilename(run, "run-json"),
    }));
    expect(actual).toEqual(goldens.screen.filenames);
  });
});

describe("scan exports (#1065 golden equivalence)", () => {
  it("the stored-run adapter produces the legacy run shape", () => {
    expect(JSON.parse(JSON.stringify(scanExportRunFromStored(SCAN_STORED_FIT))))
      .toEqual(goldens.scan.storedFitRun);
  });
  it("the live-response adapter strips the envelope exactly as legacy", () => {
    expect(JSON.parse(JSON.stringify(scanExportRunFromResult(SCAN_LIVE_RESPONSE))))
      .toEqual(goldens.scan.liveFitRun);
  });
  it("results CSV is byte-identical across modes (fits / opportunities / empty)", () => {
    const actual = [
      scanResultsCsv(scanExportRunFromStored(SCAN_STORED_FIT)),
      scanResultsCsv(scanExportRunFromResult(SCAN_LIVE_RESPONSE)),
      scanResultsCsv(scanExportRunFromStored(SCAN_STORED_PER_NAME)),
      scanResultsCsv(scanExportRunFromStored(SCAN_EMPTY_FITS)),
    ];
    expect(actual).toEqual(goldens.scan.resultsCsv);
  });
  it("run JSON is byte-identical (field order included)", () => {
    const actual = [
      scanRunJson(scanExportRunFromStored(SCAN_STORED_FIT)),
      scanRunJson(scanExportRunFromResult(SCAN_LIVE_RESPONSE)),
      scanRunJson(scanExportRunFromStored(SCAN_STORED_PER_NAME)),
      scanRunJson(scanExportRunFromStored(SCAN_EMPTY_FITS)),
    ];
    expect(actual).toEqual(goldens.scan.runJson);
  });
  it("filenames match the legacy scheme incl. the 'undated' fallback", () => {
    const actual = [SCAN_STORED_FIT, SCAN_STORED_PER_NAME, SCAN_EMPTY_FITS].map((stored) => {
      const run = scanExportRunFromStored(stored);
      return {
        resultsCsv: scanExportFilename(run, "results-csv"),
        runJson: scanExportFilename(run, "run-json"),
      };
    });
    expect(actual).toEqual(goldens.scan.filenames);
  });
});

describe("discovery exports (#1065 golden equivalence)", () => {
  it("candidates CSV is byte-identical for viewed, no-view, and failed runs", () => {
    expect([DISCOVERY_VIEWED_PARTIAL, DISCOVERY_NOVIEW, DISCOVERY_FAILED].map(discoveryCandidatesCsv))
      .toEqual(goldens.discovery.candidatesCsv);
  });
  it("run JSON is byte-identical (userLogin scoping stamp stripped)", () => {
    expect([DISCOVERY_VIEWED_PARTIAL, DISCOVERY_NOVIEW, DISCOVERY_FAILED].map(discoveryRunJson))
      .toEqual(goldens.discovery.runJson);
  });
  it("has-candidates / trigger label / constraint lines match legacy", () => {
    expect([DISCOVERY_VIEWED_PARTIAL, DISCOVERY_NOVIEW, DISCOVERY_FAILED].map(discoveryRunHasCandidates))
      .toEqual(goldens.discovery.hasCandidates);
    expect([DISCOVERY_VIEWED_PARTIAL, DISCOVERY_NOVIEW, DISCOVERY_FAILED].map(discoveryTriggerLabel))
      .toEqual(goldens.discovery.triggerLabels);
    expect((DISCOVERY_NOVIEW.constraintSets ?? []).map(formatConstraintSetLine))
      .toEqual(goldens.discovery.constraintLines);
  });
  it("filenames match the legacy scheme incl. the invalid-timestamp fallback", () => {
    const actual = [DISCOVERY_VIEWED_PARTIAL, DISCOVERY_NOVIEW, DISCOVERY_FAILED].map((run) => ({
      candidatesCsv: discoveryExportFilename(run, "candidates-csv"),
      runJson: discoveryExportFilename(run, "run-json"),
    }));
    expect(actual).toEqual(goldens.discovery.filenames);
  });
});

describe("options XLS exports (#1065 golden equivalence)", () => {
  it("raw LLM-input workbook bytes are identical (plain + grouped)", async () => {
    for (const [name, input] of [["rawPlain", XLS_RAW_PLAIN], ["rawGrouped", XLS_RAW_GROUPED]] as const) {
      const bytes = await createRawOptionsIdeasXls(input);
      expect({ sha256: sha256(bytes), length: bytes.length }).toEqual(goldens.xls[name]);
    }
  });
  it("report workbook bytes are identical (full + minimal)", async () => {
    for (const [name, input] of [["report", XLS_REPORT], ["reportMinimal", XLS_REPORT_MINIMAL]] as const) {
      const bytes = await createOptionsIdeasReportXls(input);
      expect({ sha256: sha256(bytes), length: bytes.length }).toEqual(goldens.xls[name]);
    }
  });
  it("retrieved-data workbook bytes are identical", async () => {
    const bytes = await createRetrievedOptionsDataXls(XLS_RETRIEVED);
    expect({ sha256: sha256(bytes), length: bytes.length }).toEqual(goldens.xls.retrieved);
  });
  it("the .xls download filename keeps the legacy <prefix>_<YYYY-MM-DD>.xls scheme", () => {
    // Legacy downloadXls: `${prefix}_${new Date().toISOString().slice(0, 10)}.xls`.
    expect(datedXlsFilename("nvda_llm_options_input", new Date("2026-10-22T15:04:05.000Z")))
      .toBe("nvda_llm_options_input_2026-10-22.xls");
    expect(datedXlsFilename("spy_etrade_options_raw", new Date("2026-01-05T23:59:59.000Z")))
      .toBe("spy_etrade_options_raw_2026-01-05.xls");
  });
});

describe("column-map registry (#1065)", () => {
  const headerRowOf = (csv: string) =>
    csv.split("\r\n").find((line) => line.length > 0 && !line.startsWith("#"));
  it("every CSV kind's column map reproduces the legacy header row, in order", () => {
    expect(EXPORT_COLUMN_MAPS["screen-standouts"].map((c) => c.header).join(","))
      .toBe(headerRowOf(goldens.screen.standoutsCsv[0]));
    expect(EXPORT_COLUMN_MAPS["screen-all-stocks"].map((c) => c.header).join(","))
      .toBe(headerRowOf(goldens.screen.allStocksCsv[0]));
    expect(EXPORT_COLUMN_MAPS["scan-results"].map((c) => c.header).join(","))
      .toBe(headerRowOf(goldens.scan.resultsCsv[0]));
    expect(EXPORT_COLUMN_MAPS["discovery-candidates"].map((c) => c.header).join(","))
      .toBe(headerRowOf(goldens.discovery.candidatesCsv[0]));
    expect(EXPORT_COLUMN_MAPS["discovery-noview-candidates"].map((c) => c.header).join(","))
      .toBe(headerRowOf(goldens.discovery.candidatesCsv[1]));
  });
});

// ------------------------------------------------------------ source pins ---

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const srcFiles = walk(join(ROOT, "src")).filter((f) => /\.tsx?$/.test(f));
const readSrc = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("one exporter (#1065 source pins)", () => {
  it("the five legacy exporter modules (and the optionsIdeasExport shim) are gone", () => {
    for (const rel of [
      "src/client/screenerExport.ts",
      "src/client/scannerExport.ts",
      "src/client/discoveryExport.ts",
      "src/client/options/optionsIdeasExport.ts",
      "src/client/optionsIdeasExport.ts",
    ]) {
      expect(existsSync(join(ROOT, rel)), rel).toBe(false);
    }
  });

  it("no source file imports a legacy exporter path", () => {
    const legacySpecifier =
      /from\s+"[^"]*(?:screenerExport|scannerExport|discoveryExport|optionsIdeasExport)"/;
    const offenders = srcFiles.filter((f) => legacySpecifier.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("every export call site imports the shared module", () => {
    expect(readSrc("src/client/ScreenerResultsView.tsx")).toContain('from "./runExport"');
    expect(readSrc("src/client/ScannerPanel.tsx")).toContain('from "./runExport"');
    expect(readSrc("src/client/options/DiscoveryRunsPanel.tsx")).toContain('from "../runExport"');
    expect(readSrc("src/client/options/LlmOptionsIdeasPanel.tsx")).toContain('from "../runExport"');
    expect(readSrc("src/client/options/LlmStrategyEvalModal.tsx")).toContain('from "../runExport"');
    // C2 (#1246): optionsDataExporter.tsx is deleted — its functions
    // live in runExport.ts itself, and its dropdown component imports
    // them from the shared module.
    expect(readSrc("src/client/options/OptionsDataDownloadDropdown.tsx")).toContain('from "../runExport"');
  });

  it("the shared module is the only exporter creating blob URLs", () => {
    // Pre-existing non-exporter downloads keep their own blob URLs:
    // AsyncJobResultViewer (a job's result JSON — #3605 extracted the
    // download out of AsyncJobsPanel into the shared viewer) and
    // ResearchReportActions (a server-generated workbook). Every EXPORT
    // blob URL — text or .xls — is created by runExport's download
    // helpers only.
    const creators = srcFiles
      .filter((f) => readFileSync(f, "utf8").includes("URL.createObjectURL"))
      .map((f) => relative(ROOT, f).replace(/\\/g, "/"))
      .sort();
    expect(creators).toEqual([
      "src/client/AsyncJobResultViewer.tsx",
      "src/client/ResearchReportActions.tsx",
      "src/client/runExport.ts",
    ]);
  });
});
