import React from "react";
import { Badge, Button } from "../components/ui";
import {
  candidateToTradeContext,
  type TradeOrderContext,
} from "../trading/tradeOrderContext";

export interface LiveResultPreviewProps {
  liveResult: any;
  /** The run's thesis: the preview action follows it (bearish → SELL_SHORT). */
  thesis?: "bullish" | "bearish" | "neutral" | "directional";
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
}

/**
 * Result banner for an on-demand run. Presentation only: each channel
 * pill states what the server reported (sent / failed / not reported)
 * and never upgrades "not reported" to a success. Styles are token
 * classes (scheduledOptions.css); no inline style objects (#2329).
 */
export function LiveResultPreview({ liveResult, thesis = "bullish", onPreviewTrade }: LiveResultPreviewProps) {
  if (!liveResult) return null;

  const channel = (value: unknown): { tone: "success" | "danger" | "neutral"; label: string } => {
    if (value === true) return { tone: "success", label: "✓ Sent" };
    if (value === false) return { tone: "danger", label: "✕ Error" };
    return { tone: "neutral", label: "– not reported" };
  };
  const channels = [
    { name: "Slack", value: liveResult.notifications?.slack },
    { name: "Email", value: liveResult.notifications?.email },
    { name: "Webhook", value: liveResult.notifications?.webhook },
  ].map((entry) => ({ ...entry, ...channel(entry.value) }));

  return (
    <section className="live-execution-preview" aria-label="Live screening execution result">
      <div className="preview-top-bar">
        <h4>⚡ Live Screening Execution Completed</h4>
        <div className="dispatch-status-pills">
          {channels.map((entry) => (
            <Badge key={entry.name} tone={entry.tone} size="xs">
              {entry.name}: {entry.label}
            </Badge>
          ))}
        </div>
      </div>

      <p className="live-preview-summary">{liveResult.summary}</p>

      {Array.isArray(liveResult.opportunities) && liveResult.opportunities.length > 0 && (
        <div className="live-preview-grid">
          {liveResult.opportunities.map((opportunity: any) => {
            const candidate = opportunity.pick?.best?.candidate;
            return (
              <div key={opportunity.symbol} className="live-preview-card">
                <div className="live-preview-card-head">
                  <strong className="live-preview-symbol">{opportunity.symbol}</strong>
                  <Badge tone="accent" size="xs">
                    Score: {opportunity.score}/100
                  </Badge>
                </div>
                <p className="live-preview-label">{candidate?.label || "Options Setup"}</p>
                <div className="live-preview-metrics">
                  <span>
                    Max profit:{" "}
                    <strong className="live-preview-profit">
                      {candidate?.maxProfitUnbounded ? "∞" : `$${candidate?.maxProfit?.toFixed(2) || "0"}`}
                    </strong>
                  </span>
                  <span>
                    Max loss:{" "}
                    <strong className="live-preview-loss">
                      ${candidate?.maxLoss?.toFixed(2) || "0"}
                    </strong>
                  </span>
                </div>
                {candidate && onPreviewTrade && (
                  <Button
                    type="button"
                    variant="accent"
                    tone="subtle"
                    size="sm"
                    className="live-preview-action"
                    onClick={() => {
                      // Issue #3361: the ticket takes a TradeOrderContext,
                      // not the raw candidate — convert with the canonical
                      // mapping (same as OptionsResearchPanel). The spot
                      // price is the row's when known, else the
                      // candidate's; unknown stays unknown, never invented.
                      const underlyingPrice =
                        typeof opportunity.underlyingPrice === "number" &&
                        Number.isFinite(opportunity.underlyingPrice)
                          ? opportunity.underlyingPrice
                          : typeof candidate.underlyingPrice === "number" &&
                              Number.isFinite(candidate.underlyingPrice)
                            ? candidate.underlyingPrice
                            : undefined;
                      onPreviewTrade(
                        candidateToTradeContext(candidate, thesis, underlyingPrice),
                      );
                    }}
                  >
                    Preview in Order Ticket
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
