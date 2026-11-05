/**
 * Portfolio-level risk aggregation (issue #34, gap G1 — part of epic #32).
 *
 * Until now the platform's risk numbers were strictly per candidate / per
 * trade: positions synced from the broker were display-only, and no component
 * computed combined Delta/Theta/Vega or total defined max loss, so a set of
 * individually acceptable trades could be one concentrated bet with nothing
 * measuring it. This module is that missing aggregation step.
 *
 * Design discipline (mirrors the server strategy engine):
 *  - Deterministic: the pure aggregator takes a fully-resolved snapshot
 *    (positions + chain Greeks + betas + SPY price) and produces identical
 *    output for identical input. No randomness, no hidden I/O.
 *  - Honest partial coverage: a position that cannot be resolved (no
 *    contract detail in the source payload, no chain Greeks, no beta) is
 *    NEVER silently zeroed. It is listed in `excluded` (contributes nothing)
 *    or `partial` (contributes what is known), and totals that depend on
 *    missing inputs say so via coverage counts.
 *  - Beta: computed from live price history (daily-return regression vs SPY,
 *    trailing 252 sessions) via betaService, provenance-stamped per position.
 *    The static universe table is only a marked fallback when live history
 *    cannot be fetched; symbols with neither are flagged, never assumed 1.0.
 *  - Greeks: the full displayed set — Delta, Gamma, Theta, Vega, Rho — from
 *    the broker chain payload. A contract missing any of them is excluded
 *    with the missing Greeks named; nothing is zero-filled.
 */

import type { BrokerAccount, BrokerOptionChain, BrokerPosition, ETradePosition } from "../types";
import type { ETradeService } from "./etrade";
import { sharedBetaService, type BetaResolution, type BetaSource } from "./betaService";

export type { BetaResolution, BetaSource } from "./betaService";

/** Standard equity-options contract multiplier (shares per contract). */
export const OPTION_CONTRACT_MULTIPLIER = 100;

const round2 = (n: number): number => Number(n.toFixed(2));

export function signedQuantityOf(position: ETradePosition): number {
  if (position.positionType === "SHORT") return -Math.abs(position.quantity);
  if (position.positionType === "LONG") return Math.abs(position.quantity);
  return position.quantity;
}

export function isOptionPosition(position: ETradePosition): boolean {
  return position.securityType === "OPTN" || position.optionType !== undefined;
}

/** A position with every market input the aggregator needs, resolved. */
export interface ResolvedPosition {
  position: ETradePosition;
  kind: "equity" | "option";
  signedQuantity: number;
  /** Per-share reference price: market price for equities, underlying spot for options. */
  referencePrice: number;
  /** Per-share Greeks (full displayed set); equities use delta 1, others 0. Null when unresolvable. */
  greeks: { delta: number; gamma: number; theta: number; vega: number; rho: number } | null;
  greeksMissingReason?: string;
  /** Underlying beta (the symbol's own beta for equities). Null when unknown. */
  beta: number | null;
  /** How the beta was obtained — a live risk number must show its provenance. */
  betaSource: BetaSource;
  /** Aligned return observations behind a computed beta (0 otherwise). */
  betaObservations: number;
}

export interface PositionRiskRow {
  symbol: string;
  kind: "equity" | "option";
  signedQuantity: number;
  /** Delta expressed in shares of the underlying (signed). */
  deltaShares: number | null;
  deltaDollars: number | null;
  betaWeightedDeltaDollars: number | null;
  /** Beta-weighted delta expressed as an equivalent SPY share count. */
  betaWeightedSpyShares: number | null;
  /** Change in delta (shares) per $1 move in the underlying. */
  gammaSharesPerDollar: number | null;
  thetaDollarsPerDay: number | null;
  /** P&L change per +0.01 (one vol point) move in implied volatility. */
  vegaDollarsPerVolPoint: number | null;
  /** P&L change per +1% move in interest rates (the panels' "/1%" convention). */
  rhoDollarsPerRatePoint: number | null;
  beta: number | null;
  betaSource: BetaSource;
  /** Standalone defined max loss in dollars; null when not defined (see undefinedRiskPositions). */
  definedMaxLoss: number | null;
}

export interface PortfolioRiskTotals {
  deltaShares: number;
  deltaDollars: number;
  /** Null when no position in the book has a known beta. */
  betaWeightedDeltaDollars: number | null;
  betaWeightedSpyShares: number | null;
  gammaSharesPerDollar: number;
  thetaDollarsPerDay: number;
  vegaDollarsPerVolPoint: number;
  rhoDollarsPerRatePoint: number;
  /** Sum over positions whose standalone max loss is defined. */
  definedMaxLoss: number;
  definedMaxLossPctOfNav: number | null;
  /** Positions whose beta is known / total positions contributing delta,
   *  split by provenance: computed live, or unavailable (excluded from
   *  beta-weighted totals, never assumed). */
  betaCoverage: { covered: number; total: number; computedLive: number; unavailable: number };
}

export interface PortfolioRiskReport {
  asOf: string;
  nav: number;
  spyPrice: number | null;
  totals: PortfolioRiskTotals;
  rows: PositionRiskRow[];
  /** Positions that contributed nothing, with the reason. */
  excluded: Array<{ symbol: string; reason: string }>;
  /** Positions that contributed partially (e.g. raw delta yes, beta-weighted no). */
  partial: Array<{ symbol: string; reason: string }>;
  /** Symbols with undefined standalone max risk (short options, short equity). */
  undefinedRiskPositions: string[];
}

export interface AggregateOptions {
  nav: number;
  spyPrice: number | null;
  asOf: string;
}

/**
 * Pure aggregation over a resolved snapshot. Identical input → identical
 * output; all monetary/share totals rounded to 2dp at the boundary.
 */
export function aggregatePortfolioRisk(resolved: ResolvedPosition[], opts: AggregateOptions): PortfolioRiskReport {
  const rows: PositionRiskRow[] = [];
  const excluded: PortfolioRiskReport["excluded"] = [];
  const partial: PortfolioRiskReport["partial"] = [];
  const undefinedRiskPositions: string[] = [];

  let deltaShares = 0;
  let deltaDollars = 0;
  let gammaSharesPerDollar = 0;
  let thetaDollarsPerDay = 0;
  let vegaDollarsPerVolPoint = 0;
  let definedMaxLoss = 0;
  let betaWeightedDeltaDollars = 0;
  let betaCovered = 0;
  let betaTotal = 0;
  let betaComputedLive = 0;
  let betaUnavailable = 0;
  let rhoDollarsPerRatePoint = 0;

  for (const r of resolved) {
    const { position, kind, signedQuantity } = r;
    const symbol = position.symbol;

    if (!r.greeks) {
      excluded.push({ symbol, reason: r.greeksMissingReason ?? "Greeks unavailable for this position" });
      continue;
    }

    const multiplier = kind === "option" ? OPTION_CONTRACT_MULTIPLIER : 1;
    const rowDeltaShares = signedQuantity * multiplier * r.greeks.delta;
    const rowDeltaDollars = rowDeltaShares * r.referencePrice;
    const rowGamma = signedQuantity * multiplier * r.greeks.gamma;
    const rowTheta = signedQuantity * multiplier * r.greeks.theta;
    const rowVega = signedQuantity * multiplier * r.greeks.vega * 0.01;
    const rowRho = signedQuantity * multiplier * r.greeks.rho * 0.01;

    deltaShares += rowDeltaShares;
    deltaDollars += rowDeltaDollars;
    gammaSharesPerDollar += rowGamma;
    thetaDollarsPerDay += rowTheta;
    vegaDollarsPerVolPoint += rowVega;
    rhoDollarsPerRatePoint += rowRho;
    betaTotal += 1;

    let rowBetaWeighted: number | null = null;
    let rowSpyShares: number | null = null;
    if (r.beta !== null) {
      rowBetaWeighted = rowDeltaDollars * r.beta;
      betaWeightedDeltaDollars += rowBetaWeighted;
      betaCovered += 1;
      if (r.betaSource === "computed-live") betaComputedLive += 1;
      if (opts.spyPrice && opts.spyPrice > 0) {
        rowSpyShares = rowBetaWeighted / opts.spyPrice;
      }
    } else {
      betaUnavailable += 1;
      partial.push({ symbol, reason: "No beta available for this symbol; excluded from beta-weighted totals" });
    }

    // Standalone defined max loss.
    let rowDefinedMaxLoss: number | null = null;
    if (kind === "option") {
      if (signedQuantity > 0) {
        // Long option: worst case is the premium paid (cost basis).
        rowDefinedMaxLoss = Math.abs(position.costBasis || 0);
      } else {
        undefinedRiskPositions.push(symbol);
      }
    } else if (signedQuantity > 0) {
      // Long equity: worst case is the position's market value (to zero).
      rowDefinedMaxLoss = Math.abs(position.marketValue || signedQuantity * r.referencePrice);
    } else {
      undefinedRiskPositions.push(symbol);
    }
    if (rowDefinedMaxLoss !== null) definedMaxLoss += rowDefinedMaxLoss;

    rows.push({
      symbol,
      kind,
      signedQuantity,
      deltaShares: round2(rowDeltaShares),
      deltaDollars: round2(rowDeltaDollars),
      betaWeightedDeltaDollars: rowBetaWeighted === null ? null : round2(rowBetaWeighted),
      betaWeightedSpyShares: rowSpyShares === null ? null : round2(rowSpyShares),
      gammaSharesPerDollar: round2(rowGamma),
      thetaDollarsPerDay: round2(rowTheta),
      vegaDollarsPerVolPoint: round2(rowVega),
      rhoDollarsPerRatePoint: round2(rowRho),
      beta: r.beta,
      betaSource: r.betaSource,
      definedMaxLoss: rowDefinedMaxLoss === null ? null : round2(rowDefinedMaxLoss),
    });
  }

  const betaWeightedTotal = betaCovered > 0 ? round2(betaWeightedDeltaDollars) : null;
  return {
    asOf: opts.asOf,
    nav: opts.nav,
    spyPrice: opts.spyPrice,
    totals: {
      deltaShares: round2(deltaShares),
      deltaDollars: round2(deltaDollars),
      betaWeightedDeltaDollars: betaWeightedTotal,
      betaWeightedSpyShares:
        betaWeightedTotal !== null && opts.spyPrice && opts.spyPrice > 0 ? round2(betaWeightedTotal / opts.spyPrice) : null,
      gammaSharesPerDollar: round2(gammaSharesPerDollar),
      thetaDollarsPerDay: round2(thetaDollarsPerDay),
      vegaDollarsPerVolPoint: round2(vegaDollarsPerVolPoint),
      rhoDollarsPerRatePoint: round2(rhoDollarsPerRatePoint),
      definedMaxLoss: round2(definedMaxLoss),
      definedMaxLossPctOfNav: opts.nav > 0 ? round2((definedMaxLoss / opts.nav) * 100) : null,
      betaCoverage: { covered: betaCovered, total: betaTotal, computedLive: betaComputedLive, unavailable: betaUnavailable },
    },
    rows,
    excluded,
    partial,
    undefinedRiskPositions,
  };
}

/** A candidate's Greek contribution, in the same units as PortfolioRiskTotals. */
export interface CandidateGreekContribution {
  deltaShares: number;
  deltaDollars: number;
  betaWeightedDeltaDollars: number | null;
  gammaSharesPerDollar: number;
  thetaDollarsPerDay: number;
  vegaDollarsPerVolPoint: number;
  rhoDollarsPerRatePoint: number;
  /** Candidate's own defined max loss (0 when unknown/not applicable). */
  definedMaxLoss: number;
}

/**
 * Post-trade totals: what the portfolio looks like if a candidate (e.g. a
 * recommendation's net Greeks) is added. Beta-weighted post-trade totals are
 * null when either side lacks beta coverage for the contribution.
 */
export function evaluatePostTradeTotals(
  report: PortfolioRiskReport,
  candidate: CandidateGreekContribution,
): PortfolioRiskTotals {
  const t = report.totals;
  const betaWeighted =
    t.betaWeightedDeltaDollars !== null && candidate.betaWeightedDeltaDollars !== null
      ? round2(t.betaWeightedDeltaDollars + candidate.betaWeightedDeltaDollars)
      : null;
  const definedMaxLoss = round2(t.definedMaxLoss + candidate.definedMaxLoss);
  return {
    deltaShares: round2(t.deltaShares + candidate.deltaShares),
    deltaDollars: round2(t.deltaDollars + candidate.deltaDollars),
    betaWeightedDeltaDollars: betaWeighted,
    betaWeightedSpyShares:
      betaWeighted !== null && report.spyPrice && report.spyPrice > 0 ? round2(betaWeighted / report.spyPrice) : null,
    gammaSharesPerDollar: round2(t.gammaSharesPerDollar + candidate.gammaSharesPerDollar),
    thetaDollarsPerDay: round2(t.thetaDollarsPerDay + candidate.thetaDollarsPerDay),
    vegaDollarsPerVolPoint: round2(t.vegaDollarsPerVolPoint + candidate.vegaDollarsPerVolPoint),
    rhoDollarsPerRatePoint: round2(t.rhoDollarsPerRatePoint + candidate.rhoDollarsPerRatePoint),
    definedMaxLoss,
    definedMaxLossPctOfNav: report.nav > 0 ? round2((definedMaxLoss / report.nav) * 100) : null,
    betaCoverage: t.betaCoverage,
  };
}

// ---------------------------------------------------------------------------
// Snapshot resolution (I/O): positions + live chains + beta table → resolved
// ---------------------------------------------------------------------------

type ContractLookup =
  | { status: "ok"; greeks: { delta: number; gamma: number; theta: number; vega: number; rho: number }; underlyingPrice: number }
  | { status: "incomplete"; missing: string[] }
  | { status: "not-found" };

const REQUIRED_GREEKS = ["delta", "gamma", "theta", "vega", "rho"] as const;

function findContract(chain: BrokerOptionChain, position: BrokerPosition): ContractLookup {
  for (const pair of chain.pairs) {
    const contract = position.optionType === "CALL" ? pair.call : pair.put;
    if (!contract) continue;
    if (Math.abs(contract.strikePrice - (position.strikePrice ?? NaN)) > 0.001) continue;
    const missing = REQUIRED_GREEKS.filter((g) => contract[g] === undefined);
    if (missing.length > 0) return { status: "incomplete", missing: [...missing] };
    return {
      status: "ok",
      greeks: {
        delta: contract.delta!,
        gamma: contract.gamma!,
        theta: contract.theta!,
        vega: contract.vega!,
        rho: contract.rho!,
      },
      underlyingPrice: chain.underlyingPrice,
    };
  }
  return { status: "not-found" };
}

export type BetaResolver = (symbol: string) => Promise<BetaResolution>;

export interface OptionExpiry {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Issue #3324 (programme #3292): the neutral input to the risk model.
 *
 * Until this port existed the two entry points below were typed against
 * `ETradeService`, so the only book the model could measure was E*TRADE's —
 * even though the aggregator itself (`aggregatePortfolioRisk`) was already
 * pure. Risk was therefore declared unavailable for Alpaca (#3296) rather
 * than computed for it.
 *
 * A source is read-only and broker-owned: it reports the book, one expiry's
 * chain for a held contract, and a spot price. It carries no notion of
 * "default broker", and the model never asks a source other than the one it
 * was given — a report can never mix two brokers' numbers.
 */
export interface PortfolioRiskSource {
  /** The book: the account whose NAV sizes the percentages, and its positions. */
  readBook(): Promise<{ account: BrokerAccount; positions: BrokerPosition[] }>;
  /** One expiry's chain, from the broker that holds the contract. Null when the chain is unavailable. */
  optionChain(symbol: string, expiry?: OptionExpiry): Promise<BrokerOptionChain | null>;
  /** Last price for a symbol, used for the SPY denominator. Null when unreadable. */
  spotPrice(symbol: string): Promise<number | null>;
}

/**
 * The E*TRADE source: the same reads the endpoint used to perform inline,
 * behind the neutral port. Keeping it here means the route and the adapter
 * read the book the same way, so an E*TRADE report is unchanged by the
 * introduction of the Alpaca path.
 */
export function etradePortfolioRiskSource(etrade: ETradeService): PortfolioRiskSource {
  return {
    readBook: () => etrade.fetchPortfolioRemote(undefined, true),
    optionChain: (symbol, expiry) =>
      etrade.getOptionChains({
        symbol,
        ...(expiry ? { expiryYear: expiry.year, expiryMonth: expiry.month, expiryDay: expiry.day } : {}),
      }),
    spotPrice: async (symbol) => {
      try {
        const quote = await etrade.getQuote(symbol);
        return typeof quote?.lastPrice === "number" && Number.isFinite(quote.lastPrice) ? quote.lastPrice : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Resolves a broker positions snapshot into aggregator inputs using that
 * broker's live chains for held option contracts and dynamically computed
 * betas (betaService). Positions that cannot be resolved come back with
 * greeks: null and a named reason — the aggregator lists them under
 * `excluded` rather than treating them as zero risk.
 */
export async function resolvePositionsSnapshot(
  source: Pick<PortfolioRiskSource, "optionChain">,
  positions: BrokerPosition[],
  betaResolver: BetaResolver = (symbol) => sharedBetaService.resolve(symbol),
): Promise<ResolvedPosition[]> {
  const chainCache = new Map<string, Promise<BrokerOptionChain | null>>();
  const chainFor = (symbol: string, expirationDate: string): Promise<BrokerOptionChain | null> => {
    const key = `${symbol}|${expirationDate}`;
    if (!chainCache.has(key)) {
      const [year, month, day] = expirationDate.split("-").map(Number);
      chainCache.set(key, source.optionChain(symbol, { year, month, day }));
    }
    return chainCache.get(key)!;
  };

  // Resolve each distinct symbol's beta once, in parallel.
  const betaBySymbol = new Map<string, BetaResolution>();
  await Promise.all(
    [...new Set(positions.map((p) => p.symbol.toUpperCase()))].map(async (symbol) => {
      betaBySymbol.set(symbol, await betaResolver(symbol).catch(() => ({ beta: null, source: "unavailable" as const, observations: 0, asOf: new Date().toISOString() })));
    }),
  );
  const betaFields = (symbol: string): { beta: number | null; betaSource: BetaSource; betaObservations: number } => {
    const r = betaBySymbol.get(symbol.toUpperCase());
    return { beta: r?.beta ?? null, betaSource: r?.source ?? "unavailable", betaObservations: r?.observations ?? 0 };
  };

  const resolved: ResolvedPosition[] = [];
  for (const position of positions) {
    const signedQuantity = signedQuantityOf(position);
    const beta = betaFields(position.symbol);
    if (!isOptionPosition(position)) {
      resolved.push({
        position,
        kind: "equity",
        signedQuantity,
        referencePrice: position.marketPrice || position.currentPrice || 0,
        greeks: { delta: 1, gamma: 0, theta: 0, vega: 0, rho: 0 },
        ...beta,
      });
      continue;
    }
    if (!position.optionType || position.strikePrice === undefined || !position.expirationDate) {
      resolved.push({
        position,
        kind: "option",
        signedQuantity,
        referencePrice: 0,
        greeks: null,
        greeksMissingReason: "Option position without contract detail (strike/expiry/type not reported by the source payload)",
        ...beta,
      });
      continue;
    }
    const chain = await chainFor(position.symbol, position.expirationDate).catch(() => null);
    const lookup = chain ? findContract(chain, position) : ({ status: "not-found" } as const);
    if (lookup.status !== "ok") {
      resolved.push({
        position,
        kind: "option",
        signedQuantity,
        referencePrice: 0,
        greeks: null,
        greeksMissingReason:
          lookup.status === "incomplete"
            ? `Chain Greeks incomplete for ${position.symbol} ${position.expirationDate} ${position.strikePrice} ${position.optionType} (missing: ${lookup.missing.join(", ")}) — excluded rather than zero-filled`
            : `No live chain contract for ${position.symbol} ${position.expirationDate} ${position.strikePrice} ${position.optionType}`,
        ...beta,
      });
      continue;
    }
    resolved.push({
      position,
      kind: "option",
      signedQuantity,
      referencePrice: lookup.underlyingPrice,
      greeks: lookup.greeks,
      ...beta,
    });
  }
  return resolved;
}

/** Full pipeline used by the HTTP endpoints: read, resolve, aggregate. */
export async function computePortfolioRisk(source: PortfolioRiskSource): Promise<PortfolioRiskReport> {
  const { account, positions } = await source.readBook();
  const nav = account.netAccountValue || account.totalAccountValue || 0;
  const resolved = await resolvePositionsSnapshot(source, positions);
  // The SPY denominator comes from the selected broker's own spot read. A
  // broker that cannot price SPY yields null, and the beta-weighted totals
  // say so rather than borrowing another broker's price.
  const spyPrice = await source.spotPrice("SPY").catch(() => null);
  return aggregatePortfolioRisk(resolved, { nav, spyPrice, asOf: new Date().toISOString() });
}
