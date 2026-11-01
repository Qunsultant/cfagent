import { useContext, useEffect, useMemo, useState, createContext, useRef } from "react";
import { Button, Checkbox, FieldShell, Select, Table, TextInput } from "../components/ui";
import { apiFetch as fetch } from "../apiFetch";
import type {
  ExpectedIvDirection,
  OptionStrategyType,
  OptionThesis,
  StrategyCandidate,
  StrategyLeg,
  StrategyRecommendationResult,
} from "../../trading/options/strategyEngine";
import { contractKey, reviseCandidate } from "../../trading/options/strategyEngine";
import { toLeg } from "../../trading/options/strategies/legs";
import type { ScreenedOptionContractItem } from "../../types";
import type { StrategyEvaluation } from "../../trading/options/strategies/types";
import { ResearchReportActions } from "../ResearchReportActions";
import { stageBundleCandidate } from "../portfolioRiskApi";
import { defaultRegistry } from "../../trading/options/strategies/catalog";
import { StrategyDiscoveryPanel } from "./StrategyDiscoveryPanel";
import { DiscoveryRunsPanel } from "./DiscoveryRunsPanel";
import { ScreeningActivityPanel } from "./ScreeningActivityPanel";
import { UniversalChart } from "../components/UniversalChart";
import { LlmStrategyEvalModal, type StrategyToEvaluate } from "./LlmStrategyEvalModal";
import { LlmOptionsIdeasPanel } from "./LlmOptionsIdeasPanel";
import { EtapiConfigModal } from "./EtapiConfigModal";
import { AutonomousOptionsRuns } from "./AutonomousOptionsRuns";
import { ScheduledOptionsRunForm } from "./ScheduledOptionsRunForm";
import { RawContractsScreener } from "./RawContractsScreener";
import { RiskAnalysisModal } from "./RiskAnalysisModal";
import { ThreeWayComparison, type ThreeWayComparisonData } from "./ThreeWayComparison";
import type { RiskSubject } from "./riskManagementEngine";
import type { TradeOrderContext } from "../trading/tradeOrderContext";
import { TabHoverItem } from "../TabHoverItem";
import { CapabilityNavBar, CopilotTriggerButton, type CapabilityTabItem } from "../components/CapabilityNavBar";
import { OptionsDataDownloadDropdown } from "./OptionsDataDownloadDropdown";
import "./strategyDiscovery.css";
import "./optionsResearch.css";

interface OptionsResearchPanelProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
  onJobStateChange?: (state: "idle" | "running" | "ready") => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  /** C2 (consolidation #1151, issue #1246): switch to the hub's
   *  Schedules tab — the in-hub successor to this panel's schedules
   *  mode "moved" note. Absent when the panel is hosted elsewhere. */
  onOpenSchedules?: () => void;
}

export type { TradeOrderContext } from "../trading/tradeOrderContext";

function toTradeContext(candidate: StrategyCandidate, thesis: OptionThesis, underlyingPrice?: number): TradeOrderContext {
  const optionLegs = candidate.legs.map((leg) => ({
    securityType: leg.optionType === "STOCK" ? "EQ" as const : "OPTN" as const,
    side: leg.side,
    quantity: leg.quantity,
    optionType: leg.optionType === "STOCK" ? undefined : leg.optionType,
    strike: leg.optionType === "STOCK" ? undefined : leg.strike,
    expirationDate: leg.optionType === "STOCK" ? undefined : leg.expirationDate,
  }));
  return {
    assetClass: optionLegs.some((leg) => leg.securityType === "OPTN") ? "options" : "equity",
    symbol: candidate.symbol,
    action: thesis === "bearish" ? "SELL_SHORT" : "BUY",
    quantity: 1,
    underlyingPrice,
    label: `${candidate.label} (${candidate.expirationDate}), max loss ${candidate.maxLoss === null ? "unlimited" : `$${candidate.maxLoss}`}`,
    legs: candidate.legs.map((leg) => `${leg.side} ${leg.quantity} ${leg.symbol} @ $${leg.entryPrice.toFixed(2)}`),
    optionLegs,
    strategyNetDebit: candidate.netDebit,
  };
}

function candidateToRiskSubject(candidate: StrategyCandidate): RiskSubject {
  return {
    title: candidate.label,
    underlyingSymbol: candidate.symbol,
    underlyingPrice: candidate.underlyingPrice,
    strategyType: candidate.type,
    sentiment: "directional",
    expirationDate: candidate.expirationDate,
    dte: candidate.legs[0]?.daysToExpiration,
    netDebit: candidate.netDebit,
    maxLoss: candidate.maxLoss,
    maxProfit: candidate.maxProfit,
    chanceOfProfit: candidate.modelImpliedProbabilityOfProfit * 100,
    breakevens: candidate.breakevens,
    breakevenText: candidate.breakevens.map((b) => `$${b.toFixed(2)}`).join(" · "),
    legsText: candidate.legs.map((l) => `${l.side} ${l.quantity} ${l.symbol}`).join(" / "),
    legs: candidate.legs.map((l) => ({
      side: l.side,
      quantity: l.quantity,
      entryPrice: l.entryPrice,
      strike: l.strike,
      optionType: l.optionType,
      expirationDate: l.expirationDate,
      iv: l.impliedVolatility,
      delta: l.delta,
      gamma: l.gamma,
      theta: l.theta,
      vega: l.vega,
    })),
    netGreeks: {
      delta: candidate.netGreeks.delta,
      gamma: candidate.netGreeks.gamma,
      theta: candidate.netGreeks.theta,
      vega: candidate.netGreeks.vega,
    },
  };
}

type PreviewTrade = (candidate: StrategyCandidate) => void;

function legsText(candidate?: StrategyCandidate): string {
  return candidate?.legs.map((leg) => `${leg.side} ${leg.quantity} ${leg.symbol}`).join(" / ") || "—";
}

interface LlmInputPreview {
  objective: string;
  system: string;
  instruction: string;
  request: Record<string, unknown>;
  contractCount: number;
  candidateCount: number;
  promptCharacters: number;
  contractsSample: Array<Record<string, unknown>>;
  candidatesSent: Array<Record<string, unknown>>;
}

function LlmInputPanel({ input }: { input?: LlmInputPreview }) {
  if (!input) return null;
  return (
    <div className="options-llm-input">
      <p><b>Objective:</b> {input.objective}</p>
      <details>
        <summary>Input sent to the LLM ({input.contractCount} contracts, {input.candidateCount} candidate trades, ~{input.promptCharacters.toLocaleString()} characters)</summary>
        <p><b>System prompt:</b> {input.system}</p>
        <p><b>Instruction:</b> {input.instruction}</p>
        <p><b>Request:</b></p>
        <pre>{JSON.stringify(input.request, null, 2)}</pre>
        <p><b>Candidate trades sent (all):</b></p>
        <pre>{JSON.stringify(input.candidatesSent, null, 2)}</pre>
        <p><b>Contract sample (first {input.contractsSample.length} of {input.contractCount}; full set is sent):</b></p>
        <pre>{JSON.stringify(input.contractsSample, null, 2)}</pre>
      </details>
    </div>
  );
}

const strategyGroups = defaultRegistry.list().reduce<Record<string, Array<{ id: OptionStrategyType; label: string }>>>((groups, def) => {
  (groups[def.category] ||= []).push({ id: def.id, label: def.label });
  return groups;
}, {});

type RiskProfile = "conservative" | "balanced" | "aggressive";

const workflowSteps = [
  {
    step: 1,
    title: "Options data and screener",
    blurb: "Find liquid single contracts (delta, DTE, volume, open interest, spread, quote age).",
    examples: ["Screen call options for NVDA with delta above 0.35, 20 to 45 DTE, volume over 50, open interest above 500, spread under 10%"],
  },
  {
    step: 2,
    title: "Strategy and risk screener",
    blurb: "Build multi-leg strategies and rank them by max loss, breakevens and probability of profit.",
    examples: [
      "Rank bullish NVDA call debit spreads and put credit spreads target $260 in 30 days max loss $500",
      "Show iron condors on SPY 20 to 45 DTE max loss $400 pop above 50%",
    ],
  },
  {
    step: 3,
    title: "Strategy universe",
    blurb: "See every strategy in the catalog that was evaluated, as a sortable ledger with passed/failed verdicts and reasons.",
    examples: ["list all strategies evaluated for NVDA bullish target $260"],
  },
  {
    step: 4,
    title: "Best-trade picker",
    blurb: "Rank by risk profile and pick one trade with a trade plan, confidence and blockers. Add a watchlist or a market-cap scope to scan many stocks.",
    examples: [
      "What is the best trade for NVDA bullish target $260 by 2026-11-20 max loss $500 conservative",
      "Find the best bullish option trades across my Semis watchlist max loss $500",
      "Find best bullish option opportunities across large cap stocks top 10 max loss $500 conservative",
    ],
  },
];
const nlqExamples = workflowSteps.flatMap((s) => s.examples);

interface BestTradeData {
  status: "recommended" | "research_only" | "no_trade";
  riskProfile: RiskProfile;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  best?: { candidate: StrategyCandidate; compositeScore: number };
  alternatives: Array<{ rank: number; candidate: StrategyCandidate; compositeScore: number }>;
  tradePlan?: Array<{ action: string; quantity: number; contract: string; optionType: string; strike: number; expiration: string; limitPrice: number }>;
  rationale: string[];
  blockers: string[];
  disclaimer: string;
}

interface ComparisonData {
  llmInput?: LlmInputPreview;
  quantStrategyPool?: Array<{ type: string; label: string; generated: number; bestScore: number }>;
  quant: {
    ranked: Array<{ rank: number; compositeScore: number; candidate: StrategyCandidate }>;
    scoreWeights: StrategyRecommendationResult["scoreWeights"];
    candidateCount: number;
  };
  llm: {
    status: "complete" | "error";
    model?: string;
    error?: string;
    ranked?: Array<{ candidateId: string; rank?: number; score: number; rationale: string; risks: string[] }>;
  };
}

function BestTradeCard({
  pick,
  onPreview,
  onEvaluateLlm,
  onRiskAnalysis,
  onSendToBundle,
}: {
  pick: BestTradeData;
  onPreview?: PreviewTrade;
  onEvaluateLlm?: (strategy: StrategyToEvaluate) => void;
  onRiskAnalysis?: (subject: RiskSubject) => void;
  onSendToBundle?: (candidate: StrategyCandidate) => void;
}) {
  return (
    <section className={`options-best-trade options-best-trade-${pick.status}`} role="region" aria-label="Best trade">
      <header className="options-results-header">
        <h2>{pick.status === "no_trade" ? "No qualifying trade" : `Best trade: ${pick.best?.candidate.label}`}</h2>
        <span>{pick.status.replace("_", " ").toUpperCase()} · {pick.confidence} confidence · {pick.riskProfile} profile</span>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
          {pick.best && onPreview && <Button type="button" onClick={() => onPreview(pick.best!.candidate)}>⚡ Open in Fast Order Ticket</Button>}
          {pick.best && onEvaluateLlm && (
            <Button
              type="button"
              className="options-eval-llm-btn"
              onClick={() => onEvaluateLlm(candidateToEval(pick.best!.candidate))}
              title="Evaluate this top trade recommendation with neural strategy AI against complete option chains"
            >
              🧠 Evaluate with AI
            </Button>
          )}
          {pick.best && onRiskAnalysis && (
            <Button variant="warning" tone="subtle" size="sm"
              type="button"
              onClick={() => onRiskAnalysis(candidateToRiskSubject(pick.best!.candidate))}
              title="Analyze Risk and Defense Playbook for Top Trade"
            >
              🛡️ Risk Analysis
            </Button>
          )}
          {pick.best && onSendToBundle && (
            <Button type="button" onClick={() => onSendToBundle(pick.best!.candidate)} title="Stage this candidate for the bundle builder (Portfolio & Risk panel)">
              📦 Send to bundle builder
            </Button>
          )}
        </div>
      </header>
      <ul className="options-explanations">{pick.rationale.map((line) => <li key={line}>{line}</li>)}</ul>
      {pick.blockers.length > 0 && <ul className="options-warnings">{pick.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      {pick.tradePlan && pick.tradePlan.length > 0 && (
        <div className="options-scenario-table-wrap">
          <h4>Trade plan (preview only, requires your approval)</h4>
          <Table
            className="options-scenario-table"
            columns={[
              { key: "action", header: "Action", render: (leg) => leg.action },
              { key: "qty", header: "Qty", render: (leg) => leg.quantity },
              { key: "contract", header: "Contract", render: (leg) => leg.contract },
              { key: "type", header: "Type", render: (leg) => leg.optionType },
              { key: "strike", header: "Strike", render: (leg) => `$${leg.strike}` },
              { key: "expiration", header: "Expiration", render: (leg) => leg.expiration },
              { key: "limit", header: "Limit", render: (leg) => `$${leg.limitPrice.toFixed(2)}` },
            ]}
            rows={pick.tradePlan}
            rowKey={(leg) => `${leg.contract}:${leg.action}`}
          />
        </div>
      )}
      {pick.best && <StrategyCard candidate={pick.best.candidate} onPreview={onPreview} onEvaluateLlm={onEvaluateLlm} onRiskAnalysis={onRiskAnalysis} onSendToBundle={onSendToBundle} />}
      {pick.alternatives.length > 0 && (
        <details className="options-excluded">
          <summary>{pick.alternatives.length} runner-up trades</summary>
          <div className="options-scenario-table-wrap">
            <Table
                className="options-scenario-table"
                columns={[
                  { key: "rank", header: "#", render: (alt) => alt.rank },
                  { key: "strategy", header: "Strategy", render: (alt) => (
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1-5)" }}>
                                          <span>{alt.candidate.label}</span>
                                          {onEvaluateLlm && (
                                            <Button
                                              type="button"
                                              className="options-eval-llm-btn"
                                              style={{ padding: "var(--space-0-5) var(--space-1-5)", fontSize: "var(--font-size-micro)" }}
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                onEvaluateLlm(candidateToEval(alt.candidate));
                                              }}
                                              title="Evaluate runner-up trade with AI"
                                            >
                                              🧠 AI
                                            </Button>
                                          )}
                                          {onRiskAnalysis && (
                                            <Button variant="warning" tone="subtle" size="sm"
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                onRiskAnalysis(candidateToRiskSubject(alt.candidate));
                                              }}
                                              title="Analyze risk for this trade"
                                            >
                                              🛡️ Risk
                                            </Button>
                                          )}
                                        </div>
                  ) },
                  { key: "expiry", header: "Expiry", render: (alt) => alt.candidate.expirationDate },
                  { key: "maxLoss", header: "Max loss", render: (alt) => dollars(alt.candidate.maxLoss) },
                  { key: "pop", header: "POP", render: (alt) => `${(alt.candidate.modelImpliedProbabilityOfProfit * 100).toFixed(1)}%` },
                  { key: "score", header: "Score", render: (alt) => alt.compositeScore.toFixed(1) },
                ]}
                rows={pick.alternatives}
                rowKey={(alt) => alt.candidate.id}
                rowClassName={onPreview ? "options-clickable-row" : ""}
                onRowClick={onPreview ? (alt) => onPreview(alt.candidate) : undefined}
                rowTitle="Open in Fast Order Ticket"
              />
          </div>
        </details>
      )}
      <p className="ui-footnote">{pick.disclaimer}</p>
    </section>
  );
}

function RecommendationComparison({ data, onPreview }: { data: ComparisonData; onPreview?: PreviewTrade }) {
  const llmById = new Map((data.llm.ranked || []).map((item) => [item.candidateId, item]));

  return (
    <section className="options-comparison" aria-label="Quant and LLM recommendation comparison">
      <header className="options-results-header">
        <h2>Quant vs. AI ranking</h2>
        <span>{data.llm.model || "Neural Strategy Model"} · {data.quant.candidateCount} shared candidates</span>
      </header>
      <LlmInputPanel input={data.llmInput} />
      {data.quantStrategyPool && data.quantStrategyPool.length > 0 && (
        <details className="options-excluded">
          <summary>{data.quantStrategyPool.length} strategy types evaluated by the quant engine</summary>
          <ul>{data.quantStrategyPool.map((s) => <li key={s.type}>{s.label}: {s.generated} trades generated, best score {s.bestScore.toFixed(1)}</li>)}</ul>
        </details>
      )}
      <p className="options-comparison-note">
        Both rank the same quant-generated, risk-screened trades from the same option-chain snapshot. The AI score is an analytical assessment, not a pricing model or forecast.
      </p>
      {data.llm.status === "error" && <div className="options-error" role="alert">Quant results are available, but the LLM ranking failed: {data.llm.error}</div>}
      {data.quant.ranked.length === 0 ? <p>No quant candidates passed the request constraints.</p> : (
        <div className="options-table-scroll">
          <Table
            className="options-comparison-table"
            columns={[
              { key: "strategy", header: "Strategy", render: (item) => item.candidate.label },
              { key: "legs", header: "Trade (legs)", render: (item) => legsText(item.candidate) },
              { key: "quantRank", header: "Quant rank", render: (item) => item.rank },
              { key: "quantScore", header: "Quant score", render: (item) => item.compositeScore.toFixed(2) },
              { key: "aiRank", header: "AI rank", render: (item) => llmById.get(item.candidate.id)?.rank ?? "—" },
              { key: "aiScore", header: "AI score", render: (item) => { const j = llmById.get(item.candidate.id); return j ? j.score.toFixed(0) : "—"; } },
              { key: "aiRationale", header: "AI rationale", render: (item) => llmById.get(item.candidate.id)?.rationale || "—" },
              { key: "aiRisks", header: "AI risks", render: (item) => llmById.get(item.candidate.id)?.risks.join("; ") || "—" },
            ]}
            rows={data.quant.ranked}
            rowKey={(item) => item.candidate.id}
            rowClassName={onPreview ? "options-clickable-row" : ""}
            onRowClick={onPreview ? (item) => onPreview(item.candidate) : undefined}
            rowTitle="Open in Fast Order Ticket"
          />
        </div>
      )}
      {data.llm.status === "complete" && (data.llm.ranked || []).length === 0 && data.quant.ranked.length > 0 && (
        <p>The LLM returned no ranking for this candidate set.</p>
      )}
      <p className="options-assumptions">Research comparison only; neither ranking is personalized financial advice or an instruction to trade. Verify live quotes and all assumptions before acting.</p>
    </section>
  );
}

function defaultTargetDate(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dollars(value: number | null): string {
  return value === null ? "Unlimited" : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedDollars(value: number): string {
  const text = Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < 0 ? "-" : ""}$${text}`;
}

function breakevenText(candidate: StrategyCandidate): string {
  if (!candidate.breakevens.length) return "None";
  const price = (value: number) => `$${value.toFixed(2)}`;
  if (candidate.breakevens.length === 1) {
    const curve = candidate.payoffCurve;
    const profitsAbove = curve.length > 0 && curve[curve.length - 1].pnl > curve[0].pnl;
    return `${profitsAbove ? "Above" : "Below"} ${price(candidate.breakevens[0])}`;
  }
  return candidate.breakevens.map(price).join(" · ");
}

export function candidateToEval(candidate: StrategyCandidate, thesis?: OptionThesis, targetPrice?: number): StrategyToEvaluate {
  return {
    symbol: candidate.symbol,
    strategyName: candidate.label,
    sentiment: thesis || "bullish",
    targetPrice,
    expirationDate: candidate.expirationDate,
    dte: candidate.scenarios[0]?.daysToExpiry,
    legsText: candidate.legs.map((leg) => `${leg.side} ${leg.quantity} ${leg.symbol}`).join(" / "),
    netDebit: candidate.netDebit,
    maxLoss: candidate.maxLoss,
    maxProfit: candidate.maxProfit,
    chanceOfProfit: Math.round(candidate.modelImpliedProbabilityOfProfit * 100),
    breakevenText: breakevenText(candidate),
    underlyingPrice: candidate.underlyingPrice,
    legs: candidate.legs.map((leg) => `${leg.side} ${leg.quantity} ${leg.symbol} @ $${leg.entryPrice.toFixed(2)}`),
    optionLegs: candidate.legs.map((leg) => ({
      securityType: leg.optionType === "STOCK" ? "EQ" as const : "OPTN" as const,
      side: leg.side,
      quantity: leg.quantity,
      optionType: leg.optionType === "STOCK" ? undefined : leg.optionType,
      strike: leg.optionType === "STOCK" ? undefined : leg.strike,
      expirationDate: leg.optionType === "STOCK" ? undefined : leg.expirationDate,
    })),
  };
}

/** Margin is only estimable for defined-risk strategies, where the broker requirement equals the maximum loss. */
function estimatedMargin(candidate: StrategyCandidate): string {
  return Number.isFinite(candidate.maxLoss) && candidate.maxLoss !== null ? dollars(candidate.maxLoss) : "Broker-defined";
}

function niceTicks(min: number, max: number, count: number): number[] {
  const step = (max - min) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, index) => min + index * step);
}

function PayoffGraph({ candidate }: { candidate: StrategyCandidate }) {
  const [rangePct, setRangePct] = useState(15);
  const spot = candidate.underlyingPrice;
  const curve = candidate.payoffCurve;
  if (curve.length < 2) return null;

  const lo = spot * (1 - rangePct / 100);
  const hi = spot * (1 + rangePct / 100);
  const pnlAt = (price: number) => {
    if (price <= curve[0].underlyingPrice) return curve[0].pnl;
    for (let index = 1; index < curve.length; index++) {
      const a = curve[index - 1];
      const b = curve[index];
      if (price <= b.underlyingPrice) {
        const span = b.underlyingPrice - a.underlyingPrice || 1;
        return a.pnl + ((price - a.underlyingPrice) / span) * (b.pnl - a.pnl);
      }
    }
    return curve[curve.length - 1].pnl;
  };

  const inside = curve.filter((point) => point.underlyingPrice > lo && point.underlyingPrice < hi);
  const points = [{ x: lo, y: pnlAt(lo) }, ...inside.map((p) => ({ x: p.underlyingPrice, y: p.pnl })), { x: hi, y: pnlAt(hi) }];

  return (
    <div className="options-payoff-wrap">
      <UniversalChart
        mode="payoff"
        points={points}
        spotPrice={spot}
        breakevens={candidate.breakevens}
        width={720}
        height={280}
        ariaLabel={`${candidate.label} profit and loss at expiration`}
      />
      <TextInput label={`Range ±${rangePct}%`} type="range" min={2} max={50} step={1} value={rangePct} onChange={(event) => setRangePct(Number(event.target.value))} />
    </div>
  );
}

interface ChainContextValue {
  contracts: ScreenedOptionContractItem[];
  version: number;
  refreshing: boolean;
  refreshedAt: string | null;
  refreshError: string;
  refresh: () => Promise<void>;
  target: { targetPrice?: number; targetDate?: string; expectedIvDirection?: ExpectedIvDirection };
}

const ChainContext = createContext<ChainContextValue | null>(null);

function LegEditor({ legs, original, contracts, onChange }: {
  legs: StrategyLeg[];
  original: StrategyLeg[];
  contracts: ScreenedOptionContractItem[];
  onChange: (legs: StrategyLeg[]) => void;
}) {
  const replaceLeg = (index: number, contract: ScreenedOptionContractItem) => {
    const next = legs.slice();
    next[index] = toLeg(contract, legs[index].side, legs[index].quantity);
    onChange(next);
  };
  const changed = legs.some((leg, index) => leg.symbol !== original[index]?.symbol);

  return (
    <div className="options-leg-editor">
      {legs.map((leg, index) => {
        if (leg.optionType === "STOCK") {
          return <div className="options-leg-edit" key={`${leg.symbol}:${index}`}><strong>{leg.side} {leg.quantity} shares</strong></div>;
        }
        const sameType = contracts.filter((contract) => contract.optionType === leg.optionType);
        const expiries = Array.from(new Set([...sameType.map((contract) => contract.expirationDate), leg.expirationDate])).sort();
        const strikes = Array.from(new Set(sameType.filter((contract) => contract.expirationDate === leg.expirationDate).map((contract) => contract.strikePrice))).sort((a, b) => a - b);
        if (!strikes.includes(leg.strike)) strikes.push(leg.strike);
        strikes.sort((a, b) => a - b);
        const position = strikes.indexOf(leg.strike);
        const pick = (expiry: string, strike: number) => {
          const pool = sameType.filter((contract) => contract.expirationDate === expiry);
          if (!pool.length) return;
          const best = pool.reduce((nearest, contract) => (Math.abs(contract.strikePrice - strike) < Math.abs(nearest.strikePrice - strike) ? contract : nearest), pool[0]);
          replaceLeg(index, best);
        };
        return (
          <div className="options-leg-edit" key={`${index}:${leg.optionType}:${leg.side}`}>
            <strong>{leg.side} {leg.quantity} {leg.optionType}</strong>
            <Select label="Expiry" value={leg.expirationDate} onChange={(event) => pick(event.target.value, leg.strike)}>
              {expiries.map((expiry) => <option key={expiry} value={expiry}>{expiry}</option>)}
            </Select>
            <TextInput label={`Strike $${leg.strike}`}
              type="range"
              min={0}
              max={Math.max(0, strikes.length - 1)}
              step={1}
              value={Math.max(0, position)}
              disabled={strikes.length < 2}
              onChange={(event) => pick(leg.expirationDate, strikes[Number(event.target.value)])}
            />
            <span>Entry ${leg.entryPrice.toFixed(2)} <small>({leg.side === "BUY" ? "ask" : "bid"} {leg.bid.toFixed(2)} / {leg.ask.toFixed(2)})</small></span>
          </div>
        );
      })}
      {changed && <Button type="button" className="options-leg-reset" onClick={() => onChange(original)}>Reset to suggested legs</Button>}
    </div>
  );
}

function StrategyCard({
  candidate: suggested,
  onPreview,
  onEvaluateLlm,
  onRiskAnalysis,
  onSendToBundle,
}: {
  candidate: StrategyCandidate;
  onPreview?: PreviewTrade;
  onEvaluateLlm?: (strategy: StrategyToEvaluate) => void;
  onRiskAnalysis?: (subject: RiskSubject) => void;
  onSendToBundle?: (candidate: StrategyCandidate) => void;
}) {
  const chain = useContext(ChainContext);
  const [legs, setLegs] = useState<StrategyLeg[]>(suggested.legs);
  const [underlying, setUnderlying] = useState(suggested.underlyingPrice);
  const [missingLegs, setMissingLegs] = useState(0);

  useEffect(() => {
    setLegs(suggested.legs);
    setUnderlying(suggested.underlyingPrice);
    setMissingLegs(0);
  }, [suggested]);

  const chainVersion = chain?.version ?? 0;
  const contracts = chain?.contracts;
  useEffect(() => {
    if (!chainVersion || !contracts?.length) return;
    const byKey = new Map(contracts.map((contract) => [contractKey(contract), contract]));
    let missing = 0;
    setLegs((current) => current.map((leg) => {
      if (leg.optionType === "STOCK") return leg;
      const fresh = byKey.get(leg.symbol);
      if (!fresh) {
        missing += 1;
        return leg;
      }
      return toLeg(fresh, leg.side, leg.quantity);
    }));
    setMissingLegs(missing);
    const price = contracts.find((contract) => typeof contract.underlyingPrice === "number")?.underlyingPrice;
    if (price) setUnderlying(price);
  }, [chainVersion, contracts]);

  const candidate = useMemo(() => {
    if (legs === suggested.legs && underlying === suggested.underlyingPrice) return suggested;
    try {
      return reviseCandidate(suggested, legs, { underlyingPrice: underlying, ...chain?.target });
    } catch {
      return suggested;
    }
  }, [legs, underlying, suggested, chain?.target?.targetPrice, chain?.target?.targetDate, chain?.target?.expectedIvDirection]);
  const modified = candidate !== suggested;
  const scenarioValues = candidate.scenarios.filter((scenario) => scenario.ivChangePct === 0);
  const valuationDays = Math.min(...scenarioValues.map((scenario) => scenario.daysToExpiry));
  const targetScenarios = scenarioValues.filter((scenario) => scenario.daysToExpiry === valuationDays);

  return (
    <article className="options-candidate">
      <header className="options-candidate-header">
        <div>
          <div className="options-rank">RESEARCH CANDIDATE {candidate.rank}</div>
          <h3>{candidate.label}</h3>
          <p>{candidate.symbol} ${candidate.underlyingPrice.toFixed(2)} · Expiry {candidate.expirationDate} · Ranked score {candidate.score.toFixed(1)}/100</p>
        </div>
        <div className="options-candidate-badges">
          <span className={`options-freshness-tag ${candidate.dataFreshness.toLowerCase()}`}>
            {candidate.dataFreshness === "FRESH" ? "Fresh quotes" : candidate.dataFreshness === "STALE" ? "Stale quotes" : "Quote age unknown"}
          </span>
          <div className="options-risk-tag">Max loss {dollars(candidate.maxLoss)}</div>
          {onPreview && <Button type="button" onClick={() => onPreview(candidate)}>⚡ Open in Fast Order Ticket</Button>}
          {onEvaluateLlm && (
            <Button
              type="button"
              className="options-eval-llm-btn"
              onClick={() => onEvaluateLlm(candidateToEval(candidate))}
              title="Evaluate this strategy with neural strategy AI against raw and normalized options chains"
            >
              🧠 Evaluate with AI
            </Button>
          )}
          {onRiskAnalysis && (
            <Button variant="warning" tone="subtle" size="sm"
              type="button"
              onClick={() => onRiskAnalysis(candidateToRiskSubject(candidate))}
              title="Institutional Risk Management & Defense Playbook"
            >
              🛡️ Risk Analysis
            </Button>
          )}
          {onSendToBundle && (
            <Button type="button" onClick={() => onSendToBundle(candidate)} title="Stage this candidate for the bundle builder (Portfolio & Risk panel)">
              📦 Send to bundle builder
            </Button>
          )}
          {chain && (
            <Button type="button" disabled={chain.refreshing} onClick={() => void chain.refresh()} loading={chain.refreshing}>
              {"↻ Refresh option prices"}
            </Button>
          )}
        </div>
      </header>
      {chain?.refreshedAt && <p className="options-assumptions">Prices refreshed at {chain.refreshedAt}.{missingLegs > 0 ? ` ${missingLegs} leg(s) are no longer in the refreshed chain and keep their previous prices.` : ""}</p>}
      {chain?.refreshError && <p className="options-error" role="alert">{chain.refreshError}</p>}
      {modified && <p className="options-assumptions">Showing your adjusted legs (suggested ranking score and explanations refer to the original legs).</p>}

      <LegEditor legs={legs} original={suggested.legs} contracts={contracts ?? []} onChange={setLegs} />

      <div className="options-summary-strip">
        <div><span>{candidate.netDebit >= 0 ? "NET DEBIT" : "NET CREDIT"}</span><strong>{dollars(Math.abs(candidate.netDebit))}</strong></div>
        <div><span>EST. MARGIN</span><strong>{estimatedMargin(candidate)}</strong></div>
        <div><span>MAX LOSS</span><strong className="options-negative">{dollars(candidate.maxLoss)}</strong></div>
        <div><span>MAX PROFIT</span><strong className="options-positive">{candidate.maxProfitUnbounded ? "Unlimited" : dollars(candidate.maxProfit)}</strong></div>
        <div><span>CHANCE OF PROFIT</span><strong>{(candidate.modelImpliedProbabilityOfProfit * 100).toFixed(1)}% <small>model</small></strong></div>
        <div><span>BREAKEVEN</span><strong>{breakevenText(candidate)}</strong></div>
      </div>

      <PayoffGraph candidate={candidate} />

      <div className="options-risk-grid">
        <div><span>Target-date modeled P/L</span><strong className={candidate.targetPnl >= 0 ? "options-positive" : "options-negative"}>{dollars(candidate.targetPnl)}</strong></div>
        <div><span>Target reward / risk</span><strong>{candidate.targetRewardRisk.toFixed(2)}x</strong></div>
        <div><span>Liquidity score</span><strong>{candidate.liquidityScore.toFixed(1)}/100</strong></div>
      </div>

      <details className="options-detail">
        <summary>Scenarios, Greeks, and score</summary>
        <div className="options-detail-content">
          <div className="options-greeks">
            <span>Net Δ {candidate.netGreeks.delta.toFixed(2)}</span>
            <span>Γ {candidate.netGreeks.gamma.toFixed(3)}</span>
            <span>Θ {candidate.netGreeks.theta.toFixed(2)}/day</span>
            <span>Vega {candidate.netGreeks.vega.toFixed(2)}</span>
          </div>
          <div className="options-score-grid">
            <span>Thesis alignment <b>{candidate.scoreBreakdown.thesisAlignment.toFixed(0)}</b></span>
            <span>Target reward/risk <b>{candidate.scoreBreakdown.targetRewardRisk.toFixed(0)}</b></span>
            <span>Liquidity <b>{candidate.scoreBreakdown.liquidity.toFixed(0)}</b></span>
            <span>IV alignment <b>{candidate.scoreBreakdown.volatilityAlignment.toFixed(0)}</b></span>
            <span>Theta burden <b>{candidate.scoreBreakdown.thetaBurden.toFixed(0)}</b></span>
            <span>POP <b>{candidate.scoreBreakdown.popAlignment.toFixed(0)}</b></span>
            <span>Cushion <b>{candidate.scoreBreakdown.cushion.toFixed(0)}</b></span>
            <span>Capital eff. <b>{candidate.scoreBreakdown.capitalEfficiency.toFixed(0)}</b></span>
            <span>Quote freshness <b>{candidate.scoreBreakdown.freshness.toFixed(0)}</b></span>
          </div>
          {targetScenarios.length > 0 && (
            <div className="options-scenario-table-wrap">
              <h4>Modeled P/L near target date · IV unchanged</h4>
              <Table
                className="options-scenario-table"
                columns={[
                  { key: "underlying", header: "Underlying", render: (scenario) => `$${scenario.underlyingPrice.toFixed(2)}` },
                  { key: "pnl", header: "Modeled P/L", render: (scenario) => dollars(scenario.pnl) },
                ]}
                rows={targetScenarios}
                rowKey={(scenario) => `${scenario.underlyingPrice}:${scenario.daysToExpiry}`}
              />
            </div>
          )}
          <ul className="options-explanations">{candidate.explanations.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          <ul className="options-warnings">{candidate.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          <p className="options-assumptions">{candidate.assumptions.join(" ")}</p>
        </div>
      </details>
    </article>
  );
}

type NlqResultView = {
  summary?: string;
  validationError?: string;
  count?: number;
  rows?: Array<Record<string, unknown>>;
  rejections?: Array<{ contractSymbol?: string; reason?: string }>;
  provenance?: { bestTrade?: BestTradeData };
  llmValidation?: {
    validated: boolean;
    model: string;
    domain: string;
    action?: string;
    interpretation: string;
    confidence?: number;
    corrected?: boolean;
  };
};

export type ResearchMode = "discovery" | "contracts" | "custom" | "nlq" | "llm-ideas" | "schedules";

export function OptionsResearchPanel({ activeEnv, userLogin, onPreviewTrade, onJobStateChange, onSendPrompt, onOpenSchedules }: OptionsResearchPanelProps) {
  const [researchMode, setResearchMode] = useState<ResearchMode>("discovery");
  const [evaluatingStrategy, setEvaluatingStrategy] = useState<StrategyToEvaluate | null>(null);
  const handleEvaluateLlm = (strategy: StrategyToEvaluate) => setEvaluatingStrategy(strategy);
  const [symbol, setSymbol] = useState("");
  const [thesis, setThesis] = useState<OptionThesis>("bullish");
  const [targetPrice, setTargetPrice] = useState("");
  const [targetDate, setTargetDate] = useState(defaultTargetDate);
  const [expectedIvDirection, setExpectedIvDirection] = useState<ExpectedIvDirection>("unchanged");
  const [maxPlannedLoss, setMaxPlannedLoss] = useState("500");
  const [minRewardRisk, setMinRewardRisk] = useState("1.5");
  const [minDte, setMinDte] = useState("14");
  const [maxDte, setMaxDte] = useState("60");
  const [minVolume, setMinVolume] = useState("50");
  const [minOpenInterest, setMinOpenInterest] = useState("500");
  const [maxSpreadPct, setMaxSpreadPct] = useState("10");
  const [maxQuoteAgeSeconds, setMaxQuoteAgeSeconds] = useState("60");
  const [contractLimit, setContractLimit] = useState("5000");
  const [candidateLimit, setCandidateLimit] = useState("100");
  const [maxStrikesPerSide, setMaxStrikesPerSide] = useState("12");
  const [maxIronCondors, setMaxIronCondors] = useState("100");
  const [eventPolicy, setEventPolicy] = useState<"warn" | "exclude">("warn");
  const [allowedStrategies, setAllowedStrategies] = useState<OptionStrategyType[]>(["all"]);
  const [riskProfile, setRiskProfile] = useState<RiskProfile>("balanced");
  const [bestTrade, setBestTrade] = useState<BestTradeData | null>(null);
  const [evaluations, setEvaluations] = useState<StrategyEvaluation[]>([]);
  const [result, setResult] = useState<StrategyRecommendationResult | null>(null);
  const [comparison, setComparison] = useState<ComparisonData | null>(null);
  const [threeWay, setThreeWay] = useState<ThreeWayComparisonData | null>(null);
  const [screenMeta, setScreenMeta] = useState<any>(null);
  const [screenedContracts, setScreenedContracts] = useState<Array<Record<string, unknown>>>([]);
  const [excludedContracts, setExcludedContracts] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [nlqQuery, setNlqQuery] = useState("");
  const [nlqMaxUnderlyings, setNlqMaxUnderlyings] = useState("25");
  const [nlqQuoteAgeSeconds, setNlqQuoteAgeSeconds] = useState("60");
  const [nlqLoading, setNlqLoading] = useState(false);
  const [nlqError, setNlqError] = useState("");
  const [nlqResult, setNlqResult] = useState<NlqResultView | null>(null);
  const [chainVersion, setChainVersion] = useState(0);
  const [chainRefreshing, setChainRefreshing] = useState(false);
  const [chainRefreshedAt, setChainRefreshedAt] = useState<string | null>(null);
  const [chainRefreshError, setChainRefreshError] = useState("");
  const [riskSubject, setRiskSubject] = useState<RiskSubject | null>(null);


  const refreshChain = async () => {
    setChainRefreshing(true);
    setChainRefreshError("");
    try {
      const response = await fetch("/api/trading/options/screen", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({
          underlyingSymbols: [symbol.trim().toUpperCase()],
          contractType: "BOTH",
          minDte: Number(minDte),
          maxDte: Number(maxDte),
          minVolume: minVolume.trim() ? Number(minVolume) : undefined,
          minOpenInterest: minOpenInterest.trim() ? Number(minOpenInterest) : undefined,
          maxSpreadPct: maxSpreadPct.trim() ? Number(maxSpreadPct) : undefined,
          maxQuoteAgeSeconds: Number(maxQuoteAgeSeconds),
          limit: Number(contractLimit),
        }),
      });
      const data = await response.json() as { contracts?: Array<Record<string, unknown>>; error?: string; validationError?: string };
      if (!response.ok || data.error || data.validationError) throw new Error(data.error || data.validationError || "Price refresh failed");
      if (!data.contracts?.length) throw new Error("The refreshed option chain was empty.");
      setScreenedContracts(data.contracts);
      setChainVersion((version) => version + 1);
      setChainRefreshedAt(new Date().toLocaleTimeString());
    } catch (cause) {
      setChainRefreshError(cause instanceof Error ? cause.message : "Price refresh failed");
    } finally {
      setChainRefreshing(false);
    }
  };

  // Universal app-refresh broadcast listener (triggered by top-bar Refresh button & global timer)
  const refreshChainRef = useRef(refreshChain);
  refreshChainRef.current = refreshChain;

  useEffect(() => {
    const handleAppRefresh = () => {
      if (symbol.trim() && !chainRefreshing) {
        void refreshChainRef.current();
      }
    };
    window.addEventListener("app-refresh", handleAppRefresh);
    return () => {
      window.removeEventListener("app-refresh", handleAppRefresh);
    };
  }, [symbol, chainRefreshing]);

  const canRun = allowedStrategies.length > 0 && Boolean(symbol.trim()) && Boolean(targetPrice) && /^\d{4}-\d{2}-\d{2}$/.test(targetDate);
  const hasResults = Boolean(bestTrade || comparison || threeWay || result || nlqResult);
  useEffect(() => {
    onJobStateChange?.(loading ? "running" : hasResults ? "ready" : "idle");
  }, [loading, hasResults, onJobStateChange]);

  const previewTrade: PreviewTrade | undefined = onPreviewTrade
    ? (candidate) => onPreviewTrade(toTradeContext(
      candidate,
      thesis,
      Number(screenedContracts.find((c) => typeof c.underlyingPrice === "number")?.underlyingPrice) || undefined,
    ))
    : undefined;

  // Consolidation C5 (#1361): from-results flow — stage a ranked or
  // best-trade candidate for the bundle builder (Portfolio & Risk
  // panel consumes it on mount). Staging never navigates away; the
  // banner names the staged candidate and where it went.
  const [stagedBundle, setStagedBundle] = useState<{ id: string; label: string } | null>(null);
  const sendToBundle = (candidate: StrategyCandidate) => {
    stageBundleCandidate(candidate);
    setStagedBundle({ id: candidate.id, label: candidate.label });
  };

  const loadExample = (example: string) => {
    setNlqQuery(example);
    const ticker = example.match(/\b(?:for|on)\s+([A-Z]{1,5})\b/)?.[1];
    const target = example.match(/target\s+\$?(\d+(?:\.\d+)?)/i)?.[1];
    const loss = example.match(/max loss\s+\$?(\d+)/i)?.[1];
    if (ticker) setSymbol(ticker);
    if (target) setTargetPrice(target);
    if (loss) setMaxPlannedLoss(loss);
    if (/\bbearish\b/i.test(example)) setThesis("bearish");
    else if (/\bbullish\b/i.test(example)) setThesis("bullish");
  };

  const toggleStrategy = (strategy: OptionStrategyType) => {
    setAllowedStrategies((current) => {
      const base = current.filter((item) => item !== "all");
      return base.includes(strategy) ? base.filter((item) => item !== strategy) : [...base, strategy];
    });
  };

  // The panel's current request, shared by the rank / best-trade /
  // annotation-compare modes and the #1257 three-way generator
  // comparison — one body construction, not three copies that drift.
  const requestBody = () => ({
    symbol: symbol.trim().toUpperCase(),
    thesis,
    targetPrice: Number(targetPrice),
    targetDate,
    expectedIvDirection,
    maxPlannedLoss: Number(maxPlannedLoss),
    minRewardRisk: Number(minRewardRisk),
    minDte: Number(minDte),
    maxDte: Number(maxDte),
    minVolume: minVolume.trim() ? Number(minVolume) : undefined,
    minOpenInterest: minOpenInterest.trim() ? Number(minOpenInterest) : undefined,
    maxSpreadPct: maxSpreadPct.trim() ? Number(maxSpreadPct) : undefined,
    maxQuoteAgeSeconds: Number(maxQuoteAgeSeconds),
    contractLimit: Number(contractLimit),
    candidateLimit: Number(candidateLimit),
    maxStrikesPerSide: Number(maxStrikesPerSide),
    maxIronCondors: Number(maxIronCondors),
    allowedStrategies,
    eventPolicy,
  });

  const run = async (mode: "rank" | "best" | "compare") => {
    setLoading(true);
    setError("");
    setResult(null);
    setBestTrade(null);
    setEvaluations([]);
    setComparison(null);
    setThreeWay(null);
    setScreenedContracts([]);
    try {
      const endpoint = mode === "best"
        ? "/api/trading/options/best-trade"
        : mode === "compare"
          ? "/api/trading/options/compare"
          : "/api/trading/options/recommend";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({
          ...requestBody(),
          ...(mode === "best" || mode === "compare" ? { riskProfile, alternatives: 3 } : {}),
        }),
      });
      const data = await response.json() as any;
      if (!response.ok) throw new Error(data.error || "Strategy research request failed");
      if (mode === "compare") {
        setComparison(data as ComparisonData);
        setScreenMeta(data.screen);
        setScreenedContracts(data.contracts || []);
        return;
      }
      if (mode === "best") {
        setBestTrade(data.bestTrade as BestTradeData);
        setEvaluations((data.evaluations || []) as StrategyEvaluation[]);
      }
      else setResult(data as StrategyRecommendationResult);
      setScreenMeta(data.screen);
      setScreenedContracts(data.contracts || []);
      setExcludedContracts(data.contractRejections || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Strategy research request failed");
    } finally {
      setLoading(false);
    }
  };

  // #1257 comparison surfacing: the three-way generator comparison
  // (POST /trading/options/comparison) over the panel's current
  // request. Distinct from run("compare") — that is the #47
  // annotation compare (quant candidates re-ranked by the LLM);
  // this compares three GENERATORS (llm / quant / hybrid) over one
  // snapshot. Read-only: it renders the artifact and never feeds
  // back into production rankings.
  const runThreeWay = async () => {
    setLoading(true);
    setError("");
    setResult(null);
    setBestTrade(null);
    setEvaluations([]);
    setComparison(null);
    setThreeWay(null);
    setScreenedContracts([]);
    try {
      const response = await fetch("/api/trading/options/comparison", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({ ...requestBody(), riskProfile }),
      });
      const data = await response.json() as any;
      if (!response.ok) throw new Error(data.error || "Generator comparison request failed");
      if (data.status === "no_candidates") {
        throw new Error(data.reason || "The comparison snapshot has no screened contracts");
      }
      setThreeWay(data as ThreeWayComparisonData);
      setScreenMeta(data.screen);
      setScreenedContracts(data.contracts || []);
      setExcludedContracts(data.contractRejections || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Generator comparison request failed");
    } finally {
      setLoading(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void run("rank");
  };

  const logChatActivity = (id: string, text: string) => {
    void fetch("/api/chat-activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, source: "E*TRADE · Auto Options Research", text }),
    }).catch(() => undefined);
  };

  const submitNaturalLanguage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!nlqQuery.trim() || nlqLoading) return;
    const prompt = [
      nlqQuery.trim(),
      `scan up to ${Number(nlqMaxUnderlyings)} underlyings`,
      `quote age reference ${Number(nlqQuoteAgeSeconds)} seconds`,
    ].join("; ");
    const activityId = crypto.randomUUID();
    setNlqLoading(true);
    setNlqError("");
    setNlqResult(null);
    logChatActivity(activityId, `Request submitted to the options agent: ${prompt}`);
    try {
      const response = await fetch("/api/nlq", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          "x-nlq-context": "options",
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({
          query: prompt,
          context: "options",
          validateWithLLM: true,
        }),
      });
      const data = await response.json() as NlqResultView;
      if (!response.ok) throw new Error((data as { error?: string }).error || "Options request failed");
      setNlqResult(data);
      logChatActivity(activityId, `Options agent completed: ${prompt}\n${data.summary || `${data.count ?? 0} result(s)`}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Options request failed";
      setNlqError(message);
      logChatActivity(activityId, `Options agent failed: ${prompt}\n${message}`);
    } finally {
      setNlqLoading(false);
    }
  };

  const chainValue: ChainContextValue = {
    contracts: screenedContracts as unknown as ScreenedOptionContractItem[],
    version: chainVersion,
    refreshing: chainRefreshing,
    refreshedAt: chainRefreshedAt,
    refreshError: chainRefreshError,
    refresh: refreshChain,
    target: { targetPrice: Number(targetPrice) || undefined, targetDate, expectedIvDirection },
  };

  return (
    <ChainContext.Provider value={chainValue}>
    <section className="trading-section options-research-section">
      {screenMeta?.validationError && <p className="options-error" role="alert">{screenMeta.validationError}</p>}
      {Array.isArray(screenMeta?.fetchErrors) && screenMeta.fetchErrors.length > 0 && (
        <p className="options-error" role="alert">Option chain data problem: {screenMeta.fetchErrors.map((item: { symbol?: string; reason?: string }) => `${item.symbol ?? ""} ${item.reason ?? ""}`.trim()).join("; ")}</p>
      )}

      <CapabilityNavBar
        ariaLabel="Options Research Mode"
        activeTabId={researchMode}
        onTabChange={(id) => setResearchMode(id as ResearchMode)}
        tabs={[
          {
            id: "discovery",
            label: "Strategy Discovery & Payoff Analyzer",
            icon: "🎯",
            tooltip: {
              eyebrow: "ALGORITHMIC SELECTION ENGINE",
              title: "Strategy Discovery & Payoff Analyzer",
              description: "Explore multi-leg option strategies (Iron Condors, Spreads, Straddles, Covered Calls) matched to market sentiment with interactive payoff charts and Greeks.",
            },
          },
          {
            id: "contracts",
            label: "Raw Contracts Screener",
            icon: "📋",
            tooltip: {
              eyebrow: "LIVE CHAIN FILTERING",
              title: "Raw Contracts Screener",
              description: "Directly filter individual Call and Put contracts across symbols, DTE windows, strikes, bid/ask spreads, volume, and Greeks.",
            },
          },
          {
            id: "custom",
            label: "Custom Thesis & Strategy Universe",
            icon: "⚙️",
            tooltip: {
              eyebrow: "CONSTRAINED OPTION SCANNING",
              title: "Custom Thesis & Strategy Universe",
              description: "Declare specific target prices, target dates, and IV assumptions to filter and rank tailored candidate structures.",
            },
          },
          {
            id: "nlq",
            label: "Natural Language Screen (NLQ)",
            icon: "💬",
            badge: "AI",
            badgeType: "cyan",
            tooltip: {
              eyebrow: "AI-POWERED PROMPT SCREENING",
              title: "Natural Language Screen (NLQ)",
              description: "Ask questions in plain English like 'Find high IV call spreads on NVDA with 30 DTE' to run instant options filters.",
            },
          },
          {
            id: "llm-ideas",
            label: "AI Strategy Ideas & Exporter",
            icon: "🧪",
            tooltip: {
              eyebrow: "INDEPENDENT RAW-DATA AI ANALYSIS",
              title: "AI Options Strategy Experiment",
              description: "Divides chains into near/mid/long-term expiration cohorts for multi-stage AI evaluation against raw market data.",
            },
          },
          {
            id: "schedules",
            label: "Scheduled Screening & Schedulers",
            icon: "⏰",
            badge: "DURABLE",
            badgeType: "emerald",
            tooltip: {
              eyebrow: "DURABLE TIMERS & AUTONOMOUS DISPATCH",
              title: "Scheduled Screening & Schedulers",
              description: "Create and monitor autonomous scheduled options scans with persistent background timers and Slack & Email notifications.",
            },
          },
        ]}
        rightContent={
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2-5)" }}>
            <CopilotTriggerButton label="✨ Ask Copilot" />
            {screenMeta && (
              <div className="options-scan-meta-pill" title="Screen evaluation metrics">
                {screenMeta.contractsEvaluated} eval · {screenMeta.contractsMatched} eligible
              </div>
            )}
          </div>
        }
      />

      {researchMode === "schedules" && (
        <>
          {/* S7 (consolidation #958) made schedule management live in
              the one schedule UI; C2 (consolidation #1151, #1246)
              hosts it as this hub's own Schedules tab, so the note is
              now an in-hub switch, not a pointer elsewhere. This mode
              keeps the autonomous-runs record below it. */}
          <div className="options-comparison-note" style={{ margin: "1.5rem 0", padding: "var(--space-6)", background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "8px" }}>
            <h4 style={{ margin: "0 0 0.5rem", color: "var(--color-accent)", fontSize: "var(--font-size-title-sm)" }}>⏰ Schedule Management Lives in the Schedules Tab</h4>
            <p style={{ margin: "0 0 0.75rem", color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)", lineHeight: 1.5 }}>
              Every screening schedule — stock screens, options analysis, and strategy discovery in all three input models (saved views, profile-derived, no-view) — is created and managed in one place: this hub's <strong>Schedules</strong> tab, alongside the system and queued jobs that share the same schedule store.
            </p>
            <p style={{ margin: "0 0 0.75rem", color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" }}>
              Nothing was retired: the create/edit forms, run-now triggers, latest runs, and audit trail all live on that tab.
            </p>
            {onOpenSchedules && (
              <Button type="button" onClick={onOpenSchedules} style={{ padding: "var(--space-2) var(--space-4)", fontWeight: 600 }}>
                Open the Schedules tab
              </Button>
            )}
          </div>
          {/* Issue #2545: the scheduled job's full parameter set as a
              one-shot run, hosted here in the schedules mode — the
              Options Research one-shot surfaces could not reproduce
              the scheduled "Options Market Screen" run before. */}
          <ScheduledOptionsRunForm activeEnv={activeEnv} userLogin={userLogin} />
          {/* Issue #223: the persisted autonomous runs (hourly scheduled
              scans + manual runs) — the record of what the scheduler
              actually produced. */}
          <AutonomousOptionsRuns />
          {/* Issue #1162 (epic #1096 Phase 6): the autonomous screening
              system's activity log + pause control — discovery runs,
              re-selections, promotions, and deliveries from the
              screening activity feed, next to the other run records. */}
          <ScreeningActivityPanel userLogin={userLogin} />
        </>
      )}

      {researchMode === "discovery" && (
        <>
          <StrategyDiscoveryPanel
            initialSymbol={symbol.trim() || "TSLA"}
            activeEnv={activeEnv}
            userLogin={userLogin}
            onPreviewTrade={onPreviewTrade}
            onSendPrompt={onSendPrompt}
          />
          {/* Issue #126 (PR-F): the persisted scheduled/manual discovery
              runs — a separate, read-only record stream below the
              interactive panel; the two are never merged. */}
          <DiscoveryRunsPanel activeEnv={activeEnv} userLogin={userLogin} />
        </>
      )}

      {researchMode === "contracts" && (
        <RawContractsScreener
          activeEnv={activeEnv}
          userLogin={userLogin}
          initialSymbol={symbol.trim() || "NVDA"}
          onPreviewTrade={onPreviewTrade}
          onSendPrompt={onSendPrompt}
        />
      )}

      {researchMode === "llm-ideas" && (
        <LlmOptionsIdeasPanel activeEnv={activeEnv} userLogin={userLogin} />
      )}

      {researchMode === "nlq" && (
        <>
          <details className="options-workflow-drawer">
        <summary>Workflow guide &amp; example requests</summary>
        <div className="options-workflow" aria-label="Options research workflow">
          {workflowSteps.map((s) => (
            <div className="options-workflow-step" key={s.step}>
              <h4><span className="options-workflow-num">{s.step}</span> {s.title}</h4>
              <p>{s.blurb}</p>
              <div className="options-nlq-examples">
                {s.examples.map((example) => (
                  <span className="options-example-row" key={example}>
                    <Button type="button" onClick={() => loadExample(example)}>{example}</Button>
                    {onSendPrompt && <Button type="button" className="options-example-chat" title="Send this request to the shared Chat" onClick={() => onSendPrompt(example, "E*TRADE · Auto Options Research")}>💬 Chat</Button>}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <p className="options-workflow-hint">Click an example to load it into the screen fields, or use 💬 Chat to send it to the shared Chat.</p>
        </div>
      </details>
      <form className="options-nlq-form" onSubmit={submitNaturalLanguage}>
        <TextInput label="Natural-language options screen"
          value={nlqQuery}
          onChange={(event) => setNlqQuery(event.target.value)}
          placeholder="Screen call options with 20 to 45 DTE"
          list="options-nlq-examples"
        />
        <datalist id="options-nlq-examples">{nlqExamples.map((example) => <option key={example} value={example} />)}</datalist>
        <TextInput label="Maximum underlyings to scan"
          type="number"
          min="1"
          step="1"
          value={nlqMaxUnderlyings}
          onChange={(event) => setNlqMaxUnderlyings(event.target.value)}
          placeholder="No cap"
        />
        <TextInput label="Quote-age reference (seconds; older quotes are marked stale)"
          type="number"
          min="0"
          step="1"
          required
          value={nlqQuoteAgeSeconds}
          onChange={(event) => setNlqQuoteAgeSeconds(event.target.value)}
          placeholder="No limit"
        />
        <Button type="submit" disabled={!nlqQuery.trim() || nlqLoading} loading={nlqLoading}>
          {"Run options screen"}
        </Button>
      </form>
      {nlqError && <p className="options-error" role="alert">{nlqError}</p>}
      {nlqResult && (
        <div className="options-nlq-result" role="status">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "0.4rem" }}>
            <strong>{nlqResult.count ?? 0} result rows</strong>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <Button
                type="button"
                className="options-eval-llm-btn"
                onClick={() => {
                  setEvaluatingStrategy({
                    symbol: symbol.trim() || (nlqResult.rows?.[0]?.symbol as string) || "NVDA",
                    strategyName: `NLQ: "${nlqQuery.slice(0, 45)}${nlqQuery.length > 45 ? "…" : ""}"`,
                    sentiment: thesis,
                    targetPrice: Number(targetPrice) || undefined,
                    legsText: nlqQuery,
                  });
                }}
                title="Evaluate this NLQ screening question against live option chains with neural AI"
              >
                🧠 Evaluate NLQ with AI
              </Button>
              <OptionsDataDownloadDropdown
                symbol={symbol.trim() || (nlqResult.rows?.[0]?.symbol as string) || "NVDA"}
                activeEnv={activeEnv}
                userLogin={userLogin}
                label="📥 Download Data"
              />
            </div>
          </div>
          {nlqResult.llmValidation && (
            <div
              className="options-nlq-validation-tag"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-2)",
                background: "var(--color-accent-subtle)",
                border: "1px solid var(--color-border-focus)",
                borderRadius: "var(--radius-sm, 6px)",
                padding: "var(--space-1-5) var(--space-2-5)",
                fontSize: "var(--font-size-body-sm)",
                color: "var(--color-accent)",
                marginBottom: "0.55rem",
                width: "100%",
                boxSizing: "border-box",
              }}
            >
              <span>🧠 <strong>AI Validated:</strong></span>
              <span style={{ color: "var(--color-text-secondary)" }}>{nlqResult.llmValidation.interpretation}</span>
              {nlqResult.llmValidation.corrected && (
                <span style={{ color: "var(--color-success)", fontSize: "0.75rem", fontWeight: 700, marginLeft: "auto" }}>✓ Intent Protected</span>
              )}
            </div>
          )}
          {nlqResult.provenance?.bestTrade && (
            <BestTradeCard
              pick={nlqResult.provenance.bestTrade}
              onPreview={previewTrade}
              onEvaluateLlm={handleEvaluateLlm}
              onRiskAnalysis={setRiskSubject}
              onSendToBundle={sendToBundle}
            />
          )}
          {Array.isArray(nlqResult.rows) && nlqResult.rows.length > 0 && Array.isArray(nlqResult.rows[0]?.candidateStrategies) && (
            <StrategyLedgerTable rows={nlqResult.rows} />
          )}
          {Array.isArray(nlqResult.rows) && nlqResult.rows.length > 0 && !Array.isArray(nlqResult.rows[0]?.candidateStrategies) && (
            <div className="options-scenario-table-wrap">
              <Table
            className={`options-scenario-table${Object.prototype.hasOwnProperty.call(nlqResult.rows[0], "reason") ? " options-evaluation-ledger-table" : ""}`}
            columns={Object.keys(nlqResult.rows[0]).map((key) => ({
              key,
              header: key,
              render: (row: Record<string, unknown>) => String(row[key] ?? "N/A"),
            }))}
            rows={nlqResult.rows}
            rowKey={(row: Record<string, unknown>, index) => `${row.contractSymbol || row.symbol || "row"}:${index}`}
          />
            </div>
          )}
          {Array.isArray(nlqResult.rejections) && nlqResult.rejections.length > 0 && (
            <details className="options-excluded">
              <summary>View quote and filter rejections</summary>
              <ul>{nlqResult.rejections.slice(0, 8).map((rejection: any, index: number) => (
                <li key={`${rejection.contractSymbol}:${index}`}>{rejection.contractSymbol}: {rejection.reason}</li>
              ))}</ul>
            </details>
          )}
        </div>
      )}
        </>
      )}

      {researchMode === "custom" && (
        <>
      <form className="options-request-form" onSubmit={submit}>
        <TextInput label="Underlying" required maxLength={10} value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="Ticker" />
        <Select label="Thesis" value={thesis} onChange={(event) => setThesis(event.target.value as OptionThesis)}>
          <option value="bullish">Bullish</option>
          <option value="bearish">Bearish</option>
          <option value="range_bound">Range-bound</option>
          <option value="large_move">Large move, direction unknown</option>
        </Select>
        <TextInput label="Target price" required type="number" min="0.01" step="0.01" value={targetPrice} onChange={(event) => setTargetPrice(event.target.value)} placeholder="Price at target date" />
        <FieldShell id="options-target-date" label="Target date (type YYYY-MM-DD or pick)">
        <div className="options-date-row">
          <TextInput
            required
            type="text"
            inputMode="numeric"
            pattern="\d{4}-\d{2}-\d{2}"
            placeholder="YYYY-MM-DD"
            value={targetDate}
            onChange={(event) => setTargetDate(event.target.value)}
          />
          <TextInput type="date" aria-label="Pick target date" value={/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? targetDate : ""} onChange={(event) => event.target.value && setTargetDate(event.target.value)} />
        </div>
        </FieldShell>
        <Select label="Expected IV" value={expectedIvDirection} onChange={(event) => setExpectedIvDirection(event.target.value as ExpectedIvDirection)}>
          <option value="rise">Rise</option>
          <option value="unchanged">Unchanged</option>
          <option value="fall">Fall</option>
        </Select>
        <TextInput label="Maximum planned loss ($)" required type="number" min="1" step="1" value={maxPlannedLoss} onChange={(event) => setMaxPlannedLoss(event.target.value)} />
        <TextInput label="Minimum target reward/risk" required type="number" min="0" step="0.1" value={minRewardRisk} onChange={(event) => setMinRewardRisk(event.target.value)} />
        <TextInput label="Minimum DTE" required type="number" min="1" step="1" value={minDte} onChange={(event) => setMinDte(event.target.value)} />
        <TextInput label="Maximum DTE" required type="number" min={minDte || 1} step="1" value={maxDte} onChange={(event) => setMaxDte(event.target.value)} />
        <TextInput label="Minimum contract volume" type="number" min="0" step="1" value={minVolume} onChange={(event) => setMinVolume(event.target.value)} />
        <TextInput label="Minimum open interest" type="number" min="0" step="1" value={minOpenInterest} onChange={(event) => setMinOpenInterest(event.target.value)} />
        <TextInput label="Maximum bid/ask spread (%)" type="number" min="0" step="0.1" value={maxSpreadPct} onChange={(event) => setMaxSpreadPct(event.target.value)} />
        <TextInput label="Quote-age reference (seconds)" required type="number" min="0" step="1" value={maxQuoteAgeSeconds} onChange={(event) => setMaxQuoteAgeSeconds(event.target.value)} />
        <TextInput label="Contracts to evaluate" type="number" min="1" step="1" value={contractLimit} onChange={(event) => setContractLimit(event.target.value)} />
        <TextInput label="Ranked candidates to show" type="number" min="1" step="1" value={candidateLimit} onChange={(event) => setCandidateLimit(event.target.value)} />
        <TextInput label="Strike candidates per side" type="number" min="1" step="1" value={maxStrikesPerSide} onChange={(event) => setMaxStrikesPerSide(event.target.value)} />
        <TextInput label="Iron condor combinations" type="number" min="0" step="1" value={maxIronCondors} onChange={(event) => setMaxIronCondors(event.target.value)} />
        <Select label="Earnings/dividend policy" value={eventPolicy} onChange={(event) => setEventPolicy(event.target.value as "warn" | "exclude")}>
          <option value="warn">Warn if event data unavailable</option>
          <option value="exclude">Exclude until event data can be checked</option>
        </Select>

        <fieldset className="options-strategy-picker">
          <legend>Allowed strategy templates</legend>
          <Checkbox label={<span><strong>All strategies ({defaultRegistry.ids().length})</strong></span>} checked={allowedStrategies.includes("all")} onChange={() => setAllowedStrategies(allowedStrategies.includes("all") ? [] : ["all"])} />
          {!allowedStrategies.includes("all") && Object.entries(strategyGroups).map(([category, choices]) => (
            <details key={category}>
              <summary>{category.replace(/_/g, " ")} ({choices.length})</summary>
              <div className="options-strategy-options">
                {choices.map((choice) => (
                  <Checkbox key={choice.id} label={choice.label} checked={allowedStrategies.includes(choice.id)} onChange={() => toggleStrategy(choice.id)} />
                ))}
              </div>
            </details>
          ))}
        </fieldset>

        <Select label="Best-trade risk profile" value={riskProfile} onChange={(event) => setRiskProfile(event.target.value as RiskProfile)}>
          <option value="conservative">Conservative (favor probability and capital safety)</option>
          <option value="balanced">Balanced</option>
          <option value="aggressive">Aggressive (favor reward/risk)</option>
        </Select>

        <div className="options-form-footer">
          <p>All thresholds and search/result limits are set above. Stale/unknown quote ages are labeled and scored, not excluded on age alone. Zero-bid, crossed, and adjusted contracts are excluded as invalid/non-standard instruments.</p>
          {!canRun && (
            <p className="options-error" role="status">
              Buttons unlock once you enter: {[!symbol.trim() && "Underlying", !targetPrice && "Target price", allowedStrategies.length === 0 && "at least one strategy"].filter(Boolean).join(", ")}.
            </p>
          )}
          <Button type="submit" disabled={loading || !canRun} loading={loading}>
            {"Rank research candidates"}
          </Button>
          <Button type="button" disabled={loading || !canRun} onClick={() => void run("best")} loading={loading}>
            {"Pick best trade"}
          </Button>
          <Button type="button" disabled={loading || !canRun} onClick={() => void run("compare")} loading={loading}>
            {"Compare Quant vs AI"}
          </Button>
          <Button type="button" disabled={loading || !canRun} onClick={() => void runThreeWay()} loading={loading}>
            {"Compare generators (LLM / Quant / Hybrid)"}
          </Button>
        </div>
      </form>

      {error && <div className="options-error" role="alert">{error}</div>}
      {bestTrade && (
        <BestTradeCard
          pick={bestTrade}
          onPreview={previewTrade}
          onEvaluateLlm={handleEvaluateLlm}
          onRiskAnalysis={setRiskSubject}
          onSendToBundle={sendToBundle}
        />
      )}
      {stagedBundle && (
        <div className="options-assumptions" role="status">
          Staged for the bundle builder: {stagedBundle.label} — open Portfolio &amp; Risk to build its bundle.
        </div>
      )}
      {comparison && <RecommendationComparison data={comparison} onPreview={previewTrade} />}
      {threeWay && <ThreeWayComparison data={threeWay} activeEnv={activeEnv} userLogin={userLogin} />}
      {(result?.evaluations || evaluations).length > 0 && <EvaluationTable evaluations={result?.evaluations || evaluations} />}
      {result && (
        <div className="options-results">
          <div className="options-results-header">
            <h2>{result.candidates.length ? `${result.candidates.length} ranked candidates` : "No candidates pass the constraints"}</h2>
            <span>{result.modelVersion} · {new Date(result.generatedAt).toLocaleString()}</span>
          </div>
          <div className="options-score-policy">
            Score weights: thesis {Math.round(result.scoreWeights.thesisAlignment * 100)}% · target R/R {Math.round(result.scoreWeights.targetRewardRisk * 100)}% · liquidity {Math.round(result.scoreWeights.liquidity * 100)}% · IV {Math.round(result.scoreWeights.volatilityAlignment * 100)}% · theta {Math.round(result.scoreWeights.thetaBurden * 100)}% · freshness {Math.round(result.scoreWeights.freshness * 100)}% · POP {Math.round(result.scoreWeights.popAlignment * 100)}% · cushion {Math.round(result.scoreWeights.cushion * 100)}% · capital eff. {Math.round(result.scoreWeights.capitalEfficiency * 100)}%
          </div>
          {(screenMeta?.quoteQuality?.staleContractsReturned > 0 || screenMeta?.quoteQuality?.unknownFreshnessContracts > 0) && (
            <div className="options-stale-banner" role="alert">
              <strong>Quote freshness warning: returned contracts remain visible.</strong>
              <span>
                {screenMeta.quoteQuality.staleContractsReturned} stale and {screenMeta.quoteQuality.unknownFreshnessContracts} timestamp-unknown contracts are shown. The freshest stale quote is {Math.round(screenMeta.quoteQuality.freshestStaleQuoteAgeSeconds || 0).toLocaleString()} seconds old; {screenMeta.quoteQuality.maxAgeSeconds ?? 60}s is the freshness reference. Strategy scores are reduced for stale or unknown data; verify current quotes before acting.
              </span>
            </div>
          )}
          {result.candidates.map((candidate) => (
            <StrategyCard
              key={candidate.id}
              candidate={candidate}
              onPreview={previewTrade}
              onEvaluateLlm={handleEvaluateLlm}
              onRiskAnalysis={setRiskSubject}
              onSendToBundle={sendToBundle}
            />
          ))}
          {result.excluded.length > 0 && (
            <details className="options-excluded">
              <summary>{result.excluded.reduce((sum, entry) => sum + entry.count, 0)} strategy combinations excluded</summary>
              <ul>{result.excluded.slice(0, 12).map((entry) => <li key={entry.reason}>{entry.reason} ({entry.count})</li>)}</ul>
            </details>
          )}
          {excludedContracts.length > 0 && (
            <details className="options-excluded">
              <summary>{excludedContracts.length} option contracts failed screening</summary>
              <ul>{excludedContracts.slice(0, 12).map((entry) => <li key={`${entry.contractSymbol}:${entry.reason}`}>{entry.contractSymbol}: {entry.reason}</li>)}</ul>
            </details>
          )}
          <ul className="options-result-assumptions">{result.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
        </div>
      )}
        </>
      )}

      <ResearchReportActions
        title={`${symbol || "options"} strategy research`}
        query={nlqQuery || `Rank ${thesis} ${symbol || "NVDA"} option strategies${targetPrice ? ` target $${targetPrice}` : ""} by ${targetDate} max loss $${maxPlannedLoss} ${riskProfile}`}
        userLogin={userLogin}
        sheets={[
          { name: "Options data", rows: screenedContracts },
          { name: "Options screen", rows: screenMeta ? [{ ...screenMeta, symbol: symbol.toUpperCase(), excludedContracts: excludedContracts.length }] : [] },
          { name: "Option rejections", rows: excludedContracts as Array<Record<string, unknown>> },
          { name: "Strategy evaluations", rows: (result?.evaluations || evaluations) as unknown as Array<Record<string, unknown>> },
          { name: "Strategy candidates", rows: (result?.candidates || []).map((candidate) => ({ ...candidate })) },
          { name: "Recommendations", rows: [
            ...(bestTrade?.best ? [{ ...bestTrade.best.candidate, rank: 1, score: bestTrade.best.compositeScore, status: bestTrade.status }] : []),
            ...(bestTrade?.alternatives || []).map((item) => ({ ...item.candidate, rank: item.rank + 1, score: item.compositeScore })),
            ...(result?.candidates || []).map((candidate) => ({ ...candidate, rank: candidate.rank, score: candidate.score })),
          ] },
          { name: "Quant LLM ranking", rows: (comparison?.quant.ranked || []).map((item) => ({
            quantRank: item.rank, quantScore: item.compositeScore, ...item.candidate,
            llmJudgment: comparison?.llm.ranked?.find((entry) => entry.candidateId === item.candidate.id),
          })) },
          { name: "Options NLQ", rows: (nlqResult?.rows || []) as Array<Record<string, unknown>> },
        ]}
      />

      {/* Holistic Neural Strategy LLM Evaluation & Options Data Export Modal */}
      <LlmStrategyEvalModal
        isOpen={Boolean(evaluatingStrategy)}
        onClose={() => setEvaluatingStrategy(null)}
        strategy={evaluatingStrategy}
        activeEnv={activeEnv}
        userLogin={userLogin}
        onPreviewTrade={onPreviewTrade}
      />

      {/* Dynamic ETAPI Engine Tuning & Configuration Modal */}
      <EtapiConfigModal
        isOpen={configModalOpen}
        onClose={() => setConfigModalOpen(false)}
        activeEnv={activeEnv}
        userLogin={userLogin}
      />

      {/* Institutional Risk Analysis & Defense Playbook Modal */}
      <RiskAnalysisModal
        isOpen={Boolean(riskSubject)}
        onClose={() => setRiskSubject(null)}
        subject={riskSubject}
        onSendPrompt={onSendPrompt}
      />
    </section>
    </ChainContext.Provider>
  );
}

interface LedgerCandidate {
  id: string;
  name: string;
  status: "accepted" | "rejected" | "skipped";
  why: string;
  description?: string;
  score?: number;
}

type LedgerSortKey = "category" | "score" | "passed" | "failed" | "reason" | "candidateStrategies";

const ledgerColumns: Array<{ key: LedgerSortKey; label: string }> = [
  { key: "category", label: "Category" },
  { key: "score", label: "Score" },
  { key: "passed", label: "Passed" },
  { key: "failed", label: "Failed" },
  { key: "reason", label: "Reason" },
  { key: "candidateStrategies", label: "Candidate strategies" },
];

function StrategyLedgerTable({ rows }: { rows: Array<Record<string, any>> }) {
  const [sortKey, setSortKey] = useState<LedgerSortKey>("score");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");

  const sorted = [...rows].sort((a, b) => {
    const left = sortKey === "candidateStrategies" ? (a[sortKey] as LedgerCandidate[]).length : a[sortKey];
    const right = sortKey === "candidateStrategies" ? (b[sortKey] as LedgerCandidate[]).length : b[sortKey];
    const order = typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""));
    return direction === "asc" ? order : -order;
  });

  const sortBy = (key: LedgerSortKey) => {
    if (key === sortKey) setDirection((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setDirection(key === "category" || key === "reason" ? "asc" : "desc");
    }
  };

  return (
    <div className="options-scenario-table-wrap">
      <Table
            className="options-scenario-table options-evaluation-ledger-table strategy-ledger-table"
            columns={ledgerColumns.map((column) => ({
              key: column.key,
              header: (
                <Button type="button" className="ledger-sort" onClick={() => sortBy(column.key)}>
                  {column.label}{sortKey === column.key ? (direction === "asc" ? " ▲" : " ▼") : ""}
                </Button>
              ),
              ariaSort: sortKey === column.key ? (direction === "asc" ? "ascending" : "descending") : "none",
              render: (row: Record<string, any>) => {
                switch (column.key) {
                  case "category": return String(row.category);
                  case "score": return Number(row.score ?? 0).toFixed(1);
                  case "passed": return String(row.passed);
                  case "failed": return String(row.failed);
                  case "reason": return String(row.reason);
                  case "candidateStrategies": return (
                    <ul className="ledger-candidates">
                                      {(row.candidateStrategies as LedgerCandidate[]).map((candidate) => (
                                        <li key={candidate.id} className={`ledger-candidate ledger-${candidate.status}`}>
                                          <a
                                            href={`/strategies/${candidate.id}.html`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title={candidate.description || candidate.name}
                                          >
                                            {candidate.name}
                                          </a>
                                          <span className="ledger-verdict">{candidate.status === "accepted" ? "PASSED" : candidate.status === "rejected" ? "FAILED" : "SKIPPED"}</span>
                                          <span className="ledger-why">{candidate.why}</span>
                                        </li>
                                      ))}
                                    </ul>
                  );
                  default: return "";
                }
              },
            }))}
            rows={sorted}
            rowKey={(row) => String(row.category)}
          />
    </div>
  );
}

function EvaluationTable({ evaluations }: { evaluations: StrategyEvaluation[] }) {
  const counts = evaluations.reduce((acc, e) => ({ ...acc, [e.status]: (acc[e.status] || 0) + 1 }), {} as Record<string, number>);
  return (
    <details className="options-excluded" open>
      <summary>
        Strategies evaluated: {evaluations.length} ({counts.accepted || 0} accepted, {counts.rejected || 0} rejected, {counts.skipped || 0} skipped)
      </summary>
      <div className="options-table-scroll">
        <Table
            columns={[
              { key: "strategy", header: "Strategy", render: (e) => e.label },
              { key: "category", header: "Category", render: (e) => e.category },
              { key: "status", header: "Status", render: (e) => e.status.toUpperCase() },
              { key: "built", header: "Built", render: (e) => e.generated },
              { key: "accepted", header: "Accepted", render: (e) => e.accepted },
              { key: "reason", header: "Reason", render: (e) => e.summary },
            ]}
            rows={evaluations}
            rowKey={(e) => e.id}
          />
      </div>
    </details>
  );
}
