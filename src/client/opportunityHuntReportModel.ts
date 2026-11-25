/**
 * Issue 6479 — the Opportunity Hunt report's ONE view model.
 *
 * The page (Opportunity Hunt panel) and the downloadable PDF used to decide
 * their own content: each grouped the result, formatted the rows, and worded
 * the notes. They happened to agree, but nothing failed when one changed. This
 * module is the single content source both renderers read: summary headline,
 * counts narrative, holdings/no-setups notes, table cells, per-symbol section
 * text, chart selections, and methodology. The pin in
 * `tests/opportunity_hunt_report_sync_6479.test.tsx` renders both surfaces from
 * the same model and fails if either bypasses it.
 *
 * Pure: the same `OpportunityHuntResult` always produces the same model, and
 * `summary` is computed here rather than trusted from the posted field, so a
 * stale/malformed summary cannot make one surface disagree with the other.
 */
import {
  huntCountsExplanation,
  huntSummary,
  type OpportunityHuntResult,
} from "../services/opportunityHunt";
import { OPPORTUNITY_HUNT_PATTERN_CHART_TOP_N } from "../config/opportunityHuntLevels";
import { formatReportTimestamp } from "../services/reportTimestamp";
import {
  formatHuntPct,
  formatHuntPrice,
  groupHuntSetupsBySymbol,
  type OpportunityHuntSymbolRow,
} from "./opportunityHuntView";

/** One table row, already formatted — the PDF's cells and the page's numbers. */
export interface OpportunityHuntReportTableRow {
  symbol: string;
  patterns: string;
  entries: string;
  exits: string;
  entryRange: string;
  stopLoss: string;
  takeProfit: string;
  lastClose: string;
}

/** One per-symbol detail section, already worded — both renderers print these. */
export interface OpportunityHuntReportSection {
  symbol: string;
  heading: string;
  lastCloseLine: string;
  noSetupNote: string | null;
  entryHeading: string;
  entryLines: readonly string[];
  exitHeading: string;
  exitLines: readonly string[];
  closes: readonly number[];
  row: OpportunityHuntSymbolRow;
}

/** One bar of the "Setups by strategy" chart. */
export interface OpportunityHuntStrategyBar {
  label: string;
  value: number;
  side: "entry" | "exit";
}

/** One bar of the "Pattern count by symbol" chart (top N). */
export interface OpportunityHuntPatternBar {
  symbol: string;
  count: number;
}

export interface OpportunityHuntReportModel {
  title: string;
  asOfIso: string;
  asOfLabel: string;
  summary: string;
  /** The "Scanned / Setups / …" counts line under Summary. */
  summaryCountsLine: string;
  countsHeading: string;
  countsExplanation: string;
  holdingsAvailable: boolean | null;
  holdingsHeading: string | null;
  holdingsNote: string | null;
  noSetupsNote: string | null;
  strategyBars: readonly OpportunityHuntStrategyBar[];
  patternChartTitle: string;
  patternBars: readonly OpportunityHuntPatternBar[];
  tableHeading: string;
  tableRows: readonly OpportunityHuntReportTableRow[];
  sections: readonly OpportunityHuntReportSection[];
  methodology: readonly string[];
}

const COUNTS_HEADING = "How the counts add up";
const ENTRY_HEADING = "Entry recommendations";
const EXIT_HEADING = "Exit recommendations";
const NO_SETUP_NOTE =
  "No setup — this symbol was evaluated and no strategy produced an entry or exit signal.";

/** The report's methodology footer — one wording for both surfaces. */
const METHODOLOGY: readonly string[] = [
  "Data: the hunt evaluates the pattern strategies over the tradable universe's daily closes from the persisted technicals bars; a hunt that finds nothing is a completed hunt, not an error.",
  "Exits: evaluated against the tenant's holdings from the selected broker (long equity with a known cost basis only); an unavailable holdings read degrades to entries only with the reason stated, never a silent drop.",
  "Levels: entry range, stop-loss, and take-profit are recommendation levels derived from the latest close with the per-strategy percentages in the externalized levels config — they are not the evaluator's exit triggers.",
  "This report renders the same output the Opportunity Hunt panel shows: one row per evaluated symbol, pattern count, entry and exit signals grouped per entry and per exit, with their price ranges.",
];

function strategyList(setups: OpportunityHuntSymbolRow["entries"]): string {
  return setups.length > 0 ? setups.map((setup) => setup.strategy).join(", ") : "—";
}

function entryRangeText(row: OpportunityHuntSymbolRow): string {
  return row.entryLow !== null && row.entryHigh !== null
    ? `${formatHuntPrice(row.entryLow)} – ${formatHuntPrice(row.entryHigh)}`
    : "—";
}

function sectionFor(row: OpportunityHuntSymbolRow): OpportunityHuntReportSection {
  const hasSetup = row.patternCount > 0;
  const gainText =
    row.exitGainPct !== null
      ? ` · exits ${formatHuntPct(row.exitGainPct)} vs cost basis`
      : "";
  return {
    symbol: row.symbol,
    heading: `${row.symbol} — ${hasSetup ? "recommendations" : "no setup"}`,
    lastCloseLine: `Last close ${formatHuntPrice(row.lastClose)}${gainText}.`,
    noSetupNote: hasSetup ? null : NO_SETUP_NOTE,
    entryHeading: ENTRY_HEADING,
    entryLines: row.entries.map((setup) => {
      const levels = setup.levels
        ? ` — enter ${formatHuntPrice(setup.levels.entryLow)} – ${formatHuntPrice(setup.levels.entryHigh)}, stop-loss ${formatHuntPrice(setup.levels.stopLoss)}, take-profit ${formatHuntPrice(setup.levels.takeProfit)}`
        : "";
      return `• ${setup.strategy}: ${setup.detail}${levels}.`;
    }),
    exitHeading: EXIT_HEADING,
    exitLines: row.exits.map((setup) => {
      const gain = setup.entryPrice
        ? ` (${formatHuntPct((setup.lastClose - setup.entryPrice) / setup.entryPrice)})`
        : "";
      return `• ${setup.strategy}: ${setup.detail} — exit at ${formatHuntPrice(setup.lastClose)}, entered at ${formatHuntPrice(setup.entryPrice)}${gain}.`;
    }),
    closes: row.closes,
    row,
  };
}

/** Build the report content once. Pure; the page and the PDF both read this. */
export function buildOpportunityHuntReportModel(
  result: OpportunityHuntResult,
): OpportunityHuntReportModel {
  const rows = groupHuntSetupsBySymbol(result);
  const entries = result.setups.filter((setup) => setup.direction === "entry");
  const exits = result.setups.filter((setup) => setup.direction === "exit");
  const symbolsWithSetups = rows.filter((row) => row.patternCount > 0).length;
  const status = result.holdingsStatus;
  const skipped = result.skipped > 0 ? `   Skipped (short history): ${result.skipped}` : "";

  const holdingsNote =
    status && !status.available
      ? `The hunt ran on entries only: the holdings read did not report${status.broker ? ` for ${status.broker}` : ""}${status.reason ? ` — ${status.reason}` : ""}. No exit was silently dropped; there was nothing held to evaluate.`
      : status?.available
        ? `Exits evaluated against holdings from the selected broker${status.broker ? ` (${status.broker})` : ""}.`
        : null;

  const strategies = [...new Set(result.setups.map((setup) => setup.strategy))].sort();
  const strategyBars: OpportunityHuntStrategyBar[] = [];
  for (const strategy of strategies) {
    const entryCount = entries.filter((setup) => setup.strategy === strategy).length;
    const exitCount = exits.filter((setup) => setup.strategy === strategy).length;
    if (entryCount > 0) {
      strategyBars.push({
        label: `${strategy} — entries`,
        value: entryCount,
        side: "entry",
      });
    }
    if (exitCount > 0) {
      strategyBars.push({
        label: `${strategy} — exits`,
        value: exitCount,
        side: "exit",
      });
    }
  }

  const byPatterns = [...rows].sort(
    (a, b) => b.patternCount - a.patternCount || a.symbol.localeCompare(b.symbol),
  );
  const patternBars = byPatterns
    .slice(0, OPPORTUNITY_HUNT_PATTERN_CHART_TOP_N)
    .map((row) => ({ symbol: row.symbol, count: row.patternCount }));

  return {
    title: "Opportunity Hunt Report",
    asOfIso: result.asOf,
    asOfLabel: formatReportTimestamp(result.asOf),
    summary: huntSummary(result),
    summaryCountsLine: `Scanned: ${result.scanned} symbol(s)   Setups: ${result.setups.length}   Entries: ${entries.length}   Exits: ${exits.length}   Symbols evaluated: ${rows.length}   Symbols with setups: ${symbolsWithSetups}${skipped}`,
    countsHeading: COUNTS_HEADING,
    countsExplanation: huntCountsExplanation(result),
    holdingsAvailable: status?.available ?? null,
    holdingsHeading:
      status && !status.available
        ? "Exit signals unavailable"
        : status?.available
          ? "Exit signals evaluated"
          : null,
    holdingsNote,
    noSetupsNote:
      result.setups.length === 0
        ? `The latest bar produced no entry or exit signal for any of the ${rows.length} evaluated symbol(s).`
        : null,
    strategyBars,
    patternChartTitle: `Pattern count by symbol (top ${patternBars.length} of ${rows.length} evaluated)`,
    patternBars,
    tableHeading: `Symbols evaluated (${rows.length})`,
    tableRows: rows.map((row) => ({
      symbol: row.symbol,
      patterns: String(row.patternCount),
      entries: strategyList(row.entries),
      exits: strategyList(row.exits),
      entryRange: entryRangeText(row),
      stopLoss: formatHuntPrice(row.stopLoss),
      takeProfit: formatHuntPrice(row.takeProfit),
      lastClose: formatHuntPrice(row.lastClose),
    })),
    sections: rows.map(sectionFor),
    methodology: METHODOLOGY,
  };
}
