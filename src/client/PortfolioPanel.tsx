import { Button, EmptyState, Notice, PageSection, PageShell, Spinner, Table } from "./components/ui";
import { ErrorBoundary } from "./ErrorBoundary";
import { AccountPanels } from "./AccountPanels";
import { AlpacaBrokerPanel } from "./AlpacaBrokerPanel";
import { PortfolioRiskPanel } from "./PortfolioRiskPanel";
import { formatMoney, formatSignedMoney, portfolioSummary } from "./brokerPortfolio";
import { safeNumberFormat, safePriceFormat } from "./formatters";
import { brokerSectionNav } from "./brokerSectionNav";
import { brokerSupports } from "../trading";
import { brokerModeBadge, type BrokerPresentation } from "../trading/brokerPresentation";
import type { RiskBroker } from "./portfolioRiskApi";
import type { TradeOrderContext } from "./trading/tradeOrderContext";
import type { BrokerAccount, BrokerPosition, BrokerQuote, ScreenedStockItem } from "../types";
import type { RiskSubject } from "./options/riskManagementEngine";

/**
 * Portfolio panel (issue #3050, PR5).
 *
 * Moved out of the Hub's inline markup: holdings hero + summary + positions
 * table, account panels, and portfolio risk, rendered in its own PageShell
 * inside the hub's shared shell. The markup is the Hub's, unchanged — only
 * the shell wrapper and section are new. Hub state and handlers arrive as
 * props; no data flow changed.
 */
interface PortfolioPanelProps {
  activeEnv: string;
  account: BrokerAccount | null;
  positions: BrokerPosition[];
  positionsLoading: boolean;
  fetchPositions: (override?: string) => Promise<void>;
  presentation: BrokerPresentation;
  brokerLabel: string;
  selectedBroker: string;
  isLive: boolean;
  onUnreadAlertsChange?: (count: number) => void;
  riskBroker: RiskBroker | null;
  onTradeOrder: (ctx: TradeOrderContext) => void;
  onNavigateOrder: () => void;
  handleSeedDemoPortfolio: () => void;
  handleQuickTrade: (stock: ScreenedStockItem | BrokerPosition | BrokerQuote, defaultAction?: "BUY" | "SELL") => void;
  handleCloseOptionPosition: (position: BrokerPosition) => void;
  setRiskSubject: (subject: RiskSubject | null) => void;
}

export function PortfolioPanel({
  activeEnv,
  account,
  positions,
  positionsLoading,
  fetchPositions,
  presentation,
  brokerLabel,
  selectedBroker,
  isLive,
  onUnreadAlertsChange,
  riskBroker,
  onTradeOrder,
  onNavigateOrder,
  handleSeedDemoPortfolio,
  handleQuickTrade,
  handleCloseOptionPosition,
  setRiskSubject,
}: PortfolioPanelProps) {
  return (
    <PageShell
      title="Portfolio"
      scopeNote="Holdings, cost basis, unrealized gain/loss, and portfolio Greeks across the connected brokerage desk — with account panels and portfolio risk below."
    >
      <PageSection title="Portfolio & holdings">
        <div className="trading-section portfolio-section">
          {/* Universal Hero Header */}
          <div className="tab-hero-header portfolio-hero-header">
            <div className="hero-text-block">
              <div className="hero-badge-row">
                <span className="hero-badge">💼 PORTFOLIO &amp; HOLDINGS</span>
                <span className="hero-badge" data-broker={selectedBroker}>{presentation.label}</span>
                <span className={`hero-badge ${isLive ? "badge-live" : "badge-paper"}`}>
                  {brokerModeBadge(selectedBroker, isLive ? "live" : "paper")}
                </span>
                <span className="hero-badge badge-pro">HITL ATTESTED</span>
              </div>
              <h3>{brokerLabel} Portfolio Holdings &amp; Open Positions</h3>
              <p>
                Inspect real-time equity &amp; options holdings, cost basis, unrealized gain/loss, asset allocations, and portfolio Greeks across your connected {brokerLabel} brokerage desk.
              </p>
            </div>
            <div className="hero-actions-row">
              <Button
                className="btn-options-refresh"
                variant="secondary"
                size="sm"
                onClick={() => fetchPositions()}
                disabled={positionsLoading}
                title={`Refresh live portfolio positions from ${brokerLabel}`}
               loading={positionsLoading}>
                <span className={positionsLoading ? "strat-spin" : ""}>↻</span>
                <span>{"Refresh Positions"}</span>
              </Button>
              <Button variant="trade"
                type="button"
                onClick={() => onNavigateOrder()}
                title="Open Fast Order Ticket to execute a trade"
              >
                ⚡ Fast Order Ticket
              </Button>
              {!isLive && (
                selectedBroker === "etrade" ? (
                  <Button variant="secondary"
                    type="button"
                    onClick={handleSeedDemoPortfolio}
                    title="Load curated paper trading positions (NVDA, AAPL, MSFT, SPY) to explore"
                  >
                    🌱 {positions.length === 0 ? "Load Demo Holdings" : "Reset Demo Holdings"}
                  </Button>
                ) : null
              )}
            </div>
          </div>

          <div className="portfolio-summary-row">
            {(() => {
              const summary = portfolioSummary(account, positions);
              const hasDayGain = summary.dayGain !== null;
              const isGain = (summary.dayGain ?? 0) >= 0;
              // Issue #3417: every figure comes from the SELECTED broker's own
              // read, and an unreported figure prints an em dash. "$0.00" for a
              // funded account was the defect — a zero is a claim.
              return (
                <>
                  <div className="port-summary-card">
                    <span className="summary-title">Portfolio Equity</span>
                    <span className="summary-amount">{formatMoney(summary.equity)}</span>
                    <span className={`summary-change ${hasDayGain ? (isGain ? "positive" : "negative") : ""}`}>
                      {hasDayGain
                        ? `${formatSignedMoney(summary.dayGain)} today`
                        : `${brokerLabel} did not report a day P&L for this account`}
                    </span>
                  </div>
                  <div className="port-summary-card">
                    <span className="summary-title">Available Cash</span>
                    <span className="summary-amount">{formatMoney(summary.cash)}</span>
                    <span className="summary-change">
                      {summary.cash === null
                        ? `Not reported by ${brokerLabel}`
                        : isLive
                          ? `${brokerLabel} purchasing power`
                          : "Paper capital ready"}
                    </span>
                  </div>
                  <div className="port-summary-card">
                    <span className="summary-title">Buying Power</span>
                    <span className="summary-amount">{formatMoney(summary.buyingPower)}</span>
                    <span className="summary-change">
                      {summary.buyingPower === null
                        ? `Not reported by ${brokerLabel}`
                        : account?.marginBuyingPower
                          ? "Margin buying power"
                          : "Cash buying power"}
                    </span>
                  </div>
                  <div className="port-summary-card">
                    <span className="summary-title">Active Positions</span>
                    {/* Issue #3880: before the first read lands the count is
                        unknown, not zero — "0" is a claim about the account. */}
                    <span className="summary-amount">
                      {summary.reported ? summary.positionCount : "—"}
                    </span>
                    <span className="summary-change">
                      {summary.reported
                        ? `${summary.optionCount} options · ${summary.equityCount} equities & ETFs`
                        : `Not read yet from ${brokerLabel} — use ↻ Refresh Positions`}
                    </span>
                  </div>
                </>
              );
            })()}
          </div>

          <div className="portfolio-table-wrap" id="section-positions" style={{ scrollMarginTop: 80 }}>
            <Table
                      columns={[
                        { key: "symbol", header: "Symbol & Company", render: (pos: any) => (<><div className="ticker-company"><span className="ticker-badge">{pos.symbol}</span><span className="company-title">{pos.securityType === "OPTN" ? `${pos.optionType || "Option"} ${safePriceFormat(pos.strikePrice, 2, "$0.00")} · ${pos.expirationDate || "Expiry unavailable"}` : pos.description}</span></div>{pos.securityType === "OPTN" && <span className="position-type-badge">{pos.positionType === "SHORT" ? "Short option" : "Long option"}</span>}</>) },
                        { key: "qty", header: "Quantity", render: (pos: any) => <span className="qty-val">{pos.quantity} {pos.securityType === "OPTN" ? "contracts" : "shares"}</span> },
                        { key: "cost", header: "Avg Cost Basis", render: (pos: any) => <span>{safePriceFormat(pos.costBasis ?? pos.pricePaid, 2, "$0.00")}</span> },
                        { key: "price", header: "Current Price", render: (pos: any) => <span className="price-tag">{safePriceFormat(pos.currentPrice ?? pos.marketPrice, 2, "$0.00")}</span> },
                        { key: "mkt", header: "Total Market Value", render: (pos: any) => <span className="mkt-val">${Number(pos.marketValue ?? (Number(pos.currentPrice ?? pos.marketPrice ?? 0) * Number(pos.quantity ?? 0))).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> },
                        { key: "unreal", header: "Unrealized Gain / Loss", render: (pos: any) => { const g = Number(pos.unrealizedGainLoss ?? pos.totalGain ?? 0); const gp = Number(pos.unrealizedGainLossPercent ?? pos.totalGainPercent ?? 0); const isPos = g >= 0; return <span className={`change-pill ${isPos ? "positive" : "negative"}`}>{isPos ? "+" : ""}${safeNumberFormat(g)} ({isPos ? "+" : ""}{safeNumberFormat(gp)}%)</span>; } },
                        { key: "day", header: "Day's Gain", render: (pos: any) => { const d = Number(pos.daysGain ?? 0); const dp = Number(pos.daysGainPercent ?? 0); const isPos = d >= 0; return <span className={`change-pill ${isPos ? "positive" : "negative"}`}>{isPos ? "+" : ""}${safeNumberFormat(d)} ({isPos ? "+" : ""}{safeNumberFormat(dp)}%)</span>; } },
                        { key: "actions", header: "Actions", render: (pos: any) => { const costBasis = Number(pos.costBasis ?? pos.pricePaid ?? 0); const curPrice = Number(pos.currentPrice ?? pos.marketPrice ?? 0); const mktVal = Number(pos.marketValue ?? (curPrice * Number(pos.quantity ?? 0))); const unrealizedGain = Number(pos.unrealizedGainLoss ?? pos.totalGain ?? 0); return (<div className="table-actions-cell">{pos.securityType === "OPTN" && pos.optionType && pos.strikePrice && pos.expirationDate ? (<Button variant="danger" tone="subtle" size="sm" type="button" onClick={() => handleCloseOptionPosition(pos)} title="Build a broker-priced closing order for this option position">- Close Option</Button>) : pos.securityType === "OPTN" ? (<span className="position-action-unavailable" title="The broker did not return enough contract details to build a closing order.">Contract details unavailable</span>) : (<><Button variant="trade" tone="subtle" size="sm" type="button" onClick={() => handleQuickTrade(pos, "BUY")} title="Add more shares">+ Buy</Button><Button variant="danger" tone="subtle" size="sm" type="button" onClick={() => handleQuickTrade(pos, "SELL")} title="Sell to close position">- Close</Button></>)}<Button variant="warning" tone="subtle" size="sm" type="button" onClick={() => { setRiskSubject({ title: `${pos.quantity}x ${pos.symbol} (${pos.description || "Long Equity"})`, underlyingSymbol: pos.symbol, underlyingPrice: curPrice, strategyType: "Long Equity Position", sentiment: "bullish", quantity: pos.quantity, positionType: "EQUITY", costBasis: costBasis, unrealizedPnL: unrealizedGain, maxLoss: mktVal, maxProfit: null, breakevens: [costBasis], breakevenText: `Cost basis: ${safePriceFormat(costBasis)}/share` }); }} title="Analyze position risk profile and hedging strategies">🛡️ Risk</Button></div>); } },
                      ]}
                      rows={positions}
                      rowKey={(pos: any) => pos.symbol}
                      empty={positionsLoading ? (
                        <Spinner label="Loading portfolio positions" />
                      ) : (
                        <EmptyState
                          icon="💼"
                          title="No Active Holdings Found"
                          description={
                            isLive
                              ? `No active positions found in your connected live ${brokerLabel} brokerage account. Use the Fast Order Ticket to build and preview an order.`
                              : (selectedBroker === "etrade"
                                ? "Your paper trading sandbox has no open positions. Place a paper trade or load curated demo holdings (NVDA, AAPL, MSFT, SPY) to explore portfolio analytics, charts, and Greeks."
                                : `Your ${brokerLabel} paper trading sandbox has no open positions. Place a paper trade to explore portfolio analytics, charts, and Greeks.`)
                          }
                          action={
                            <div style={{ display: "flex", gap: "var(--space-3)", justifyContent: "center", flexWrap: "wrap" }}>
                              <Button variant="trade" onClick={() => onNavigateOrder()}>
                                ⚡ Build Order Ticket
                              </Button>
                              {!isLive && (
                                selectedBroker === "etrade" ? (
                                  <Button variant="secondary" onClick={handleSeedDemoPortfolio}>
                                    🌱 Load Curated Demo Positions
                                  </Button>
                                ) : null
                              )}
                            </div>
                          }
                        />
                      )}
                    />
          </div>

          {/* Portfolio Risk (issue #63): surfaces the #34/#35/#36/#54 backends —
              aggregates, hedge drafts with HITL preview hand-off, correlation
              flags, and portfolio-aware sizing. */}
          {/* Section nav (issue #69) */}
          <nav className="portfolio-section-nav" style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginTop: "1.25rem" }}>
            {/* Issue #3367: the chips follow the broker being rendered. A chip that
                scrolls to a section this broker's panel does not render is a dead
                control, and the list used to be E*TRADE's for every broker. */}
            {brokerSectionNav(selectedBroker).map(({ label, id }) => (
              <Button
                variant="secondary"
                size="sm"
                key={id}
                style={{ padding: "var(--space-1-5) var(--space-3)", borderRadius: 999, border: "1px solid var(--color-border-medium)", background: "var(--color-muted)", color: "inherit", cursor: "pointer", fontSize: "var(--font-size-body-sm)" }}
                onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
              >
                {label}
              </Button>
            ))}
          </nav>

          <ErrorBoundary label="Account panels (alerts, transactions, watchlists, orders)">
            {selectedBroker === "etrade" ? (
              <AccountPanels activeEnv={activeEnv} onUnreadAlertsChange={onUnreadAlertsChange} />
            ) : (
              <AlpacaBrokerPanel broker={selectedBroker} activeEnv={activeEnv} />
            )}
          </ErrorBoundary>

          <ErrorBoundary label="Portfolio Risk panel">
            {/* Issue #3356: the catalogue decides whether risk is served, and the
                panel reads the SELECTED broker's book. A broker that declares no risk
                model gets a named notice instead of another broker's numbers. */}
            {riskBroker && brokerSupports(riskBroker, "portfolioRisk") ? (
              <PortfolioRiskPanel activeEnv={activeEnv} onPreviewHedge={onTradeOrder} broker={riskBroker} />
            ) : (
              <Notice tone="neutral" title="Portfolio risk analytics are not available for this broker">
                The selected broker declares no portfolio risk model. No other broker's positions are
                substituted for it.
              </Notice>
            )}
          </ErrorBoundary>
        </div>
      </PageSection>
    </PageShell>
  );
}
