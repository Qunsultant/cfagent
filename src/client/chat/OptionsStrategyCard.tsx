import React, { useMemo, useState } from "react";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Table, type TableColumn } from "../components/ui/Table";
import { useToast, type ToastApi } from "../components/ui/Toast";
import "./optionsCard.css";

function useSafeToast(): ToastApi | null {
  try {
    return useToast();
  } catch {
    return null;
  }
}

export interface OptionsLegData {
  side?: "BUY" | "SELL" | "BUY_TO_OPEN" | "SELL_TO_OPEN" | string;
  action?: "BUY" | "SELL" | string;
  quantity?: number;
  strike: number;
  optionType: "CALL" | "PUT" | "STOCK" | string;
  expiration?: string;
  symbol?: string;
  premium?: number;
  limitPrice?: number;
  delta?: number;
  iv?: number;
}

export interface OptionsStrategyData {
  id?: string;
  strategy?: string;
  label?: string;
  name?: string;
  type?: string;
  symbol: string;
  underlyingPrice?: number;
  expirationDate?: string;
  expiry?: string;
  dte?: number;
  sentiment?: "bullish" | "bearish" | "neutral" | "large_move" | "range_bound" | string;
  legs: OptionsLegData[];
  maxProfit?: number | string | null;
  maxProfitUnbounded?: boolean;
  maxLoss?: number | string;
  breakevens?: number[];
  breakeven?: number | string;
  probabilityOfProfit?: number | string;
  targetRewardRisk?: number | string;
  netDebit?: number;
  netCredit?: number;
  netDebitCredit?: string;
  netGreeks?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
  };
  payoffCurve?: Array<{ underlyingPrice: number; pnl: number }>;
  score?: number;
  compositeScore?: number;
  dataFreshness?: "FRESH" | "STALE" | "UNKNOWN" | string;
  summary?: string;
  rationale?: string[] | string;
}

function normalizeStrategyData(raw: any): OptionsStrategyData | null {
  if (!raw || typeof raw !== "object") return null;

  // Case 1: Wrapped in candidate or bestTrade
  const source = raw.candidate ?? raw.bestTrade?.best?.candidate ?? raw.bestTrade ?? raw;

  const symbol = source.symbol || source.underlyingSymbol || raw.symbol || "";
  if (!symbol && !source.legs?.length && !source.tradePlan?.length) return null;

  const rawLegs = source.legs || source.tradePlan || raw.legs || [];
  const legs: OptionsLegData[] = Array.isArray(rawLegs)
    ? rawLegs.map((l: any) => ({
        side: l.side || l.action || "BUY",
        action: l.action || l.side || "BUY",
        quantity: l.quantity || 1,
        strike: Number(l.strike) || 0,
        optionType: (l.optionType || l.type || "CALL").toUpperCase(),
        expiration: l.expiration || l.expirationDate || source.expirationDate || source.expiry,
        symbol: l.symbol || l.contract || symbol,
        limitPrice: l.limitPrice ?? l.premium,
        delta: l.delta,
        iv: l.iv,
      }))
    : [];

  const strategyName =
    source.label ||
    source.strategy ||
    source.name ||
    source.type ||
    raw.strategy ||
    raw.label ||
    "Options Strategy";

  return {
    id: source.id || raw.id,
    strategy: strategyName,
    label: strategyName,
    symbol: symbol.toUpperCase(),
    underlyingPrice: source.underlyingPrice ?? raw.underlyingPrice,
    expirationDate: source.expirationDate || source.expiry || raw.expirationDate || raw.expiry,
    dte: source.dte ?? raw.dte,
    sentiment: source.sentiment || source.thesis || raw.sentiment || raw.thesis || "neutral",
    legs,
    maxProfit: source.maxProfit ?? raw.maxProfit,
    maxProfitUnbounded: Boolean(source.maxProfitUnbounded ?? raw.maxProfitUnbounded),
    maxLoss: source.maxLoss ?? raw.maxLoss,
    breakevens: source.breakevens || (source.breakeven !== undefined ? [source.breakeven] : raw.breakevens),
    breakeven: source.breakeven ?? raw.breakeven,
    probabilityOfProfit: source.modelImpliedProbabilityOfProfit ?? source.probabilityOfProfit ?? raw.probabilityOfProfit,
    targetRewardRisk: source.targetRewardRisk ?? raw.targetRewardRisk,
    netDebit: source.netDebit ?? raw.netDebit,
    netCredit: source.netCredit ?? raw.netCredit,
    netDebitCredit: source.netDebitCredit ?? raw.netDebitCredit,
    netGreeks: source.netGreeks || raw.netGreeks,
    payoffCurve: source.payoffCurve || raw.payoffCurve,
    score: source.score ?? source.compositeScore ?? raw.score ?? raw.compositeScore,
    dataFreshness: source.dataFreshness || raw.dataFreshness || "FRESH",
    summary: source.summary || raw.summary,
    rationale: source.rationale || raw.rationale,
  };
}

export function OptionsStrategyCard({
  data,
  onAction,
  onNavigateTab,
  isBusy,
}: {
  data: any;
  onAction?: (actionPrompt: string) => void;
  onNavigateTab?: (tab: string) => void;
  isBusy?: boolean;
}) {
  const [openRaw, setOpenRaw] = useState(false);
  const toast = useSafeToast();

  const strategy = useMemo(() => normalizeStrategyData(data), [data]);

  if (!strategy || (!strategy.symbol && strategy.legs.length === 0)) {
    return null;
  }

  const {
    label,
    symbol,
    underlyingPrice,
    expirationDate,
    sentiment,
    legs,
    maxProfit,
    maxProfitUnbounded,
    maxLoss,
    breakevens,
    probabilityOfProfit,
    targetRewardRisk,
    netDebitCredit,
    netDebit,
    netCredit,
    netGreeks,
    score,
    dataFreshness,
  } = strategy;

  const sentimentTone =
    sentiment === "bullish" ? "success" : sentiment === "bearish" ? "danger" : "info";

  // Formatted financial metrics
  const formattedMaxProfit = maxProfitUnbounded
    ? "Unlimited"
    : maxProfit !== undefined && maxProfit !== null
    ? typeof maxProfit === "number"
      ? `$${maxProfit.toFixed(2)}`
      : String(maxProfit)
    : "N/A";

  const formattedMaxLoss =
    maxLoss !== undefined && maxLoss !== null
      ? typeof maxLoss === "number"
        ? `$${Math.abs(maxLoss).toFixed(2)}`
        : String(maxLoss)
      : "N/A";

  const formattedBreakevens =
    breakevens && breakevens.length > 0
      ? breakevens.map((b) => (typeof b === "number" ? `$${b.toFixed(2)}` : String(b))).join(", ")
      : "N/A";

  const formattedPop =
    probabilityOfProfit !== undefined
      ? typeof probabilityOfProfit === "number"
        ? probabilityOfProfit <= 1
          ? `${(probabilityOfProfit * 100).toFixed(1)}%`
          : `${probabilityOfProfit.toFixed(1)}%`
        : String(probabilityOfProfit)
      : undefined;

  const formattedCost =
    netDebitCredit ||
    (netDebit !== undefined
      ? `$${Number(netDebit).toFixed(2)} Debit`
      : netCredit !== undefined
      ? `$${Number(netCredit).toFixed(2)} Credit`
      : undefined);

  // Simple, deterministic SVG payoff path calculation
  const payoffPoints = useMemo(() => {
    if (strategy.payoffCurve && strategy.payoffCurve.length >= 2) {
      return strategy.payoffCurve;
    }
    // Generate synthetic curve from strikes
    const strikes = legs.map((l) => l.strike).filter((s) => s > 0);
    const basePrice = underlyingPrice || (strikes.length > 0 ? strikes[0] : 100);
    const minP = strikes.length ? Math.min(...strikes, basePrice) * 0.88 : basePrice * 0.88;
    const maxP = strikes.length ? Math.max(...strikes, basePrice) * 1.12 : basePrice * 1.12;
    const step = (maxP - minP) / 8;

    const points: Array<{ underlyingPrice: number; pnl: number }> = [];
    for (let p = minP; p <= maxP; p += step) {
      let pnl = 0;
      for (const leg of legs) {
        const isCall = leg.optionType === "CALL";
        const isBuy = leg.side?.toUpperCase().includes("BUY");
        const strike = leg.strike;
        const intrinsic = isCall ? Math.max(0, p - strike) : Math.max(0, strike - p);
        const premium = leg.limitPrice || 1;
        pnl += isBuy ? intrinsic - premium : premium - intrinsic;
      }
      points.push({ underlyingPrice: Number(p.toFixed(2)), pnl: Number((pnl * 100).toFixed(2)) });
    }
    return points;
  }, [strategy.payoffCurve, legs, underlyingPrice]);

  const legColumns = useMemo<TableColumn<OptionsLegData>[]>(() => {
    const cols: TableColumn<OptionsLegData>[] = [
      {
        key: "action",
        header: "Action",
        render: (leg) => {
          const isBuy = (leg.side || leg.action || "BUY").toUpperCase().includes("BUY");
          return (
            <span className={isBuy ? "options-side-buy" : "options-side-sell"}>
              {isBuy ? "BUY" : "SELL"}
            </span>
          );
        },
      },
      {
        key: "qty",
        header: "Qty",
        render: (leg) => leg.quantity || 1,
      },
      {
        key: "strike",
        header: "Strike",
        render: (leg) => <strong>${Number(leg.strike).toFixed(2)}</strong>,
      },
      {
        key: "type",
        header: "Type",
        render: (leg) => (
          <Badge size="xs" uppercase tone={leg.optionType === "CALL" ? "success" : "danger"}>
            {leg.optionType}
          </Badge>
        ),
      },
      {
        key: "expiry",
        header: "Expiry",
        render: (leg) => leg.expiration || expirationDate || "—",
      },
      {
        key: "limitPrice",
        header: "Mark / Limit",
        render: (leg) => (leg.limitPrice ? `$${Number(leg.limitPrice).toFixed(2)}` : "—"),
      },
    ];
    if (legs.some((l) => l.delta !== undefined)) {
      cols.push({
        key: "delta",
        header: "Delta",
        render: (leg) => (leg.delta ? Number(leg.delta).toFixed(2) : "—"),
      });
    }
    return cols;
  }, [legs, expirationDate]);

  const handleCopyJson = () => {
    try {
      navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      toast?.success("Options strategy JSON copied to clipboard");
    } catch {
      toast?.info("Strategy payload copied");
    }
  };

  return (
    <Card padding="none" className="options-strategy-structured-card">
      {/* Header */}
      <div className="options-card-header" onClick={() => setOpenRaw(!openRaw)}>
        <div className="options-card-title-group">
          <span className="options-card-icon">🎯</span>
          <span className="options-strategy-name">{label}</span>
          <span className="options-underlying-symbol">{symbol}</span>
          {underlyingPrice && (
            <span className="options-underlying-price">${Number(underlyingPrice).toFixed(2)}</span>
          )}
          {expirationDate && (
            <span className="metric-tag">📅 {expirationDate}</span>
          )}
        </div>

        <div className="options-card-badge-row">
          <Badge size="xs" uppercase tone={sentimentTone}>
            {String(sentiment).toUpperCase()}
          </Badge>
          {dataFreshness && (
            <Badge size="xs" uppercase tone={dataFreshness === "FRESH" ? "success" : "neutral"}>
              {dataFreshness}
            </Badge>
          )}
          {score !== undefined && (
            <Badge size="xs" uppercase tone="accent">
              Score: {Number(score).toFixed(0)}
            </Badge>
          )}
          <span className="toggle-arrow">{openRaw ? "▲" : "▼"}</span>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="options-metrics-grid">
        <div className="options-metric-tile">
          <span className="options-metric-label">Max Profit</span>
          <span className="options-metric-value profit">{formattedMaxProfit}</span>
        </div>
        <div className="options-metric-tile">
          <span className="options-metric-label">Max Loss</span>
          <span className="options-metric-value loss">{formattedMaxLoss}</span>
        </div>
        {formattedCost && (
          <div className="options-metric-tile">
            <span className="options-metric-label">Net Cost / Credit</span>
            <span className="options-metric-value credit">{formattedCost}</span>
          </div>
        )}
        <div className="options-metric-tile">
          <span className="options-metric-label">Breakeven(s)</span>
          <span className="options-metric-value">{formattedBreakevens}</span>
        </div>
        {formattedPop && (
          <div className="options-metric-tile">
            <span className="options-metric-label">POP</span>
            <span className="options-metric-value">{formattedPop}</span>
          </div>
        )}
        {targetRewardRisk && (
          <div className="options-metric-tile">
            <span className="options-metric-label">Reward / Risk</span>
            <span className="options-metric-value">{typeof targetRewardRisk === "number" ? `${targetRewardRisk.toFixed(2)}x` : targetRewardRisk}</span>
          </div>
        )}
      </div>

      {/* Greeks Strip */}
      {netGreeks && (
        <div className="options-greeks-strip">
          <span style={{ fontWeight: 700, textTransform: "uppercase", fontSize: "var(--font-size-micro)" }}>
            Net Greeks:
          </span>
          {netGreeks.delta !== undefined && (
            <span className="options-greek-item">Δ Delta: <strong>{Number(netGreeks.delta).toFixed(2)}</strong></span>
          )}
          {netGreeks.gamma !== undefined && (
            <span className="options-greek-item">Γ Gamma: <strong>{Number(netGreeks.gamma).toFixed(3)}</strong></span>
          )}
          {netGreeks.theta !== undefined && (
            <span className="options-greek-item">Θ Theta: <strong>{Number(netGreeks.theta).toFixed(2)}</strong></span>
          )}
          {netGreeks.vega !== undefined && (
            <span className="options-greek-item">V Vega: <strong>{Number(netGreeks.vega).toFixed(2)}</strong></span>
          )}
        </div>
      )}

      {/* Legs Breakdown Table */}
      {legs.length > 0 && (
        <div className="options-legs-section">
          <div className="options-legs-title">Strategy Legs ({legs.length})</div>
          <Table<OptionsLegData>
            columns={legColumns}
            rows={legs}
            rowKey={(_leg, idx) => String(idx)}
            className="options-legs-table"
          />
        </div>
      )}

      {/* Mini Payoff SVG Curve */}
      {payoffPoints.length >= 2 && (
        <div className="options-payoff-container">
          <div className="options-payoff-header">
            <span>2D Expiration Payoff Curve</span>
            <span>P&amp;L vs Underlying Price</span>
          </div>
          <svg className="options-payoff-svg" viewBox="0 0 400 80" preserveAspectRatio="none">
            {/* Zero Line */}
            <line x1="0" y1="40" x2="400" y2="40" stroke="var(--color-border-medium)" strokeDasharray="3 3" strokeWidth="1" />
            {/* PnL Line */}
            {(() => {
              const maxVal = Math.max(...payoffPoints.map((p) => Math.abs(p.pnl)), 100);
              const coords = payoffPoints.map((p, idx) => {
                const x = (idx / (payoffPoints.length - 1)) * 400;
                const y = 40 - (p.pnl / maxVal) * 35;
                return `${x.toFixed(1)},${y.toFixed(1)}`;
              });
              return (
                <polyline
                  points={coords.join(" ")}
                  fill="none"
                  stroke="var(--color-accent)"
                  strokeWidth="2.5"
                />
              );
            })()}
          </svg>
        </div>
      )}

      {/* Actionable CTAs */}
      <div className="options-card-actions">
        <Button
          variant="primary"
          tone="subtle"
          size="sm"
          disabled={isBusy}
          onClick={() => onAction?.(`Preview trade ${label} on ${symbol} in E*TRADE`)}
          title="Reserve order draft and preview execution"
        >
          ⚡ Preview in E*TRADE
        </Button>

        <Button
          variant="secondary"
          tone="subtle"
          size="sm"
          disabled={isBusy}
          onClick={() => onNavigateTab ? onNavigateTab("options") : onAction?.(`Open ${symbol} in Auto Options Research`)}
          title="Deep dive in Auto Options Research"
        >
          🔬 Research {symbol}
        </Button>

        <Button
          variant="secondary"
          tone="subtle"
          size="sm"
          disabled={isBusy}
          onClick={() => onNavigateTab ? onNavigateTab("options-flows") : onAction?.(`Inspect options flows for ${symbol}`)}
          title="Inspect institutional options sweeps and flow"
        >
          🌊 Options Flows
        </Button>

        <Button
          variant="ghost"
          size="sm"
          disabled={isBusy}
          onClick={handleCopyJson}
          title="Copy structured options JSON specification"
        >
          📋 Copy JSON
        </Button>
      </div>

      {/* Expandable Raw JSON */}
      {openRaw && (
        <div className="tool-card-body" style={{ padding: "var(--space-2) var(--space-3)", background: "var(--color-surface-sunken)" }}>
          <pre style={{ margin: 0, fontSize: "var(--font-size-micro)", overflowX: "auto" }}>
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      )}
    </Card>
  );
}
