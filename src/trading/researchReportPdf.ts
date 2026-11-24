/**
 * Research report PDFs (issue #335).
 *
 * Renders a #319 research run as a PDF with pdf-lib (pure JS,
 * Workers-compatible — no headless browser), FROM the canonical stored copy
 * in mas_reports (#308 model — the PDF is a delivery artifact, never a second
 * copy). Mirrors the screener-PDF machinery (#361) and the #297 naming
 * convention.
 *
 * Contents: ranked table (≤5 qualified), watchlist, rejected-with-reasons,
 * detailed trade cards (incl. falsification answers + the effective
 * filter/config snapshot the run used).
 */

import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
import type {
  ResearchReport,
  TradeCard,
  WatchlistEntry,
  RejectedEntry,
} from "../services/researchPipeline";
import { researchLegLine, researchReportFileName } from "./researchReportData";
import { cleanForPdf } from "./pdfText";

/** Print palette — same scale as the screener PDFs (#473). */
const PRINT_INK: [number, number, number] = [0.15, 0.15, 0.15];
const PRINT_LABEL: [number, number, number] = [0.35, 0.35, 0.35];
const PRINT_MUTED: [number, number, number] = [0.4, 0.4, 0.4];
const PRINT_FAINT: [number, number, number] = [0.5, 0.5, 0.5];
const PRINT_HAIRLINE: [number, number, number] = [0.7, 0.7, 0.7];
const PRINT_DANGER: [number, number, number] = [0.8, 0.2, 0.2];
const PRINT_WARNING: [number, number, number] = [0.75, 0.45, 0];

const MARGIN = 48;
const PAGE_W = 612; // Letter
const PAGE_H = 792;

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

function text(
  ctx: Ctx,
  rawStr: string,
  opts: { size?: number; bold?: boolean; color?: [number, number, number]; x?: number } = {}
): void {
  // #5109 — WinAnsi-sanitize before measuring: a raw "≥" (or "⚠") in a
  // reason, thesis, or warning aborts the whole PDF at widthOfTextAtSize.
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

function heading(ctx: Ctx, str: string): void {
  ctx.y -= 6;
  text(ctx, str, { size: 13, bold: true });
  rule(ctx);
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

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function bullet(ctx: Ctx, str: string): void {
  text(ctx, `• ${str}`, { size: 9, color: PRINT_MUTED, x: MARGIN + 12 });
}

function labeled(ctx: Ctx, label: string, value: string): void {
  text(ctx, `${label}: `, { size: 9, bold: true, color: PRINT_LABEL });
  // Continue on the same visual block — indent the value slightly.
  text(ctx, value, { size: 9, x: MARGIN + 12 });
}

function renderRankedTable(ctx: Ctx, ideas: TradeCard[]): void {
  heading(ctx, `Qualified ideas (${ideas.length})`);
  if (ideas.length === 0) {
    text(ctx, "No qualified ideas this run.", { size: 10, color: PRINT_MUTED });
    return;
  }
  for (const idea of ideas.slice(0, 5)) {
    ensureSpace(ctx, 40);
    text(
      ctx,
      `#${idea.rank} ${idea.symbol} — ${idea.outlook} — ${idea.structure} (score ${idea.score.toFixed(1)})`,
      { size: 10, bold: true }
    );
    text(ctx, idea.thesis, { size: 9, color: PRINT_MUTED, x: MARGIN + 12 });
    const e = idea.economics;
    text(
      ctx,
      `Net ${e.netCredit > 0 ? "credit" : "debit"} ${fmtMoney(e.netCredit || e.netDebit)} · max loss ${fmtMoney(e.maxLoss)} · max gain ${e.maxGain == null ? "unbounded" : fmtMoney(e.maxGain)}`,
      { size: 9, x: MARGIN + 12 }
    );
    ctx.y -= 4;
  }
}

function renderWatchlist(ctx: Ctx, watchlist: WatchlistEntry[]): void {
  heading(ctx, `Watchlist (${watchlist.length})`);
  if (watchlist.length === 0) {
    text(ctx, "Empty.", { size: 10, color: PRINT_MUTED });
    return;
  }
  for (const w of watchlist) {
    ensureSpace(ctx, 30);
    text(ctx, `${w.symbol} — ${w.outlook} — ${w.structure}`, {
      size: 10,
      bold: true,
    });
    text(ctx, `Trigger: ${w.triggerCondition}`, {
      size: 9,
      color: PRINT_MUTED,
      x: MARGIN + 12,
    });
    text(ctx, w.reason, { size: 9, x: MARGIN + 12 });
    ctx.y -= 4;
  }
}

function renderRejected(ctx: Ctx, rejected: RejectedEntry[]): void {
  heading(ctx, `Rejected (${rejected.length})`);
  if (rejected.length === 0) {
    text(ctx, "None.", { size: 10, color: PRINT_MUTED });
    return;
  }
  for (const r of rejected) {
    ensureSpace(ctx, 24);
    text(ctx, `${r.symbol} — ${r.structure} — gate: ${r.gate}`, {
      size: 9,
      bold: true,
      color: PRINT_DANGER,
    });
    text(ctx, r.reason, { size: 9, color: PRINT_MUTED, x: MARGIN + 12 });
  }
}

function renderRunProvenance(ctx: Ctx, report: ResearchReport): void {
  heading(ctx, "Run provenance");
  text(ctx, `Broker: ${report.brokerId ?? "not recorded"} · Mode: ${report.mode ?? "not recorded"} · Asset: ${report.assetType ?? "options"}`, { size: 9, color: PRINT_MUTED });
  text(ctx, `Account type: ${report.accountType ?? "not recorded"} · Account: ${report.accountId ?? "not recorded"}`, { size: 9, color: PRINT_MUTED });
  const quoteSources = [...new Set((report.symbolEvaluations ?? []).map((row) => row.quote?.source).filter((source): source is string => Boolean(source)))];
  const chainSources = [...new Set((report.symbolEvaluations ?? []).map((row) => row.chain?.source).filter((source): source is string => Boolean(source)))];
  text(ctx, `Quote sources: ${quoteSources.join(", ") || "not recorded"}`, { size: 9, color: PRINT_MUTED });
  text(ctx, `Option-chain sources: ${chainSources.join(", ") || "not recorded"}`, { size: 9, color: PRINT_MUTED });
}

function renderSymbolEvaluations(ctx: Ctx, report: ResearchReport): void {
  heading(ctx, `Universe evaluation (${(report.symbolEvaluations ?? []).length})`);
  if (!report.symbolEvaluations?.length) {
    text(ctx, "Per-symbol evaluation evidence was not recorded for this run.", { size: 9, color: PRINT_MUTED });
    return;
  }
  for (const evaluation of report.symbolEvaluations) {
    ensureSpace(ctx, 30);
    const quote = evaluation.quote
      ? `quote ${evaluation.quote.price} (${evaluation.quote.quoteStatus}, ${evaluation.quote.source})`
      : "quote unavailable";
    const chain = evaluation.chain
      ? `chain ${evaluation.chain.outcome} (${evaluation.chain.source}${evaluation.chain.provenance ? `, ${evaluation.chain.provenance}` : ""}; ${evaluation.chain.expiryCount ?? 0} expiries / ${evaluation.chain.legCount ?? 0} contracts)`
      : "chain not attempted";
    text(ctx, `${evaluation.symbol} — ${evaluation.outcome}`, { size: 9, bold: true });
    text(ctx, `${quote} · ${chain}`, { size: 8, color: PRINT_MUTED, x: MARGIN + 12 });
    if (evaluation.strategies.length) {
      text(ctx, `Strategies: ${evaluation.strategies.map((strategy) => `${strategy.strategy}=${strategy.outcome}${strategy.gate ? `(${strategy.gate})` : ""}${strategy.legs?.length ? ` [${strategy.legs.map(researchLegLine).join("; ")}]` : ""}`).join(", ")}`, { size: 8, x: MARGIN + 12 });
    }
    if (evaluation.reason) text(ctx, evaluation.reason, { size: 8, color: PRINT_MUTED, x: MARGIN + 12 });
  }
}

function renderTradeCard(ctx: Ctx, idea: TradeCard): void {
  newPage(ctx);
  text(ctx, `Trade card #${idea.rank}: ${idea.symbol}`, {
    size: 14,
    bold: true,
  });
  text(ctx, `${idea.outlook} · ${idea.structure} · score ${idea.score.toFixed(1)}`, {
    size: 10,
    color: PRINT_LABEL,
  });
  rule(ctx);

  text(ctx, "Thesis", { size: 10, bold: true });
  text(ctx, idea.thesis, { size: 9 });
  ctx.y -= 4;

  if (idea.supportingEvidence.length > 0) {
    text(ctx, "Supporting", { size: 10, bold: true });
    for (const s of idea.supportingEvidence) bullet(ctx, s);
    ctx.y -= 4;
  }
  if (idea.contradictingEvidence.length > 0) {
    text(ctx, "Contradicting", { size: 10, bold: true, color: PRINT_WARNING });
    for (const s of idea.contradictingEvidence) bullet(ctx, s);
    ctx.y -= 4;
  }

  text(ctx, "Falsification", { size: 10, bold: true });
  const f = idea.falsification;
  labeled(ctx, "Why the market may be wrong", f.whyMarketWrong);
  labeled(ctx, "Resolution trigger", f.resolutionTrigger);
  labeled(ctx, "Horizon", f.horizon);
  labeled(ctx, "Invalidation", f.invalidation);
  labeled(ctx, "Why this structure", f.whyThisStructure);
  if (idea.falsificationWarnings.length > 0) {
    for (const w of idea.falsificationWarnings)
      text(ctx, `⚠ ${w}`, { size: 9, color: PRINT_WARNING, x: MARGIN + 12 });
  }
  ctx.y -= 4;

  text(ctx, "Economics", { size: 10, bold: true });
  const e = idea.economics;
  labeled(
    ctx,
    "Net",
    e.netCredit > 0
      ? `credit ${fmtMoney(e.netCredit)}`
      : `debit ${fmtMoney(e.netDebit)}`
  );
  labeled(ctx, "Max loss", fmtMoney(e.maxLoss));
  labeled(ctx, "Max gain", e.maxGain == null ? "unbounded" : fmtMoney(e.maxGain));
  labeled(ctx, "Contractual max loss", fmtMoney(idea.contractualMaxLoss));
  if (idea.legs.length > 0) {
    text(ctx, "Legs", { size: 10, bold: true });
    // Issue #2167: the shared leg line. The old cast read fields ResearchLeg
    // does not have (action/symbol/price), so every leg printed blanks.
    for (const leg of idea.legs) bullet(ctx, researchLegLine(leg));
  }
  ctx.y -= 4;

  text(ctx, "Entry & risk", { size: 10, bold: true });
  labeled(ctx, "Entry condition", idea.entryCondition);
  labeled(ctx, "Invalidation", idea.invalidation);
  if (idea.limitations.length > 0) {
    text(ctx, "Limitations", { size: 10, bold: true });
    for (const l of idea.limitations) bullet(ctx, l);
  }
}

function renderConfigSnapshot(ctx: Ctx, report: ResearchReport): void {
  heading(ctx, "Effective config snapshot");
  const cfg = report.configSnapshot as unknown as Record<string, unknown>;
  const keys = Object.keys(cfg ?? {});
  if (keys.length === 0) {
    text(ctx, "No config snapshot recorded.", {
      size: 10,
      color: PRINT_MUTED,
    });
    return;
  }
  for (const k of keys.slice(0, 40)) {
    const v = cfg[k];
    const vs =
      typeof v === "object" ? JSON.stringify(v).slice(0, 160) : String(v);
    ensureSpace(ctx, 16);
    text(ctx, `${k}: ${vs}`, { size: 8, color: PRINT_MUTED });
  }
  text(ctx, `rulesVersion: ${report.rulesVersion}`, {
    size: 9,
    color: PRINT_LABEL,
  });
  // Issue #6037 (d) — the resolved rules the run decided under.
  for (const [key, value] of Object.entries(report.rules ?? {})) {
    ensureSpace(ctx, 12);
    text(ctx, `rule ${key}: ${String(value)}`, { size: 7, color: PRINT_MUTED });
  }
}

/**
 * Generate the research-run PDF from the canonical stored report.
 * Returns the raw PDF bytes.
 */
export async function generateResearchPdf(
  report: ResearchReport
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = {
    doc,
    font,
    bold,
    page: doc.addPage([PAGE_W, PAGE_H]),
    y: PAGE_H - MARGIN,
  };

  // Cover header
  text(ctx, "Autonomous Options Research", { size: 18, bold: true });
  text(ctx, `Run ${report.runId} · ${report.trigger} · ${report.createdAt}`, {
    size: 10,
    color: PRINT_LABEL,
  });
  const regime = report.regime;
  text(
    ctx,
    `Regime: ${regime?.regime ?? "unknown"}${regime?.notes?.length ? ` — ${regime.notes.slice(0, 2).join("; ")}` : ""}`,
    { size: 10, color: PRINT_LABEL }
  );
  rule(ctx);
  text(ctx, report.summary || "No summary.", { size: 10 });
  renderRunProvenance(ctx, report);
  ctx.y -= 4;
  const s = report.stats;
  if (s) {
    text(
      ctx,
      `Universe ${s.universeSize} · quotes ${s.quotesRetrieved} · chains attempted ${s.chainsAttempted ?? "not recorded"} / fetched ${s.chainsFetched} · evaluated ${s.candidatesEvaluated} · qualified ${s.qualified} · watchlist ${s.watchlist} · rejected ${s.rejected}`,
      { size: 9, color: PRINT_MUTED }
    );
  }

  renderRankedTable(ctx, report.ideas ?? []);
  renderWatchlist(ctx, report.watchlist ?? []);
  renderRejected(ctx, report.rejected ?? []);
  renderSymbolEvaluations(ctx, report);

  for (const idea of (report.ideas ?? []).slice(0, 5)) {
    renderTradeCard(ctx, idea);
  }

  newPage(ctx);
  renderConfigSnapshot(ctx, report);

  // Footer page numbers
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(`${i + 1} / ${pages.length}`, {
      x: PAGE_W - MARGIN - 40,
      y: 24,
      size: 8,
      font,
      color: rgb(...PRINT_FAINT),
    });
  });

  return doc.save();
}

/**
 * #297 naming: full timestamp for uniqueness.
 * Format: research_{trigger}_{timestamp}_{runId}.pdf
 */
export function researchPdfFileName(report: ResearchReport): string {
  // Issue #2167: one naming rule for all three formats.
  return researchReportFileName(report, "pdf");
}
