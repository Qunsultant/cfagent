/**
 * Options scanner PDF reports (issue #350).
 *
 * Generates an options research report PDF with pdf-lib (pure JS, Workers-compatible).
 * Used by:
 *   - the scheduled tick → Slack file upload + email attachment
 *   - the manual run → downloadable via API
 *
 * Mirrors the structure of screenerReportPdf.ts for stock screeners.
 */

import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { OptionScreenResult, ScreenedOptionContractItem } from "../types";
import type { OptionsPartialQualification } from "./options/opportunityScanner";
import { buildNamesByStrategyRows, buildStrategiesByNameRows } from "./optionsReportMatrix";


/** Print palette (#473): named print mirrors of the semantic text roles —
 *  same scale as screenerReportPdf — instead of scattered rgb literals. */
const PRINT_INK: [number, number, number] = [0.15, 0.15, 0.15];
const PRINT_MUTED: [number, number, number] = [0.4, 0.4, 0.4];
const PRINT_NOTE: [number, number, number] = [0.45, 0.45, 0.45];
const PRINT_FAINT: [number, number, number] = [0.5, 0.5, 0.5];
const PRINT_HAIRLINE: [number, number, number] = [0.7, 0.7, 0.7];
const PRINT_WARNING: [number, number, number] = [0.75, 0.45, 0];

const MARGIN = 48;
const PAGE_W = 612; // Letter
const PAGE_H = 792;
const CONTENT_W = PAGE_W - MARGIN * 2;

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
  // Issue #2599 (F8): word-wrap, never truncate. The previous
  // `str.slice(0, 120)` silently cut contract/prose lines at 120
  // characters; this is the screenerReportPdf wrap idiom (measure
  // with widthOfTextAtSize, break on words, one drawn line per
  // wrapped line with its own page-break check). Caps and content
  // are unchanged — the callers' slice(0, 50) / slice(0, 25) /
  // "... and N more" lines still state the summary caps; only the
  // rendering of each kept line changes, from cut to wrapped.
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
  // Empty input still consumes one line, as the old single-draw did.
  if (lines.length === 0) lines.push("");
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

function formatContract(c: ScreenedOptionContractItem): string {
  const parts: string[] = [];
  parts.push(c.underlyingSymbol || c.symbol || "N/A");
  if (c.expirationDate) parts.push(c.expirationDate);
  if (c.strikePrice) parts.push(`$${c.strikePrice}`);
  if (c.optionType) parts.push(c.optionType);
  if (c.delta !== undefined) parts.push(`d${c.delta.toFixed(2)}`);
  if (c.impliedVolatility !== undefined) parts.push(`IV${(c.impliedVolatility * 100).toFixed(0)}%`);
  return parts.join(" ");
}

/**
 * Issue #1290 (#1173 R6): the qualified-partial banner lines for an
 * options scan whose coverage was partial — the options mirror of the
 * stock PDF's "PARTIAL SCREEN — QUALIFIED RESULTS" block (#462).
 * Returns null when the run was complete (no qualification stamped).
 */
export function optionsPartialBanner(
  partial: OptionsPartialQualification | undefined
): [string, string] | null {
  if (!partial) return null;
  const heading = "PARTIAL SCAN — QUALIFIED RESULTS";
  const counts =
    `${partial.evaluatedCount} of ${partial.consideredCount} underlyings evaluated; ` +
    `${partial.coverageErrors} quote/chain failures, ${partial.truncatedCount} truncated.` +
    (partial.topSkipReason ? ` Top skip reason: ${partial.topSkipReason}.` : "") +
    " Results below cover the evaluated subset only.";
  return [heading, counts];
}

/**
 * Generate a PDF report for an options scan result.
 */
export async function generateOptionsPdf(result: OptionScreenResult | any): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ctx: Ctx = { doc, font, bold, page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };

  const scannedAt = result.scannedAt || result.generatedAt || result.timestamp || new Date().toISOString();
  const underlyingsScanned = result.totalUnderlyingsScanned ?? result.scanned ?? 0;
  const contractsEvaluated = result.totalContractsEvaluated ?? result.withTrades ?? 0;
  const matched = result.matchedCount ?? (result.contracts ? result.contracts.length : (result.opportunities ? result.opportunities.length : 0));
  const thesis = result.thesis || (result.mode ? String(result.mode) : "Bullish");
  const riskProfile = result.riskProfile || "Balanced";
  const universeLabel = (result.universe || (result.symbols && result.symbols.length > 0 ? result.symbols.slice(0, 5).join(", ") : "Options Universe")).replace(/_/g, " ");

  // Header
  text(ctx, `Options Scanner Report — ${universeLabel}`, { size: 16, bold: true });
  text(ctx, `Thesis: ${thesis.toUpperCase()}  •  Risk Profile: ${riskProfile}  •  Generated: ${scannedAt}`, { size: 9, color: PRINT_MUTED });

  // Active Criteria Box
  ensureSpace(ctx, 16);
  const activeCriteria = result.filterSummary || `Thesis ${thesis}, risk profile ${riskProfile}, live E*TRADE chains`;
  text(ctx, `Active Criteria: ${activeCriteria}`, { size: 9, bold: true, color: PRINT_INK });
  rule(ctx);

  // Partial scan notice (issue #1290): a qualified partial is never
  // presented as a complete scan on the artifact itself.
  const partialBanner = optionsPartialBanner((result as any).partial);
  if (partialBanner) {
    text(ctx, partialBanner[0], { size: 12, bold: true, color: PRINT_WARNING });
    text(ctx, partialBanner[1], { size: 9 });
    rule(ctx);
  }

  // Summary
  text(ctx, "Summary", { size: 12, bold: true });
  text(ctx, `Underlyings scanned: ${underlyingsScanned}   Contracts evaluated: ${contractsEvaluated}   Matched: ${matched}`);
  rule(ctx);

  // Contracts or Opportunities
  if (Array.isArray(result.contracts) && result.contracts.length > 0) {
    text(ctx, `Matched Contracts (${result.contracts.length})`, { size: 12, bold: true });
    ctx.y -= 4;

    for (const contract of result.contracts.slice(0, 50)) {
      ensureSpace(ctx, 28);
      text(ctx, formatContract(contract), { size: 9, bold: true });
      if (contract.bid && contract.ask) {
        text(ctx, `  Bid/Ask: $${contract.bid.toFixed(2)} / $${contract.ask.toFixed(2)}`, { size: 8, color: PRINT_MUTED });
      }
      ctx.y -= 2;
    }

    if (result.contracts.length > 50) {
      text(ctx, `... and ${result.contracts.length - 50} more`, { size: 9, color: PRINT_FAINT });
    }
    rule(ctx);
  } else if (Array.isArray(result.opportunities) && result.opportunities.length > 0) {
    text(ctx, `Opportunities (${result.opportunities.length})`, { size: 12, bold: true });
    ctx.y -= 4;

    for (const opp of result.opportunities.slice(0, 50)) {
      ensureSpace(ctx, 28);
      const symbol = opp.symbol || "N/A";
      const pick = opp.pick;
      const pickName = pick?.strategyName || pick?.strategyType || "Strategy";
      const price = opp.underlyingPrice !== undefined ? `$${opp.underlyingPrice.toFixed(2)}` : "";
      const score = opp.score !== undefined ? `Score: ${opp.score}` : "";
      const bucket = opp.gateBucket ? `[${String(opp.gateBucket).toUpperCase()}]` : "";
      text(ctx, `${symbol} - ${pickName} ${price} ${bucket}`.trim(), { size: 9, bold: true });
      const detail = pick?.description || pick?.reasoning || score;
      if (detail) {
        text(ctx, `  ${detail}`, { size: 8, color: PRINT_MUTED });
      }
      ctx.y -= 2;
    }

    if (result.opportunities.length > 50) {
      text(ctx, `... and ${result.opportunities.length - 50} more`, { size: 9, color: PRINT_FAINT });
    }
    rule(ctx);
  } else {
    text(ctx, "No matching contracts or opportunities found.", { size: 10, color: PRINT_MUTED });
    rule(ctx);
  }

  // Issue #2091 matrix sections: the two directions of the chain-vs-
  // strategies evaluation. Rendered ONLY when the run carries a matrix
  // (scheduled scans and adapted scans do; manual runs without a scan
  // and legacy rows do not — they keep the previous shape).
  if (Array.isArray(result.matrix) && result.matrix.length > 0) {
    const byName = buildStrategiesByNameRows(result.matrix);
    const byStrategy = buildNamesByStrategyRows(Array.isArray(result.typeRollup) ? result.typeRollup : []);
    text(ctx, "Strategies fit my name", { size: 12, bold: true });
    ctx.y -= 4;
    for (const row of byName.slice(0, 50)) {
      ensureSpace(ctx, 28);
      text(ctx, `${row.symbol} — ${row.passedCount} of ${row.evaluatedCount} evaluated strategies fit`, { size: 9, bold: true });
      for (const passing of row.passing.slice(0, 5)) {
        const composite = passing.bestComposite !== null ? `composite ${passing.bestComposite}` : "no composite";
        const expiry = passing.bestExpirationDate ? `, exp ${passing.bestExpirationDate}` : "";
        text(ctx, `  ${passing.strategyType} — ${passing.label} (${composite}${expiry})`, { size: 8, color: PRINT_MUTED });
      }
      if (row.passing.length > 5) {
        text(ctx, `  ... and ${row.passing.length - 5} more fit`, { size: 8, color: PRINT_FAINT });
      }
      ctx.y -= 2;
    }
    if (byName.length > 50) {
      text(ctx, `... and ${byName.length - 50} more names`, { size: 9, color: PRINT_FAINT });
    }
    rule(ctx);
    if (byStrategy.length > 0) {
      text(ctx, "Names fit my strategy", { size: 12, bold: true });
      ctx.y -= 4;
      for (const row of byStrategy.slice(0, 25)) {
        ensureSpace(ctx, 28);
        const best = row.bestSymbol ? `, best ${row.bestSymbol}${row.bestComposite !== null ? ` (composite ${row.bestComposite})` : ""}` : "";
        text(ctx, `${row.strategyType} — ${row.label}: ${row.symbolsPassed} of ${row.symbolsEvaluated} symbols passed${best}`, { size: 9, bold: true });
      }
      if (byStrategy.length > 25) {
        text(ctx, `... and ${byStrategy.length - 25} more strategies`, { size: 9, color: PRINT_FAINT });
      }
      rule(ctx);
    }
    const coverage = result.strategyCoverage as
      | { scope?: string; evaluatedStrategyIds?: string[]; notEvaluated?: Array<{ id: string; reason: string }> }
      | undefined;
    if (coverage) {
      const evaluatedCount = coverage.evaluatedStrategyIds?.length ?? 0;
      const notEvaluated = coverage.notEvaluated ?? [];
      text(ctx, `Coverage (${coverage.scope === "all" ? "all wanted strategies" : "thesis strategies"}): ${evaluatedCount} evaluated`, { size: 9, bold: true });
      for (const entry of notEvaluated.slice(0, 10)) {
        text(ctx, `  Not evaluated: ${entry.id} — ${entry.reason}`, { size: 8, color: PRINT_MUTED });
      }
      if (notEvaluated.length > 10) {
        text(ctx, `  ... and ${notEvaluated.length - 10} more not evaluated`, { size: 8, color: PRINT_FAINT });
      }
      rule(ctx);
    }
  }

  // Methodology footer
  ensureSpace(ctx, 40);
  text(ctx, "Methodology", { size: 10, bold: true });
  text(ctx, "* Quotes: E*TRADE live option chains. Standard Greeks via Black-Scholes.", { size: 7.5, color: PRINT_NOTE });
  text(ctx, "* Multi-leg strategy discovery: risk-bounded payoff evaluations per defined risk profile.", { size: 7.5, color: PRINT_NOTE });

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

  return (await doc.save()) as Uint8Array;
}

/**
 * Generate a filename for the options PDF report.
 */
/**
 * #297 naming parity with the stock screener PDFs (#334):
 * options-scan_{universe}_{schedule}_{timestamp}_{jobId}.pdf
 * The schedule and jobId are appended by the caller when available.
 */
export function optionsPdfFileName(result: OptionScreenResult | any): string {
  const dateStr = result.scannedAt || result.generatedAt || result.timestamp || new Date().toISOString();
  let ts: string;
  try {
    ts = new Date(dateStr).toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  } catch {
    ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  }
  const r = result as unknown as Record<string, unknown>;
  const u = String(r.universe || "options").toLowerCase().replace(/_/g, "-");
  const schedule = String(r.schedule || r.trigger || "adhoc");
  const jobId = String(r.jobId || "adhoc");
  return `options-scan_${u}_${schedule}_${ts}_${jobId}.pdf`;
}
