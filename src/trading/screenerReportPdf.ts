/**
 * Screener PDF reports (issue #269; template + landscape #2088).
 *
 * Generates a screening report PDF with pdf-lib (pure JS, Workers-compatible —
 * no headless browser). Used by:
 *   - the scheduled tick → Slack file upload + email attachment
 *   - the manual run → downloadable via GET /api/screener/report.pdf
 *
 * Issue #2088: the whole document is Letter landscape (792 x 612,
 * 720pt content width) — no mixed orientations. Every section is
 * one table from the template module
 * (src/trading/screenerReportTemplate.ts): the 16 XLSX/CSV columns,
 * one sort (screenScore desc, symbol asc), sections as filter +
 * limit. Cells wrap; they are never silently sliced.
 */

import { PDFDocument, StandardFonts } from "pdf-lib";
import type { ScreenerRunResult } from "../agents/screener-agent";
import { yahooDataModeLabel } from "../config/yahooDataMode";
import { defaultUniverseId } from "../config/defaultUniverse";
import { formatReportTimestamp } from "../services/reportTimestamp";
import {
  SCREENER_PDF_COLUMNS,
  buildScreenerPdfSections,
  projectFormulaAppendixRows,
  type ScreenerPdfColumn,
  DEFAULT_SCREENER_PDF_SECTION_CONFIG,
  type ScreenerPdfSection,
  type ScreenerPdfSectionConfig,
} from "./screenerReportTemplate";
import { SCREENER_FORMULA_DOCUMENTATION } from "./screenerReportXlsx";
import {
  PDF_PRINT_DANGER,
  PDF_PRINT_INK,
  PDF_PRINT_MUTED,
  PDF_PRINT_NOTE,
  addPageNumbers,
  createPdfCtx,
  ensureSpace,
  renderTable,
  rule,
  text,
} from "./pdfDrawing";

/** Re-exported for the existing importers and the #2088 timestamp pin. */
export { formatReportTimestamp };

/** Screener-specific print colour: the partial-screen warning.
 *  The shared base print scale lives in the drawing layer
 *  (src/trading/pdfDrawing.ts). */
const PRINT_WARNING: [number, number, number] = [0.75, 0.45, 0];

export interface ScreenerPdfOptions {
  sections?: ScreenerPdfSectionConfig;
}

/** Section titles carry "showing X of Y" so a limit is visible, not
 *  silent (#2088). The table itself is the shared drawing layer's
 *  renderTable. */
function sectionTitle(section: Pick<ScreenerPdfSection, "title" | "shown" | "total">): string {
  return `${section.title} (showing ${section.shown} of ${section.total})`;
}

/**
 * Issue #1278 (#1173 R5): provider-truthful provenance lines. The
 * pre-R5 report hardcoded "E*TRADE live snapshots" — and "No fallback
 * data substituted" — even on Yahoo runs, where both claims were false
 * (the manual NASDAQ100 incident report of 2026-10-23). The lines are
 * built from the run's recorded provider; legacy stored runs without
 * a provider keep the E*TRADE wording (they predate provider tagging).
 * Partial technicals coverage (R2's technicalsCoverage) is stated
 * explicitly so blank MACD/Gap columns are explained on the artifact.
 */
export function screenerProvenanceLines(result: {
  provider?: string;
  /**
   * Issue #3331: the broker that produced the run. A non-Yahoo run's quotes
   * are that broker's; with the field absent the legacy E*TRADE wording stands,
   * because that is what produced it. The artifact never names a broker the run
   * did not use.
   */
  broker?: "etrade" | "alpaca" | "public"; // Issue #3990
  /** Issue #3331: the environment the run traded in (TEST = paper). Absent on
   *  legacy runs; the artifact then states the broker without a mode. */
  environment?: "TEST" | "PROD";
  /**
   * Issue #4436: the run's explicit data mode, when one
   * applies. A mode run's lines name the mode explicitly — a
   * plain-provider line would hide that the run ran the full dataset
   * as a test, and a broker line would be false.
   */
  yahooDataMode?: import("../workflows/stockScreenPlanner").YahooDataMode;
  technicalsCoverage?: { symbols: number; withMacd: number; withGap: number };
}): { quotesLine: string; methodologyQuotes: string; technicalsNote?: string } {
  const yahoo = result.provider === "yahoo";
  const mode = result.yahooDataMode;
  // Issue #5516: a run with no recorded broker predates provenance — the
  // stored-value legacy reading is kept deliberately (pinned by
  // tests/run_defaults_5516.test.ts), not re-defaulted to the new broker.
  const broker = result.broker === "alpaca" ? "alpaca" : "etrade";
  const brokerLabel = broker === "alpaca" ? "Alpaca" : "E*TRADE";
  // The mode is stated only when the run recorded it: a legacy run that never
  // carried an environment must not acquire one on the way to paper.
  const modeLabel =
    result.environment === "TEST" ? " (paper)" : result.environment === "PROD" ? " (live)" : "";
  const lines: { quotesLine: string; methodologyQuotes: string; technicalsNote?: string } =
    mode === "full-dataset" && yahoo
      ? {
          quotesLine: `Quotes: ${yahooDataModeLabel("full-dataset")}`,
          methodologyQuotes:
            "Quotes: Yahoo Finance (delayed) — full-dataset testing mode (stocks only); " +
            "the quote source for this run is Yahoo.",
        }
      : mode === "gap-fill"
        ? {
            quotesLine: `Quotes: ${brokerLabel} live snapshots${modeLabel} — Yahoo gap-fill (delayed) for missing quotes`,
            methodologyQuotes:
              `Quotes: ${brokerLabel} live snapshots${modeLabel} (primary) — Yahoo Finance gap-fill ` +
              `(delayed) filled gaps the primary missed; filled rows carry delayed quotes, not ${brokerLabel} live.`,
          }
        : yahoo
          ? {
              quotesLine: "Quotes: Yahoo Finance quotes (delayed)",
              methodologyQuotes:
                "Quotes: Yahoo Finance (delayed) — the quote source for this run.",
            }
          : {
              // Issue #3331: the broker the run recorded, not a hardcoded one.
              quotesLine: `Quotes: ${brokerLabel} live snapshots${modeLabel}`,
              methodologyQuotes: `Quotes: ${brokerLabel} live snapshots${modeLabel} (primary). No fallback data substituted.`,
            };
  const cov = result.technicalsCoverage;
  if (cov && cov.symbols > 0 && (cov.withMacd < cov.symbols || cov.withGap < cov.symbols)) {
    lines.technicalsNote =
      `Technicals coverage: MACD available for ${cov.withMacd} of ${cov.symbols} symbols, ` +
      `Gap% for ${cov.withGap} of ${cov.symbols}; blanks mean daily history was unavailable for that symbol.`;
  }
  return lines;
}

export async function generateScreenerPdf(
  result: ScreenerRunResult,
  options?: ScreenerPdfOptions
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx = createPdfCtx(doc, font, bold);

  const prov = screenerProvenanceLines(result);
  const triggerLabel = result.trigger === "manual" ? "Manual Screen" : "Autonomous Screen";

  // Header
  const universeLabel = (result.universe || defaultUniverseId()).replace(/_/g, " ");
  text(ctx, `Stock Screener Report — ${universeLabel}`, { size: 16, bold: true });
  const sectorSegment = result.sector && result.sector !== "ALL" ? `  •  ${result.sector} sector` : "  •  All Sectors";
  text(ctx, `${triggerLabel}${sectorSegment}`, { size: 10, color: PDF_PRINT_MUTED });
  text(ctx, `Generated: ${formatReportTimestamp(result.timestamp)}`, { size: 9, color: PDF_PRINT_MUTED });

  // Active Screening Criteria
  ensureSpace(ctx, 16);
  const activeCriteria = result.filterSummary || "Default criteria (Positive Day Change, Momentum Score >= 60, Quant Buy/Strong Buy)";
  text(ctx, `Active Criteria: ${activeCriteria}`, { size: 9, bold: true, color: PDF_PRINT_INK });
  rule(ctx);

  if (!result.success) {
    text(ctx, "Screen failed", { size: 13, bold: true, color: PDF_PRINT_DANGER });
    text(ctx, result.error || "E*TRADE unavailable — no market data.", { size: 10 });
    return doc.save();
  }

  // Partial screen notice
  if (result.partial) {
    const failed = result.partial.failedSymbols;
    const reasonSummary = Object.entries(result.partial.failureReasons)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    text(ctx, "PARTIAL SCREEN — QUALIFIED RESULTS", { size: 12, bold: true, color: PRINT_WARNING });
    text(ctx, `${result.partial.quotedCount} of ${result.partial.requestedCount} symbols quoted; ${failed.length} unavailable (${failed.slice(0, 8).join(", ")}${failed.length > 8 ? ", ..." : ""}).`, { size: 9 });
    if (reasonSummary) text(ctx, `Failure reasons: ${reasonSummary}.`, { size: 9 });
    text(ctx, "Results below cover the quoted subset only; no fallback data substituted.", { size: 9 });
    rule(ctx);
  }

  // Summary
  text(ctx, "Summary", { size: 12, bold: true });
  text(ctx, `Scanned: ${result.totalScanned}   Matched: ${result.matchedCount}   Standout Opportunities: ${result.opportunities.length}`);
  if (result.discoveryMessage) text(ctx, result.discoveryMessage, { size: 8, color: PDF_PRINT_MUTED });
  if (result.rejections && result.rejections.length > 0) {
    const counts: Record<string, number> = {};
    for (const r of result.rejections) {
      const gate = r.reason.split(" (")[0].split(" for ")[0].trim();
      counts[gate] = (counts[gate] || 0) + 1;
    }
    const breakdown = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([g, n]) => `${n} ${g}`)
      .join(", ");
    text(ctx, `Rejections Breakdown: ${breakdown}`, { size: 8, color: PDF_PRINT_NOTE });
  }
  rule(ctx);

  // Sections (#2088): one template, one sort, filter + limit each.
  const sections = buildScreenerPdfSections(
    result as any,
    options?.sections ?? DEFAULT_SCREENER_PDF_SECTION_CONFIG
  );
  const gapUp = sections.find((s) => s.key === "gapUp")!;
  const gapDown = sections.find((s) => s.key === "gapDown")!;
  const standouts = sections.find((s) => s.key === "standouts")!;
  const allSymbols = sections.find((s) => s.key === "allSymbols")!;

  text(ctx, `${prov.quotesLine}  |  Technicals (RSI, MACD, Gap%): Yahoo Finance daily history`, { size: 8, color: PDF_PRINT_MUTED });
  ctx.y -= 4;

  renderTable(ctx, sectionTitle(gapUp), SCREENER_PDF_COLUMNS, gapUp.rows);
  renderTable(ctx, sectionTitle(gapDown), SCREENER_PDF_COLUMNS, gapDown.rows);
  if (standouts.rows.length === 0) {
    text(ctx, "Standout Opportunities", { size: 12, bold: true });
    text(ctx, "No standout opportunities met all criteria in this run.", { size: 9, color: PDF_PRINT_MUTED });
    rule(ctx);
  } else {
    renderTable(ctx, sectionTitle(standouts), SCREENER_PDF_COLUMNS, standouts.rows);
  }
  renderTable(ctx, sectionTitle(allSymbols), SCREENER_PDF_COLUMNS, allSymbols.rows);

  // Formulas & Methodology appendix (#2088): the XLSX tab-2 content,
  // as-is (including the #1942 provenance defect until #1942 lands).
  const appendixCols: ScreenerPdfColumn[] = [
    { header: "Column Name", w: 110 },
    { header: "Field Key", w: 110 },
    { header: "Data Source / Provenance", w: 180 },
    { header: "Calculation Formula", w: 180 },
    { header: "Description & Interpretation", w: 140 },
  ];
  renderTable(
    ctx,
    sectionTitle({
      title: "Formulas & Methodology",
      shown: SCREENER_FORMULA_DOCUMENTATION.length,
      total: SCREENER_FORMULA_DOCUMENTATION.length,
    }),
    appendixCols,
    projectFormulaAppendixRows(SCREENER_FORMULA_DOCUMENTATION as any)
  );

  // Methodology footer
  ensureSpace(ctx, 60);
  text(ctx, "Methodology", { size: 10, bold: true });
  const notes = [
    prov.methodologyQuotes,
    ...(prov.technicalsNote ? [prov.technicalsNote] : []),
    "RSI(14), MACD(12,26,9), gaps: Yahoo Finance daily history (complement).",
    "Factor grades (Value/Momentum A+..F): percentile-relative within this run's universe.",
    "Sentiment: day-action based (very bearish -> very bullish). Range zones are 52-week based, not RSI.",
    "Score: composite 0-100 of day momentum, intraday position, 52-week position, and value zone (screenScore); it does not include RSI, MACD, gap, or factor grades.",
  ];
  for (const n of notes) text(ctx, `* ${n}`, { size: 7.5, color: PDF_PRINT_NOTE });

  // Page numbers across all pages
  addPageNumbers(doc, font);

  return doc.save();
}

export function screenerPdfFileName(result: ScreenerRunResult): string {
  // Issue #297: Include full timestamp (not just date) to ensure uniqueness.
  // Format: market-screen_{universe}_hourly-{mm}_{timestamp}_{jobId}.pdf
  // The schedule and jobId are appended by the caller when available.
  const ts = new Date(result.timestamp).toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  const u = (result.universe || defaultUniverseId()).toLowerCase().replace(/_/g, "-");
  const schedule = (result as any).schedule || result.trigger;
  const jobId = (result as any).jobId || "adhoc";
  return `market-screen_${u}_${schedule}_${ts}_${jobId}.pdf`;
}
