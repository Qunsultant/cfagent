import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  FieldShell,
  Flex,
  Grid,
  Notice,
  PageSection,
  PageShell,
  Select,
  Stack,
  SummaryCard,
  TabPanel,
  Tabs,
  TextInput,
} from "./components/ui";
import { TradingApprovalsQueue } from "./TradingApprovalsQueue";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import type { ETradeOrderDraft, ETradeQuote } from "../types";
import type { TradeAssetClass, TradeOrderContext } from "./trading/tradeOrderContext";
import type {
  RiskLeg,
  RiskSubject,
} from "./options/riskManagementEngine";
import { RiskAnalysisPanel } from "./RiskAnalysisPanel";
import { PageChromeContext } from "./components/ui/PageShell";
import { STRATEGY_LIBRARY } from "./options/strategyLibrary";
import { buildTradeLegs, describeTradeLeg } from "./trading/strategyAutobuild";
import { brokerModeBadge, brokerPresentation } from "../trading";
import { AlpacaSignInCard } from "./AlpacaSignInCard";
import { safeNumberFormat, safePriceFormat } from "./formatters";

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

export type OrderTicketTab = "stock" | "options" | "risk";

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
  /**
   * Issue #3669: the broker-neutral connection model. The panel used to
   * receive only the E*TRADE OAuth object, so a tenant on any other
   * broker was permanently told to "Connect your E*TRADE account" — the
   * panel had no broker, no mode, and no other connect flow to show.
   * `brokerConnected` is derived by the hub from the selected broker's
   * own connect surface; `onConnectBroker` starts the selected broker's
   * connect flow (E*TRADE OAuth — the only broker whose connect flow is
   * a button; Alpaca renders its sign-in card inline instead).
   */
  brokerId: string;
  tradingType: "paper" | "live";
  brokerConnected: boolean;
  /** The environment the Alpaca sign-in card verifies against. */
  activeEnv?: string;
  onConnectBroker: (override?: unknown) => Promise<void>;
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
  setOptionLegs: (
    legs: NonNullable<TradeOrderContext["optionLegs"]>,
    label: string,
    legsText: string[],
  ) => void;
  setOptionNetOrderDirection: (credit: boolean) => void;
  handlePreviewOrder: (e: React.FormEvent) => Promise<void>;
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
    brokerId,
    tradingType,
    brokerConnected,
    activeEnv,
    onConnectBroker,
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
    setOptionLegs,
    setOptionNetOrderDirection,
    handlePreviewOrder,
    sendNlqToChat,
    setRiskSubject,
    seedManualOptions,
  } = ticket;

  // Issue #3669: the panel names the SELECTED broker, from the one
  // presentation module — never a hard-coded firm. An unrecognised id
  // is named as a selection, never silently as E*TRADE.
  const presentation = brokerPresentation(brokerId);
  const brokerLabel = presentation.label;

  const applyTab = (tab: OrderTicketTab) => {
    // The Risk tab analyzes the ticket; it never changes the ticket's
    // asset class. Leaving Risk for an asset tab applies that tab below.
    if (tab === "risk") return;
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
      value === "stock" || value === "options" || value === "risk",
    defaultTab: "stock",
    onTabChange: applyTab,
  });

  // The post-mount effect below reads the live tab, not the render that
  // scheduled it: a seed landing while the Risk tab is open must refresh
  // the risk seed, never yank the user off Risk onto an asset tab.
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // Mount: the URL tab and the ticket can disagree two ways, and each
  // direction wins in exactly one case. An explicit ?orderTab= in the URL
  // is the user's intent (deep link, reload, back/forward) — apply it.
  // With no param, a surviving ticket wins (the Fast Order Ticket entry
  // never touches the ticket, so a strategy ticket from another tab must
  // still show its own tab when the page reopens).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const urlTab = new URLSearchParams(window.location.search).get("orderTab");
    if (urlTab === "risk") {
      // The Risk tab is not an asset class: show it, touch nothing.
      return;
    }
    if (urlTab === "stock" || urlTab === "options") {
      const assetTab: OrderTicketTab =
        orderAssetClass === "options" ? "options" : "stock";
      if (urlTab !== assetTab) applyTab(urlTab);
    } else {
      const assetTab: OrderTicketTab =
        orderAssetClass === "options" ? "options" : "stock";
      if (assetTab !== activeTab) handleTabChange(assetTab);
    }
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
    // A seed landing while Risk is open refreshes the risk seed (via
    // riskSeedKey below); it must not move the selected tab.
    if (activeTabRef.current === "risk") return;
    const assetTab: OrderTicketTab =
      orderAssetClass === "options" ? "options" : "stock";
    if (assetTab !== activeTab) handleTabChange(assetTab);
  }, [orderAssetClass]);

  // Risk seed (#3125): the ticket as a RiskSubject. An equity ticket
  // seeds Long Equity sized to the ticket; an options ticket seeds its
  // legs as a multi-leg subject (ticket legs carry no IV, so the engine
  // excludes them from Greek sums and the tab discloses the gap). No
  // symbol, or an options ticket with no struck leg, seeds nothing and
  // the tab shows the manual analyze form instead.
  const riskSeed: RiskSubject | null = useMemo(() => {
    const cleanSymbol = orderSymbol.trim().toUpperCase();
    if (!cleanSymbol) return null;
    const spot =
      orderContext?.underlyingPrice ??
      orderQuote?.lastPrice ??
      orderQuote?.price ??
      undefined;
    if (orderAssetClass === "options") {
      const validLegs = orderLegs.filter(
        (l) => l.securityType === "EQ" || (l.strike != null && l.strike > 0),
      );
      if (validLegs.length === 0) return null;
      const legs: RiskLeg[] = validLegs.map((l) => ({
        side: l.side,
        optionType: l.securityType === "EQ" ? "STOCK" : l.optionType,
        strike: l.strike,
        expirationDate: l.expirationDate,
        quantity: l.quantity,
      }));
      const singleOptn =
        validLegs.length === 1 && validLegs[0].securityType === "OPTN";
      return {
        title: `${cleanSymbol} — Ticket strategy`,
        underlyingSymbol: cleanSymbol,
        underlyingPrice: spot,
        strategyType: "Ticket strategy",
        sentiment: "directional",
        quantity: validLegs.reduce((sum, l) => sum + (l.quantity ?? 1), 0),
        positionType: singleOptn ? "OPTION" : "MULTI_LEG",
        legs,
      };
    }
    return {
      title: `${cleanSymbol} — Long Equity`,
      underlyingSymbol: cleanSymbol,
      underlyingPrice: spot,
      strategyType: "Long Equity",
      sentiment: "bullish",
      quantity: Math.max(1, orderQuantity || 1),
      positionType: "EQUITY",
    };
  }, [
    orderSymbol,
    orderAssetClass,
    orderLegs,
    orderContext,
    orderQuote,
    orderQuantity,
  ]);
  const riskSeedKey = useMemo(
    () =>
      `${orderSymbol}|${orderAssetClass}|${orderLegs
        .map((l) =>
          [l.side, l.securityType, l.optionType, l.strike, l.expirationDate, l.quantity].join(":"),
        )
        .join(";")}|${orderQuantity}`,
    [orderSymbol, orderAssetClass, orderLegs, orderQuantity],
  );

  // Strategy auto-build (#3090): a strategy Select + one expiration
  // picker that REPLACES the ticket's legs with the built structure
  // (the editor stays available for per-leg tweaks after the build).
  // The picker defaults to the legs' shared expiration when they all
  // agree, otherwise it starts empty and the build refuses until a
  // date is picked. Spot comes from the live ticket quote, falling
  // back to the context's underlying price; with neither, the build
  // refuses exactly as discovery does.
  const todayLocalIso = () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  };
  const [buildExpiry, setBuildExpiry] = useState(() => {
    const expiries = new Set(
      orderLegs
        .filter((l) => l.securityType === "OPTN" && l.expirationDate)
        .map((l) => l.expirationDate as string),
    );
    return expiries.size === 1 ? [...expiries][0] : "";
  });
  const [strategyChoice, setStrategyChoice] = useState("");
  const [builderNotice, setBuilderNotice] = useState("");
  const strategyCategories = useMemo(
    () => Array.from(new Set(STRATEGY_LIBRARY.map((d) => d.category))),
    [],
  );
  const handleBuildStrategy = (strategyId: string) => {
    setStrategyChoice(strategyId);
    if (!strategyId) {
      setBuilderNotice("");
      return;
    }
    const definition = STRATEGY_LIBRARY.find((d) => d.id === strategyId);
    if (!definition) return;
    const spot = orderQuote?.lastPrice ?? orderContext?.underlyingPrice;
    if (!spot || spot <= 0) {
      setBuilderNotice("Quote unavailable — load a live quote before choosing a strategy.");
      return;
    }
    if (!buildExpiry) {
      setBuilderNotice("Pick an expiration date first.");
      return;
    }
    if (buildExpiry < todayLocalIso()) {
      setBuilderNotice("Expiration must be today or later.");
      return;
    }
    const { legs } = buildTradeLegs(definition, spot, buildExpiry);
    setOptionLegs(legs, `Built strategy: ${definition.name}`, legs.map(describeTradeLeg));
    setBuilderNotice("");
    setStrategyChoice("");
  };

  return (
    <PageShell title="Order Ticket">
      <Tabs
        idBase="order-ticket"
        ariaLabel="Order type"
        tabs={[
          { id: "stock", label: "Stock order" },
          { id: "options", label: "Options order" },
          { id: "risk", label: "Risk analysis" },
        ]}
        value={activeTab}
        onChange={(tab) => handleTabChange(tab)}
      />
      <Stack gap="4">
        <TabPanel
          idBase="order-ticket"
          tabId={orderAssetClass === "options" ? "options" : "stock"}
          active={activeTab !== "risk"}
          retain
        >
          <PageSection>
            <Grid columns={2} gap="2">
              {/* Left: Interactive Order Ticket Form */}
              <Card padding="md">
                <Stack gap="2">
                {/* Issue #3669: broker + mode badges, as the portfolio
                    branch has — the ticket used to show neither, so a
                    tenant could not tell which broker or mode an order
                    would use. The mode comes from the TEST/PROD
                    selection the hub passes in, not from a broker
                    status read (see hub orderTradingType). */}
                <CardHeader
                  title={`⚡ ${orderAssetClass === "options" ? "Options Order Ticket" : "Equity / ETF Order Ticket"}`}
                  subtitle={
                    orderAssetClass === "options"
                      ? "Broker-priced options strategy preview with human approval required"
                      : orderContext?.optionLegs?.length
                        ? "Stock strategy preview with human approval required"
                        : "Zero-commission equity trading with agentic DID stamping"
                  }
                  belowSubtitle={
                    <Flex gap="2" wrap>
                      <Badge tone="accent" title={`Broker: ${brokerId}`}>{brokerLabel}</Badge>
                      <Badge tone={tradingType === "live" ? "warning" : "success"}>{brokerModeBadge(brokerId, tradingType)}</Badge>
                    </Flex>
                  }
                  meta={
                    orderSymbol ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => fetchSymbolQuote(orderSymbol)}
                        disabled={quoteLoading}
                        title={`Refresh live quote for ${orderSymbol}`}
                       loading={quoteLoading}>
                        <span>↻</span>
                        <span>{"Refresh Quote"}</span>
                      </Button>
                    ) : undefined
                  }
                />

                {orderError && (orderAssetClass === "options" ? (
                  <Notice tone="danger" title="Options preview failed. No order was created or submitted.">
                    <span>{/unapproved options position|options approval levels/i.test(orderError)
                      ? `${brokerLabel} says this strategy is not approved for the account, or conflicts with current positions or open orders. Review the account’s options approval and open orders with ${brokerLabel}.`
                      : "Review the contract details and correct the issue before requesting another broker preview."}</span>
                    <details>
                      <summary>Broker response</summary>
                      <p>{orderError}</p>
                    </details>
                  </Notice>
                ) : <Notice tone="danger">⚠️ {orderError}</Notice>)}
                {orderContext && (
                  <Stack gap="2">
                    <CardHeader
                      title={orderContext.assetClass === "options" ? "Options strategy" : "From Strategy Research"}
                      subtitle={orderContext.label}
                    />
                    {orderAssetClass === "options" && orderContext.assetClass === "options" ? (
                      <Card padding="sm">
                        <Stack gap="2">
                        <CardHeader
                          title="Build your order"
                          subtitle={`Review and edit every contract before requesting ${brokerLabel}’s preview.`}
                          meta={
                            <Button type="button" variant="secondary" size="sm" onClick={addOptionLeg} disabled={orderLegs.length >= 4 || orderLegs.some((leg) => leg.securityType === "EQ")}>
                              + Add leg
                            </Button>
                          }
                        />
                        <Flex gap="2" wrap align="end">
                          <Select
                            label="Build from strategy"
                            hint="Replaces the legs below with the strategy's structure."
                            aria-label="Build from strategy"
                            value={strategyChoice}
                            onChange={(event) => handleBuildStrategy(event.target.value)}
                          >
                            <option value="">Choose a strategy…</option>
                            {strategyCategories.map((category) => (
                              <optgroup key={category} label={category}>
                                {STRATEGY_LIBRARY.filter((d) => d.category === category).map((d) => (
                                  <option key={d.id} value={d.id}>{d.name}</option>
                                ))}
                              </optgroup>
                            ))}
                          </Select>
                          <TextInput
                            label="Expiration"
                            aria-label="Build expiration"
                            type="date"
                            min={todayLocalIso()}
                            value={buildExpiry}
                            onChange={(event) => {
                              setBuildExpiry(event.target.value);
                              setBuilderNotice("");
                            }}
                          />
                        </Flex>
                        {builderNotice && <Notice tone="warning">{builderNotice}</Notice>}
                        {orderLegs.map((leg, index) => (
                          <Card padding="sm" key={`option-leg-${index}`}>
                            <Stack gap="2">
                            <Flex gap="1" align="center" wrap>
                              <strong>Leg {index + 1}</strong>
                              <Badge tone="neutral" size="xs">{leg.securityType === "OPTN" ? "OPTION" : "STOCK"}</Badge>
                            </Flex>
                            <Flex gap="2" wrap align="end">
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
                            <Button type="button" variant="danger" tone="subtle" size="sm" onClick={() => removeOptionLeg(index)} aria-label={`Remove leg ${index + 1}`} disabled={(orderContext.optionLegs?.length ?? 0) <= 1}>Remove</Button>
                            </Flex>
                            </Stack>
                          </Card>
                        ))}
                        <p className="ui-footnote">1. Edit the contracts and net limit. 2. Request {brokerLabel}’s preview. 3. Review and approve only if the broker accepts it. Nothing is submitted before your approval; {brokerLabel} still validates account approval, buying power, and existing positions.</p>
                        </Stack>
                      </Card>
                    ) : (
                      <ul>{orderContext.legs.map((leg) => <li key={leg}>{leg}</li>)}</ul>
                    )}
                  </Stack>
                )}

                <form onSubmit={handlePreviewOrder}>
                  <Stack gap="2">
                  {/* Symbol and Instant Quote */}
                  <Stack gap="2">
                    <FieldShell id="etrade-order-symbol" label={orderAssetClass === "options" ? "Underlying Symbol" : "Ticker Symbol"}>
                      <Flex gap="1" align="center">
                        <TextInput
                          type="text"
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
                          variant="secondary"
                          size="sm"
                          disabled={quoteLoading}
                          onClick={() => fetchSymbolQuote(orderSymbol)}
                          title={`Fetch live quote from ${brokerLabel}`}
                         loading={quoteLoading}>
                          {"🔍 Get Live Quote"}
                        </Button>
                      </Flex>
                    </FieldShell>
                    {/* Issue #3669: the connect notice follows the SELECTED
                        broker. It used to read E*TRADE's OAuth status for
                        every tenant, so an Alpaca tenant — who can never
                        complete E*TRADE OAuth — saw "Connect your E*TRADE
                        account" permanently. E*TRADE keeps its OAuth
                        button; Alpaca gets its sign-in card inline; any
                        other broker names itself with no invented flow. */}
                    {!brokerConnected && brokerId === "etrade" && (
                      <Notice tone="info">
                        <span>🔒 Connect your E*TRADE account to fetch authenticated live market quotes.</span>{" "}
                        <Button type="button" variant="ghost" size="sm" onClick={onConnectBroker}>
                          Connect E*TRADE →
                        </Button>
                      </Notice>
                    )}
                    {!brokerConnected && brokerId === "alpaca" && (
                      <>
                        <Notice tone="info">
                          <span>🔒 Connect your Alpaca account to fetch authenticated live market quotes.</span>
                        </Notice>
                        <AlpacaSignInCard activeEnv={activeEnv} collapsedWhenConfigured={false} />
                      </>
                    )}
                    {!brokerConnected && brokerId !== "etrade" && brokerId !== "alpaca" && (
                      <Notice tone="info">
                        <span>🔒 Connect your {brokerLabel} account to fetch authenticated live market quotes.</span>
                      </Notice>
                    )}
                    {orderQuote && (
                      <Card padding="sm">
                        <Flex gap="2" align="center" wrap>
                          <strong>{orderQuote.companyName}</strong>
                          {orderQuote.quoteStatus && (
                            <Badge tone={orderQuote.quoteStatus === "REALTIME" ? "success" : "neutral"} size="sm" dot>
                              ● {orderQuote.quoteStatus}
                            </Badge>
                          )}
                          <strong>{safePriceFormat(orderQuote.lastPrice)}</strong>
                          {orderQuote.change !== undefined && orderQuote.change !== null ? (
                            <Badge tone={Number(orderQuote.change) >= 0 ? "success" : "danger"} size="sm">
                              {Number(orderQuote.change) >= 0 ? "+" : ""}{safeNumberFormat(orderQuote.change)} ({safeNumberFormat(orderQuote.changePercent)}%)
                            </Badge>
                          ) : (
                            <span className="ui-meta">—</span>
                          )}
                          <span className="ui-meta">Bid: {safePriceFormat(orderQuote.bid)} / Ask: {safePriceFormat(orderQuote.ask)}</span>
                          {orderQuote.source && (
                            <Badge tone="accent">✓ {orderQuote.source}</Badge>
                          )}
                        </Flex>
                      </Card>
                    )}
                  </Stack>

                  {/* Action Toggle (BUY / SELL) */}
                  {!orderContext?.optionLegs?.length && <Stack gap="2">
                    <FieldShell id="etrade-order-action" label="Order Action">
                      <Grid columns={4} gap="1">
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
                      </Grid>
                    </FieldShell>
                  </Stack>}

                  {/* Order Type and Pricing */}
                  {orderAssetClass === "options" && (orderContext?.optionLegs?.filter((leg) => leg.securityType === "OPTN").length ?? 0) > 1 && (
                    <Flex gap="2" align="center" role="group" aria-label="Net order direction">
                      <span>Net order</span>
                      <Button type="button" variant={(orderContext?.strategyNetDebit ?? 0) >= 0 ? "primary" : "secondary"} tone={(orderContext?.strategyNetDebit ?? 0) >= 0 ? "solid" : "subtle"} onClick={() => setOptionNetOrderDirection(false)}>Debit</Button>
                      <Button type="button" variant={(orderContext?.strategyNetDebit ?? 0) < 0 ? "primary" : "secondary"} tone={(orderContext?.strategyNetDebit ?? 0) < 0 ? "solid" : "subtle"} onClick={() => setOptionNetOrderDirection(true)}>Credit</Button>
                    </Flex>
                  )}
                  <Grid columns={2} gap="2">
                    <Stack gap="1">
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
                    </Stack>

                    <Stack gap="1">
                      <TextInput label={orderContext?.optionLegs?.length ? "Net Limit Price per Strategy Unit ($)" : orderType === "LIMIT" ? "Limit Price ($)" : "Stop Price ($)"}
                        type="number"
                        step="0.01"
                        disabled={orderType === "MARKET"}
                        placeholder={orderQuote?.lastPrice != null ? safeNumberFormat(orderQuote.lastPrice, 2, "125.50") : "125.50"}
                        value={orderLimitPrice}
                        onChange={(e) => {
                          setOrderLimitPrice(e.target.value);
                          setActiveDraft(null);
                          setLastExecutionResult(null);
                          setOrderError("");
                        }}
                      />
                    </Stack>
                  </Grid>

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
                  <Stack gap="2">
                    <FieldShell id="etrade-order-quantity" label={orderContext?.optionLegs?.length ? "Strategy Units" : "Quantity (Shares)"}>
                      <Flex gap="1" align="center">
                        <Button
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
                          value={orderQuantity}
                          onChange={(e) => {
                            setOrderQuantity(Math.max(1, parseInt(e.target.value) || 1));
                            setActiveDraft(null);
                            setLastExecutionResult(null);
                          }}
                        />
                        <Button
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
                      </Flex>
                    </FieldShell>
                    <Flex gap="1" wrap>
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
                    </Flex>
                  </Stack>

                  {/* Pricing Summary */}
                  <SummaryCard
                    rows={[
                      {
                        label: orderContext?.optionLegs?.length ? `Net ${orderContext.strategyNetDebit !== undefined && orderContext.strategyNetDebit < 0 ? "Credit" : "Debit"} per strategy unit` : "Estimated Price per Share:",
                        value: orderType === "LIMIT" ? safePriceFormat(orderLimitPrice, 2, "$0.00") : safePriceFormat(orderQuote?.lastPrice, 2, "$0.00"),
                      },
                      {
                        label: "Online Commission:",
                        value: orderContext?.optionLegs?.length ? (activeDraft ? `${safePriceFormat(activeDraft.estimatedCommission, 2, "$0.00")} broker estimate` : "Broker estimate in preview") : "$0.00 USD",
                      },
                    ]}
                    total={{
                      label: `Estimated ${orderContext?.optionLegs?.length && (orderContext.strategyNetDebit ?? 0) < 0 ? "Credit" : "Total Order Value"}:`,
                      value: `$${(
                        orderQuantity *
                        (orderType === "LIMIT" ? parseFloat(orderLimitPrice || "0") : orderQuote?.lastPrice || 0) *
                        (orderAssetClass === "options"
                          ? 100
                          : orderContext?.optionLegs?.reduce((total, leg) => total + leg.quantity, 0) || 1)
                      ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    }}
                  />

                  {/* Submit Preview and Pre-Trade Risk Analysis Buttons */}
                  <Flex gap="2">
                    <Button
                      type="submit"
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
                          breakevenText: `Execution/Limit: ${safePriceFormat(estPrice)}`,
                        });
                      }}
                      title="Risk Analysis — Run pre-trade institutional risk analysis"
                      aria-label="Risk Analysis"
                    >
                      <span aria-hidden="true">🛡️</span>
                      <span>Risk Analysis</span>
                    </Button>
                  </Flex>
                  </Stack>
                </form>
              </Stack></Card>

              {/* Right: Security & Architecture Specs */}
              <Stack gap="2">
                <Card padding="md">
                  <Stack gap="2">
                  <h5>🛡️ Agentic HITL Safety Guarantee</h5>
                  <p>
                    Every trade initiated by the Multi-Agent System is saved to the institutional ledger in <code>previewed</code> status.
                    No funds are moved, and no order is routed to {brokerLabel} until you review the order details and click <strong>Approve &amp; Submit</strong>.
                  </p>
                  <Stack gap="2">
                    <Flex gap="2" align="start">
                      <span>🔒</span>
                      <div>
                        <strong>Cryptographic DID Attestation:</strong> All orders are stamped with Trading Agent DID (<code>did:agent:openaimp:trading</code>) and reviewer user DID.
                      </div>
                    </Flex>
                    <Flex gap="2" align="start">
                      <span>⚖️</span>
                      <div>
                        <strong>GoF &amp; SOLID Enforcement:</strong> Executes via the Command &amp; Strategy pattern with protected variations over live OAuth and simulated endpoints.
                      </div>
                    </Flex>
                    <Flex gap="2" align="start">
                      <span>⚡</span>
                      <div>
                        <strong>Instant Broker Cancellation:</strong> You can reject or cancel draft orders with one click at any time before execution.
                      </div>
                    </Flex>
                  </Stack>
                  </Stack>
                </Card>

                {/* Sample Quick Action Box */}
                <Card padding="md">
                  <Stack gap="2">
                  <h5>💬 NLQ Voice &amp; Text Prompts</h5>
                  <p>You can also place trades effortlessly through conversational natural language:</p>
                  <Stack gap="1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => sendNlqToChat("Preview buy 10 shares of NVDA limit 125.50")}
                    >
                      👉 "Preview buy 10 shares of NVDA limit 125.50"
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => sendNlqToChat("Screen oversold tech stocks")}
                    >
                      👉 "Screen oversold tech stocks"
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => sendNlqToChat("Show my portfolio positions")}
                    >
                      👉 "Show my portfolio positions"
                    </Button>
                  </Stack>
                  </Stack>
                </Card>
              </Stack>
            </Grid>
          </PageSection>
        </TabPanel>
        <TabPanel
          idBase="order-ticket"
          tabId="risk"
          active={activeTab === "risk"}
          retain
        >
          {/*
            Composition without component changes (#3125): the Risk tab
            renders the SAME RiskAnalysisPanel the standalone route
            renders. The tab host applies chrome via context, so the
            panel's PageShell collapses to content only here and renders
            fully on its own route — the panel itself is never edited
            for the host it lands in.
          */}
          <PageChromeContext.Provider value="tab">
            <RiskAnalysisPanel
              seededSubject={riskSeed}
              seedKey={riskSeedKey}
              onSendPrompt={(prompt) => sendNlqToChat(prompt)}
            />
          </PageChromeContext.Provider>
        </TabPanel>
        <TradingApprovalsQueue />
      </Stack>
    </PageShell>
  );
}
