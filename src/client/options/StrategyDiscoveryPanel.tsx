import React, { useEffect, useMemo, useState, useRef } from "react";
import {
  generateExpirations,
  generateStrikeLadder,
  evaluateStrategyPnL,
  getOptimizationFactors,
  updateLegStrike,
  updateLegsExpiration,
  analyzeStrategy,
  calculateNetGreeks,
  calculateRealizedAndUnrealizedPnl,
  evaluate2dPayoffMatrix,
  shiftAllStrikes,
  shiftSymmetricStrikes,
  type DiscoveredStrategy,
  type ExpirationOption,
  type SentimentType,
  type StrategyLegItem,
  type StrategyDiscoveryConfig,
  type NetOptionGreeks,
  type RealizedUnrealizedPnl,
  type Matrix2dCell,
  type Matrix2dRow,
} from "./strategyDiscoveryEngine";
import {
  buildStrategyRequest,
  fetchServerDiscovery,
  fetchServerCatalog,
  type ServerCatalogResult,
  type ServerDiscoveryInputs,
} from "./serverDiscovery";
import { etToUtcCron } from "./cronTime";
import { buildDiscoveryCaptureSubmission } from "../scheduledOptionsManager/payloadBuilders";
import {
  STRATEGY_LIBRARY,
  type StrategyDefinition,
} from "./strategyLibrary";
import {
  calculateProbabilityDensityPoints,
  calculateProbabilityAboveBelow,
} from "./blackScholes";
import { apiFetch as fetch } from "../apiFetch";
import { UniversalChart } from "../components/UniversalChart";
import { LlmStrategyEvalModal, type StrategyToEvaluate } from "./LlmStrategyEvalModal";
import { RiskAnalysisModal } from "./RiskAnalysisModal";
import type { RiskSubject } from "./riskManagementEngine";
import { OptionsDataDownloadDropdown } from "./OptionsDataDownloadDropdown";
import type { TradeOrderContext } from "../trading/tradeOrderContext";
import "./strategyDiscovery.css";
import { StrategyLibraryModal, type StrategyInfo } from "./StrategyLibraryModal";
import { Button, FieldShell, PillGroup, SegmentedControl, Select, Table, TextInput, Modal, useToast } from "../components/ui";

const SENTIMENT_ITEMS: Array<{
  id: SentimentType;
  label: string;
  icon: React.ReactNode;
}> = [
  {
    id: "all",
    label: "ALL",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3v18M3 12h18M6.3 6.3l11.4 11.4M6.3 17.7L17.7 6.3" />
      </svg>
    ),
  },
  {
    id: "very_bearish",
    label: "Very Bearish",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 5l-7 7-7-7" />
        <path d="M19 12l-7 7-7-7" />
      </svg>
    ),
  },
  {
    id: "bearish",
    label: "Bearish",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="7" y1="7" x2="17" y2="17" />
        <polyline points="17 7 17 17 7 17" />
      </svg>
    ),
  },
  {
    id: "neutral",
    label: "Neutral",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
      </svg>
    ),
  },
  {
    id: "directional",
    label: "High Volatility",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="16 3 21 3 21 8" />
        <line x1="4" y1="20" x2="21" y2="3" />
        <polyline points="21 16 21 21 16 21" />
        <line x1="15" y1="15" x2="21" y2="21" />
        <line x1="4" y1="4" x2="9" y2="9" />
      </svg>
    ),
  },
  {
    id: "bullish",
    label: "Bullish",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="7" y1="17" x2="17" y2="7" />
        <polyline points="7 7 17 7 17 17" />
      </svg>
    ),
  },
  {
    id: "very_bullish",
    label: "Very Bullish",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 19l7-7 7 7" />
        <path d="M5 12l7-7 7 7" />
      </svg>
    ),
  },
];

interface StrategyDiscoveryPanelProps {
  initialSymbol?: string;
  activeEnv?: "TEST" | "PROD";
  userLogin?: string;
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  flowTradeBanner?: {
    title: string;
    returnText: string;
    timestamp?: string;
  } | null;
  initialCustomLegs?: StrategyLegItem[];
  initialStrategyName?: string;
  initialExpirationDate?: string;
  onBackToFlows?: () => void;
}

interface StockQuoteState {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  companyName: string;
  delayed: boolean;
}

interface SavedOptionTrade {
  id: string;
  name: string;
  notes?: string;
  createdAt: string;
  symbol: string;
  expirationDate: string;
  dte: number;
  legs: StrategyLegItem[];
  strategyName: string;
  underlyingPriceAtSave: number;
  ivAtSave: number;
}

const STORAGE_KEY_SAVED_TRADES = "etrade_saved_options_trades";

// Popular stock & ETF presets including futures — symbols and names ONLY.
// Issue #924: prices must never come from a hardcoded table. A preset
// carries no price until a live quote is fetched for it; the dropdown
// shows "Quote unavailable" for symbols with no live quote yet.
const POPULAR_SYMBOLS: { symbol: string; companyName: string }[] = [
  { symbol: "TSLA", companyName: "Tesla, Inc." },
  { symbol: "NVDA", companyName: "NVIDIA Corporation" },
  { symbol: "AAPL", companyName: "Apple Inc." },
  { symbol: "SPY", companyName: "SPDR S&P 500 ETF Trust" },
  { symbol: "QQQ", companyName: "Invesco QQQ Trust" },
  { symbol: "MSFT", companyName: "Microsoft Corporation" },
  { symbol: "AMD", companyName: "Advanced Micro Devices" },
  { symbol: "AMZN", companyName: "Amazon.com, Inc." },
  { symbol: "GOOGL", companyName: "Alphabet Inc." },
  { symbol: "META", companyName: "Meta Platforms, Inc." },
  { symbol: "WMT", companyName: "Walmart Inc." },
  { symbol: "IWM", companyName: "iShares Russell 2000 ETF" },
  { symbol: "/ES", companyName: "E-mini S&P 500 Futures" },
  { symbol: "/NQ", companyName: "E-mini Nasdaq 100 Futures" },
];

// URL hash encoding / decoding for Capability 10 (Share Trades)
function encodeTradeToHash(payload: {
  symbol: string;
  expirationDate: string;
  dte: number;
  legs: StrategyLegItem[];
  strategyName: string;
  iv: number;
}): string {
  try {
    const json = JSON.stringify(payload);
    return btoa(unescape(encodeURIComponent(json)));
  } catch {
    return "";
  }
}

function decodeTradeFromHash(hashStr: string): {
  symbol: string;
  expirationDate: string;
  dte: number;
  legs: StrategyLegItem[];
  strategyName: string;
  iv: number;
} | null {
  try {
    const raw = decodeURIComponent(escape(atob(hashStr)));
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Display value for one payoff-matrix cell under the active metric mode (P1, #1835). Pure. */
export function matrixCellDisplay(
  cell: Matrix2dCell,
  metricMode: "pnl_dollar" | "pnl_pct" | "contract_val" | "collateral_pct",
): string {
  if (metricMode === "pnl_dollar") {
    return `${cell.pnlDollar >= 0 ? "+" : ""}$${cell.pnlDollar.toLocaleString()}`;
  } else if (metricMode === "pnl_pct") {
    return `${cell.pnlPercent >= 0 ? "+" : ""}${cell.pnlPercent}%`;
  } else if (metricMode === "collateral_pct") {
    return `${cell.riskPercent >= 0 ? "+" : ""}${cell.riskPercent}%`;
  }
  return `$${cell.contractValue.toLocaleString()}`;
}

/** Heatmap background for one payoff-matrix cell (P1, #1835). Pure. */
export function matrixCellBg(cell: Matrix2dCell, maxPnl: number, minPnl: number): string {
  let cellBg = "var(--color-muted)";
  if (cell.pnlDollar > 0) {
    const intensity = Math.min(0.7, 0.12 + (cell.pnlDollar / (maxPnl || 1)) * 0.58);
    cellBg = `color-mix(in srgb, var(--color-success) ${Math.round(intensity * 100)}%, transparent)`;
  } else if (cell.pnlDollar < 0) {
    const intensity = Math.min(0.7, 0.12 + (Math.abs(cell.pnlDollar) / (Math.abs(minPnl) || 1)) * 0.58);
    cellBg = `color-mix(in srgb, var(--color-danger) ${Math.round(intensity * 100)}%, transparent)`;
  }
  return cellBg;
}

export function StrategyDiscoveryPanel({
  initialSymbol = "TSLA",
  activeEnv = "TEST",
  userLogin,
  onPreviewTrade,
  onSendPrompt,
  flowTradeBanner,
  initialCustomLegs,
  initialStrategyName,
  initialExpirationDate,
  onBackToFlows,
}: StrategyDiscoveryPanelProps) {
  // Navigation View: "discovery" or "builder"
  const [activeView, setActiveView] = useState<"discovery" | "builder">("builder");

  // LLM Strategy Evaluation Modal State
  const [evaluatingStrategy, setEvaluatingStrategy] = useState<StrategyToEvaluate | null>(null);

  // Risk Analysis Modal State
  const [riskSubject, setRiskSubject] = useState<RiskSubject | null>(null);

  // Core ticker state
  const [symbolInput, setSymbolInput] = useState(initialSymbol);
  const [activeSymbol, setActiveSymbol] = useState(initialSymbol.toUpperCase());
  const [showSymbolSearchMenu, setShowSymbolSearchMenu] = useState(false);
  const [customStrategyName, setCustomStrategyName] = useState<string | null>(initialStrategyName || null);
  const [isFlowBannerDismissed, setIsFlowBannerDismissed] = useState<boolean>(false);
  // Issue #924: initial quote state is EMPTY, never priced. A quote exists
  // only after a live fetch succeeds; the cache holds live-fetched quotes
  // only — never static presets or invented values.
  const [quote, setQuote] = useState<StockQuoteState | null>(null);
  const [quotesCache, setQuotesCache] = useState<Record<string, StockQuoteState>>({});
  // Explicit quote-failure state: null while loading, set on failure.
  const [quoteError, setQuoteError] = useState<string | null>(null);
  // Symbol awaiting its first live quote so its target price can be derived
  // from the live price on arrival (never from a preset). Cleared once the
  // target is set, so later refreshes never override a user-set target.
  const pendingTargetSymbolRef = useRef<string | null>(initialSymbol.toUpperCase());

  // Expirations schedule
  const expirations = useMemo(() => generateExpirations(), []);
  const [selectedExpiration, setSelectedExpiration] = useState<ExpirationOption>(
    expirations[6] || expirations[0]
  );

  // Sentiment selector
  const [sentiment, setSentiment] = useState<SentimentType>("bullish");

  // Target price state — 0 (unset) until a live quote arrives, at which
  // point fetchQuoteData derives it from the live price for the pending
  // symbol (issue #924: never from a hardcoded price).
  const [targetPrice, setTargetPrice] = useState<number>(0);

  // Budget state (null = None)
  const [budget, setBudget] = useState<number | null>(null);

  // Minimum Reward/Risk (Max Profit vs Max Loss) filter ratio (null = Any)
  const [minRewardRiskRatio, setMinRewardRiskRatio] = useState<number | null>(null);

  // Optimization Slider (0 = Max Return, 100 = Max Chance)
  const [optimizationBias, setOptimizationBias] = useState<number>(50);

  // Builder View State
  const [selectedStrategy, setSelectedStrategy] = useState<DiscoveredStrategy | null>(null);
  const [builderLegs, setBuilderLegs] = useState<StrategyLegItem[]>(() => {
    return initialCustomLegs && initialCustomLegs.length > 0 ? [...initialCustomLegs] : [];
  });
  const [builderIv, setBuilderIv] = useState<number>(27.5);
  const hasInitialCustomLegsRef = useRef(Boolean(initialCustomLegs && initialCustomLegs.length > 0));

  // Synchronize when custom trade legs are passed
  useEffect(() => {
    if (initialCustomLegs && initialCustomLegs.length > 0) {
      setBuilderLegs([...initialCustomLegs]);
    }
    if (initialStrategyName) {
      setCustomStrategyName(initialStrategyName);
    }
    if (initialExpirationDate) {
      const match = expirations.find(
        (e) =>
          e.date === initialExpirationDate ||
          e.label.toLowerCase().includes(initialExpirationDate.toLowerCase())
      );
      if (match) setSelectedExpiration(match);
    }
  }, [initialCustomLegs, initialStrategyName, initialExpirationDate, expirations]);

  // Capability 1: Strategy Library Modal State (50+ Strategies)
  const [showStrategyModal, setShowStrategyModal] = useState<boolean>(false);
  const [hoveredStrategyDef, setHoveredStrategyDef] = useState<StrategyDefinition | null>(null);

  // Capability 4: Dual Stats Switcher & Side-by-Side View (Default: both active simultaneously)
  const [showKeyStats, setShowKeyStats] = useState<boolean>(true);
  const [showNetGreeks, setShowNetGreeks] = useState<boolean>(true);

  const toggleKeyStats = () => {
    if (showKeyStats && !showNetGreeks) {
      setShowKeyStats(false);
      setShowNetGreeks(true);
    } else {
      setShowKeyStats(!showKeyStats);
    }
  };

  const toggleNetGreeks = () => {
    if (showNetGreeks && !showKeyStats) {
      setShowNetGreeks(false);
      setShowKeyStats(true);
    } else {
      setShowNetGreeks(!showNetGreeks);
    }
  };

  // Capability 8: Legs Inspector & Actions
  const [editingLegCostId, setEditingLegCostId] = useState<string | null>(null);
  const [customCostInputValue, setCustomCostInputValue] = useState<string>("");
  const [rollingLeg, setRollingLeg] = useState<StrategyLegItem | null>(null);

  // Capability 9: Price History Modal
  const [showHistoryModal, setShowHistoryModal] = useState<boolean>(false);

  // Capability 10 & 11: Save, Share, and Saved Trades Drawers
  const [showSaveModal, setShowSaveModal] = useState<boolean>(false);
  const [saveTradeName, setSaveTradeName] = useState<string>("");
  const [saveTradeNotes, setSaveTradeNotes] = useState<string>("");
  const [showSavedTradesModal, setShowSavedTradesModal] = useState<boolean>(false);

  // Scrollable container references for expirations and strike ruler
  const builderExpScrollRef = useRef<HTMLDivElement>(null);
  const discoveryExpScrollRef = useRef<HTMLDivElement>(null);
  const strikeRulerScrollRef = useRef<HTMLDivElement>(null);

  // Smooth horizontal scroll helper for arrow buttons
  const scrollContainer = (ref: React.RefObject<HTMLDivElement | null>, delta: number) => {
    if (ref.current) {
      ref.current.scrollBy({ left: delta, behavior: "smooth" });
    }
  };

  // Convert vertical mouse wheel to horizontal scrolling for smooth trackpad and mouse wheel navigation
  const handleHorizontalWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.currentTarget.scrollLeft += e.deltaY;
    }
  };

  // Auto-center ATM strike on the strike ruler
  const centerRulerOnAtm = () => {
    if (!strikeRulerScrollRef.current) return;
    const atmTick = strikeRulerScrollRef.current.querySelector(".strat-ruler-tick.highlight");
    if (atmTick) {
      atmTick.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  };

  // Auto-center active expiration chip
  const centerActiveExpiration = (ref: React.RefObject<HTMLDivElement | null>) => {
    if (!ref.current) return;
    const activeChip = ref.current.querySelector(".strat-timeline-chip.active, .strat-exp-chip.active");
    if (activeChip) {
      activeChip.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  };

  // Auto-center ruler on spot/ATM when symbol, spot, or builder view changes
  useEffect(() => {
    if (activeView === "builder") {
      const timer = setTimeout(() => {
        centerRulerOnAtm();
      }, 120);
      return () => clearTimeout(timer);
    }
  }, [activeView, activeSymbol, quote?.price]);

  // Auto-center active expiration when expiration selection changes
  useEffect(() => {
    const timer = setTimeout(() => {
      if (activeView === "builder") {
        centerActiveExpiration(builderExpScrollRef);
      } else {
        centerActiveExpiration(discoveryExpScrollRef);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [selectedExpiration.date, activeView]);
  const [savedTrades, setSavedTrades] = useState<SavedOptionTrade[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_SAVED_TRADES);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const toast = useToast();

  // Capability 12: Previous Trade Comparison
  const [previousStrategyLegs, setPreviousStrategyLegs] = useState<StrategyLegItem[] | null>(null);
  const [isComparingPrevious, setIsComparingPrevious] = useState<boolean>(false);

  // Dynamic Engine Config loaded from externalized ETAPI settings
  const [engineConfig, setEngineConfig] = useState<StrategyDiscoveryConfig>({
    riskFreeRate: 0.04,
    feePerContract: 0.65,
    maxCombinations: 5000,
  });

  useEffect(() => {
    fetch("/api/trading/options/config", {
      headers: {
        "x-environment": activeEnv,
        ...(userLogin ? { "x-user-login": userLogin } : {}),
      },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: any) => {
        if (data?.config?.strategyEngine) {
          setEngineConfig({
            riskFreeRate: data.config.strategyEngine.riskFreeRate ?? 0.04,
            feePerContract: data.config.strategyEngine.feePerContract ?? 0.65,
            maxCombinations: data.config.strategyEngine.maxCombinations ?? 5000,
          });
        }
      })
      .catch(() => {
        // Fallback to baseline defaults
      });
  }, [activeEnv, userLogin]);

  // Display and Zoom Modes
  const [builderRangePct, setBuilderRangePct] = useState<number>(20);
  const [builderZoomLevel, setBuilderZoomLevel] = useState<"x1" | "x2" | "x3">("x1");
  const [builderDateSliderPct, setBuilderDateSliderPct] = useState<number>(100);
  const [builderDisplayMode, setBuilderDisplayMode] = useState<"graph" | "table">("graph");
  const [builderMetricMode, setBuilderMetricMode] = useState<"pnl_dollar" | "pnl_pct" | "contract_val" | "collateral_pct">("pnl_dollar");
  const [showPositionsDrawer, setShowPositionsDrawer] = useState<boolean>(false);
  const [graphHoverPrice, setGraphHoverPrice] = useState<number | null>(null);


  // Check URL hash for shared trades on mount (Capability 10)
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash.startsWith("#trade=")) {
      const hashData = window.location.hash.slice(7);
      const decoded = decodeTradeFromHash(hashData);
      if (decoded && decoded.symbol && decoded.legs?.length > 0) {
        setActiveSymbol(decoded.symbol.toUpperCase());
        setSymbolInput(decoded.symbol.toUpperCase());
        const matchingExp = expirations.find((e) => e.date === decoded.expirationDate) || expirations[0];
        setSelectedExpiration(matchingExp);
        setBuilderLegs(decoded.legs);
        if (decoded.iv) setBuilderIv(decoded.iv);
        setActiveView("builder");
        toast.info(`Loaded shared trade: ${decoded.strategyName} (${decoded.symbol})`);
      }
    }
  }, [expirations]);

  const [isQuoteRefreshing, setIsQuoteRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);



  // Fetch live or market-data quote with optional notification and reanalysis
  const fetchQuoteData = async (sym: string, showNotification: boolean = false) => {
    setIsQuoteRefreshing(true);
    try {
      const resp = await fetch(`/api/market-data/quote?symbol=${encodeURIComponent(sym)}`);
      if (resp.ok) {
        const data = (await resp.json()) as any;
        if (data && (data.lastPrice || data.price)) {
          const freshPrice = Number(data.lastPrice || data.price);
          const freshQuote: StockQuoteState = {
            symbol: sym,
            price: freshPrice,
            change: Number(data.change || 0),
            changePercent: Number(data.changePercent || 0),
            companyName: data.companyName || sym,
            delayed: true,
          };
          setQuote(freshQuote);
          setQuoteError(null);
          setQuotesCache((prev) => ({
            ...prev,
            [sym.toUpperCase()]: freshQuote,
          }));
          // First live quote for a newly selected symbol: derive the
          // target price from it (issue #924: never from a preset).
          if (pendingTargetSymbolRef.current === sym.toUpperCase()) {
            pendingTargetSymbolRef.current = null;
            setTargetPrice(
              getTargetPriceForSentiment(sentiment, freshPrice, builderIv, selectedExpiration.dte)
            );
          }
          if (builderLegs.length > 0) {
            const updated = builderLegs.map((l) =>
              updateLegStrike(l, l.strike, freshPrice, selectedExpiration.dte, builderIv / 100, engineConfig.riskFreeRate)
            );
            setBuilderLegs(updated);
            reanalyze(updated);
          }
          const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          setLastRefreshedAt(timeStr);
          if (showNotification) {
            toast.info(`Refreshed ${sym} market data: $${freshPrice.toFixed(2)}`);
          }
          return;
        }
      }
    } catch {
      // No live quote: fall through to the explicit unavailable path below.
    } finally {
      setIsQuoteRefreshing(false);
    }

    // Issue #924: on failure, NEVER substitute a static or invented price.
    // A previously live-fetched quote for this symbol may stay visible
    // (it is real market data, labelled delayed), flagged as stale; with
    // no live quote at all, the state is explicitly unavailable.
    const cachedQuote = quotesCache[sym.toUpperCase()];
    if (cachedQuote) {
      setQuote(cachedQuote);
      setQuoteError(`Live refresh failed for ${sym} — showing the last live quote.`);
    } else {
      setQuote(null);
      setQuoteError(`Quote unavailable for ${sym} — live quote could not be loaded.`);
    }
  };

  useEffect(() => {
    void fetchQuoteData(activeSymbol, false);
  }, [activeSymbol]);

  // Universal app-refresh broadcast listener (triggered by top-bar Refresh button & global timer)
  const fetchQuoteDataRef = useRef(fetchQuoteData);
  fetchQuoteDataRef.current = fetchQuoteData;

  useEffect(() => {
    const handleAppRefresh = () => {
      void fetchQuoteDataRef.current(activeSymbol, true);
    };
    window.addEventListener("app-refresh", handleAppRefresh);
    return () => {
      window.removeEventListener("app-refresh", handleAppRefresh);
    };
  }, [activeSymbol]);

  const handleRefreshOptions = () => {
    void fetchQuoteData(activeSymbol, true);
  };

  // Implied move calculated using options market formula: spot * IV * sqrt(dte / 365)
  const computeImpliedMove = (spotPrice: number, ivPercent: number, dteDays: number) => {
    const ivDec = Math.max(0.05, ivPercent / 100);
    const tYears = Math.max(0.5, dteDays) / 365;
    return spotPrice * ivDec * Math.sqrt(tYears);
  };

  // Target price calculation for sentiment presets based on ±1x or ±2x implied move
  const getTargetPriceForSentiment = (
    nextSentiment: SentimentType,
    spotPrice: number,
    ivPercent: number,
    dteDays: number
  ) => {
    const move = computeImpliedMove(spotPrice, ivPercent, dteDays);
    if (nextSentiment === "all") return Number(spotPrice.toFixed(2));
    if (nextSentiment === "very_bullish") return Number((spotPrice + 2 * move).toFixed(2));
    if (nextSentiment === "bullish") return Number((spotPrice + move).toFixed(2));
    if (nextSentiment === "neutral") return Number(spotPrice.toFixed(2));
    if (nextSentiment === "directional") return Number((spotPrice + move).toFixed(2));
    if (nextSentiment === "bearish") return Number(Math.max(0.01, spotPrice - move).toFixed(2));
    if (nextSentiment === "very_bearish") return Number(Math.max(0.01, spotPrice - 2 * move).toFixed(2));
    return Number(spotPrice.toFixed(2));
  };

  // Canonical strategy catalog state fetched from backend (default: 74 registered strategies)
  const [serverCatalog, setServerCatalog] = useState<ServerCatalogResult | null>(null);

  useEffect(() => {
    fetchServerCatalog()
      .then((cat) => setServerCatalog(cat))
      .catch((err) => console.warn("[StrategyDiscoveryPanel] Failed to fetch server strategy catalog:", err));
  }, []);

  const catalogCount = serverCatalog?.count ?? 74;

  // Adjust target price default when sentiment or quote price changes
  const handleSentimentChange = (nextSentiment: SentimentType) => {
    hasInitialCustomLegsRef.current = false;
    // Do not leave the previous thesis' server-ranked list visible while the
    // replacement candidates are loading.
    setIsDiscovering(true);
    setDiscoveredStrategies([]);
    setDiscoveryError("");
    if (builderLegs.length > 0) {
      setPreviousStrategyLegs([...builderLegs]);
    }
    setSentiment(nextSentiment);
    setCustomStrategyName(null);
    // No live quote → no target derivation (issue #924: never from a fake).
    if (quote) {
      const target = getTargetPriceForSentiment(nextSentiment, quote.price, builderIv, selectedExpiration.dte);
      setTargetPrice(target);
    }
  };

  const handleSelectExpiration = (exp: ExpirationOption) => {
    setSelectedExpiration(exp);
    if (quote) {
      const target = getTargetPriceForSentiment(sentiment, quote.price, builderIv, exp.dte);
      setTargetPrice(target);
    }
  };

  const handleSelectSymbol = (sym: string) => {
    const clean = sym.trim().toUpperCase();
    setShowSymbolSearchMenu(false);
    if (!clean) return;

    if (clean !== activeSymbol) {
      setActiveSymbol(clean);
      setSymbolInput(clean);
      // Issue #924: never invent a price for a new symbol. A previously
      // live-fetched quote may show immediately; otherwise the quote is
      // empty until the live fetch for this symbol resolves, and its
      // target is derived from that live price on arrival.
      const cached = quotesCache[clean];
      if (cached) {
        setQuote(cached);
        setQuoteError(null);
        pendingTargetSymbolRef.current = null;
        const target = getTargetPriceForSentiment(sentiment, cached.price, builderIv, selectedExpiration.dte);
        setTargetPrice(target);
      } else {
        setQuote(null);
        setQuoteError(null);
        pendingTargetSymbolRef.current = clean;
      }
    }
  };

  const handleSymbolSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSelectSymbol(symbolInput);
  };

  // Issue #65: data tab — "live" (production default; broker chains only) or
  // "demo" (calibrated/generated chains; tab renders only when the server
  // reports the dev/demo gate enabled).
  const [dataTab, setDataTab] = useState<"live" | "demo">("live");
  const [discoveryError, setDiscoveryError] = useState<string>("");

  // Discovered strategy candidates fetched exclusively from server pipeline (pure display layer)
  const [discoveredStrategies, setDiscoveredStrategies] = useState<DiscoveredStrategy[]>([]);
  const [isDiscovering, setIsDiscovering] = useState<boolean>(false);
  const [discoveryDataSource, setDiscoveryDataSource] = useState<"live" | "calibrated-demo" | "unavailable">("unavailable");

  // The inputs an interactive discovery run sends RIGHT NOW (issue #29).
  // The scheduled-discovery capture (issue #126) builds its saved request
  // from this exact same object, so a schedule re-runs the view on screen
  // verbatim — never a re-derived approximation of it.
  const currentDiscoveryInputs = (): ServerDiscoveryInputs => ({
    symbol: activeSymbol,
    // No live quote → 0 placeholder; callers that act on these inputs
    // (auto-discovery effect, schedule capture) refuse to run without a
    // quote, so 0 is never presented or sent as a price.
    currentPrice: quote?.price ?? 0,
    sentiment,
    targetPrice,
    budget: budget ?? 100000,
    minRewardRisk: minRewardRiskRatio ?? 0,
    expiration: selectedExpiration,
    bias: optimizationBias,
    dataMode: dataTab === "demo" ? "calibrated-demo" : "live",
  });

  // Issue #126: "Schedule this discovery" — capture the current view as a
  // saved request on a durable schedule (backend: POST /api/schedules/create
  // with the autonomousStrategyDiscovery callback). The cadence is chosen
  // here, at capture time; the request itself is snapshotted when the
  // confirm strip opens and its symbol/thesis/target are shown before
  // anything is created, so nobody schedules a view they cannot see.
  const [scheduleCaptureOpen, setScheduleCaptureOpen] = useState(false);
  const [capturedRequest, setCapturedRequest] = useState<ReturnType<typeof buildStrategyRequest> | null>(null);
  const [captureScheduleType, setCaptureScheduleType] = useState<"interval" | "cron" | "delayed" | "scheduled">("interval");
  const [captureIntervalSeconds, setCaptureIntervalSeconds] = useState(3600);
  const [captureCron, setCaptureCron] = useState(() =>
    etToUtcCron({ hour: 9, minute: 30, daysOfWeek: "1-5" })
  );
  const [captureDelaySeconds, setCaptureDelaySeconds] = useState(1800);
  const [captureDate, setCaptureDate] = useState("");
  const [captureSubmitting, setCaptureSubmitting] = useState(false);
  const [captureError, setCaptureError] = useState("");

  const openScheduleCapture = () => {
    // Issue #924: never snapshot a discovery view with no live quote —
    // its currentPrice would be the 0 placeholder, not a market price.
    if (!quote) {
      toast.warning("Quote unavailable — load a live quote before scheduling this discovery.");
      return;
    }
    setCapturedRequest(buildStrategyRequest(currentDiscoveryInputs()));
    setCaptureError("");
    setScheduleCaptureOpen(true);
  };

  const handleCreateDiscoverySchedule = async () => {
    if (!capturedRequest) return;
    setCaptureError("");
    // S8 (consolidation #958): the create body is built by the one
    // schedule payload-builder module (the S7 builders), not
    // hand-assembled here — same saved-request payload, same cadence
    // keys, same one-shot date error; the payload now also carries
    // the trigger: "scheduled" stamp the route applied server-side.
    const built = buildDiscoveryCaptureSubmission({
      request: capturedRequest,
      environment: activeEnv,
      scheduleType: captureScheduleType,
      intervalSeconds: captureIntervalSeconds,
      cronExpression: captureCron,
      delaySeconds: captureDelaySeconds,
      scheduledDate: captureDate,
    });
    if ("error" in built) {
      setCaptureError(built.error);
      return;
    }
    const body = built.requestBody;
    setCaptureSubmitting(true);
    try {
      const res = await fetch("/api/schedules/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.success) {
        setScheduleCaptureOpen(false);
        toast.success(
          `🗓 Scheduled this discovery view (${capturedRequest.symbol} · ${capturedRequest.thesis} · target $${capturedRequest.targetPrice}) — manage it under Schedules.`
        );
      } else {
        setCaptureError(data.error || `Failed to create schedule (${res.status})`);
      }
    } catch (err: any) {
      setCaptureError(err?.message || "Failed to create schedule");
    } finally {
      setCaptureSubmitting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    // Issue #924: no live quote → no discovery run. Running with a
    // placeholder price would rank strategies against a fake spot.
    if (!quote) {
      setIsDiscovering(false);
      setDiscoveredStrategies([]);
      setDiscoveryDataSource("unavailable");
      setDiscoveryError("Quote unavailable — live quote could not be loaded.");
      return () => {
        cancelled = true;
      };
    }
    setIsDiscovering(true);
    setDiscoveryError("");
    fetchServerDiscovery(currentDiscoveryInputs())
      .then((res) => {
        if (!cancelled) {
          setDiscoveredStrategies(res.strategies);
          setDiscoveryDataSource(res.dataSource);
          setDiscoveryError(res.snapshotError ?? "");
          setIsDiscovering(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn("[StrategyDiscoveryPanel] Server discovery failed:", err);
          setDiscoveredStrategies([]);
          setDiscoveryDataSource("unavailable");
          setDiscoveryError(err instanceof Error ? err.message : "Server options discovery failed.");
          setIsDiscovering(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSymbol, quote?.price, sentiment, targetPrice, budget, minRewardRiskRatio, selectedExpiration, optimizationBias, builderIv, engineConfig, dataTab]);

  // When discovering strategies, synchronize selectedStrategy and builderLegs with the top match
  useEffect(() => {
    if (discoveredStrategies.length > 0) {
      if (hasInitialCustomLegsRef.current) {
        hasInitialCustomLegsRef.current = false;
        if (!selectedStrategy) {
          setSelectedStrategy(discoveredStrategies[0]);
        }
        return;
      }
      const top = discoveredStrategies[0];
      setSelectedStrategy(top);
      setCustomStrategyName(null);
      setBuilderLegs([...top.legs]);
    }
  }, [discoveredStrategies]);

  // Transition from Discovery card to Builder view
  const openInBuilder = (strat: DiscoveredStrategy) => {
    // Preserve current legs as previous for comparison (Capability 12)
    if (builderLegs.length > 0) {
      setPreviousStrategyLegs([...builderLegs]);
    }
    setSelectedStrategy(strat);
    setCustomStrategyName(null);
    setBuilderLegs([...strat.legs]);
    setActiveView("builder");
  };

  // Capability 1: Choose a strategy from 50+ Library
  const handleSelectPreMadeStrategy = (stratDef: StrategyDefinition) => {
    // Issue #924: legs are built from spot — no live quote, no strategy.
    if (!quote) {
      toast.warning("Quote unavailable — load a live quote before choosing a strategy.");
      return;
    }
    if (builderLegs.length > 0) {
      setPreviousStrategyLegs([...builderLegs]);
    }
    const newLegs = stratDef.buildLegs(
      quote.price,
      selectedExpiration.dte,
      selectedExpiration.date,
      builderIv / 100,
      engineConfig.riskFreeRate
    );
    const analyzed = analyzeStrategy(
      stratDef.name,
      stratDef.category,
      stratDef.subtitle,
      stratDef.theses,
      newLegs,
      quote.price,
      targetPrice,
      selectedExpiration.dte,
      selectedExpiration.date,
      builderIv / 100,
      stratDef.description,
      optimizationBias,
      engineConfig
    );
    setSelectedStrategy(analyzed);
    setBuilderLegs(newLegs);
    setShowStrategyModal(false);
    setActiveView("builder");
    toast.info(`Loaded ${stratDef.name} (${stratDef.category})`);
  };

  // Target price percentage change from spot
  const targetPctChange = useMemo(() => {
    if (!quote?.price) return 0;
    return Number((((targetPrice - quote.price) / quote.price) * 100).toFixed(0));
  }, [targetPrice, quote?.price]);

  // Optimization Factor breakdown
  const optFactors = useMemo(() => {
    return getOptimizationFactors(optimizationBias);
  }, [optimizationBias]);

  // =========================================================================
  // BUILDER VIEW CALCULATIONS & MATHEMATICAL ENGINE
  // =========================================================================
  // No live quote → 0 spot; builder math that needs spot is gated on a
  // live quote at its entry points (strategy select, discovery, trade
  // preview), so 0 is never presented as a price.
  const spot = quote?.price ?? 0;
  const currentStrategyName = customStrategyName || selectedStrategy?.name || "Options Strategy";
  const canTradeBuilderCandidate = Boolean(
    dataTab === "live" &&
    discoveryDataSource === "live" &&
    selectedStrategy &&
    builderLegs.some((leg) => !leg.isExcluded && !leg.isClosed) &&
    builderLegs.filter((leg) => !leg.isExcluded && !leg.isClosed).length <= 4
  );

  // Effective DTE and time remaining for the Date slider
  const maxDte = selectedExpiration.dte;
  const tRemainingDays = maxDte * (1 - builderDateSliderPct / 100);
  const tRemainingYears = Math.max(0, tRemainingDays) / 365;

  // Zoom / Range %
  const effectiveRangePct = useMemo(() => {
    if (builderZoomLevel === "x1") return builderRangePct;
    if (builderZoomLevel === "x2") return builderRangePct * 2.0;
    return builderRangePct * 3.5;
  }, [builderRangePct, builderZoomLevel]);

  const priceLow = Math.max(0.1, spot * (1 - effectiveRangePct / 100));
  const priceHigh = spot * (1 + effectiveRangePct / 100);

  // Full Payoff points across the range for the primary Builder graph
  const builderGraphPoints = useMemo(() => {
    const steps = 60;
    const stepSize = (priceHigh - priceLow) / (steps - 1);
    const points: Array<{ price: number; pnlEvaluated: number; pnlExpiry: number }> = [];

    for (let i = 0; i < steps; i++) {
      const p = priceLow + i * stepSize;
      const pnlEvaluated = evaluateStrategyPnL(
        builderLegs,
        p,
        tRemainingYears,
        builderIv / 100,
        engineConfig.riskFreeRate
      );
      const pnlExpiry = evaluateStrategyPnL(
        builderLegs,
        p,
        0,
        builderIv / 100,
        engineConfig.riskFreeRate
      );
      points.push({
        price: Number(p.toFixed(2)),
        pnlEvaluated: Number(pnlEvaluated.toFixed(2)),
        pnlExpiry: Number(pnlExpiry.toFixed(2)),
      });
    }
    return points;
  }, [builderLegs, priceLow, priceHigh, tRemainingYears, builderIv, engineConfig.riskFreeRate]);

  // Capability 12: Comparison curve points for previous trade (dashed gray line)
  const comparisonGraphPoints = useMemo(() => {
    if (!isComparingPrevious || !previousStrategyLegs || previousStrategyLegs.length === 0) {
      return undefined;
    }
    const steps = 60;
    const stepSize = (priceHigh - priceLow) / (steps - 1);
    const points: Array<{ x: number; y: number }> = [];

    for (let i = 0; i < steps; i++) {
      const p = priceLow + i * stepSize;
      const pnl = evaluateStrategyPnL(
        previousStrategyLegs,
        p,
        tRemainingYears,
        builderIv / 100,
        engineConfig.riskFreeRate
      );
      points.push({
        x: Number(p.toFixed(2)),
        y: Number(pnl.toFixed(2)),
      });
    }
    return points;
  }, [isComparingPrevious, previousStrategyLegs, priceLow, priceHigh, tRemainingYears, builderIv, engineConfig.riskFreeRate]);

  // Capability 6: Log-Normal Probability Distribution Overlay Curve
  const probabilityOverlayPoints = useMemo(() => {
    const raw = calculateProbabilityDensityPoints(
      spot,
      Math.max(0.001, tRemainingYears),
      builderIv / 100,
      priceLow,
      priceHigh,
      60,
      engineConfig.riskFreeRate
    );
    return raw.map((pt) => ({ x: pt.price, density: pt.density, probBelow: pt.probBelow }));
  }, [spot, tRemainingYears, builderIv, priceLow, priceHigh, engineConfig.riskFreeRate]);

  // Capability 6: Hover Chance Indicators (← X% | Y% →)
  const hoverProbabilities = useMemo(() => {
    if (graphHoverPrice === null) return null;
    return calculateProbabilityAboveBelow(
      spot,
      graphHoverPrice,
      Math.max(0.001, tRemainingYears),
      builderIv / 100,
      engineConfig.riskFreeRate
    );
  }, [spot, graphHoverPrice, tRemainingYears, builderIv, engineConfig.riskFreeRate]);

  // Capability 4: Net Option Greeks & Realized / Unrealized P&L
  const netGreeks: NetOptionGreeks = useMemo(() => {
    return calculateNetGreeks(
      builderLegs,
      spot,
      selectedExpiration.dte,
      builderIv / 100,
      engineConfig.riskFreeRate
    );
  }, [builderLegs, spot, selectedExpiration.dte, builderIv, engineConfig.riskFreeRate]);

  const pnlBreakdown: RealizedUnrealizedPnl = useMemo(() => {
    return calculateRealizedAndUnrealizedPnl(
      builderLegs,
      spot,
      selectedExpiration.dte,
      builderIv / 100,
      engineConfig.riskFreeRate
    );
  }, [builderLegs, spot, selectedExpiration.dte, builderIv, engineConfig.riskFreeRate]);

  // Capability 5: 2D Payoff Matrix Heatmap Data
  const matrix2dData = useMemo(() => {
    return evaluate2dPayoffMatrix(
      builderLegs,
      spot,
      selectedExpiration.dte,
      selectedExpiration.date,
      builderIv / 100,
      effectiveRangePct,
      17,
      7,
      selectedStrategy?.riskOrCollateral || 1000,
      engineConfig.riskFreeRate
    );
  }, [builderLegs, spot, selectedExpiration, builderIv, effectiveRangePct, selectedStrategy, engineConfig.riskFreeRate]);

  // Strike ladder for ruler and sliders
  const strikeLadder = useMemo(() => generateStrikeLadder(spot), [spot]);
  const minStrike = strikeLadder[0] || spot * 0.5;
  const maxStrike = strikeLadder[strikeLadder.length - 1] || spot * 1.5;
  const strikeStep = strikeLadder.length > 1 ? Number((strikeLadder[1] - strikeLadder[0]).toFixed(2)) : 1;

  // Visible ruler strikes: comprehensive scrollable ladder including all active option leg strikes
  const rulerStrikes = useMemo(() => {
    const set = new Set<number>(strikeLadder);
    for (const leg of builderLegs) {
      if (leg.strike && leg.strike > 0) {
        set.add(leg.strike);
      }
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [strikeLadder, builderLegs]);

  // Re-analyze strategy helper
  const reanalyze = (updatedLegs: StrategyLegItem[]) => {
    if (selectedStrategy) {
      const analyzed = analyzeStrategy(
        selectedStrategy.name,
        selectedStrategy.category,
        selectedStrategy.subtitle,
        selectedStrategy.theses,
        updatedLegs,
        spot,
        targetPrice,
        selectedExpiration.dte,
        selectedExpiration.date,
        builderIv / 100,
        selectedStrategy.description,
        optimizationBias,
        engineConfig
      );
      setSelectedStrategy(analyzed);
    }
  };

  // Strike change handlers
  const handleStrikeChange = (legId: string, newStrike: number, e?: React.MouseEvent | React.ChangeEvent) => {
    // If Shift key is held, move all strikes at once (Capability 3)
    if (e && "shiftKey" in e && (e as React.MouseEvent).shiftKey) {
      const leg = builderLegs.find((l) => l.id === legId);
      if (leg) {
        const delta = Math.round((newStrike - leg.strike) / strikeStep);
        handleMoveAllStrikes(delta);
        return;
      }
    }

    if (builderLegs.length > 0 && !previousStrategyLegs) {
      setPreviousStrategyLegs([...builderLegs]);
    }
    const updatedLegs = builderLegs.map((l) => {
      if (l.id === legId) {
        return updateLegStrike(l, newStrike, spot, selectedExpiration.dte, builderIv / 100, engineConfig.riskFreeRate);
      }
      return l;
    });
    setBuilderLegs(updatedLegs);
    reanalyze(updatedLegs);
  };

  // Step strike up or down
  const handleStrikeStep = (legId: string, stepDirection: number, e?: React.MouseEvent) => {
    if (e?.shiftKey) {
      handleMoveAllStrikes(stepDirection);
      return;
    }
    const leg = builderLegs.find((l) => l.id === legId);
    if (!leg) return;
    const currIdx = strikeLadder.findIndex((k) => Math.abs(k - leg.strike) < strikeStep * 0.5);
    const nextIdx = Math.max(0, Math.min(strikeLadder.length - 1, (currIdx >= 0 ? currIdx : 0) + stepDirection));
    handleStrikeChange(legId, strikeLadder[nextIdx]);
  };

  // Capability 3: Move All Strikes simultaneously (Shift+Drag / Stepper)
  const handleMoveAllStrikes = (stepDelta: number) => {
    if (builderLegs.length > 0 && !previousStrategyLegs) {
      setPreviousStrategyLegs([...builderLegs]);
    }
    const updated = shiftAllStrikes(
      builderLegs,
      stepDelta,
      spot,
      selectedExpiration.dte,
      builderIv / 100,
      engineConfig.riskFreeRate
    );
    setBuilderLegs(updated);
    reanalyze(updated);
  };

  // Capability 3: Symmetric Wing adjustments for Condors / Butterflies
  const handleSymmetricMove = (widthDelta: number) => {
    if (builderLegs.length > 0 && !previousStrategyLegs) {
      setPreviousStrategyLegs([...builderLegs]);
    }
    const updated = shiftSymmetricStrikes(
      builderLegs,
      widthDelta,
      spot,
      selectedExpiration.dte,
      builderIv / 100,
      engineConfig.riskFreeRate
    );
    setBuilderLegs(updated);
    reanalyze(updated);
  };

  // Expiration change handler
  const handleBuilderExpirationChange = (exp: ExpirationOption) => {
    setSelectedExpiration(exp);
    if (builderLegs.length > 0) {
      const updatedLegs = updateLegsExpiration(
        builderLegs,
        exp.dte,
        exp.date,
        spot,
        builderIv / 100,
        engineConfig.riskFreeRate
      );
      setBuilderLegs(updatedLegs);
      if (selectedStrategy) {
        const analyzed = analyzeStrategy(
          selectedStrategy.name,
          selectedStrategy.category,
          selectedStrategy.subtitle,
          selectedStrategy.theses,
          updatedLegs,
          spot,
          targetPrice,
          exp.dte,
          exp.date,
          builderIv / 100,
          selectedStrategy.description,
          optimizationBias,
          engineConfig
        );
        setSelectedStrategy(analyzed);
      }
    }
  };

  // Capability 8: Adjusting Leg Quantity
  const handleLegQuantityChange = (legId: string, delta: number) => {
    const updated = builderLegs.map((leg) => {
      if (leg.id === legId) {
        const newQty = Math.max(1, leg.quantity + delta);
        return { ...leg, quantity: newQty };
      }
      return leg;
    });
    setBuilderLegs(updated);
    reanalyze(updated);
  };

  // Capability 8: Adjusting Leg Side (BUY / SELL)
  const handleLegSideToggle = (legId: string) => {
    const updated = builderLegs.map((leg) => {
      if (leg.id === legId) {
        const newSide: "BUY" | "SELL" = leg.side === "BUY" ? "SELL" : "BUY";
        const newEntry = newSide === "BUY" ? leg.ask : leg.bid;
        return { ...leg, side: newSide, entryPrice: newEntry };
      }
      return leg;
    });
    setBuilderLegs(updated);
    reanalyze(updated);
  };

  // Capability 8: Exclude / Include Leg toggle
  const handleLegExcludeToggle = (legId: string) => {
    const updated = builderLegs.map((leg) => {
      if (leg.id === legId) {
        return { ...leg, isExcluded: !leg.isExcluded };
      }
      return leg;
    });
    setBuilderLegs(updated);
    reanalyze(updated);
  };

  // Capability 8: Custom Cost-Basis Input
  const handleSaveCustomCost = (legId: string) => {
    const val = parseFloat(customCostInputValue);
    const updated = builderLegs.map((leg) => {
      if (leg.id === legId) {
        return {
          ...leg,
          customCostBasis: isNaN(val) || val <= 0 ? undefined : val,
        };
      }
      return leg;
    });
    setBuilderLegs(updated);
    reanalyze(updated);
    setEditingLegCostId(null);
  };

  const handleResetCustomCost = (legId: string) => {
    const updated = builderLegs.map((leg) => {
      if (leg.id === legId) {
        return { ...leg, customCostBasis: undefined };
      }
      return leg;
    });
    setBuilderLegs(updated);
    reanalyze(updated);
    setEditingLegCostId(null);
  };

  // Capability 8 & 11: Close Leg (Locks in realized P&L)
  const handleCloseLeg = (legId: string) => {
    const leg = builderLegs.find((l) => l.id === legId);
    if (!leg) return;
    // Default closing exit price to current mark
    const exitPrice = leg.side === "BUY" ? leg.bid : leg.ask;
    const updated = builderLegs.map((l) => {
      if (l.id === legId) {
        return {
          ...l,
          isClosed: true,
          closingPrice: exitPrice,
        };
      }
      return l;
    });
    setBuilderLegs(updated);
    reanalyze(updated);
    toast.success(`Closed ${leg.side} ${leg.strike}${leg.optionType[0]} @ $${exitPrice.toFixed(2)} ✓`);
  };

  // Capability 8: Add New Option Leg
  const handleAddLeg = (optionType: "CALL" | "PUT") => {
    const defaultStrike = optionType === "CALL" ? strikeLadder.find((k) => k >= spot) || spot : strikeLadder.find((k) => k <= spot) || spot;
    const newLeg = updateLegStrike(
      {
        id: `${optionType}_${defaultStrike}_BUY_${Date.now()}`,
        side: "BUY",
        optionType,
        strike: defaultStrike,
        quantity: 1,
        expirationDate: selectedExpiration.date,
        dte: selectedExpiration.dte,
        entryPrice: 2.5,
        bid: 2.4,
        ask: 2.6,
        impliedVolatility: builderIv / 100,
        delta: 0.5,
        gamma: 0.02,
        theta: -0.05,
        vega: 0.12,
        rho: 0.05,
        vanna: 0.002,
        charm: -0.001,
        vomma: 0.005,
      },
      defaultStrike,
      spot,
      selectedExpiration.dte,
      builderIv / 100,
      engineConfig.riskFreeRate
    );
    const updated = [...builderLegs, newLeg];
    setBuilderLegs(updated);
    reanalyze(updated);
    toast.success(`Added Long ${defaultStrike}${optionType[0]} Leg`);
  };

  // Remove specific option leg by ID
  const handleRemoveLeg = (legId: string) => {
    const targetLeg = builderLegs.find((l) => l.id === legId);
    if (!targetLeg) return;
    const updated = builderLegs.filter((l) => l.id !== legId);
    setBuilderLegs(updated);
    reanalyze(updated);
    toast.success(`Removed ${targetLeg.side} ${targetLeg.strike ? `$${targetLeg.strike.toFixed(2)} ` : ""}${targetLeg.optionType} leg`);
  };

  // Remove the most recently added option leg of given type
  const handleRemoveLegByType = (optionType: "CALL" | "PUT") => {
    const matching = builderLegs.filter((l) => l.optionType === optionType);
    if (matching.length === 0) return;
    const lastLeg = matching[matching.length - 1];
    handleRemoveLeg(lastLeg.id);
  };

  // Capability 11: Execute Leg Roll
  const handleExecuteRoll = (newDte: number, newExpDate: string, newStrike: number) => {
    if (!rollingLeg) return;
    // 1. Close current rolling leg
    const closingExit = rollingLeg.side === "BUY" ? rollingLeg.bid : rollingLeg.ask;
    const closedOriginal = {
      ...rollingLeg,
      isClosed: true,
      closingPrice: closingExit,
    };
    // 2. Open new rolled leg
    const rolledNew = updateLegStrike(
      {
        ...rollingLeg,
        id: `${rollingLeg.optionType}_${newStrike}_${rollingLeg.side}_rolled_${Date.now()}`,
        strike: newStrike,
        expirationDate: newExpDate,
        dte: newDte,
        isClosed: false,
        closingPrice: undefined,
        customCostBasis: undefined,
      },
      newStrike,
      spot,
      newDte,
      builderIv / 100,
      engineConfig.riskFreeRate
    );

    const updated = builderLegs.map((l) => (l.id === rollingLeg.id ? closedOriginal : l)).concat(rolledNew);
    setBuilderLegs(updated);
    reanalyze(updated);
    setRollingLeg(null);
    toast.success(`Rolled ${rollingLeg.strike}${rollingLeg.optionType[0]} to ${newExpDate} $${newStrike} ✓`);
  };

  // Capability 10: Save Trade to LocalStorage
  const handleSaveTrade = () => {
    const name = saveTradeName.trim() || `${activeSymbol} ${currentStrategyName}`;
    const newSaved: SavedOptionTrade = {
      id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      notes: saveTradeNotes.trim(),
      createdAt: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }),
      symbol: activeSymbol,
      expirationDate: selectedExpiration.date,
      dte: selectedExpiration.dte,
      legs: builderLegs,
      strategyName: currentStrategyName,
      underlyingPriceAtSave: spot,
      ivAtSave: builderIv,
    };
    const nextList = [newSaved, ...savedTrades.filter((t) => t.name !== name)];
    setSavedTrades(nextList);
    try {
      localStorage.setItem(STORAGE_KEY_SAVED_TRADES, JSON.stringify(nextList));
    } catch {
      // ignore
    }
    setShowSaveModal(false);
    toast.success(`Trade "${name}" saved! 💾`);
  };

  // Capability 10: Share Trade Link
  const handleShareTrade = () => {
    const hash = encodeTradeToHash({
      symbol: activeSymbol,
      expirationDate: selectedExpiration.date,
      dte: selectedExpiration.dte,
      legs: builderLegs,
      strategyName: currentStrategyName,
      iv: builderIv,
    });
    const url = `${window.location.origin}${window.location.pathname}#trade=${hash}`;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => toast.success("Shareable link copied to clipboard! 📋"),
        () => toast.success("Link generated in address bar")
      );
    } else {
      window.location.hash = `trade=${hash}`;
      toast.success("Link set in address bar!");
    }
  };

  // Capability 11: Load Saved Trade
  const handleLoadSavedTrade = (trade: SavedOptionTrade) => {
    setActiveSymbol(trade.symbol);
    setSymbolInput(trade.symbol);
    const exp = expirations.find((e) => e.date === trade.expirationDate) || expirations[0];
    setSelectedExpiration(exp);
    setBuilderLegs(trade.legs);
    setBuilderIv(trade.ivAtSave || 44.2);
    setShowSavedTradesModal(false);
    toast.info(`Loaded saved trade: ${trade.name}`);
  };

  const handleDeleteSavedTrade = (tradeId: string) => {
    const nextList = savedTrades.filter((t) => t.id !== tradeId);
    setSavedTrades(nextList);
    try {
      localStorage.setItem(STORAGE_KEY_SAVED_TRADES, JSON.stringify(nextList));
    } catch {
      // ignore
    }
    toast.success("Saved trade deleted.");
  };

  // Capability 12: Revert to Previous Trade
  const handleRevertToPrevious = () => {
    if (previousStrategyLegs) {
      setBuilderLegs([...previousStrategyLegs]);
      reanalyze(previousStrategyLegs);
      setIsComparingPrevious(false);
      toast.success("Reverted to previous strategy configuration.");
    }
  };

  // Fast order ticket context creator
  const sendToFastOrder = () => {
    if (!onPreviewTrade || !selectedStrategy || !canTradeBuilderCandidate || !quote) return;
    const activeLegs = builderLegs.filter((leg) => !leg.isExcluded && !leg.isClosed);
    const ctx: TradeOrderContext = {
      assetClass: activeLegs.some((leg) => leg.optionType !== "STOCK") ? "options" : "equity",
      symbol: activeSymbol,
      action: sentiment.includes("bearish") ? "SELL_SHORT" : "BUY",
      quantity: 1,
      underlyingPrice: quote.price,
      label: `${selectedStrategy.name} (${selectedExpiration.date})`,
      legs: builderLegs.map(
        (leg) =>
          `${leg.side} ${leg.quantity} ${
            leg.optionType === "STOCK" ? "Shares" : `${leg.strike}${leg.optionType[0]} ${leg.expirationDate}`
          } @ $${leg.entryPrice.toFixed(2)}`
      ),
      optionLegs: activeLegs.map((leg) => ({
        securityType: leg.optionType === "STOCK" ? "EQ" as const : "OPTN" as const,
        side: leg.side,
        quantity: leg.quantity,
        optionType: leg.optionType === "STOCK" ? undefined : leg.optionType,
        strike: leg.optionType === "STOCK" ? undefined : leg.strike,
        expirationDate: leg.optionType === "STOCK" ? undefined : leg.expirationDate,
      })),
      strategyNetDebit: builderLegs.filter((leg) => !leg.isExcluded && !leg.isClosed).reduce((net, leg) => {
        const multiplier = leg.optionType === "STOCK" ? 1 : 100;
        return net + (leg.side === "BUY" ? 1 : -1) * leg.quantity * leg.entryPrice * multiplier;
      }, 0),
    };
    onPreviewTrade(ctx);
  };

  // Filtered Strategy Library (Capability 1)
  // Issue #450: the strategy library renders through the shared
  // StrategyLibraryModal (single source of truth, multiple representations).
  // STRATEGY_LIBRARY maps onto StrategyInfo with its rich card fields intact.
  const strategyInfos = useMemo<StrategyInfo[]>(
    () =>
      STRATEGY_LIBRARY.map((d) => ({
        id: d.id,
        label: d.name,
        category: d.category,
        description: d.description,
        theses: d.theses as unknown as string[],
        aliases: [],
        subtitle: d.subtitle,
        riskType: d.riskType,
        legsCount: d.legsCount,
        pnlSvgPath: d.pnlSvgPath,
      })),
    []
  );

  // Autocomplete suggestions for stock search with synchronized live quotes.
  // Issue #924: entries carry a price ONLY from a live quote (current or
  // previously fetched); otherwise they carry no price at all.
  const filteredTickers = useMemo(() => {
    const q = symbolInput ? symbolInput.trim().toUpperCase() : "";
    const baseList = q
      ? POPULAR_SYMBOLS.filter((t) => t.symbol.includes(q) || t.companyName.toUpperCase().includes(q))
      : POPULAR_SYMBOLS.slice(0, 8);

    return baseList.map((t) => {
      const sym = t.symbol.toUpperCase();
      if (sym === activeSymbol.toUpperCase() && quote && quote.symbol.toUpperCase() === sym) {
        return {
          ...t,
          price: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
        };
      }
      if (quotesCache[sym]) {
        return {
          ...t,
          price: quotesCache[sym].price,
          change: quotesCache[sym].change,
          changePercent: quotesCache[sym].changePercent,
        };
      }
      // No live quote for this symbol: no price fields at all, so the
      // dropdown renders "Quote unavailable" instead of a number.
      return { ...t, price: undefined, change: undefined, changePercent: undefined };
    });
  }, [symbolInput, activeSymbol, quote, quotesCache]);

  return (
    <div className="strat-discovery-container">
      {/* Top View Mode Switcher */}
      <div className="strat-view-tabs">
        <div className="strat-view-tab-buttons">
          <Button
            type="button"
            className={`strat-view-tab-btn ${activeView === "builder" ? "active" : ""}`}
            onClick={() => setActiveView("builder")}
          >
            📊 Builder / Payoff Analyzer
          </Button>
          <Button
            type="button"
            className={`strat-view-tab-btn ${activeView === "discovery" && dataTab === "live" ? "active" : ""}`}
            onClick={() => { setDataTab("live"); setActiveView("discovery"); }}
          >
            🔍 Discovery Scanner
          </Button>
          {serverCatalog?.demoCalibratedChainsEnabled && (
            <Button
              type="button"
              className={`strat-view-tab-btn ${dataTab === "demo" ? "active" : ""}`}
              onClick={() => { setDataTab("demo"); setActiveView("discovery"); }}
              title="Development/demo mode: strategies built on calibrated (generated) chains, not live market data"
            >
              🧪 Demo — Calibrated Chains
            </Button>
          )}
        </div>

        <div className="strat-top-controls-group">
          <Button
            type="button"
            className="strat-action-chip highlight"
            onClick={() => setShowStrategyModal(true)}
            title={`Browse ${catalogCount} pre-made options strategies`}
          >
            📚 Strategies ({catalogCount})
          </Button>
          <Button
            type="button"
            className="strat-action-chip"
            onClick={() => setShowSavedTradesModal(true)}
            title="Open saved strategies & tracking"
          >
            📂 Saved Trades ({savedTrades.length})
          </Button>
          <Button
            type="button"
            className="strat-action-chip"
            onClick={handleShareTrade}
            title="Copy shareable trade link to clipboard"
          >
            🔗 Share
          </Button>
          <Button
            type="button"
            className="strat-action-chip save"
            onClick={() => {
              setSaveTradeName(`${activeSymbol} ${currentStrategyName}`);
              setShowSaveModal(true);
            }}
            title="Save this strategy"
          >
            💾 Save
          </Button>
          {onPreviewTrade && selectedStrategy && (
            <Button
              type="button"
              className={`strat-action-chip trade-fast ${canTradeBuilderCandidate ? "" : "disabled"}`}
              onClick={sendToFastOrder}
              disabled={!canTradeBuilderCandidate}
              title={canTradeBuilderCandidate
                ? `Send ${currentStrategyName} to Trade Order Ticket`
                : builderLegs.filter((leg) => !leg.isExcluded && !leg.isClosed).length > 4
                  ? "E*TRADE supports up to four legs in one order."
                  : "A live broker chain and at least one active strategy leg are required."}
            >
              ⚡ Trade
            </Button>
          )}
        </div>
      </div>

      {/* ====================================================================
          VIEW 1: STRATEGY DISCOVERY SCANNER (IMAGE 2)
          ==================================================================== */}
      {activeView === "discovery" && (
        <div className="strat-discovery-view">
          {dataTab === "demo" && (
            <div style={{ margin: "0 0 12px", padding: "var(--space-2-5) var(--space-3)", borderRadius: 10, background: "var(--color-warning-subtle)", border: "1px solid var(--color-warning-border)", color: "var(--color-warning-text)", fontSize: "var(--font-size-body)", fontWeight: 600 }}>
              ⚠ DEMO DATA — the strategies below are built on calibrated (generated) option chains for development/demo. This is not live market data.
            </div>
          )}
          {discoveryError && (
            <div className="strat-discovery-message error" role="alert">
              {discoveryError}
            </div>
          )}
          <div className="strat-discovery-header">
            {/* Top Row: Symbol Input & Quote Price Badge (Left) + Sentiment Segmented Pill Bar (Right) */}
            <div className="strat-discovery-top-bar">
              <form onSubmit={handleSymbolSubmit} className="strat-symbol-bar">
                <div className="strat-symbol-input-wrap">
                  <span className="strat-search-icon">🔍</span>
                  <TextInput label="Symbol:"
                    id="strat-sym-input"
                    type="text"
                    value={symbolInput}
                    onChange={(e) => {
                      setSymbolInput(e.target.value);
                      setShowSymbolSearchMenu(true);
                    }}
                    onFocus={() => setShowSymbolSearchMenu(true)}
                    placeholder="TSLA, /ES..."
                    autoComplete="off"
                    aria-label="Stock or ETF symbol"
                  />
                  {/* Inline Symbol Autocomplete Dropdown anchored directly below input */}
                  {showSymbolSearchMenu && (
                    <>
                      <div className="strat-symbol-dropdown-backdrop" onClick={() => setShowSymbolSearchMenu(false)} />
                      <div className="strat-symbol-dropdown" onClick={(e) => e.stopPropagation()}>
                        <div className="strat-dropdown-header">Stocks, ETFs & Futures</div>
                        <div className="strat-dropdown-list">
                          {filteredTickers.map((t) => (
                            <div
                              key={t.symbol}
                              className={`strat-dropdown-item ${t.symbol === activeSymbol ? "active" : ""}`}
                              onClick={() => handleSelectSymbol(t.symbol)}
                            >
                              <div className="strat-dropdown-sym-col">
                                <span className="strat-dropdown-sym">{t.symbol}</span>
                                <span className="strat-dropdown-name">{t.companyName}</span>
                              </div>
                              <div className="strat-dropdown-price-col">
                                {typeof t.price === "number" ? (
                                  <>
                                    <span className="strat-dropdown-price">${t.price.toFixed(2)}</span>
                                    <span className={`strat-dropdown-pill ${(t.change ?? 0) >= 0 ? "gain" : "loss"}`}>
                                      {(t.change ?? 0) >= 0 ? "+" : ""}{(t.changePercent ?? 0).toFixed(2)}%
                                    </span>
                                  </>
                                ) : (
                                  <span className="strat-dropdown-price">Quote unavailable</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div className="strat-price-badge">
                  {quote ? (
                    <>
                      <span className="strat-price-num">${quote.price.toFixed(2)}</span>
                      <span className={`strat-change-pill ${quote.change >= 0 ? "gain" : "loss"}`}>
                        {quote.change >= 0 ? "+" : ""}
                        {quote.changePercent.toFixed(2)}% ({quote.change >= 0 ? "+$" : "-$"}{Math.abs(quote.change).toFixed(2)})
                      </span>
                      <span className="strat-delayed-tag">↻ Delayed</span>
                    </>
                  ) : (
                    <span className="strat-price-unavailable">
                      {isQuoteRefreshing ? "Loading quote…" : quoteError || "Quote unavailable"}
                    </span>
                  )}
                  <Button
                    type="button"
                    className="strat-mini-refresh-btn"
                    onClick={handleRefreshOptions}
                    disabled={isQuoteRefreshing}
                    title={`Refresh ${activeSymbol} quote & options`}
                  >
                    <span className={isQuoteRefreshing ? "strat-spin" : ""}>↻</span>
                  </Button>
                </div>
              </form>
            </div>

            {/* Controls Row: Side-by-Side Market Sentiment Circular Buttons (Left) & Optimization Bias Panel (Right) */}
            <div className="strat-discovery-controls-row">
              {/* Sentiment Selector Group with Circular Icons */}
              <div className="strat-sentiment-group strat-sentiment-selector" role="radiogroup" aria-label="Market sentiment">
                {SENTIMENT_ITEMS.map((item) => {
                  const isActive = sentiment === item.id;
                  return (
                    <Button
                      key={item.id}
                      type="button"
                      className={`strat-sentiment-btn-wrap strat-sentiment-card ${item.id} ${isActive ? "active" : ""}`}
                      onClick={() => handleSentimentChange(item.id)}
                      role="radio"
                      aria-checked={isActive}
                      title={item.label}
                    >
                      <div className="strat-sentiment-circle">
                        {item.icon}
                      </div>
                      <span className="strat-sentiment-label">{item.label}</span>
                    </Button>
                  );
                })}
              </div>

              {/* Optimization Bias Inline Control Panel */}
              <div className="strat-opt-adjacent-deck" title={optFactors.regimeDescription}>
                <div className="strat-opt-deck-top">
                  <div className="strat-opt-adjacent-meta">
                    <span className="strat-opt-title">Optimization Bias</span>
                    <span className="strat-opt-regime-badge">{optFactors.regime}</span>
                  </div>
                  <div className="strat-opt-adjacent-slider-wrap">
                    <span className="strat-opt-bound">← Return</span>
                    <TextInput
                      type="range"
                      min={0}
                      max={100}
                      value={optimizationBias}
                      onChange={(e) => setOptimizationBias(Number(e.target.value))}
                      aria-label="Optimization bias slider"
                    />
                    <span className="strat-opt-bound">Chance →</span>
                  </div>
                </div>
                <div className="strat-opt-deck-bottom strat-opt-adjacent-factors">
                  <span className="strat-factor-chip return" title="Target Return Weight">Ret: {optFactors.returnWeight}%</span>
                  <span className="strat-factor-chip chance" title="Win Probability (POP)">Win: {optFactors.chanceWeight}%</span>
                  <span className="strat-factor-chip safety" title="Breakeven Buffer">BE: {optFactors.safetyWeight}%</span>
                  <span className="strat-factor-chip capital" title="Capital Efficiency">Eff: {optFactors.capitalWeight}%</span>
                </div>
              </div>
            </div>

            {/* Target Price, Implied Move, Budget & Min R:R Bar (Unified Single Row) */}
            <div className="strat-target-bar">
              <div className="strat-input-pill" title="Tap or edit to customize target price. Defaults to ±1x or ±2x implied move based on sentiment.">
                <span className="strat-pill-icon">🎯</span>
                <TextInput label="Target:"
                  type="number"
                  step="0.1"
                  value={targetPrice}
                  onChange={(e) => setTargetPrice(Number(e.target.value))}
                  aria-label="Target price in dollars"
                />
                <span className={`strat-pct-tag ${targetPctChange >= 0 ? "gain" : "loss"}`}>
                  ({targetPctChange >= 0 ? `+${targetPctChange}%` : `${targetPctChange}%`})
                </span>
              </div>

              <div className="strat-input-pill strat-implied-move-info" title="Market Implied Move calculated from options market IV and days to expiration">
                <span className="strat-pill-icon">📐</span>
                <label>Implied Move:</label>
                <span className="strat-implied-val">
                  {quote ? (
                    <>
                      ±${computeImpliedMove(quote.price, builderIv, selectedExpiration.dte).toFixed(2)}
                      <span className="strat-implied-pct">
                        (±{(((computeImpliedMove(quote.price, builderIv, selectedExpiration.dte) / (quote.price || 1)) * 100).toFixed(1))}%)
                      </span>
                    </>
                  ) : (
                    "Quote unavailable"
                  )}
                </span>
              </div>

              <div className="strat-input-pill" title="Max capital budget to allocate">
                <span className="strat-pill-icon">💰</span>
                <label>Budget:</label>
                <span className="strat-currency-prefix">$</span>
                <TextInput
                  type="text"
                  placeholder="None"
                  value={budget !== null ? budget : ""}
                  onChange={(e) => {
                    const val = e.target.value.trim();
                    setBudget(val === "" ? null : Number(val) || null);
                  }}
                  aria-label="Budget in dollars"
                />
              </div>

              <div className="strat-input-pill strat-rr-pill" title="Filter strategies by minimum Reward/Risk (Max Profit to Max Loss ratio)">
                <span className="strat-pill-icon">⚖️</span>
                <label>Min R:R:</label>
                <Select
                  value={minRewardRiskRatio ?? ""}
                  onChange={(e) => setMinRewardRiskRatio(e.target.value === "" ? null : Number(e.target.value))}
                  className="strat-rr-select"
                  aria-label="Minimum reward-to-risk ratio"
                >
                  <option value="">Any R:R</option>
                  <option value="1">≥ 1:1 (Profit &gt; Loss)</option>
                  <option value="1.5">≥ 1:1.5 (+50%)</option>
                  <option value="2">≥ 1:2 (2x)</option>
                  <option value="3">≥ 1:3 (3x)</option>
                  <option value="4">≥ 1:4 (4x)</option>
                </Select>
              </div>
            </div>

            {/* Expiration Timeline Chips (Scrollable with Navigation Arrows) */}
            <div className="strat-exp-chips-scroll-wrap">
              <Button
                type="button"
                className="strat-scroll-arrow left"
                onClick={() => scrollContainer(discoveryExpScrollRef, -240)}
                title="Scroll expirations left"
                aria-label="Scroll expirations left"
              >
                ‹
              </Button>
              <div
                className="strat-timeline-row strat-exp-chips-scroll"
                ref={discoveryExpScrollRef}
                onWheel={handleHorizontalWheel}
              >
                {expirations.map((exp) => (
                  <Button
                    key={exp.date}
                    type="button"
                    className={`strat-timeline-chip ${selectedExpiration.date === exp.date ? "active" : ""}`}
                    onClick={() => handleSelectExpiration(exp)}
                  >
                    <span className="strat-chip-month">{exp.monthGroup}</span>
                    <span className="strat-chip-day">{exp.dayLabel}</span>
                  </Button>
                ))}
              </div>
              <Button
                type="button"
                className="strat-scroll-arrow right"
                onClick={() => scrollContainer(discoveryExpScrollRef, 240)}
                title="Scroll expirations right"
                aria-label="Scroll expirations right"
              >
                ›
              </Button>
            </div>
          </div>

          {/* Issue #126: schedule this exact view as a saved-request discovery schedule */}
          <div className="strat-schedule-capture">
            {!scheduleCaptureOpen ? (
              <>
                <Button
                  type="button"
                  className="strat-action-chip"
                  onClick={openScheduleCapture}
                  title="Create a durable schedule that re-runs this exact discovery view and stores the results"
                >
                  🗓 Schedule this discovery
                </Button>
                <span className="strat-schedule-capture-hint">
                  Re-runs the view above (symbol, sentiment, target, budget) on a schedule; results land in Discovery runs.
                </span>
              </>
            ) : capturedRequest ? (
              <div className="strat-schedule-confirm" role="group" aria-label="Confirm scheduled discovery">
                <p className="strat-schedule-confirm-summary">
                  Schedule THIS view: <strong>{capturedRequest.symbol}</strong> — {capturedRequest.thesis} · target{" "}
                  <strong>${capturedRequest.targetPrice.toFixed(2)}</strong> by {capturedRequest.targetDate} · max loss{" "}
                  ${capturedRequest.maxPlannedLoss.toLocaleString()} · min R:R {capturedRequest.minRewardRisk} ·{" "}
                  {capturedRequest.dataMode === "calibrated-demo" ? "calibrated-demo chains" : "live chains"}
                </p>
                <div className="strat-schedule-confirm-controls">
                  <Select label="Cadence"
                    value={captureScheduleType}
                    onChange={(e) => setCaptureScheduleType(e.target.value as typeof captureScheduleType)}
                    aria-label="Schedule cadence type"
                  >
                    <option value="interval">Interval</option>
                    <option value="cron">Cron (UTC)</option>
                    <option value="delayed">Delayed (once)</option>
                    <option value="scheduled">One-shot date</option>
                  </Select>
                  {captureScheduleType === "interval" && (
                    <TextInput label="Every (seconds)"
                      type="number"
                      min={60}
                      step={60}
                      value={captureIntervalSeconds}
                      onChange={(e) => setCaptureIntervalSeconds(Number(e.target.value))}
                      aria-label="Interval seconds"
                    />
                  )}
                  {captureScheduleType === "cron" && (
                    <TextInput label="Cron (UTC)"
                      type="text"
                      value={captureCron}
                      onChange={(e) => setCaptureCron(e.target.value)}
                      aria-label="Cron expression"
                    />
                  )}
                  {captureScheduleType === "delayed" && (
                    <TextInput label="Delay (seconds)"
                      type="number"
                      min={1}
                      step={60}
                      value={captureDelaySeconds}
                      onChange={(e) => setCaptureDelaySeconds(Number(e.target.value))}
                      aria-label="Delay seconds"
                    />
                  )}
                  {captureScheduleType === "scheduled" && (
                    <TextInput label="Run at"
                      type="datetime-local"
                      value={captureDate}
                      onChange={(e) => setCaptureDate(e.target.value)}
                      aria-label="One-shot date and time"
                    />
                  )}
                </div>
                {captureError && (
                  <div className="strat-discovery-message error" role="alert">
                    {captureError}
                  </div>
                )}
                <div className="strat-schedule-confirm-actions">
                  <Button
                    type="button"
                    className="strat-action-chip highlight"
                    onClick={handleCreateDiscoverySchedule}
                    disabled={captureSubmitting}
                   loading={captureSubmitting}>
                    {"✓ Create schedule"}
                  </Button>
                  <Button
                    type="button"
                    className="strat-action-chip"
                    onClick={() => setScheduleCaptureOpen(false)}
                    disabled={captureSubmitting}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          {/* Discovered Strategies Grid */}
          <div className="strat-cards-grid">
            {isDiscovering && discoveredStrategies.length === 0 && (
              <div className="strat-discovery-message" role="status">
                {dataTab === "demo"
                  ? "Loading server-ranked strategies from the gated demo chain…"
                  : "Loading server-ranked strategies from the live broker chain…"}
              </div>
            )}
            {!isDiscovering && discoveredStrategies.length === 0 && (
              <div className="strat-discovery-message empty" role="status">
                {discoveryError
                  ? "No strategies were returned. Check the server options-data message above, then retry after the live chain is available."
                  : dataTab === "demo"
                    ? "No strategies matched this sentiment, expiration, and gated demo chain. Adjust the filters or choose another expiration."
                    : "No strategies matched this sentiment, expiration, risk budget, and live broker chain. Adjust the filters or choose another expiration."}
              </div>
            )}
            {discoveredStrategies.map((strat) => {
              const returnLabel =
                strat.returnOnRiskPct !== null
                  ? `${strat.returnOnRiskPct}% Return on risk`
                  : `${strat.returnOnCollateralPct}% Return on collateral`;

              return (
                <div
                  key={strat.id}
                  className={`strat-card strat-discovery-card ${selectedStrategy?.id === strat.id ? "selected active" : ""}`}
                  onClick={() => {
                    if (builderLegs.length > 0) {
                      setPreviousStrategyLegs([...builderLegs]);
                    }
                    setSelectedStrategy(strat);
                    setCustomStrategyName(null);
                    setBuilderLegs([...strat.legs]);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <div className="strat-card-title-row">
                    <div className="strat-card-header-left">
                      <span className="strat-card-name">{strat.name}</span>
                      <span className="strat-card-subtitle">{strat.subtitle}</span>
                    </div>
                    {strat.rewardRiskRatio !== undefined && strat.rewardRiskRatio !== null && (
                      <span className="strat-stat-rr-badge" title="Reward / Risk Ratio (Max Profit vs Max Loss)">
                        R:R 1:{strat.rewardRiskRatio}
                      </span>
                    )}
                    {strat.maxProfit === null && (
                      <span className="strat-stat-rr-badge uncapped" title="Uncapped Upside Potential">
                        R:R ∞ (Uncapped)
                      </span>
                    )}
                  </div>

                  <div className="strat-card-stats-row">
                    <div className="strat-card-stat-left">
                      <span className="strat-stat-return">{returnLabel}</span>
                      <span className="strat-stat-profit">${strat.targetProfit.toLocaleString()} Profit</span>
                    </div>
                    <div className="strat-card-stat-right">
                      <span className="strat-stat-chance">{strat.chanceOfProfit}% Chance 🔒</span>
                      <span className="strat-stat-risk">
                        ${strat.riskOrCollateral.toLocaleString()} {strat.returnOnRiskPct !== null ? "Risk" : "Collateral"}
                      </span>
                    </div>
                  </div>

                  <div style={{ height: "90px", width: "100%", margin: "0.4rem 0" }}>
                    <UniversalChart
                      mode="mini_payoff"
                      points={strat.miniPayoffPoints.map((pt) => ({ x: pt.price, y: pt.pnl }))}
                      spotPrice={spot}
                      targetPrice={targetPrice}
                      width={300}
                      height={90}
                      ariaLabel={`${strat.name} mini payoff chart`}
                    />
                  </div>

                  <div className="strat-card-actions-row">
                    {onPreviewTrade && discoveryDataSource === "live" && dataTab === "live" && (
                      <Button
                        type="button"
                        className="strat-card-icon-btn trade"
                        onClick={(e) => {
                          e.stopPropagation();
                          const activeLegs = strat.legs.filter((leg) => !leg.isExcluded && !leg.isClosed);
                          const ctx: TradeOrderContext = {
                            assetClass: activeLegs.some((leg) => leg.optionType !== "STOCK") ? "options" : "equity",
                            symbol: activeSymbol,
                            action: sentiment.includes("bearish") ? "SELL_SHORT" : "BUY",
                            quantity: 1,
                            // Reachable only after a live-quote discovery run
                            // (button renders on discoveryDataSource live);
                            // 0 is a type-level fallback, never a shown price.
                            underlyingPrice: quote?.price ?? 0,
                            label: `${strat.name} (${selectedExpiration.date})`,
                            legs: strat.legs.map(
                              (leg) =>
                                `${leg.side} ${leg.quantity} ${
                                  leg.optionType === "STOCK" ? "Shares" : `${leg.strike}${leg.optionType[0]} ${leg.expirationDate}`
                                } @ $${leg.entryPrice.toFixed(2)}`
                            ),
                            optionLegs: activeLegs.map((leg) => ({
                              securityType: leg.optionType === "STOCK" ? "EQ" as const : "OPTN" as const,
                              side: leg.side,
                              quantity: leg.quantity,
                              optionType: leg.optionType === "STOCK" ? undefined : leg.optionType,
                              strike: leg.optionType === "STOCK" ? undefined : leg.strike,
                              expirationDate: leg.optionType === "STOCK" ? undefined : leg.expirationDate,
                            })),
                            strategyNetDebit: strat.legs.filter((leg) => !leg.isExcluded && !leg.isClosed).reduce((net, leg) => {
                              const multiplier = leg.optionType === "STOCK" ? 1 : 100;
                              return net + (leg.side === "BUY" ? 1 : -1) * leg.quantity * leg.entryPrice * multiplier;
                            }, 0),
                          };
                          onPreviewTrade(ctx);
                        }}
                        title={`Trade ${strat.name}: send to Order Ticket`}
                        aria-label={`Trade ${strat.name}`}
                      >
                        <span className="strat-icon">⚡</span>
                        <span className="strat-icon-tooltip">Trade</span>
                      </Button>
                    )}
                    <Button
                      type="button"
                      className="strat-card-icon-btn builder"
                      onClick={(e) => {
                        e.stopPropagation();
                        openInBuilder(strat);
                      }}
                      title={`Open ${strat.name} in Interactive Builder`}
                      aria-label={`Open ${strat.name} in Builder`}
                    >
                      <span className="strat-icon">📊</span>
                      <span className="strat-icon-tooltip">Builder</span>
                    </Button>
                    <Button
                      type="button"
                      className="strat-card-icon-btn eval"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEvaluatingStrategy({
                          symbol: activeSymbol,
                          strategyName: strat.name,
                          sentiment,
                          targetPrice,
                          expirationDate: selectedExpiration.date,
                          dte: selectedExpiration.dte,
                          legsText: strat.legs.map((l) => `${l.side} ${l.quantity} ${l.strike}${l.optionType[0]}`).join(" / "),
                          netDebit: strat.netDebit,
                          maxLoss: strat.riskOrCollateral,
                          maxProfit: strat.maxProfit,
                          chanceOfProfit: strat.chanceOfProfit,
                          breakevenText: strat.breakevens.map((b) => `$${b.toFixed(2)}`).join(" · "),
                          underlyingPrice: spot,
                          legs: strat.legs.map((l) => `${l.side} ${l.quantity} ${activeSymbol} ${selectedExpiration.date} $${l.strike} ${l.optionType}`),
                          optionLegs: strat.legs.filter((l) => !l.isExcluded && !l.isClosed).map((l) => ({
                            securityType: l.optionType === "STOCK" ? "EQ" as const : "OPTN" as const,
                            side: l.side,
                            quantity: l.quantity,
                            optionType: l.optionType === "STOCK" ? undefined : l.optionType,
                            strike: l.optionType === "STOCK" ? undefined : l.strike,
                            expirationDate: l.optionType === "STOCK" ? undefined : l.expirationDate,
                          })),
                        });
                      }}
                      title={`Evaluate ${strat.name} with AI Engine`}
                      aria-label={`Evaluate ${strat.name} with AI`}
                    >
                      <span className="strat-icon">🧠</span>
                      <span className="strat-icon-tooltip">AI Eval</span>
                    </Button>
                    <Button
                      type="button"
                      className="strat-card-icon-btn risk"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRiskSubject({
                          title: strat.name,
                          underlyingSymbol: activeSymbol,
                          underlyingPrice: spot,
                          strategyType: strat.name,
                          sentiment,
                          expirationDate: selectedExpiration.date,
                          dte: selectedExpiration.dte,
                          legsText: strat.legs.map((l) => `${l.side} ${l.quantity} ${l.strike}${l.optionType[0]}`).join(" / "),
                          netDebit: strat.netDebit,
                          maxLoss: strat.riskOrCollateral,
                          maxProfit: strat.maxProfit,
                          chanceOfProfit: strat.chanceOfProfit,
                          breakevens: strat.breakevens,
                          breakevenText: strat.breakevens.map((b) => `$${b.toFixed(2)}`).join(" · "),
                          legs: strat.legs.map((l) => ({
                            side: l.side,
                            quantity: l.quantity,
                            strike: l.strike,
                            optionType: l.optionType,
                            entryPrice: l.entryPrice,
                            delta: l.delta,
                            gamma: l.gamma,
                            theta: l.theta,
                            vega: l.vega,
                          })),
                          netGreeks: {
                            delta: netGreeks.netDelta,
                            gamma: netGreeks.netGamma,
                            theta: netGreeks.netTheta,
                            vega: netGreeks.netVega,
                            rho: netGreeks.netRho,
                          },
                        });
                      }}
                      title={`Analyze ${strat.name} Risk & Management Playbook`}
                      aria-label={`Risk Analysis for ${strat.name}`}
                    >
                      <span className="strat-icon">🛡️</span>
                      <span className="strat-icon-tooltip">Risk</span>
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ====================================================================
          VIEW 2: INTERACTIVE STRATEGY BUILDER / PAYOFF ANALYZER (IMAGE 1)
          ==================================================================== */}
      {activeView === "builder" && (
        <div className="strat-builder-view">
          {/* Capability: Flow Trade Banner (Screenshot 4) */}
          {flowTradeBanner && !isFlowBannerDismissed && (
            <div className="strat-flow-alert-banner">
              <div className="strat-flow-alert-content">
                <span className="strat-flow-alert-title">{flowTradeBanner.title}</span>
                <span className="strat-flow-alert-subtitle">{flowTradeBanner.returnText}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                {onBackToFlows && (
                  <Button type="button" className="strat-flow-back-btn" onClick={onBackToFlows}>
                    ← Back to Flows
                  </Button>
                )}
                <Button
                  type="button"
                  className="strat-flow-alert-close"
                  onClick={() => setIsFlowBannerDismissed(true)}
                  aria-label="Dismiss banner"
                >
                  ✕
                </Button>
              </div>
            </div>
          )}

          {/* Header Bar */}
          <div className="strat-builder-header-bar">
            <div className="strat-builder-title-group">
              <div className="strat-strategy-name-badge-wrap">
                <h2>{currentStrategyName}</h2>
                <Button
                  type="button"
                  className="strat-change-strat-btn"
                  onClick={() => setShowStrategyModal(true)}
                  title={`Change Strategy (${catalogCount} available)`}
                >
                  Change ▾
                </Button>
              </div>
              <span title={selectedStrategy?.description} className="strat-info-icon">
                ⓘ {selectedStrategy?.subtitle}
              </span>
            </div>

            <div className="strat-builder-action-btns">
              <Button
                type="button"
                className="strat-btn-action"
                onClick={() => setShowPositionsDrawer(!showPositionsDrawer)}
              >
                Positions ({builderLegs.filter((l) => !l.isClosed).length} open) ☰
              </Button>
              <Button
                type="button"
                className="strat-btn-action"
                onClick={() => setShowHistoryModal(true)}
                title="View single contract price history over time"
              >
                History 📈
              </Button>
              <Button
                type="button"
                className="strat-btn-action eval-llm"
                onClick={() => {
                  setEvaluatingStrategy({
                    symbol: activeSymbol,
                    strategyName: currentStrategyName,
                    sentiment,
                    targetPrice,
                    expirationDate: selectedExpiration.date,
                    dte: selectedExpiration.dte,
                    legsText: builderLegs.map((l) => `${l.side} ${l.quantity} ${l.strike}${l.optionType[0]}`).join(" / "),
                    netDebit: selectedStrategy?.netDebit,
                    maxLoss: selectedStrategy?.riskOrCollateral ?? null,
                    maxProfit: selectedStrategy?.maxProfit ?? null,
                    chanceOfProfit: selectedStrategy?.chanceOfProfit,
                    breakevenText: (selectedStrategy?.breakevens || []).map((b) => `$${b.toFixed(2)}`).join(" · "),
                    underlyingPrice: spot,
                    legs: builderLegs.map((l) => `${l.side} ${l.quantity} ${activeSymbol} ${selectedExpiration.date} $${l.strike} ${l.optionType}`),
                    optionLegs: builderLegs.filter((l) => !l.isExcluded && !l.isClosed).map((l) => ({
                      securityType: l.optionType === "STOCK" ? "EQ" as const : "OPTN" as const,
                      side: l.side,
                      quantity: l.quantity,
                      optionType: l.optionType === "STOCK" ? undefined : l.optionType,
                      strike: l.optionType === "STOCK" ? undefined : l.strike,
                      expirationDate: l.optionType === "STOCK" ? undefined : l.expirationDate,
                    })),
                  });
                }}
              >
                🧠 Evaluate with AI
              </Button>
              <Button
                type="button"
                className="strat-btn-action risk-btn"
                onClick={() => {
                  setRiskSubject({
                    title: currentStrategyName,
                    underlyingSymbol: activeSymbol,
                    underlyingPrice: spot,
                    strategyType: currentStrategyName,
                    sentiment,
                    expirationDate: selectedExpiration.date,
                    dte: selectedExpiration.dte,
                    legsText: builderLegs.map((l) => `${l.side} ${l.quantity} ${l.strike}${l.optionType[0]}`).join(" / "),
                    netDebit: selectedStrategy?.netDebit,
                    maxLoss: selectedStrategy?.riskOrCollateral ?? null,
                    maxProfit: selectedStrategy?.maxProfit ?? null,
                    chanceOfProfit: selectedStrategy?.chanceOfProfit,
                    breakevens: selectedStrategy?.breakevens || [],
                    breakevenText: (selectedStrategy?.breakevens || []).map((b) => `$${b.toFixed(2)}`).join(" · "),
                    legs: builderLegs.map((l) => ({
                      side: l.side,
                      quantity: l.quantity,
                      strike: l.strike,
                      optionType: l.optionType,
                      entryPrice: l.entryPrice,
                      delta: l.delta,
                      gamma: l.gamma,
                      theta: l.theta,
                      vega: l.vega,
                    })),
                    netGreeks: {
                      delta: netGreeks.netDelta,
                      gamma: netGreeks.netGamma,
                      theta: netGreeks.netTheta,
                      vega: netGreeks.netVega,
                      rho: netGreeks.netRho,
                    },
                  });
                }}
                title="Institutional Risk Management & Defense Playbook"
              >
                🛡️ Risk Analysis
              </Button>
              <OptionsDataDownloadDropdown
                symbol={activeSymbol}
                activeEnv={activeEnv}
                userLogin={userLogin}
                label="📥 Export Data"
              />
            </div>
          </div>

          <section className="strat-server-candidates" aria-label="Backend-ranked strategies for payoff analysis">
            <div className="strat-server-candidates-header">
              <div>
                <h3>Backend-ranked strategies</h3>
                <p>Choose a market sentiment to load live server-ranked candidates into the payoff analyzer.</p>
              </div>
              <span className={`strat-server-source ${discoveryDataSource}`}>
                {isDiscovering ? "Refreshing candidates…" : discoveryDataSource === "live" ? "Live broker chain" : discoveryDataSource === "calibrated-demo" ? "Calibrated demo data" : "Data unavailable"}
              </span>
            </div>
            <div className="strat-sentiment-group strat-sentiment-selector strat-payoff-sentiments" role="radiogroup" aria-label="Market sentiment for payoff strategies">
              {SENTIMENT_ITEMS.map((item) => {
                const isActive = sentiment === item.id;
                return (
                  <Button
                    key={item.id}
                    type="button"
                    className={`strat-sentiment-btn-wrap strat-sentiment-card ${item.id} ${isActive ? "active" : ""}`}
                    onClick={() => handleSentimentChange(item.id)}
                    role="radio"
                    aria-checked={isActive}
                    title={`Load backend-ranked ${item.label.toLowerCase()} strategies`}
                  >
                    <div className="strat-sentiment-circle">{item.icon}</div>
                    <span className="strat-sentiment-label">{item.label}</span>
                  </Button>
                );
              })}
            </div>
            {discoveryError && <div className="strat-server-candidates-error" role="alert">{discoveryError}</div>}
            {isDiscovering && (
              <div className="strat-server-candidates-empty" role="status" aria-live="polite">
                Loading backend-ranked strategies for {SENTIMENT_ITEMS.find((item) => item.id === sentiment)?.label || sentiment}…
              </div>
            )}
            {!isDiscovering && discoveredStrategies.length === 0 && (
              <div className="strat-server-candidates-empty" role="status">
                No backend candidates are available for this sentiment and market data source. Change sentiment or refresh the option chain.
              </div>
            )}
            {discoveredStrategies.length > 0 && (
              <div className="strat-server-candidates-list" aria-label={`${discoveredStrategies.length} backend-ranked strategies`}>
                {discoveredStrategies.slice(0, 8).map((strategy) => (
                  <Button
                    key={strategy.id}
                    type="button"
                    className={`strat-server-candidate ${selectedStrategy?.id === strategy.id ? "active" : ""}`}
                    disabled={isDiscovering}
                    aria-pressed={selectedStrategy?.id === strategy.id}
                    onClick={() => {
                      if (builderLegs.length > 0) setPreviousStrategyLegs([...builderLegs]);
                      setSelectedStrategy(strategy);
                      setCustomStrategyName(null);
                      setBuilderLegs([...strategy.legs]);
                    }}
                  >
                    <span className="strat-server-candidate-title">{strategy.name}</span>
                    <span className="strat-server-candidate-meta">{strategy.subtitle}</span>
                    <span className="strat-server-candidate-risk">Max loss {strategy.maxLoss === null ? "Unlimited" : `$${strategy.maxLoss.toLocaleString()}`} · POP {strategy.chanceOfProfit}%</span>
                  </Button>
                ))}
              </div>
            )}
          </section>

          {/* Capability 12: Strategy Comparison Banner */}
          {previousStrategyLegs && previousStrategyLegs.length > 0 && (
            <div className="strat-compare-banner">
              <div className="strat-compare-label">
                <span>🔀 Strategy modified</span>
                <span className="strat-compare-hint">Compare payoff against previous configuration</span>
              </div>
              <div className="strat-compare-actions">
                <Button
                  type="button"
                  className={`strat-compare-toggle-btn ${isComparingPrevious ? "active" : ""}`}
                  onClick={() => setIsComparingPrevious(!isComparingPrevious)}
                >
                  {isComparingPrevious ? "Hide Comparison" : "Compare with Previous"}
                </Button>
                <Button
                  type="button"
                  className="strat-compare-revert-btn"
                  onClick={handleRevertToPrevious}
                >
                  ↩ Revert
                </Button>
              </div>
            </div>
          )}

          {/* Subheader: Symbol Quote Bar & Quick Stock Search */}
          <div className="strat-symbol-quote-bar">
            <div className="strat-quote-search-inline">
              <span className="strat-symbol-pill">{activeSymbol}</span>
              <Button
                type="button"
                className="strat-sym-quick-btn"
                onClick={() => setShowSymbolSearchMenu(!showSymbolSearchMenu)}
                title="Search Stock / ETF / Futures"
              >
                🔍 Search
              </Button>
            </div>
            <span className="strat-quote-name">{quote ? quote.companyName : activeSymbol}</span>
            {quote ? (
              <>
                <span className="strat-quote-price">${quote.price.toFixed(2)}</span>
                <span className={`strat-quote-change ${quote.change >= 0 ? "gain" : "loss"}`}>
                  {quote.change >= 0 ? "+" : ""}
                  {quote.changePercent.toFixed(2)}% ({quote.change >= 0 ? "+$" : "-$"}{Math.abs(quote.change).toFixed(2)})
                </span>
                <span className="strat-delayed-tag">↻ Realtime/Delayed</span>
              </>
            ) : (
              <span className="strat-quote-unavailable">
                {isQuoteRefreshing ? "Loading quote…" : quoteError || "Quote unavailable"}
              </span>
            )}
            <Button
              type="button"
              className="strat-mini-refresh-btn"
              onClick={handleRefreshOptions}
              disabled={isQuoteRefreshing}
              title={`Refresh ${activeSymbol} quote & options legs`}
             loading={isQuoteRefreshing}>
              <span className={isQuoteRefreshing ? "strat-spin" : ""}>↻</span> {"Refresh"}
            </Button>
          </div>


            {/* Inline Symbol Autocomplete Popover in Builder */}
            {showSymbolSearchMenu && (
              <>
                <div className="strat-symbol-dropdown-backdrop" onClick={() => setShowSymbolSearchMenu(false)} />
                <div className="strat-symbol-dropdown builder" onClick={(e) => e.stopPropagation()}>
                  <div className="strat-dropdown-search-wrap">
                    <TextInput
                      type="text"
                      value={symbolInput}
                      onChange={(e) => setSymbolInput(e.target.value)}
                      placeholder="Search symbol (e.g. NVDA, /ES)..."
                      autoFocus
                    />
                  </div>
                  <div className="strat-dropdown-header">Popular Stocks, ETFs & Futures</div>
                  <div className="strat-dropdown-list">
                    {filteredTickers.map((t) => (
                      <div
                        key={t.symbol}
                        className={`strat-dropdown-item ${t.symbol === activeSymbol ? "active" : ""}`}
                        onClick={() => handleSelectSymbol(t.symbol)}
                      >
                        <div className="strat-dropdown-sym-col">
                          <span className="strat-dropdown-sym">{t.symbol}</span>
                          <span className="strat-dropdown-name">{t.companyName}</span>
                        </div>
                        <div className="strat-dropdown-price-col">
                          {typeof t.price === "number" ? (
                            <>
                              <span className="strat-dropdown-price">${t.price.toFixed(2)}</span>
                              <span className={`strat-dropdown-pill ${(t.change ?? 0) >= 0 ? "gain" : "loss"}`}>
                                {(t.change ?? 0) >= 0 ? "+" : ""}{(t.changePercent ?? 0).toFixed(2)}%
                              </span>
                            </>
                          ) : (
                            <span className="strat-dropdown-price">Quote unavailable</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

          {/* Expiration Timeline Chips in Builder (Scrollable with Navigation Arrows) */}
          <div className="strat-builder-exp-bar">
            <div className="strat-builder-exp-title">
              EXPIRATION: <span className="highlight">{selectedExpiration.label}</span> ({selectedExpiration.dte} DTE)
            </div>
            <div className="strat-exp-chips-scroll-wrap">
              <Button
                type="button"
                className="strat-scroll-arrow left"
                onClick={() => scrollContainer(builderExpScrollRef, -240)}
                title="Scroll expirations left"
                aria-label="Scroll expirations left"
              >
                ‹
              </Button>
              <div
                className="strat-exp-chips-scroll"
                ref={builderExpScrollRef}
                onWheel={handleHorizontalWheel}
              >
                {expirations.map((exp) => (
                  <Button
                    key={exp.date}
                    type="button"
                    className={`strat-exp-chip strat-timeline-chip ${selectedExpiration.date === exp.date ? "active" : ""}`}
                    onClick={() => handleBuilderExpirationChange(exp)}
                    title={`${exp.label} (${exp.dte} DTE)`}
                  >
                    <span className="strat-chip-month">{exp.monthGroup}</span>
                    <span className="strat-chip-day">{exp.dayLabel}</span>
                  </Button>
                ))}
              </div>
              <Button
                type="button"
                className="strat-scroll-arrow right"
                onClick={() => scrollContainer(builderExpScrollRef, 240)}
                title="Scroll expirations right"
                aria-label="Scroll expirations right"
              >
                ›
              </Button>
            </div>
          </div>

          {/* Capability 3: Strike Ruler with Volume Bars & Call/Put Badges (Scrollable with ATM Centering & Nav Arrows) */}
          <div className="strat-strike-ruler-wrap">
            <div className="strat-strike-ruler-header">
              <div className="strat-ruler-title-group">
                <span className="strat-strike-ruler-title">STRIKE RULER:</span>
                {rulerStrikes.length > 0 && (
                  <span className="strat-ruler-range-hint">
                    {rulerStrikes.length} strikes (${rulerStrikes[0]} – ${rulerStrikes[rulerStrikes.length - 1]})
                  </span>
                )}
              </div>
              <div className="strat-ruler-quick-tools">
                <span className="strat-ruler-legend">
                  <span className="dot call"></span> Call (Green)
                  <span className="dot put"></span> Put (Red)
                  <span className="dot vol"></span> Vol Bars
                </span>
                <Button
                  type="button"
                  className="strat-ruler-shift-btn center-atm"
                  onClick={centerRulerOnAtm}
                  title={`Center strike ruler on ATM ($${spot.toFixed(2)})`}
                >
                  🎯 Center ATM
                </Button>
                <Button
                  type="button"
                  className="strat-ruler-shift-btn"
                  onClick={() => handleMoveAllStrikes(-1)}
                  title="Shift all strikes down 1 step"
                >
                  ◀ Move All
                </Button>
                <Button
                  type="button"
                  className="strat-ruler-shift-btn"
                  onClick={() => handleMoveAllStrikes(1)}
                  title="Shift all strikes up 1 step"
                >
                  Move All ▶
                </Button>
                <Button
                  type="button"
                  className="strat-ruler-shift-btn wings"
                  onClick={() => handleSymmetricMove(1)}
                  title="Expand wings symmetrically for condors & butterflies"
                >
                  ↔ Symmetric Wings
                </Button>
              </div>
            </div>

            <div className="strat-strike-ruler-container">
              <Button
                type="button"
                className="strat-ruler-nav-arrow left"
                onClick={() => scrollContainer(strikeRulerScrollRef, -280)}
                title="Scroll strikes left (lower strikes)"
                aria-label="Scroll strikes left"
              >
                ‹
              </Button>
              <div
                className="strat-strike-ruler"
                ref={strikeRulerScrollRef}
                onWheel={handleHorizontalWheel}
              >
                <div className="strat-ruler-ticks">
                  {rulerStrikes.map((k) => {
                    const callBuy = builderLegs.find((l) => l.strike === k && l.optionType === "CALL" && l.side === "BUY" && !l.isClosed);
                    const callSell = builderLegs.find((l) => l.strike === k && l.optionType === "CALL" && l.side === "SELL" && !l.isClosed);
                    const putBuy = builderLegs.find((l) => l.strike === k && l.optionType === "PUT" && l.side === "BUY" && !l.isClosed);
                    const putSell = builderLegs.find((l) => l.strike === k && l.optionType === "PUT" && l.side === "SELL" && !l.isClosed);
                    const isAtm = Math.abs(k - spot) < strikeStep * 0.5;

                    const distFromSpot = spot > 0 ? Math.abs(k - spot) / spot : 0;
                    const hasCallBadge = Boolean(callBuy || callSell);
                    const hasPutBadge = Boolean(putBuy || putSell);
                    const callVolHeight = Math.max(
                      3,
                      Math.min(hasCallBadge ? 6 : 16, Math.round(16 * Math.exp(-distFromSpot * 8)))
                    );
                    const putVolHeight = Math.max(
                      3,
                      Math.min(hasPutBadge ? 6 : 16, Math.round(16 * Math.exp(-distFromSpot * 8)))
                    );

                    return (
                      <div
                        key={k}
                        className={`strat-ruler-tick ${isAtm ? "highlight atm" : ""}`}
                        onClick={(e) => {
                          const firstLeg = builderLegs.find((l) => l.optionType !== "STOCK" && !l.isClosed);
                          if (firstLeg) handleStrikeChange(firstLeg.id, k, e);
                        }}
                        title={`Strike $${k}${isAtm ? " (ATM Spot)" : ""} · Click to set primary leg strike. Shift+Click moves all`}
                      >
                        {/* Upper Zone: Call Badges & Call Volume */}
                        <div className="strat-ruler-call-zone">
                          {callBuy && <div className="strat-ruler-badge call long">+{k}C</div>}
                          {callSell && <div className="strat-ruler-badge call short">-{k}C</div>}
                          <div
                            className="strat-vol-bar call"
                            style={{ height: `${callVolHeight}px` }}
                            title={`Call Volume at $${k}`}
                          />
                        </div>

                        {/* Center Zone: Tick Indicator & Strike Price Text */}
                        <div className="strat-ruler-center-zone">
                          <div className="strat-ruler-tick-bar" />
                          <span className="strat-ruler-price-txt">{k}</span>
                        </div>

                        {/* Lower Zone: Put Volume & Put Badges */}
                        <div className="strat-ruler-put-zone">
                          <div
                            className="strat-vol-bar put"
                            style={{ height: `${putVolHeight}px` }}
                            title={`Put Volume at $${k}`}
                          />
                          {putBuy && <div className="strat-ruler-badge put long">+{k}P</div>}
                          {putSell && <div className="strat-ruler-badge put short">-{k}P</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <Button
                type="button"
                className="strat-ruler-nav-arrow right"
                onClick={() => scrollContainer(strikeRulerScrollRef, 280)}
                title="Scroll strikes right (higher strikes)"
                aria-label="Scroll strikes right"
              >
                ›
              </Button>
            </div>
          </div>

          {/* Capability 8: Adjusting the Options (Legs Inspector Cards) */}
          <div className="strat-leg-strike-sliders-wrap">
            <div className="strat-leg-strike-sliders-title">
              <div className="strat-legs-title-text">
                <span>Option Legs Inspector ({builderLegs.length})</span>
                <span className="strat-legs-hint">
                  Edit price, quantity, side, cost basis or exclude/close individual legs
                </span>
              </div>
              <div className="strat-add-leg-btns">
                <div className="strat-leg-btn-pair">
                  <Button
                    type="button"
                    className="strat-add-leg-btn call"
                    onClick={() => handleAddLeg("CALL")}
                    title="Add a new Call option leg"
                  >
                    + Add Call
                  </Button>
                  <Button
                    type="button"
                    className="strat-remove-leg-btn call"
                    onClick={() => handleRemoveLegByType("CALL")}
                    disabled={!builderLegs.some((l) => l.optionType === "CALL")}
                    title={
                      builderLegs.some((l) => l.optionType === "CALL")
                        ? "Remove the last Call leg"
                        : "No Call legs to remove"
                    }
                  >
                    − Remove Call
                  </Button>
                </div>
                <div className="strat-leg-btn-pair">
                  <Button
                    type="button"
                    className="strat-add-leg-btn put"
                    onClick={() => handleAddLeg("PUT")}
                    title="Add a new Put option leg"
                  >
                    + Add Put
                  </Button>
                  <Button
                    type="button"
                    className="strat-remove-leg-btn put"
                    onClick={() => handleRemoveLegByType("PUT")}
                    disabled={!builderLegs.some((l) => l.optionType === "PUT")}
                    title={
                      builderLegs.some((l) => l.optionType === "PUT")
                        ? "Remove the last Put leg"
                        : "No Put legs to remove"
                    }
                  >
                    − Remove Put
                  </Button>
                </div>
              </div>
            </div>

            <div className="strat-legs-grid">
              {builderLegs.map((leg) => {
                const isExcluded = Boolean(leg.isExcluded);
                const isClosed = Boolean(leg.isClosed);
                const hasCustomCost = leg.customCostBasis !== undefined;
                const costBasis = hasCustomCost ? leg.customCostBasis! : leg.entryPrice;

                // Warnings (Capability 8)
                const isLowVol = (leg.volume ?? 120) < 50;
                const isLowOi = (leg.openInterest ?? 250) < 100;
                const spreadPct = leg.bid > 0 ? ((leg.ask - leg.bid) / leg.bid) * 100 : 0;
                const isWideSpread = spreadPct > 10;

                return (
                  <div
                    key={leg.id}
                    className={`strat-leg-card ${isExcluded ? "excluded" : ""} ${isClosed ? "closed" : ""}`}
                  >
                    <div className="strat-leg-header-row">
                      <div className="strat-leg-side-qty">
                        <Button
                          type="button"
                          className="strat-qty-btn"
                          onClick={() => handleLegQuantityChange(leg.id, -1)}
                          disabled={isClosed}
                        >
                          -
                        </Button>
                        <span className="strat-leg-qty">{leg.quantity}x</span>
                        <Button
                          type="button"
                          className="strat-qty-btn"
                          onClick={() => handleLegQuantityChange(leg.id, 1)}
                          disabled={isClosed}
                        >
                          +
                        </Button>

                        <Button
                          type="button"
                          className={`strat-side-pill ${leg.side.toLowerCase()}`}
                          onClick={() => handleLegSideToggle(leg.id)}
                          disabled={isClosed}
                          title="Toggle BUY / SELL"
                        >
                          {leg.side}
                        </Button>

                        <span className={`strat-type-pill ${leg.optionType.toLowerCase()}`}>
                          {leg.optionType}
                        </span>

                        <span className="strat-leg-strike-label">${leg.strike.toFixed(2)}</span>
                      </div>

                      <div className="strat-leg-cost-group">
                        <span className="strat-cost-label">Price:</span>
                        {editingLegCostId === leg.id ? (
                          <div className="strat-inline-edit-cost">
                            <TextInput
                              type="number"
                              step="0.05"
                              value={customCostInputValue}
                              onChange={(e) => setCustomCostInputValue(e.target.value)}
                              placeholder={leg.entryPrice.toFixed(2)}
                              autoFocus
                            />
                            <Button
                              type="button"
                              className="strat-cost-save-btn"
                              onClick={() => handleSaveCustomCost(leg.id)}
                            >
                              ✓
                            </Button>
                            <Button
                              type="button"
                              className="strat-cost-reset-btn"
                              onClick={() => handleResetCustomCost(leg.id)}
                              title="Reset to market price"
                            >
                              ✕
                            </Button>
                          </div>
                        ) : (
                          <Button
                            type="button"
                            className={`strat-cost-display-btn ${hasCustomCost ? "custom" : ""}`}
                            onClick={() => {
                              if (!isClosed) {
                                setEditingLegCostId(leg.id);
                                setCustomCostInputValue(costBasis.toFixed(2));
                              }
                            }}
                            title="Click to edit custom cost basis"
                          >
                            ${costBasis.toFixed(2)}
                            {hasCustomCost && <span className="strat-custom-cost-badge" title="Custom cost-basis applied">$</span>}
                          </Button>
                        )}
                      </div>

                      {/* Leg Actions: Exclude, Close, Roll, Remove */}
                      <div className="strat-leg-actions-group">
                        <Button
                          type="button"
                          className={`strat-leg-act-btn exclude ${isExcluded ? "active" : ""}`}
                          onClick={() => handleLegExcludeToggle(leg.id)}
                          title={isExcluded ? "Include in strategy" : "Exclude from calculations"}
                        >
                          {isExcluded ? "👁️ Excluded" : "👁️‍🗨️ Exclude"}
                        </Button>

                        {!isClosed && (
                          <Button
                            type="button"
                            className="strat-leg-act-btn close"
                            onClick={() => handleCloseLeg(leg.id)}
                            title="Close leg to lock in realized profit/loss"
                          >
                            ✓ Close
                          </Button>
                        )}

                        {isClosed && (
                          <span className="strat-closed-tag" title={`Closed @ $${(leg.closingPrice ?? 0).toFixed(2)}`}>
                            ✓ Closed @ ${(leg.closingPrice ?? 0).toFixed(2)}
                          </span>
                        )}

                        <Button
                          type="button"
                          className="strat-leg-act-btn roll"
                          onClick={() => setRollingLeg(leg)}
                          title="Roll to new strike or expiration date"
                        >
                          ↻ Roll
                        </Button>

                        <Button
                          type="button"
                          className="strat-leg-act-btn remove"
                          onClick={() => handleRemoveLeg(leg.id)}
                          title={`Remove this ${leg.side} ${leg.strike ? `$${leg.strike.toFixed(2)} ` : ""}${leg.optionType} leg from strategy`}
                          aria-label={`Remove leg ${leg.side} ${leg.strike} ${leg.optionType}`}
                        >
                          ✕ Remove
                        </Button>
                      </div>
                    </div>

                    {/* Greeks & Strike Slider */}
                    <div className="strat-leg-body-row">
                      <div className="strat-leg-greeks-strip">
                        <span className="strat-greek-chip iv" title="Implied Volatility (IV)">
                          IV {leg.optionType === "STOCK" ? "—" : `${(leg.impliedVolatility * 100).toFixed(1)}%`}
                        </span>
                        <span className="strat-greek-chip delta" title="Delta (Δ): Price sensitivity per $1 underlying move">
                          Δ {(leg.delta * (leg.side === "BUY" ? 1 : -1)).toFixed(2)}
                        </span>
                        <span className="strat-greek-chip gamma" title="Gamma (Γ): Delta rate of change per $1 underlying move">
                          Γ {leg.gamma.toFixed(3)}
                        </span>
                        <span className="strat-greek-chip theta" title="Theta (θ): Time decay per day">
                          θ {(leg.theta * 100).toFixed(1)}/d
                        </span>
                        <span className="strat-greek-chip vega" title="Vega (ν): Sensitivity per 1% change in implied volatility">
                          ν {(leg.vega * 100).toFixed(1)}/1%
                        </span>
                        <span className="strat-greek-chip rho" title="Rho (ρ): Sensitivity per 1% change in interest rates">
                          ρ {(((leg.rho ?? 0) * (leg.side === "BUY" ? 1 : -1)) * 100).toFixed(2)}/1%
                        </span>
                        <span className="strat-greek-chip vanna" title="Vanna: Delta sensitivity per 1% IV change (dDelta/dVol)">
                          Vanna {(((leg.vanna ?? 0) * (leg.side === "BUY" ? 1 : -1)) * 100).toFixed(3)}
                        </span>
                        <span className="strat-greek-chip charm" title="Charm: Delta decay per calendar day (dDelta/dt)">
                          Charm {(((leg.charm ?? 0) * (leg.side === "BUY" ? 1 : -1)) * 100).toFixed(3)}/d
                        </span>
                        <span className="strat-greek-chip vomma" title="Vomma: Vega convexity per 1% IV change (dVega/dVol)">
                          Vomma {(((leg.vomma ?? 0) * (leg.side === "BUY" ? 1 : -1)) * 100).toFixed(3)}
                        </span>
                        <span className="strat-spread-txt" title="Real-time NBBO market bid/ask">
                          Bid: ${leg.bid.toFixed(2)} · Ask: ${leg.ask.toFixed(2)}
                        </span>
                      </div>

                      {/* Warnings Badges */}
                      {(isLowVol || isLowOi || isWideSpread) && (
                        <div className="strat-leg-warnings-row">
                          {isLowVol && <span className="strat-warn-badge">⚠️ Low Vol</span>}
                          {isLowOi && <span className="strat-warn-badge">⚠️ Low OI</span>}
                          {isWideSpread && <span className="strat-warn-badge">⚠️ Wide Spread</span>}
                        </div>
                      )}

                      {!isClosed && (
                        <div className="strat-leg-slider-row">
                          <Button
                            type="button"
                            className="strat-strike-step-btn"
                            onClick={(e) => handleStrikeStep(leg.id, -1, e)}
                            title="Step strike down (Hold shift to move all)"
                          >
                            ◀ -
                          </Button>
                          <TextInput
                            type="range"
                            min={minStrike}
                            max={maxStrike}
                            step={strikeStep}
                            value={leg.strike}
                            onChange={(e) => handleStrikeChange(leg.id, Number(e.target.value), e)}
                            className="strat-leg-strike-range"
                          />
                          <Button
                            type="button"
                            className="strat-strike-step-btn"
                            onClick={(e) => handleStrikeStep(leg.id, 1, e)}
                            title="Step strike up (Hold shift to move all)"
                          >
                            + ▶
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Capability 4: Simultaneous Side-by-Side Stats & Greeks Display */}
          <div className="strat-stats-card-container">
            <div className="strat-stats-header-tabs">
              <Button
                type="button"
                className={`strat-stats-tab ${showKeyStats ? "active" : ""}`}
                onClick={toggleKeyStats}
                title={showKeyStats ? "Key Stats & P&L active (click to toggle)" : "Click to enable Key Stats & P&L"}
              >
                📊 Key Stats & P&L
              </Button>
              <Button
                type="button"
                className={`strat-stats-tab ${showNetGreeks ? "active" : ""}`}
                onClick={toggleNetGreeks}
                title={showNetGreeks ? "Net Option Greeks active (click to toggle)" : "Click to enable Net Option Greeks"}
              >
                📐 Net Option Greeks (Δ Γ Θ ν ρ)
              </Button>
              {(!showKeyStats || !showNetGreeks) && (
                <Button
                  type="button"
                  className="strat-stats-tab reset-both"
                  onClick={() => {
                    setShowKeyStats(true);
                    setShowNetGreeks(true);
                  }}
                  title="Enable both side-by-side"
                >
                  ⚡ Show Both Side-by-Side
                </Button>
              )}
            </div>

            <div className={`strat-stats-side-by-side-row ${showKeyStats && showNetGreeks ? "dual" : "single"}`}>
              {showKeyStats && (
                <div className={`strat-stats-panel-col key-stats ${!showNetGreeks ? "full" : ""}`}>
                  <div className={`strat-metrics-strip ${showKeyStats && showNetGreeks ? "side-by-side" : ""}`}>
                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">
                        🪙 {selectedStrategy && selectedStrategy.netDebit >= 0 ? "NET DEBIT:" : "NET CREDIT:"}
                      </span>
                      <span className="strat-metric-val">
                        ${Math.abs(selectedStrategy?.netDebit ?? 0).toLocaleString()}
                      </span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">📊 EST. MARGIN:</span>
                      <span className="strat-metric-val">
                        ${(selectedStrategy?.estMargin ?? 0).toLocaleString()}
                      </span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">↘ MAX LOSS:</span>
                      <span className="strat-metric-val loss">
                        {selectedStrategy?.maxLoss === null ? "Infinite" : `$${selectedStrategy?.maxLoss?.toLocaleString()}`}
                      </span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">↗ MAX PROFIT:</span>
                      <span className="strat-metric-val gain">
                        {selectedStrategy?.maxProfit === null ? "Unlimited" : `$${selectedStrategy?.maxProfit?.toLocaleString()}`}
                      </span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">🎲 CHANCE OF PROFIT:</span>
                      <span className="strat-metric-val highlight">
                        {selectedStrategy?.chanceOfProfit ?? 50}% 🔒
                      </span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">→ BREAKEVEN:</span>
                      <span className="strat-metric-val breakeven">
                        {selectedStrategy?.breakevenText || `Below $${spot.toFixed(2)}`}
                      </span>
                    </div>

                    {/* Realized & Unrealized P&L Display */}
                    {(pnlBreakdown.hasClosedPositions || pnlBreakdown.hasCustomCostBasis) && (
                      <>
                        <div className="strat-metric-cell">
                          <span className="strat-metric-label">💰 REALIZED P&L:</span>
                          <span className={`strat-metric-val ${pnlBreakdown.realizedPnl >= 0 ? "gain" : "loss"}`}>
                            {pnlBreakdown.realizedPnl >= 0 ? "+" : ""}${pnlBreakdown.realizedPnl.toFixed(2)}
                          </span>
                        </div>
                        <div className="strat-metric-cell">
                          <span className="strat-metric-label">📈 UNREALIZED P&L:</span>
                          <span className={`strat-metric-val ${pnlBreakdown.unrealizedPnl >= 0 ? "gain" : "loss"}`}>
                            {pnlBreakdown.unrealizedPnl >= 0 ? "+" : ""}${pnlBreakdown.unrealizedPnl.toFixed(2)}
                          </span>
                        </div>
                      </>
                    )}

                    {flowTradeBanner && !pnlBreakdown.hasClosedPositions && !pnlBreakdown.hasCustomCostBasis && (
                      <div className="strat-metric-cell">
                        <span className="strat-metric-label">💰 UNREALIZED LOSS:</span>
                        <span className="strat-metric-val loss">
                          {flowTradeBanner.returnText.split(" return")[0]}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {showNetGreeks && (
                <div className={`strat-stats-panel-col net-greeks ${!showKeyStats ? "full" : ""}`}>
                  <div className={`strat-metrics-strip greeks ${showKeyStats && showNetGreeks ? "side-by-side" : ""}`}>
                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">Δ NET DELTA:</span>
                      <span className={`strat-metric-val ${netGreeks.netDelta >= 0 ? "gain" : "loss"}`}>
                        {netGreeks.netDelta >= 0 ? "+" : ""}{netGreeks.netDelta}
                      </span>
                      <span className="strat-greek-sub">Shares equiv</span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">Γ NET GAMMA:</span>
                      <span className="strat-metric-val">
                        {netGreeks.netGamma}
                      </span>
                      <span className="strat-greek-sub">Δ change / $1</span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">Θ NET THETA:</span>
                      <span className={`strat-metric-val ${netGreeks.netTheta >= 0 ? "gain" : "loss"}`}>
                        {netGreeks.netTheta >= 0 ? "+" : ""}${netGreeks.netTheta}/day
                      </span>
                      <span className="strat-greek-sub">Time decay / day</span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">ν NET VEGA:</span>
                      <span className={`strat-metric-val ${netGreeks.netVega >= 0 ? "gain" : "loss"}`}>
                        ${netGreeks.netVega}/1%
                      </span>
                      <span className="strat-greek-sub">PnL / 1% IV</span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">ρ NET RHO:</span>
                      <span className="strat-metric-val">
                        ${netGreeks.netRho}/1%
                      </span>
                      <span className="strat-greek-sub">Rate sensitivity</span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">IV WEIGHTED:</span>
                      <span className="strat-metric-val">
                        {netGreeks.weightedIv !== undefined ? `${(netGreeks.weightedIv * 100).toFixed(1)}%` : "—"}
                      </span>
                      <span className="strat-greek-sub">Net implied vol</span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">VANNA:</span>
                      <span className={`strat-metric-val ${(netGreeks.netVanna ?? 0) >= 0 ? "gain" : "loss"}`}>
                        {(netGreeks.netVanna ?? 0) >= 0 ? "+" : ""}{netGreeks.netVanna ?? 0}
                      </span>
                      <span className="strat-greek-sub">Δ shift / 1% IV</span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">CHARM:</span>
                      <span className={`strat-metric-val ${(netGreeks.netCharm ?? 0) >= 0 ? "gain" : "loss"}`}>
                        {(netGreeks.netCharm ?? 0) >= 0 ? "+" : ""}{netGreeks.netCharm ?? 0}/d
                      </span>
                      <span className="strat-greek-sub">Δ decay / day</span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">VOMMA:</span>
                      <span className={`strat-metric-val ${(netGreeks.netVomma ?? 0) >= 0 ? "gain" : "loss"}`}>
                        {(netGreeks.netVomma ?? 0) >= 0 ? "+" : ""}{netGreeks.netVomma ?? 0}
                      </span>
                      <span className="strat-greek-sub">ν shift / 1% IV</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Capability 6: Payoff Chart OR Capability 5: 2D Heatmap Matrix Table */}
          {builderDisplayMode === "graph" ? (
            <div className="strat-full-graph-wrap">
              <UniversalChart
                mode="payoff"
                points={builderGraphPoints.map((pt) => ({ x: pt.price, y: pt.pnlExpiry }))}
                secondaryPoints={
                  tRemainingDays > 0
                    ? builderGraphPoints.map((pt) => ({ x: pt.price, y: pt.pnlEvaluated }))
                    : undefined
                }
                comparisonPoints={comparisonGraphPoints}
                probabilityOverlayPoints={probabilityOverlayPoints}
                hoverProbabilities={hoverProbabilities}
                spotPrice={spot}
                targetPrice={targetPrice}
                breakevens={selectedStrategy?.breakevens || []}
                hoverX={graphHoverPrice}
                onHoverXChange={setGraphHoverPrice}
                width={850}
                height={350}
                ariaLabel={`${currentStrategyName} interactive payoff chart`}
              />
            </div>
          ) : (
            /* Capability 5: 2D Profit/Loss Matrix Heatmap Table */
            <div className="strat-table-view-wrap">
              <div className="strat-matrix-toolbar">
                <span className="strat-matrix-title">
                  ⊞ Profit/Loss Heatmap Matrix (Prices vs Calendar Dates)
                </span>
                <span className="strat-matrix-legend">
                  🪙 Ex-Dividend · 📢 Earnings
                </span>
              </div>
              <div className="strat-matrix-scroll-wrap">
                <Table
                  className="strat-matrix-table"
                  columns={[
                    {
                      key: "price",
                      header: "Price",
                      headerClassName: "sticky-col",
                      cellClassName: "sticky-col price-cell",
                      render: (row) => (
                        <>
                          {row.priceLabel} {row.isAtSpot && <span className="spot-tag">● Spot</span>}
                        </>
                      ),
                    },
                    ...matrix2dData.columns.map((col, colIdx) => ({
                      key: col.dateStr,
                      header: (
                        <div className="strat-th-content">
                          <span>{col.label}</span>
                          <span className="strat-th-dte">({col.dteRemaining}d)</span>
                          {col.isExDiv && <span title="Estimated Ex-Dividend Date">🪙</span>}
                          {col.isEarnings && <span title="Upcoming Earnings Announcement">📢</span>}
                        </div>
                      ),
                      cellClassName: (row: Matrix2dRow) =>
                        row.cells[colIdx].pnlDollar >= 0 ? "matrix-cell gain" : "matrix-cell loss",
                      cellStyle: (row: Matrix2dRow) => ({
                        background: matrixCellBg(row.cells[colIdx], matrix2dData.maxPnl, matrix2dData.minPnl),
                      }),
                      render: (row: Matrix2dRow) => matrixCellDisplay(row.cells[colIdx], builderMetricMode),
                    })),
                  ]}
                  rows={matrix2dData.rows}
                  rowKey={(row) => String(row.price)}
                  rowClassName={(row) => (row.isAtSpot ? "current-price-row" : "")}
                />
              </div>
            </div>
          )}

          {/* Controls Directly at Bottom of Chart: Unified Space-Conserving Bar */}
          <div className="strat-chart-unified-footer-bar">
            {/* Left: View Mode (Graph / Matrix) & Matrix Metrics */}
            <div className="strat-footer-mode-group">
              <SegmentedControl
                ariaLabel="Payoff display mode"
                value={builderDisplayMode}
                onChange={(val) => setBuilderDisplayMode(val as "graph" | "table")}
                options={[
                  { id: "graph", label: "Graph", icon: "📈" },
                  { id: "table", label: "Matrix Table", icon: "⊞" },
                ]}
                size="sm"
              />

              <PillGroup
                ariaLabel="Matrix metric mode"
                value={builderMetricMode}
                onChange={(val) => setBuilderMetricMode(val as "pnl_dollar" | "pnl_pct" | "contract_val" | "collateral_pct")}
                variant="cyan"
                size="sm"
                options={[
                  { id: "pnl_dollar", label: "P/L ($)" },
                  { id: "pnl_pct", label: "P/L (%)" },
                  { id: "collateral_pct", label: "% Risk" },
                  { id: "contract_val", label: "Value" },
                ]}
              />
            </div>

            {/* Center: Date Slider */}
            <div className="strat-footer-date-group">
              <span className="strat-footer-slider-label">
                DATE:{" "}
                {builderDateSliderPct === 100
                  ? `At Exp (${selectedExpiration.label})`
                  : builderDateSliderPct === 0
                  ? `Today (${selectedExpiration.dte}d)`
                  : `In ${Math.round((builderDateSliderPct / 100) * selectedExpiration.dte)}d (${Math.round(tRemainingDays)}d)`}
              </span>
              <TextInput
                type="range"
                min={0}
                max={100}
                value={builderDateSliderPct}
                onChange={(e) => setBuilderDateSliderPct(Number(e.target.value))}
                className="strat-date-range-slider compact"
              />
            </div>

            {/* Right: Range Zoom & IV Adjustment */}
            <div className="strat-footer-tools-group">
              <div className="strat-zoom-btn-group compact">
                <span className="strat-footer-sub-label">RANGE:</span>
                <Button
                  type="button"
                  className={`strat-zoom-btn ${builderZoomLevel === "x1" ? "active" : ""}`}
                  onClick={() => setBuilderZoomLevel("x1")}
                >
                  ±20%
                </Button>
                <Button
                  type="button"
                  className={`strat-zoom-btn ${builderZoomLevel === "x2" ? "active" : ""}`}
                  onClick={() => setBuilderZoomLevel("x2")}
                >
                  ±40%
                </Button>
                <Button
                  type="button"
                  className={`strat-zoom-btn ${builderZoomLevel === "x3" ? "active" : ""}`}
                  onClick={() => setBuilderZoomLevel("x3")}
                >
                  ±70%
                </Button>
              </div>

              <div className="strat-footer-iv-group">
                <span className="strat-footer-sub-label">IV: {builderIv.toFixed(1)}%</span>
                <div className="strat-iv-presets mini">
                  <Button
                    type="button"
                    className="strat-iv-btn mini crush"
                    onClick={() => setBuilderIv(Math.max(10, Number((builderIv * 0.75).toFixed(1))))}
                    title="Simulate IV Crush (-25%)"
                  >
                    -25%
                  </Button>
                  <Button
                    type="button"
                    className="strat-iv-btn mini surge"
                    onClick={() => setBuilderIv(Math.min(150, Number((builderIv * 1.25).toFixed(1))))}
                    title="Simulate IV Expansion (+25%)"
                  >
                    +25%
                  </Button>
                  <Button
                    type="button"
                    className="strat-iv-btn mini reset"
                    onClick={() => setBuilderIv(44.2)}
                    title="Reset IV to baseline"
                  >
                    ↺
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          MODAL 1: CHOOSE A STRATEGY (50+ PRE-MADE STRATEGIES - CAPABILITY 1)
          ==================================================================== */}
      <StrategyLibraryModal
        isOpen={showStrategyModal}
        onClose={() => setShowStrategyModal(false)}
        strategies={strategyInfos}
        onSelect={(id) => {
          const def = STRATEGY_LIBRARY.find((d) => d.id === id);
          if (def) handleSelectPreMadeStrategy(def);
        }}
        onHover={(id) =>
          setHoveredStrategyDef(id ? STRATEGY_LIBRARY.find((d) => d.id === id) ?? null : null)
        }
        onAnalyzeRisk={(id) => {
          const def = STRATEGY_LIBRARY.find((d) => d.id === id);
          if (!def) return;
          setRiskSubject({
            title: def.name,
            underlyingSymbol: activeSymbol,
            underlyingPrice: spot,
            strategyType: def.name,
            sentiment: def.theses[0] || "neutral",
            dte: selectedExpiration.dte,
            legsText: `${def.legsCount} legs (${def.riskType} Risk)`,
            breakevenText: def.subtitle,
          });
        }}
      />

      {/* ====================================================================
          MODAL 2: ROLL LEG MODAL (CAPABILITY 8 & 11)
          ==================================================================== */}
      {rollingLeg && (
                <Modal open={Boolean(rollingLeg)} onClose={() => setRollingLeg(null)} size="none" panelClassName="strat-roll-modal" ariaLabel="Roll option leg">
            <div className="strat-modal-header">
              <h3>Roll Option Leg</h3>
              <Button type="button" className="strat-modal-close-btn" onClick={() => setRollingLeg(null)}>
                ✕
              </Button>
            </div>

            <div className="strat-roll-body">
              <p className="strat-roll-subtitle">
                Rolling {rollingLeg.side} {rollingLeg.quantity}x {rollingLeg.strike}{rollingLeg.optionType[0]} ({rollingLeg.expirationDate})
              </p>

              <div className="strat-roll-field">
                <FieldShell id="strat-roll-exp" label="Select New Expiration Date:">
                  <div className="strat-roll-exp-chips">
                    {expirations.map((exp) => (
                      <Button
                        key={exp.date}
                        type="button"
                        className={`strat-roll-exp-chip ${exp.date === selectedExpiration.date ? "active" : ""}`}
                        onClick={() => handleExecuteRoll(exp.dte, exp.date, rollingLeg.strike)}
                      >
                        {exp.label} ({exp.dte}d)
                      </Button>
                    ))}
                  </div>
                </FieldShell>
              </div>

              <div className="strat-roll-field">
                <FieldShell id="strat-roll-strikes" label="Select New Strike Price:">
                  <div className="strat-roll-strikes-grid">
                    {rulerStrikes.map((k) => (
                      <Button
                        key={k}
                        type="button"
                        className={`strat-roll-strike-btn ${k === rollingLeg.strike ? "current" : ""}`}
                        onClick={() => handleExecuteRoll(selectedExpiration.dte, selectedExpiration.date, k)}
                      >
                        ${k}
                      </Button>
                    ))}
                  </div>
                </FieldShell>
              </div>
            </div>
                  </Modal>
      )}

      {/* ====================================================================
          MODAL 3: PRICE HISTORY MODAL (CAPABILITY 9)
          ==================================================================== */}
      {showHistoryModal && (
                <Modal open={showHistoryModal} onClose={() => setShowHistoryModal(false)} size="none" panelClassName="strat-history-modal" ariaLabel="Strategy price history">
            <div className="strat-modal-header">
              <div>
                <h3>Strategy Price History (Past 30 Days)</h3>
                <span className="strat-modal-sub">
                  Historical contract value of {activeSymbol} {currentStrategyName}
                </span>
              </div>
              <Button type="button" className="strat-modal-close-btn" onClick={() => setShowHistoryModal(false)}>
                ✕
              </Button>
            </div>

            <div className="strat-history-stats-row">
              <div className="strat-hstat-cell">
                <span className="label">Current Value:</span>
                <span className="val">${Math.abs(selectedStrategy?.netDebit ?? 250).toFixed(2)}</span>
              </div>
              <div className="strat-hstat-cell">
                <span className="label">30d High:</span>
                <span className="val gain">${(Math.abs(selectedStrategy?.netDebit ?? 250) * 1.45).toFixed(2)}</span>
              </div>
              <div className="strat-hstat-cell">
                <span className="label">30d Low:</span>
                <span className="val loss">${(Math.abs(selectedStrategy?.netDebit ?? 250) * 0.65).toFixed(2)}</span>
              </div>
              <div className="strat-hstat-cell">
                <span className="label">Average:</span>
                <span className="val">${(Math.abs(selectedStrategy?.netDebit ?? 250) * 1.05).toFixed(2)}</span>
              </div>
            </div>

            <div style={{ height: "220px", width: "100%", margin: "1rem 0" }}>
              <UniversalChart
                mode="line"
                points={Array.from({ length: 30 }, (_, i) => {
                  const day = i + 1;
                  const base = Math.abs(selectedStrategy?.netDebit ?? 250);
                  const noise = Math.sin(i / 3) * (base * 0.2) + Math.cos(i / 5) * (base * 0.1);
                  return { x: day, y: Number(Math.max(1, base + noise).toFixed(2)) };
                })}
                width={700}
                height={220}
                formatX={(d) => `Day ${d}`}
                formatY={(v) => `$${v}`}
                ariaLabel="Historical Strategy Price Chart"
              />
            </div>

            <p className="strat-history-note">
              Note: Historical price reflects the contract unit price over time, not realized portfolio profit or loss.
            </p>
                  </Modal>
      )}

      {/* ====================================================================
          MODAL 4: SAVE TRADE DIALOG (CAPABILITY 10)
          ==================================================================== */}
      {showSaveModal && (
                <Modal open={showSaveModal} onClose={() => setShowSaveModal(false)} size="none" panelClassName="strat-save-modal" ariaLabel="Save trade strategy">
            <div className="strat-modal-header">
              <h3>Save Trade Strategy</h3>
              <Button type="button" className="strat-modal-close-btn" onClick={() => setShowSaveModal(false)}>
                ✕
              </Button>
            </div>

            <div className="strat-save-form">
              <TextInput label="Strategy / Trade Name:"
                type="text"
                value={saveTradeName}
                onChange={(e) => setSaveTradeName(e.target.value)}
                placeholder="e.g. TSLA Bull Call Spread Earnings"
                autoFocus
              />

              <TextInput label="Trading Notes & Rationale (Optional):" multiline
                value={saveTradeNotes}
                onChange={(e) => setSaveTradeNotes(e.target.value)}
                placeholder="Targeting $450 breakout after delivery report. Max loss defined at $250."
                rows={3}
              />

              <div className="strat-save-actions">
                <Button
                  type="button"
                  className="strat-save-submit-btn"
                  onClick={handleSaveTrade}
                >
                  Save to My Trades 💾
                </Button>
                <Button
                  type="button"
                  className="strat-save-cancel-btn"
                  onClick={() => setShowSaveModal(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
                  </Modal>
      )}

      {/* ====================================================================
          MODAL 5: SAVED TRADES DRAWER (CAPABILITY 11)
          ==================================================================== */}
      {showSavedTradesModal && (
                <Modal open={showSavedTradesModal} onClose={() => setShowSavedTradesModal(false)} size="none" panelClassName="strat-saved-trades-modal" ariaLabel="My saved trades">
            <div className="strat-modal-header">
              <div>
                <h3>My Saved Trades ({savedTrades.length})</h3>
                <span className="strat-modal-sub">Track profit/loss and reopen saved positions</span>
              </div>
              <Button type="button" className="strat-modal-close-btn" onClick={() => setShowSavedTradesModal(false)}>
                ✕
              </Button>
            </div>

            <div className="strat-saved-trades-list">
              {savedTrades.length === 0 ? (
                <div className="strat-no-saved-trades">
                  <span>No saved trades yet. Use the "Save" button to store a trade!</span>
                </div>
              ) : (
                savedTrades.map((t) => (
                  <div key={t.id} className="strat-saved-trade-card">
                    <div className="strat-saved-trade-header">
                      <div>
                        <span className="strat-saved-name">{t.name}</span>
                        <span className="strat-saved-meta">
                          {t.symbol} · {t.expirationDate} ({t.dte}d) · Saved {t.createdAt}
                        </span>
                      </div>
                      <div className="strat-saved-card-btns">
                        <Button
                          type="button"
                          className="strat-saved-load-btn"
                          style={{ borderColor: "var(--color-warning)", color: "var(--color-warning)" }}
                          onClick={() => {
                            setRiskSubject({
                              title: t.name,
                              underlyingSymbol: t.symbol,
                              underlyingPrice: t.underlyingPriceAtSave,
                              strategyType: t.strategyName,
                              expirationDate: t.expirationDate,
                              dte: t.dte,
                              legsText: t.legs.map((l) => `${l.side} ${l.quantity} ${l.strike}${l.optionType[0]}`).join(" / "),
                              legs: t.legs.map((l) => ({
                                side: l.side,
                                quantity: l.quantity,
                                strike: l.strike,
                                optionType: l.optionType,
                                entryPrice: l.entryPrice,
                                delta: l.delta,
                                gamma: l.gamma,
                                theta: l.theta,
                                vega: l.vega,
                              })),
                            });
                          }}
                          title="Analyze Risk for Saved Trade"
                        >
                          🛡️ Risk
                        </Button>
                        <Button
                          type="button"
                          className="strat-saved-load-btn"
                          onClick={() => handleLoadSavedTrade(t)}
                        >
                          Load Trade ↗
                        </Button>
                        <Button
                          type="button"
                          className="strat-saved-del-btn"
                          onClick={() => handleDeleteSavedTrade(t.id)}
                        >
                          ✕
                        </Button>
                      </div>
                    </div>

                    {t.notes && <p className="strat-saved-notes">"{t.notes}"</p>}

                    <div className="strat-saved-legs-chips">
                      {t.legs.map((l) => (
                        <span key={l.id} className="strat-saved-leg-chip">
                          {l.side} {l.quantity}x {l.strike}{l.optionType[0]}
                        </span>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
                  </Modal>
      )}

      {/* ====================================================================
          DRAWER: POSITIONS DRAWER (CAPABILITY 11)
          ==================================================================== */}
      {showPositionsDrawer && (
        <div className="strat-positions-drawer">
          <div className="strat-drawer-header">
            <h4>Positions & Leg Status</h4>
            <Button type="button" className="strat-drawer-close" onClick={() => setShowPositionsDrawer(false)}>
              ✕
            </Button>
          </div>

          <div className="strat-drawer-content">
            <div className="strat-drawer-section">
              <h5>Open Legs ({builderLegs.filter((l) => !l.isClosed).length})</h5>
              {builderLegs.filter((l) => !l.isClosed).map((l) => (
                <div key={l.id} className="strat-pos-item open">
                  <span>{l.side} {l.quantity}x {l.strike}{l.optionType[0]}</span>
                  <span>Cost: ${(l.customCostBasis ?? l.entryPrice).toFixed(2)}</span>
                  <Button type="button" onClick={() => handleCloseLeg(l.id)}>Close</Button>
                </div>
              ))}
            </div>

            <div className="strat-drawer-section">
              <h5>Closed / Rolled Legs ({builderLegs.filter((l) => l.isClosed).length})</h5>
              {builderLegs.filter((l) => l.isClosed).length === 0 ? (
                <p className="empty-txt">No closed positions</p>
              ) : (
                builderLegs.filter((l) => l.isClosed).map((l) => (
                  <div key={l.id} className="strat-pos-item closed">
                    <span>{l.side} {l.quantity}x {l.strike}{l.optionType[0]}</span>
                    <span className="gain">Closed @ ${(l.closingPrice ?? 0).toFixed(2)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Neural Strategy LLM Evaluation & Options Data Export Modal */}
      <LlmStrategyEvalModal
        isOpen={Boolean(evaluatingStrategy)}
        onClose={() => setEvaluatingStrategy(null)}
        strategy={evaluatingStrategy}
        activeEnv={activeEnv}
        userLogin={userLogin}
        onPreviewTrade={onPreviewTrade}
      />

      {/* Institutional Risk Analysis & Defense Playbook Modal */}
      <RiskAnalysisModal
        isOpen={Boolean(riskSubject)}
        onClose={() => setRiskSubject(null)}
        subject={riskSubject}
        onSendPrompt={onSendPrompt}
      />
    </div>
  );
}
