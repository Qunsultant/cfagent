import React, { useState, useMemo, useEffect } from "react";
import { useUrlSyncedTabs } from "../../useUrlSyncedTabs";
import { useBrokerEnvironment } from "../../brokerEnvironment";
import { usePolling } from "../../usePolling";
import { useAutoRefresh } from "../../autoRefresh";
import { getPollingConfig } from "../../pollingConfig";
import {
  Badge,
  Button,
  EmptyState,
  Flex,
  Notice,
  PageSection,
  PageShell,
  Spinner,
  Stack,
  Table,
  type BadgeTone,
  type TableColumn,
} from "../../components/ui";

// Issue #5077: the optionsFlows.css import stays — the sheet styles this
// hub's child components (FlowFiltersSidebar, FlowSummaryDualBars,
// FlowTradeDetailModal, news sentiment badges), which are not migrated in
// this slice. This file itself no longer uses any class from it; the import
// is the subtree's only load of the sheet (main.tsx does not import it).
// Retiring the sheet waits on migrating those children.
import "./optionsFlows.css";

/** Tone maps for the flow badges (sheet rules, token-only). */
function flowTypeTone(type: string): BadgeTone {
  switch (type.toLowerCase()) {
    case "sweep": return "trade";
    case "split": return "accent";
    case "block": return "info";
    default: return "neutral";
  }
}

function flowProvenanceTone(provenance: string): BadgeTone {
  return provenance === "chain-derived" ? "neutral" : "warning";
}

function flowSentimentClass(sentiment: string): string {
  if (sentiment === "bullish") return "ui-success";
  if (sentiment === "bearish") return "ui-danger";
  return "";
}

function presetTone(color: SavedFilterPreset["color"]): BadgeTone {
  switch (color) {
    case "purple":
    case "magenta": return "purple";
    case "green": return "success";
    case "yellow":
    case "orange": return "warning";
    case "cyan": return "info";
    default: return "neutral";
  }
}

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
  // Issue #4576: the flows sub-tabs live in their own param. `view`
  // belongs to the Options hub (which nests this panel under
  // `view=options-flows`), so writing `view` here overwrote the hub's tab
  // and a reload fell back to the scanner. `flowsTab` is the panel's own
  // address; the standalone `?tab=options-flows` reads the same param.
  const { activeTab: subTab, handleTabChange } = useUrlSyncedTabs<FlowSubTab>({
    param: "flowsTab",
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
      <div className="ui-page-frame">
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
    { key: "time", header: "Time",
      render: (item) => <span>{item.timestamp ? formatFlowDateTime(item.timestamp) : item.time}</span> },
    { key: "symbol", header: "Symbol",
      render: (item) => <strong className={flowSentimentClass(item.sentiment) || undefined}>{item.symbol}</strong> },
    { key: "strategy", header: "Strategy",
      render: (item) => (
        <span>
          {item.strategy}
          {item.companyName && <span className="ui-meta">({item.companyName})</span>}
        </span>
      ) },
    { key: "expiration", header: "Expiration",
      render: (item) => <span>{item.expiration}</span> },
    { key: "premium", header: "Premium",
      render: (item) => (
        <span>
          <span className={flowSentimentClass(item.sentiment) || undefined}>{item.premiumFormatted}</span>
          {item.abnormalActivity && (
            <>
              {" "}
              <Badge tone="warning" size="xs">AA</Badge>
            </>
          )}
        </span>
      ) },
    { key: "type", header: "Type",
      render: (item) => (
        <Stack gap="1">
          <Badge tone={flowTypeTone(item.type)} size="xs">{item.type}</Badge>
          <Badge tone={flowProvenanceTone(item.provenance)} size="xs" title={FLOW_PROVENANCE_NOTICE}>
            {item.provenance === "chain-derived"
              ? "modelled · chain-derived"
              : item.provenance === "generated"
                ? "🧪 generated"
                : "static sample"}
          </Badge>
        </Stack>
      ) },
    { key: "action", header: "Action",
      render: (item) => (
        <Button
          variant="secondary"
          size="sm"
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
    { key: "time", header: "Time",
      render: (item) => <span>{item.time}</span> },
    { key: "headline", header: "Headline",
      render: (item) => (
        <span>
          <strong>{item.symbols.join(", ")}:</strong>{" "}
          <span>{item.headline}</span>
          {item.source && (
            <span className="ui-meta"> — {item.source}</span>
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
    { key: "filingDate", header: "Filing Date",
      render: (item) => <span>{item.filingDate}</span> },
    { key: "politician", header: "Politician",
      render: (item) => (
        <span>
          <strong>{item.politician}</strong>{" "}
          <Badge tone={item.party === "Democrat" ? "info" : "danger"} size="xs">
            {item.party[0]} - {item.state}
          </Badge>
        </span>
      ) },
    { key: "asset", header: "Asset / Strategy",
      render: (item) => (
        <span>
          <strong>{item.symbol}</strong>: {item.assetDescription}
        </span>
      ) },
    { key: "transaction", header: "Transaction",
      render: (item) => <span>{item.transaction}</span> },
    { key: "amount", header: "Amount",
      render: (item) => <span className="ui-meta">{item.amountRange}</span> },
    { key: "premium", header: "Est. Premium",
      render: (item) => <span className="ui-success">{item.estimatedPremiumFormatted}</span> },
  ];
  const insiderColumns: TableColumn<InsiderFlowItem>[] = [
    { key: "reportDate", header: "Report Date",
      render: (item) => <span>{item.reportDate}</span> },
    { key: "trade", header: "Trade",
      render: (item) => (
        <span>
          {item.trade}{" "}
          <span className="ui-meta">({item.companyName})</span>
        </span>
      ) },
    { key: "member", header: "Member",
      render: (item) => (
        <Stack gap="0">
          <span>{item.member}</span>
          <span className="ui-meta">{item.title}</span>
        </Stack>
      ) },
    { key: "premium", header: "Premium",
      render: (item) => <span className="ui-success">{item.premiumFormatted}</span> },
  ];

  return (
    <div className="ui-page-frame">
      <PageShell
        title="Institutional Options Flows"
        scopeNote="Options flows, dark pool prints, institutional sweeps, blocks, and insider disclosures"
      >
      {/* Universal Capability Navigation Bar */}
      <CapabilityNavBar
        ariaLabel="Institutional Options Flows"
        activeTabId={subTab}
        onTabChange={handleTabChange}
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
            <Badge tone="warning" size="sm" title={FLOW_PROVENANCE_NOTICE}>
              🧪 {flowProvenance.provenances.includes("generated") ? "MODELLED · INCLUDES GENERATED SAMPLES" : "MODELLED — NOT A TRADE TAPE"}
              {lastSyncTime && <span> {lastSyncTime}</span>}
            </Badge>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fetchLiveFlows(filterConfig)}
              disabled={isRefreshing}
              title="Refresh modelled options flow estimates"
            >
              {isRefreshing ? "Refreshing..." : "↻ Refresh"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleTabChange("summary")}
              title="Overall Options Market Flow Sentiment Dial"
            >
              <svg width={32} height={18} viewBox="0 0 40 20" aria-hidden="true">
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
              <span className="ui-meta">{summaryData.bullishSentimentRatio}% Bullish</span>
            </Button>
          </>
        }
      />

      {/* Provenance disclosure (issue #119): this is modelled flow, not a tape */}
      <Notice tone="warning">
        <Flex justify="between" align="center" gap="2">
          <Flex gap="2" align="center">
            <span aria-hidden="true">🧪</span>
            <strong>Modelled Options Flow — not a live trade tape</strong>
            <span className="ui-meta">{flowProvenanceText}</span>
          </Flex>
          <Flex gap="2" align="center">
            {activePreset && (
              <Badge tone={presetTone(activePreset.color)} size="sm">
                Filter: {activePreset.name}
              </Badge>
            )}
            <Button
              variant={isFiltersOpen ? "primary" : "secondary"}
              size="sm"
              aria-pressed={isFiltersOpen}
              onClick={() => setIsFiltersOpen(!isFiltersOpen)}
              title={isFiltersOpen ? "Hide filters to expand table" : "Show filters panel"}
            >
              {isFiltersOpen ? "✕ Hide Filters" : "⚙️ Filters"}
            </Button>
          </Flex>
        </Flex>
      </Notice>

      {/* Main Split Layout: Data Tables + Right Sidebar */}
      <PageSection>
        <Flex>
          <main className="ui-grow">
          {/* SUB-TAB 1: SUMMARY VIEW */}
          {subTab === "summary" && (
            !hasLoadedInitial && isRefreshing ? (
              <Stack gap="2" align="center">
                <Spinner />
                <strong>Aggregating Modelled Options Flow Leaderboard...</strong>
                <span className="ui-meta">Calculating net bullish vs bearish dollar volumes from modelled flow estimates derived from option-chain snapshots</span>
              </Stack>
            ) : summaryData.totalTrades === 0 ? (
              <EmptyState
                title="No flow estimates available"
                description="No option-chain data is currently available to derive flow estimates."
              />
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
                <Notice tone="info">
                  <Flex justify="between" align="center" gap="2">
                    <Flex gap="2" align="center">
                      <Badge tone="info" size="xs" uppercase>TICKER DRILLDOWN</Badge>
                      <span>
                        Showing modelled flow for <strong>{filterConfig.tickers.join(", ")}</strong>
                      </span>
                    </Flex>
                    <Flex gap="1" align="center">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleTabChange("summary")}
                      >
                        ← Return to Market Summary
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleClearTickerDrilldown}
                      >
                        ✕ Show All Tickers
                      </Button>
                    </Flex>
                  </Flex>
                </Notice>
              )}
              {!hasLoadedInitial && isRefreshing ? (
                <Stack gap="2" align="center">
                  <Spinner />
                  <strong>Loading Modelled Institutional Options Flow Estimates...</strong>
                  <span className="ui-meta">Deriving sweep and block estimates from option-chain snapshots — not exchange trade prints</span>
                </Stack>
              ) : filteredLiveItems.length === 0 ? (
                <EmptyState
                  title="No flow estimates available"
                  description={
                    filterConfig.tickers.length > 0 || filterConfig.minPremium > 0
                      ? "No modelled flow items matching the current filter criteria."
                      : "No option-chain data currently available to derive flow estimates."
                  }
                />
              ) : (
                <Table
                  columns={liveColumns}
                  rows={filteredLiveItems}
                  rowKey={(item) => item.id}
                  onRowClick={(item) => handleOpenTradeDetail(item)}
                  containerClassName="ui-scroll-frame"
                  stickyHeader
                />
              )}
            </>
          )}

          {/* SUB-TAB 4: NEWS FLOW */}
          {subTab === "news" && (
            !hasLoadedInitial && isRefreshing && newsItems.length === 0 ? (
              <Stack gap="2" align="center">
                <Spinner />
                <strong>Fetching Live Market News...</strong>
                <span className="ui-meta">Connecting to real-time financial market news feeds</span>
              </Stack>
            ) : filteredNewsItems.length === 0 ? (
              <EmptyState
                title="No live feed available"
                description="No live financial news prints currently available from market feeds."
              />
            ) : (
              <Table
                columns={newsColumns}
                rows={filteredNewsItems}
                rowKey={(item) => item.id}
                onRowClick={(item) => {
                  if (item.url) window.open(item.url, "_blank", "noopener,noreferrer");
                }}
                containerClassName="ui-scroll-frame"
                stickyHeader
              />
            )
          )}

          {/* SUB-TAB 5: CONGRESS FLOW */}
          {subTab === "congress" && (
            !hasLoadedInitial && isRefreshing && congressItems.length === 0 ? (
              <Stack gap="2" align="center">
                <Spinner />
                <strong>Fetching Congressional Trading Disclosures...</strong>
                <span className="ui-meta">Connecting to real-time congressional member stock disclosure feeds</span>
              </Stack>
            ) : filteredCongressItems.length === 0 ? (
              <EmptyState
                title="No live feed available"
                description="No live congressional trading disclosures feed currently available."
              />
            ) : (
              <Table
                columns={congressColumns}
                rows={filteredCongressItems}
                rowKey={(item) => item.id}
                onRowClick={(item) => handleTradeOrPrompt(item.symbol)}
                containerClassName="ui-scroll-frame"
                stickyHeader
              />
            )
          )}

          {/* SUB-TAB 6: INSIDER FLOW */}
          {subTab === "insider" && (
            !hasLoadedInitial && isRefreshing && insiderItems.length === 0 ? (
              <Stack gap="2" align="center">
                <Spinner />
                <strong>Streaming Live SEC Form 4 Filings...</strong>
                <span className="ui-meta">Connecting directly to SEC EDGAR real-time insider trade disclosures</span>
              </Stack>
            ) : filteredInsiderItems.length === 0 ? (
              <EmptyState
                title="No live feed available"
                description="No live SEC Form 4 insider trading feed currently available."
              />
            ) : (
              <Table
                columns={insiderColumns}
                rows={filteredInsiderItems}
                rowKey={(item) => item.id}
                onRowClick={(item) => handleTradeOrPrompt(item.symbol)}
                containerClassName="ui-scroll-frame"
                stickyHeader
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
        </Flex>
      </PageSection>

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
