/**
 * Strategy screener report artifacts (PDF / XLSX / CSV).
 *
 * The options contract screener's generators render contracts and
 * opportunities; the strategy screener's unit is a *ranked strategy* —
 * a structure with legs, economics, probability, score and (for the AI
 * actions) an LLM rank/rationale. These generators render exactly that
 * unit, for every strategy surface:
 *
 *  - "Strategies that fit my name" / per-name best (`ranked`)
 *  - "Names that fit my strategy" / best-trade (`bestTrade`)
 *  - the AI actions (`llm_ideas` / `llm_evaluate`: quant ranked + LLM rows)
 *
 * Artifacts are stored by the ScreenerAgent under the existing options
 * prefixes (`options:pdf:` / `options:xlsx:` / `options:csv:`), so the
 * established `/api/options/report.*` endpoints serve them with no new
 * route surface. A generation failure is per format and never fails the
 * run (the #1278 contract).
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as XLSX from "@e965/xlsx";
import type { RankedStrategy } from "./options/recommendationAgent";
import type { StrategyLeg } from "./options/strategyEngine";
import { defaultRegistry } from "./options/strategies/catalog";
import {
  describeReportScope,
  resolveOptionsReportScope,
  type ResolvedOptionsReportScope,
} from "./optionsReportScope";

export type StrategyReportFormat = "pdf" | "xlsx" | "csv";

export interface StrategyReportAiRow {
  candidateId: string;
  rank?: number;
  score?: number;
  rationale?: string;
}

/**
 * What the report was asked to cover, and what it actually carries.
 *
 * This is the honest answer to "why only three strategies?". A wanted
 * strategy can be missing for three different reasons, and they are not
 * interchangeable: it was never selected (the scope's wanted set), it was
 * evaluated but built/received no ranked candidate (candidate limit or
 * acceptance gate), or the fetched chain could not reach its horizon.
 */
export interface StrategyReportCoverage {
  /** The scope in one line (theses x strategies x chains → formats). */
  scope: string;
  preset: string;
  theses: string[];
  wantedStrategyIds: string[];
  /** Strategy types that reached the ranked rows of this report. */
  reportedStrategyIds: string[];
  /** Strategy ids the engine's ledger reported, when the caller supplied it. */
  evaluatedStrategyIds: string[];
  notReported: Array<{ id: string; label: string; reason: string }>;
  warnings: string[];
}

export interface StrategyReportInput {
  /** Underlying (or "universe" for a multi-name scan). */
  symbol?: string;
  /** Human title; defaults to a mode-derived one. */
  title?: string;
  summary?: string;
  /** strategies | best-trade | compare | llm_ideas | llm_evaluate */
  action?: string;
  thesis?: string;
  riskProfile?: string;
  generatedAt?: string;
  ranked?: RankedStrategy[];
  bestTrade?: { best?: RankedStrategy; alternatives?: RankedStrategy[] } | null;
  ai?: { model?: string; rows?: StrategyReportAiRow[]; status?: string } | null;
  screenedOut?: Array<{ id: string; reason: string }>;
  /** Issue #2577: scope + coverage, rendered as a named section. */
  coverage?: StrategyReportCoverage | null;
}

export interface NormalizedStrategyRow {
  rank: number | null;
  strategy: string;
  label: string;
  symbol: string;
  expiration: string;
  legs: string;
  legCount: number;
  netDebit: number | null;
  maxProfit: number | null;
  maxLoss: number | null;
  breakevens: string;
  rewardRisk: number | null;
  probabilityOfProfit: number | null;
  compositeScore: number | null;
  aiRank: number | null;
  aiScore: number | null;
  aiRationale: string;
  rationale: string;
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function legText(leg: StrategyLeg): string {
  return `${leg.side} ${leg.quantity} ${leg.optionType} ${leg.strike}${leg.expirationDate ? ` ${leg.expirationDate}` : ""} @ ${Number(leg.entryPrice).toFixed(2)}`;
}

/**
 * One ordered candidate list for every renderer: the best trade leads
 * (a best-trade screen ranks exactly one name), then the ranked list,
 * then the alternatives. A candidate appears once, keyed by its id.
 */
export function strategyReportCandidates(input: StrategyReportInput): RankedStrategy[] {
  const ordered: RankedStrategy[] = [];
  const seen = new Set<string>();
  const add = (entry: RankedStrategy | null | undefined) => {
    if (!entry?.candidate) return;
    const id = entry.candidate.id ? String(entry.candidate.id) : "";
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    ordered.push(entry);
  };
  add(input.bestTrade?.best);
  for (const entry of Array.isArray(input.ranked) ? input.ranked : []) add(entry);
  for (const alternative of input.bestTrade?.alternatives ?? []) add(alternative);
  return ordered;
}

/** Flatten the panel/AI result into the report's row model. */
export function normalizeStrategyRows(input: StrategyReportInput): NormalizedStrategyRow[] {
  const ranked = strategyReportCandidates(input);
  const aiById = new Map((input.ai?.rows ?? []).map((row) => [String(row.candidateId), row]));
  return ranked
    .map((entry, index) => {
      const candidate = entry.candidate;
      const ai = aiById.get(String(candidate.id));
      return {
        rank: Number.isFinite(entry.rank) ? entry.rank : index + 1,
        strategy: String(candidate.type ?? candidate.label ?? "strategy"),
        label: String(candidate.label ?? candidate.type ?? "Strategy"),
        symbol: String(candidate.symbol ?? input.symbol ?? ""),
        expiration: String(candidate.expirationDate ?? ""),
        legs: (candidate.legs ?? []).map(legText).join(" · "),
        legCount: (candidate.legs ?? []).length,
        netDebit: Number.isFinite(candidate.netDebit) ? candidate.netDebit : null,
        maxProfit: candidate.maxProfitUnbounded ? null : (candidate.maxProfit ?? null),
        maxLoss: Number.isFinite(candidate.maxLoss) ? candidate.maxLoss : null,
        breakevens: (candidate.breakevens ?? []).map((b) => Number(b).toFixed(2)).join(" / "),
        rewardRisk: Number.isFinite(candidate.targetRewardRisk) ? candidate.targetRewardRisk : null,
        probabilityOfProfit: Number.isFinite(candidate.modelImpliedProbabilityOfProfit)
          ? candidate.modelImpliedProbabilityOfProfit
          : null,
        compositeScore: Number.isFinite(entry.compositeScore) ? entry.compositeScore : null,
        aiRank: Number.isFinite(ai?.rank as number) ? (ai!.rank as number) : null,
        aiScore: Number.isFinite(ai?.score as number) ? (ai!.score as number) : null,
        aiRationale: String(ai?.rationale ?? ""),
        rationale: String((candidate as { rationale?: unknown }).rationale ?? (candidate.explanations ?? []).join(" ")),
      };
    });
}

export function strategyReportTitle(input: StrategyReportInput): string {
  const symbol = input.symbol || "watchlist";
  const action = input.action || "strategies";
  return input.title ?? `Options strategy ${action.includes("llm") ? "AI" : "screener"} — ${symbol}`;
}

export function strategyReportFileName(input: StrategyReportInput, format: StrategyReportFormat): string {
  const symbol = String(input.symbol || "watchlist").toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  const action = String(input.action || "strategies").replace(/[^a-z0-9_-]/gi, "");
  return `options-strategy-${symbol}-${action}.${format}`;
}

export interface StrategyReportArtifactOutcome {
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

/** Download links a stored strategy run serves, on the existing options routes. */
export interface StrategyReportArtifactLinks {
  pdfKey?: string;
  reportUrl?: string;
  xlsxKey?: string;
  xlsxUrl?: string;
  csvKey?: string;
  csvUrl?: string;
}

/**
 * Map a run's stored keys to the established options download URLs.
 *
 * A failed leg has no key, so it contributes no link — the response
 * never carries a URL that 404s (#1278's failure contract). Returns
 * `{}` when the run produced nothing.
 */
export function strategyReportArtifactLinks(outcome: StrategyReportArtifactOutcome): StrategyReportArtifactLinks {
  const links: StrategyReportArtifactLinks = {};
  if (outcome.pdfKey) {
    links.pdfKey = outcome.pdfKey;
    links.reportUrl = `/api/options/report.pdf?key=${encodeURIComponent(outcome.pdfKey)}`;
  }
  if (outcome.xlsxKey) {
    links.xlsxKey = outcome.xlsxKey;
    links.xlsxUrl = `/api/options/report.xlsx?key=${encodeURIComponent(outcome.xlsxKey)}`;
  }
  if (outcome.csvKey) {
    links.csvKey = outcome.csvKey;
    links.csvUrl = `/api/options/report.csv?key=${encodeURIComponent(outcome.csvKey)}`;
  }
  return links;
}

/**
 * Derive the report's coverage from the resolved scope and the rows that
 * actually reached the page. Report-side only: it never changes what was
 * evaluated, it states what the document shows and why the rest is absent.
 */
export function buildStrategyReportCoverage(args: {
  scope: ResolvedOptionsReportScope;
  reported: string[];
  evaluations?: Array<{ id?: unknown; status?: unknown; summary?: unknown }>;
}): StrategyReportCoverage {
  const reportedStrategyIds = [...new Set(args.reported.filter(Boolean))];
  const evaluatedStrategyIds = [
    ...new Set(
      (args.evaluations ?? [])
        .map((entry) => (typeof entry?.id === "string" ? entry.id : ""))
        .filter(Boolean),
    ),
  ];
  const reported = new Set(reportedStrategyIds);
  const evaluated = new Set(evaluatedStrategyIds);
  const evaluationById = new Map(
    (args.evaluations ?? [])
      .map((entry) => (typeof entry?.id === "string" ? ([entry.id, entry] as const) : null))
      .filter((entry) => entry !== null),
  );
  const notReported = args.scope.strategyIds
    .filter((id) => !reported.has(id))
    .map((id) => {
      const horizon = args.scope.horizonLimited.find((entry) => entry.id === id);
      const evaluation = evaluationById.get(id);
      const skipped = evaluation?.status === "skipped";
      const skipSummary = typeof evaluation?.summary === "string" ? evaluation.summary : "";
      const reason = horizon
        ? `requires expiries beyond the fetched chain (catalog horizon ${horizon.horizonDte} DTE > ${args.scope.chains.dte.maxDte} DTE)`
        : skipped
          ? `skipped by the engine${skipSummary ? `: ${skipSummary}` : ""}`
          : args.scope.thesisExcluded.includes(id)
            ? "selected, but not thesis-aligned and the scope evaluates only the wanted thesis set"
            : evaluated.has(id)
              ? "evaluated, but no ranked candidate survived the acceptance gates or the report's candidate limit"
              : "not evaluated: no candidate was built on the fetched chain";
      return { id, label: defaultRegistry.get(id)?.label ?? id, reason };
    });
  return {
    scope: describeReportScope(args.scope),
    preset: args.scope.preset,
    theses: args.scope.theses,
    wantedStrategyIds: args.scope.strategyIds,
    reportedStrategyIds,
    evaluatedStrategyIds,
    notReported,
    warnings: args.scope.warnings.map((warning) => `${warning.axis}: ${warning.value} — ${warning.message}`),
  };
}

/**
 * Normalize any strategy surface's execution data into the report
 * input: the panel routes pass `data.ranked` / `bestTrade`; the
 * unified actions pass `data.ranked`, `data.quant.ranked`, `bestTrade`,
 * and `data.llm` (AI rank/score/rationale).
 *
 * The request also resolves the report scope (issue #2577), so every
 * strategy report states the scope it was produced under and which wanted
 * strategies are absent — without the caller passing anything new.
 */
export function buildStrategyReportInput(args: {
  action?: string;
  request?: Record<string, any>;
  data?: Record<string, any>;
  symbol?: string;
  summary?: string;
  generatedAt?: string;
  /** Pre-resolved scope (callers that already resolved it); otherwise derived from `request`. */
  scope?: ResolvedOptionsReportScope;
  coverage?: StrategyReportCoverage | null;
}): StrategyReportInput {
  const data = args.data ?? {};
  const request = args.request ?? {};
  const ranked: RankedStrategy[] = Array.isArray(data.ranked)
    ? data.ranked
    : Array.isArray(data.quant?.ranked)
      ? data.quant.ranked
      : [];
  const bestTrade = data.bestTrade ?? data.best ?? null;
  const llm = data.llm;
  // AI rows arrive in two shapes: the comparison pipeline's `ranked`
  // judgments (candidateId + score) and the evaluate panel's `rankings`
  // (rank-ordered, no id). The second resolves its candidate by rank,
  // which is exactly how the panel emitted it.
  const aiRows: StrategyReportAiRow[] = Array.isArray(llm?.ranked)
    ? llm.ranked
    : Array.isArray(llm?.rankings)
      ? llm.rankings
          .map((row: Record<string, any>, index: number): StrategyReportAiRow => {
            const rank = Number.isFinite(row?.rank) ? Number(row.rank) : index + 1;
            return {
              candidateId: String(ranked[rank - 1]?.candidate?.id ?? ""),
              rank,
              score: Number.isFinite(row?.score) ? Number(row.score) : undefined,
              rationale: typeof row?.rationale === "string" ? row.rationale : undefined,
            };
          })
          .filter((row: StrategyReportAiRow) => row.candidateId)
      : [];
  const symbol =
    String(args.symbol || data.symbol || ranked[0]?.candidate?.symbol || data.contracts?.[0]?.symbol || request.symbol || "").toUpperCase() ||
    undefined;
  const scope =
    args.scope ??
    resolveOptionsReportScope({
      ...(typeof request.thesis === "string" ? { thesis: request.thesis } : {}),
      ...(Array.isArray(request.allowedStrategies) && request.allowedStrategies.length > 0
        ? { strategies: request.allowedStrategies.map(String) }
        : {}),
      ...(Number.isFinite(request.candidateLimit) ? { candidateLimit: Number(request.candidateLimit) } : {}),
      ...(Number.isFinite(request.minDte) || Number.isFinite(request.maxDte)
        ? {
            dte: {
              ...(Number.isFinite(request.minDte) ? { minDte: Number(request.minDte) } : {}),
              ...(Number.isFinite(request.maxDte) ? { maxDte: Number(request.maxDte) } : {}),
            },
          }
        : {}),
    });
  const coverage =
    args.coverage === undefined
      ? buildStrategyReportCoverage({
          scope,
          reported: ranked.map((entry) => String(entry?.candidate?.type ?? "")),
          evaluations: Array.isArray(data.evaluations)
            ? data.evaluations
            : Array.isArray(data.strategies?.evaluations)
              ? data.strategies.evaluations
              : undefined,
        })
      : args.coverage;

  return {
    symbol,
    action: args.action,
    coverage,
    thesis: typeof request.thesis === "string" ? request.thesis : undefined,
    riskProfile: typeof request.riskProfile === "string" ? request.riskProfile : undefined,
    generatedAt: args.generatedAt,
    summary: args.summary,
    ranked,
    bestTrade,
    ai: llm ? { model: llm.model, rows: aiRows, status: llm.status } : undefined,
    screenedOut: Array.isArray(data.screenedOut) ? data.screenedOut : undefined,
  };
}

const CSV_COLUMNS = [
  "rank",
  "strategy",
  "label",
  "symbol",
  "expiration",
  "legs",
  "net_debit",
  "max_profit",
  "max_loss",
  "breakevens",
  "reward_risk",
  "probability_of_profit",
  "composite_score",
  "ai_rank",
  "ai_score",
  "ai_rationale",
] as const;

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowCells(row: NormalizedStrategyRow): Array<string | number | null> {
  return [
    row.rank,
    row.strategy,
    row.label,
    row.symbol,
    row.expiration,
    row.legs,
    row.netDebit,
    row.maxProfit,
    row.maxLoss,
    row.breakevens,
    row.rewardRisk,
    row.probabilityOfProfit,
    row.compositeScore,
    row.aiRank,
    row.aiScore,
    row.aiRationale,
  ];
}

export function generateStrategyReportCsv(input: StrategyReportInput): string {
  const rows = normalizeStrategyRows(input);
  const lines = [
    (CSV_COLUMNS as readonly string[]).join(","),
    ...rows.map((row) => rowCells(row).map(csvEscape).join(",")),
  ];
  return lines.join("\n") + "\n";
}

export function generateStrategyReportXlsx(input: StrategyReportInput): Uint8Array {
  const rows = normalizeStrategyRows(input);
  const wb = XLSX.utils.book_new();
  const strategies = XLSX.utils.json_to_sheet(
    rows.map((row) => ({
      rank: row.rank,
      strategy: row.strategy,
      label: row.label,
      symbol: row.symbol,
      expiration: row.expiration,
      legs: row.legs,
      net_debit: row.netDebit,
      max_profit: row.maxProfit,
      max_loss: row.maxLoss,
      breakevens: row.breakevens,
      reward_risk: row.rewardRisk,
      probability_of_profit: row.probabilityOfProfit,
      composite_score: row.compositeScore,
      ai_rank: row.aiRank,
      ai_score: row.aiScore,
      ai_rationale: row.aiRationale,
    })),
  );
  XLSX.utils.book_append_sheet(wb, strategies, "Strategies");

  const legRows: Array<Record<string, unknown>> = [];
  for (const entry of strategyReportCandidates(input)) {
    for (const leg of entry.candidate?.legs ?? []) {
      legRows.push({
        strategy: entry.candidate.label ?? entry.candidate.type,
        rank: entry.rank,
        symbol: leg.symbol,
        option_type: leg.optionType,
        side: leg.side,
        quantity: leg.quantity,
        strike: leg.strike,
        expiration: leg.expirationDate,
        entry_price: leg.entryPrice,
        implied_volatility: leg.impliedVolatility,
        delta: leg.delta,
        open_interest: leg.openInterest,
        volume: leg.volume,
      });
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(legRows), "Legs");

  const summary = XLSX.utils.aoa_to_sheet([
    ["field", "value"],
    ["title", strategyReportTitle(input)],
    ["symbol", input.symbol ?? ""],
    ["action", input.action ?? ""],
    ["thesis", input.thesis ?? ""],
    ["risk_profile", input.riskProfile ?? ""],
    ["generated_at", input.generatedAt ?? ""],
    ["ranked_strategies", rows.length],
    ["ai_model", input.ai?.model ?? ""],
    ["ai_status", input.ai?.status ?? ""],
    ["screened_out", (input.screenedOut ?? []).length],
  ]);
  XLSX.utils.book_append_sheet(wb, summary, "Summary");

  // Issue #2577: coverage is a first-class sheet, not a footnote. It is the
  // difference between "3 strategies" and "3 of 74 reported, 71 with a
  // named reason", which is the question every short report raises.
  if (input.coverage) {
    const coverageRows = input.coverage.wantedStrategyIds.map((id) => {
      const missing = input.coverage!.notReported.find((entry) => entry.id === id);
      return {
        strategy: id,
        label: missing?.label ?? defaultRegistry.get(id)?.label ?? id,
        reported: missing ? "no" : "yes",
        reason: missing?.reason ?? "",
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(coverageRows), "Coverage");
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["field", "value"],
        ["scope", input.coverage.scope],
        ["preset", input.coverage.preset],
        ["theses", input.coverage.theses.join(", ")],
        ["wanted_strategies", input.coverage.wantedStrategyIds.length],
        ["reported_strategies", input.coverage.reportedStrategyIds.length],
        ["not_reported", input.coverage.notReported.length],
        ["warnings", input.coverage.warnings.join(" | ")],
      ]),
      "Coverage Summary",
    );
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Uint8Array;
}

export async function generateStrategyReportPdf(input: StrategyReportInput): Promise<Uint8Array> {
  const rows = normalizeStrategyRows(input);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 48;
  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const wrap = (text: string, width: number, size: number): string[] => {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > width && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines.length > 0 ? lines : [""];
  };

  const ensure = (needed: number) => {
    if (y - needed < margin) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  };

  const text = (value: string, size = 10, useBold = false, color = rgb(0, 0, 0), indent = 0) => {
    for (const line of wrap(value, pageWidth - margin * 2 - indent, size)) {
      ensure(size + 6);
      page.drawText(line, { x: margin + indent, y, size, font: useBold ? bold : font, color });
      y -= size + 5;
    }
  };

  const rule = () => {
    ensure(10);
    page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 0.6, color: rgb(0.82, 0.82, 0.82) });
    y -= 10;
  };

  text(strategyReportTitle(input), 17, true);
  const stamp = [
    input.symbol ? `Symbol: ${input.symbol}` : null,
    input.action ? `Mode: ${input.action}` : null,
    input.thesis ? `Thesis: ${input.thesis}` : null,
    input.riskProfile ? `Risk: ${input.riskProfile}` : null,
    input.generatedAt ? `Generated: ${input.generatedAt}` : null,
  ].filter(Boolean).join("  ·  ");
  if (stamp) text(stamp, 9, false, rgb(0.42, 0.42, 0.42));
  if (input.summary) text(input.summary, 10);
  if (input.coverage) {
    const coverage = input.coverage;
    text(
      `Scope: ${coverage.scope}`,
      9,
      false,
      rgb(0.42, 0.42, 0.42),
    );
    text(
      `Coverage: ${coverage.reportedStrategyIds.length} of ${coverage.wantedStrategyIds.length} wanted strategies reported`
        + ` (theses: ${coverage.theses.join(", ") || "—"})`,
      9,
      false,
      rgb(0.42, 0.42, 0.42),
    );
    if (coverage.notReported.length > 0) {
      text("Not reported in this document:", 9, true);
      for (const entry of coverage.notReported.slice(0, 12)) {
        text(`${entry.id} — ${entry.reason}`, 8, false, rgb(0.45, 0.45, 0.45), 8);
      }
      if (coverage.notReported.length > 12) {
        text(`…and ${coverage.notReported.length - 12} more (full list in the XLSX Coverage sheet).`, 8, false, rgb(0.45, 0.45, 0.45), 8);
      }
    }
    for (const warning of coverage.warnings.slice(0, 5)) {
      text(`Scope warning — ${warning}`, 8, false, rgb(0.72, 0.45, 0), 8);
    }
  }
  if (input.ai?.status === "error") {
    text("AI ranking failed for this run; quant ranks stand alone.", 9, false, rgb(0.72, 0.2, 0.2));
  }
  rule();

  if (rows.length === 0) {
    text("No qualifying strategies for this run.", 11, true);
  }

  rows.forEach((row, index) => {
    ensure(90);
    text(`#${row.rank ?? index + 1}  ${row.label}  (${row.strategy})`, 12, true);
    const economics = [
      `Debit/credit: ${money(row.netDebit)}`,
      `Max profit: ${row.maxProfit === null ? "unbounded/—" : money(row.maxProfit)}`,
      `Max loss: ${money(row.maxLoss)}`,
      `Breakevens: ${row.breakevens || "—"}`,
      `R/R: ${row.rewardRisk === null ? "—" : row.rewardRisk.toFixed(2)}`,
      `POP: ${pct(row.probabilityOfProfit)}`,
      `Score: ${row.compositeScore === null ? "—" : row.compositeScore.toFixed(1)}`,
      row.aiRank !== null ? `AI rank: ${row.aiRank}` : null,
      row.aiScore !== null ? `AI score: ${row.aiScore.toFixed(1)}` : null,
    ].filter(Boolean).join("  ·  ");
    text(economics, 9);
    text(`Expiration: ${row.expiration || "—"}  ·  Legs: ${row.legCount}`, 9, false, rgb(0.42, 0.42, 0.42));
    if (row.legs) text(row.legs, 9, false, rgb(0.25, 0.25, 0.25), 8);
    if (row.rationale) text(`Why: ${row.rationale}`, 9, false, rgb(0.42, 0.42, 0.42), 8);
    if (row.aiRationale) text(`AI: ${row.aiRationale}`, 9, false, rgb(0.3, 0.35, 0.55), 8);
    rule();
  });

  if ((input.screenedOut ?? []).length > 0) {
    ensure(40);
    text("Screened out", 11, true);
    for (const item of (input.screenedOut ?? []).slice(0, 20)) {
      text(`${item.id} — ${item.reason}`, 9, false, rgb(0.42, 0.42, 0.42));
    }
  }

  return doc.save();
}
