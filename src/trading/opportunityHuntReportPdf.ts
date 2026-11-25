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
import { huntCountsExplanation } from "../services/opportunityHunt";
import type {
  OpportunityHuntResult,
  OpportunityHuntSetup,
} from "../services/opportunityHunt";
import {
  groupHuntSetupsBySymbol,
  formatHuntPrice,
  formatHuntPct,
  type OpportunityHuntSymbolRow,
} from "../client/opportunityHuntView";
import { cleanForPdf } from "./pdfText";
import { formatReportTimestamp } from "./screenerReportPdf";
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


/** How many symbols the pattern-count chart shows. The table below
 *  lists every symbol; the chart is a visualization, so it shows
 *  the top N by pattern count and says so — never a silent cut. */
const PATTERN_CHART_TOP_N = 20;

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

function entryRangeText(row: OpportunityHuntSymbolRow): string {
  return row.entryLow !== null && row.entryHigh !== null
    ? `${formatHuntPrice(row.entryLow)} – ${formatHuntPrice(row.entryHigh)}`
    : "—";
}

function strategyList(setups: OpportunityHuntSetup[]): string {
  return setups.length > 0
    ? setups.map((s) => s.strategy).join(", ")
    : "—";
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

export async function generateOpportunityHuntPdf(
  result: OpportunityHuntResult,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx = createPdfCtx(doc, font, bold);

  // The panel's own grouping — one row per symbol — so the PDF's
  // table is the panel's table, sorted by the panel's default
  // (symbol ascending).
  const rows = groupHuntSetupsBySymbol(result);
  const entries = result.setups.filter((s) => s.direction === "entry");
  const exits = result.setups.filter((s) => s.direction === "exit");
  // Issue 6478 — "evaluated" and "with setups" are different populations now:
  // every evaluated symbol is a row, and most may carry zero patterns.
  const symbolsWithSetups = rows.filter((row) => row.patternCount > 0).length;

  // Header
  text(ctx, "Opportunity Hunt Report", { size: 16, bold: true });
  text(ctx, `As of ${formatReportTimestamp(result.asOf)}`, { size: 10, color: PDF_PRINT_MUTED });
  text(ctx, result.summary, { size: 10, color: PDF_PRINT_MUTED });
  rule(ctx);

  // Summary
  text(ctx, "Summary", { size: 12, bold: true });
  text(
    ctx,
    `Scanned: ${result.scanned} symbol(s)   Setups: ${result.setups.length}   Entries: ${entries.length}   Exits: ${exits.length}   Symbols evaluated: ${rows.length}   Symbols with setups: ${symbolsWithSetups}${result.skipped > 0 ? `   Skipped (short history): ${result.skipped}` : ""}`,
    { size: 10 },
  );
  if (result.holdingsStatus && !result.holdingsStatus.available) {
    text(
      ctx,
      `Exit signals unavailable — the hunt ran on entries only: the holdings read did not report${result.holdingsStatus.broker ? ` for ${result.holdingsStatus.broker}` : ""}${result.holdingsStatus.reason ? ` — ${result.holdingsStatus.reason}` : ""}. No exit was silently dropped; there was nothing held to evaluate.`,
      { size: 9, color: PDF_PRINT_NOTE },
    );
  } else if (result.holdingsStatus?.available) {
    text(
      ctx,
      `Exits evaluated against holdings from the selected broker${result.holdingsStatus.broker ? ` (${result.holdingsStatus.broker})` : ""}.`,
      { size: 9, color: PDF_PRINT_NOTE },
    );
  }
  // Issue #6473 — "how did N symbols become M setups?" is answerable from the
  // run's own counts, so the report answers it instead of leaving the reader to
  // wonder: a symbol carries one setup per strategy that fired, and exits are
  // counted apart from entries. Computed here, never asserted; rendered for a
  // zero-setup run too, because "0 setups" is still the run's arithmetic.
  text(ctx, "How the counts add up", { size: 12, bold: true });
  text(ctx, huntCountsExplanation(result), { size: 10 });
  rule(ctx);

  if (result.setups.length === 0) {
    text(ctx, "No setups", { size: 12, bold: true });
    text(
      ctx,
      `The latest bar produced no entry or exit signal for any of the ${rows.length} evaluated symbol(s).`,
      { size: 10, color: PDF_PRINT_MUTED },
    );
    rule(ctx);
  } else {
    // Per-strategy breakdown: entries and exits per strategy.
    const strategies = [...new Set(result.setups.map((s) => s.strategy))].sort();
    const strategyBars: BarEntry[] = [];
    for (const strategy of strategies) {
      const e = entries.filter((s) => s.strategy === strategy).length;
      const x = exits.filter((s) => s.strategy === strategy).length;
      if (e > 0) strategyBars.push({ label: `${strategy} — entries`, value: e, color: PRINT_ENTRY_BAR });
      if (x > 0) strategyBars.push({ label: `${strategy} — exits`, value: x, color: PRINT_EXIT_BAR });
    }
    renderBarChart(ctx, "Setups by strategy", strategyBars, { labelWidth: 220 });
  }

  // Per-symbol pattern-count chart: top N by pattern count over the EVALUATED
  // population (issue 6478). All-zero patterns would draw an empty chart, so a
  // run where nothing fired skips the chart instead of drawing 20 zero bars.
  const byPatterns = [...rows].sort(
    (a, b) => b.patternCount - a.patternCount || a.symbol.localeCompare(b.symbol),
  );
  const top = byPatterns.slice(0, PATTERN_CHART_TOP_N);
  if (top.some((row) => row.patternCount > 0)) {
    renderBarChart(
      ctx,
      `Pattern count by symbol (top ${top.length} of ${rows.length} evaluated)`,
      top.map((row) => ({ label: row.symbol, value: row.patternCount, color: PRINT_COUNT_BAR })),
      { labelWidth: 84 },
    );
  }

  if (rows.length > 0) {
    // Main table — the panel's table, one row per EVALUATED symbol.
    renderTable(
      ctx,
      `Symbols evaluated (${rows.length})`,
      HUNT_TABLE_COLUMNS,
      rows.map((row) => [
        row.symbol,
        String(row.patternCount),
        strategyList(row.entries),
        strategyList(row.exits),
        entryRangeText(row),
        formatHuntPrice(row.stopLoss),
        formatHuntPrice(row.takeProfit),
        formatHuntPrice(row.lastClose),
      ]),
    );

    // Per-symbol detail — the panel's detail card, for every evaluated symbol:
    // grouped entry and exit recommendations with their price ranges, and the
    // price chart. A symbol with no setup says so and still carries its chart
    // (issue 6478): the reader sees what was evaluated and found uninteresting.
    for (const row of rows) {
      const hasSetup = row.patternCount > 0;
      text(ctx, `${row.symbol} — ${hasSetup ? "recommendations" : "no setup"}`, { size: 12, bold: true });
      const gainText =
        row.exitGainPct !== null
          ? ` · exits ${formatHuntPct(row.exitGainPct)} vs cost basis`
          : "";
      text(ctx, `Last close ${formatHuntPrice(row.lastClose)}${gainText}.`, { size: 9, color: PDF_PRINT_MUTED });
      if (!hasSetup) {
        text(
          ctx,
          "No setup — this symbol was evaluated and no strategy produced an entry or exit signal.",
          { size: 9, color: PDF_PRINT_MUTED },
        );
      }
      if (row.entries.length > 0) {
        text(ctx, "Entry recommendations", { size: 10, bold: true, color: PRINT_SUCCESS });
        for (const setup of row.entries) {
          const levels = setup.levels
            ? ` — enter ${formatHuntPrice(setup.levels.entryLow)} – ${formatHuntPrice(setup.levels.entryHigh)}, stop-loss ${formatHuntPrice(setup.levels.stopLoss)}, take-profit ${formatHuntPrice(setup.levels.takeProfit)}`
            : "";
          text(ctx, `• ${setup.strategy}: ${setup.detail}${levels}.`, { size: 9 });
        }
      }
      if (row.exits.length > 0) {
        text(ctx, "Exit recommendations", { size: 10, bold: true, color: PDF_PRINT_DANGER });
        for (const setup of row.exits) {
          const gain =
            setup.entryPrice
              ? ` (${formatHuntPct((setup.lastClose - setup.entryPrice) / setup.entryPrice)})`
              : "";
          text(
            ctx,
            `• ${setup.strategy}: ${setup.detail} — exit at ${formatHuntPrice(setup.lastClose)}, entered at ${formatHuntPrice(setup.entryPrice)}${gain}.`,
            { size: 9 },
          );
        }
      }
      const closes = row.closes ?? result.seriesBySymbol?.[row.symbol] ?? [];
      if (closes.length >= 2) {
        const levels: PriceLevel[] = [];
        if (row.entryLow !== null) levels.push({ value: row.entryLow, label: `Entry ${formatHuntPrice(row.entryLow)}`, color: PRINT_LEVEL_ENTRY });
        if (row.entryHigh !== null) levels.push({ value: row.entryHigh, label: `Entry ${formatHuntPrice(row.entryHigh)}`, color: PRINT_LEVEL_ENTRY });
        if (row.stopLoss !== null) levels.push({ value: row.stopLoss, label: `Stop ${formatHuntPrice(row.stopLoss)}`, color: PRINT_LEVEL_STOP });
        if (row.takeProfit !== null) levels.push({ value: row.takeProfit, label: `Take-profit ${formatHuntPrice(row.takeProfit)}`, color: PRINT_LEVEL_TAKE });
        const basis = row.exits[0]?.entryPrice;
        if (basis !== undefined && basis !== null) {
          levels.push({ value: basis, label: `Cost basis ${formatHuntPrice(basis)}`, color: PRINT_LEVEL_BASIS });
        }
        renderPriceChart(ctx, closes, levels, 420, 84);
      }
      rule(ctx);
    }
  }

  // Methodology footer
  ensureSpace(ctx, 60);
  text(ctx, "Methodology", { size: 10, bold: true });
  const notes = [
    "Data: the hunt evaluates the pattern strategies over the tradable universe's daily closes from the persisted technicals bars; a hunt that finds nothing is a completed hunt, not an error.",
    "Exits: evaluated against the tenant's holdings from the selected broker (long equity with a known cost basis only); an unavailable holdings read degrades to entries only with the reason stated, never a silent drop.",
    "Levels: entry range, stop-loss, and take-profit are recommendation levels derived from the latest close with the per-strategy percentages in the externalized levels config — they are not the evaluator's exit triggers.",
    "This report renders the same output the Opportunity Hunt panel shows: one row per symbol, pattern count, entry and exit signals grouped per entry and per exit, with their price ranges.",
  ];
  for (const n of notes) text(ctx, `* ${n}`, { size: 7.5, color: PDF_PRINT_NOTE });

  // Page numbers across all pages
  addPageNumbers(doc, font);

  return doc.save();
}

export function opportunityHuntPdfFileName(result: OpportunityHuntResult): string {
  // Issue 297 convention: full timestamp (not just date) for uniqueness.
  const ts = new Date(result.asOf).toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  return `opportunity-hunt_${ts}.pdf`;
}
