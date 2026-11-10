/**
 * Stock + options CSV report generators (issue #1346, job-truth
 * follow-up to #1335; #1355 job2.4 consumes the stock generator
 * for its generate.csv shard).
 *
 * #1346: stock/options runs stored only PDF + XLSX; CSV was a
 * client-side export from loaded results (src/client/runExport.ts),
 * not a stored artifact, so the Runs list could not link one.
 * These generators mirror the goal-screen CSV in
 * src/services/goalScreenReports.ts — same conventions, not a
 * second format:
 *   - header row + one row per record; headers ONLY at 0 records
 *     (the acceptance: a 0-record stock run and a 0-record options
 *     run each yield a headers-only stored CSV alongside PDF+XLSX);
 *   - the goal-screen escape (quote on comma/quote/newline, doubled
 *     quotes), LF line endings with a trailing newline;
 *   - columns mirror the run's XLSX tab column-for-column (stock:
 *     "Screened Stocks"; options: "Screened Contracts"), with the
 *     same value mapping — so the three formats describe the same
 *     rows. The one deliberate divergence: the options XLSX writes
 *     a "(no contracts matched)" placeholder row at 0 contracts;
 *     the CSV writes headers only, per #1346's acceptance.
 *   - storage keys are namespaced per format (screener:csv: /
 *     options:csv:), served prefix-validated through the agent
 *     getters, and surfaced as csvUrl on RunSummary + Reports cards.
 * Provenance (shard ids) rides in report metadata, never in the
 * CSV bytes — a comment line would break parsers.
 */

import type { ScreenerRunResult } from "../agents/screener-agent";
import type { OptionScreenResult } from "../types";

/** Stock CSV columns, in "Screened Stocks" tab order. */
export const SCREENER_CSV_COLUMNS: readonly string[] = [
  "Symbol",
  "Company Name",
  "Sector",
  "Price",
  "Chg%",
  "Gap%",
  "Sentiment",
  "Quant Rating",
  "Value Grade",
  "Momentum Grade",
  "RSI-14",
  "MACD Histogram",
  "Score",
  "P/E Ratio",
  "Technical Signal",
  "Data Source",
];

/** Options CSV columns, in "Screened Contracts" tab order. */
export const OPTIONS_CSV_COLUMNS: readonly string[] = [
  "Underlying",
  "Underlying Price",
  "Type",
  "Strike",
  "Expiration",
  "DTE",
  "Moneyness",
  "Bid",
  "Ask",
  "Last",
  "Spread %",
  "Volume",
  "Open Interest",
  "Vol/OI",
  "IV %",
  "Delta",
  "Gamma",
  "Theta",
  "Vega",
  "Quote Freshness",
  "Technical Signal",
  "Highlight",
];

/** Storage-key namespaces for the CSV artifacts (cf. the
 *  screener:xlsx: / options:xlsx: prefixes). */
export const SCREENER_CSV_KEY_PREFIX = "screener:csv:";
export const OPTIONS_CSV_KEY_PREFIX = "options:csv:";

/** Prefix validation, mirroring isGoalScreenArtifactKey: a stock
 *  CSV route/getter serves only screener:csv: keys, an options one
 *  only options:csv: keys — never another family's blob. */
export function isScreenerCsvKey(key: string): boolean {
  return key.startsWith(SCREENER_CSV_KEY_PREFIX);
}

export function isOptionsCsvKey(key: string): boolean {
  return key.startsWith(OPTIONS_CSV_KEY_PREFIX);
}

/** The goal-screen escape, verbatim (goalScreenReports.ts). */
function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return String(value);
}

/** Round like the XLSX num() helper; non-finite → empty. */
function num2(value: unknown, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(Number(value.toFixed(digits)))
    : "";
}

function num1(value: unknown): string {
  return num2(value, 1);
}

function num3(value: unknown): string {
  return num2(value, 3);
}

type Row = Record<string, any>;

/** One CSV row per screened stock, mirroring the XLSX row builder
 *  (same fallbacks, same rounding). */
function stockToRow(stock: Row): string[] {
  const t = (stock.technicals ?? {}) as Row;
  const grades = (stock.factorGrades ?? {}) as Row;
  const indicators = (stock.indicators ?? {}) as Row;
  const rsiVal = t.rsi14 ?? stock.rsi14;
  const gapVal = t.gapPercent != null ? Number(t.gapPercent.toFixed(2)) : null;
  const macdVal = t.macdHistogram != null ? Number(t.macdHistogram.toFixed(2)) : null;
  return [
    cell(stock.symbol),
    cell(stock.companyName || stock.symbol),
    cell(stock.sector || "Unknown"),
    num2(stock.lastPrice),
    num2(stock.changePercent),
    cell(gapVal),
    // #3932: sourced news sentiment or "-" — never the
    // price-derived day action, and never a "neutral" default.
    cell(indicators.sentiment != null ? String(indicators.sentiment).replace(/_/g, " ") : "-"),
    cell(grades.quantRating || "-"),
    cell(grades.value || "-"),
    cell(grades.momentum || "-"),
    cell(rsiVal != null ? Number(rsiVal.toFixed(1)) : null),
    cell(macdVal),
    cell(indicators.screenScore ?? null),
    cell(stock.peRatio != null ? Number(stock.peRatio.toFixed(1)) : null),
    cell(stock.signal || "-"),
    cell(stock.source || "E*TRADE live"),
  ];
}

/** One CSV row per matched contract, mirroring the XLSX row builder. */
function contractToRow(c: Row): string[] {
  return [
    cell(c.underlyingSymbol || c.symbol || ""),
    num2(c.underlyingPrice),
    cell(c.optionType || ""),
    num2(c.strikePrice),
    cell(c.expirationDate || ""),
    cell(c.daysToExpiration ?? null),
    cell(c.moneyness || ""),
    num2(c.bid),
    num2(c.ask),
    num2(c.lastPrice),
    num1(c.spreadPct),
    cell(c.volume ?? null),
    cell(c.openInterest ?? null),
    num2(c.volumeOiRatio),
    cell(
      typeof c.impliedVolatility === "number"
        ? Number((c.impliedVolatility * 100).toFixed(1))
        : null
    ),
    num3(c.delta),
    num3(c.gamma),
    num3(c.theta),
    num3(c.vega),
    cell(c.quoteFreshness || ""),
    cell(c.technicalSignal || ""),
    cell(c.highlightReason || ""),
  ];
}

function toCsv(columns: readonly string[], rows: string[][]): string {
  const lines = [columns.join(","), ...rows.map((row) => row.map(csvEscape).join(","))];
  return lines.join("\n") + "\n";
}

/**
 * Stock CSV: one row per screened stock (allStocks when present,
 * else opportunities — the XLSX tab's own fallback), header row
 * first, headers only at 0 records.
 */
export function generateScreenerCsv(result: ScreenerRunResult): string {
  const stocks: Row[] =
    result.allStocks && result.allStocks.length > 0
      ? (result.allStocks as Row[])
      : ((result.opportunities as unknown as Row[]) || []);
  return toCsv(SCREENER_CSV_COLUMNS, stocks.map(stockToRow));
}

/**
 * Options CSV: one row per matched contract, header row first,
 * headers only at 0 contracts (per #1346's acceptance — unlike
 * the XLSX placeholder row).
 */
export function generateOptionsCsv(result: OptionScreenResult): string {
  const contracts: Row[] = Array.isArray(result.contracts)
    ? (result.contracts as Row[])
    : [];
  return toCsv(OPTIONS_CSV_COLUMNS, contracts.map(contractToRow));
}

/** Mirrors screenerXlsxFileName, with a .csv extension. */
export function screenerCsvFileName(result: { universe?: string; timestamp?: string }): string {
  const ts = (result.timestamp || new Date().toISOString()).slice(0, 10);
  const u = (result.universe || "tech").toLowerCase();
  return `screener-report-${u}-${ts}.csv`;
}

/** Mirrors optionsXlsxFileName, with a .csv extension. */
export function optionsCsvFileName(result: { scannedAt?: string }): string {
  const ts = (result.scannedAt || new Date().toISOString()).slice(0, 10);
  return `options-report-${ts}.csv`;
}

/** Minimal RFC-4180 parser for tests/verification (handles quoted
 *  fields, doubled quotes, and LF endings). */
export function parseScreenerCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (ch === "\r") {
      // Tolerate CRLF input; generated output is LF-only.
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}
