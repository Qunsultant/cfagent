/**
 * Research-run report data (#2167): one row model for the PDF, the
 * workbook and the CSV.
 *
 * A `ResearchReport` is a ranked set of trade ideas plus the watchlist,
 * the rejects, and the run's stats. Every renderer projects from this
 * module, so the three formats cannot drift apart:
 *
 *  - the ideas table (ranked economics) is the CSV and the `Ideas` tab;
 *  - the trade-card narrative (thesis, evidence, falsification, limits)
 *    is the `Trade Cards` tab and the PDF's per-idea pages;
 *  - legs are one row each, with the side from the quantity sign and the
 *    price from the mid — the PDF prints the same `researchLegLine`.
 */

import type { ResearchLeg } from "../services/researchEconomics";
import type { ResearchReport, TradeCard } from "../services/researchPipeline";

export type ResearchReportFormat = "pdf" | "xlsx" | "csv";

/** The ranked-idea table: shared verbatim by the CSV and the `Ideas` tab. */
export const RESEARCH_IDEA_COLUMNS = [
  "rank",
  "symbol",
  "outlook",
  "structure",
  "score",
  "thesis",
  "net_debit",
  "net_credit",
  "max_loss",
  "max_gain",
  "contractual_max_loss",
  "breakevens",
  "entry_condition",
  "invalidation",
  "legs",
] as const;

export type ResearchIdeaRow = Record<(typeof RESEARCH_IDEA_COLUMNS)[number], string | number | null>;

export const RESEARCH_TRADE_CARD_COLUMNS = [
  "rank",
  "symbol",
  "outlook",
  "structure",
  "thesis",
  "supporting",
  "contradicting",
  "why_market_wrong",
  "resolution_trigger",
  "horizon",
  "invalidation",
  "why_this_structure",
  "entry_condition",
  "limitations",
  "sources",
] as const;

export const RESEARCH_SYMBOL_EVALUATION_COLUMNS = [
  "symbol",
  "outcome",
  "reason",
  "quote_price",
  "quote_timestamp",
  "quote_status",
  "quote_source",
  "market_cap",
  "is_etf",
  "chain_outcome",
  "chain_source",
  "chain_provenance",
  "chain_as_of",
  "expiry_count",
  "leg_count",
  "chain_failure_reason",
  "outlook",
  "selected_strategy",
  "strategies",
] as const;

export type ResearchSymbolEvaluationRow = Record<(typeof RESEARCH_SYMBOL_EVALUATION_COLUMNS)[number], string | number | boolean | null>;

export const RESEARCH_CSV_COLUMNS = [
  "record_type",
  ...RESEARCH_IDEA_COLUMNS,
  ...RESEARCH_SYMBOL_EVALUATION_COLUMNS,
] as const;

export type ResearchTradeCardRow = Record<(typeof RESEARCH_TRADE_CARD_COLUMNS)[number], string | number | null>;

export interface ResearchLegRow {
  idea_rank: number | null;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  option_type: string;
  strike: number | null;
  expiry: string;
  dte: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  implied_volatility: number | null;
  volume: number | null;
  open_interest: number | null;
}

export interface ResearchWatchlistRow {
  symbol: string;
  outlook: string;
  structure: string;
  thesis: string;
  reason: string;
  trigger_condition: string;
}

export interface ResearchRejectedRow {
  symbol: string;
  outlook: string;
  structure: string;
  gate: string;
  reason: string;
}

export interface ResearchReportArtifactOutcome {
  pdfKey?: string;
  pdfStatus: "generated" | "failed";
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus: "generated" | "failed";
  xlsxError?: string;
  csvKey?: string;
  csvStatus: "generated" | "failed";
  csvError?: string;
}

/** What the agent's workbook seam produces (the PDF has its own owner). */
export interface ResearchWorkbookOutcome {
  xlsxKey?: string;
  xlsxStatus: "generated" | "failed";
  xlsxError?: string;
  csvKey?: string;
  csvStatus: "generated" | "failed";
  csvError?: string;
}

/** Download links a stored research run serves, on the research routes. */
export interface ResearchReportArtifactLinks {
  pdfKey?: string;
  reportUrl?: string;
  xlsxKey?: string;
  xlsxUrl?: string;
  csvKey?: string;
  csvUrl?: string;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The mid price of a quoted leg, or null when the feed gave no quote. */
export function researchLegMid(leg: ResearchLeg): number | null {
  const bid = finite(leg?.bid);
  const ask = finite(leg?.ask);
  return bid !== null && ask !== null ? (bid + ask) / 2 : null;
}

/**
 * One leg, as every renderer states it: side from the quantity sign, the
 * contract from strike/expiry/type, the price from the mid. A missing
 * quote prints "—" rather than a fabricated price.
 */
export function researchLegLine(leg: ResearchLeg): string {
  const quantity = finite(leg?.quantity);
  const qty = Math.abs(quantity ?? 0);
  const side = (quantity ?? 0) < 0 ? "SELL" : "BUY";
  const mid = researchLegMid(leg);
  return `${side} ${qty} ${String(leg?.optionType ?? "").toUpperCase()} ${leg?.strike ?? "—"} ${leg?.expiry ?? "—"} @ ${
    mid === null ? "—" : mid.toFixed(2)
  }`;
}

function legsText(idea: TradeCard): string {
  return (idea?.legs ?? []).map((leg) => researchLegLine(leg)).join(" · ");
}

function breakevensText(idea: TradeCard): string {
  return (idea?.economics?.breakevens ?? []).map((value) => Number(value).toFixed(2)).join(" / ");
}

export function researchIdeaRows(report: ResearchReport): ResearchIdeaRow[] {
  return (report?.ideas ?? []).map((idea) => {
    const economics = idea.economics ?? ({} as TradeCard["economics"]);
    return {
      rank: finite(idea.rank),
      symbol: String(idea.symbol ?? ""),
      outlook: String(idea.outlook ?? ""),
      structure: String(idea.structure ?? ""),
      score: finite(idea.score),
      thesis: String(idea.thesis ?? ""),
      net_debit: finite(economics.netDebit),
      net_credit: finite(economics.netCredit),
      max_loss: finite(economics.maxLoss),
      max_gain: finite(economics.maxGain),
      contractual_max_loss: finite(idea.contractualMaxLoss),
      breakevens: breakevensText(idea),
      entry_condition: String(idea.entryCondition ?? ""),
      invalidation: String(idea.invalidation ?? ""),
      legs: legsText(idea),
    };
  });
}

export function researchTradeCardRows(report: ResearchReport): ResearchTradeCardRow[] {
  return (report?.ideas ?? []).map((idea) => {
    const falsification = idea.falsification ?? ({} as TradeCard["falsification"]);
    return {
      rank: finite(idea.rank),
      symbol: String(idea.symbol ?? ""),
      outlook: String(idea.outlook ?? ""),
      structure: String(idea.structure ?? ""),
      thesis: String(idea.thesis ?? ""),
      supporting: (idea.supportingEvidence ?? []).join(" · "),
      contradicting: (idea.contradictingEvidence ?? []).join(" · "),
      why_market_wrong: String(falsification.whyMarketWrong ?? ""),
      resolution_trigger: String(falsification.resolutionTrigger ?? ""),
      horizon: String(falsification.horizon ?? ""),
      invalidation: String(falsification.invalidation ?? idea.invalidation ?? ""),
      why_this_structure: String(falsification.whyThisStructure ?? ""),
      entry_condition: String(idea.entryCondition ?? ""),
      limitations: (idea.limitations ?? []).join(" · "),
      sources: (idea.sources ?? []).join(" · "),
    };
  });
}

export function researchLegRows(report: ResearchReport): ResearchLegRow[] {
  const rows: ResearchLegRow[] = [];
  for (const idea of report?.ideas ?? []) {
    for (const leg of idea.legs ?? []) {
      const quantity = finite(leg.quantity);
      rows.push({
        idea_rank: finite(idea.rank),
        symbol: String(idea.symbol ?? ""),
        side: (quantity ?? 0) < 0 ? "SELL" : "BUY",
        quantity: Math.abs(quantity ?? 0),
        option_type: String(leg.optionType ?? "").toUpperCase(),
        strike: finite(leg.strike),
        expiry: String(leg.expiry ?? ""),
        dte: finite(leg.dte),
        bid: finite(leg.bid),
        ask: finite(leg.ask),
        mid: researchLegMid(leg),
        implied_volatility: finite(leg.iv),
        volume: finite(leg.volume),
        open_interest: finite(leg.openInterest),
      });
    }
  }
  return rows;
}

export function researchWatchlistRows(report: ResearchReport): ResearchWatchlistRow[] {
  return (report?.watchlist ?? []).map((entry) => ({
    symbol: String(entry.symbol ?? ""),
    outlook: String(entry.outlook ?? ""),
    structure: String(entry.structure ?? ""),
    thesis: String(entry.thesis ?? ""),
    reason: String(entry.reason ?? ""),
    trigger_condition: String(entry.triggerCondition ?? ""),
  }));
}

export function researchRejectedRows(report: ResearchReport): ResearchRejectedRow[] {
  return (report?.rejected ?? []).map((entry) => ({
    symbol: String(entry.symbol ?? ""),
    outlook: String(entry.outlook ?? ""),
    structure: String(entry.structure ?? ""),
    gate: String(entry.gate ?? ""),
    reason: String(entry.reason ?? ""),
  }));
}

export function researchSymbolEvaluationRows(report: ResearchReport): ResearchSymbolEvaluationRow[] {
  return (report?.symbolEvaluations ?? []).map((evaluation) => ({
    symbol: String(evaluation.symbol ?? ""),
    outcome: String(evaluation.outcome ?? "unknown"),
    reason: String(evaluation.reason ?? ""),
    quote_price: finite(evaluation.quote?.price),
    quote_timestamp: finite(evaluation.quote?.timestamp),
    quote_status: evaluation.quote?.quoteStatus ?? null,
    quote_source: evaluation.quote?.source ?? null,
    market_cap: finite(evaluation.quote?.marketCap),
    is_etf: typeof evaluation.quote?.isEtf === "boolean" ? evaluation.quote.isEtf : null,
    chain_outcome: evaluation.chain?.outcome ?? null,
    chain_source: evaluation.chain?.source ?? null,
    chain_provenance: evaluation.chain?.provenance ?? null,
    chain_as_of: finite(evaluation.chain?.asOf),
    expiry_count: finite(evaluation.chain?.expiryCount),
    leg_count: finite(evaluation.chain?.legCount),
    chain_failure_reason: evaluation.chain?.failureReason ?? null,
    outlook: evaluation.outlook ?? null,
    selected_strategy: evaluation.selectedStrategy ?? null,
    strategies: JSON.stringify(evaluation.strategies ?? []),
  }));
}

/** The run-level field/value rows, mirroring the PDF's config page. */
export function researchSummaryRows(report: ResearchReport): Array<[string, string | number | null]> {
  const stats = report?.stats;
  return [
    ["run_id", String(report?.runId ?? "")],
    ["trigger", String(report?.trigger ?? "")],
    ["created_at", String(report?.createdAt ?? "")],
    ["rules_version", String(report?.rulesVersion ?? "")],
    ["broker", String(report?.brokerId ?? "not recorded")],
    ["mode", String(report?.mode ?? "not recorded")],
    ["asset_type", String(report?.assetType ?? "not recorded")],
    ["account_type", String(report?.accountType ?? "not recorded")],
    ["account_id", String(report?.accountId ?? "not recorded")],
    ["quote_sources", [...new Set((report?.symbolEvaluations ?? []).map((evaluation) => evaluation.quote?.source).filter(Boolean))].join(", ")],
    ["chain_sources", [...new Set((report?.symbolEvaluations ?? []).map((evaluation) => evaluation.chain?.source).filter(Boolean))].join(", ")],
    ["regime", String(report?.regime?.regime ?? "")],
    ["summary", String(report?.summary ?? "")],
    ["universe", finite(stats?.universeSize)],
    ["quotes_retrieved", finite(stats?.quotesRetrieved)],
    ["candidates_evaluated", finite(stats?.candidatesEvaluated)],
    ["chains_attempted", finite(stats?.chainsAttempted)],
    ["chains_fetched", finite(stats?.chainsFetched)],
    ["qualified", finite(stats?.qualified)],
    ["watchlist", finite(stats?.watchlist)],
    ["rejected", finite(stats?.rejected)],
    ["unverified", finite(stats?.unverified)],
    ["duration_ms", finite(stats?.durationMs)],
    ["config_snapshot", JSON.stringify(report?.configSnapshot ?? {})],
  ];
}

/** `research_<trigger>_<timestamp>_<runId>.<format>` — mirrors the PDF name. */
export function researchReportFileName(report: ResearchReport, format: ResearchReportFormat): string {
  const createdAt = report?.createdAt ? new Date(report.createdAt) : new Date(0);
  const stamp = Number.isNaN(createdAt.getTime())
    ? "unknown"
    : `${createdAt.toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z`;
  const trigger = (report?.trigger || "manual").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const runId = (report?.runId || "adhoc").replace(/[^a-zA-Z0-9-]+/g, "").slice(0, 24);
  return `research_${trigger}_${stamp}_${runId}.${format}`;
}

/**
 * Map a run's stored keys to the research download URLs. A failed leg has
 * no key, so it contributes no link — never a URL that 404s.
 */
export function researchReportArtifactLinks(outcome: ResearchReportArtifactOutcome): ResearchReportArtifactLinks {
  const links: ResearchReportArtifactLinks = {};
  if (outcome.pdfKey) {
    links.pdfKey = outcome.pdfKey;
    links.reportUrl = `/api/research/report.pdf?key=${encodeURIComponent(outcome.pdfKey)}`;
  }
  if (outcome.xlsxKey) {
    links.xlsxKey = outcome.xlsxKey;
    links.xlsxUrl = `/api/research/report.xlsx?key=${encodeURIComponent(outcome.xlsxKey)}`;
  }
  if (outcome.csvKey) {
    links.csvKey = outcome.csvKey;
    links.csvUrl = `/api/research/report.csv?key=${encodeURIComponent(outcome.csvKey)}`;
  }
  return links;
}
