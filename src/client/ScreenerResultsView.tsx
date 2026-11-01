/**
 * ScreenerResultsView (issue #261) — THE single results UI for screening.
 *
 * Used for both manual runs and scheduled runs. One backend (ScreenerAgent),
 * one frontend. Leads with what screening found (opportunities), not raw
 * listings. All columns sortable (click header to toggle asc/desc).
 *
 * Indicator methodology is E*TRADE-honest: computed from snapshot quotes
 * only. Range-based overbought/oversold is labeled as such — never as RSI.
 * RSI(14)/MACD need price history E*TRADE does not provide; shown as "—"
 * when unavailable rather than faked.
 */

import { useMemo, useState, type ReactElement } from "react";
import { downloadScreenExport } from "./runExport";
import { Button, Table, type TableColumn } from "./components/ui";
import { RegeneratePdfButton } from "./RegeneratePdfButton";

export interface StockTechnicalsData {
  rsi14: number | null;
  macdLine: number | null;
  macdSignalLine: number | null;
  macdHistogram: number | null;
  macdSignal: string | null;
  gapPercent: number | null;
  gapDirection: "up" | "down" | "flat" | null;
  historyBars: number;
  historySource: string | null;
}

export interface FactorGradesData {
  value: string | null;
  momentum: string | null;
  growth: null;
  profitability: null;
  revisions: null;
  quantRating: string | null;
  valueScore: number | null;
  momentumScore: number | null;
  compositeScore: number | null;
  gradedFactors: string[];
}

export interface ScreenedIndicatorsData {
  sentiment: string;
  directional: boolean;
  rangeZone: string;
  valueZone: string;
  screenScore: number;
  intradayPosition: number | null;
  rangePosition: number | null;
  summary: string;
}

export interface ScreenerResultData {
  timestamp: string;
  reportUrl?: string;
  /** Durable, per-run PDF key returned by ScreenerAgent. */
  pdfKey?: string;
  /** Issue #912: PDF generation status for error surfacing. */
  pdfStatus?: "generated" | "failed" | "skipped";
  pdfError?: string;
  /** Durable, per-run XLSX key returned by ScreenerAgent. */
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed" | "skipped";
  xlsxError?: string;
  xlsxUrl?: string;
  trigger: "manual" | "scheduled";
  sector: string;
  success: boolean;
  totalScanned: number;
  matchedCount: number;
  opportunities: Array<{
    symbol: string;
    companyName: string;
    signal: string;
    momentumScore: number;
    lastPrice: number;
    changePercent: number;
    indicators?: ScreenedIndicatorsData;
    factorGrades?: FactorGradesData;
    technicals?: StockTechnicalsData;
  }>;
  allStocks?: Array<{
    symbol: string;
    companyName: string;
    signal: string;
    momentumScore: number;
    lastPrice: number;
    changePercent: number;
    rsi14: number | null;
    source: string;
    indicators?: ScreenedIndicatorsData;
    factorGrades?: FactorGradesData;
    technicals?: StockTechnicalsData;
  }>;
  discoveryMessage?: string;
  /** Issue #462: qualification when the screen ran on a partial quote set. */
  partial?: {
    quotedCount: number;
    requestedCount: number;
    failedSymbols: string[];
    failureReasons: Record<string, number>;
  };
  /** Issue #816: quote pipeline trace for observability. */
  quoteTrace?: {
    traceId: string;
    symbolCount: number;
    batchCount: number;
    quotesReceived: number;
    quotesFailed: number;
    failuresByCategory: Record<string, number>;
    batches: Array<{
      batchIndex: number;
      symbolCount: number;
      httpStatus: number | null;
      quotesReceived: number;
      failures: Array<{ symbol: string; category: string; detail: string }>;
      durationMs: number;
    }>;
  };
  error?: string;
}

type OpportunityRow = ScreenerResultData["opportunities"][number];
type AllStockRow = NonNullable<ScreenerResultData["allStocks"]>[number];

type SortKey =
  | "symbol"
  | "lastPrice"
  | "changePercent"
  | "sentiment"
  | "screenScore"
  | "rangeZone"
  | "valueZone"
  | "momentumScore"
  | "rsi14"
  | "quantRating"
  | "valueGrade"
  | "momentumGrade"
  | "gapPercent";

const SENTIMENT_RANK: Record<string, number> = {
  very_bullish: 5,
  bullish: 4,
  neutral: 3,
  bearish: 2,
  very_bearish: 1,
};

const GRADE_RANK: Record<string, number> = {
  "A+": 12, "A": 11, "A-": 10,
  "B+": 9, "B": 8, "B-": 7,
  "C+": 6, "C": 5, "C-": 4,
  "D+": 3, "D": 2, "D-": 1, "F": 0,
};

const QUANT_RANK: Record<string, number> = {
  "Strong Buy": 5, "Buy": 4, "Hold": 3, "Sell": 2, "Strong Sell": 1,
};

const ZONE_RANK: Record<string, number> = {
  overbought: 3,
  neutral: 2,
  oversold: 1,
  overvalued: 3,
  fair: 2,
  undervalued: 1,
};

function sortValue(row: { indicators?: ScreenedIndicatorsData } & Record<string, any>, key: SortKey): number | string {
  switch (key) {
    case "symbol":
      return row.symbol;
    case "sentiment":
      return SENTIMENT_RANK[row.indicators?.sentiment ?? "neutral"] ?? 3;
    case "screenScore":
      return row.indicators?.screenScore ?? 0;
    case "rangeZone":
      return ZONE_RANK[row.indicators?.rangeZone ?? "neutral"] ?? 2;
    case "valueZone":
      return ZONE_RANK[row.indicators?.valueZone ?? "fair"] ?? 2;
    case "rsi14":
      return row.rsi14 ?? -1;
    case "quantRating":
      return QUANT_RANK[row.factorGrades?.quantRating ?? ""] ?? -1;
    case "valueGrade":
      return GRADE_RANK[row.factorGrades?.value ?? ""] ?? -1;
    case "momentumGrade":
      return GRADE_RANK[row.factorGrades?.momentum ?? ""] ?? -1;
    case "gapPercent":
      return row.technicals?.gapPercent ?? -999;
    default:
      return row[key] ?? 0;
  }
}

function useSortable<T extends Record<string, any>>(rows: T[], defaultKey: SortKey, defaultDir: 1 | -1 = -1) {
  const [sortKey, setSortKey] = useState<SortKey>(defaultKey);
  const [sortDir, setSortDir] = useState<1 | -1>(defaultDir);
  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (typeof va === "string" && typeof vb === "string")
        return sortDir * va.localeCompare(vb);
      return sortDir * (Number(va) - Number(vb));
    });
    return copy;
  }, [rows, sortKey, sortDir]);
  const toggle = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(-1);
    }
  };
  return { sorted, sortKey, sortDir, toggle };
}

/**
 * Derive aria-sort for sortable columns from their SortLabel headers
 * (#2283 stream 5): the Table primitive renders ariaSort on the <th>,
 * and the header already carries the sort key — so no per-column edit
 * is needed when columns are added. Non-sort headers pass through.
 */
function withSortAria<T>(columns: TableColumn<T>[], sortKey: SortKey, sortDir: 1 | -1): TableColumn<T>[] {
  return columns.map((col) => {
    const k = (col.header as ReactElement<{ k?: SortKey }> | undefined)?.props?.k;
    if (!k) return col;
    return {
      ...col,
      ariaSort: sortKey === k ? (sortDir === 1 ? "ascending" : "descending") : undefined,
    };
  });
}

function SortLabel({
  label,
  k,
  sortKey,
  sortDir,
  toggle,
  title,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: 1 | -1;
  toggle: (k: SortKey) => void;
  title?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => toggle(k)}
      title={title ?? `Sort by ${label}`}
      aria-label={`Sort by ${label}`}
    >
      {label}
      {sortKey === k && <span style={{ marginLeft: "0.25rem" }}>{sortDir === 1 ? "▲" : "▼"}</span>}
    </Button>
  );
}

function gradeColor(g: string | null | undefined): string {
  if (!g) return "var(--color-text-muted)";
  const top = g[0];
  if (top === "A") return "var(--color-success)";
  if (top === "B") return "var(--color-sentiment-bullish)";
  if (top === "C") return "var(--color-warning)";
  return "var(--color-danger)";
}

function GradeBadge({
  grade,
  withheldReason,
}: {
  grade: string | null | undefined;
  withheldReason?: string;
}) {
  if (!grade) {
    return (
      <span
        title={withheldReason ?? "Insufficient data — grade withheld, not estimated"}
        style={{ color: "var(--color-text-muted)", cursor: "help" }}
      >
        —
      </span>
    );
  }
  return (
    <span
      style={{
        display: "inline-block",
        minWidth: "2rem",
        textAlign: "center",
        padding: "var(--space-0-5) var(--space-1-5)",
        borderRadius: "4px",
        fontWeight: 700,
        fontSize: "var(--font-size-body-sm)",
        color: gradeColor(grade),
        border: `1px solid ${gradeColor(grade)}`,
      }}
    >
      {grade}
    </span>
  );
}

function quantRatingColor(r: string | null | undefined): string {
  if (!r) return "var(--color-text-muted)";
  if (r === "Strong Buy") return "var(--color-success)";
  if (r === "Buy") return "var(--color-sentiment-bullish)";
  if (r === "Hold") return "var(--color-warning)";
  if (r === "Sell") return "var(--color-sentiment-bearish)";
  return "var(--color-danger)";
}

function GapValue({ t }: { t?: StockTechnicalsData }) {
  if (t?.gapPercent == null) {
    return <span style={{ color: "var(--color-text-muted)" }} title="No history — gap unavailable">—</span>;
  }
  const arrow = t.gapDirection === "up" ? "▲" : t.gapDirection === "down" ? "▼" : "•";
  const color =
    t.gapDirection === "up"
      ? "var(--color-success)"
      : t.gapDirection === "down"
        ? "var(--color-danger)"
        : "var(--color-text-muted)";
  return (
    <span style={{ color, fontWeight: 600 }} title={`Overnight gap (Yahoo): ${t.gapPercent.toFixed(2)}%`}>
      {arrow} {t.gapPercent >= 0 ? "+" : ""}{t.gapPercent.toFixed(2)}%
    </span>
  );
}

function ChangeValue({ value }: { value: number }) {
  return (
    <span
      style={{
        color: value >= 0 ? "var(--color-success)" : "var(--color-danger)",
      }}
    >
      {value >= 0 ? "+" : ""}
      {value.toFixed(2)}%
    </span>
  );
}

function sentimentLabel(s?: string): string {
  return (s ?? "neutral").replace(/_/g, " ");
}

function sentimentColor(s?: string): string {
  switch (s) {
    case "very_bullish":
      return "var(--color-success)";
    case "bullish":
      return "var(--color-success)";
    case "very_bearish":
      return "var(--color-danger)";
    case "bearish":
      return "var(--color-danger)";
    default:
      return "var(--color-text-muted)";
  }
}

export function ScreenerResultsView({ result }: { result: ScreenerResultData }) {
  const triggerLabel = result.trigger === "manual" ? "Manual Screen" : "Autonomous Screen";
  // Issue #126 (PR-D): only THIS run's PDF — its own reportUrl, else
  // its per-run pdfKey (#297). When neither exists (this run's PDF
  // generation failed, or a failed run), there is NO PDF link: the
  // previous keyless fallback ("/api/screener/report.pdf" with no
  // key) serves the LATEST run's PDF, so the viewed run silently
  // downloaded a different run's report.
  const reportUrl = result.reportUrl || (result.pdfKey
    ? `/api/screener/report.pdf?key=${encodeURIComponent(result.pdfKey)}`
    : undefined);
  const xlsxUrl = result.xlsxUrl || (result.xlsxKey
    ? `/api/screener/report.xlsx?key=${encodeURIComponent(result.xlsxKey)}`
    : (result.pdfKey ? `/api/screener/report.xlsx?key=${encodeURIComponent(result.pdfKey)}` : undefined));
  const opps = useSortable(result.opportunities, "screenScore");
  const all = useSortable(result.allStocks ?? [], "screenScore");

  // Issue #125 (PR-B) / #126: result-set downloads of THIS run (the one
  // being viewed), beside the PDF report. A failed run produced no
  // result set, so it offers none; partial runs export with their #462
  // qualification carried into the file (see runExport.ts).

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "0.5rem" }}>
        {result.success && (
          <>
            <Button
            variant="accent"
            tone="subtle"
            size="sm"
              className="screener-export-csv"
              onClick={() => downloadScreenExport(result, "standouts")}
              title="Download this run's standout opportunities as CSV"
            >
              ⬇ CSV standouts
            </Button>
            {(result.allStocks?.length ?? 0) > 0 && (
              <Button
              variant="accent"
              tone="subtle"
              size="sm"
                className="screener-export-csv-all"
                onClick={() => downloadScreenExport(result, "all-stocks")}
                title="Download every symbol this run scanned as CSV"
              >
                ⬇ CSV all screened
              </Button>
            )}
            <Button
            variant="accent"
            tone="subtle"
            size="sm"
              className="screener-export-json"
              onClick={() => downloadScreenExport(result, "run-json")}
              title="Download this run's full result as JSON"
            >
              ⬇ JSON run
            </Button>
          </>
        )}
        {reportUrl && (
          <a
            href={reportUrl}
            download
            style={{
              fontSize: "var(--font-size-body-sm)",
              padding: "var(--space-1-5) var(--space-3)",
              borderRadius: "4px",
              border: "1px solid var(--color-accent)",
              color: "var(--color-accent)",
              textDecoration: "none",
            }}
          >
            📄 Download PDF report
          </a>
        )}
        {xlsxUrl && (
          <a
            href={xlsxUrl}
            download
            className="screener-download-xlsx"
            style={{
              fontSize: "var(--font-size-body-sm)",
              padding: "var(--space-1-5) var(--space-3)",
              borderRadius: "4px",
              border: "1px solid var(--color-accent)",
              color: "var(--color-accent)",
              textDecoration: "none",
            }}
          >
            📊 Download XLSX report
          </a>
        )}
        {/* Issue #912 / #1793: surface PDF generation status and offer recovery action */}
        {!reportUrl && result.pdfStatus === "failed" && (
          <span
            title={result.pdfError || "PDF generation failed"}
            style={{
              fontSize: "var(--font-size-body-sm)",
              padding: "var(--space-1-5) var(--space-3)",
              borderRadius: "4px",
              border: "1px solid var(--color-danger)",
              color: "var(--color-danger)",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-1-5)",
            }}
          >
            ⚠️ PDF failed: {result.pdfError ? result.pdfError.slice(0, 50) : "unknown error"}
            <RegeneratePdfButton />
          </span>
        )}
        {!reportUrl && !result.pdfStatus && result.success && (
          <span
            title="PDF report was not generated for this run"
            style={{
              fontSize: "var(--font-size-body-sm)",
              padding: "var(--space-1-5) var(--space-3)",
              borderRadius: "4px",
              border: "1px dashed var(--color-border-subtle)",
              color: "var(--color-text-muted)",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-1-5)",
            }}
          >
            ⚠️ PDF unavailable
            <RegeneratePdfButton />
          </span>
        )}
      </div>
      <div style={{ fontSize: "var(--font-size-body)", marginBottom: "0.5rem" }}>
        {/* Issue #421: no sector claim when none was selected ("ALL"). */}
        <strong>{triggerLabel}</strong>
        {result.sector && result.sector !== "ALL" && (
          <> • <strong>{result.sector}</strong> sector</>
        )}{" "}
        • {result.totalScanned.toLocaleString()} scanned • {result.matchedCount} matched •{" "}
        <span style={{ color: "var(--color-text-muted)" }}>
          {new Date(result.timestamp).toLocaleString()}
        </span>
        {!result.success && (
          <span style={{ color: "var(--color-danger)", marginLeft: "0.5rem" }}>
            ⚠️ Failed: {result.error || "E*TRADE unavailable"}
          </span>
        )}
      </div>

      {result.success && result.partial && (
        <div
          style={{
            fontSize: "var(--font-size-body)",
            color: "var(--color-warning-text)",
            padding: "var(--space-3)",
            border: "1px solid var(--color-warning-border)",
            borderRadius: "4px",
            marginBottom: "0.5rem",
          }}
        >
          ⚠️ Partial screen — qualified results: {result.partial.quotedCount} of {result.partial.requestedCount} symbols quoted;{" "}
          {result.partial.failedSymbols.length} unavailable ({result.partial.failedSymbols.slice(0, 5).join(", ")}
          {result.partial.failedSymbols.length > 5 ? "…" : ""}). Results cover the quoted subset only; no fallback data substituted.
        </div>
      )}

      {/* Issue #816: Quote Pipeline trace section */}
      {result.quoteTrace && (
        <details
          style={{
            fontSize: "var(--font-size-body)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "4px",
            padding: "var(--space-3)",
            marginBottom: "0.5rem",
            background: "var(--color-surface-sunken)",
          }}
        >
          <summary style={{ cursor: "pointer", fontWeight: 700, color: "var(--color-text-primary)" }}>
            🔍 Quote Pipeline: {result.quoteTrace.quotesReceived} of {result.quoteTrace.symbolCount} quoted
            {result.quoteTrace.quotesFailed > 0 && (
              <span style={{ color: "var(--color-warning)", marginLeft: "0.5rem" }}>
                ({result.quoteTrace.quotesFailed} failed)
              </span>
            )}
            {result.quoteTrace.quotesReceived === 0 && (
              <span style={{ color: "var(--color-warning)", marginLeft: "0.5rem", fontWeight: 500 }}>
                • Off-market hours (live feed closed)
              </span>
            )}
          </summary>
          <div style={{ marginTop: "0.5rem", fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
            {result.quoteTrace.quotesReceived === 0 && (
              <div style={{ marginBottom: "0.4rem", color: "var(--color-warning)" }}>
                ℹ️ 0 quotes received — Live quotes are unavailable outside market hours or when the exchange feed is closed.
              </div>
            )}
            <div>Trace ID: <code>{result.quoteTrace.traceId}</code></div>
            <div>Batches: {result.quoteTrace.batchCount} · Received: {result.quoteTrace.quotesReceived} · Failed: {result.quoteTrace.quotesFailed}</div>
            {Object.entries(result.quoteTrace.failuresByCategory).filter(([_, v]) => v > 0).length > 0 && (
              <div style={{ marginTop: "0.25rem" }}>
                Failures by category:{" "}
                {Object.entries(result.quoteTrace.failuresByCategory)
                  .filter(([_, v]) => v > 0)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(", ")}
              </div>
            )}
          </div>
        </details>
      )}

      {!result.success ? (
        <div
          style={{
            fontSize: "var(--font-size-body)",
            color: "var(--color-danger)",
            padding: "var(--space-3)",
            border: "1px solid var(--color-danger)",
            borderRadius: "4px",
          }}
        >
          {result.error || "E*TRADE unavailable — no market data. No fallback data substituted."}
        </div>
      ) : (
        <>
          {result.opportunities.length > 0 ? (
              <Table
                containerClassName="options-table-scroll"
                columns={withSortAria<OpportunityRow>([
                  { key: "symbol", header: <SortLabel label="Symbol" k="symbol" {...opps} />, render: (o) => (<><strong>{o.symbol}</strong>{o.indicators?.directional && (<span title="Strong directional move (|change| ≥ 2%)" style={{ marginLeft: "0.3rem" }}>⚡</span>)}</>) },
                  { key: "company", header: "Company", render: (o) => o.companyName },
                  { key: "sentiment", header: <SortLabel label="Sentiment" k="sentiment" {...opps} title="Day-action sentiment: very bearish → very bullish" />, render: (o) => (<span style={{ color: sentimentColor(o.indicators?.sentiment), fontWeight: 600 }}>{sentimentLabel(o.indicators?.sentiment)}</span>) },
                  { key: "score", header: <SortLabel label="Score" k="screenScore" {...opps} title="Composite 0-100 screening score (heuristic)" />, render: (o) => (<strong>{o.indicators?.screenScore ?? "—"}</strong>) },
                  { key: "quant", header: <SortLabel label="Quant" k="quantRating" {...opps} title="Quant rating from graded factors (Strong Buy → Strong Sell)" />, render: (o) => (<span style={{ color: quantRatingColor(o.factorGrades?.quantRating), fontWeight: 700, whiteSpace: "nowrap" }}>{o.factorGrades?.quantRating ?? "—"}</span>) },
                  { key: "value", header: <SortLabel label="Val" k="valueGrade" {...opps} title="Value factor grade A+…F (P/E + 52-week position, relative)" />, render: (o) => (<GradeBadge grade={o.factorGrades?.value} />) },
                  { key: "momentum", header: <SortLabel label="Mom" k="momentumGrade" {...opps} title="Momentum factor grade A+…F (relative)" />, render: (o) => (<GradeBadge grade={o.factorGrades?.momentum} />) },
                  { key: "price", header: <SortLabel label="Price" k="lastPrice" {...opps} />, render: (o) => ("$" + o.lastPrice.toFixed(2)) },
                  { key: "change", header: <SortLabel label="Change" k="changePercent" {...opps} />, render: (o) => (<ChangeValue value={o.changePercent} />) },
                  { key: "gap", header: <SortLabel label="Gap" k="gapPercent" {...opps} title="Overnight gap % (open vs prev close, Yahoo)" />, render: (o) => (<GapValue t={o.technicals} />) },
                  { key: "range", header: <SortLabel label="Range" k="rangeZone" {...opps} title="Range-based overbought/oversold (52-week position, not RSI)" />, render: (o) => (o.indicators?.rangeZone ?? "—") },
                  { key: "valueZone", header: <SortLabel label="Value" k="valueZone" {...opps} title="Heuristic value zone (P/E + 52-week position)" />, render: (o) => (o.indicators?.valueZone ?? "—") },
                ], opps.sortKey, opps.sortDir)}
                rows={opps.sorted}
                rowKey={(o) => o.symbol}
              />
          ) : (
            <div style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)" }}>
              No standout opportunities in this run.
            </div>
          )}

          {(result.allStocks?.length ?? 0) > 0 && (
            <details style={{ marginTop: "0.75rem" }}>
              <summary
                style={{
                  fontSize: "var(--font-size-body)",
                  cursor: "pointer",
                  color: "var(--color-accent)",
                }}
              >
                All {result.allStocks!.length} screened symbols (click column headers to sort)
              </summary>
              <div className="options-table-scroll" style={{ marginTop: "0.5rem" }}>
                <Table
                  columns={withSortAria<AllStockRow>([
                    { key: "symbol", header: <SortLabel label="Symbol" k="symbol" {...all} />, render: (s) => (<><strong>{s.symbol}</strong>{s.indicators?.directional && (<span title="Strong directional move" style={{ marginLeft: "0.3rem" }}>⚡</span>)}</>) },
                    { key: "company", header: "Company", render: (s) => s.companyName },
                    { key: "price", header: <SortLabel label="Price" k="lastPrice" {...all} />, render: (s) => ("$" + s.lastPrice.toFixed(2)) },
                    { key: "change", header: <SortLabel label="Change" k="changePercent" {...all} />, render: (s) => (<ChangeValue value={s.changePercent} />) },
                    { key: "gap", header: <SortLabel label="Gap" k="gapPercent" {...all} title="Overnight gap % (Yahoo)" />, render: (s) => (<GapValue t={s.technicals} />) },
                    { key: "sentiment", header: <SortLabel label="Sentiment" k="sentiment" {...all} />, render: (s) => (<span style={{ color: sentimentColor(s.indicators?.sentiment) }}>{sentimentLabel(s.indicators?.sentiment)}</span>) },
                    { key: "score", header: <SortLabel label="Score" k="screenScore" {...all} />, render: (s) => (<strong>{s.indicators?.screenScore ?? "—"}</strong>) },
                    { key: "quant", header: <SortLabel label="Quant" k="quantRating" {...all} />, render: (s) => (<span style={{ color: quantRatingColor(s.factorGrades?.quantRating), fontWeight: 700, whiteSpace: "nowrap" }}>{s.factorGrades?.quantRating ?? "—"}</span>) },
                    { key: "value", header: <SortLabel label="Val" k="valueGrade" {...all} />, render: (s) => (<GradeBadge grade={s.factorGrades?.value} />) },
                    { key: "momentum", header: <SortLabel label="Mom" k="momentumGrade" {...all} />, render: (s) => (<GradeBadge grade={s.factorGrades?.momentum} />) },
                    { key: "momentumScore", header: <SortLabel label="Momentum" k="momentumScore" {...all} />, render: (s) => s.momentumScore.toFixed(0) },
                    { key: "range", header: <SortLabel label="Range" k="rangeZone" {...all} title="Range-based (52-week position), not RSI" />, render: (s) => (s.indicators?.rangeZone ?? "—") },
                    { key: "valueZone", header: <SortLabel label="Value" k="valueZone" {...all} />, render: (s) => (s.indicators?.valueZone ?? "—") },
                    { key: "rsi", header: <SortLabel label="RSI(14)" k="rsi14" {...all} title="Real RSI(14) from Yahoo daily history" />, render: (s) => (<span title={s.technicals?.historySource ? `RSI(14) from ${s.technicals.historySource} (${s.technicals.historyBars} bars)` : "No history — RSI unavailable"}>{s.rsi14 == null ? "—" : s.rsi14.toFixed(1)}</span>) },
                    { key: "macd", header: (<span title="MACD(12,26,9) from Yahoo daily history">MACD</span>), render: (s) => (<span style={{ fontSize: "0.75rem" }} title={s.technicals?.macdSignal ?? "No history — MACD unavailable"}>{s.technicals?.macdHistogram == null ? "—" : `${s.technicals.macdHistogram >= 0 ? "+" : ""}${s.technicals.macdHistogram.toFixed(2)}`}</span>) },
                    { key: "source", header: "Source", render: (s) => (<span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>{s.source}</span>) },
                  ], all.sortKey, all.sortDir)}
                  rows={all.sorted}
                  rowKey={(s) => s.symbol}
                />
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
