/**
 * Issue #3652 — the `search.opportunity_hunt` operation, implemented.
 *
 * The seeded `opportunity-hunt` goal (daily 07:00, enabled) declared this
 * operation, but `OPERATION_CATALOG` registered only `search.query` for the
 * search agent, so every firing — scheduled or manual — threw
 * `Unknown operation: search.opportunity_hunt` at descriptor creation and the
 * goal recorded a failure. Registering the name alone would have turned that
 * red row into a green descriptor that does nothing (#1655's "registration is
 * the complete fix" precedent applies only where the job has a consumer; this
 * one has none). So the operation executes here.
 *
 * What a hunt is: evaluate the existing pattern strategies over the tradable
 * universe's daily closes and report the symbols whose latest bar produces an
 * entry signal. Reuse, not a new indicator: `evaluateLatestPatternSignal` is
 * the same pure evaluator the Stock Copilot's plan step uses, with the same
 * five-bar floor. A hunt that finds nothing is a completed hunt (success with
 * zero setups), not a failure — only an unreadable bar source fails.
 */
import {
  evaluateLatestPatternSignal,
  SANDBOX_STRATEGY_IDS,
  type SandboxStrategyId,
} from "./patternSignals";
import {
  deriveOpportunityHuntLevels,
  OPPORTUNITY_HUNT_CHART_BARS,
  type OpportunityHuntPriceLevels,
} from "../config/opportunityHuntLevels";

/** The catalog operation this module implements (issue #3652). */
export const OPPORTUNITY_HUNT_OPERATION = "search.opportunity_hunt";

/** Minimum closes before a pattern can be evaluated (same floor as the copilot plan step). */
export const OPPORTUNITY_HUNT_MIN_BARS = 5;

/** Which side of the trade the signal is on (issue 6406). */
export type OpportunityHuntDirection = "entry" | "exit";

export interface OpportunityHuntSetup {
  symbol: string;
  strategy: SandboxStrategyId;
  /** Entry for a fresh signal; exit for a held position the evaluator says to close. */
  direction: OpportunityHuntDirection;
  /** Latest close — the execution/reference price for the recommendation. */
  lastClose: number;
  /** The evaluator's own reason string (e.g. "(Fast SMA 143.46 > Slow 136.24)"). */
  detail: string;
  /** Held position's cost basis — exits only. */
  entryPrice?: number;
  /** Entry recommendation's price range — entries only. */
  levels?: OpportunityHuntPriceLevels;
}

/**
 * Whether the hunt knew the tenant's holdings (issue 6406). Exits can only
 * fire when holdings are known; when they are not, the reason rides along
 * so the panel states it instead of silently showing entries only.
 */
export interface OpportunityHuntHoldingsStatus {
  available: boolean;
  /** The broker that answered the holdings read, when one did. */
  broker?: string;
  /** Coded reason the holdings were unavailable, when they were. */
  reason?: string;
}

export interface OpportunityHuntResult {
  /** Symbols with enough bars to evaluate. */
  scanned: number;
  /** Symbols skipped for too few bars. */
  skipped: number;
  setups: OpportunityHuntSetup[];
  /** One line for the run ledger's descriptor cell. */
  summary: string;
  asOf: string;
  holdingsStatus: OpportunityHuntHoldingsStatus;
  /**
   * Trailing closes per symbol with setups, oldest → newest, capped at
   * OPPORTUNITY_HUNT_CHART_BARS — the panel's price chart, not a new store.
   */
  seriesBySymbol: Record<string, readonly number[]>;
}

export interface OpportunityHuntInput {
  /** Daily closes per symbol, oldest → newest. */
  closesBySymbol: ReadonlyMap<string, readonly number[]>;
  strategies?: readonly SandboxStrategyId[];
  minBars?: number;
  now?: () => Date;
  /**
   * Held positions, symbol → entry (cost-basis) price. Absent = flat:
   * the hunt evaluates entries only, exactly as before. Supplied by the
   * caller from the tenant's broker-neutral positions read.
   */
  holdings?: ReadonlyMap<string, number>;
  /** Why holdings were unavailable, when the caller knows (else a default). */
  holdingsStatus?: OpportunityHuntHoldingsStatus;
}

/** Summarise a hunt for the ledger: counts first, then the first few symbols. */
function huntSummary(result: Omit<OpportunityHuntResult, "summary">): string {
  const entries = result.setups.filter((s) => s.direction === "entry").length;
  const exits = result.setups.length - entries;
  const head = `Opportunity hunt: ${result.setups.length} setup(s) across ${result.scanned} symbol(s)`;
  // Issue 6406 — the entry/exit split rides after the established prefix,
  // so the pinned "N setup(s) across M symbol(s)" shape is unchanged.
  const split =
    result.setups.length > 0
      ? `, ${entries} ${entries === 1 ? "entry" : "entries"}, ${exits} ${exits === 1 ? "exit" : "exits"}`
      : "";
  const tail = result.skipped > 0 ? `, ${result.skipped} skipped (short history)` : "";
  const names =
    result.setups.length > 0
      ? ` — ${result.setups
          .slice(0, 5)
          .map((s) => `${s.symbol}:${s.strategy}`)
          .join(", ")}${result.setups.length > 5 ? ", …" : ""}`
      : " — none";
  return `${head}${split}${tail}${names}`;
}

/** Pure hunt over supplied closes. The caller owns the bar source. */
export function runOpportunityHunt(input: OpportunityHuntInput): OpportunityHuntResult {
  const strategies = input.strategies ?? SANDBOX_STRATEGY_IDS;
  const minBars = input.minBars ?? OPPORTUNITY_HUNT_MIN_BARS;
  const setups: OpportunityHuntSetup[] = [];
  const seriesBySymbol: Record<string, readonly number[]> = {};
  let scanned = 0;
  let skipped = 0;

  for (const [symbol, closes] of input.closesBySymbol) {
    if (!Array.isArray(closes) || closes.length < minBars) {
      skipped += 1;
      continue;
    }
    scanned += 1;
    // Issue 6406 — a held symbol evaluates with its cost basis, so the
    // evaluator's exit rules can fire; a symbol with no holding evaluates
    // flat, exactly as before.
    const entryPrice = input.holdings?.get(symbol);
    const holding = entryPrice !== undefined;
    const lastClose = closes[closes.length - 1];
    let hasSetup = false;
    for (const strategy of strategies) {
      const signal = evaluateLatestPatternSignal(strategy, closes as readonly number[], {
        holding,
        entryPrice: entryPrice ?? 0,
      });
      if (signal.action === "enter_long") {
        hasSetup = true;
        setups.push({
          symbol,
          strategy,
          direction: "entry",
          lastClose,
          detail: signal.detail,
          levels: deriveOpportunityHuntLevels(strategy, lastClose),
        });
      } else if (signal.action === "exit_long") {
        hasSetup = true;
        setups.push({
          symbol,
          strategy,
          direction: "exit",
          lastClose,
          detail: signal.detail,
          entryPrice,
        });
      }
    }
    if (hasSetup) {
      seriesBySymbol[symbol] = closes.slice(-OPPORTUNITY_HUNT_CHART_BARS);
    }
  }

  // Stable output: symbol then strategy, so the ledger line is comparable run to run.
  setups.sort((a, b) =>
    a.symbol === b.symbol ? a.strategy.localeCompare(b.strategy) : a.symbol.localeCompare(b.symbol),
  );

  const partial = {
    scanned,
    skipped,
    setups,
    asOf: (input.now ?? (() => new Date()))().toISOString(),
    holdingsStatus: input.holdingsStatus ?? {
      available: false,
      reason: "holdings_not_loaded",
    },
    seriesBySymbol,
  };
  return { ...partial, summary: huntSummary(partial) };
}

/**
 * Execute the operation with a supplied bar loader. Fails — with a named
 * reason, never a fabricated empty result — when the source cannot be read.
 */
export async function executeOpportunityHunt(input: {
  loadCloses: () => Promise<ReadonlyMap<string, readonly number[]>>;
  strategies?: readonly SandboxStrategyId[];
  now?: () => Date;
  /** Held positions, symbol → entry price (issue 6406). */
  holdings?: ReadonlyMap<string, number>;
  holdingsStatus?: OpportunityHuntHoldingsStatus;
}): Promise<OpportunityHuntResult> {
  let closes: ReadonlyMap<string, readonly number[]>;
  try {
    closes = await input.loadCloses();
  } catch (err) {
    throw new Error(
      `opportunity_hunt_bar_source_failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!closes || closes.size === 0) {
    throw new Error(
      "opportunity_hunt_no_bars: no live persisted technicals bars are available for the universe",
    );
  }
  return runOpportunityHunt({
    closesBySymbol: closes,
    ...(input.strategies ? { strategies: input.strategies } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.holdings ? { holdings: input.holdings } : {}),
    ...(input.holdingsStatus ? { holdingsStatus: input.holdingsStatus } : {}),
  });
}
