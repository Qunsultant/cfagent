/**
 * Opportunity Hunt PDF reports (issue 6403).
 *
 * Generates the hunt's downloadable report as a coloured PDF with
 * pdf-lib (pure JS, Workers-compatible — no headless browser).
 * It renders the SAME output the panel shows (issue 6406's
 * report-style view, comment 7119279626): the one-row-per-symbol
 * table, entry and exit signals grouped per entry and per exit with
 * their price ranges, and a price chart carrying the recommendation
 * levels. The grouping and formatting are the panel's own helpers
 * (`groupHuntSetupsBySymbol`, `formatHuntPrice`, `formatHuntPct`
 * from `../client/opportunityHuntView`) — the PDF groups and formats
 * exactly as the panel does, so the two cannot drift apart.
 *
 * Charts: the panel's on-screen chart is lightweight-charts, which
 * renders to a browser canvas and cannot render into a PDF. The PDF
 * draws its charts natively in pdf-lib as vector graphics — bar
 * charts for the per-strategy breakdown and the per-symbol
 * pattern-count chart, and a polyline with horizontal level lines
 * for each symbol's price chart — from the same data the panel
 * charts (the trailing closes in `seriesBySymbol` and the levels
 * in `src/config/opportunityHuntLevels.ts`). Same data, vector-drawn,
 * so panel and report match.
 *
 * Used by the report pipeline (`runReportPipeline`, type
 * "opportunity-hunt") through the ReportAssetAgent, and downloaded
 * via GET /api/opportunity-hunt/report.pdf.
 *
 * Layout follows the screener PDF (issue 269, template + landscape
 * 2088): Letter landscape (792 x 612, 720pt content width), one
 * table per section, cells wrap and are never silently sliced.
 */

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { OpportunityHuntResult } from "../services/opportunityHunt";
import {
  buildOpportunityHuntReportModel,
  type OpportunityHuntReportModel,
} from "../client/opportunityHuntReportModel";
import { formatHuntPrice } from "../client/opportunityHuntView";
import { cleanForPdf } from "./pdfText";
import {
  PDF_CONTENT_W,
  PDF_MARGIN,
  PDF_PRINT_DANGER,
  PDF_PRINT_HAIRLINE,
  PDF_PRINT_INK,
  PDF_PRINT_MUTED,
  PDF_PRINT_NOTE,
  addPageNumbers,
  createPdfCtx,
  ensureSpace,
  renderTable,
  rule,
  text,
  type PdfCtx,
  type PdfTableColumn,
} from "./pdfDrawing";

/** Hunt-specific print colours: entry green / exit red mirror the
 *  panel's success / danger Badge tones, and the bar / level colours
 *  match the panel's chart. The shared base print scale lives in
 *  the drawing layer (src/trading/pdfDrawing.ts). pdf-lib 0..1 RGB
 *  triples. */
const PRINT_SUCCESS: [number, number, number] = [0.15, 0.55, 0.25];
const PRINT_ENTRY_BAR: [number, number, number] = [0.2, 0.6, 0.3];
const PRINT_EXIT_BAR: [number, number, number] = [0.85, 0.25, 0.25];
const PRINT_COUNT_BAR: [number, number, number] = [0.25, 0.45, 0.75];
const PRINT_LINE: [number, number, number] = [0.2, 0.4, 0.7];
const PRINT_LEVEL_ENTRY: [number, number, number] = [0.2, 0.6, 0.3];
const PRINT_LEVEL_STOP: [number, number, number] = [0.85, 0.25, 0.25];
const PRINT_LEVEL_TAKE: [number, number, number] = [0.15, 0.55, 0.25];
const PRINT_LEVEL_BASIS: [number, number, number] = [0.45, 0.35, 0.65];


interface BarEntry {
  label: string;
  value: number;
  color: [number, number, number];
}

/**
 * A horizontal bar chart, drawn as vector rectangles. `maxValue`
 * scales the bars; a zero max draws no bars (empty chart), never a
 * division by zero. The label column is fixed width; the value is
 * printed at the bar's end.
 */
function renderBarChart(
  ctx: PdfCtx,
  title: string,
  bars: BarEntry[],
  opts: { labelWidth?: number; maxValue?: number } = {},
): void {
  if (bars.length === 0) return;
  const labelW = opts.labelWidth ?? 140;
  const valueW = 48;
  const barAreaW = PDF_CONTENT_W - labelW - valueW - 8;
  const maxValue = opts.maxValue ?? Math.max(...bars.map((b) => b.value), 0);
  const barH = 11;
  const gap = 4;
  // Issue #6473 — the heading must not be orphaned. Reserve the title plus the
  // first few bars BEFORE drawing anything, so a page never ends on a heading;
  // a chart longer than the page re-draws its title on each continuation page
  // (the per-bar check below), which is why only the head of the block is
  // reserved here rather than the whole chart.
  ensureSpace(ctx, 18 + Math.min(bars.length, CHART_HEAD_BARS) * (barH + gap));
  text(ctx, title, { size: 12, bold: true });
  for (const bar of bars) {
    const pageBefore = ctx.page;
    ensureSpace(ctx, barH + gap);
    if (ctx.page !== pageBefore) {
      text(ctx, title, { size: 12, bold: true });
    }
    const yTop = ctx.y;
    ctx.page.drawText(cleanForPdf(bar.label), {
      x: PDF_MARGIN,
      y: yTop - 2,
      size: 8,
      font: ctx.font,
      color: rgb(...PDF_PRINT_INK),
    });
    const barW = maxValue > 0 ? Math.max(1, (bar.value / maxValue) * barAreaW) : 0;
    if (barW > 0) {
      ctx.page.drawRectangle({
        x: PDF_MARGIN + labelW,
        y: yTop - barH + 2,
        width: barW,
        height: barH - 2,
        color: rgb(...bar.color),
      });
    }
    ctx.page.drawText(String(bar.value), {
      x: PDF_MARGIN + labelW + barAreaW + 8,
      y: yTop - 2,
      size: 8,
      font: ctx.bold,
      color: rgb(...PDF_PRINT_INK),
    });
    ctx.y -= barH + gap;
  }
  ctx.y -= 4;
  rule(ctx);
}

/** Bars the heading reserves under itself, so it is never the last thing on a page. */
const CHART_HEAD_BARS = 4;

/**
 * Issue #6473 — place one label per level so no two overlap, inside the chart
 * box. Inputs are the levels' y positions (ascending or not); the result is one
 * label y per level, each at least MIN_LABEL_GAP from every other, clamped to
 * [yBottom + 2, yTop - 10]. A level with room keeps its own line; a crowded one
 * is nudged up, then down, until it fits — never dropped, so no level goes
 * unlabelled.
 */
export function levelLabelYs(levelYs: readonly number[], yBottom: number, yTop: number): number[] {
  const MIN_LABEL_GAP = 9;
  const low = yBottom + 2;
  const high = yTop - 10;
  const placed: number[] = [];
  return levelYs.map((ly) => {
    const preferred = Math.min(Math.max(ly + 2, low), high);
    let candidate = preferred;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!placed.some((y) => Math.abs(y - candidate) < MIN_LABEL_GAP)) break;
      const up = candidate + MIN_LABEL_GAP;
      candidate = up <= high ? up : Math.max(low, candidate - MIN_LABEL_GAP);
    }
    placed.push(candidate);
    return candidate;
  });
}

interface PriceLevel {
  value: number;
  label: string;
  color: [number, number, number];
}

/**
 * A compact price chart: the trailing closes as a polyline, with
 * horizontal level lines for the recommendation levels. Drawn in a
 * bounded box with a hairline border. Levels outside the closes'
 * range widen the range so the lines stay visible. A series with
 * fewer than two closes draws nothing (no chart to draw).
 */
function renderPriceChart(
  ctx: PdfCtx,
  closes: readonly number[],
  levels: PriceLevel[],
  width: number,
  height: number,
): void {
  if (closes.length < 2) return;
  ensureSpace(ctx, height + 18);
  const x0 = PDF_MARGIN;
  const yTop = ctx.y;
  const yBottom = yTop - height;
  const values = [...closes, ...levels.map((l) => l.value)];
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max === min) {
    max = min + 1;
    min = min - 1;
  }
  const pad = (max - min) * 0.05;
  min -= pad;
  max += pad;
  const px = (i: number): number =>
    x0 + (i / (closes.length - 1)) * width;
  const py = (v: number): number =>
    yBottom + ((v - min) / (max - min)) * height;
  // Border.
  ctx.page.drawRectangle({
    x: x0,
    y: yBottom,
    width,
    height,
    borderColor: rgb(...PDF_PRINT_HAIRLINE),
    borderWidth: 0.5,
  });
  // Level lines (behind the price line). Labels are staggered by the helper
  // below: entry and exit levels can sit within a few points of one another,
  // and stacked labels were unreadable (issue #6473).
  const labelYs = levelLabelYs(
    levels.map((level) => py(level.value)),
    yBottom,
    yTop,
  );
  for (const [index, level] of levels.entries()) {
    const ly = py(level.value);
    ctx.page.drawLine({
      start: { x: x0, y: ly },
      end: { x: x0 + width, y: ly },
      thickness: 0.75,
      color: rgb(...level.color),
    });
    ctx.page.drawText(cleanForPdf(level.label), {
      x: x0 + 4,
      y: labelYs[index],
      size: 7,
      font: ctx.bold,
      color: rgb(...level.color),
    });
  }
  // Price polyline.
  for (let i = 0; i < closes.length - 1; i++) {
    ctx.page.drawLine({
      start: { x: px(i), y: py(closes[i]) },
      end: { x: px(i + 1), y: py(closes[i + 1]) },
      thickness: 1,
      color: rgb(...PRINT_LINE),
    });
  }
  ctx.y = yBottom - 14;
}

/** The per-symbol table's columns, in the panel's order. */
const HUNT_TABLE_COLUMNS: PdfTableColumn[] = [
  { header: "Symbol", w: 84 },
  { header: "Patterns", w: 64 },
  { header: "Entries", w: 130 },
  { header: "Exits", w: 130 },
  { header: "Entry range", w: 96 },
  { header: "Stop-loss", w: 72 },
  { header: "Take-profit", w: 72 },
  { header: "Last close", w: 72 },
];

export async function renderOpportunityHuntPdf(
  model: OpportunityHuntReportModel,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx = createPdfCtx(doc, font, bold);

  // Header — every string comes from the shared model (issue 6479), so the
  // page and this PDF cannot word the same report differently.
  text(ctx, model.title, { size: 16, bold: true });
  text(ctx, `As of ${model.asOfLabel}`, { size: 10, color: PDF_PRINT_MUTED });
  text(ctx, model.summary, { size: 10, color: PDF_PRINT_MUTED });
  rule(ctx);

  // Summary
  text(ctx, "Summary", { size: 12, bold: true });
  text(ctx, model.summaryCountsLine, { size: 10 });
  if (model.holdingsHeading) {
    text(ctx, model.holdingsHeading, { size: 9, bold: true, color: PDF_PRINT_NOTE });
  }
  if (model.holdingsNote) {
    text(ctx, model.holdingsNote, { size: 9, color: PDF_PRINT_NOTE });
  }
  // Issue #6473 — "how did N symbols become M setups?" is answered from the
  // run's own counts. The wording lives in the model, not here.
  text(ctx, model.countsHeading, { size: 12, bold: true });
  text(ctx, model.countsExplanation, { size: 10 });
  rule(ctx);

  if (model.noSetupsNote) {
    text(ctx, "No setups", { size: 12, bold: true });
    text(ctx, model.noSetupsNote, { size: 10, color: PDF_PRINT_MUTED });
    rule(ctx);
  }

  // Per-strategy breakdown: entries and exits per strategy.
  if (model.strategyBars.length > 0) {
    const bars: BarEntry[] = model.strategyBars.map((bar) => ({
      label: bar.label,
      value: bar.value,
      color: bar.side === "entry" ? PRINT_ENTRY_BAR : PRINT_EXIT_BAR,
    }));
    renderBarChart(ctx, "Setups by strategy", bars, { labelWidth: 220 });
  }

  // Per-symbol pattern count over the evaluated population (issue 6478). An
  // all-zero chart would be noise, so a run where nothing fired skips it.
  if (model.patternBars.some((bar) => bar.count > 0)) {
    renderBarChart(
      ctx,
      model.patternChartTitle,
      model.patternBars.map((bar) => ({
        label: bar.symbol,
        value: bar.count,
        color: PRINT_COUNT_BAR,
      })),
      { labelWidth: 84 },
    );
  }

  if (model.tableRows.length > 0) {
    renderTable(
      ctx,
      model.tableHeading,
      HUNT_TABLE_COLUMNS,
      model.tableRows.map((row) => [
        row.symbol,
        row.patterns,
        row.entries,
        row.exits,
        row.entryRange,
        row.stopLoss,
        row.takeProfit,
        row.lastClose,
      ]),
    );

    // Per-symbol detail — the model's section text, for every evaluated
    // symbol, with the chart drawn from the section's own series and levels.
    for (const section of model.sections) {
      text(ctx, section.heading, { size: 12, bold: true });
      text(ctx, section.lastCloseLine, { size: 9, color: PDF_PRINT_MUTED });
      if (section.noSetupNote) {
        text(ctx, section.noSetupNote, { size: 9, color: PDF_PRINT_MUTED });
      }
      if (section.entryLines.length > 0) {
        text(ctx, section.entryHeading, { size: 10, bold: true, color: PRINT_SUCCESS });
        for (const line of section.entryLines) {
          text(ctx, line, { size: 9 });
        }
      }
      if (section.exitLines.length > 0) {
        text(ctx, section.exitHeading, { size: 10, bold: true, color: PDF_PRINT_DANGER });
        for (const line of section.exitLines) {
          text(ctx, line, { size: 9 });
        }
      }
      const row = section.row;
      if (section.closes.length >= 2) {
        const levels: PriceLevel[] = [];
        if (row.entryLow !== null) levels.push({ value: row.entryLow, label: `Entry ${formatHuntPrice(row.entryLow)}`, color: PRINT_LEVEL_ENTRY });
        if (row.entryHigh !== null) levels.push({ value: row.entryHigh, label: `Entry ${formatHuntPrice(row.entryHigh)}`, color: PRINT_LEVEL_ENTRY });
        if (row.stopLoss !== null) levels.push({ value: row.stopLoss, label: `Stop ${formatHuntPrice(row.stopLoss)}`, color: PRINT_LEVEL_STOP });
        if (row.takeProfit !== null) levels.push({ value: row.takeProfit, label: `Take-profit ${formatHuntPrice(row.takeProfit)}`, color: PRINT_LEVEL_TAKE });
        const basis = row.exits[0]?.entryPrice;
        if (basis !== undefined && basis !== null) {
          levels.push({ value: basis, label: `Cost basis ${formatHuntPrice(basis)}`, color: PRINT_LEVEL_BASIS });
        }
        renderPriceChart(ctx, section.closes, levels, 420, 84);
      }
      rule(ctx);
    }
  }

  // Methodology footer — the model's wording, shared with the page.
  ensureSpace(ctx, 60);
  text(ctx, "Methodology", { size: 10, bold: true });
  for (const note of model.methodology) {
    text(ctx, `* ${note}`, { size: 7.5, color: PDF_PRINT_NOTE });
  }

  // Page numbers across all pages
  addPageNumbers(doc, font);

  return doc.save();
}

/** Build the one view model, then render it — no content decision here. */
export async function generateOpportunityHuntPdf(
  result: OpportunityHuntResult,
): Promise<Uint8Array> {
  return renderOpportunityHuntPdf(buildOpportunityHuntReportModel(result));
}

export function opportunityHuntPdfFileName(result: OpportunityHuntResult): string {
  // Issue 297 convention: full timestamp (not just date) for uniqueness.
  const ts = new Date(result.asOf).toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  return `opportunity-hunt_${ts}.pdf`;
}
