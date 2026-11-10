/**
 * Screener XLSX multi-tab report generator.
 *
 * Produces an Excel (.xlsx) workbook with:
 *   - Tab 1: "Screened Stocks" — all screened symbols and all columns shown on the UI
 *   - Tab 2: "Formulas & Methodology" — complete documentation of every formula,
 *     data source, indicator threshold, and factor scoring rubric.
 */

import * as XLSX from "@e965/xlsx";
import type { ScreenerRunResult } from "../agents/screener-agent";
import type { ScannedStock } from "../trading/screenerPipeline";

export interface ColumnFormulaDocumentation {
  columnName: string;
  fieldKey: string;
  provenance: string;
  formula: string;
  description: string;
}

export const SCREENER_FORMULA_DOCUMENTATION: ColumnFormulaDocumentation[] = [
  {
    columnName: "Symbol",
    fieldKey: "symbol",
    provenance: "Nasdaq Official Listings Feed (api.nasdaq.com)",
    formula: "Normalized uppercase equity ticker symbol (e.g., NVDA, AAPL)",
    description: "Primary tradable identifier across exchanges (NASDAQ, NYSE, AMEX).",
  },
  {
    columnName: "Company Name",
    fieldKey: "companyName",
    provenance: "E*TRADE Live Quote / Nasdaq Listing Directory",
    formula: "String company name stripped of excess legal suffixes",
    description: "Official issuer legal name or corporate entity description.",
  },
  {
    columnName: "Price",
    fieldKey: "lastPrice",
    provenance: "E*TRADE Live REST API Quote (v1/market/quote)",
    formula: "quote.lastPrice (Real-time snapshot, fallback data prohibited)",
    description: "Most recent execution price from primary market feeds in USD.",
  },
  {
    columnName: "Chg%",
    fieldKey: "changePercent",
    provenance: "E*TRADE Live REST API Quote",
    formula: "((lastPrice - previousClose) / previousClose) * 100",
    description: "Percentage price change relative to previous official exchange regular-session close.",
  },
  {
    columnName: "Gap%",
    fieldKey: "technicals.gapPercent",
    provenance: "Yahoo Finance Daily History (query1/query2.finance.yahoo.com)",
    formula: "((todayOpen - prevClose) / prevClose) * 100",
    description: "Overnight gap between prior regular-session close and today's regular-session open.",
  },
  {
    columnName: "Sentiment",
    fieldKey: "indicators.sentiment",
    // #3932 — sourced, not price-derived: the sentiment job's
    // persisted Yahoo News rows, LLM-classified per headline
    // and aggregated per symbol (mean of +1/0/-1, bullish at
    // >= +1/3, bearish at <= -1/3, else neutral). "-" when no
    // persisted copy covers the symbol. The price-derived
    // day-action label is a different field (indicators.dayAction)
    // and is never presented as sentiment.
    provenance: "Yahoo News (query2.finance.yahoo.com/v1/finance/search), persisted sentiment dataset",
    formula: "Per headline: LLM classifies bullish (+1) / neutral (0) / bearish (-1); per symbol: score = mean(headline scores), label bullish if score >= +1/3, bearish if score <= -1/3, else neutral",
    description: "Sourced news sentiment from the persisted sentiment dataset (Yahoo News headlines, LLM-classified); '-' when no persisted copy covers the symbol.",
  },
  {
    columnName: "Quant Rating",
    fieldKey: "factorGrades.quantRating",
    provenance: "Multi-Factor Scoring Composite",
    formula: "Composite Score: 35% Momentum + 25% Value + 20% Sentiment + 20% Trend Consistency. Thresholds: >=80 'Strong Buy', 60-79 'Buy', 40-59 'Hold', 20-39 'Sell', <20 'Strong Sell'",
    description: "Systematic multi-factor assessment ranking the stock relative to peer universe.",
  },
  {
    columnName: "Value Grade",
    fieldKey: "factorGrades.value",
    provenance: "Valuation Multiples & 52-Week Range Positioning",
    formula: "Weighted: 60% P/E ratio relative to peer sector median + 40% 52-week price range position ((Price - 52W_Low)/(52W_High - 52W_Low)). Grades A+ to F across 10 percentile bins.",
    description: "Relative valuation grade against universe peers. A+/A indicates strong undervaluation or favorable multiple.",
  },
  {
    columnName: "Momentum Grade",
    fieldKey: "factorGrades.momentum",
    provenance: "RSI-14 Velocity & Daily Price Trajectory",
    formula: "Weighted: 60% RSI-14 momentum distance + 40% daily change velocity. Normalized percentile rank A+ to F.",
    description: "Relative price momentum and trend strength across the scanned universe.",
  },
  {
    columnName: "RSI-14",
    fieldKey: "rsi14 / technicals.rsi14",
    provenance: "Yahoo Finance Daily Close History",
    formula: "Wilder's RSI(14) = 100 - (100 / (1 + RS)), where RS = Average Gain(14) / Average Loss(14) over daily bars",
    description: "14-day Relative Strength Index. Values < 35 denote oversold conditions; values > 70 denote overbought.",
  },
  {
    columnName: "MACD Histogram",
    fieldKey: "technicals.macdHistogram",
    provenance: "Yahoo Finance Daily Close History",
    formula: "MACD Line = EMA(12) - EMA(26); Signal Line = EMA(9) of MACD Line; Histogram = MACD Line - Signal Line",
    description: "Moving Average Convergence Divergence momentum spread. Positive denotes bullish convergence.",
  },
  {
    columnName: "Score",
    fieldKey: "indicators.screenScore",
    provenance: "Composite Opportunity Rating (0-100)",
    formula: "Weighted composite: Momentum (0-35 pts) + Valuation (0-25 pts) + Technical Alignment (0-20 pts) + Volume/Liquidity (0-20 pts)",
    description: "Master multi-attribute screener score; used as primary ranking criterion on UI.",
  },
  {
    columnName: "Sector",
    fieldKey: "sector",
    provenance: "Curated Industry Registry & Inferred Corporate Taxonomy",
    formula: "Curated security taxonomy map -> Regex name inference (Semiconductors, Technology, Financial, Healthcare, Energy, Consumer, etc.) -> Default: none (shown as Unknown)",
    description: "Macro industrial sector used for universe categorization and peer-group normalization.",
  },
  {
    columnName: "P/E Ratio",
    fieldKey: "peRatio",
    provenance: "E*TRADE Live Quote / SEC EDGAR filings",
    formula: "Price / Trailing Twelve Months Diluted EPS",
    description: "Price to Earnings multiple reflecting valuation expectations.",
  },
  {
    columnName: "Technical Signal",
    fieldKey: "signal",
    provenance: "Multi-indicator rule evaluation",
    formula: "IF RSI < 35 -> 'OVERSOLD_BOUNCE'; IF RSI > 70 -> 'OVERBOUGHT'; IF changePercent > 0.5% -> 'BULLISH_MOMENTUM'; ELSE -> 'RANGE_BOUND'",
    description: "Actionable summary state for trade execution and options flow routing.",
  },
  {
    columnName: "Data Source",
    fieldKey: "source",
    provenance: "Execution telemetry audit trail",
    formula: "Literal quote source: 'E*TRADE live' + 'Yahoo Finance complement'",
    description: "Data provenance ensuring auditability and compliance with quote policies.",
  },
];

/**
 * Generate a multi-tab XLSX binary buffer for a screener run.
 */
export function generateScreenerXlsx(result: ScreenerRunResult): Uint8Array {
  const wb = XLSX.utils.book_new();

  // Tab 1: Screened Stocks
  const stocks: ScannedStock[] = result.allStocks && result.allStocks.length > 0
    ? result.allStocks
    : (result.opportunities as any[] || []);

  const stockRows = stocks.map((s) => {
    const t = s.technicals;
    const rsiVal = t?.rsi14 ?? s.rsi14;
    const gapVal = t?.gapPercent != null ? Number(t.gapPercent.toFixed(2)) : null;
    const macdVal = t?.macdHistogram != null ? Number(t.macdHistogram.toFixed(2)) : null;

    return {
      "Symbol": s.symbol,
      "Company Name": s.companyName || s.symbol,
      "Sector": s.sector || "Unknown",
      "Price": Number(s.lastPrice.toFixed(2)),
      "Chg%": Number(s.changePercent.toFixed(2)),
      "Gap%": gapVal,
      // #3932: sourced news sentiment or "-" — never the
      // price-derived day action, and never a "neutral" default.
      "Sentiment": s.indicators?.sentiment != null ? s.indicators.sentiment.replace(/_/g, " ") : "-",
      "Quant Rating": s.factorGrades?.quantRating || "-",
      "Value Grade": s.factorGrades?.value || "-",
      "Momentum Grade": s.factorGrades?.momentum || "-",
      "RSI-14": rsiVal != null ? Number(rsiVal.toFixed(1)) : null,
      "MACD Histogram": macdVal,
      "Score": s.indicators?.screenScore ?? null,
      "P/E Ratio": s.peRatio != null ? Number(s.peRatio.toFixed(1)) : null,
      "Technical Signal": s.signal || "-",
      "Data Source": s.source || "E*TRADE live",
    };
  });

  const wsStocks = XLSX.utils.json_to_sheet(stockRows);

  // Set standard column widths for clean readability
  wsStocks["!cols"] = [
    { wch: 10 }, // Symbol
    { wch: 28 }, // Company Name
    { wch: 22 }, // Sector
    { wch: 10 }, // Price
    { wch: 10 }, // Chg%
    { wch: 10 }, // Gap%
    { wch: 14 }, // Sentiment
    { wch: 14 }, // Quant Rating
    { wch: 12 }, // Value Grade
    { wch: 15 }, // Momentum Grade
    { wch: 10 }, // RSI-14
    { wch: 15 }, // MACD Histogram
    { wch: 10 }, // Score
    { wch: 12 }, // P/E Ratio
    { wch: 20 }, // Technical Signal
    { wch: 18 }, // Data Source
  ];

  XLSX.utils.book_append_sheet(wb, wsStocks, "Screened Stocks");

  // Tab 2: Formulas & Methodology
  const formulaRows = SCREENER_FORMULA_DOCUMENTATION.map((item) => ({
    "Column Name": item.columnName,
    "Field Key": item.fieldKey,
    "Data Source / Provenance": item.provenance,
    "Calculation Formula": item.formula,
    "Description & Interpretation": item.description,
  }));

  const wsFormulas = XLSX.utils.json_to_sheet(formulaRows);
  wsFormulas["!cols"] = [
    { wch: 18 }, // Column Name
    { wch: 22 }, // Field Key
    { wch: 32 }, // Data Source / Provenance
    { wch: 55 }, // Calculation Formula
    { wch: 45 }, // Description & Interpretation
  ];

  XLSX.utils.book_append_sheet(wb, wsFormulas, "Formulas & Methodology");

  // Output as Uint8Array
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new Uint8Array(buffer);
}

/**
 * Generate standard filename for a screener run's XLSX report.
 */
export function screenerXlsxFileName(result: { universe?: string; timestamp?: string }): string {
  const ts = (result.timestamp || new Date().toISOString()).slice(0, 10);
  const u = (result.universe || "tech").toLowerCase();
  return `screener-report-${u}-${ts}.xlsx`;
}

/** Helper for tests */
export function parseScreenerXlsx(bytes: Uint8Array): XLSX.WorkBook {
  return XLSX.read(bytes, { type: "array" });
}
