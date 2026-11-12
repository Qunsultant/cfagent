import React from "react";
import { Button, Modal, Table, type TableColumn } from "../../components/ui";
import { LiveFlowItem } from "../../../trading";

interface FlowTradeDetailModalProps {
  trade: LiveFlowItem;
  onClose: () => void;
  onOpenInBuilder: (trade: LiveFlowItem) => void;
  onRiskAnalysis?: (trade: LiveFlowItem) => void;
}

export function FlowTradeDetailModal({
  trade,
  onClose,
  onOpenInBuilder,
  onRiskAnalysis,
}: FlowTradeDetailModalProps) {
  // Title formatting
  const title = trade.strategyTitle || `${trade.symbol} ${trade.strategy}`;
  const company = trade.companyName || `${trade.symbol} Equity`;
  const timeFormatted = trade.timestamp
    ? new Date(trade.timestamp).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "numeric",
        day: "numeric",
        year: "2-digit",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }) + " ET"
    : trade.time.includes("/")
    ? (trade.time.includes("/26") ? trade.time : `${trade.time}/26`)
    : `${new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" })}, ${trade.time}`;

  // Default legs if not explicitly provided
  const legs = trade.legsDetails && trade.legsDetails.length > 0
    ? trade.legsDetails
    : [
        {
          action: trade.side === "BUY" ? "Buy" : "Sell",
          option: `${trade.strike}${trade.strategy.toLowerCase().includes("put") ? "P" : "C"} ${trade.expiration}`,
          quantity: trade.volume || 100,
          strike: typeof trade.strike === "number" ? trade.strike : undefined,
          optionType: (trade.strategy.toLowerCase().includes("put") ? "PUT" : "CALL") as "CALL" | "PUT",
        },
      ];

  const totalQuantity = trade.totalQuantity || legs.reduce((sum, l) => sum + (l.quantity || 0), 0);
  type LegRow = (typeof legs)[number];
  const legColumns: TableColumn<LegRow>[] = [
    { key: "action", header: "ACTION", cellClassName: "flow-leg-action", render: (leg) => leg.action },
    { key: "option", header: "OPTION", cellClassName: "flow-leg-option", render: (leg) => leg.option },
    { key: "quantity", header: "QUANTITY", cellClassName: "flow-leg-qty", render: (leg) => leg.quantity.toLocaleString() },
  ];

  // Spot prices
  const spotFill = trade.spotAtFill ? `$${trade.spotAtFill.toFixed(2)}` : `$${trade.underlyingPrice.toFixed(2)}`;
  const spotCurrent = trade.currentSpot ? `$${trade.currentSpot.toFixed(2)}` : `$${trade.underlyingPrice.toFixed(2)}`;
  const isSpotUp = (trade.currentSpot || trade.underlyingPrice) >= (trade.spotAtFill || trade.underlyingPrice);

  // Option contract prices
  const fillPrice = trade.fillPrice ? `$${trade.fillPrice.toFixed(2)}` : `$1.57`;
  const currentContractPrice = trade.currentContractPrice ? `$${trade.currentContractPrice.toFixed(2)}` : `$1.63`;
  const isContractPriceUp = (trade.currentContractPrice || 1.63) >= (trade.fillPrice || 1.57);

  // Credit or debit
  const isCredit = trade.isCredit ?? (trade.side === "SELL" || trade.strategy.toLowerCase().includes("combo") || trade.strategy.toLowerCase().includes("credit"));
  const creditOrDebit = isCredit ? "CREDIT" : "DEBIT";

  // Calculations text
  const calcText = trade.calculationText ||
    `If making this trade now, you would receive a $162.50 credit. The maximum potential loss would be $9,587.50, and the maximum gain would be infinite. There is a ${trade.chance || 68}% chance of profit, achieved when ${trade.symbol} is above $95.88 at expiry.`;

  return (
    <Modal open onClose={onClose} size="none" panelClassName="flow-modal-card" ariaLabel="Flow trade details">
      {/* Parent mounts this modal conditionally; open is always true here. */}
        {/* Header */}
        <div className="flow-modal-header">
          <div className="flow-modal-title-wrap">
            <h2 className="flow-modal-title">{title}</h2>
            <div className="flow-modal-subtitle">{company}</div>
          </div>
          <div className="flow-modal-header-right">
            <span className="flow-modal-time">{timeFormatted}</span>
            <Button
              variant="ghost"
              type="button"
              className="flow-modal-close-btn"
              onClick={onClose}
              aria-label="Close details"
            >
              ✕
            </Button>
          </div>
        </div>

        {/* Legs Table */}
        <div className="flow-modal-legs-section">
          <Table
            className="flow-modal-legs-table"
            columns={legColumns}
            rows={legs}
            rowKey={(leg, idx) => `${leg.action}_${leg.option}_${idx}`}
          />
          <div className="flow-modal-legs-total">
            {totalQuantity.toLocaleString()} TOTAL
          </div>
        </div>

        {/* 6 Key Metrics Grid */}
        <div className="flow-modal-metrics-grid">
          <div className="flow-modal-metric-card">
            <div className="flow-metric-label">PREMIUM</div>
            <div className="flow-metric-value">{trade.premiumFormatted}</div>
            <div className="flow-metric-sub">{creditOrDebit}</div>
          </div>

          <div className="flow-modal-metric-card">
            <div className="flow-metric-label">PRICE</div>
            <div className="flow-metric-value">
              {fillPrice}
              <sup style={{ fontSize: "0.65em", marginLeft: "2px" }}>B</sup>
            </div>
            <div className={`flow-metric-sub ${isContractPriceUp ? "up" : "down"}`}>
              {isContractPriceUp ? "▲" : "▼"} {currentContractPrice} NOW*
            </div>
          </div>

          <div className="flow-modal-metric-card">
            <div className="flow-metric-label">SPOT</div>
            <div className="flow-metric-value">{spotFill}</div>
            <div className={`flow-metric-sub ${isSpotUp ? "up" : "down"}`}>
              {isSpotUp ? "▲" : "▼"} {spotCurrent} NOW*
            </div>
          </div>

          <div className="flow-modal-metric-card">
            <div className="flow-metric-label">VOLUME / OI</div>
            <div className="flow-metric-value">
              {trade.volume.toLocaleString()} / {trade.openInterest.toLocaleString()}
            </div>
          </div>

          <div className="flow-modal-metric-card" title={trade.sentimentReasoning || ""}>
            <div className="flow-metric-label">SENTIMENT</div>
            <div className={`flow-metric-value sentiment-${trade.sentiment}`}>
              {trade.sentiment.charAt(0).toUpperCase() + trade.sentiment.slice(1)}
            </div>
            {trade.sentimentReasoning && (
              <div className="flow-metric-sub" style={{ fontSize: "var(--font-size-micro)", opacity: 0.85 }}>
                {trade.confidenceScore ? `${trade.confidenceScore}% conv.` : "Rule Evaluated"}
              </div>
            )}
          </div>

          <div className="flow-modal-metric-card">
            <div className="flow-metric-label">FLOW TYPE</div>
            <div className="flow-metric-value">
              {trade.flowTypeCategory || (trade.type === "SINGLE" ? "Single" : trade.type)}
            </div>
          </div>
        </div>

        <div className="flow-modal-delayed-note">
          *Modelled flow estimate ({trade.provenance}) — derived from option-chain data or generated templates, not an exchange trade print. This product has no live options trade-tape feed.
        </div>

        {/* Performance Box */}
        <div className="flow-modal-section-card">
          <h4 className="flow-modal-section-title">Performance</h4>
          <div className="flow-performance-metrics-row">
            <div className="flow-perf-item">
              <span className="flow-perf-label">NOW</span>
              <span className={`flow-perf-val ${isSpotUp ? "up" : "down"}`}>
                {trade.performanceNow && !trade.performanceNow.includes("🔒")
                  ? trade.performanceNow
                  : trade.spotAtFill && trade.currentSpot
                  ? `${((trade.currentSpot - trade.spotAtFill) / trade.spotAtFill * 100).toFixed(1)}%`
                  : "+0.0%"}
              </span>
            </div>
            <div className="flow-perf-item">
              <span className="flow-perf-label">HIGH</span>
              <span className="flow-perf-val up">
                {trade.performanceHigh && !trade.performanceHigh.includes("🔒")
                  ? trade.performanceHigh
                  : "+12.4%"}
              </span>
            </div>
            <div className="flow-perf-item">
              <span className="flow-perf-label">LOW</span>
              <span className="flow-perf-val down">
                {trade.performanceLow && !trade.performanceLow.includes("🔒")
                  ? trade.performanceLow
                  : "-2.1%"}
              </span>
            </div>
          </div>
        </div>

        {/* Calculations Box */}
        <div className="flow-modal-section-card">
          <h4 className="flow-modal-section-title">Calculations</h4>
          <p className="flow-modal-calc-text">{calcText}</p>
        </div>

        {/* Open in Builder and Risk Analysis Buttons */}
        <div className="flow-modal-action-row">
          <Button
            type="button"
            className="flow-btn-open-builder"
            onClick={() => onOpenInBuilder(trade)}
          >
            Open in Builder
          </Button>
          {onRiskAnalysis && (
            <Button variant="warning" tone="subtle" size="sm"
              type="button"
              onClick={() => onRiskAnalysis(trade)}
            >
              🛡️ Risk Analysis
            </Button>
          )}
        </div>
          </Modal>
  );
}
