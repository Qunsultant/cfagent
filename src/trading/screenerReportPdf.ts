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

import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { ScreenerRunResult } from "../agents/screener-agent";
import {
  SCREENER_PDF_COLUMNS,
  buildScreenerPdfSections,
  projectFormulaAppendixRows,
  wrapCellText,
  type ScreenerPdfColumn,
  DEFAULT_SCREENER_PDF_SECTION_CONFIG,
  type ScreenerPdfSection,
  type ScreenerPdfSectionConfig,
} from "./screenerReportTemplate";
import { SCREENER_FORMULA_DOCUMENTATION } from "./screenerReportXlsx";

/** Print palette (#473): PDFs render on white paper, so the report uses
 *  this named print scale — the print mirrors of the semantic text/status
 *  roles — instead of scattered rgb literals. pdf-lib 0..1 RGB triples. */
const PRINT_INK: [number, number, number] = [0.15, 0.15, 0.15];
const PRINT_LABEL: [number, number, number] = [0.35, 0.35, 0.35];
const PRINT_MUTED: [number, number, number] = [0.4, 0.4, 0.4];
const PRINT_NOTE: [number, number, number] = [0.45, 0.45, 0.45];
const PRINT_FAINT: [number, number, number] = [0.5, 0.5, 0.5];
const PRINT_HAIRLINE: [number, number, number] = [0.7, 0.7, 0.7];
const PRINT_DANGER: [number, number, number] = [0.8, 0.2, 0.2];
const PRINT_WARNING: [number, number, number] = [0.75, 0.45, 0];

const MARGIN = 36;
const PAGE_W = 792; // Letter landscape (#2088: entire document, no mixing)
const PAGE_H = 612;

export interface ScreenerPdfOptions {
  sections?: ScreenerPdfSectionConfig;
}

interface Ctx {
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  page: PDFPage;
  y: number;
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.y = PAGE_H - MARGIN;
}

function ensureSpace(ctx: Ctx, needed: number): void {
  if (ctx.y - needed < MARGIN) newPage(ctx);
}

function cleanForPdf(str: string): string {
  return String(str ?? "")
    .replace(/Δ/g, "Delta ")
    .replace(/▲/g, "+")
    .replace(/▼/g, "-")
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/•/g, "*")
    .replace(/—/g, "-")
    .replace(/–/g, "-")
    .replace(/“|”/g, '"')
    .replace(/‘|’/g, "'")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, " ");
}

function text(
  ctx: Ctx,
  rawStr: string,
  opts: { size?: number; bold?: boolean; color?: [number, number, number]; x?: number } = {}
): void {
  const str = cleanForPdf(rawStr);
  const size = opts.size ?? 10;
  const font = opts.bold ? ctx.bold : ctx.font;
  const c = opts.color ?? PRINT_INK;
  const x = opts.x ?? MARGIN;
  const maxWidth = PAGE_W - MARGIN - x;
  const words = str.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  for (const renderedLine of lines) {
    ensureSpace(ctx, size + 4);
    ctx.page.drawText(renderedLine, {
      x,
      y: ctx.y,
      size,
      font,
      color: rgb(c[0], c[1], c[2]),
    });
    ctx.y -= size + 4;
  }
}

function rule(ctx: Ctx): void {
  ensureSpace(ctx, 10);
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_W - MARGIN, y: ctx.y },
    thickness: 0.75,
    color: rgb(...PRINT_HAIRLINE),
  });
  ctx.y -= 10;
}

function renderTableHeader(ctx: Ctx, cols: ScreenerPdfColumn[]): void {
  ensureSpace(ctx, 16);
  let x = MARGIN;
  for (const col of cols) {
    ctx.page.drawText(col.header, { x, y: ctx.y, size: 8, font: ctx.bold, color: rgb(...PRINT_LABEL) });
    x += col.w;
  }
  ctx.y -= 10;
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_W - MARGIN, y: ctx.y },
    thickness: 0.5,
    color: rgb(...PRINT_HAIRLINE),
  });
  ctx.y -= 6;
}

/**
 * One section table: header repeats on every page break, cells wrap
 * to their column width (never sliced). Section titles carry
 * "showing X of Y" so a limit is visible, not silent (#2088).
 */
function renderSectionTable(
  ctx: Ctx,
  section: Pick<ScreenerPdfSection, "title" | "rows" | "shown" | "total">,
  cols: ScreenerPdfColumn[]
): void {
  if (section.rows.length === 0) return;
  text(ctx, `${section.title} (showing ${section.shown} of ${section.total})`, { size: 12, bold: true });
  renderTableHeader(ctx, cols);
  const measure = (t: string): number => ctx.font.widthOfTextAtSize(t, 8);
  for (const row of section.rows) {
    const wrapped = row.map((cell, i) => wrapCellText(cell, cols[i].w - 4, measure));
    const lineCount = Math.max(...wrapped.map((w) => w.length));
    const rowHeight = lineCount * 10 + 2;
    const pageBefore = ctx.page;
    ensureSpace(ctx, rowHeight);
    if (ctx.page !== pageBefore) renderTableHeader(ctx, cols);
    let x = MARGIN;
    for (let i = 0; i < row.length; i++) {
      for (let li = 0; li < wrapped[i].length; li++) {
        ctx.page.drawText(cleanForPdf(wrapped[i][li]), {
          x,
          y: ctx.y - li * 10,
          size: 8,
          font: ctx.font,
          color: rgb(...PRINT_INK),
        });
      }
      x += cols[i].w;
    }
    ctx.y -= rowHeight;
  }
  rule(ctx);
}

/** Human timestamp (#2088): "Oct 28, 2026, 03:50 EDT (07:50 UTC)". Falls back to the raw ISO. */
export function formatReportTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).formatToParts(date);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
    const utc = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
    return `${get("month")} ${get("day")}, ${get("year")}, ${get("hour")}:${get("minute")} ${get("timeZoneName")} (${utc} UTC)`;
  } catch {
    return iso;
  }
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
   * Issue #1527: whole-run fallback marker. A fallback run's lines
   * name the fallback explicitly — a plain-Yahoo line would hide
   * that the run was configured for another provider, and the
   * E*TRADE line would be false.
   */
  providerFallback?: { from: string; reason: string };
  technicalsCoverage?: { symbols: number; withMacd: number; withGap: number };
}): { quotesLine: string; methodologyQuotes: string; technicalsNote?: string } {
  const yahoo = result.provider === "yahoo";
  const fallback = yahoo && !!result.providerFallback;
  const broker = result.broker === "alpaca" ? "alpaca" : "etrade";
  const brokerLabel = broker === "alpaca" ? "Alpaca" : "E*TRADE";
  // The mode is stated only when the run recorded it: a legacy run that never
  // carried an environment must not acquire one on the way to paper.
  const modeLabel =
    result.environment === "TEST" ? " (paper)" : result.environment === "PROD" ? " (live)" : "";
  const fromLabel =
    result.providerFallback?.from === "etrade"
      ? "E*TRADE"
      : (result.providerFallback?.from ?? "the configured provider");
  const lines: { quotesLine: string; methodologyQuotes: string; technicalsNote?: string } = fallback
    ? {
        quotesLine: `Quotes: Yahoo Finance quotes (delayed) — fallback (${fromLabel} auth unavailable)`,
        methodologyQuotes:
          `Quotes: Yahoo Finance (delayed) — fallback because ${fromLabel} auth was unavailable ` +
          `for this scheduled run; the quote source for this run is Yahoo, not ${fromLabel} live.`,
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
  const ctx: Ctx = { doc, font, bold, page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };

  const prov = screenerProvenanceLines(result);
  const triggerLabel = result.trigger === "manual" ? "Manual Screen" : "Autonomous Screen";

  // Header
  const universeLabel = (result.universe || "TECH").replace(/_/g, " ");
  text(ctx, `Stock Screener Report — ${universeLabel}`, { size: 16, bold: true });
  const sectorSegment = result.sector && result.sector !== "ALL" ? `  •  ${result.sector} sector` : "  •  All Sectors";
  text(ctx, `${triggerLabel}${sectorSegment}`, { size: 10, color: PRINT_MUTED });
  text(ctx, `Generated: ${formatReportTimestamp(result.timestamp)}`, { size: 9, color: PRINT_MUTED });

  // Active Screening Criteria
  ensureSpace(ctx, 16);
  const activeCriteria = result.filterSummary || "Default criteria (Positive Day Change, Momentum Score >= 60, Quant Buy/Strong Buy)";
  text(ctx, `Active Criteria: ${activeCriteria}`, { size: 9, bold: true, color: PRINT_INK });
  rule(ctx);

  if (!result.success) {
    text(ctx, "Screen failed", { size: 13, bold: true, color: PRINT_DANGER });
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
  if (result.discoveryMessage) text(ctx, result.discoveryMessage, { size: 8, color: PRINT_MUTED });
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
    text(ctx, `Rejections Breakdown: ${breakdown}`, { size: 8, color: PRINT_NOTE });
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

  text(ctx, `${prov.quotesLine}  |  Technicals (RSI, MACD, Gap%): Yahoo Finance daily history`, { size: 8, color: PRINT_MUTED });
  ctx.y -= 4;

  renderSectionTable(ctx, gapUp, SCREENER_PDF_COLUMNS);
  renderSectionTable(ctx, gapDown, SCREENER_PDF_COLUMNS);
  if (standouts.rows.length === 0) {
    text(ctx, "Standout Opportunities", { size: 12, bold: true });
    text(ctx, "No standout opportunities met all criteria in this run.", { size: 9, color: PRINT_MUTED });
    rule(ctx);
  } else {
    renderSectionTable(ctx, standouts, SCREENER_PDF_COLUMNS);
  }
  renderSectionTable(ctx, allSymbols, SCREENER_PDF_COLUMNS);

  // Formulas & Methodology appendix (#2088): the XLSX tab-2 content,
  // as-is (including the #1942 provenance defect until #1942 lands).
  const appendixCols: ScreenerPdfColumn[] = [
    { header: "Column Name", w: 110 },
    { header: "Field Key", w: 110 },
    { header: "Data Source / Provenance", w: 180 },
    { header: "Calculation Formula", w: 180 },
    { header: "Description & Interpretation", w: 140 },
  ];
  renderSectionTable(
    ctx,
    {
      title: "Formulas & Methodology",
      rows: projectFormulaAppendixRows(SCREENER_FORMULA_DOCUMENTATION as any),
      shown: SCREENER_FORMULA_DOCUMENTATION.length,
      total: SCREENER_FORMULA_DOCUMENTATION.length,
    },
    appendixCols
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
  for (const n of notes) text(ctx, `* ${n}`, { size: 7.5, color: PRINT_NOTE });

  // Page numbers across all pages
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(`Page ${i + 1} of ${pages.length}`, {
      x: PAGE_W - MARGIN - 60,
      y: 20,
      size: 8,
      font,
      color: rgb(...PRINT_FAINT),
    });
  });

  return doc.save();
}

export function screenerPdfFileName(result: ScreenerRunResult): string {
  // Issue #297: Include full timestamp (not just date) to ensure uniqueness.
  // Format: market-screen_{universe}_hourly-{mm}_{timestamp}_{jobId}.pdf
  // The schedule and jobId are appended by the caller when available.
  const ts = new Date(result.timestamp).toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  const u = (result.universe || "NASDAQ100").toLowerCase().replace(/_/g, "-");
  const schedule = (result as any).schedule || result.trigger;
  const jobId = (result as any).jobId || "adhoc";
  return `market-screen_${u}_${schedule}_${ts}_${jobId}.pdf`;
}
