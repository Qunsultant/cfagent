import React, { useState, useMemo, useEffect } from "react";
import { useUrlSyncedTabs } from "../../useUrlSyncedTabs";
import { useBrokerEnvironment } from "../../brokerEnvironment";
import { usePolling } from "../../usePolling";
import { useAutoRefresh } from "../../autoRefresh";
import { getPollingConfig } from "../../pollingConfig";
import { Button, Table, PageShell, type TableColumn } from "../../components/ui";
import "./optionsFlows.css";
import {
  LiveFlowItem,
  NewsFlowItem,
  InsiderFlowItem,
  CongressFlowItem,
  FlowSummary,
  FlowFilterConfig,
  SavedFilterPreset,
} from "../../../trading";
import {
  DEFAULT_SAVED_PRESETS,
  DEFAULT_FILTER_CONFIG,
  filterLiveFlowItems,
  filterNewsFlowItems,
  filterInsiderFlowItems,
  filterCongressFlowItems,
  calculateFlowSummary,
  formatFlowDateTime,
  summarizeFlowProvenance,
  FLOW_PROVENANCE_LABELS,
  FLOW_PROVENANCE_NOTICE,
} from "../../../trading";
import { newsSentimentPresentation } from "./newsSentimentDisplay";
import { FlowFiltersSidebar } from "./FlowFiltersSidebar";
import { FlowSummaryDualBars } from "./FlowSummaryDualBars";
import { FlowTradeDetailModal } from "./FlowTradeDetailModal";
import { StrategyDiscoveryPanel } from "../StrategyDiscoveryPanel";
import { RiskAnalysisModal } from "../RiskAnalysisModal";
import type { RiskSubject } from "../riskManagementEngine";
import { CapabilityNavBar, CopilotTriggerButton } from "../../components/CapabilityNavBar";

export type FlowSubTab = "summary" | "live" | "historical" | "news" | "congress" | "insider";

export function isValidFlowSubTab(tab: unknown): tab is FlowSubTab {
  return (
    typeof tab === "string" &&
    (["summary", "live", "historical", "news", "congress", "insider"] as readonly string[]).includes(
      tab,
    )
  );
}

interface OptionsFlowsHubProps {
  user?: { name: string; login: string };
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  onTradeSymbol?: (symbol: string) => void;
}

function flowTradeToRiskSubject(trade: LiveFlowItem): RiskSubject {
  const isPut = trade.strategy.toLowerCase().includes("put");
  const isCredit = trade.isCredit ?? (trade.side === "SELL" || trade.strategy.toLowerCase().includes("credit"));
  const strike = typeof trade.strike === "number" ? trade.strike : trade.underlyingPrice;
  const fill = trade.fillPrice || 1.5;
  return {
    title: trade.strategyTitle || `${trade.symbol} ${trade.strategy}`,
    underlyingSymbol: trade.symbol,
    underlyingPrice: trade.currentSpot || trade.underlyingPrice,
    strategyType: trade.strategy,
    sentiment: trade.sentiment,
    expirationDate: trade.expiration,
    dte: trade.dte,
    quantity: trade.totalQuantity || trade.volume || 10,
    netDebit: isCredit ? -fill : fill,
    maxProfit: isCredit ? fill * 100 : null,
    maxLoss: isCredit ? null : fill * 100,
    chanceOfProfit: trade.chance || (isCredit ? 65 : 45),
    breakevens: [isPut ? Number((strike - fill).toFixed(2)) : Number((strike + fill).toFixed(2))],
    breakevenText: trade.calculationText,
    legs: (trade.legsDetails || []).map((l) => ({
      side: l.action.toUpperCase().includes("BUY") ? "BUY" : "SELL",
      optionType: l.optionType,
      strike: l.strike,
      quantity: l.quantity,
    })),
  };
}

export function OptionsFlowsHub({
  user,
  onSendPrompt,
  onTradeSymbol,
}: OptionsFlowsHubProps) {
  // Issue #2482: this tab renders outside the hub, so it reads the
  // single environment value directly instead of inheriting the
  // StrategyDiscoveryPanel TEST prop default.
  const brokerEnv = useBrokerEnvironment();
  const [filterConfig, setFilterConfig] = useState<FlowFilterConfig>(DEFAULT_FILTER_CONFIG);
  const [activePreset, setActivePreset] = useState<SavedFilterPreset | null>(DEFAULT_SAVED_PRESETS[0]);
  const [savedPresets, setSavedPresets] = useState<SavedFilterPreset[]>(DEFAULT_SAVED_PRESETS);
  const [selectedDetailTrade, setSelectedDetailTrade] = useState<LiveFlowItem | null>(null);
  const [activeBuilderTrade, setActiveBuilderTrade] = useState<LiveFlowItem | null>(null);
  const [riskSubject, setRiskSubject] = useState<RiskSubject | null>(null);
  const [isFiltersOpen, setIsFiltersOpen] = useState<boolean>(true);

  // Flow items are modelled estimates derived from option-chain snapshots
  // (issue #119) — there is no live trade-tape feed behind this view.
  const [liveItems, setLiveItems] = useState<LiveFlowItem[]>([]);
  const [marketFlowItems, setMarketFlowItems] = useState<LiveFlowItem[]>([]);
  const [hasLoadedInitial, setHasLoadedInitial] = useState<boolean>(false);
  const [newsItems, setNewsItems] = useState<NewsFlowItem[]>([]);
  const [insiderItems, setInsiderItems] = useState<InsiderFlowItem[]>([]);
  const [congressItems, setCongressItems] = useState<CongressFlowItem[]>([]);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(true);
  const [lastSyncTime, setLastSyncTime] = useState<string>("");

  const fetchLiveFlows = (config?: Partial<FlowFilterConfig>) => {
    setIsRefreshing(true);
    const cfg = config || filterConfig;
    const params = new URLSearchParams();
    if (cfg.tickers && cfg.tickers.length > 0) params.set("tickers", cfg.tickers.join(","));
    if (cfg.minPremium && cfg.minPremium > 0) params.set("minPremium", String(cfg.minPremium));
    if (cfg.marketCaps && cfg.marketCaps.length > 0) params.set("marketCaps", cfg.marketCaps.join(","));
    if (cfg.assetTypes && cfg.assetTypes.length > 0) params.set("assetTypes", cfg.assetTypes.join(","));
    const url = `/api/options/flows/live${params.toString() ? `?${params.toString()}` : ""}`;

    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        if (data?.flows && Array.isArray(data.flows)) {
          setLiveItems(data.flows);
          if (!cfg.tickers || cfg.tickers.length === 0) {
            setMarketFlowItems(data.flows);
          }
          setLastSyncTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
        } else {
          setLiveItems([]);
        }
      })
      .catch(() => {
        setLiveItems([]);
      })
      .finally(() => {
        setIsRefreshing(false);
        setHasLoadedInitial(true);
      });
  };

  // Fetch initial or server data if available
  useEffect(() => {
    fetchLiveFlows(filterConfig);

    const tickerParam = filterConfig.tickers.length > 0 ? `?tickers=${encodeURIComponent(filterConfig.tickers.join(","))}` : "";

    fetch(`/api/options/flows/news${tickerParam}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        setNewsItems(Array.isArray(data?.news) ? data.news : []);
      })
      .catch(() => {
        setNewsItems([]);
      });

    fetch(`/api/options/flows/insider${tickerParam}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        setInsiderItems(Array.isArray(data?.insiders) ? data.insiders : []);
      })
      .catch(() => {
        setInsiderItems([]);
      });

    fetch("/api/options/flows/congress")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        setCongressItems(Array.isArray(data?.congress) ? data.congress : []);
      })
      .catch(() => {
        setCongressItems([]);
      });
  }, [filterConfig.tickers, filterConfig.minPremium, filterConfig.marketCaps, filterConfig.assetTypes]);

  // Issue #2419: live-stream refresh on the shared treatment —
  // hidden-pause + externalized cadence (was a hand-rolled 30s
  // setInterval with no visibility handling). The immediate fetch
  // on filter change stays in the effect above; the poller always
  // calls the latest fetchLiveFlows through the hook's ref.
  const flowsPollMs = getPollingConfig().optionsFlowsPollMs;
  // Issue #2481 — live-flow polling is gated by the global
  // auto-refresh switch; the immediate fetch on filter change
  // above is unaffected.
  const [autoRefresh] = useAutoRefresh();
  usePolling(() => fetchLiveFlows(filterConfig), { fastMs: flowsPollMs, idleMs: flowsPollMs, enabled: autoRefresh.enabled });

  // Filtered collections
  const filteredLiveItems = useMemo(() => {
    return filterLiveFlowItems(liveItems, filterConfig);
  }, [liveItems, filterConfig]);

  const filteredNewsItems = useMemo(() => {
    return filterNewsFlowItems(newsItems, filterConfig.tickers);
  }, [newsItems, filterConfig.tickers]);

  const filteredInsiderItems = useMemo(() => {
    return filterInsiderFlowItems(insiderItems, {
      tickers: filterConfig.tickers,
      insiderNames: filterConfig.insiderNames,
      minPremium: filterConfig.minPremium,
      assetTypes: filterConfig.assetTypes,
      marketCaps: filterConfig.marketCaps,
    });
  }, [insiderItems, filterConfig]);

  const filteredCongressItems = useMemo(() => {
    return filterCongressFlowItems(congressItems, {
      tickers: filterConfig.tickers,
      chamber: filterConfig.congressChamber,
      party: filterConfig.congressParty,
    });
  }, [congressItems, filterConfig]);

  // Provenance mix of the currently loaded flow items (issue #119) — drives
  // the disclosure banner and header pill so generated/static data can never
  // be presented as a live tape.
  const flowProvenance = useMemo(() => summarizeFlowProvenance(liveItems), [liveItems]);
  const flowProvenanceText = useMemo(() => {
    if (liveItems.length === 0) return FLOW_PROVENANCE_NOTICE;
    const parts = flowProvenance.provenances.map(
      (p) => `${flowProvenance.counts[p]} ${FLOW_PROVENANCE_LABELS[p].toLowerCase()}`
    );
    return `${FLOW_PROVENANCE_NOTICE} Current items: ${parts.join(" · ")}.`;
  }, [liveItems, flowProvenance]);

  const summaryData: FlowSummary = useMemo(() => {
    // Market Summary must ALWAYS represent the market-wide flow across active general filters,
    // NEVER collapsed into a single drilled-down stock!
    const marketItems = marketFlowItems.length > 0 ? marketFlowItems : liveItems;
    const generalMarketConfig: FlowFilterConfig = {
      ...filterConfig,
      tickers: [], // Exclude single-ticker drilldown so Summary always displays all stocks
    };
    const filteredMarket = filterLiveFlowItems(marketItems, generalMarketConfig);
    return calculateFlowSummary(filteredMarket);
  }, [marketFlowItems, liveItems, filterConfig]);

  // Tabbed browsing via the shared hook (S2, #2027): the flows inner tabs
  // live in `?view=` (no legacy param — flows never had one). Panels stay
  // conditional (no retention change: hidden panels must not keep polling).
  // The Summary side effects run on every tab change, including back/forward.
  const { activeTab: subTab, handleTabChange } = useUrlSyncedTabs<FlowSubTab>({
    param: "view",
    isValid: isValidFlowSubTab,
    defaultTab: "live",
    onTabChange: (tab) => {
      if (tab === "summary") {
        // When returning to Summary, clear single ticker drilldown so full dynamic market list is displayed
        if (filterConfig.tickers.length > 0) {
          const nextCfg: FlowFilterConfig = {
            ...filterConfig,
            tickers: [],
          };
          setFilterConfig(nextCfg);
          fetchLiveFlows(nextCfg);
        } else if (marketFlowItems.length === 0) {
          fetchLiveFlows(filterConfig);
        }
      }
    },
  });

  const handleClearTickerDrilldown = () => {
    const nextCfg: FlowFilterConfig = {
      ...filterConfig,
      tickers: [],
    };
    setFilterConfig(nextCfg);
    fetchLiveFlows(nextCfg);
  };

  // Handle Preset selection
  const handleSelectPreset = (preset: SavedFilterPreset) => {
    setActivePreset(preset);
    setFilterConfig({
      ...DEFAULT_FILTER_CONFIG,
      ...preset.config,
    });
  };

  const handleClearPreset = () => {
    setActivePreset(null);
    setFilterConfig(DEFAULT_FILTER_CONFIG);
  };

  const handleSaveFilter = (name: string) => {
    const newPreset: SavedFilterPreset = {
      id: `custom_${Date.now()}`,
      name,
      tagline: "Custom User Filter",
      color: "purple",
      tags: [
        filterConfig.tickers.length ? filterConfig.tickers.join(",") : "All Tickers",
        filterConfig.minPremium ? `>${Math.round(filterConfig.minPremium / 1000)}k` : "All Prem",
      ],
      config: { ...filterConfig },
    };
    setSavedPresets((prev) => [newPreset, ...prev]);
    setActivePreset(newPreset);
  };

  const handleResetFilter = () => {
    setActivePreset(null);
    setFilterConfig(DEFAULT_FILTER_CONFIG);
  };

  // Select ticker from dual leaderboard
  const handleSelectTicker = (symbol: string) => {
    setActivePreset(null);
    const nextCfg: FlowFilterConfig = {
      ...DEFAULT_FILTER_CONFIG,
      tickers: [symbol],
    };
    setFilterConfig(nextCfg);
    handleTabChange("live");
    fetchLiveFlows(nextCfg);
  };

  // Open trade details modal
  const handleOpenTradeDetail = (trade: LiveFlowItem) => {
    setSelectedDetailTrade(trade);
  };

  // Open in Builder handoff
  const handleOpenInBuilder = (trade: LiveFlowItem) => {
    setSelectedDetailTrade(null);
    setActiveBuilderTrade(trade);
  };

  // Row Action handler
  const handleTradeOrPrompt = (symbol: string, strategyText?: string) => {
    if (onTradeSymbol) {
      onTradeSymbol(symbol);
    } else if (onSendPrompt) {
      onSendPrompt(`Analyze institutional flow for ${symbol}: ${strategyText || "Options sweep"}`);
    }
  };

  // If builder is active for a flow trade (Screenshot 4)
  if (activeBuilderTrade) {
    const legs = activeBuilderTrade.legsDetails && activeBuilderTrade.legsDetails.length > 0
      ? activeBuilderTrade.legsDetails.map((l, idx) => ({
          id: `flow_leg_${idx}_${l.action}_${l.strike || idx}`,
          side: l.action.toUpperCase() as "BUY" | "SELL",
          optionType: l.optionType || (l.option.includes("C") ? "CALL" : "PUT"),
          strike: l.strike || (l.option.includes("135") ? 135 : l.option.includes("97.5") ? 97.5 : 100),
          quantity: l.quantity,
          expirationDate: l.expirationDate || "2027-01-15",
          dte: activeBuilderTrade.dte || 100,
          entryPrice: l.action === "Buy" ? 1.63 : 1.57,
          bid: 1.55,
          ask: 1.65,
          impliedVolatility: 27.5,
          delta: (l.optionType || (l.option.includes("C") ? "CALL" : "PUT")) === "CALL" ? 0.42 : -0.38,
          gamma: 0.015,
          theta: -0.045,
          vega: 0.12,
        }))
      : [
          {
            id: "flow_leg_0_buy_135c",
            side: "BUY" as const,
            optionType: "CALL" as const,
            strike: 135,
            quantity: 2000,
            expirationDate: "2027-01-15",
            dte: 100,
            entryPrice: 1.63,
            bid: 1.60,
            ask: 1.66,
            impliedVolatility: 27.5,
            delta: 0.42,
            gamma: 0.015,
            theta: -0.045,
            vega: 0.12,
          },
          {
            id: "flow_leg_1_sell_97p",
            side: "SELL" as const,
            optionType: "PUT" as const,
            strike: 97.5,
            quantity: 2000,
            expirationDate: "2027-01-15",
            dte: 100,
            entryPrice: 1.57,
            bid: 1.54,
            ask: 1.60,
            impliedVolatility: 27.5,
            delta: -0.38,
            gamma: 0.015,
            theta: -0.045,
            vega: 0.12,
          },
        ];

    return (
      <div className="options-flows-container options-flows-builder-view">
        <PageShell
          title="Institutional Options Flows"
          scopeNote="Options flows, dark pool prints, institutional sweeps, blocks, and insider disclosures"
        >
        <StrategyDiscoveryPanel
          activeEnv={brokerEnv}
          initialSymbol={activeBuilderTrade.symbol}
          initialStrategyName={activeBuilderTrade.strategyTitle || activeBuilderTrade.strategy}
          initialExpirationDate={
            activeBuilderTrade.legsDetails?.[0]?.expirationDate || "2027-01-15"
          }
          initialCustomLegs={legs}
          flowTradeBanner={{
            title: `${activeBuilderTrade.symbol} Options Flow`,
            returnText: activeBuilderTrade.returnSinceFillText || "-$5.50 (-3.5%) return since Oct 6, 2026, 3:51 PM",
          }}
          onBackToFlows={() => setActiveBuilderTrade(null)}
          onSendPrompt={onSendPrompt}
        />
        </PageShell>
      </div>
    );
  }


  const liveColumns: TableColumn<LiveFlowItem>[] = [
    { key: "time", header: "Time", cellClassName: "flow-time-cell",
      render: (item) => <span>{item.timestamp ? formatFlowDateTime(item.timestamp) : item.time}</span> },
    { key: "symbol", header: "Symbol", cellClassName: (item) => `flow-symbol-cell ${item.sentiment}`,
      render: (item) => <span>{item.symbol}</span> },
    { key: "strategy", header: "Strategy", cellClassName: "flow-strategy-cell",
      render: (item) => (
        <span>
          {item.strategy}
          {item.companyName && <span className="flow-strategy-desc">({item.companyName})</span>}
        </span>
      ) },
    { key: "expiration", header: "Expiration", cellClassName: "flow-exp-cell",
      render: (item) => <span>{item.expiration}</span> },
    { key: "premium", header: "Premium", cellClassName: (item) => `flow-premium-cell ${item.sentiment}`,
      render: (item) => (
        <span>
          {item.premiumFormatted}
          {item.abnormalActivity && <span className="flow-aa-badge">AA</span>}
        </span>
      ) },
    { key: "type", header: "Type",
      render: (item) => (
        <span>
          <span className={`flow-type-badge ${item.type.toLowerCase()}`}>{item.type}</span>
          <span className={`flow-prov-badge prov-${item.provenance}`} title={FLOW_PROVENANCE_NOTICE}>
            {item.provenance === "chain-derived"
              ? "modelled · chain-derived"
              : item.provenance === "generated"
                ? "🧪 generated"
                : "static sample"}
          </span>
        </span>
      ) },
    { key: "action", header: "Action",
      render: (item) => (
        <Button
          className="subnav-btn"
          style={{ padding: "var(--space-1) var(--space-1-5)", fontSize: "var(--font-size-caption)", borderColor: "var(--color-warning)", color: "var(--color-warning)" }}
          title="Analyze institutional trade risk profile"
          onClick={(e) => {
            e.stopPropagation();
            setRiskSubject(flowTradeToRiskSubject(item));
          }}
        >
          🛡️ Risk
        </Button>
      ) },
  ];
  const newsColumns: TableColumn<NewsFlowItem>[] = [
    { key: "time", header: "Time", cellClassName: "flow-time-cell",
      render: (item) => <span>{item.time}</span> },
    { key: "headline", header: "Headline", cellClassName: "news-headline-cell",
      render: (item) => (
        <span>
          <span className="news-symbols-prefix">{item.symbols.join(", ")}:</span>
          <span>{item.headline}</span>
          {item.source && (
            <span style={{ marginLeft: "8px", fontSize: "0.75rem", color: "var(--color-text-muted)", opacity: 0.8 }}>
              — {item.source}
            </span>
          )}
        </span>
      ) },
    { key: "sentiment", header: "Sentiment",
      render: (item) => {
        // Issue #132: sentiment is an LLM model assessment with
        // provenance — assessed items show the label + "· AI";
        // unassessed items show "Not assessed", never a
        // default "neutral" dressed up as a judgement.
        const sentimentUi = newsSentimentPresentation(item);
        return (
          <span className={sentimentUi.className} title={sentimentUi.title}>
            {sentimentUi.label}
          </span>
        );
      } },
  ];
  const congressColumns: TableColumn<CongressFlowItem>[] = [
    { key: "filingDate", header: "Filing Date", cellClassName: "flow-time-cell",
      render: (item) => <span>{item.filingDate}</span> },
    { key: "politician", header: "Politician",
      render: (item) => (
        <span>
          <span className="congress-politician">{item.politician}</span>
          <span className={`congress-meta-tag ${item.party === "Democrat" ? "dem" : "rep"}`}>
            {item.party[0]} - {item.state}
          </span>
        </span>
      ) },
    { key: "asset", header: "Asset / Strategy", cellClassName: "flow-strategy-cell",
      render: (item) => (
        <span>
          <strong>{item.symbol}</strong>: {item.assetDescription}
        </span>
      ) },
    { key: "transaction", header: "Transaction",
      render: (item) => <span>{item.transaction}</span> },
    { key: "amount", header: "Amount",
      render: (item) => <span style={{ color: "var(--color-text-muted)" }}>{item.amountRange}</span> },
    { key: "premium", header: "Est. Premium", cellClassName: "flow-premium-cell bullish",
      render: (item) => <span>{item.estimatedPremiumFormatted}</span> },
  ];
  const insiderColumns: TableColumn<InsiderFlowItem>[] = [
    { key: "reportDate", header: "Report Date", cellClassName: "flow-time-cell",
      render: (item) => <span>{item.reportDate}</span> },
    { key: "trade", header: "Trade", cellClassName: "flow-strategy-cell",
      render: (item) => (
        <span>
          {item.trade}
          <span className="flow-strategy-desc">({item.companyName})</span>
        </span>
      ) },
    { key: "member", header: "Member", cellClassName: "insider-member-cell",
      render: (item) => (
        <span>
          {item.member}
          <div className="insider-title-sub">{item.title}</div>
        </span>
      ) },
    { key: "premium", header: "Premium", cellClassName: "flow-premium-cell bullish",
      render: (item) => <span>{item.premiumFormatted}</span> },
  ];

  return (
    <div className="options-flows-container">
      <PageShell
        title="Institutional Options Flows"
        scopeNote="Options flows, dark pool prints, institutional sweeps, blocks, and insider disclosures"
      >
      {/* Universal Capability Navigation Bar */}
      <CapabilityNavBar
        ariaLabel="Institutional Options Flows"
        activeTabId={subTab}
        onTabChange={handleTabChange}
        className="flows-capability-nav"
        tabs={[
          {
            id: "summary",
            label: "Summary",
            tooltip: {
              eyebrow: "MARKET OVERVIEW",
              title: "Options Flow Market Summary",
              description: "Market-wide institutional options flow, aggregate bullish vs bearish sentiment, and top premium targets.",
            },
          },
          {
            id: "live",
            label: "Modelled Flow",
            badge: "ESTIMATES",
            badgeType: "amber",
            tooltip: {
              eyebrow: "CHAIN-DERIVED ESTIMATES",
              title: "Modelled Institutional Flow Estimates",
              description: "Flow estimates modelled from option-chain snapshots (contract volume, open interest, last price). Not exchange trade prints — no options trade-tape feed is connected.",
            },
          },
          {
            id: "historical",
            label: "Flow (Current Estimates)",
            tooltip: {
              eyebrow: "NO HISTORICAL TAPE",
              title: "Options Flow — Current Estimates",
              description: "No historical options trade tape is available in this product. This view shows the same current modelled flow estimates as the Modelled Flow tab.",
            },
          },
          {
            id: "news",
            label: "News Flow",
            tooltip: {
              eyebrow: "CATALYST FEED",
              title: "Real-Time News Flow",
              description: "Real-time breaking market news tied directly to options volatility and unusual volume catalysts. Sentiment badges are LLM model assessments of the headline text (marked · AI, model named on hover) — not measured market signals; headlines the model did not assess show 'Not assessed'.",
            },
          },
          {
            id: "congress",
            label: "Congress Flow",
            tooltip: {
              eyebrow: "CAPITOL HILL DISCLOSURES",
              title: "Congressional Trading Flow",
              description: "Capitol Hill financial disclosures and congressional trading disclosures filed under the STOCK Act.",
            },
          },
          {
            id: "insider",
            label: "Insider Flow",
            tooltip: {
              eyebrow: "SEC FORM 4 FILINGS",
              title: "Corporate Insider Flow",
              description: "SEC Form 4 corporate insider purchases, sales, and option exercises by C-suite executives and board directors.",
            },
          },
        ]}
        rightContent={
          <>
            <CopilotTriggerButton label="✨ Ask Copilot" />
            <div
              title={FLOW_PROVENANCE_NOTICE}
              style={{ display: "flex", alignItems: "center", gap: "var(--space-1-5)", fontSize: "var(--font-size-micro)", color: "var(--color-warning)", background: "var(--color-warning-subtle, var(--color-surface-sunken))", padding: "var(--space-1) var(--space-2)", borderRadius: "var(--radius-full, 12px)", border: "1px solid var(--color-warning)", fontWeight: 600 }}
            >
              <span>🧪</span>
              <span>{flowProvenance.provenances.includes("generated") ? "MODELLED · INCLUDES GENERATED SAMPLES" : "MODELLED — NOT A TRADE TAPE"}</span>
              {lastSyncTime && <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>{lastSyncTime}</span>}
            </div>
            <Button
              onClick={() => fetchLiveFlows(filterConfig)}
              disabled={isRefreshing}
              style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", fontSize: "var(--font-size-micro)", color: "var(--color-text-muted)", background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-medium)", borderRadius: "var(--radius-sm)", padding: "var(--space-1) var(--space-2)", cursor: isRefreshing ? "wait" : "pointer" }}
              title="Refresh modelled options flow estimates"
            >
              {isRefreshing ? "Refreshing..." : "↻ Refresh"}
            </Button>
            <div
              className="flows-gauge-badge-wrap"
              onClick={() => handleTabChange("summary")}
              title="Overall Options Market Flow Sentiment Dial"
            >
              <svg className="flows-gauge-svg" viewBox="0 0 40 20">
                <path
                  d="M 5 20 A 15 15 0 0 1 35 20"
                  fill="none"
                  stroke="var(--color-surface-raised)"
                  strokeWidth="5"
                  strokeLinecap="round"
                />
                <path
                  d="M 5 20 A 15 15 0 0 1 28 8"
                  fill="none"
                  stroke="var(--color-accent)"
                  strokeWidth="5"
                  strokeLinecap="round"
                />
                <path
                  d="M 28 8 A 15 15 0 0 1 35 20"
                  fill="none"
                  stroke="var(--color-warning)"
                  strokeWidth="5"
                  strokeLinecap="round"
                />
              </svg>
              <span className="flows-gauge-text">{summaryData.bullishSentimentRatio}% Bullish</span>
            </div>
          </>
        }
      />

      {/* Provenance disclosure (issue #119): this is modelled flow, not a tape */}
      <div className="flows-delay-banner">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <span aria-hidden="true">🧪</span>
          <span style={{ fontWeight: 600 }}>Modelled Options Flow — not a live trade tape</span>
          <span style={{ fontWeight: 400, color: "var(--color-text-muted)" }}>{flowProvenanceText}</span>
        </div>

        <div className="flows-delay-banner-right">
          {activePreset && (
            <div className={`flows-filter-active-pill-header ${activePreset.color}`}>
              <span>Filter: {activePreset.name}</span>
            </div>
          )}
          <Button
            className={`flow-toggle-filters-btn ${isFiltersOpen ? "active" : ""}`}
            onClick={() => setIsFiltersOpen(!isFiltersOpen)}
            title={isFiltersOpen ? "Hide filters to expand table" : "Show filters panel"}
          >
            {isFiltersOpen ? "✕ Hide Filters" : "⚙️ Filters"}
          </Button>
        </div>
      </div>

      {/* Main Split Layout: Data Tables + Right Sidebar */}
      <div className="flows-main-layout">
        <main className="flows-table-area">
          {/* SUB-TAB 1: SUMMARY VIEW */}
          {subTab === "summary" && (
            !hasLoadedInitial && isRefreshing ? (
              <div style={{ padding: "calc(var(--space-6) * 2 + var(--space-4)) calc(var(--space-6) + var(--space-2))", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "var(--font-size-title-sm)", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  Aggregating Modelled Options Flow Leaderboard...
                </div>
                <div style={{ fontSize: "var(--font-size-body)" }}>
                  Calculating net bullish vs bearish dollar volumes from modelled flow estimates derived from option-chain snapshots
                </div>
              </div>
            ) : summaryData.totalTrades === 0 ? (
              <div style={{ padding: "calc(var(--space-6) * 2 + var(--space-4)) calc(var(--space-6) + var(--space-2))", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "var(--font-size-title)", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  No flow estimates available
                </div>
                <div style={{ fontSize: "var(--font-size-body)" }}>
                  No option-chain data is currently available to derive flow estimates.
                </div>
              </div>
            ) : (
              <FlowSummaryDualBars
                bullishItems={summaryData.bullishLeaderboard}
                bearishItems={summaryData.bearishLeaderboard}
                onSelectSymbol={handleSelectTicker}
              />
            )
          )}

          {/* SUB-TAB 2: LIVE FLOW & SUB-TAB 3: HISTORICAL FLOW */}
          {(subTab === "live" || subTab === "historical") && (
            <>
              {filterConfig.tickers.length > 0 && (
                <div className="flow-drilldown-banner">
                  <div className="flow-drilldown-info">
                    <span className="flow-drilldown-badge">TICKER DRILLDOWN</span>
                    <span className="flow-drilldown-text">
                      Showing modelled flow for <strong>{filterConfig.tickers.join(", ")}</strong>
                    </span>
                  </div>
                  <div className="flow-drilldown-actions">
                    <Button
                      className="flow-drilldown-back-btn"
                      onClick={() => handleTabChange("summary")}
                    >
                      ← Return to Market Summary
                    </Button>
                    <Button
                      className="flow-drilldown-clear-btn"
                      onClick={handleClearTickerDrilldown}
                    >
                      ✕ Show All Tickers
                    </Button>
                  </div>
                </div>
              )}
              {!hasLoadedInitial && isRefreshing ? (
                <div style={{ padding: "calc(var(--space-6) * 2 + var(--space-4)) calc(var(--space-6) + var(--space-2))", textAlign: "center", color: "var(--color-text-muted)" }}>
                  <div style={{ fontSize: "var(--font-size-title-sm)", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                    Loading Modelled Institutional Options Flow Estimates...
                  </div>
                  <div style={{ fontSize: "var(--font-size-body)" }}>
                    Deriving sweep and block estimates from option-chain snapshots — not exchange trade prints
                  </div>
                </div>
              ) : filteredLiveItems.length === 0 ? (
                <div style={{ padding: "calc(var(--space-6) * 2) var(--space-4)", textAlign: "center", color: "var(--color-text-muted)" }}>
                  <div style={{ fontSize: "var(--font-size-title)", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                    No flow estimates available
                  </div>
                  <div style={{ fontSize: "var(--font-size-body)" }}>
                    {filterConfig.tickers.length > 0 || filterConfig.minPremium > 0
                      ? "No modelled flow items matching the current filter criteria."
                      : "No option-chain data currently available to derive flow estimates."}
                  </div>
                </div>
              ) : (
                <Table
                  columns={liveColumns}
                  rows={filteredLiveItems}
                  rowKey={(item) => item.id}
                  onRowClick={(item) => handleOpenTradeDetail(item)}
                  rowClassName="clickable-row"
                  className="flow-table"
                />
              )}
            </>
          )}

          {/* SUB-TAB 4: NEWS FLOW */}
          {subTab === "news" && (
            !hasLoadedInitial && isRefreshing && newsItems.length === 0 ? (
              <div style={{ padding: "calc(var(--space-6) * 2 + var(--space-4)) calc(var(--space-6) + var(--space-2))", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "var(--font-size-title-sm)", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  Fetching Live Market News...
                </div>
                <div style={{ fontSize: "var(--font-size-body)" }}>
                  Connecting to real-time financial market news feeds
                </div>
              </div>
            ) : filteredNewsItems.length === 0 ? (
              <div style={{ padding: "calc(var(--space-6) * 2) var(--space-4)", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "var(--font-size-title)", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  No live feed available
                </div>
                <div style={{ fontSize: "var(--font-size-body)" }}>
                  No live financial news prints currently available from market feeds.
                </div>
              </div>
            ) : (
              <Table
                columns={newsColumns}
                rows={filteredNewsItems}
                rowKey={(item) => item.id}
                onRowClick={(item) => {
                  if (item.url) window.open(item.url, "_blank", "noopener,noreferrer");
                }}
                rowClassName={(item) => (item.url ? "clickable-row" : "")}
                className="flow-table"
              />
            )
          )}

          {/* SUB-TAB 5: CONGRESS FLOW */}
          {subTab === "congress" && (
            !hasLoadedInitial && isRefreshing && congressItems.length === 0 ? (
              <div style={{ padding: "calc(var(--space-6) * 2 + var(--space-4)) calc(var(--space-6) + var(--space-2))", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "var(--font-size-title-sm)", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  Fetching Congressional Trading Disclosures...
                </div>
                <div style={{ fontSize: "var(--font-size-body)" }}>
                  Connecting to real-time congressional member stock disclosure feeds
                </div>
              </div>
            ) : filteredCongressItems.length === 0 ? (
              <div style={{ padding: "calc(var(--space-6) * 2) var(--space-4)", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "var(--font-size-title)", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  No live feed available
                </div>
                <div style={{ fontSize: "var(--font-size-body)" }}>
                  No live congressional trading disclosures feed currently available.
                </div>
              </div>
            ) : (
              <Table
                columns={congressColumns}
                rows={filteredCongressItems}
                rowKey={(item) => item.id}
                onRowClick={(item) => handleTradeOrPrompt(item.symbol)}
                rowClassName="clickable-row"
                className="flow-table"
              />
            )
          )}

          {/* SUB-TAB 6: INSIDER FLOW */}
          {subTab === "insider" && (
            !hasLoadedInitial && isRefreshing && insiderItems.length === 0 ? (
              <div style={{ padding: "calc(var(--space-6) * 2 + var(--space-4)) calc(var(--space-6) + var(--space-2))", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "var(--font-size-title-sm)", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  Streaming Live SEC Form 4 Filings...
                </div>
                <div style={{ fontSize: "var(--font-size-body)" }}>
                  Connecting directly to SEC EDGAR real-time insider trade disclosures
                </div>
              </div>
            ) : filteredInsiderItems.length === 0 ? (
              <div style={{ padding: "calc(var(--space-6) * 2) var(--space-4)", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "var(--font-size-title)", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  No live feed available
                </div>
                <div style={{ fontSize: "var(--font-size-body)" }}>
                  No live SEC Form 4 insider trading feed currently available.
                </div>
              </div>
            ) : (
              <Table
                columns={insiderColumns}
                rows={filteredInsiderItems}
                rowKey={(item) => item.id}
                onRowClick={(item) => handleTradeOrPrompt(item.symbol)}
                rowClassName="clickable-row"
                className="flow-table"
              />
            )
          )}
        </main>

        {/* Right Filters & Alerts Sidebar */}
        {isFiltersOpen && (
          <FlowFiltersSidebar
            currentTab={subTab}
            filterConfig={filterConfig}
            activePreset={activePreset}
            savedPresets={savedPresets}
            totalFlowCount={
              subTab === "news"
                ? newsItems.length
                : subTab === "insider"
                ? insiderItems.length
                : subTab === "congress"
                ? congressItems.length
                : liveItems.length
            }
            filteredFlowCount={
              subTab === "news"
                ? filteredNewsItems.length
                : subTab === "insider"
                ? filteredInsiderItems.length
                : subTab === "congress"
                ? filteredCongressItems.length
                : filteredLiveItems.length
            }
            onFilterChange={setFilterConfig}
            onSelectPreset={handleSelectPreset}
            onClearPreset={handleClearPreset}
            onSaveFilter={handleSaveFilter}
            onResetFilter={handleResetFilter}
            onClose={() => setIsFiltersOpen(false)}
          />
        )}
      </div>

      {/* Trade Detail Modal */}
      {selectedDetailTrade && (
        <FlowTradeDetailModal
          trade={selectedDetailTrade}
          onClose={() => setSelectedDetailTrade(null)}
          onOpenInBuilder={handleOpenInBuilder}
          onRiskAnalysis={(trade) => setRiskSubject(flowTradeToRiskSubject(trade))}
        />
      )}

      {/* Institutional Risk Analysis & Defense Playbook Modal */}
      <RiskAnalysisModal
        isOpen={Boolean(riskSubject)}
        onClose={() => setRiskSubject(null)}
        subject={riskSubject}
        onSendPrompt={onSendPrompt}
      />
    </PageShell>
    </div>
  );
}
