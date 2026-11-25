/**
 * Issue 6406 — the Opportunity Hunt report-style view's pure helpers.
 *
 * Grouping, sorting, and chart labels live here so they are unit-testable
 * without rendering the panel. The panel is a thin view over these rows.
 */
import type {
  OpportunityHuntResult,
  OpportunityHuntSetup,
} from "../services/opportunityHunt";

/** One row of the report-style table: one symbol, all its setups. */
export interface OpportunityHuntSymbolRow {
  symbol: string;
  setups: OpportunityHuntSetup[];
  /** Distinct pattern strategies firing for this symbol. */
  patternCount: number;
  entries: OpportunityHuntSetup[];
  exits: OpportunityHuntSetup[];
  /** Latest close — the same bar for every strategy on the symbol. */
  lastClose: number;
  /**
   * The evaluated symbol's trailing closes, oldest → newest (capped by the
   * hunt) — the one series the page's sparkline/dialog and the PDF's price
   * chart draw from. Issue 6478: present for every evaluated symbol, not only
   * the ones with a setup.
   */
  closes: readonly number[];
  /** Entry range rolled up across the symbol's entries (min low → max high). */
  entryLow: number | null;
  entryHigh: number | null;
  /** Tightest stop-loss across the symbol's entries. */
  stopLoss: number | null;
  /** Highest take-profit across the symbol's entries. */
  takeProfit: number | null;
  /** Exit price (latest close) for the symbol's exits. */
  exitPrice: number | null;
  /** Mean gain vs cost basis across the symbol's exits, as a fraction. */
  exitGainPct: number | null;
}

export function groupHuntSetupsBySymbol(
  result: OpportunityHuntResult,
): OpportunityHuntSymbolRow[] {
  const bySymbol = new Map<string, OpportunityHuntSetup[]>();
  for (const setup of result.setups ?? []) {
    const list = bySymbol.get(setup.symbol) ?? [];
    list.push(setup);
    bySymbol.set(setup.symbol, list);
  }
  // Issue 6478 — the report is over the EVALUATED universe. A symbol with no
  // setup is still a row (pattern count 0) with its chart series; otherwise
  // the report silently answers "what fired" instead of "what was evaluated".
  const symbols = new Set<string>(Object.keys(result.seriesBySymbol ?? {}));
  for (const symbol of bySymbol.keys()) symbols.add(symbol);
  const rows: OpportunityHuntSymbolRow[] = [];
  for (const symbol of symbols) {
    const setups = bySymbol.get(symbol) ?? [];
    const closes = result.seriesBySymbol?.[symbol] ?? [];
    const entries = setups.filter((s) => s.direction === "entry");
    const exits = setups.filter((s) => s.direction === "exit");
    // A no-setup row's latest close comes from its series (there is no setup
    // carrying it); a legacy result without a series falls back to the setup.
    const lastClose =
      setups[0]?.lastClose ?? closes[closes.length - 1] ?? NaN;
    const entryLevels = entries
      .map((s) => s.levels)
      .filter((l): l is NonNullable<typeof l> => !!l);
    const exitGains = exits
      .map((s) => (s.entryPrice ? (lastClose - s.entryPrice) / s.entryPrice : null))
      .filter((g): g is number => g !== null);
    rows.push({
      symbol,
      setups: [...setups].sort((a, b) => a.strategy.localeCompare(b.strategy)),
      patternCount: setups.length,
      entries,
      exits,
      lastClose,
      closes,
      entryLow: entryLevels.length
        ? Math.min(...entryLevels.map((l) => l.entryLow))
        : null,
      entryHigh: entryLevels.length
        ? Math.max(...entryLevels.map((l) => l.entryHigh))
        : null,
      stopLoss: entryLevels.length
        ? Math.min(...entryLevels.map((l) => l.stopLoss))
        : null,
      takeProfit: entryLevels.length
        ? Math.max(...entryLevels.map((l) => l.takeProfit))
        : null,
      exitPrice: exits.length ? lastClose : null,
      exitGainPct:
        exitGains.length > 0
          ? exitGains.reduce((a, b) => a + b, 0) / exitGains.length
          : null,
    });
  }
  rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return rows;
}

export type HuntSortKey = "symbol" | "patterns" | "lastClose";
export interface HuntSort {
  key: HuntSortKey;
  dir: "asc" | "desc";
}

export const HUNT_SORT_DEFAULT: HuntSort = { key: "symbol", dir: "asc" };

const HUNT_SORT_DEFAULT_DIRECTION: Record<HuntSortKey, "asc" | "desc"> = {
  symbol: "asc",
  patterns: "desc",
  lastClose: "desc",
};

/** Next sort state for a header click: same column reverses, a new one starts fresh. */
export function nextHuntSort(current: HuntSort, key: HuntSortKey): HuntSort {
  if (current.key === key) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { key, dir: HUNT_SORT_DEFAULT_DIRECTION[key] };
}

export function sortHuntRows(
  rows: OpportunityHuntSymbolRow[],
  sort: HuntSort,
): OpportunityHuntSymbolRow[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.key === "symbol") return dir * a.symbol.localeCompare(b.symbol);
    if (sort.key === "patterns") {
      return dir * (a.patternCount - b.patternCount) || a.symbol.localeCompare(b.symbol);
    }
    return dir * (a.lastClose - b.lastClose) || a.symbol.localeCompare(b.symbol);
  });
}

/**
 * Trading-day labels (YYYY-MM-DD, weekdays only) stepping back from asOf —
 * the chart's time axis. The latest bar is the latest close, so the last
 * label is asOf's date; a weekend asOf still labels Friday last.
 */
export function huntTradingDayLabels(asOfIso: string, count: number): string[] {
  const labels: string[] = [];
  const day = new Date(asOfIso);
  if (Number.isNaN(day.getTime()) || count <= 0) return labels;
  while (labels.length < count) {
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) labels.unshift(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return labels;
}

export function formatHuntPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

export function formatHuntPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const pct = value * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}
