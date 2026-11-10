/**
 * Screener PDF report template (issue #2088).
 *
 * The template the PDF never had: one row projection, one sort, and
 * sections defined as filter + limit — every PDF section rendered
 * through the same table code.
 *
 * The projection mirrors the CSV/XLSX value mapping column for
 * column (src/trading/screenerReportCsv.ts stockToRow and the
 * "Screened Stocks" tab builder): same source fields, same
 * fallbacks. It is the PDF's display formatting of those values,
 * not a third mapping — a value that disagrees with the CSV/XLSX
 * for the same row is a defect in this module.
 *
 * Sort: screenScore desc, symbol asc tiebreak (integer scores tie
 * constantly), null scores last. screenScore is the displayed
 * "Score" composite (day momentum, intraday position, 52-week
 * position, value zone); it does NOT include RSI, MACD, gap, or
 * factor grades. momentumScore is a separate field used for
 * standout selection only.
 *
 * Sections: gap up (gapDirection up), gap down (down), standouts
 * (the existing opportunities set — selection criteria unchanged,
 * only sorted + limited), all symbols (no filter). The base list
 * is allStocks when non-empty, else opportunities — the CSV/XLSX
 * fallback rule — so the PDF's row set matches the workbook's.
 *
 * Gather seam (#2088 provenance): gather-derived columns (RSI,
 * MACD, Gap%) render from the run object today. Once Phase 3
 * #1998 lands the persisted gather output, the template's row
 * input switches to that store; the projection and sort do not
 * change.
 */

export interface ScreenerPdfColumn {
  header: string;
  /** Points of the 720pt landscape content width. Must sum to 720. */
  w: number;
}

export const SCREENER_PDF_COLUMNS: ScreenerPdfColumn[] = [
  { header: "Symbol", w: 48 },
  { header: "Company", w: 92 },
  { header: "Sector", w: 56 },
  { header: "Price", w: 48 },
  { header: "Chg%", w: 40 },
  { header: "Gap%", w: 40 },
  { header: "Sentiment", w: 60 },
  { header: "Quant", w: 48 },
  { header: "Val", w: 28 },
  { header: "Mom", w: 28 },
  { header: "RSI", w: 34 },
  { header: "MACD", w: 44 },
  { header: "Score", w: 36 },
  { header: "P/E", w: 38 },
  { header: "Signal", w: 44 },
  { header: "Source", w: 36 },
];

/** Minimal structural row: what the projection reads. */
export interface ScreenerPdfRowInput {
  symbol: string;
  companyName?: string | null;
  sector?: string | null;
  lastPrice?: number | null;
  changePercent?: number | null;
  technicals?: {
    gapPercent?: number | null;
    gapDirection?: string | null;
    rsi14?: number | null;
    macdHistogram?: number | null;
  } | null;
  indicators?: {
    sentiment?: string | null;
    screenScore?: number | null;
  } | null;
  factorGrades?: {
    quantRating?: string | null;
    value?: string | null;
    momentum?: string | null;
  } | null;
  rsi14?: number | null;
  peRatio?: number | null;
  signal?: string | null;
  source?: string | null;
}

function fmt(n: number | null | undefined, digits = 2, suffix = ""): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${n.toFixed(digits)}${suffix}`;
}

function gapLabel(t: ScreenerPdfRowInput["technicals"]): string {
  if (!t || t.gapPercent == null) return "-";
  const arrow = t.gapDirection === "up" ? "+" : t.gapDirection === "down" ? "-" : "";
  return `${arrow}${Math.abs(t.gapPercent).toFixed(1)}%`;
}

/** One projected row: 16 display strings, in SCREENER_PDF_COLUMNS order. */
export function projectScreenerPdfRow(stock: ScreenerPdfRowInput): string[] {
  const t = stock.technicals ?? {};
  const grades = stock.factorGrades ?? {};
  const indicators = stock.indicators ?? {};
  const rsiVal = t.rsi14 ?? stock.rsi14;
  const macdVal =
    t.macdHistogram != null
      ? `${t.macdHistogram >= 0 ? "+" : ""}${t.macdHistogram.toFixed(1)}`
      : "-";
  return [
    stock.symbol,
    stock.companyName || stock.symbol,
    stock.sector || "Unknown",
    `$${fmt(stock.lastPrice, 2)}`,
    stock.changePercent != null
      ? `${stock.changePercent >= 0 ? "+" : ""}${fmt(stock.changePercent, 1, "%")}`
      : "-",
    gapLabel(t),
    // #3932: sourced news sentiment or "-" — never the
    // price-derived day action, and never a "neutral" default.
    indicators.sentiment != null ? indicators.sentiment.replace(/_/g, " ") : "-",
    grades.quantRating ?? "-",
    grades.value ?? "-",
    grades.momentum ?? "-",
    rsiVal != null ? fmt(rsiVal, 1) : "-",
    macdVal,
    indicators.screenScore != null ? String(indicators.screenScore) : "-",
    stock.peRatio != null ? fmt(stock.peRatio, 1) : "-",
    stock.signal || "-",
    stock.source || "E*TRADE live",
  ];
}

function screenScoreOf(row: ScreenerPdfRowInput): number | null {
  const s = row.indicators?.screenScore;
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}

/** screenScore desc, symbol asc tiebreak, null scores last. */
export function sortScreenerPdfRows<T extends ScreenerPdfRowInput>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const sa = screenScoreOf(a);
    const sb = screenScoreOf(b);
    if (sa === null && sb === null) return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
    if (sa === null) return 1;
    if (sb === null) return -1;
    if (sb !== sa) return sb - sa;
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });
}

export interface ScreenerPdfSectionConfig {
  /** Max gap-up rows, or null for all. */
  gapUps: number | null;
  /** Max gap-down rows, or null for all. */
  gapDowns: number | null;
  /** Max standout rows, or null for all opportunities. */
  standouts: number | null;
  /** Max all-symbols rows, or null for all. */
  allSymbols: number | null;
}

export const DEFAULT_SCREENER_PDF_SECTION_CONFIG: ScreenerPdfSectionConfig = {
  gapUps: 8,
  gapDowns: 8,
  standouts: null,
  allSymbols: null,
};

function parseLimit(raw: string | undefined, fallback: number | null): number | null {
  if (raw === undefined || raw === "") return fallback;
  if (raw.trim().toLowerCase() === "all") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Code defaults plus env overrides (v1; no settings UI). Env names:
 * SCREENER_PDF_GAP_UPS / _GAP_DOWNS / _STANDOUTS / _ALL_SYMBOLS.
 * A positive integer caps the section; "all" removes the cap;
 * anything else keeps the default.
 */
export function resolveScreenerPdfSectionConfig(
  env: Record<string, string | undefined>
): ScreenerPdfSectionConfig {
  const d = DEFAULT_SCREENER_PDF_SECTION_CONFIG;
  return {
    gapUps: parseLimit(env.SCREENER_PDF_GAP_UPS, d.gapUps),
    gapDowns: parseLimit(env.SCREENER_PDF_GAP_DOWNS, d.gapDowns),
    standouts: parseLimit(env.SCREENER_PDF_STANDOUTS, d.standouts),
    allSymbols: parseLimit(env.SCREENER_PDF_ALL_SYMBOLS, d.allSymbols),
  };
}

export type ScreenerPdfSectionKey = "gapUp" | "gapDown" | "standouts" | "allSymbols";

export interface ScreenerPdfSection {
  key: ScreenerPdfSectionKey;
  title: string;
  /** Projected, sorted, limited rows. */
  rows: string[][];
  /** Rows shown after the limit. */
  shown: number;
  /** Rows before the limit. */
  total: number;
}

function sliceSection(
  key: ScreenerPdfSectionKey,
  title: string,
  rows: ScreenerPdfRowInput[],
  limit: number | null
): ScreenerPdfSection {
  const sorted = sortScreenerPdfRows(rows);
  const limited = limit === null ? sorted : sorted.slice(0, limit);
  return {
    key,
    title,
    rows: limited.map(projectScreenerPdfRow),
    shown: limited.length,
    total: sorted.length,
  };
}

/**
 * Every PDF section from one run: same projection, same sort,
 * filter + limit per section. Standouts reuse the run's existing
 * opportunities set untouched (selection criteria unchanged).
 */
export function buildScreenerPdfSections(
  result: {
    allStocks?: ScreenerPdfRowInput[] | null;
    opportunities?: ScreenerPdfRowInput[] | null;
  },
  config: ScreenerPdfSectionConfig
): ScreenerPdfSection[] {
  const base =
    result.allStocks && result.allStocks.length > 0
      ? result.allStocks
      : (result.opportunities ?? []);
  const gapUp = base.filter((s) => s.technicals?.gapDirection === "up");
  const gapDown = base.filter((s) => s.technicals?.gapDirection === "down");
  return [
    sliceSection("gapUp", "Gap up", gapUp, config.gapUps),
    sliceSection("gapDown", "Gap down", gapDown, config.gapDowns),
    sliceSection("standouts", "Standout Opportunities", result.opportunities ?? [], config.standouts),
    sliceSection("allSymbols", "All Screened Symbols", base, config.allSymbols),
  ];
}

/** One appendix row: the XLSX "Formulas & Methodology" tab's fields, in tab order. */
export function projectFormulaAppendixRows(
  docs: Array<{
    columnName: string;
    fieldKey: string;
    provenance: string;
    formula: string;
    description: string;
  }>
): string[][] {
  return docs.map((d) => [d.columnName, d.fieldKey, d.provenance, d.formula, d.description]);
}

/**
 * Word-wrap a cell value to a column width. Never truncates: the
 * wrapped lines rejoin to the input. A single word longer than the
 * column is hard-split so no line exceeds the width.
 */
export function wrapCellText(
  value: string,
  width: number,
  measure: (text: string) => number
): string[] {
  const words = String(value ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  const pushWord = (word: string): void => {
    let rest = word;
    while (measure(rest) > width) {
      let cut = rest.length;
      while (cut > 0 && measure(rest.slice(0, cut)) > width) cut--;
      if (cut === 0) cut = 1;
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    const candidate = line ? `${line} ${rest}` : rest;
    if (line && measure(candidate) > width) {
      lines.push(line);
      line = rest;
    } else {
      line = candidate;
    }
  };
  for (const word of words) pushWord(word);
  if (line) lines.push(line);
  return lines;
}
