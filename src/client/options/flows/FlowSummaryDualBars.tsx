import React from "react";
import { FlowLeaderboardItem } from "../../../trading";

interface FlowSummaryDualBarsProps {
  bullishItems: FlowLeaderboardItem[];
  bearishItems: FlowLeaderboardItem[];
  onSelectSymbol: (symbol: string) => void;
}

export function FlowSummaryDualBars({
  bullishItems,
  bearishItems,
  onSelectSymbol,
}: FlowSummaryDualBarsProps) {
  return (
    <div className="flow-dual-leaderboard-container">
      {/* Left Column: Bullish Flow */}
      <div className="flow-leaderboard-col bullish-col">
        <div className="flow-leaderboard-col-header">
          <span className="flow-col-title-bullish">🐂 Bullish Flow</span>
        </div>
        <div className="flow-leaderboard-rows-list">
          {bullishItems.length === 0 ? (
            <div style={{ padding: "calc(var(--space-6) * 2) var(--space-4)", textAlign: "center", color: "var(--color-text-dim)", fontSize: "var(--font-size-body)" }}>
              No bullish flow matching active filter criteria
            </div>
          ) : (
            bullishItems.map((item) => (
              <div
                key={item.symbol}
                className="flow-bar-row bullish-row"
                onClick={() => onSelectSymbol(item.symbol)}
                title={`View Live Flow for ${item.symbol} (${item.tradeCount} trades, ${item.premiumFormatted})`}
              >
                {/* Background gradient bar */}
                <div
                  className="flow-bar-fill bullish-fill"
                  style={{ width: `${item.pctWidth}%` }}
                />
                {/* Row contents */}
                <div className="flow-bar-content bullish-content">
                  <span className="flow-bar-symbol">{item.symbol}</span>
                  <span className="flow-bar-count bullish-count">{item.tradeCount}</span>
                  <span className="flow-bar-amount bullish-amount">{item.premiumFormatted}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right Column: Bearish Flow */}
      <div className="flow-leaderboard-col bearish-col">
        <div className="flow-leaderboard-col-header">
          <span className="flow-col-title-bearish">🐻 Bearish Flow</span>
        </div>
        <div className="flow-leaderboard-rows-list">
          {bearishItems.length === 0 ? (
            <div style={{ padding: "calc(var(--space-6) * 2) var(--space-4)", textAlign: "center", color: "var(--color-text-dim)", fontSize: "var(--font-size-body)" }}>
              No bearish flow matching active filter criteria
            </div>
          ) : (
            bearishItems.map((item) => (
              <div
                key={item.symbol}
                className="flow-bar-row bearish-row"
                onClick={() => onSelectSymbol(item.symbol)}
                title={`View Live Flow for ${item.symbol} (${item.tradeCount} trades, ${item.premiumFormatted})`}
              >
                {/* Background gradient bar extending from right or left */}
                <div
                  className="flow-bar-fill bearish-fill"
                  style={{ width: `${item.pctWidth}%` }}
                />
                {/* Row contents */}
                <div className="flow-bar-content bearish-content">
                  <span className="flow-bar-amount bearish-amount">{item.premiumFormatted}</span>
                  <span className="flow-bar-count bearish-count">{item.tradeCount}</span>
                  <span className="flow-bar-symbol">{item.symbol}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
