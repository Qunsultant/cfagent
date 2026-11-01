import React, { useState, useEffect } from "react";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import { apiFetch as fetch } from "./apiFetch";
import { EmptyState, Spinner, Button, Select, Table, TextInput, PageShell, PageSection, FieldShell } from "./components/ui";
import { ResearchReportActions } from "./ResearchReportActions";
import { TabHoverItem } from "./TabHoverItem";
import { CapabilityNavBar, CopilotTriggerButton } from "./components/CapabilityNavBar";
import type {
  MarketDataResearchQuote,
  MarketDataResearchCompanyFundamentals,
  MarketDataResearchHistoricalBar,
  MarketDataResearchProvenance,
  AlpacaMarketSnapshot,
  MarketDataResearchReport,
  MarketDataResearchProviderStatus,
} from "../types";

/**
 * Data-provenance badge (issue #117). Every market-data object now states whether
 * it was fetched live, served from the static market-data table, or generated.
 * Non-live data is badged visibly — following the repo's 🧪 demo-labelling
 * pattern — instead of being dressed as a live provider feed.
 */
export function marketDataResearchProvenanceLabel(provenance?: MarketDataResearchProvenance): string {
  switch (provenance) {
    case "live":
      return "● LIVE provider data";
    case "static":
      return "🧪 Static market-data table — not live";
    case "generated":
      return "🧪 Generated market-data estimate — not live market data";
    default:
      return "🧪 Provenance unknown — treat as not live";
  }
}

export function MarketDataResearchProvenanceBadge({
  provenance,
  note,
}: {
  provenance?: MarketDataResearchProvenance;
  note?: string;
}) {
  const isLive = provenance === "live";
  return (
    <span
      title={note || marketDataResearchProvenanceLabel(provenance)}
      style={{
        display: "inline-block",
        padding: "var(--space-0-5) var(--space-2)",
        borderRadius: "999px",
        fontSize: "var(--font-size-micro)",
        fontWeight: 700,
        letterSpacing: "0.01em",
        color: isLive ? "var(--color-success)" : "var(--color-warning)",
        background: isLive ? "var(--color-success-subtle, transparent)" : "var(--color-warning-subtle, transparent)",
        border: `1px solid ${isLive ? "var(--color-success)" : "var(--color-warning)"}`,
        whiteSpace: "nowrap",
      }}
    >
      {marketDataResearchProvenanceLabel(provenance)}
    </span>
  );
}

export interface User {
  login: string;
  name?: string;
  avatar?: string;
}

export interface MarketDataResearchHubProps {
  user?: User;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  onTradeSymbol?: (symbol: string) => void;
}

export type ResearchSubTab =
  | "screener"
  | "report"
  | "quoting"
  | "fundamentals"
  | "bars"
  | "snapshot"
  | "compare";

export function isValidResearchSubTab(tab: unknown): tab is ResearchSubTab {
  return (
    typeof tab === "string" &&
    (
      ["screener", "report", "quoting", "fundamentals", "bars", "snapshot", "compare"] as readonly string[]
    ).includes(tab)
  );
}

export function MarketDataResearchHub({ user, onSendPrompt, onTradeSymbol }: MarketDataResearchHubProps) {
  // Navigation subtabs via the shared hook (S2, #2027): inner tabs live
  // in `?view=` (no legacy param — research never had one). Panels stay
  // conditional (no retention change). The lazy-load side effects run on
  // every tab change, including back/forward.
  const { activeTab: subTab, handleTabChange } = useUrlSyncedTabs<ResearchSubTab>({
    param: "view",
    isValid: isValidResearchSubTab,
    defaultTab: "screener",
    onTabChange: (targetTab) => {
      if (targetTab === "screener" && screenerStocks.length === 0) fetchScreener();
      if (targetTab === "compare" && comparisonResults.length === 0) runComparison(compareSymbolsInput);
    },
  });

  // Active Symbol State
  const [activeSymbol, setActiveSymbol] = useState("NVDA");
  const [symbolInput, setSymbolInput] = useState("NVDA");

  // Providers Status
  const [providers, setProviders] = useState<MarketDataResearchProviderStatus[]>([]);

  // Research Report State
  const [report, setReport] = useState<MarketDataResearchReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  // Quoting State
  const [quoteProvider, setQuoteProvider] = useState<"yfinance" | "alpaca" | "hybrid">("hybrid");
  const [activeQuote, setActiveQuote] = useState<MarketDataResearchQuote | null>(null);
  const [yfinanceQuote, setYfinanceQuote] = useState<MarketDataResearchQuote | null>(null);
  const [alpacaQuote, setAlpacaQuote] = useState<MarketDataResearchQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  // Fundamentals State
  const [fundamentals, setFundamentals] = useState<MarketDataResearchCompanyFundamentals | null>(null);
  const [fundamentalsLoading, setFundamentalsLoading] = useState(false);

  // Historical Bars State
  const [bars, setBars] = useState<MarketDataResearchHistoricalBar[]>([]);
  const [barTimeframe, setBarTimeframe] = useState("1D");
  const [barLimit, setBarLimit] = useState(30);
  const [barProvider, setBarProvider] = useState<"yfinance" | "alpaca">("yfinance");
  const [barsMeta, setBarsMeta] = useState<{ source?: string; timestamp?: string; provider?: string; provenance?: MarketDataResearchProvenance } | null>(null);
  const [barsLoading, setBarsLoading] = useState(false);

  // Alpaca Snapshot & Tracing State
  const [snapshot, setSnapshot] = useState<AlpacaMarketSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [alpacaTraces, setAlpacaTraces] = useState<any[]>([]);
  const [tracesLoading, setTracesLoading] = useState(false);
  const [copiedMcpConfig, setCopiedMcpConfig] = useState(false);
  const [alpacaAccount, setAlpacaAccount] = useState<any>(null);
  const [alpacaPositions, setAlpacaPositions] = useState<any[]>([]);
  const [alpacaAccountLoading, setAlpacaAccountLoading] = useState(false);

  // Multi-Stock Comparison State
  const [compareSymbolsInput, setCompareSymbolsInput] = useState("NVDA, AMD, INTC, MSFT");
  const [comparisonResults, setComparisonResults] = useState<Array<{ symbol: string; quote: MarketDataResearchQuote; fundamentals: MarketDataResearchCompanyFundamentals }>>([]);
  const [compareLoading, setCompareLoading] = useState(false);

  // NLQ Prompt Bar State
  const [nlqQuery, setNlqQuery] = useState("");

  // Copy feedback
  const [copiedDid, setCopiedDid] = useState(false);

  // Yahoo Finance Screener State
  const [screenerStocks, setScreenerStocks] = useState<any[]>([]);
  const [screenerLoading, setScreenerLoading] = useState(false);
  const [screenerSearch, setScreenerSearch] = useState("");
  const [screenerSector, setScreenerSector] = useState("all");
  const [screenerGainersOnly, setScreenerGainersOnly] = useState(false);
  const [screenerLosersOnly, setScreenerLosersOnly] = useState(false);
  const [screenerMinRsi, setScreenerMinRsi] = useState<number | undefined>(undefined);
  const [screenerMaxRsi, setScreenerMaxRsi] = useState<number | undefined>(undefined);
  const [screenerSummary, setScreenerSummary] = useState("All Equities (Yahoo Finance Feed)");
  const [screenerLastScanned, setScreenerLastScanned] = useState<string>("");
  const [screenerError, setScreenerError] = useState("");
  const [showAlpacaDrawerOnScreener, setShowAlpacaDrawerOnScreener] = useState(false);

  const researchAgentDid = "did:agent:openaimp:research";

  // Initial load
  useEffect(() => {
    fetchProviders();
    loadAllSymbolData("NVDA");
    fetchScreener();
  }, []);

  const fetchScreener = async (override?: {
    search?: string;
    sector?: string;
    gainersOnly?: boolean;
    losersOnly?: boolean;
    minRsi?: number;
    maxRsi?: number;
  }) => {
    setScreenerLoading(true);
    setScreenerError("");
    try {
      const search = override?.search !== undefined ? override.search : screenerSearch;
      const sector = override?.sector !== undefined ? override.sector : screenerSector;
      const gainers = override?.gainersOnly !== undefined ? override.gainersOnly : screenerGainersOnly;
      const losers = override?.losersOnly !== undefined ? override.losersOnly : screenerLosersOnly;
      const minRsi = override?.minRsi !== undefined ? override.minRsi : screenerMinRsi;
      const maxRsi = override?.maxRsi !== undefined ? override.maxRsi : screenerMaxRsi;

      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (sector && sector !== "all") params.set("sector", sector);
      if (gainers) params.set("gainersOnly", "true");
      if (losers) params.set("losersOnly", "true");
      if (minRsi !== undefined) params.set("minRsi", String(minRsi));
      if (maxRsi !== undefined) params.set("maxRsi", String(maxRsi));

      const resp = await fetch(`/api/market-data/screen?${params.toString()}`);
      const data = (await resp.json()) as any;
      if (!resp.ok) throw new Error(data.error || `Stock screening failed [HTTP ${resp.status}].`);
      setScreenerStocks(data.stocks || data.results || []);
      if (data.filterSummary) setScreenerSummary(data.filterSummary);
      setScreenerLastScanned(new Date().toLocaleTimeString());
    } catch (cause) {
      setScreenerStocks([]);
      setScreenerError(cause instanceof Error ? cause.message : "Unable to reach the stock screening API.");
    } finally {
      setScreenerLoading(false);
    }
  };

  const fetchProviders = async () => {
    try {
      const resp = await fetch("/api/market-data/providers");
      if (resp.ok) {
        const data = await resp.json() as { providers?: MarketDataResearchProviderStatus[] };
        if (data.providers) setProviders(data.providers);
      }
    } catch {
      // Ignore
    }
  };

  const loadAllSymbolData = async (sym: string) => {
    const cleanSym = sym.toUpperCase().trim();
    setActiveSymbol(cleanSym);
    loadResearchReport(cleanSym);
    loadQuotes(cleanSym);
    loadFundamentals(cleanSym);
    loadHistoricalBars(cleanSym, barTimeframe, barLimit, barProvider);
    loadAlpacaSnapshot(cleanSym);
  };

  const handleAnalyzeTicker = (sym: string) => {
    const cleanSym = sym.toUpperCase().trim();
    if (!cleanSym) return;
    loadAllSymbolData(cleanSym);
    if (subTab === "screener") {
      setScreenerSearch(cleanSym);
      fetchScreener({ search: cleanSym });
    }
  };

  const loadResearchReport = async (sym: string) => {
    setReportLoading(true);
    try {
      const resp = await fetch(`/api/market-data/research?symbol=${encodeURIComponent(sym)}`);
      if (resp.ok) {
        const data = await resp.json() as MarketDataResearchReport;
        setReport(data);
      }
    } catch {
      // Ignore
    } finally {
      setReportLoading(false);
    }
  };

  const loadQuotes = async (sym: string) => {
    setQuoteLoading(true);
    try {
      const [respYf, respAlpaca] = await Promise.all([
        fetch(`/api/market-data/quote?symbol=${encodeURIComponent(sym)}&provider=yfinance`),
        fetch(`/api/market-data/quote?symbol=${encodeURIComponent(sym)}&provider=alpaca`),
      ]);
      if (respYf.ok) {
        const dataYf = await respYf.json() as MarketDataResearchQuote;
        setYfinanceQuote(dataYf);
        setActiveQuote(dataYf);
      }
      if (respAlpaca.ok) {
        const dataAlpaca = await respAlpaca.json() as MarketDataResearchQuote;
        setAlpacaQuote(dataAlpaca);
      }
    } catch {
      // Ignore
    } finally {
      setQuoteLoading(false);
    }
  };

  const loadFundamentals = async (sym: string) => {
    setFundamentalsLoading(true);
    try {
      const resp = await fetch(`/api/market-data/fundamentals?symbol=${encodeURIComponent(sym)}`);
      if (resp.ok) {
        const data = await resp.json() as MarketDataResearchCompanyFundamentals;
        setFundamentals(data);
      }
    } catch {
      // Ignore
    } finally {
      setFundamentalsLoading(false);
    }
  };

  const loadHistoricalBars = async (sym: string, timeframe: string, limit: number, provider: "yfinance" | "alpaca" = barProvider) => {
    setBarsLoading(true);
    try {
      const resp = await fetch(`/api/market-data/bars?symbol=${encodeURIComponent(sym)}&timeframe=${encodeURIComponent(timeframe)}&limit=${limit}&provider=${provider}`);
      if (resp.ok) {
        const data = await resp.json() as { count: number; bars: MarketDataResearchHistoricalBar[]; source?: string; timestamp?: string; provider?: string; provenance?: MarketDataResearchProvenance };
        setBars(data.bars || []);
        setBarsMeta({ source: data.source, timestamp: data.timestamp, provider: data.provider, provenance: data.provenance ?? data.bars?.[0]?.provenance });
      }
    } catch {
      // Ignore
    } finally {
      setBarsLoading(false);
    }
  };

  const loadAlpacaTraces = async () => {
    setTracesLoading(true);
    try {
      const resp = await fetch("/api/audit?limit=50");
      if (resp.ok) {
        const data = await resp.json() as any;
        const events = Array.isArray(data?.events) ? data.events : [];
        const alpacaEvents = events.filter((e: any) =>
          e.type?.startsWith("alpaca") || e.agent === "trading" || e.agent === "research"
        );
        setAlpacaTraces(alpacaEvents);
      }
    } catch {
      // Ignore
    } finally {
      setTracesLoading(false);
    }
  };

  const loadAlpacaAccountAndPositions = async () => {
    setAlpacaAccountLoading(true);
    try {
      const [accRes, posRes] = await Promise.all([
        fetch("/api/market-data/alpaca/account").catch(() => null),
        fetch("/api/market-data/alpaca/positions").catch(() => null),
      ]);
      if (accRes && accRes.ok) {
        const accData = await accRes.json() as any;
        setAlpacaAccount(accData.account || accData);
      }
      if (posRes && posRes.ok) {
        const posData = await posRes.json() as any;
        setAlpacaPositions(posData.positions || []);
      }
      await loadAlpacaTraces();
    } catch {
      // Ignore
    } finally {
      setAlpacaAccountLoading(false);
    }
  };

  const loadAlpacaSnapshot = async (sym: string) => {
    setSnapshotLoading(true);
    try {
      const resp = await fetch(`/api/market-data/snapshot?symbol=${encodeURIComponent(sym)}`);
      if (resp.ok) {
        const data = await resp.json() as AlpacaMarketSnapshot;
        setSnapshot(data);
      }
      await loadAlpacaTraces();
    } catch {
      // Ignore
    } finally {
      setSnapshotLoading(false);
    }
  };

  const runComparison = async (symbolsStr: string) => {
    setCompareLoading(true);
    const syms = symbolsStr.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    try {
      const resp = await fetch("/api/market-data/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: syms }),
      });
      if (resp.ok) {
        const data = await resp.json() as { count: number; comparison: Array<{ symbol: string; quote: MarketDataResearchQuote; fundamentals: MarketDataResearchCompanyFundamentals }> };
        setComparisonResults(data.comparison || []);
      }
    } catch {
      // Ignore
    } finally {
      setCompareLoading(false);
    }
  };

  const askInChat = (prompt = nlqQuery) => {
    const query = prompt.trim();
    if (query) onSendPrompt?.(query, `Yahoo Finance Research · ${subTab}`);
  };

  const copyDidToClipboard = (did: string) => {
    navigator.clipboard.writeText(did);
    setCopiedDid(true);
    setTimeout(() => setCopiedDid(false), 2000);
  };

  const getRecommendationBadgeClass = (rec?: string) => {
    if (!rec) return "rec-hold";
    const lower = rec.toLowerCase();
    if (lower.includes("strong_buy") || lower.includes("strong buy")) return "rec-strong-buy";
    if (lower.includes("buy")) return "rec-buy";
    if (lower.includes("underperform") || lower.includes("sell")) return "rec-sell";
    return "rec-hold";
  };

  return (
    <div className="market-data-research-hub">
      <PageShell
        title="Market Data Research & Quoting Engine"
        scopeNote="Zero-credential Yahoo Finance and Alpaca dual feed, fundamental peer comparison"
      >
      <div>
        <div className="provider-status-chips">
          <span className="chip-provider yf">
            <span className="dot yf-dot" /> Yahoo Finance Engine
          </span>
          <span className="chip-provider alpaca">
            <span className="dot alpaca-dot" /> Alpaca Data v2 (Paper &amp; Live)
          </span>
        </div>

        {/* Research Agent DID Box */}
        <div className="research-did-cluster">
          <div className="did-box">
            <span className="metric-label">Research Agent DID</span>
            <div className="did-attest-row">
              <code className="did-snippet" title={researchAgentDid}>
                did:agent:…:research
              </code>
              <Button
                type="button"
                className="btn-tiny-copy"
                onClick={() => copyDidToClipboard(researchAgentDid)}
                title="Copy W3C Agent DID"
              >
                {copiedDid ? "✓" : "📋"}
              </Button>
            </div>
            <span className="did-verified-tag">🛡️ Cryptographic Research Attestation</span>
          </div>
        </div>
      </div>

      <PageSection>
      {/* Symbol Search & Selector Bar */}
      <div className="symbol-selector-bar">
        <div className="active-ticker-display">
          <span className="active-ticker-label">Active Symbol:</span>
          <span className="active-ticker-badge">{activeSymbol}</span>
          <span className="active-company-name">{activeQuote?.companyName || "Loading…"}</span>
        </div>

        <div className="symbol-input-group">
          <TextInput
            type="text"
            className="symbol-search-input"
            placeholder="Search ticker (e.g. AAPL, MSFT, BTC/USD)"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && symbolInput.trim()) {
                handleAnalyzeTicker(symbolInput.trim());
              }
            }}
          />
          <Button
            type="button"
            className="btn-load-symbol"
            onClick={() => {
              if (symbolInput.trim()) handleAnalyzeTicker(symbolInput.trim());
            }}
          >
            🔍 Analyze Ticker
          </Button>
          {onTradeSymbol && (
            <Button
              type="button"
              className="btn-trade-etrade"
              title="Trade this symbol via E*TRADE"
              onClick={() => onTradeSymbol(activeSymbol)}
            >
              ⚡ Trade on E*TRADE →
            </Button>
          )}
        </div>
      </div>

      {/* Universal Capability Navigation Bar */}
      <CapabilityNavBar
        ariaLabel="Research &amp; Due Diligence Modes"
        activeTabId={subTab}
        onTabChange={handleTabChange}
        tabs={[
          {
            id: "screener",
            label: "Yahoo Screener",
            icon: "🔍",
            tooltip: {
              eyebrow: "MARKET DATA SCREENER",
              title: "Yahoo Finance Screener",
              description: "Filter active stocks, top gainers, and top losers without requiring broker credentials.",
            },
          },
          {
            id: "report",
            label: "Research Report",
            icon: "🔬",
            badge: "AI",
            badgeType: "cyan",
            tooltip: {
              eyebrow: "AI RESEARCH ENGINE",
              title: "Autonomous Research Report",
              description: "Deep AI-generated equity research synthesizing fundamentals, news, valuations, and risk factors.",
            },
          },
          {
            id: "quoting",
            label: "Multi-Provider Quotes",
            icon: "📊",
            tooltip: {
              eyebrow: "REAL-TIME QUOTE AGGREGATION",
              title: "Multi-Provider Quoting",
              description: "Compare bid/ask spreads, volume, and Level 1 quotes across Yahoo Finance and Alpaca.",
            },
          },
          {
            id: "fundamentals",
            label: "Fundamentals & Valuations",
            icon: "⚖️",
            tooltip: {
              eyebrow: "FINANCIAL METRICS",
              title: "Fundamentals & Valuations",
              description: "Analyze balance sheets, P/E ratios, EBITDA, cash flow, and valuation multiples.",
            },
          },
          {
            id: "bars",
            label: "Historical Price Bars",
            icon: "📈",
            badge: bars.length > 0 ? String(bars.length) : undefined,
            badgeType: "default",
            tooltip: {
              eyebrow: "PRICE TIME-SERIES",
              title: "Historical OHLCV Bars",
              description: "Interactive historical candlesticks, moving averages, and volume across multiple timeframes.",
            },
          },
          {
            id: "snapshot",
            label: "Alpaca Snapshot",
            icon: "⚡",
            tooltip: {
              eyebrow: "MARKET SNAPSHOT API",
              title: "Alpaca Market Snapshot",
              description: "Live minute-by-minute bar snapshots and latest trades via Alpaca Market Data v2.",
            },
          },
          {
            id: "compare",
            label: "Peer Comparison",
            icon: "🔄",
            tooltip: {
              eyebrow: "PEER GROUP BENCHMARKING",
              title: "Multi-Stock Valuation Comparison",
              description: "Side-by-side comparison of valuation metrics, margins, and performance for multiple tickers.",
            },
          },
        ]}
        rightContent={<CopilotTriggerButton label="✨ Ask Copilot" />}
      />

      {/* SUBTAB 0: YAHOO FINANCE LIVE MARKET SCREENER */}
      {subTab === "screener" && (
        <div className="research-section screener-section">
          <div className="section-intro-card">
            <div className="section-intro-card-header">
              <div>
                <h3 className="section-intro-title">
                  📊 Yahoo Finance Live Market Screener
                </h3>
                <p className="section-intro-desc">
                  Real-time Level 1 quotes, daily changes, dynamic RSI-14 momentum, and institutional P/E valuations powered 100% by Yahoo Finance API.
                </p>
              </div>
              <div className="section-intro-actions">
                <Button variant="secondary"
                  type="button"
                  onClick={() => fetchScreener()}
                  disabled={screenerLoading}
                 loading={screenerLoading}>
                  <span className={screenerLoading ? "strat-spin" : ""}>🔄</span>
                  {"Refresh Screener"}
                </Button>
              </div>
            </div>
          </div>

          {/* Active Ticker Dual-Feed & Alpaca Real-Time Intelligence Card (On-Page Screener Integration) */}
          <div className="active-ticker-dual-card">
            <div className="dual-card-top-bar">
              <div className="dual-card-title-group">
                <span className="dual-card-symbol">
                  {activeSymbol}
                </span>
                <span className="dual-card-company">
                  {activeQuote?.companyName || activeQuote?.name || yfinanceQuote?.companyName || yfinanceQuote?.name || `${activeSymbol} Equity`}
                </span>
                <span className="dual-card-status-pill">
                  Active Analyzed Security
                </span>
              </div>
              <div className="dual-card-status-group">
                <span className="dual-card-live-tag yahoo-live">
                  <span className={`status-dot ${yfinanceQuote?.provenance === "live" ? "green" : "amber"}`} />
                  {yfinanceQuote?.provenance === "live" ? "Yahoo Finance Live" : "Yahoo Finance — non-live market data"}
                </span>
                <span className="dual-card-live-tag alpaca-live">
                  <span className="status-dot amber" />
                  Alpaca Market Data v2 (On-Page)
                </span>
                <Button variant="accent" tone="subtle" size="sm"
                  type="button"
                  onClick={() => loadAllSymbolData(activeSymbol)}
                  disabled={quoteLoading || snapshotLoading}
                 loading={quoteLoading || snapshotLoading}>
                  {"🔄 Refresh Dual Feeds"}
                </Button>
              </div>
            </div>

            {/* Same-profile disclosure (#117): when neither feed is live,
                both cards show the SAME market-data profile — say so plainly
                instead of presenting two independent live sources. */}
            {yfinanceQuote && alpacaQuote && yfinanceQuote.provenance !== "live" && alpacaQuote.provenance !== "live" && (
              <div
                role="note"
                style={{
                  margin: "0.25rem 0 0.5rem",
                  padding: "var(--space-2) var(--space-2-5)",
                  borderRadius: "8px",
                  border: "1px solid var(--color-warning)",
                  color: "var(--color-warning)",
                  fontSize: "var(--font-size-caption)",
                  fontWeight: 600,
                }}
              >
                ⚠ Both feeds are currently serving the same non-live market-data profile for {activeSymbol} — they are not two independent live sources.
              </div>
            )}

            {/* Dual Feed Columns: Yahoo Finance & Alpaca side-by-side */}
            <div className="dual-feed-columns-grid">
              {/* Yahoo Finance Card */}
              <div className="dual-feed-card yahoo-card">
                <div className="dual-feed-card-header">
                  <span className="dual-feed-card-title yahoo-title">
                    📊 Yahoo Finance Feed
                  </span>
                  <span style={{ display: "inline-flex", gap: "var(--space-1-5)", alignItems: "center" }}>
                    <MarketDataResearchProvenanceBadge provenance={yfinanceQuote?.provenance} note={yfinanceQuote?.note} />
                    <span className="dual-feed-market-state">
                      {yfinanceQuote?.marketState || "REGULAR"}
                    </span>
                  </span>
                </div>
                <div className="dual-feed-price-row">
                  <span className="dual-feed-price-val">
                    ${Number(yfinanceQuote?.price || activeQuote?.price || 0).toFixed(2)}
                  </span>
                  <span className={`dual-feed-change-val ${(yfinanceQuote?.change || 0) >= 0 ? "gain" : "loss"}`}>
                    {(yfinanceQuote?.change || 0) >= 0 ? "+" : ""}{Number(yfinanceQuote?.change || 0).toFixed(2)} ({Number(yfinanceQuote?.changePercent || 0).toFixed(2)}%)
                  </span>
                </div>
                <div className="dual-feed-stats-grid">
                  <div>
                    <span className="dual-feed-stat-label">Bid / Ask: </span>
                    <strong className="dual-feed-stat-val">${Number(yfinanceQuote?.bid || 0).toFixed(2)} / ${Number(yfinanceQuote?.ask || 0).toFixed(2)}</strong>
                  </div>
                  <div>
                    <span className="dual-feed-stat-label">Day Range: </span>
                    <strong className="dual-feed-stat-val">${Number(yfinanceQuote?.low ?? yfinanceQuote?.dayLow ?? 0).toFixed(2)} - ${Number(yfinanceQuote?.high ?? yfinanceQuote?.dayHigh ?? 0).toFixed(2)}</strong>
                  </div>
                  <div>
                    <span className="dual-feed-stat-label">Volume: </span>
                    <strong className="dual-feed-stat-val">{Number(yfinanceQuote?.volume || 0).toLocaleString()}</strong>
                  </div>
                  <div>
                    <span className="dual-feed-stat-label">P/E Ratio: </span>
                    <strong className="dual-feed-stat-val">{yfinanceQuote?.trailingPE || yfinanceQuote?.peRatio ? Number(yfinanceQuote?.trailingPE || yfinanceQuote?.peRatio).toFixed(1) : "N/A"}</strong>
                  </div>
                </div>
              </div>

              {/* Alpaca Market Data v2 Card */}
              <div className="dual-feed-card alpaca-card">
                <div className="dual-feed-card-header">
                  <span className="dual-feed-card-title alpaca-title">
                    🦙 Alpaca Market Data v2
                  </span>
                  <span style={{ display: "inline-flex", gap: "var(--space-1-5)", alignItems: "center" }}>
                    <MarketDataResearchProvenanceBadge provenance={alpacaQuote?.provenance ?? snapshot?.provenance} note={alpacaQuote?.note ?? snapshot?.note} />
                    <span className="dual-feed-snapshot-badge">
                      {snapshot ? (snapshot.provenance === "live" ? "Live Snapshot" : "Market Data Profile Snapshot") : "Alpaca Feed"}
                    </span>
                  </span>
                </div>
                <div className="dual-feed-price-row">
                  <span className="dual-feed-price-val">
                    ${Number(alpacaQuote?.price || snapshot?.latestTrade?.price || yfinanceQuote?.price || 0).toFixed(2)}
                  </span>
                  <span className="dual-feed-nbbo-val">
                    NBBO Spread: <strong>{alpacaQuote?.ask && alpacaQuote?.bid ? `$${(alpacaQuote.ask - alpacaQuote.bid).toFixed(3)}` : "—"}</strong>
                  </span>
                </div>
                <div className="dual-feed-stats-grid">
                  <div>
                    <span className="dual-feed-stat-label">NBBO Bid/Ask: </span>
                    <strong className="dual-feed-stat-val">${Number(alpacaQuote?.bid || snapshot?.latestQuote?.bidPrice || 0).toFixed(2)} / ${Number(alpacaQuote?.ask || snapshot?.latestQuote?.askPrice || 0).toFixed(2)}</strong>
                  </div>
                  <div>
                    <span className="dual-feed-stat-label">Latest Trade: </span>
                    <strong className="dual-feed-stat-val">{snapshot?.latestTrade ? `$${snapshot.latestTrade.price} (${snapshot.latestTrade.size} shs)` : "Awaiting trade data"}</strong>
                  </div>
                  <div>
                    <span className="dual-feed-stat-label">Minute Bar: </span>
                    <strong className="dual-feed-stat-val">{snapshot?.minuteBar ? `H: $${snapshot.minuteBar.high} L: $${snapshot.minuteBar.low}` : "Aggregating…"}</strong>
                  </div>
                  <div>
                    <span className="dual-feed-stat-label">Daily VWAP: </span>
                    <strong className="dual-feed-stat-val">{snapshot?.dailyBar?.vwap ? `$${Number(snapshot.dailyBar.vwap).toFixed(2)}` : "—"}</strong>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick Action Navigation & Drawer Toggle */}
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center", paddingTop: "var(--space-1)" }}>
              <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-muted)", fontWeight: 600 }}>Deep-Dive Analysis:</span>
              <Button variant="accent" tone="subtle" size="sm"
                type="button"
                onClick={() => handleTabChange("report")}
              >
                🔬 In-Depth AI Research Report →
              </Button>
              <Button variant="warning" size="sm" tone={showAlpacaDrawerOnScreener ? "solid" : "subtle"} aria-pressed={showAlpacaDrawerOnScreener}
                type="button"
                onClick={() => setShowAlpacaDrawerOnScreener(!showAlpacaDrawerOnScreener)}
              >
                {showAlpacaDrawerOnScreener ? "▲ Hide Alpaca Snapshot Drawer" : "▼ Expand Alpaca Snapshot Drawer (On-Page)"}
              </Button>
              <Button variant="secondary" tone="subtle" size="sm"
                type="button"
                onClick={() => handleTabChange("fundamentals")}
              >
                ⚖️ Fundamentals &amp; Multiples →
              </Button>
              <Button variant="trade" tone="subtle" size="sm"
                type="button"
                onClick={() => handleTabChange("bars")}
              >
                📈 Candlestick Bars →
              </Button>
              {onTradeSymbol && (
                <Button variant="trade"
                  type="button"
                  onClick={() => onTradeSymbol(activeSymbol)}
                  style={{ marginLeft: "auto" }}
                >
                  ⚡ Trade {activeSymbol} on E*TRADE
                </Button>
              )}
            </div>

            {/* Expandable Alpaca Snapshot Drawer right inside the Screener page */}
            {showAlpacaDrawerOnScreener && snapshot && (
              <div style={{ background: "var(--color-surface-sunken)", border: "1px dashed var(--color-warning)", borderRadius: "10px", padding: "var(--space-4)", marginTop: "0.5rem" }}>
                <h4 style={{ margin: "0 0 0.5rem", color: "var(--color-warning)", fontSize: "var(--font-size-body)" }}>
                  🦙 Alpaca Market Snapshot {snapshot.provenance === "live" ? "Live" : "Market Data Profile"} Inspection — {activeSymbol}
                </h4>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--space-3)", fontSize: "var(--font-size-body-sm)" }}>
                  <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border-subtle)", padding: "var(--space-2-5)", borderRadius: "6px" }}>
                    <div style={{ color: "var(--color-text-muted)" }}>Latest Execution Trade</div>
                    <div style={{ fontWeight: 700, color: "var(--color-text-primary)", fontSize: "1rem" }}>
                      ${snapshot.latestTrade?.price || "N/A"}
                    </div>
                    <div style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-dim)" }}>
                      Size: {snapshot.latestTrade?.size || 0} • {snapshot.latestTrade?.timestamp || "live"}
                    </div>
                  </div>
                  <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border-subtle)", padding: "var(--space-2-5)", borderRadius: "6px" }}>
                    <div style={{ color: "var(--color-text-muted)" }}>Minute Bar Snapshot</div>
                    <div style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>
                      Close: ${snapshot.minuteBar?.close || "N/A"}
                    </div>
                    <div style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-dim)" }}>
                      O: {snapshot.minuteBar?.open} H: {snapshot.minuteBar?.high} L: {snapshot.minuteBar?.low}
                    </div>
                  </div>
                  <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border-subtle)", padding: "var(--space-2-5)", borderRadius: "6px" }}>
                    <div style={{ color: "var(--color-text-muted)" }}>Daily Bar &amp; VWAP</div>
                    <div style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>
                      VWAP: ${snapshot.dailyBar?.vwap ? Number(snapshot.dailyBar.vwap).toFixed(2) : "N/A"}
                    </div>
                    <div style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-dim)" }}>
                      Volume: {snapshot.dailyBar?.volume?.toLocaleString() || 0}
                    </div>
                  </div>
                  <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border-subtle)", padding: "var(--space-2-5)", borderRadius: "6px" }}>
                    <div style={{ color: "var(--color-text-muted)" }}>Prev Daily Bar</div>
                    <div style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>
                      Close: ${snapshot.prevDailyBar?.close || "N/A"}
                    </div>
                    <div style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-dim)" }}>
                      H: {snapshot.prevDailyBar?.high} L: {snapshot.prevDailyBar?.low}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Screener Controls Bar */}
          <div className="screener-controls-bar" style={{ marginBottom: "1rem" }}>
            <div className="control-item search-item">
              <TextInput label="Search Ticker / Company"
                type="text"
                placeholder="e.g. NVDA, Apple, Semiconductors…"
                value={screenerSearch}
                onChange={(e) => setScreenerSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") fetchScreener();
                }}
              />
            </div>

            <div className="control-item">
              <Select label="Sector"
                value={screenerSector}
                onChange={(e) => {
                  setScreenerSector(e.target.value);
                  fetchScreener({ sector: e.target.value });
                }}
              >
                <option value="all">All Sectors</option>
                <option value="Semiconductors">Semiconductors</option>
                <option value="Technology">Technology</option>
                <option value="Communication Services">Communication Services</option>
                <option value="Consumer Discretionary">Consumer Discretionary</option>
              </Select>
            </div>

            <div className="control-item">
              <FieldShell id="marketdata-quick-presets" label="Quick Presets">
                <div style={{ display: "flex", gap: "var(--space-1-5)" }}>
                  <Button
                    type="button"
                    className={`btn-filter-pill ${screenerGainersOnly ? "active gainers" : ""}`}
                    onClick={() => {
                      const next = !screenerGainersOnly;
                      setScreenerGainersOnly(next);
                      if (next) setScreenerLosersOnly(false);
                      fetchScreener({ gainersOnly: next, losersOnly: false });
                    }}
                  >
                    🚀 Gainers
                  </Button>
                  <Button
                    type="button"
                    className={`btn-filter-pill ${screenerLosersOnly ? "active losers" : ""}`}
                    onClick={() => {
                      const next = !screenerLosersOnly;
                      setScreenerLosersOnly(next);
                      if (next) setScreenerGainersOnly(false);
                      fetchScreener({ losersOnly: next, gainersOnly: false });
                    }}
                  >
                    📉 Losers
                  </Button>
                  <Button
                    type="button"
                    className="btn-filter-pill"
                    onClick={() => {
                      setScreenerSearch("");
                      setScreenerSector("all");
                      setScreenerGainersOnly(false);
                      setScreenerLosersOnly(false);
                      setScreenerMinRsi(undefined);
                      setScreenerMaxRsi(undefined);
                      fetchScreener({ search: "", sector: "all", gainersOnly: false, losersOnly: false, minRsi: undefined, maxRsi: undefined });
                    }}
                  >
                    Reset
                  </Button>
                </div>
              </FieldShell>
            </div>

            <Button
              type="button"
              variant="primary"
              className="btn-run-scan"
              onClick={() => fetchScreener()}
              disabled={screenerLoading}
             loading={screenerLoading}>
              {"🔍 Run Scan"}
            </Button>
          </div>

          {/* Screener Results Meta */}
          <div className="screener-results-header">
            <span>
              <strong>Filtered:</strong> {screenerSummary} • <strong>Matches:</strong> {screenerStocks.length} equities
            </span>
            <span>
              Data Source: <strong>Yahoo Finance Engine</strong> {screenerLastScanned ? `• ${screenerLastScanned}` : ""}
            </span>
          </div>
          {screenerError && <div className="options-error" role="alert">{screenerError}</div>}

          {/* Table */}
          {screenerLoading ? (
            <div className="research-loading-state">
              <span className="spinner-large" />
              <p>Scanning equities universe via Yahoo Finance API…</p>
            </div>
          ) : (
              <Table
                containerClassName="trading-table-container"
                columns={[
                  {
                    key: "security",
                    header: "Security",
                    render: (stock) => (
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        <span style={{ fontWeight: 700, color: "var(--color-accent)" }}>{stock.symbol}</span>
                        <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>{stock.companyName}</span>
                      </div>
                    ),
                  },
                  {
                    key: "sector",
                    header: "Sector",
                    render: (stock) => (
                      <span style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-secondary)" }}>{stock.sector}</span>
                    ),
                  },
                  {
                    key: "price",
                    header: "Price (YF)",
                    align: "right",
                    render: (stock) => (
                      <span style={{ fontWeight: 700 }}>
                        ${Number(stock.lastPrice || stock.price || 0).toFixed(2)}
                      </span>
                    ),
                  },
                  {
                    key: "change",
                    header: "Change (1D)",
                    align: "right",
                    render: (stock) => (
                      <span className={`pill-badge ${stock.change >= 0 ? "positive" : "negative"}`}>
                        {stock.change >= 0 ? "+" : ""}{Number(stock.change || 0).toFixed(2)} ({Number(stock.changePercent || 0).toFixed(2)}%)
                      </span>
                    ),
                  },
                  {
                    key: "pe",
                    header: "P/E Ratio",
                    align: "right",
                    render: (stock) => (
                      <span style={{ color: "var(--color-text-muted)" }}>
                        {stock.peRatio ? Number(stock.peRatio).toFixed(1) : "N/A"}
                      </span>
                    ),
                  },
                  {
                    key: "marketCap",
                    header: "Market Cap",
                    align: "right",
                    render: (stock) => (
                      <span style={{ color: "var(--color-text-muted)" }}>
                        {stock.marketCap ? `$${Number(stock.marketCap).toFixed(1)}B` : "N/A"}
                      </span>
                    ),
                  },
                  {
                    key: "rsi",
                    header: "RSI (14)",
                    align: "center",
                    render: (stock) => (
                      <span className={`pill-badge ${stock.rsi14 > 70 ? "negative" : stock.rsi14 < 35 ? "positive" : "neutral"}`}>
                        {stock.rsi14 ? stock.rsi14.toFixed(1) : "50.0"}
                      </span>
                    ),
                  },
                  {
                    key: "momentum",
                    header: "Momentum Signal",
                    render: (stock) => (
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        <span style={{ fontSize: "var(--font-size-caption)", fontWeight: 600, color: stock.changePercent > 0 ? "var(--color-success)" : "var(--color-warning)" }}>
                          {stock.signal || "RANGE_BOUND"}
                        </span>
                        <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-dim)" }}>
                          Score: {stock.momentumScore || 50}/100
                        </span>
                      </div>
                    ),
                  },
                  {
                    key: "alpaca",
                    header: "Alpaca Feed",
                    align: "center",
                    render: (stock) => (
                      <Button variant="warning" size="sm" tone={activeSymbol === stock.symbol ? "solid" : "subtle"} aria-pressed={activeSymbol === stock.symbol}
                        type="button"
                        title={`Inspect live Alpaca quote & snapshot for ${stock.symbol}`}
                        onClick={() => {
                          setSymbolInput(stock.symbol);
                          handleAnalyzeTicker(stock.symbol);
                        }}
                      >
                        {activeSymbol === stock.symbol && (alpacaQuote?.price || snapshot?.latestTrade?.price)
                          ? `🦙 $${Number(alpacaQuote?.price || snapshot?.latestTrade?.price || 0).toFixed(2)}`
                          : "🦙 Alpaca Quote"}
                      </Button>
                    ),
                  },
                  {
                    key: "actions",
                    header: "Actions",
                    align: "center",
                    render: (stock) => (
                      <div style={{ display: "flex", gap: "var(--space-1-5)", justifyContent: "center" }}>
                        <Button variant="accent" tone="subtle" size="sm"
                          type="button"
                          title="Generate AI Research Report with Yahoo Finance & Alpaca"
                          onClick={() => {
                            setActiveSymbol(stock.symbol);
                            loadAllSymbolData(stock.symbol);
                            handleTabChange("report");
                          }}
                        >
                          🔬 Report
                        </Button>
                        <Button variant="secondary" tone="subtle" size="sm"
                          type="button"
                          title="Inspect Fundamentals & Valuations via Yahoo Finance"
                          onClick={() => {
                            setActiveSymbol(stock.symbol);
                            loadFundamentals(stock.symbol);
                            handleTabChange("fundamentals");
                          }}
                        >
                          ⚖️ Ratios
                        </Button>
                        {onTradeSymbol && (
                          <Button variant="trade" tone="subtle" size="sm"
                            type="button"
                            title="Send to E*TRADE Order Ticket for Execution"
                            onClick={() => onTradeSymbol(stock.symbol)}
                          >
                            ⚡ Trade on E*TRADE
                          </Button>
                        )}
                      </div>
                    ),
                  },
                ]}
                rows={screenerStocks}
                rowKey={(stock) => stock.symbol}
              />
          )}
          <ResearchReportActions
            title={`${activeSymbol} stock research`}
            query={nlqQuery || `Run full market-data research on ${activeSymbol} using yfinance and Alpaca`}
            userLogin={user?.login}
            sheets={[
              { name: "Stock screen data", rows: screenerStocks as Array<Record<string, unknown>> },
              { name: "Screen evaluation", rows: [{
                scannedAt: screenerLastScanned, summary: screenerSummary, matchedCount: screenerStocks.length,
                search: screenerSearch, sector: screenerSector, gainersOnly: screenerGainersOnly,
                losersOnly: screenerLosersOnly, minRsi: screenerMinRsi, maxRsi: screenerMaxRsi,
              }] },
              { name: "Research report", rows: report ? [report as unknown as Record<string, unknown>] : [] },
              { name: "Quotes", rows: [activeQuote, yfinanceQuote, alpacaQuote].filter(Boolean) as unknown as Array<Record<string, unknown>> },
              { name: "Fundamentals", rows: fundamentals ? [fundamentals as unknown as Record<string, unknown>] : [] },
              { name: "Historical bars", rows: bars as unknown as Array<Record<string, unknown>> },
              { name: "Market snapshot", rows: snapshot ? [snapshot as unknown as Record<string, unknown>] : [] },
              { name: "Stock comparison", rows: comparisonResults as unknown as Array<Record<string, unknown>> },
            ]}
          />
        </div>
      )}

      {/* SUBTAB 1: AUTONOMOUS RESEARCH REPORT */}
      {subTab === "report" && (
        <div className="research-section report-section">
          {reportLoading ? (
            <div className="research-loading-state">
              <span className="spinner-large" />
              <p>Synthesizing Yahoo Finance fundamentals, Alpaca pricing, and AI technical summary for {activeSymbol}…</p>
            </div>
          ) : report ? (
            <div className="research-report-layout">
              {/* Report Header Card */}
              <div className="report-main-card">
                <div className="report-card-top">
                  <div className="company-heading">
                    <span className="report-ticker">{report.symbol}</span>
                    <div className="heading-meta">
                      <h4>{report.fundamentals.companyName}</h4>
                      <span className="sector-sub">{report.fundamentals.sector} • {report.fundamentals.industry}</span>
                    </div>
                  </div>

                  <div className="report-price-block">
                    <span className="report-price">${report.quote.price.toFixed(2)}</span>
                    <span className={`report-change ${report.quote.change >= 0 ? "positive" : "negative"}`}>
                      {report.quote.change >= 0 ? "+" : ""}{report.quote.change.toFixed(2)} ({report.quote.changePercent >= 0 ? "+" : ""}{report.quote.changePercent.toFixed(2)}%)
                    </span>
                    <span className="source-tag">Source: {report.quote.provider.toUpperCase()} Market Data</span>
                    <MarketDataResearchProvenanceBadge provenance={report.provenance} />
                  </div>
                </div>

                {/* Non-live banner (#117): a report built on static/generated
                    inputs must not read as live research. */}
                {report.provenance !== "live" && (
                  <div
                    role="note"
                    style={{
                      margin: "0.5rem 0",
                      padding: "var(--space-2) var(--space-2-5)",
                      borderRadius: "8px",
                      border: "1px solid var(--color-warning)",
                      color: "var(--color-warning)",
                      fontSize: "var(--font-size-body-sm)",
                      fontWeight: 600,
                    }}
                  >
                    🧪 This report is built from {report.provenance} market data — not live market data. Its target is a profile estimate, not analyst consensus, and its technical levels are heuristic formulas.
                  </div>
                )}

                {/* AI Research Synthesis Narrative */}
                <div className="report-ai-narrative">
                  <div className="narrative-badge">
                    <span>🤖 Autonomous AI Research Synthesis</span>
                  </div>
                  <p className="narrative-text">{report.aiAnalysis}</p>
                </div>

                {/* Quick Key Metrics Grid */}
                <div className="key-metrics-grid">
                  <div className="metric-pill-item">
                    <span className="label">Trailing P/E</span>
                    <span className="value">{report.fundamentals.peTrailing || "N/A"}</span>
                  </div>
                  <div className="metric-pill-item">
                    <span className="label">Forward P/E</span>
                    <span className="value">{report.fundamentals.peForward || "N/A"}</span>
                  </div>
                  <div className="metric-pill-item">
                    <span className="label">PEG Ratio</span>
                    <span className="value">{report.fundamentals.pegRatio || "N/A"}</span>
                  </div>
                  <div className="metric-pill-item">
                    <span className="label">Beta</span>
                    <span className="value">{report.fundamentals.beta || "1.00"}</span>
                  </div>
                  <div className="metric-pill-item">
                    <span className="label">Market Cap</span>
                    <span className="value">${(report.fundamentals.marketCap / 1e9).toFixed(1)}B</span>
                  </div>
                  <div className="metric-pill-item">
                    <span className="label">{report.fundamentals.provenance === "live" ? "Consensus Target" : "Profile Target Estimate"}</span>
                    <span className="value target-highlight">
                      ${report.fundamentals.targetMeanPrice ? report.fundamentals.targetMeanPrice.toFixed(2) : "N/A"}
                    </span>
                  </div>
                </div>

                {/* Technical Overview Cards */}
                <div className="technical-overview-row">
                  <div className="tech-stat-card">
                    <span className="stat-label">14-Day RSI</span>
                    <span className="stat-num">{report.technicalSummary.rsi14}</span>
                    <div className="rsi-meter-bar">
                      <div
                        className="rsi-fill"
                        style={{
                          width: `${Math.min(100, Math.max(0, report.technicalSummary.rsi14))}%`,
                          background: report.technicalSummary.rsi14 < 35 ? "var(--color-success)" : report.technicalSummary.rsi14 > 70 ? "var(--color-danger)" : "var(--color-accent)",
                        }}
                      />
                    </div>
                  </div>
                  <div className="tech-stat-card">
                    <span className="stat-label">MACD Signal</span>
                    <span className="stat-num tech-pill">{report.technicalSummary.macd}</span>
                  </div>
                  <div className="tech-stat-card">
                    <span className="stat-label">50 vs 200 SMA Trend</span>
                    <span className="stat-num tech-pill">{report.technicalSummary.trend50vs200SMA}</span>
                  </div>
                  <div className="tech-stat-card">
                    <span className="stat-label">Support / Resistance</span>
                    <span className="stat-num">${report.technicalSummary.support} / ${report.technicalSummary.resistance}</span>
                  </div>
                </div>

                {/* W3C Agent DID Attestation Stamp */}
                <div className="report-attestation-footer">
                  <div className="attest-col">
                    <span className="attest-label">Attesting Research Agent:</span>
                    <code>{report.agentAttestation.did}</code>
                  </div>
                  <div className="attest-col">
                    <span className="attest-label">Cryptographic Signature:</span>
                    <code className="sig-snippet">{report.agentAttestation.signature.slice(0, 32)}…</code>
                  </div>
                  <div className="attest-col">
                    <span className="attest-label">Certified Timestamp:</span>
                    <span>{new Date(report.agentAttestation.timestamp).toLocaleString()}</span>
                  </div>
                  <div className="attest-col">
                    <span className="attest-label">Attested Data Provenance:</span>
                    <span>{report.agentAttestation.provenance}</span>
                  </div>
                </div>
              </div>

              {/* Right Side: Analyst Rating & Action Card */}
              <div className="report-side-card">
                <div className="analyst-rating-box">
                  <h5>{report.fundamentals.provenance === "live" ? "Wall Street Consensus" : "Market Data Profile Rating — not live consensus"}</h5>
                  <div className={`rating-big-badge ${getRecommendationBadgeClass(report.analystRating)}`}>
                    {report.analystRating}
                  </div>
                  <div className="target-spread-info">
                    <div className="spread-row">
                      <span>Low Target:</span>
                      <span>${report.fundamentals.targetLowPrice?.toFixed(2) || "N/A"}</span>
                    </div>
                    <div className="spread-row mean">
                      <span>Mean Target:</span>
                      <span>${report.fundamentals.targetMeanPrice?.toFixed(2) || "N/A"}</span>
                    </div>
                    <div className="spread-row">
                      <span>High Target:</span>
                      <span>${report.fundamentals.targetHighPrice?.toFixed(2) || "N/A"}</span>
                    </div>
                    <div className="analyst-count-note">
                      {report.fundamentals.provenance === "live"
                        ? `Based on ${report.fundamentals.numberOfAnalystOpinions || 30} Wall Street analyst ratings`
                        : `Targets and the analyst count come from the ${report.fundamentals.provenance} market-data profile — not live Wall Street data.`}
                    </div>
                  </div>
                </div>

                <div className="company-description-card">
                  <h5>Business Overview</h5>
                  <p>{report.fundamentals.description}</p>
                </div>

                {onTradeSymbol && (
                  <Button
                    type="button"
                    className="btn-side-trade"
                    onClick={() => onTradeSymbol(report.symbol)}
                  >
                    ⚡ Trade {report.symbol} on E*TRADE
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <EmptyState title="No research report available." />
          )}
        </div>
      )}

      {/* SUBTAB 2: MULTI-PROVIDER QUOTING */}
      {subTab === "quoting" && (
        <div className="research-section quoting-section">
          <div className="quoting-comparison-grid">
            {/* Yahoo Finance Quote Card */}
            <div className="provider-quote-card yf-card">
              <div className="quote-card-header">
                <div className="provider-name-row">
                  <span className="dot yf-dot" />
                  <h4>Yahoo Finance Engine</h4>
                </div>
                <span style={{ display: "inline-flex", gap: "var(--space-1-5)", alignItems: "center" }}>
                  <MarketDataResearchProvenanceBadge provenance={yfinanceQuote?.provenance} note={yfinanceQuote?.note} />
                  <span className="provider-tag">yfinance API</span>
                </span>
              </div>

              {yfinanceQuote ? (
                <div className="quote-card-body">
                  <div className="quote-price-row">
                    <span className="big-quote-price">${yfinanceQuote.price.toFixed(2)}</span>
                    <span className={`quote-change-pill ${yfinanceQuote.change >= 0 ? "positive" : "negative"}`}>
                      {yfinanceQuote.change >= 0 ? "+" : ""}{yfinanceQuote.change.toFixed(2)} ({yfinanceQuote.changePercent >= 0 ? "+" : ""}{yfinanceQuote.changePercent.toFixed(2)}%)
                    </span>
                  </div>

                  <div className="quote-detail-grid">
                    <div className="detail-item">
                      <span className="lbl">Bid</span>
                      <span className="val">{yfinanceQuote.bid !== undefined ? `$${yfinanceQuote.bid.toFixed(2)}` : "—"}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Ask</span>
                      <span className="val">{yfinanceQuote.ask !== undefined ? `$${yfinanceQuote.ask.toFixed(2)}` : "—"}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Spread</span>
                      <span className="val">{yfinanceQuote.ask !== undefined && yfinanceQuote.bid !== undefined ? `$${(yfinanceQuote.ask - yfinanceQuote.bid).toFixed(2)}` : "—"}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Open</span>
                      <span className="val">${yfinanceQuote.open.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">High</span>
                      <span className="val">${yfinanceQuote.high.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Low</span>
                      <span className="val">${yfinanceQuote.low.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Volume</span>
                      <span className="val">{(yfinanceQuote.volume / 1e6).toFixed(2)}M</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Prev Close</span>
                      <span className="val">${yfinanceQuote.previousClose.toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="provider-foot">
                    <span>Protocol: Market Data Query Endpoint</span>
                    <span>Updated: {new Date(yfinanceQuote.timestamp).toLocaleTimeString()}</span>
                  </div>
                </div>
              ) : quoteLoading ? (
                <Spinner size="lg" label="Loading Yahoo Finance quote" />
              ) : (
                <EmptyState title="No Yahoo Finance quote available" />
              )}
            </div>

            {/* Alpaca Market Data v2 Quote Card */}
            <div className="provider-quote-card alpaca-card">
              <div className="quote-card-header">
                <div className="provider-name-row">
                  <span className="dot alpaca-dot" />
                  <h4>Alpaca Market Data v2</h4>
                </div>
                <span style={{ display: "inline-flex", gap: "var(--space-1-5)", alignItems: "center" }}>
                  <MarketDataResearchProvenanceBadge provenance={alpacaQuote?.provenance} note={alpacaQuote?.note} />
                  <span className="provider-tag">Level 1/2 REST &amp; Paper</span>
                </span>
              </div>

              {alpacaQuote ? (
                <div className="quote-card-body">
                  <div className="quote-price-row">
                    <span className="big-quote-price">${alpacaQuote.price.toFixed(2)}</span>
                    <span className={`quote-change-pill ${alpacaQuote.change >= 0 ? "positive" : "negative"}`}>
                      {alpacaQuote.change >= 0 ? "+" : ""}{alpacaQuote.change.toFixed(2)} ({alpacaQuote.changePercent >= 0 ? "+" : ""}{alpacaQuote.changePercent.toFixed(2)}%)
                    </span>
                  </div>

                  <div className="quote-detail-grid">
                    <div className="detail-item">
                      <span className="lbl">NBBO Bid</span>
                      <span className="val">{alpacaQuote.bid !== undefined ? `$${alpacaQuote.bid.toFixed(2)}` : "—"} ({alpacaQuote.bidSize} shs)</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">NBBO Ask</span>
                      <span className="val">{alpacaQuote.ask !== undefined ? `$${alpacaQuote.ask.toFixed(2)}` : "—"} ({alpacaQuote.askSize} shs)</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Spread</span>
                      <span className="val">{alpacaQuote.ask !== undefined && alpacaQuote.bid !== undefined ? `$${(alpacaQuote.ask - alpacaQuote.bid).toFixed(2)}` : "—"}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">VWAP</span>
                      <span className="val">${alpacaQuote.vwap ? alpacaQuote.vwap.toFixed(2) : alpacaQuote.price.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Day High</span>
                      <span className="val">${alpacaQuote.high.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Day Low</span>
                      <span className="val">${alpacaQuote.low.toFixed(2)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Volume</span>
                      <span className="val">{(alpacaQuote.volume / 1e6).toFixed(2)}M</span>
                    </div>
                    <div className="detail-item">
                      <span className="lbl">Prev Close</span>
                      <span className="val">${alpacaQuote.previousClose.toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="provider-foot">
                    <span>Protocol: Alpaca v2 Data Gateway</span>
                    <span>Updated: {new Date(alpacaQuote.timestamp).toLocaleTimeString()}</span>
                  </div>
                </div>
              ) : quoteLoading ? (
                <Spinner size="lg" label="Loading Alpaca quote" />
              ) : (
                <EmptyState title="No Alpaca quote available" />
              )}
            </div>
          </div>
        </div>
      )}

      {/* SUBTAB 3: FUNDAMENTALS & VALUATIONS */}
      {subTab === "fundamentals" && (
        <div className="research-section fundamentals-section">
          {fundamentalsLoading ? (
            <div className="research-loading-state">
              <span className="spinner-large" />
              <p>Extracting financial ratios and balance sheet metrics from Yahoo Finance…</p>
            </div>
          ) : fundamentals ? (
            <div className="fundamentals-layout">
              <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginBottom: "0.5rem" }}>
                <MarketDataResearchProvenanceBadge provenance={fundamentals.provenance} note={fundamentals.note} />
                {fundamentals.provenance !== "live" && (
                  <span style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
                    {fundamentals.note || "Fundamentals below are not live provider data."}
                  </span>
                )}
              </div>
              {/* Valuation Multiples */}
              <div className="fund-card">
                <h5>📊 Valuation Multiples (yfinance)</h5>
                <div className="fund-grid">
                  <div className="fund-item">
                    <span className="lbl">Market Capitalization</span>
                    <span className="val">${(fundamentals.marketCap / 1e9).toFixed(1)}B</span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Enterprise Value</span>
                    <span className="val">
                      {fundamentals.enterpriseValue ? `$${(fundamentals.enterpriseValue / 1e9).toFixed(1)}B` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Trailing P/E</span>
                    <span className="val">{fundamentals.peTrailing || "N/A"}</span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Forward P/E</span>
                    <span className="val">{fundamentals.peForward || "N/A"}</span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">PEG Ratio (5-yr expected)</span>
                    <span className="val">{fundamentals.pegRatio || "N/A"}</span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Price to Book (MRQ)</span>
                    <span className="val">{fundamentals.priceToBook || "N/A"}</span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Beta (5-yr monthly)</span>
                    <span className="val">{fundamentals.beta || "1.00"}</span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Dividend Yield</span>
                    <span className="val">{fundamentals.dividendYield ? `${fundamentals.dividendYield}%` : "0.00%"}</span>
                  </div>
                </div>
              </div>

              {/* Financial Performance & Margins */}
              <div className="fund-card">
                <h5>💰 Financial Performance &amp; Margins</h5>
                <div className="fund-grid">
                  <div className="fund-item">
                    <span className="lbl">Total Revenue (TTM)</span>
                    <span className="val">
                      {fundamentals.revenue ? `$${(fundamentals.revenue / 1e9).toFixed(1)}B` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Gross Profit (TTM)</span>
                    <span className="val">
                      {fundamentals.grossProfits ? `$${(fundamentals.grossProfits / 1e9).toFixed(1)}B` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">EBITDA</span>
                    <span className="val">
                      {fundamentals.ebitda ? `$${(fundamentals.ebitda / 1e9).toFixed(1)}B` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Free Cash Flow</span>
                    <span className="val">
                      {fundamentals.freeCashflow ? `$${(fundamentals.freeCashflow / 1e9).toFixed(1)}B` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Profit Margin</span>
                    <span className="val">
                      {fundamentals.profitMargins ? `${(fundamentals.profitMargins * 100).toFixed(1)}%` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Operating Margin</span>
                    <span className="val">
                      {fundamentals.operatingMargins ? `${(fundamentals.operatingMargins * 100).toFixed(1)}%` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">Return on Equity</span>
                    <span className="val">
                      {fundamentals.returnOnEquity ? `${(fundamentals.returnOnEquity * 100).toFixed(1)}%` : "N/A"}
                    </span>
                  </div>
                  <div className="fund-item">
                    <span className="lbl">52-Week Range</span>
                    <span className="val">${fundamentals.fiftyTwoWeekLow.toFixed(2)} - ${fundamentals.fiftyTwoWeekHigh.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <EmptyState title="No fundamentals data available." />
          )}
        </div>
      )}

      {/* SUBTAB 4: HISTORICAL OHLCV BARS */}
      {subTab === "bars" && (
        <div className="research-section bars-section">
          <div className="bars-controls-row">
            <span className="bars-title">
              Historical OHLCV Bars for <strong>{activeSymbol}</strong>
            </span>
            <div className="bars-filters">
              <Select label="Feed:"
                value={barProvider}
                onChange={(e) => {
                  const p = e.target.value as "yfinance" | "alpaca";
                  setBarProvider(p);
                  loadHistoricalBars(activeSymbol, barTimeframe, barLimit, p);
                }}
              >
                <option value="yfinance">Yahoo Finance</option>
                <option value="alpaca">Alpaca Data v2</option>
              </Select>
              <Select label="Timeframe:"
                value={barTimeframe}
                onChange={(e) => {
                  const tf = e.target.value;
                  setBarTimeframe(tf);
                  loadHistoricalBars(activeSymbol, tf, barLimit, barProvider);
                }}
              >
                <option value="1D">Daily (1D)</option>
                <option value="1W">Weekly (1W)</option>
                <option value="1M">Monthly (1M)</option>
                <option value="1H">Hourly (1H)</option>
              </Select>
              <Select label="Limit:"
                value={barLimit}
                onChange={(e) => {
                  const l = Number(e.target.value);
                  setBarLimit(l);
                  loadHistoricalBars(activeSymbol, barTimeframe, l, barProvider);
                }}
              >
                <option value={15}>15 Bars</option>
                <option value={30}>30 Bars</option>
                <option value={60}>60 Bars</option>
                <option value={90}>90 Bars</option>
              </Select>
              <Button variant="secondary" size="sm"
                type="button"
                disabled={barsLoading}
                onClick={() => loadHistoricalBars(activeSymbol, barTimeframe, barLimit, barProvider)}
                title="Refresh live market bars" style={{ marginLeft: "0.25rem" }}
               loading={barsLoading}>
                {"↻ Refresh"}
              </Button>
            </div>
          </div>

          {barsMeta && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "0.5rem 0.25rem 0.75rem 0.25rem", fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
              <span style={{ display: "inline-flex", gap: "var(--space-2)", alignItems: "center" }}>
                <span>
                  📡 Source: <strong style={{ color: "var(--color-accent)" }}>{barsMeta.source || (barProvider === "alpaca" ? "Alpaca Market Data v2" : "Yahoo Finance Chart API")}</strong>
                </span>
                <MarketDataResearchProvenanceBadge provenance={barsMeta.provenance} />
              </span>
              <span>
                {barsMeta.provenance === "live" ? "Live Synced" : "Retrieved"}: {barsMeta.timestamp ? new Date(barsMeta.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString()}
              </span>
            </div>
          )}
            <Table
            containerClassName="bars-table-wrap"
            columns={[
              { key: "date", header: "Date", render: (bar) => <code>{bar.timestamp}</code> },
              { key: "open", header: "Open", render: (bar) => `$${bar.open.toFixed(2)}` },
              { key: "high", header: "High", render: (bar) => `$${bar.high.toFixed(2)}` },
              { key: "low", header: "Low", render: (bar) => `$${bar.low.toFixed(2)}` },
              {
                key: "close",
                header: "Close",
                render: (bar) => (
                  <span className={`price-tag ${bar.close >= bar.open ? "positive-text" : "negative-text"}`}>
                    ${bar.close.toFixed(2)}
                  </span>
                ),
              },
              {
                key: "vwap",
                header: "VWAP",
                render: (bar) => `$${bar.vwap ? bar.vwap.toFixed(2) : bar.close.toFixed(2)}`,
              },
              { key: "volume", header: "Volume", render: (bar) => `${(bar.volume / 1e6).toFixed(2)}M` },
              {
                key: "trades",
                header: "Trades",
                render: (bar) => (bar.tradeCount ? bar.tradeCount.toLocaleString() : "N/A"),
              },
            ]}
            rows={bars}
            rowKey={(bar, i) => bar.timestamp || String(i)}
            empty={barsLoading ? <Spinner label="Loading historical bars" /> : <EmptyState title="No bars returned." />}
          />
        </div>
      )}

      {/* SUBTAB 5: ALPACA MARKET SNAPSHOT */}
      {subTab === "snapshot" && (
        <div className="research-section snapshot-section">
          {snapshotLoading ? (
            <div className="research-loading-state">
              <span className="spinner-large" />
              <p>Querying real-time Level 1/2 snapshot from Alpaca Market Data v2…</p>
            </div>
          ) : snapshot ? (
            <div className="snapshot-card">
              <div className="snapshot-header">
                <div className="snap-title">
                  <span className="dot alpaca-dot" />
                  <h4>Alpaca Market Data v2 Snapshot: {snapshot.symbol}</h4>
                </div>
                <span style={{ display: "inline-flex", gap: "var(--space-1-5)", alignItems: "center" }}>
                  <MarketDataResearchProvenanceBadge provenance={snapshot.provenance} note={snapshot.note} />
                  <span className="asset-tag">{snapshot.assetClass.toUpperCase()}</span>
                </span>
              </div>

              <div className="snapshot-grid">
                <div className="snap-item">
                  <span className="label">Latest Executed Trade</span>
                  <span className="val big">${snapshot.latestTrade.price.toFixed(2)}</span>
                  <span className="sub">Size: {snapshot.latestTrade.size} shares • {new Date(snapshot.latestTrade.timestamp).toLocaleTimeString()}</span>
                </div>

                <div className="snap-item">
                  <span className="label">NBBO Best Bid / Ask</span>
                  <span className="val">${snapshot.latestQuote.bidPrice.toFixed(2)} / ${snapshot.latestQuote.askPrice.toFixed(2)}</span>
                  <span className="sub">Sizes: {snapshot.latestQuote.bidSize} x {snapshot.latestQuote.askSize}</span>
                </div>

                <div className="snap-item">
                  <span className="label">Daily Bar (Today)</span>
                  <span className="val">${snapshot.dailyBar.low.toFixed(2)} - ${snapshot.dailyBar.high.toFixed(2)}</span>
                  <span className="sub">Vol: {(snapshot.dailyBar.volume / 1e6).toFixed(2)}M • VWAP: ${snapshot.dailyBar.vwap ? snapshot.dailyBar.vwap.toFixed(2) : "N/A"}</span>
                </div>

                <div className="snap-item">
                  <span className="label">Previous Daily Bar</span>
                  <span className="val">${snapshot.prevDailyBar.close.toFixed(2)} Close</span>
                  <span className="sub">Range: ${snapshot.prevDailyBar.low.toFixed(2)} - ${snapshot.prevDailyBar.high.toFixed(2)}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="research-loading-state" style={{ opacity: 0.8 }}>
              <p>No snapshot data loaded. Enter a ticker above and click Search Market Data.</p>
            </div>
          )}

          <div className="section-intro-card" style={{ marginTop: "1.5rem" }}>
            <div className="section-intro-card-header" style={{ marginBottom: "0.75rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <span style={{ fontSize: "1.25rem" }}>🛡️</span>
                <h4 className="section-intro-title">
                  Alpaca Agentic Tracing Stream &amp; Provenance Ledger
                </h4>
                <span className="pill-badge positive">
                  W3C DID ATTESTED
                </span>
              </div>
              <Button variant="secondary"
                type="button"
                onClick={loadAlpacaTraces}
                disabled={tracesLoading}
               loading={tracesLoading}>
                {"🔄 Refresh Audit Traces"}
              </Button>
            </div>

            <p className="section-intro-desc" style={{ marginBottom: "1rem" }}>
              Every market inquiry, snapshot lookup, and order routed through Alpaca is cryptographically stamped with Agent DID (<code>did:agent:openaimp:trading</code>) and recorded in the persistent event ledger (<code>mas_events</code>) for end-to-end provenance.
            </p>

            {alpacaTraces.length === 0 ? (
              <div style={{ textAlign: "center", padding: "var(--space-4)", color: "var(--color-text-dim)", fontSize: "var(--font-size-body)", background: "var(--color-surface-sunken)", borderRadius: "8px" }}>
                {tracesLoading ? "Querying audit ledger…" : "No Alpaca traces recorded in this session yet. Run a snapshot or quote query above to generate trace telemetry."}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2-5)", maxHeight: "320px", overflowY: "auto" }}>
                {alpacaTraces.map((tr, idx) => (
                  <div key={tr.id || idx} style={{ background: "var(--color-card)", border: "1px solid var(--color-border-subtle)", borderRadius: "8px", padding: "var(--space-3)", fontSize: "var(--font-size-body)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px", flexWrap: "wrap", gap: "var(--space-1)" }}>
                      <span className="pill-badge" style={{ background: "var(--color-accent-subtle)", color: "var(--color-accent)", borderColor: "var(--color-border-focus)" }}>
                        {tr.type}
                      </span>
                      <span style={{ color: "var(--color-text-dim)", fontSize: "0.75rem" }}>
                        {new Date(tr.created_at).toLocaleTimeString()} ({new Date(tr.created_at).toLocaleDateString()})
                      </span>
                    </div>
                    <div style={{ color: "var(--color-text-secondary)", fontSize: "var(--font-size-body-sm)", wordBreak: "break-all", background: "var(--color-surface)", padding: "var(--space-1-5)", borderRadius: "4px" }}>
                      {typeof tr.payload === "string" ? tr.payload : JSON.stringify(tr.payload)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Antigravity MCP Integration Guide */}
            <div style={{ marginTop: "1.25rem", borderTop: "1px solid var(--color-border-subtle)", paddingTop: "var(--space-4)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <span style={{ fontSize: "var(--font-size-body)", fontWeight: 700, color: "var(--color-text-primary)" }}>
                  ⚡ Antigravity &amp; Agent MCP Server Config (Alpaca)
                </span>
                <Button variant="accent"
                  type="button"
                  onClick={() => {
                    const cfg = JSON.stringify({
                      mcpServers: {
                        alpaca: {
                          command: "uvx",
                          args: ["alpaca-mcp-server"],
                          env: {
                            ALPACA_API_KEY: "your_alpaca_api_key",
                            ALPACA_SECRET_KEY: "your_alpaca_secret_key"
                          }
                        }
                      }
                    }, null, 2);
                    navigator.clipboard.writeText(cfg);
                    setCopiedMcpConfig(true);
                    setTimeout(() => setCopiedMcpConfig(false), 2000);
                  }}
                >
                  {copiedMcpConfig ? "✓ Copied Config!" : "📋 Copy MCP Config"}
                </Button>
              </div>
              <pre style={{ margin: 0, background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "6px", padding: "var(--space-3)", fontSize: "var(--font-size-caption)", color: "var(--color-text-primary)", overflowX: "auto" }}>
{`{
  "mcpServers": {
    "alpaca": {
      "command": "uvx",
      "args": ["alpaca-mcp-server"],
      "env": {
        "ALPACA_API_KEY": "your_alpaca_api_key",
        "ALPACA_SECRET_KEY": "your_alpaca_secret_key"
      }
    }
  }
}`}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* SUBTAB 6: MULTI-STOCK VALUATION COMPARISON */}
      {subTab === "compare" && (
        <div className="research-section compare-section">
          <div className="compare-bar">
            <TextInput label="Compare Tickers:"
              type="text"
              className="compare-input"
              value={compareSymbolsInput}
              onChange={(e) => setCompareSymbolsInput(e.target.value.toUpperCase())}
            />
            <Button
              type="button"
              variant="primary"
              className="btn-run-compare"
              disabled={compareLoading}
              onClick={() => runComparison(compareSymbolsInput)}
             loading={compareLoading}>
              {"⚡ Run Valuation Comparison"}
            </Button>
          </div>
            <Table
            containerClassName="compare-table-wrap"
            columns={[
              {
                key: "symbol",
                header: "Symbol & Company",
                render: ({ symbol, quote, fundamentals: f }) => (
                  <div className="ticker-company">
                    <span className="ticker-badge">{symbol}</span>
                    <span className="company-title">{f.companyName}</span>
                    <MarketDataResearchProvenanceBadge provenance={quote.provenance === "live" && f.provenance === "live" ? "live" : quote.provenance === "generated" || f.provenance === "generated" ? "generated" : "static"} />
                  </div>
                ),
              },
              {
                key: "price",
                header: "Price",
                render: ({ quote }) => <span className="price-tag">${quote.price.toFixed(2)}</span>,
              },
              {
                key: "change",
                header: "24h Change",
                render: ({ quote }) => (
                  <span className={`change-pill ${quote.change >= 0 ? "positive" : "negative"}`}>
                    {quote.change >= 0 ? "+" : ""}{quote.change.toFixed(2)} ({quote.change >= 0 ? "+" : ""}{quote.changePercent.toFixed(2)}%)
                  </span>
                ),
              },
              { key: "marketCap", header: "Market Cap", render: ({ fundamentals: f }) => `$${(f.marketCap / 1e9).toFixed(1)}B` },
              { key: "peTrailing", header: "Trailing P/E", render: ({ fundamentals: f }) => f.peTrailing || "N/A" },
              { key: "peForward", header: "Forward P/E", render: ({ fundamentals: f }) => f.peForward || "N/A" },
              { key: "peg", header: "PEG Ratio", render: ({ fundamentals: f }) => f.pegRatio || "N/A" },
              { key: "pb", header: "Price/Book", render: ({ fundamentals: f }) => f.priceToBook || "N/A" },
              { key: "beta", header: "Beta", render: ({ fundamentals: f }) => f.beta || "1.00" },
              {
                key: "target",
                header: "Target (Mean)",
                render: ({ fundamentals: f }) => (
                  <span className="target-val">${f.targetMeanPrice?.toFixed(2) || "N/A"}</span>
                ),
              },
              {
                key: "rating",
                header: "Analyst Rating",
                render: ({ fundamentals: f }) => (
                  <span className={`rec-badge ${getRecommendationBadgeClass(f.recommendationKey)}`}>
                    {f.recommendationKey?.toUpperCase() || "BUY"}
                  </span>
                ),
              },
            ]}
            rows={comparisonResults}
            rowKey={({ symbol }) => symbol}
            empty={compareLoading ? <Spinner label="Gathering multi-stock metrics" /> : <EmptyState title="No stocks to compare." />}
          />
        </div>
      )}
    </PageSection>
    </PageShell>
    </div>
  );
}
