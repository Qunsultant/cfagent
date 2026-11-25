/**
 * Shared PDF drawing layer for the pdf-lib report renderers (issue 6403).
 *
 * The low-level drawing primitives every PDF report uses — page
 * management, wrapped text, rules, and the generic section table —
 * lived as parallel copies in each renderer (screener, options,
 * research, discovery, hunt). This module is the ONE home for
 * them, following the `pdfText.ts` precedent (shared WinAnsi
 * sanitizer, not copied per renderer): a renderer imports these
 * instead of redefining them. The report SHAPE (which sections,
 * which columns, which charts) stays in each renderer; only the
 * generic drawing is shared.
 *
 * Layout follows the screener PDF (issue 269, template + landscape
 * 2088): Letter landscape (792 x 612, 720pt content width), one
 * table per section, cells wrap and are never silently sliced.
 *
 * Print palette (#473): PDFs render on white paper, so the reports
 * use this named print scale — the print mirrors of the semantic
 * text/status roles — instead of scattered rgb literals. pdf-lib
 * 0..1 RGB triples. Renderer-specific colours (the hunt's bar and
 * level colours, the screener's warning) stay in their renderer.
 */

import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import { cleanForPdf } from "./pdfText";
import { wrapCellText } from "./screenerReportTemplate";

export const PDF_MARGIN = 36;
export const PDF_PAGE_W = 792; // Letter landscape (2088: entire document, no mixing)
export const PDF_PAGE_H = 612;
export const PDF_CONTENT_W = PDF_PAGE_W - PDF_MARGIN * 2;

export type PdfColor = [number, number, number];
export const PDF_PRINT_INK: PdfColor = [0.15, 0.15, 0.15];
export const PDF_PRINT_LABEL: PdfColor = [0.35, 0.35, 0.35];
export const PDF_PRINT_MUTED: PdfColor = [0.4, 0.4, 0.4];
export const PDF_PRINT_NOTE: PdfColor = [0.45, 0.45, 0.45];
export const PDF_PRINT_FAINT: PdfColor = [0.5, 0.5, 0.5];
export const PDF_PRINT_HAIRLINE: PdfColor = [0.7, 0.7, 0.7];
export const PDF_PRINT_DANGER: PdfColor = [0.8, 0.2, 0.2];

export interface PdfCtx {
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  page: PDFPage;
  y: number;
}

export interface PdfTableColumn {
  header: string;
  /** Points of the 720pt landscape content width. Must sum to 720. */
  w: number;
}

export interface PdfTableOptions {
  /**
   * Per-column body text colour, keyed by zero-based column index. A `—` cell
   * keeps the default ink (an empty value is not a status signal). Issue 6499:
   * the hunt report's Exits column is danger red.
   */
  columnColors?: Readonly<Record<number, PdfColor>>;
}

/** A fresh context with the first page already added. */
export function createPdfCtx(doc: PDFDocument, font: PDFFont, bold: PDFFont): PdfCtx {
  return { doc, font, bold, page: doc.addPage([PDF_PAGE_W, PDF_PAGE_H]), y: PDF_PAGE_H - PDF_MARGIN };
}

export function newPage(ctx: PdfCtx): void {
  ctx.page = ctx.doc.addPage([PDF_PAGE_W, PDF_PAGE_H]);
  ctx.y = PDF_PAGE_H - PDF_MARGIN;
}

export function ensureSpace(ctx: PdfCtx, needed: number): void {
  if (ctx.y - needed < PDF_MARGIN) newPage(ctx);
}

export function text(
  ctx: PdfCtx,
  rawStr: string,
  opts: { size?: number; bold?: boolean; color?: PdfColor; x?: number } = {}
): void {
  const str = cleanForPdf(rawStr);
  const size = opts.size ?? 10;
  const font = opts.bold ? ctx.bold : ctx.font;
  const c = opts.color ?? PDF_PRINT_INK;
  const x = opts.x ?? PDF_MARGIN;
  const maxWidth = PDF_PAGE_W - PDF_MARGIN - x;
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

export function rule(ctx: PdfCtx): void {
  ensureSpace(ctx, 10);
  ctx.page.drawLine({
    start: { x: PDF_MARGIN, y: ctx.y },
    end: { x: PDF_PAGE_W - PDF_MARGIN, y: ctx.y },
    thickness: 0.75,
    color: rgb(...PDF_PRINT_HAIRLINE),
  });
  ctx.y -= 10;
}

export function renderTableHeader(ctx: PdfCtx, cols: PdfTableColumn[]): void {
  ensureSpace(ctx, 16);
  let x = PDF_MARGIN;
  for (const col of cols) {
    ctx.page.drawText(col.header, { x, y: ctx.y, size: 8, font: ctx.bold, color: rgb(...PDF_PRINT_LABEL) });
    x += col.w;
  }
  ctx.y -= 10;
  ctx.page.drawLine({
    start: { x: PDF_MARGIN, y: ctx.y },
    end: { x: PDF_PAGE_W - PDF_MARGIN, y: ctx.y },
    thickness: 0.5,
    color: rgb(...PDF_PRINT_HAIRLINE),
  });
  ctx.y -= 6;
}

/**
 * One table: header repeats on every page break, cells wrap
 * to their column width (never sliced). The caller composes the
 * title — the screener's "showing X of Y" suffix is a title
 * detail, not a rendering difference.
 */
export function renderTable(
  ctx: PdfCtx,
  title: string,
  cols: PdfTableColumn[],
  rows: string[][],
  options: PdfTableOptions = {}
): void {
  if (rows.length === 0) return;
  text(ctx, title, { size: 12, bold: true });
  renderTableHeader(ctx, cols);
  const measure = (t: string): number => ctx.font.widthOfTextAtSize(t, 8);
  for (const row of rows) {
    const wrapped = row.map((cell, i) => wrapCellText(cell, cols[i].w - 4, measure));
    const lineCount = Math.max(...wrapped.map((w) => w.length));
    const rowHeight = lineCount * 10 + 2;
    const pageBefore = ctx.page;
    ensureSpace(ctx, rowHeight);
    if (ctx.page !== pageBefore) renderTableHeader(ctx, cols);
    let x = PDF_MARGIN;
    for (let i = 0; i < row.length; i++) {
      const cellColor =
        row[i] !== "—" ? (options.columnColors?.[i] ?? PDF_PRINT_INK) : PDF_PRINT_INK;
      for (let li = 0; li < wrapped[i].length; li++) {
        ctx.page.drawText(cleanForPdf(wrapped[i][li]), {
          x,
          y: ctx.y - li * 10,
          size: 8,
          font: ctx.font,
          color: rgb(...cellColor),
        });
      }
      x += cols[i].w;
    }
    ctx.y -= rowHeight;
  }
  rule(ctx);
}

/** "Page N of M" footer on every page. */
export function addPageNumbers(doc: PDFDocument, font: PDFFont): void {
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(`Page ${i + 1} of ${pages.length}`, {
      x: PDF_PAGE_W - PDF_MARGIN - 60,
      y: 20,
      size: 8,
      font,
      color: rgb(...PDF_PRINT_FAINT),
    });
  });
}
