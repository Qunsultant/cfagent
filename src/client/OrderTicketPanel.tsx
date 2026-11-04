import React, { useEffect, useRef } from "react";
import {
  Badge,
  Button,
  FieldShell,
  Flex,
  Notice,
  PageShell,
  Select,
  Stack,
  TabPanel,
  Tabs,
  TextInput,
} from "./components/ui";
import { TradingApprovalsQueue } from "./TradingApprovalsQueue";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import type { ETradeOrderDraft, ETradeQuote } from "../types";
import type { TradeAssetClass, TradeOrderContext } from "./trading/tradeOrderContext";
import type { RiskSubject } from "./options/riskManagementEngine";

/**
 * OrderTicketPanel — the Fast Order Ticket as its own shell-conforming
 * page (issue #3088, epic #3086). The trading hub's order branch renders
 * this panel (the #3050 PR1 composition pattern); all ticket state still
 * lives in the hub and arrives as one model prop, so every seed path
 * (strategy trade, quick trade, close-position, schedule preview, the
 * legacy ?assetClass=options one-shot) behaves exactly as before.
 *
 * Tabs are URL-synced (?orderTab=stock|options, default stock) and switch
 * the ticket's asset class; switching tabs preserves the symbol, and
 * switching to options with no context seeds the manual options ticket
 * exactly as #3038 does (one blank BUY CALL leg, editable underlying).
 * The panel follows the hub's asset class whenever it changes underneath
 * (a seed landing while the page is mounted), so the selected tab can
 * never disagree with the ticket it shows.
 */

export type OrderTicketTab = "stock" | "options";

export interface OrderTicketModel {
  orderSymbol: string;
  orderAction: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  orderType: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  orderQuantity: number;
  orderLimitPrice: string;
  orderQuote: ETradeQuote | null;
  quoteLoading: boolean;
  previewLoading: boolean;
  orderError: string;
  orderContext: TradeOrderContext | null;
  orderAssetClass: TradeAssetClass;
  orderLegs: NonNullable<TradeOrderContext["optionLegs"]>;
  activeDraft: ETradeOrderDraft | null;
  oauthStatus: {
    authenticated: boolean;
    environment?: string;
    storedAt?: string;
    renewable?: boolean;
    expired?: boolean;
  } | null;
  setOrderSymbol: (symbol: string) => void;
  setOrderAction: (action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT") => void;
  setOrderType: (type: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT") => void;
  setOrderQuantity: (quantity: number) => void;
  setOrderLimitPrice: (price: string) => void;
  setOrderContext: (ctx: TradeOrderContext | null) => void;
  setActiveDraft: (draft: null) => void;
  setLastExecutionResult: (result: null) => void;
  setOrderError: (error: string) => void;
  setOrderAssetClass: (assetClass: TradeAssetClass) => void;
  fetchSymbolQuote: (symbol: string, envOverride?: unknown) => Promise<void>;
  updateOptionLeg: (
    index: number,
    patch: Partial<NonNullable<TradeOrderContext["optionLegs"]>[number]>,
  ) => void;
  addOptionLeg: () => void;
  removeOptionLeg: (index: number) => void;
  setOptionNetOrderDirection: (credit: boolean) => void;
  handlePreviewOrder: (e: React.FormEvent) => Promise<void>;
  handleStartOAuth: (override?: unknown) => Promise<void>;
  sendNlqToChat: (prompt?: string) => void;
  setRiskSubject: (subject: RiskSubject | null) => void;
  seedManualOptions: (symbol: string) => void;
}

export function OrderTicketPanel({ ticket }: { ticket: OrderTicketModel }) {
  const {
    orderSymbol,
    orderAction,
    orderType,
    orderQuantity,
    orderLimitPrice,
    orderQuote,
    quoteLoading,
    previewLoading,
    orderError,
    orderContext,
    orderAssetClass,
    orderLegs,
    activeDraft,
    oauthStatus,
    setOrderSymbol,
    setOrderAction,
    setOrderType,
    setOrderQuantity,
    setOrderLimitPrice,
    setOrderContext,
    setActiveDraft,
    setLastExecutionResult,
    setOrderError,
    setOrderAssetClass,
    fetchSymbolQuote,
    updateOptionLeg,
    addOptionLeg,
    removeOptionLeg,
    setOptionNetOrderDirection,
    handlePreviewOrder,
    handleStartOAuth,
    sendNlqToChat,
    setRiskSubject,
    seedManualOptions,
  } = ticket;

  const applyTab = (tab: OrderTicketTab) => {
    if (tab === "options" && !orderContext) {
      seedManualOptions(orderSymbol);
      return;
    }
    // Tabs say stock/options; the ticket's asset class says equity/options.
    const asset: TradeAssetClass = tab === "options" ? "options" : "equity";
    if (asset !== orderAssetClass) setOrderAssetClass(asset);
  };

  const { activeTab, handleTabChange } = useUrlSyncedTabs<OrderTicketTab>({
    param: "orderTab",
    isValid: (value: unknown): value is OrderTicketTab =>
      value === "stock" || value === "options",
    defaultTab: "stock",
    onTabChange: applyTab,
  });

  // Mount: the URL tab and the ticket can disagree two ways, and each
  // direction wins in exactly one case. An explicit ?orderTab= in the URL
  // is the user's intent (deep link, reload, back/forward) — apply it.
  // With no param, a surviving ticket wins (the Fast Order Ticket entry
  // never touches the ticket, so a strategy ticket from another tab must
  // still show its own tab when the page reopens).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const urlTab = new URLSearchParams(window.location.search).get("orderTab");
    if (urlTab === "stock" || urlTab === "options") {
      const assetTab: OrderTicketTab =
        orderAssetClass === "options" ? "options" : "stock";
      if (urlTab !== assetTab) applyTab(urlTab);
    } else {
      const assetTab: OrderTicketTab =
        orderAssetClass === "options" ? "options" : "stock";
      if (assetTab !== activeTab) handleTabChange(assetTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After mount: follow the hub's asset class whenever it moves
  // underneath the page. A seed landing while mounted (the legacy
  // assetClass one-shot, a schedule preview) must move the selected tab
  // with it, or the tab would claim stock while the ticket shows options.
  // The first run is the mount commit itself, already reconciled above.
  const prevAssetClassRef = useRef(orderAssetClass);
  useEffect(() => {
    if (prevAssetClassRef.current === orderAssetClass) return;
    prevAssetClassRef.current = orderAssetClass;
    const assetTab: OrderTicketTab =
      orderAssetClass === "options" ? "options" : "stock";
    if (assetTab !== activeTab) handleTabChange(assetTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderAssetClass]);

  return (
    <PageShell title="Order Ticket">
      <Tabs
        idBase="order-ticket"
        ariaLabel="Order type"
        tabs={[
          { id: "stock", label: "Stock order" },
          { id: "options", label: "Options order" },
        ]}
        value={activeTab}
        onChange={(tab) => handleTabChange(tab)}
      />
      <Stack gap="4">
        <TabPanel idBase="order-ticket" tabId={activeTab} active>
          <div className="trading-section order-ticket-section">
            <div className="order-ticket-layout">
              {/* Left: Interactive Order Ticket Form */}
              <div className="order-form-card">
                <Flex justify="between" align="start" wrap gap="2" className="card-header-styled">
                  <div>
                    <h4>⚡ {orderAssetClass === "options" ? "Options Order Ticket" : "Equity / ETF Order Ticket"}</h4>
                    <span className="header-subtitle">
                      {orderAssetClass === "options"
                        ? "Broker-priced options strategy preview with human approval required"
                        : orderContext?.optionLegs?.length
                          ? "Stock strategy preview with human approval required"
                          : "Zero-commission equity trading with agentic DID stamping"}
                    </span>
                  </div>
                  {orderSymbol && (
                    <Button
                      className="btn-options-refresh"
                      variant="secondary"
                      size="sm"
                      onClick={() => fetchSymbolQuote(orderSymbol)}
                      disabled={quoteLoading}
                      title={`Refresh live quote for ${orderSymbol}`}
                     loading={quoteLoading}>
                      <span className={quoteLoading ? "strat-spin" : ""}>↻</span>
                      <span>{"Refresh Quote"}</span>
                    </Button>
                  )}
                </Flex>

                {orderError && (orderAssetClass === "options" ? (
                  <div className="options-preview-error" role="alert">
                    <strong>Options preview failed. No order was created or submitted.</strong>
                    <span>{/unapproved options position|options approval levels/i.test(orderError)
                      ? "E*TRADE says this strategy is not approved for the account, or conflicts with current positions or open orders. Review the account’s options approval and open orders with E*TRADE."
                      : "Review the contract details and correct the issue before requesting another broker preview."}</span>
                    <details>
                      <summary>Broker response</summary>
                      <p>{orderError}</p>
                    </details>
                  </div>
                ) : <div className="form-error-alert" role="alert">⚠️ {orderError}</div>)}
                {orderContext && (
                  <div className="options-order-context">
                    <strong>{orderContext.assetClass === "options" ? "Options strategy" : "From Strategy Research"}</strong>
                    <span>{orderContext.label}</span>
                    {orderAssetClass === "options" && orderContext.assetClass === "options" ? (
                      <div className="options-leg-editor" aria-label="Edit option strategy legs">
                        <div className="options-leg-editor-heading">
                          <div>
                            <strong>Build your order</strong>
                            <span>Review and edit every contract before requesting E*TRADE’s preview.</span>
                          </div>
                          <Button type="button" variant="secondary" size="sm" className="options-leg-add" onClick={addOptionLeg} disabled={orderLegs.length >= 4 || orderLegs.some((leg) => leg.securityType === "EQ")}>
                            + Add leg
                          </Button>
                        </div>
                        {orderLegs.map((leg, index) => (
                          <div className="options-leg-row" key={`option-leg-${index}`}>
                            <div className="options-leg-title"><strong>Leg {index + 1}</strong><span>{leg.securityType === "OPTN" ? "OPTION" : "STOCK"}</span></div>
                            <Select label="Side" value={leg.side} onChange={(event) => updateOptionLeg(index, { side: event.target.value as "BUY" | "SELL" })}>
                              <option value="BUY">Buy</option><option value="SELL">Sell</option>
                            </Select>
                            {leg.securityType === "OPTN" && <>
                              <Select label="Type" value={leg.optionType || "CALL"} onChange={(event) => updateOptionLeg(index, { optionType: event.target.value as "CALL" | "PUT" })}>
                                <option value="CALL">Call</option><option value="PUT">Put</option>
                              </Select>
                              <TextInput label="Strike ($)" type="number" min="0.01" step="0.5" value={leg.strike ?? ""} onChange={(event) => updateOptionLeg(index, { strike: Number(event.target.value) })} />
                              <TextInput label="Expiration" type="date" value={leg.expirationDate || ""} onChange={(event) => updateOptionLeg(index, { expirationDate: event.target.value })} />
                            </>}
                            <TextInput label={leg.securityType === "OPTN" ? "Contracts" : "Shares"} type="number" min="1" step="1" value={leg.quantity} onChange={(event) => updateOptionLeg(index, { quantity: Math.max(1, Number.parseInt(event.target.value, 10) || 1) })} />
                            <Button type="button" variant="danger" tone="subtle" size="sm" className="options-leg-remove" onClick={() => removeOptionLeg(index)} aria-label={`Remove leg ${index + 1}`} disabled={(orderContext.optionLegs?.length ?? 0) <= 1}>Remove</Button>
                          </div>
                        ))}
                        <p className="options-leg-editor-help">1. Edit the contracts and net limit. 2. Request E*TRADE’s preview. 3. Review and approve only if the broker accepts it. Nothing is submitted before your approval; E*TRADE still validates account approval, buying power, and existing positions.</p>
                      </div>
                    ) : (
                      <ul>{orderContext.legs.map((leg) => <li key={leg}>{leg}</li>)}</ul>
                    )}
                  </div>
                )}

                <form onSubmit={handlePreviewOrder} className="order-ticket-form">
                  {/* Symbol and Instant Quote */}
                  <div className="form-group">
                    <FieldShell id="etrade-order-symbol" label={orderAssetClass === "options" ? "Underlying Symbol" : "Ticker Symbol"}>
                      <div className="symbol-input-row">
                        <TextInput
                          type="text"
                          className="ticker-input"
                          placeholder="e.g. NVDA, AAPL"
                          value={orderSymbol}
                          // Issue #3038: the symbol stays read-only only
                          // for a strategy ticket (a strategy set its
                          // underlying); a manual options ticket seeded
                          // from the Options order sub-menu has no
                          // strategy symbol yet, so the underlying is
                          // editable — and typing it keeps the seeded
                          // legs (context clears on equity only).
                          readOnly={orderAssetClass === "options" && !!orderContext?.symbol}
                          onChange={(e) => {
                            const s = e.target.value.toUpperCase();
                            setOrderSymbol(s);
                            if (orderAssetClass !== "options") setOrderContext(null);
                            setActiveDraft(null);
                            setLastExecutionResult(null);
                          }}
                          onBlur={() => fetchSymbolQuote(orderSymbol)}
                        />
                        <Button
                          className="btn-peek-quote"
                          variant="secondary"
                          size="sm"
                          disabled={quoteLoading}
                          onClick={() => fetchSymbolQuote(orderSymbol)}
                          title="Fetch live quote from E*TRADE"
                         loading={quoteLoading}>
                          {"🔍 Get Live Quote"}
                        </Button>
                      </div>
                    </FieldShell>
                    {!oauthStatus?.authenticated && (
                      <div className="order-auth-notice">
                        <span>🔒 Connect your E*TRADE account to fetch authenticated live market quotes.</span>
                        <Button type="button" variant="ghost" size="sm" onClick={handleStartOAuth}>
                          Connect E*TRADE →
                        </Button>
                      </div>
                    )}
                    {orderQuote && (
                      <div className="order-quote-peek">
                        <Flex justify="between" align="center">
                          <span className="quote-company">{orderQuote.companyName}</span>
                          {orderQuote.quoteStatus && (
                            <span className={`pill-badge ${orderQuote.quoteStatus === "REALTIME" ? "positive" : "neutral"}`}>
                              ● {orderQuote.quoteStatus}
                            </span>
                          )}
                        </Flex>
                        <span className="quote-price">${orderQuote.lastPrice.toFixed(2)}</span>
                        <span className={`quote-change ${orderQuote.change >= 0 ? "positive" : "negative"}`}>
                          {orderQuote.change >= 0 ? "+" : ""}{orderQuote.change.toFixed(2)} ({orderQuote.changePercent.toFixed(2)}%)
                        </span>
                        <span className="quote-bidask">Bid: ${orderQuote.bid.toFixed(2)} / Ask: ${orderQuote.ask.toFixed(2)}</span>
                        {orderQuote.source && (
                          <Badge tone="accent">✓ {orderQuote.source}</Badge>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Action Toggle (BUY / SELL) */}
                  {!orderContext?.optionLegs?.length && <div className="form-group">
                    <FieldShell id="etrade-order-action" label="Order Action">
                      <div className="action-toggle-grid">
                        <Button
                          type="button"
                          variant={orderAction === "BUY" ? "primary" : "secondary"} tone={orderAction === "BUY" ? "solid" : "subtle"}
                          onClick={() => {
                            setOrderAction("BUY");
                            setActiveDraft(null);
                            setLastExecutionResult(null);
                            if (orderQuote && orderType === "LIMIT") {
                              const askP = orderQuote.ask > 0 ? orderQuote.ask : orderQuote.lastPrice;
                              if (askP > 0) setOrderLimitPrice(askP.toFixed(2));
                            }
                          }}
                        >
                          BUY
                        </Button>
                        <Button
                          type="button"
                          variant={orderAction === "SELL" ? "danger" : "secondary"} tone={orderAction === "SELL" ? "solid" : "subtle"}
                          onClick={() => {
                            setOrderAction("SELL");
                            setActiveDraft(null);
                            setLastExecutionResult(null);
                            if (orderQuote && orderType === "LIMIT") {
                              const bidP = orderQuote.bid > 0 ? orderQuote.bid : orderQuote.lastPrice;
                              if (bidP > 0) setOrderLimitPrice(bidP.toFixed(2));
                            }
                          }}
                        >
                          SELL
                        </Button>
                        <Button
                          type="button"
                          variant={orderAction === "SELL_SHORT" ? "danger" : "secondary"} tone={orderAction === "SELL_SHORT" ? "solid" : "subtle"}
                          onClick={() => {
                            setOrderAction("SELL_SHORT");
                            setActiveDraft(null);
                            setLastExecutionResult(null);
                            if (orderQuote && orderType === "LIMIT") {
                              const bidP = orderQuote.bid > 0 ? orderQuote.bid : orderQuote.lastPrice;
                              if (bidP > 0) setOrderLimitPrice(bidP.toFixed(2));
                            }
                          }}
                        >
                          SHORT
                        </Button>
                        <Button
                          type="button"
                          variant={orderAction === "BUY_TO_COVER" ? "primary" : "secondary"} tone={orderAction === "BUY_TO_COVER" ? "solid" : "subtle"}
                          onClick={() => {
                            setOrderAction("BUY_TO_COVER");
                            setActiveDraft(null);
                            setLastExecutionResult(null);
                            if (orderQuote && orderType === "LIMIT") {
                              const askP = orderQuote.ask > 0 ? orderQuote.ask : orderQuote.lastPrice;
                              if (askP > 0) setOrderLimitPrice(askP.toFixed(2));
                            }
                          }}
                        >
                          COVER
                        </Button>
                      </div>
                    </FieldShell>
                  </div>}

                  {/* Order Type and Pricing */}
                  {orderAssetClass === "options" && (orderContext?.optionLegs?.filter((leg) => leg.securityType === "OPTN").length ?? 0) > 1 && (
                    <div className="options-net-order-control" role="group" aria-label="Net order direction">
                      <span>Net order</span>
                      <Button type="button" variant={(orderContext?.strategyNetDebit ?? 0) >= 0 ? "primary" : "secondary"} tone={(orderContext?.strategyNetDebit ?? 0) >= 0 ? "solid" : "subtle"} onClick={() => setOptionNetOrderDirection(false)}>Debit</Button>
                      <Button type="button" variant={(orderContext?.strategyNetDebit ?? 0) < 0 ? "primary" : "secondary"} tone={(orderContext?.strategyNetDebit ?? 0) < 0 ? "solid" : "subtle"} onClick={() => setOptionNetOrderDirection(true)}>Credit</Button>
                    </div>
                  )}
                  <div className="form-row-2">
                    <div className="form-group">
                      <Select label="Order Type"
                        value={orderType}
                        disabled={Boolean(orderContext?.optionLegs?.length)}
                        onChange={(e) => {
                          setOrderType(e.target.value as any);
                          setActiveDraft(null);
                          setLastExecutionResult(null);
                        }}
                      >
                        <option value="MARKET">Market</option>
                        <option value="LIMIT">Limit</option>
                        <option value="STOP">Stop</option>
                        <option value="STOP_LIMIT">Stop Limit</option>
                      </Select>
                    </div>

                    <div className="form-group">
                      <TextInput label={orderContext?.optionLegs?.length ? "Net Limit Price per Strategy Unit ($)" : orderType === "LIMIT" ? "Limit Price ($)" : "Stop Price ($)"}
                        type="number"
                        step="0.01"
                        disabled={orderType === "MARKET"}
                        placeholder={orderQuote?.lastPrice ? orderQuote.lastPrice.toFixed(2) : "125.50"}
                        value={orderLimitPrice}
                        onChange={(e) => {
                          setOrderLimitPrice(e.target.value);
                          setActiveDraft(null);
                          setLastExecutionResult(null);
                          setOrderError("");
                        }}
                      />
                    </div>
                  </div>

                  {/* Limit Price Sanity / Market Divergence Notice */}
                  {(() => {
                    const parsedLimit = parseFloat(orderLimitPrice);
                    if (orderType !== "LIMIT" || isNaN(parsedLimit) || parsedLimit <= 0 || !orderQuote) return null;
                    const askPrice = orderQuote.ask > 0 ? orderQuote.ask : orderQuote.lastPrice;
                    const bidPrice = orderQuote.bid > 0 ? orderQuote.bid : orderQuote.lastPrice;
                    if ((orderAction === "BUY" || orderAction === "BUY_TO_COVER") && askPrice > 0 && parsedLimit > askPrice * 1.05) {
                      return (
                        <Notice tone="warning">⚠️ <strong>Limit Price Alert:</strong> Proposed Buy Limit (${parsedLimit.toFixed(2)}) is &gt;5% above current ask (${askPrice.toFixed(2)}). As a buy limit, this order may execute immediately at prevailing market prices.</Notice>
                      );
                    }
                    if ((orderAction === "BUY" || orderAction === "BUY_TO_COVER") && askPrice > 0 && parsedLimit < askPrice * 0.7) {
                      return (
                        <Notice tone="danger">⚠️ <strong>Pricing Collar Alert:</strong> Proposed Buy Limit (${parsedLimit.toFixed(2)}) is {Math.round((1 - parsedLimit / askPrice) * 100)}% below current ask (${askPrice.toFixed(2)}). Broker collar rules may reject orders that diverge excessively from prevailing NBBO quotes.</Notice>
                      );
                    }
                    if ((orderAction === "SELL" || orderAction === "SELL_SHORT") && bidPrice > 0 && parsedLimit < bidPrice * 0.95) {
                      return (
                        <Notice tone="warning">⚠️ <strong>Limit Price Alert:</strong> Proposed Sell Limit (${parsedLimit.toFixed(2)}) is &gt;5% below current bid (${bidPrice.toFixed(2)}). As a sell limit, this order may execute immediately below prevailing value.</Notice>
                      );
                    }
                    if ((orderAction === "SELL" || orderAction === "SELL_SHORT") && bidPrice > 0 && parsedLimit > bidPrice * 1.3) {
                      return (
                        <Notice tone="danger">⚠️ <strong>Pricing Collar Alert:</strong> Proposed Sell Limit (${parsedLimit.toFixed(2)}) is {Math.round((parsedLimit / bidPrice - 1) * 100)}% above current bid (${bidPrice.toFixed(2)}). Broker collar rules may reject orders that diverge excessively from prevailing NBBO quotes.</Notice>
                      );
                    }
                    return null;
                  })()}

                  {/* Quantity and Quick Stepper */}
                  <div className="form-group">
                    <FieldShell id="etrade-order-quantity" label={orderContext?.optionLegs?.length ? "Strategy Units" : "Quantity (Shares)"}>
                      <div className="quantity-stepper-row">
                        <Button
                          className="qty-btn"
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setOrderQuantity(Math.max(1, orderQuantity - (orderContext?.optionLegs?.some((leg) => leg.securityType === "OPTN") ? 1 : 5)));
                            setActiveDraft(null);
                            setLastExecutionResult(null);
                          }}
                        >
                          {orderContext?.optionLegs?.some((leg) => leg.securityType === "OPTN") ? "−1" : "−5"}
                        </Button>
                        <TextInput
                          type="number"
                          min="1"
                          className="qty-input"
                          value={orderQuantity}
                          onChange={(e) => {
                            setOrderQuantity(Math.max(1, parseInt(e.target.value) || 1));
                            setActiveDraft(null);
                            setLastExecutionResult(null);
                          }}
                        />
                        <Button
                          className="qty-btn"
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setOrderQuantity(orderQuantity + (orderContext?.optionLegs?.some((leg) => leg.securityType === "OPTN") ? 1 : 5));
                            setActiveDraft(null);
                            setLastExecutionResult(null);
                          }}
                        >
                          {orderContext?.optionLegs?.some((leg) => leg.securityType === "OPTN") ? "+1" : "+5"}
                        </Button>
                      </div>
                    </FieldShell>
                    <div className="qty-preset-chips">
                      {(orderAssetClass === "options" ? [1, 2, 5, 10, 25] : [5, 10, 25, 50, 100]).map((q) => (
                        <Button
                          key={q}
                          size="sm"
                          variant={orderQuantity === q ? "primary" : "secondary"}
                          tone="subtle"
                          onClick={() => {
                            setOrderQuantity(q);
                            setActiveDraft(null);
                            setLastExecutionResult(null);
                          }}
                        >
                          {q} {orderContext?.optionLegs?.length ? "units" : "shs"}
                        </Button>
                      ))}
                    </div>
                  </div>

                  {/* Pricing Summary */}
                  <div className="order-calc-card">
                    <div className="calc-row">
                      <span>{orderContext?.optionLegs?.length ? `Net ${orderContext.strategyNetDebit !== undefined && orderContext.strategyNetDebit < 0 ? "Credit" : "Debit"} per strategy unit` : "Estimated Price per Share:"}</span>
                      <span>${orderType === "LIMIT" ? parseFloat(orderLimitPrice || "0").toFixed(2) : (orderQuote?.lastPrice || 0).toFixed(2)}</span>
                    </div>
                    <div className="calc-row">
                      <span>Online Commission:</span>
                      <span className="zero-comm">{orderContext?.optionLegs?.length ? (activeDraft ? `$${activeDraft.estimatedCommission.toFixed(2)} broker estimate` : "Broker estimate in preview") : "$0.00 USD"}</span>
                    </div>
                    <div className="calc-row total">
                      <span>Estimated {orderContext?.optionLegs?.length && (orderContext.strategyNetDebit ?? 0) < 0 ? "Credit" : "Total Order Value"}:</span>
                      <span className="calc-total-val">
                        ${(
                          orderQuantity *
                          (orderType === "LIMIT" ? parseFloat(orderLimitPrice || "0") : orderQuote?.lastPrice || 0) *
                          (orderAssetClass === "options"
                            ? 100
                            : orderContext?.optionLegs?.reduce((total, leg) => total + leg.quantity, 0) || 1)
                        ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                  </div>

                  {/* Submit Preview and Pre-Trade Risk Analysis Buttons */}
                  <Flex gap="2">
                    <Button
                      type="submit"
                      className="btn-submit-preview"
                      variant="primary"
                      disabled={previewLoading || !orderSymbol.trim()}
                      title="Generate cryptographic order preview with Trading Agent DID"
                      aria-label={orderAssetClass === "options" ? "Preview Options Order" : "Preview Equity Order"}
                    >
                      {previewLoading ? (
                        "Creating Cryptographic Preview…"
                      ) : (
                        <>
                          📋 
                          {orderAssetClass === "options" ? "Preview Options Order" : "Preview Equity Order"}
                        </>
                      )}
                    </Button>
                    <Button variant="primary"
                      type="button"
                      size="lg"
                      disabled={!orderSymbol.trim()}
                      onClick={() => {
                        const estPrice = orderType === "LIMIT" ? parseFloat(orderLimitPrice || "0") : (orderQuote?.lastPrice || 100);
                        const totalVal = orderQuantity * estPrice;
                        setRiskSubject({
                          title: orderAssetClass === "options"
                            ? `${orderContext?.label || "Options strategy"} · ${orderQuantity} unit(s)`
                            : `${orderAction} ${orderQuantity}x ${orderSymbol.toUpperCase()} (${orderType})`,
                          underlyingSymbol: orderSymbol.toUpperCase(),
                          underlyingPrice: estPrice,
                          strategyType: orderAssetClass === "options" ? orderContext?.label || "Options Order Ticket" : `${orderAction} Order Ticket`,
                          sentiment: orderAction.includes("BUY") ? "bullish" : "bearish",
                          quantity: orderQuantity,
                          positionType: orderAssetClass === "options" ? "MULTI_LEG" : "EQUITY",
                          maxLoss: orderAssetClass === "options" ? undefined : totalVal,
                          netDebit: orderAssetClass === "options" ? orderContext?.strategyNetDebit : undefined,
                          legsText: orderContext?.legs.join(" / "),
                          legs: orderContext?.optionLegs?.map((leg) => ({
                            side: leg.side,
                            quantity: leg.quantity * orderQuantity,
                            optionType: leg.optionType,
                            strike: leg.strike,
                            expirationDate: leg.expirationDate,
                          })),
                          breakevens: [estPrice],
                          breakevenText: `Execution/Limit: $${estPrice.toFixed(2)}`,
                        });
                      }}
                      title="Risk Analysis — Run pre-trade institutional risk analysis"
                      aria-label="Risk Analysis"
                    >
                      <span className="risk-shield-icon" aria-hidden="true">🛡️</span>
                      <span>Risk Analysis</span>
                    </Button>
                  </Flex>
                </form>
              </div>

              {/* Right: Security & Architecture Specs */}
              <div className="order-side-info">
                <div className="info-card">
                  <h5>🛡️ Agentic HITL Safety Guarantee</h5>
                  <p>
                    Every trade initiated by the Multi-Agent System is saved to the institutional ledger in <code>previewed</code> status.
                    No funds are moved, and no order is routed to E*TRADE until you review the order details and click <strong>Approve &amp; Submit</strong>.
                  </p>
                  <div className="safety-bullets">
                    <div className="bullet-item">
                      <span className="bullet-icon">🔒</span>
                      <div>
                        <strong>Cryptographic DID Attestation:</strong> All orders are stamped with Trading Agent DID (<code>did:agent:openaimp:trading</code>) and reviewer user DID.
                      </div>
                    </div>
                    <div className="bullet-item">
                      <span className="bullet-icon">⚖️</span>
                      <div>
                        <strong>GoF &amp; SOLID Enforcement:</strong> Executes via the Command &amp; Strategy pattern with protected variations over live OAuth and simulated endpoints.
                      </div>
                    </div>
                    <div className="bullet-item">
                      <span className="bullet-icon">⚡</span>
                      <div>
                        <strong>Instant Broker Cancellation:</strong> You can reject or cancel draft orders with one click at any time before execution.
                      </div>
                    </div>
                  </div>
                </div>

                {/* Sample Quick Action Box */}
                <div className="info-card">
                  <h5>💬 NLQ Voice &amp; Text Prompts</h5>
                  <p>You can also place trades effortlessly through conversational natural language:</p>
                  <div className="nlq-example-links">
                    <Button
                      className="example-link"
                      variant="ghost"
                      size="sm"
                      onClick={() => sendNlqToChat("Preview buy 10 shares of NVDA limit 125.50")}
                    >
                      👉 "Preview buy 10 shares of NVDA limit 125.50"
                    </Button>
                    <Button
                      className="example-link"
                      variant="ghost"
                      size="sm"
                      onClick={() => sendNlqToChat("Screen oversold tech stocks")}
                    >
                      👉 "Screen oversold tech stocks"
                    </Button>
                    <Button
                      className="example-link"
                      variant="ghost"
                      size="sm"
                      onClick={() => sendNlqToChat("Show my portfolio positions")}
                    >
                      👉 "Show my portfolio positions"
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </TabPanel>
        <TradingApprovalsQueue />
      </Stack>
    </PageShell>
  );
}
