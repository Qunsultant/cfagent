import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { apiFetch as fetch } from "./apiFetch";
import { mapScreenError } from "./paidScreenSubmit";
import { getDisplayUserDid } from "../agents/did";
import { codedMessage, resolveOutcome } from "../outcomes/outcomeAspects";
import { Card, Badge, TextInput, Button, EmptyState, Select, Spinner, Table, Modal, Notice, PageShell, FieldShell, useToast } from "./components/ui";
import { getRoute } from "./routes";
import { parseTabFromSearch, subscribeToRouteChanges } from "./router";
import { readTenantProvidersState, useTenantProviders, BROKER_OPTIONS } from "./tenantProviders";
import {
  ETradeQuote,
  ScreenedStockItem,
  ETradeOrderDraft,
  ETradeOrderExecutionResult,
  ETradePosition,
  ETradeAccount,
  ETradeBrokerStatus,
  TradeRecord,
} from "../types";
import type { TradeAssetClass, TradeOrderContext } from "./trading/tradeOrderContext";
import { PortfolioRiskPanel } from "./PortfolioRiskPanel";
import { brokerSectionNav } from "./brokerSectionNav";
import type { RiskBroker } from "./portfolioRiskApi";
import { brokerSupports, isBrokerId } from "../trading";
import { brokerModeBadge, brokerPresentation } from "../trading/brokerPresentation";
import {
  accountsFromPayload,
  formatMoney,
  formatSignedMoney,
  portfolioFromPayload,
  portfolioSummary,
} from "./brokerPortfolio";
import { TradingApprovalsQueue } from "./TradingApprovalsQueue";
import { AccountPanels } from "./AccountPanels";
import { AlpacaBrokerPanel } from "./AlpacaBrokerPanel";
import { AlpacaSignInCard } from "./AlpacaSignInCard";
import {
  accountsEndpoint,
  connectStatusEndpoint,
  diagnosticsEndpoint,
  positionsEndpoint,
  quoteEndpoint,
  statusEndpoint,
  stockScreenEndpoint,
} from "./brokerEndpoints";
import { ErrorBoundary } from "./ErrorBoundary";
import { ScreenersHub, type ScreenersHubTab } from "./ScreenersHub";
import { GoalScreenPanel } from "./GoalScreenPanel";
import { ReportsPanel } from "./ReportsPanel";
import { ScreeningReviewPanel } from "./ScreeningReviewPanel";
import { TrackRecordPanel } from "./TrackRecordPanel";
import { OrderTicketPanel } from "./OrderTicketPanel";
import { OptionsHub, type OptionsHubTab } from "./OptionsHub";
import { StockHub, type StockHubTab } from "./StockHub";
import { ETradeDynamicMenu, type ETradeDynamicMenuProps } from "./ETradeDynamicMenu";
import {
  fetchBrokerEnvironment,
  switchBrokerEnvironment,
  useBrokerEnvironment,
} from "./brokerEnvironment";
import { EtapiConfigModal } from "./options/EtapiConfigModal";
import { RiskAnalysisModal } from "./options/RiskAnalysisModal";
import { TradeExecutionPreview } from "./TradeExecutionPreview";
import type { RiskSubject } from "./options/riskManagementEngine";

/**
 * C2 (consolidation #1151, issue #1246): the S8 "Screening Moved"
 * redirect notices are retired. The Trading Hub's screening subtabs
 * (options research, strategy scanner, IV history, reports)
 * render the ONE screening hub — ScreenersHub — directly on the
 * equivalent tab, so every legacy deep link lands on the live
 * surface with no interstitial. Reports is hosted by the hub as a
 * tab now; it is no longer mounted here. Schedules left the hub in
 * #3121 S2 — it renders from the shell (Chat.tsx TAB_CONTENT →
 * SchedulesHome), the one schedules surface.
 */
import { ResearchReportActions } from "./ResearchReportActions";
import { AutopilotControlCenter } from "./components/AutopilotControlCenter";

export interface User {
  login: string;
  name?: string;
  avatar?: string;
  /** Issue #1759: login provider id for this session; absent for legacy sessions. */
  providerId?: string;
}

export type TradingSubTab =
  | "autopilot"
  | "scanner"
  | "screeners"
  | "stock-hub"
  | "reports"
  | "goal-screen"
  | "review"
  | "track-record"
  | "iv-history"
  | "options"
  | "assets-hub"
  | "order"
  | "portfolio"
  | "ledger"
  | "omnichannel"
  | "voice";

export interface ETradeTradingHubProps {
  user?: User;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  activeSubTab?: TradingSubTab;
  onSelectSubTab?: (tab: TradingSubTab) => void;
  onBrokerPropsChange?: (props: ETradeDynamicMenuProps) => void;
  /** Issue #69: unread broker-alert count, reported up for the nav badge. */
  onUnreadAlertsChange?: (count: number) => void;
}

const NLQ_ROW_RENDER_LIMIT = 500;

function formatNlqColumn(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return spaced.replace(/\bOi\b/g, "OI").replace(/\bIv\b/g, "IV").replace(/\bDte\b/g, "DTE").toUpperCase();
}

/**
 * Issue #3197: a pre-opened authorization tab must never be left
 * blank on start failure. Close it when possible; when the close
 * does not take effect (the tab stays open), navigate it back to
 * the app with the outcome code, so the hub banner in THAT tab
 * shows the error. Only the code — never free text — travels in
 * the URL, and it is resolved against the outcome catalog on
 * mount, so no URL-supplied text is ever rendered (same principle
 * as #2402's auth_outcome handling).
 */
/**
 * Issue #3197: the pre-opened tab is ours for a few seconds while the
 * start call runs. Fill it with an honest placeholder so the user never
 * stares at a bare about:blank, even if the call hangs to its timeout.
 * Same-origin about:blank, so this write is allowed; guarded because the
 * user may already have closed the tab (or a policy may deny the access).
 */
function showConnectingPlaceholder(authTab: Window) {
  try {
    authTab.document.title = "Connecting to E*TRADE…";
    authTab.document.body.textContent =
      "Connecting to E*TRADE… You can keep this tab open; it will move on by itself. If it does not, return to the app tab for the error.";
  } catch {
    // Closed, cross-origin, or sandboxed: the in-app banner still carries the state.
  }
}

function reclaimFailedStartTab(
  authTab: { close(): void; readonly closed: boolean; location: { href: string } } | null,
  code: string,
) {
  if (!authTab) return;
  try {
    authTab.close();
  } catch {
    // A tab the user already closed throws on close; fall through
    // to the check below.
  }
  let stillOpen = false;
  try {
    stillOpen = !authTab.closed;
  } catch {
    stillOpen = true;
  }
  if (!stillOpen) return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("etrade_connect_error", code);
    authTab.location.href = url.toString();
  } catch {
    // Last resort: the original tab's banner still carries the error.
  }
}

/** Issue #3197: only a catalog-resolving server code rides the reclaimed tab's URL; anything else falls back to the start-failure outcome. */
function outcomeCodeForStartFailure(code: unknown): string {
  if (typeof code === "string" && resolveOutcome(code).entry) return code;
  return "FAILURE_ETRADE_OAUTH_START_FAILED";
}

export function ETradeTradingHub({
  user,
  onSendPrompt,
  activeSubTab,
  onSelectSubTab,
  onBrokerPropsChange, onUnreadAlertsChange,
}: ETradeTradingHubProps) {
  const toast = useToast();
  // Navigation subtabs: synchronized directly with activeSubTab prop from Chat navigation
  const [subTab, setSubTab] = useState<TradingSubTab>(activeSubTab || "autopilot");
  const effectiveSubTab: TradingSubTab = activeSubTab || subTab || "autopilot";
  // Issue #2853 (gap G2): the selected broker decides which broker surface
  // renders. Previously every panel was E*TRADE regardless of selection.
  // Issue #3411: subscribe to useTenantProviders() so broker switches reactively update.
  const [tenantProviders] = useTenantProviders();
  const selectedBroker = tenantProviders.brokerId;
  // Issue #3417: the broker's NAME is the presentation module's, not a local
  // ternary. One lookup renames every surface at once, and an unrecognised id
  // is described as a selection instead of silently becoming "E*TRADE".
  const presentation = brokerPresentation(selectedBroker);
  const brokerLabel = presentation.label;
  // Issue #3356: an unrecognised stored id is refused rather than becoming an
  // E*TRADE read by default - the same fail-closed rule the catalog applies.
  const riskBroker: RiskBroker | null = isBrokerId(selectedBroker) ? selectedBroker : null;
  // S4-D (#1991): the hub is the route outlet for every trading page, so
  // the shell title/scope follow the active subtab via the route table.
  // iv-history is an inner hub tab with no route entry.
  const shellRoute = getRoute(effectiveSubTab);
  const shellTitle = shellRoute?.crumb ?? (effectiveSubTab === "iv-history" ? "IV History" : "");
  const shellScopeNote = shellRoute?.description;

  const handleNavigateSubTab = (newSubTab: TradingSubTab) => {
    setSubTab(newSubTab);
    onSelectSubTab?.(newSubTab);
  };
  // C2: every screening subtab renders the one hub on the
  // equivalent tab — the same props the hub has always received
  // here, with initialTab selecting the asset tab.
  const renderScreenersHub = (tab: ScreenersHubTab) => (
    <ScreenersHub activeEnv={activeEnv} userLogin={user?.login} initialTab={tab} />
  );

  // Issue #2954: the Options copy hub — the options subtabs render it
  // on the equivalent tab, with the same trade/prompt/job props.
  const renderOptionsHub = (tab?: OptionsHubTab) => (
    <OptionsHub
      activeEnv={activeEnv}
      userLogin={user?.login}
      user={user}
      initialTab={tab}
      onPreviewTrade={handleTradeOrder}
      onSendPrompt={onSendPrompt}
      onJobStateChange={setOptionsJob}
    />
  );

  const renderStockHub = (tab: StockHubTab) => (
    <StockHub
      activeEnv={activeEnv}
      userLogin={user?.login}
      user={user}
      onStocksLoaded={setScreenerStocks}
      initialTab={tab}
      onPreviewTrade={handleTradeOrder}
      onSendPrompt={onSendPrompt}
      onJobStateChange={setOptionsJob}
    />
  );

  useEffect(() => {
    if (activeSubTab && activeSubTab !== subTab) {
      setSubTab(activeSubTab);
    }
    const current = activeSubTab || subTab;
    if (current === "portfolio") {
      fetchPositions();
    } else if (current === "ledger") {
      fetchOrders();
    }
  }, [activeSubTab]);

  // Broker status
  const [brokerStatus, setBrokerStatus] = useState<ETradeBrokerStatus | null>(null);
  // Issue #3669: the Alpaca connect read (`configured`/`signedIn`, the
  // same `GET /api/broker/connect/alpaca` the dynamic menu makes). The
  // neutral broker status cannot answer it — it knows deployment keys
  // only, not whether THIS login signed in with its own pair.
  const [alpacaConnectStatus, setAlpacaConnectStatus] = useState<{
    configured?: boolean;
    signedIn?: boolean;
  } | null>(null);
  const [account, setAccount] = useState<ETradeAccount | null>(null);
  const [positions, setPositions] = useState<ETradePosition[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [configModalOpen, setConfigModalOpen] = useState(false);

  const handleSeedDemoPortfolio = () => {
    // #913/#921: demo holdings are fabricated data — they may never be
    // seeded into a live/PROD brokerage view. The render sites are gated
    // on !isLive as well; this guard is the defense in depth.
    if (isLive) return;
    const samplePositions: ETradePosition[] = [
      {
        symbol: "NVDA",
        description: "NVIDIA Corporation - Common Stock",
        quantity: 50,
        pricePaid: 124.50,
        costBasis: 6225.00,
        currentPrice: 138.25,
        marketPrice: 138.25,
        marketValue: 6912.50,
        totalGain: 687.50,
        unrealizedGainLoss: 687.50,
        totalGainPercent: 11.04,
        unrealizedGainLossPercent: 11.04,
        daysGain: 84.50,
        daysGainPercent: 1.24,
        positionType: "LONG",
        securityType: "EQ",
      },
      {
        symbol: "AAPL",
        description: "Apple Inc. - Common Stock",
        quantity: 40,
        pricePaid: 215.00,
        costBasis: 8600.00,
        currentPrice: 231.40,
        marketPrice: 231.40,
        marketValue: 9256.00,
        totalGain: 656.00,
        unrealizedGainLoss: 656.00,
        totalGainPercent: 7.63,
        unrealizedGainLossPercent: 7.63,
        daysGain: -22.80,
        daysGainPercent: -0.25,
        positionType: "LONG",
        securityType: "EQ",
      },
      {
        symbol: "MSFT",
        description: "Microsoft Corporation - Common Stock",
        quantity: 25,
        pricePaid: 410.00,
        costBasis: 10250.00,
        currentPrice: 428.15,
        marketPrice: 428.15,
        marketValue: 10703.75,
        totalGain: 453.75,
        unrealizedGainLoss: 453.75,
        totalGainPercent: 4.43,
        unrealizedGainLossPercent: 4.43,
        daysGain: 41.25,
        daysGainPercent: 0.39,
        positionType: "LONG",
        securityType: "EQ",
      },
      {
        symbol: "SPY",
        description: "SPDR S&P 500 ETF Trust",
        quantity: 30,
        pricePaid: 560.00,
        costBasis: 16800.00,
        currentPrice: 582.60,
        marketPrice: 582.60,
        marketValue: 17478.00,
        totalGain: 678.00,
        unrealizedGainLoss: 678.00,
        totalGainPercent: 4.04,
        unrealizedGainLossPercent: 4.04,
        daysGain: 52.20,
        daysGainPercent: 0.30,
        positionType: "LONG",
        securityType: "EQ",
      },
    ];

    setPositions(samplePositions);
    setAccount({
      accountId: "paper_sandbox_demo",
      accountKey: "paper_sandbox_key",
      accountDesc: "Paper Trading Portfolio Sandbox",
      accountType: "MARGIN",
      netAccountValue: 69350.25,
      totalAccountValue: 69350.25,
      cashAvailableForInvestment: 25000.00,
      dayTraderStatus: false,
    });
  };

  // Screener state
  const [exchangeFilter, setExchangeFilter] = useState<"ALL" | "NASDAQ" | "NYSE" | "AMEX">("ALL");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [stockResultLimit, setStockResultLimit] = useState("");
  const [marketCapPreset, setMarketCapPreset] = useState<string>("all");
  const [perfFilter, setPerfFilter] = useState<"all" | "gainers" | "losers">("all");
  const [screenerSearch, setScreenerSearch] = useState("");
  const [screenerStocks, setScreenerStocks] = useState<ScreenedStockItem[]>([]);
  const [screenerLoading, setScreenerLoading] = useState(false);
  const [scannedAt, setScannedAt] = useState<string>("");

  // Order Ticket state
  const [orderSymbol, setOrderSymbol] = useState("");
  const [orderAction, setOrderAction] = useState<"BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT">("LIMIT");
  const [orderQuantity, setOrderQuantity] = useState(10);
  const [orderLimitPrice, setOrderLimitPrice] = useState<string>("125.50");
  const [orderQuote, setOrderQuote] = useState<ETradeQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [activeDraft, setActiveDraft] = useState<ETradeOrderDraft | null>(null);
  const [executingDraft, setExecutingDraft] = useState(false);
  const [lastExecutionResult, setLastExecutionResult] = useState<ETradeOrderExecutionResult | null>(null);
  const [riskSubject, setRiskSubject] = useState<RiskSubject | null>(null);
  const [orderError, setOrderError] = useState("");
  const [orderContext, setOrderContext] = useState<TradeOrderContext | null>(null);
  const [orderAssetClass, setOrderAssetClass] = useState<TradeAssetClass>("equity");
  const [optionsJob, setOptionsJob] = useState<"idle" | "running" | "ready">("idle");

  // Orders Ledger state
  const [orders, setOrders] = useState<TradeRecord[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);

  // Quote Inspection Modal state
  const [inspectSymbol, setInspectSymbol] = useState<string | null>(null);
  const [inspectQuote, setInspectQuote] = useState<ETradeQuote | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);

  // In-tab NLQ state
  const [nlqQuery, setNlqQuery] = useState("");

  // DID Copy feedback
  const [copiedDid, setCopiedDid] = useState(false);

  // Trust, Reconciliation & Privacy state
  const [maskAccount, setMaskAccount] = useState(true);
  const [scanUniverseCount, setScanUniverseCount] = useState(0);
  const [scanStatus, setScanStatus] = useState<"not_run" | "no_universe" | "data_unavailable" | "scan_failed" | "no_matches" | "matches_found">("not_run");
  const [scanMessage, setScanMessage] = useState("");

  // E*TRADE Live Diagnostics state
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [showDiagnosticsModal, setShowDiagnosticsModal] = useState(false);
  const [showAlpacaSignInModal, setShowAlpacaSignInModal] = useState(false);

  // E*TRADE 3-Legged OAuth 1.0a state
  const [oauthStatus, setOauthStatus] = useState<{
    authenticated: boolean;
    environment?: string;
    storedAt?: string;
    renewable?: boolean;
    expired?: boolean;
  } | null>(null);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const [oauthPin, setOauthPin] = useState("");
  const [requestTokenInfo, setRequestTokenInfo] = useState<{ requestToken: string; authorizeUrl: string } | null>(null);
  const [oauthSubmitting, setOauthSubmitting] = useState(false);
  const [oauthMsg, setOauthMsg] = useState("");
  // #1159: fallback authorize URL when the popup itself is blocked.
  const [blockedAuthUrl, setBlockedAuthUrl] = useState<string | null>(null);

  // Omnichannel Email & Slack Simulator states
  const [emailFrom, setEmailFrom] = useState("trader@example.com");
  const [emailSubject, setEmailSubject] = useState(`${presentation.label} market update`);
  const [emailBody, setEmailBody] = useState("What is the current market price and technical signal?");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailResult, setEmailResult] = useState<any>(null);

  const [slackPrompt, setSlackPrompt] = useState(`@${presentation.botName} preview buy <quantity> <symbol> limit <price>`);
  const [slackLoading, setSlackLoading] = useState(false);
  const [slackResult, setSlackResult] = useState<any>(null);
  const [slackActionLoading, setSlackActionLoading] = useState(false);

  const handleSimulateEmail = async () => {
    setEmailLoading(true);
    setEmailResult(null);
    try {
      const resp = await fetch("/api/trading/email/inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({
          from: emailFrom,
          to: "trade@agent.openaimp.com",
          subject: emailSubject,
          text: emailBody,
        }),
      });
      const data = (await resp.json()) as any;
      setEmailResult(data);
      if (data.actionType === "preview" || data.actionType === "approval") {
        fetchOrders();
      }
    } catch (err: any) {
      setEmailResult({ success: false, responseSubject: "Error", responseText: err.message, responseHtml: `<p style="color:red">${err.message}</p>` });
    } finally {
      setEmailLoading(false);
    }
  };

  const handleSimulateSlack = async (customPrompt?: string) => {
    const textToRun = customPrompt || slackPrompt;
    setSlackLoading(true);
    setSlackResult(null);
    try {
      const resp = await fetch("/api/trading/slack/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({
          type: "event_callback",
          event: {
            type: "app_mention",
            text: textToRun,
            channel: "C_TRADING_FLOOR",
            user: "U_TRADER_DEV",
            ts: `${Date.now() / 1000}`,
          },
        }),
      });
      const data = (await resp.json()) as any;
      setSlackResult(data);
      if (data.actionType === "preview") {
        fetchOrders();
      }
    } catch (err: any) {
      setSlackResult({ handled: false, error: err.message });
    } finally {
      setSlackLoading(false);
    }
  };

  const handleSlackActionButton = async (actionId: string, orderId: string) => {
    setSlackActionLoading(true);
    try {
      const resp = await fetch("/slack/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "x-environment": activeEnv },
        body: new URLSearchParams({
          payload: JSON.stringify({
            type: "block_actions",
            user: { id: "U_TRADER_DEV", username: "trader_openaimp" },
            actions: [{ action_id: actionId, value: orderId }],
          }),
        }),
      });
      const data = await resp.json() as any;
      if (slackResult?.response) {
        setSlackResult({
          ...slackResult,
          response: {
            ...slackResult.response,
            blocks: data.replacementBlocks || slackResult.response.blocks,
          },
        });
      }
      fetchOrders();
      fetchPositions();
    } catch (err: any) {
      console.warn("Slack button action failed:", err);
    } finally {
      setSlackActionLoading(false);
    }
  };

  // Voice Trading Desk state
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const [voiceTranscript, setVoiceTranscript] = useState<Array<{
    role: "user" | "assistant";
    text: string;
    actionType?: string;
    orderId?: string;
    orderDraft?: any;
    brokerOrderRef?: string;
    marketQuote?: any;
    screenedStocks?: any[];
    timestamp: string;
  }>>([
    {
      role: "assistant",
      text: `Welcome to the ${presentation.deskName}. You can ask for real-time market quotes, technical screening, portfolio status, or draft order tickets. How can I assist your portfolio today?`,
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);
  const [voiceInterim, setVoiceInterim] = useState<string | null>(null);
  const [voiceInputText, setVoiceInputText] = useState("");
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [voiceIsMuted, setVoiceIsMuted] = useState(false);
  const [speechRecognitionActive, setSpeechRecognitionActive] = useState(false);

  const speakText = (text: string) => {
    if (typeof window !== "undefined" && "speechSynthesis" in window && !voiceIsMuted) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      utterance.onstart = () => setVoiceStatus("speaking");
      utterance.onend = () => setVoiceStatus("idle");
      utterance.onerror = () => setVoiceStatus("idle");
      window.speechSynthesis.speak(utterance);
    }
  };

  const handleVoiceTurn = async (textToSubmit?: string) => {
    const prompt = (textToSubmit || voiceInputText).trim();
    if (!prompt) return;

    setVoiceLoading(true);
    setVoiceStatus("thinking");
    setVoiceInputText("");
    setVoiceInterim(null);

    const userMessageTime = new Date().toLocaleTimeString();
    setVoiceTranscript((prev) => [
      ...prev,
      { role: "user", text: prompt, timestamp: userMessageTime },
    ]);

    try {
      const resp = await fetch("/api/trading/voice/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({ transcript: prompt }),
      });
      const data = (await resp.json()) as any;

      const assistantMsg = {
        role: "assistant" as const,
        text: data.spokenText || data.displayMarkdown || "Request processed.",
        actionType: data.actionType,
        orderId: data.orderId,
        orderDraft: data.orderDraft,
        brokerOrderRef: data.brokerOrderRef,
        marketQuote: data.marketQuote,
        screenedStocks: data.screenedStocks,
        timestamp: new Date().toLocaleTimeString(),
      };

      setVoiceTranscript((prev) => [...prev, assistantMsg]);
      setVoiceStatus("speaking");
      speakText(data.spokenText || "");

      if (data.actionType === "preview" || data.actionType === "approval") {
        fetchOrders();
        fetchPositions();
      }
    } catch (err: any) {
      setVoiceTranscript((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Voice Agent Error: ${err.message || "Could not process voice turn."}`,
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
      setVoiceStatus("idle");
    } finally {
      setVoiceLoading(false);
    }
  };

  const handleToggleVoiceRecording = () => {
    if (typeof window === "undefined") return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      toast.warning("Web Speech API is not supported in this browser. You can type in the prompt box or use the quick chips.");
      return;
    }

    if (speechRecognitionActive) {
      setSpeechRecognitionActive(false);
      setVoiceStatus("idle");
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onstart = () => {
        setSpeechRecognitionActive(true);
        setVoiceStatus("listening");
      };

      recognition.onresult = (event: any) => {
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            final += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        if (interim) setVoiceInterim(interim);
        if (final) {
          setVoiceInterim(null);
          setSpeechRecognitionActive(false);
          handleVoiceTurn(final);
        }
      };

      recognition.onerror = () => {
        setSpeechRecognitionActive(false);
        setVoiceStatus("idle");
      };

      recognition.onend = () => {
        setSpeechRecognitionActive(false);
      };

      recognition.start();
    } catch (e) {
      console.warn("Speech recognition error:", e);
      setSpeechRecognitionActive(false);
      setVoiceStatus("idle");
    }
  };

  const handleVoiceOrderAction = async (action: "approve" | "cancel", orderId: string) => {
    const textPrompt = action === "approve" ? `Confirm order ${orderId}` : `Cancel order ${orderId}`;
    await handleVoiceTurn(textPrompt);
  };

  // Active environment (Sandbox TEST vs Live PROD) — Issue #2482: the
  // single client value, mirroring the server-persisted selection.
  // It is the prop root for every hub-embedded surface; no component
  // reads a localStorage environment key anymore.
  const activeEnv = useBrokerEnvironment();

  // Issue #2482: true while this hub's own switch is in flight, so the
  // etrade-env-changed listener below skips the event its own switch
  // broadcast and does not re-POST or double-refetch.
  const switchingRef = useRef(false);

  const handleSwitchEnvironment = async (target: "TEST" | "PROD") => {
    // Writes through to the server source of truth; adopt the echoed
    // value so the UI never displays a switch the server did not store.
    switchingRef.current = true;
    try {
      const adopted = await switchBrokerEnvironment(target);
      setActiveDraft(null);
      setLastExecutionResult(null);
      setOauthMsg(`Switched to ${adopted === "PROD" ? "Production (Live)" : "Sandbox (TEST)"} mode.`);
      await Promise.all([
        // Issue #3669: E*TRADE OAuth status is E*TRADE's — refetch it
        // only for an E*TRADE tenant.
        ...(selectedBroker === "etrade" ? [fetchOAuthStatus(adopted)] : []),
        fetchBrokerStatus(adopted),
        fetchPositions(adopted),
      ]);
      fetchSymbolQuote(orderSymbol, adopted);
    } finally {
      switchingRef.current = false;
    }
  };

  // Issue #2482: load the server-persisted selection at boot. The
  // [activeEnv] effect below then fetches with the selection.
  useEffect(() => {
    void fetchBrokerEnvironment();
  }, []);

  // Fetch initial broker status, OAuth status, positions, and screener
  useEffect(() => {
    // Issue #3669: E*TRADE OAuth status is E*TRADE's — it is fetched only
    // for an E*TRADE tenant. An Alpaca tenant never completes E*TRADE
    // OAuth, so the call could only ever return "unauthenticated", which
    // the order page used to render as a permanent E*TRADE prompt.
    if (selectedBroker === "etrade") fetchOAuthStatus(activeEnv);
    fetchBrokerStatus(activeEnv);
    fetchPositions(activeEnv);
    fetchOrders();
    fetchSymbolQuote(orderSymbol);

    // Check if redirected back from E*TRADE OAuth
    const params = new URLSearchParams(window.location.search);
    if (selectedBroker === "etrade" && params.get("etrade_auth") === "success") {
      setOauthMsg("E*TRADE OAuth 1.0a connection established! Real broker access enabled.");
      fetchOAuthStatus(activeEnv);
      fetchBrokerStatus(activeEnv);
      fetchPositions(activeEnv);
    }
    // Issue #3197: a start failure reclaims the pre-opened tab by
    // navigating it here with an outcome code. Resolve the code
    // against the catalog (never render URL-supplied text), show
    // the business message, and strip the param so a refresh does
    // not re-show it.
    const connectError = params.get("etrade_connect_error");
    if (connectError && resolveOutcome(connectError).entry) {
      setOauthMsg(codedMessage(connectError));
      params.delete("etrade_connect_error");
      const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", next);
    }
  }, [activeEnv]);

  // Issue #3669: the order page's Alpaca connection signal. Same read the
  // dynamic menu makes, same definition of connected (`configured` OR
  // `signedIn`): a usable pair exists for this trading type, whether it
  // is the deployment's or the user's own. No connect read exists for
  // any other non-E*TRADE broker yet, so the endpoint helper returns
  // null and nothing is fetched for them.
  useEffect(() => {
    if (selectedBroker !== "alpaca") {
      setAlpacaConnectStatus(null);
      return;
    }
    const endpoint = connectStatusEndpoint(selectedBroker);
    if (!endpoint) return;
    let cancelled = false;
    const url = `${endpoint}?environment=${encodeURIComponent(activeEnv)}`;
    fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data === "object") {
          const body = data as Record<string, unknown>;
          setAlpacaConnectStatus({
            configured: Boolean(body.configured),
            signedIn: Boolean(body.signedIn),
          });
        }
      })
      .catch(() => {
        if (!cancelled) setAlpacaConnectStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBroker, activeEnv]);

  // Listen for open-etapi-tuning and etrade-env-changed events from SettingsMenu
  useEffect(() => {
    const handleOpenTuning = () => setConfigModalOpen(true);
    const handleEnvChange = (e: any) => {
      // Issue #2482: the hub's own switch already refetched above; this
      // listener serves menu-initiated switches only (same value, so
      // the module needs no second POST — reset drafts and refetch).
      if (switchingRef.current) return;
      const target = e.detail?.env;
      if (target === "TEST" || target === "PROD") {
        setActiveDraft(null);
        setLastExecutionResult(null);
        void Promise.all([
          // Issue #3669: E*TRADE OAuth status is E*TRADE's (see mount effect).
          ...(selectedBroker === "etrade" ? [fetchOAuthStatus(target)] : []),
          fetchBrokerStatus(target),
          fetchPositions(target),
        ]);
        fetchSymbolQuote(orderSymbol, target);
      }
    };
    window.addEventListener("open-etapi-tuning", handleOpenTuning);
    window.addEventListener("etrade-env-changed", handleEnvChange);
    return () => {
      window.removeEventListener("open-etapi-tuning", handleOpenTuning);
      window.removeEventListener("etrade-env-changed", handleEnvChange);
    };
  }, [activeEnv]);

  const fetchOAuthStatus = async (override?: string) => {
    const envToUse = override || activeEnv;
    setOauthLoading(true);
    try {
      const resp = await fetch("/api/etrade/oauth/status", {
        headers: { "x-environment": envToUse },
      });
      if (resp.ok) {
        const data = (await resp.json()) as any;
        setOauthStatus(data);
      }
    } catch {
      // Ignore
    } finally {
      setOauthLoading(false);
    }
  };

  const handleStartOAuth = async (override?: unknown) => {
    const envToUse = typeof override === "string" && (override === "TEST" || override === "PROD") ? override : activeEnv;
    setOauthLoading(true);
    setOauthMsg("");
    setBlockedAuthUrl(null);
    // Open the tab synchronously, while this is still the user's gesture:
    // a window.open issued after the await below is blocked by browsers
    // as a popup (#1159). #3197: the features string must NOT request
    // noopener/noreferrer — the HTML spec makes window.open return null
    // in that case, so this tab could never be navigated (always
    // about:blank) and the failure reclaim was dead code. Severing the
    // opener reference ourselves keeps the handle we need.
    const authTab =
      typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    if (authTab) {
      try {
        authTab.opener = null;
      } catch {
        // Already closed or not same-origin: nothing to sever.
      }
      showConnectingPlaceholder(authTab);
    }
    // Issue #3197: the start fetch must not hang forever — a hung
    // fetch used to leave the pre-opened tab blank with no branch
    // ever running. The timeout forces the failure branch, which
    // reclaims the tab instead of stranding it.
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId = controller
      ? window.setTimeout(() => controller.abort(), 30000)
      : undefined;
    try {
      const resp = await fetch("/api/etrade/oauth/start", {
        headers: { "x-environment": envToUse },
        signal: controller?.signal,
      });
      const data = (await resp.json()) as any;
      if (resp.ok && data.authorizeUrl) {
        setRequestTokenInfo(data);
        setShowPinModal(true);
        if (authTab) {
          authTab.location.href = data.authorizeUrl;
        } else {
          setBlockedAuthUrl(data.authorizeUrl);
        }
      } else {
        // Issue #3197: never strand the pre-opened tab on failure.
        // The server's outcome code (when it resolves in the
        // catalog) rides the reclaimed tab's URL so the error is
        // visible where the user is looking, not only on the
        // original tab's banner.
        reclaimFailedStartTab(authTab, outcomeCodeForStartFailure(data?.code));
        setOauthMsg(data.error || codedMessage("FAILURE_ETRADE_OAUTH_START_FAILED"));
      }
    } catch (err: any) {
      reclaimFailedStartTab(authTab, "FAILURE_ETRADE_OAUTH_START_FAILED");
      setOauthMsg(codedMessage("FAILURE_ETRADE_OAUTH_START_FAILED"));
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      setOauthLoading(false);
    }
  };

  const handleSwitchAndConnect = async (target: "TEST" | "PROD") => {
    await handleSwitchEnvironment(target);
    await handleStartOAuth(target);
  };

  const handleSubmitPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oauthPin.trim()) return;
    setOauthSubmitting(true);
    setOauthMsg("");
    try {
      const resp = await fetch("/api/etrade/oauth/verifier", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({
          verifier: oauthPin.trim(),
          requestToken: requestTokenInfo?.requestToken,
          requestTokenSecret: (requestTokenInfo as any)?.requestTokenSecret,
        }),
      });
      const data = (await resp.json()) as any;
      if (resp.ok && data.success) {
        setShowPinModal(false);
        setOauthPin("");
        await fetchOAuthStatus(activeEnv);
        await fetchBrokerStatus(activeEnv);
        await fetchPositions(activeEnv);
        await fetchSymbolQuote(orderSymbol);
        setOauthMsg("E*TRADE Account Connected! Access token active until midnight Eastern Time.");
      } else {
        setOauthMsg(data.error || "Failed to exchange verification code with E*TRADE");
      }
    } catch (err: any) {
      setOauthMsg(err.message || "Failed to submit verification code");
    } finally {
      setOauthSubmitting(false);
    }
  };

  const handleRenewOAuth = async () => {
    setOauthLoading(true);
    setOauthMsg("");
    try {
      const resp = await fetch("/api/etrade/oauth/renew", {
        method: "POST",
        headers: { "x-environment": activeEnv },
      });
      const data = (await resp.json()) as any;
      if (resp.ok && data.success) {
        await fetchOAuthStatus(activeEnv);
        setOauthMsg("Token renewed successfully for today!");
      } else {
        setOauthMsg(data.error || "Failed to renew token. Please re-authenticate.");
      }
    } catch (err: any) {
      setOauthMsg(err.message || "Failed to renew token");
    } finally {
      setOauthLoading(false);
    }
  };

  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);

  const handleRevokeOAuth = async () => {
    setDisconnectConfirmOpen(true);
  };

  const doRevokeOAuth = async () => {
    setOauthLoading(true);
    try {
      // Issue #2386: the panel flips to disconnected ONLY on a
      // confirmed revoke. A failed revoke leaves the panel exactly
      // as the server reports it — no optimistic flip, no blind
      // refetch snap-back.
      const resp = await fetch("/api/etrade/oauth/revoke", {
        method: "POST",
        headers: { "x-environment": activeEnv },
      });
      const data = (await resp.json().catch(() => ({}))) as any;
      if (!resp.ok || data.success !== true) {
        setOauthMsg(data.error || data.message || "Failed to disconnect E*TRADE account. Your connection is unchanged.");
        return;
      }
      setOauthStatus({
        authenticated: false,
        environment: activeEnv,
        storedAt: undefined,
        renewable: false,
      });
      setBrokerStatus((prev) => (prev ? { ...prev, oauthAuthenticated: false } : prev));
      setAccount(null);
      setPositions([]);
      setOauthMsg("E*TRADE account disconnected.");
      await fetchOAuthStatus(activeEnv);
      await fetchBrokerStatus(activeEnv);
    } catch {
      setOauthMsg("Failed to disconnect E*TRADE account. Your connection is unchanged.");
    } finally {
      setOauthLoading(false);
    }
  };

  const fetchBrokerStatus = async (override?: string) => {
    const envToUse = override || activeEnv;
    try {
      // Issue #3294: the hub read follows the selection.
      const resp = await fetch(statusEndpoint(), {
        headers: { "x-environment": envToUse },
      });
      if (resp.ok) {
        const data = (await resp.json()) as any;
        setBrokerStatus(data.status || data);
        const acct = portfolioFromPayload(data).account;
        if (acct) setAccount(acct);
        // Issue #2386: oauth/status is the SOLE writer of
        // oauthStatus. This broker read used to overwrite it from
        // its own oauthAuthenticated flag, so the two reads raced
        // (and, before the identity-aware seam, could disagree);
        // the broker flag still lands in brokerStatus for display.
      }
    } catch {
      // Ignore
    }
  };

  const fetchPositions = async (override?: string) => {
    const envToUse = override || activeEnv;
    setPositionsLoading(true);
    try {
      const resp = await fetch(positionsEndpoint(), {
        headers: { "x-environment": envToUse },
      });
      if (resp.ok) {
        const body = (await resp.json()) as unknown;
        const read = portfolioFromPayload(body);
        let acct = read.account;
        // A payload without a positions array did not answer the question, so it
        // must not clear the table; an empty array is a real "you hold nothing".
        if (read.reported) setPositions(read.positions);
        if (!acct) {
          // The neutral positions route nests the platform result, and a broker
          // that omits the account leaves the hero at zero. The accounts read is
          // the fallback; a failure keeps the account unknown rather than zero.
          try {
            const acctResp = await fetch(accountsEndpoint(), {
              headers: { "x-environment": envToUse },
            });
            if (acctResp.ok) {
              const accounts = accountsFromPayload(await acctResp.json());
              if (accounts.length > 0) acct = accounts[0];
            }
          } catch {
            // Ignore
          }
        }
        if (acct) setAccount(acct);
        const errorText = (body as { error?: unknown })?.error;
        if (typeof errorText === "string" && errorText && (!acct || acct.accountId === "unconnected")) {
          setOauthMsg(errorText);
        }
      }
    } catch {
      // Ignore
    } finally {
      setPositionsLoading(false);
    }
  };

  const runDiagnostics = async (brokerIdOverride?: string, override?: string) => {
    const brokerToUse = brokerIdOverride || selectedBroker || "etrade";
    const envToUse = override || activeEnv;
    setDiagnosticsLoading(true);
    try {
      if (brokerToUse === "alpaca") {
        const startedAt = Date.now();
        const [connectResp, accountResp] = await Promise.allSettled([
          fetch(`/api/broker/connect/alpaca?environment=${encodeURIComponent(envToUse)}`),
          fetch(`/api/market-data/alpaca/account`, { headers: { "x-environment": envToUse } }),
        ]);
        const latency = Date.now() - startedAt;
        const connectData = connectResp.status === "fulfilled" && connectResp.value.ok ? await connectResp.value.json().catch(() => ({})) : {};
        const accountData = accountResp.status === "fulfilled" && accountResp.value.ok ? ((await accountResp.value.json().catch(() => ({}))) as Record<string, any>) : null;
        const isConfigured = Boolean((connectData as any)?.configured || (connectData as any)?.signedIn);
        setDiagnostics({
          broker: "alpaca",
          environment: envToUse,
          status: isConfigured ? "healthy" : "not_configured",
          apiUrl: envToUse === "PROD" ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets",
          ping: `${latency}ms`,
          roundTripMs: latency,
          authenticated: isConfigured,
          credentials: {
            apiKeyConfigured: isConfigured,
            apiSecretConfigured: isConfigured,
          },
          oauthToken: {
            present: isConfigured,
          },
          upstreamAccounts: {
            count: accountData ? 1 : 0,
            accounts: accountData ? [{
              accountId: accountData.account_number || accountData.id || "Alpaca-Account",
              accountKey: accountData.status || "ACTIVE",
              accountType: `${envToUse === "PROD" ? "Live" : "Paper"} (${accountData.currency || "USD"})`,
              cash: accountData.cash,
              buyingPower: accountData.buying_power,
            }] : [],
          },
          lastError: !isConfigured ? "Alpaca API keys not yet configured or connected for this mode." : undefined,
        });
        setShowDiagnosticsModal(true);
        void Promise.allSettled([
          fetchBrokerStatus(envToUse),
          fetchPositions(envToUse),
        ]);
        return;
      }
      const diagnosticsUrl = diagnosticsEndpoint(brokerToUse);
      if (!diagnosticsUrl) {
        setDiagnostics({
          broker: brokerToUse,
          unavailable: true,
          message: `Broker diagnostics are not available for the selected broker (${brokerPresentation(brokerToUse).label}).`,
        });
        setShowDiagnosticsModal(true);
        return;
      }
      const resp = await fetch(diagnosticsUrl, {
        headers: { "x-environment": envToUse },
      });
      const data = (await resp.json()) as any;
      setDiagnostics({
        broker: brokerToUse,
        ...data,
      });
      setShowDiagnosticsModal(true);
      // Unconditionally sync broker status, positions, and OAuth state on diagnostics run
      void Promise.allSettled([
        fetchBrokerStatus(envToUse),
        fetchPositions(envToUse),
        fetchOAuthStatus(envToUse),
      ]);
    } catch (err: any) {
      setDiagnostics({ broker: brokerToUse, error: err.message || "Failed to run diagnostics" });
      setShowDiagnosticsModal(true);
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  useEffect(() => {
    const handleOpenDiag = () => {
      runDiagnostics();
    };
    const handleSync = () => {
      runDiagnostics();
    };
    const handleStartOAuthEvt = () => {
      handleStartOAuth();
    };
    const handleRenewOAuthEvt = () => {
      handleRenewOAuth();
    };
    const handleRevokeOAuthEvt = () => {
      handleRevokeOAuth();
    };

    if (typeof window !== "undefined") {
      window.addEventListener("open-etrade-diagnostics", handleOpenDiag);
      window.addEventListener("sync-etrade-api", handleSync);
      window.addEventListener("start-etrade-oauth", handleStartOAuthEvt);
      window.addEventListener("renew-etrade-oauth", handleRenewOAuthEvt);
      window.addEventListener("revoke-etrade-oauth", handleRevokeOAuthEvt);
      return () => {
        window.removeEventListener("open-etrade-diagnostics", handleOpenDiag);
        window.removeEventListener("sync-etrade-api", handleSync);
        window.removeEventListener("start-etrade-oauth", handleStartOAuthEvt);
        window.removeEventListener("renew-etrade-oauth", handleRenewOAuthEvt);
        window.removeEventListener("revoke-etrade-oauth", handleRevokeOAuthEvt);
      };
    }
  }, [activeEnv]);

  const fetchOrders = async () => {
    setOrdersLoading(true);
    try {
      const resp = await fetch("/api/broker/orders");
      if (resp.ok) {
        const data = await resp.json() as { total: number; orders: TradeRecord[]; trades?: TradeRecord[] };
        // Issue #3089: the broker route lists stored drafts as `trades`
        // (the legacy route's shape); the old `orders` shape is kept as
        // a fallback so either listing populates the table.
        const rows = data.trades ?? data.orders;
        if (rows) setOrders(rows);
      }
    } catch {
      // Ignore
    } finally {
      setOrdersLoading(false);
    }
  };

  const runScreener = async (envOverride?: unknown) => {
    const envToUse = typeof envOverride === "string" ? envOverride : activeEnv;
    setScreenerLoading(true);
    setScanMessage("");
    try {
      const body: Record<string, any> = {};
      if (stockResultLimit.trim()) body.limit = Number(stockResultLimit);
      body.exchange = exchangeFilter;
      if (minPrice.trim()) body.minPrice = Number(minPrice);
      if (maxPrice.trim()) body.maxPrice = Number(maxPrice);
      if (marketCapPreset === "mega") body.minMarketCap = 200;
      if (marketCapPreset === "large") body.minMarketCap = 50;
      if (perfFilter === "gainers") body.gainersOnly = true;
      if (perfFilter === "losers") body.losersOnly = true;
      if (screenerSearch.trim()) body.search = screenerSearch.trim();

      // Issue #3272: the selected broker decides which stock screen serves.
      const resp = await fetch(stockScreenEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": envToUse },
        body: JSON.stringify(body),
      });

      if (resp.ok) {
        const data = (await resp.json()) as any;
        const list = Array.isArray(data.stocks) ? data.stocks : Array.isArray(data.results) ? data.results : [];
        setScreenerStocks(list);
        const total = typeof data.totalScreened === "number" ? data.totalScreened : list.length;
        const candidateCount = typeof data.discovery?.candidateCount === "number" ? data.discovery.candidateCount : total;
        const listingCount = typeof data.discovery?.listingCount === "number" ? data.discovery.listingCount : total;
        setScanUniverseCount(candidateCount);
        setScanMessage(data.validationError || data.discovery?.message || "");
        if (data.validationError) {
          setScanStatus("data_unavailable");
        } else if (candidateCount === 0) {
          setScanStatus("no_universe");
        } else if (listingCount === 0) {
          setScanStatus("data_unavailable");
        } else if (list.length === 0) {
          setScanStatus("no_matches");
        } else {
          setScanStatus("matches_found");
        }
        setScannedAt(data.scannedAt || new Date().toLocaleTimeString());
      } else {
        const data = await resp.json().catch(() => ({})) as any;
        // Issue #3239: a 402 (and any screen error) surfaces as an
        // outcome-encoded message with remediation, never the raw
        // server code. Full paid-path wiring for this hub is a
        // named follow-up in the #3239 PR body.
        setScanMessage(mapScreenError(resp.status, data.error));
        setScanStatus("scan_failed");
      }
    } catch (error) {
      setScanMessage(error instanceof Error ? error.message : `Unable to reach the ${presentation.label} screening API.`);
      setScanStatus("scan_failed");
    } finally {
      setScreenerLoading(false);
    }
  };

  const fetchSymbolQuote = async (sym: string, envOverride?: unknown) => {
    if (!sym) return;
    const envToUse = typeof envOverride === "string" ? envOverride : activeEnv;
    setQuoteLoading(true);
    try {
      const resp = await fetch(`${quoteEndpoint()}?symbol=${encodeURIComponent(sym)}`, {
        headers: { "x-environment": envToUse },
      });
      if (resp.ok) {
        const data = (await resp.json()) as ETradeQuote;
        if (data && data.symbol === sym) {
          setOrderQuote(data);
          if (orderType === "LIMIT") {
            // Align limit price with order direction: Buy -> Ask; Sell -> Bid
            if ((orderAction === "BUY" || orderAction === "BUY_TO_COVER") && data.ask > 0) {
              setOrderLimitPrice(data.ask.toFixed(2));
            } else if ((orderAction === "SELL" || orderAction === "SELL_SHORT") && data.bid > 0) {
              setOrderLimitPrice(data.bid.toFixed(2));
            } else if (data.lastPrice > 0) {
              setOrderLimitPrice(data.lastPrice.toFixed(2));
            }
          }
        }
      }
    } catch {
      // Ignore
    } finally {
      setQuoteLoading(false);
    }
  };

  const handleOpenInspectQuote = async (sym: string, existingStock?: ScreenedStockItem) => {
    setInspectSymbol(sym);
    setInspectLoading(true);
    const initialStock = existingStock || screenerStocks.find((s) => s.symbol === sym);
    if (initialStock) {
      setInspectQuote(initialStock as any);
    } else {
      setInspectQuote(null);
    }
    try {
      const resp = await fetch(`${quoteEndpoint()}?symbol=${encodeURIComponent(sym)}`, {
        headers: { "x-environment": activeEnv },
      });
      if (resp.ok) {
        const data = (await resp.json()) as ETradeQuote;
        if (data && data.symbol === sym) {
          setInspectQuote(data);
        }
      }
    } catch {
      // Ignore
    } finally {
      setInspectLoading(false);
    }
  };

  const handleTradeOrder = (ctx: TradeOrderContext) => {
    const seededOptionLegs = ctx.assetClass === "options" && !ctx.optionLegs?.length
      ? [{ securityType: "OPTN" as const, side: ctx.action === "SELL" || ctx.action === "SELL_SHORT" ? "SELL" as const : "BUY" as const, quantity: 1, optionType: "CALL" as const }]
      : ctx.optionLegs;
    const preparedContext: TradeOrderContext = {
      ...ctx,
      optionLegs: seededOptionLegs,
      strategyNetDebit: ctx.strategyNetDebit ?? (ctx.assetClass === "options" ? (ctx.action === "SELL" || ctx.action === "SELL_SHORT" ? -1 : 1) : undefined),
    };
    setOrderContext(preparedContext);
    setOrderAssetClass(ctx.assetClass);
    setOrderSymbol(preparedContext.symbol);
    // Multi-leg order direction is defined by each leg. Keep the ticket's
    // generic header action neutral for option strategies; never label a long
    // put structure as a stock short order.
    setOrderAction(preparedContext.assetClass === "options" ? "BUY" : preparedContext.action);
    setOrderType(preparedContext.assetClass === "options" || preparedContext.optionLegs?.length || preparedContext.underlyingPrice ? "LIMIT" : "MARKET");
    setOrderQuantity(preparedContext.quantity);
    if (preparedContext.assetClass === "options" && preparedContext.strategyNetDebit !== undefined) {
      const unitMultiplier = preparedContext.optionLegs?.some((leg) => leg.securityType === "OPTN")
        ? 100
        : preparedContext.optionLegs?.reduce((total, leg) => total + leg.quantity, 0) || 1;
      setOrderLimitPrice((Math.abs(preparedContext.strategyNetDebit) / unitMultiplier).toFixed(2));
    } else if (preparedContext.assetClass === "options") setOrderLimitPrice("0.01");
    else if (preparedContext.underlyingPrice) setOrderLimitPrice(preparedContext.underlyingPrice.toFixed(2));
    setActiveDraft(null);
    setLastExecutionResult(null);
    setOrderError("");
    setSubTab("order");
    onSelectSubTab?.("order");
  };

  // Issue #3088: the order page's tab switch seeds a manual options
  // ticket through the same no-legs path as the #3038 sub-menu (one
  // blank BUY CALL leg, editable underlying, symbol preserved).
  const seedManualOptions = (symbol: string) => {
    handleTradeOrder({
      assetClass: "options",
      symbol,
      action: "BUY",
      quantity: 1,
      label: "Options Order Ticket",
      legs: [],
    });
  };

  // Issue #3038: the Options order sub-menu lands on
  // ?tab=order&assetClass=options. Seed a manual options ticket
  // through the existing no-legs path (one blank BUY CALL leg),
  // then consume the param (replaceState, no event) so it acts as
  // a one-shot trigger: every sub-menu click opens a fresh manual
  // ticket, while the parent Fast Order Ticket entry (no param)
  // never touches the ticket — a strategy or in-progress ticket
  // survives it, and the param cannot linger into later tab
  // navigations. Seeding changes no tab, so it cannot loop.
  useEffect(() => {
    const seedManualOptionsOrder = () => {
      if (typeof window === "undefined") return;
      if (parseTabFromSearch(window.location.search) !== "order") return;
      if (new URLSearchParams(window.location.search).get("assetClass") !== "options") return;
      handleTradeOrder({
        assetClass: "options",
        symbol: "",
        action: "BUY",
        quantity: 1,
        label: "Options Order Ticket",
        legs: [],
      });
      const params = new URLSearchParams(window.location.search);
      params.delete("assetClass");
      // Issue #3088: the panel's tab follows orderTab, so the one-shot
      // also writes the tab (replaceState notifies no subscribers; the
      // panel picks the change up through the seeded asset class).
      params.set("orderTab", "options");
      const s = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${s ? `?${s}` : ""}${window.location.hash}`);
    };
    seedManualOptionsOrder();
    return subscribeToRouteChanges(seedManualOptionsOrder);
  }, [effectiveSubTab]);

  const updateOptionLeg = (index: number, patch: Partial<NonNullable<TradeOrderContext["optionLegs"]>[number]>) => {
    setOrderContext((current) => {
      if (!current?.optionLegs) return current;
      const optionLegs = current.optionLegs.map((leg, legIndex) => legIndex === index ? { ...leg, ...patch } : leg);
      return { ...current, optionLegs };
    });
    setActiveDraft(null);
    setLastExecutionResult(null);
    setOrderError("");
  };

  const addOptionLeg = () => {
    setOrderContext((current) => {
      if (!current?.optionLegs || current.optionLegs.length >= 4) return current;
      const firstOption = current.optionLegs.find((leg) => leg.securityType === "OPTN");
      return {
        ...current,
        optionLegs: [...current.optionLegs, {
          securityType: "OPTN",
          side: "BUY",
          quantity: 1,
          optionType: firstOption?.optionType || "CALL",
          strike: firstOption?.strike,
          expirationDate: firstOption?.expirationDate,
        }],
      };
    });
    setActiveDraft(null);
    setLastExecutionResult(null);
    setOrderError("");
  };

  const removeOptionLeg = (index: number) => {
    setOrderContext((current) => current?.optionLegs
      ? { ...current, optionLegs: current.optionLegs.filter((_, legIndex) => legIndex !== index) }
      : current);
    setActiveDraft(null);
    setLastExecutionResult(null);
    setOrderError("");
  };

  // Issue #3090: a built strategy REPLACES the ticket's legs wholesale
  // (a strategy is a whole structure, not an addition). The label and
  // legs text move with the legs so the context block never shows a
  // stale strategy name; strategyNetDebit clears so the broker preview
  // re-establishes pricing from live quotes instead of inheriting the
  // replaced structure's net. Same draft/result/error invalidation as
  // the other leg editors.
  const setOptionLegs = (
    legs: NonNullable<TradeOrderContext["optionLegs"]>,
    label: string,
    legsText: string[],
  ) => {
    setOrderContext((current) => current
      ? { ...current, optionLegs: legs, label, legs: legsText, strategyNetDebit: undefined }
      : current);
    setActiveDraft(null);
    setLastExecutionResult(null);
    setOrderError("");
  };

  const setOptionNetOrderDirection = (credit: boolean) => {
    setOrderContext((current) => current ? {
      ...current,
      strategyNetDebit: (credit ? -1 : 1) * Math.abs(Number.parseFloat(orderLimitPrice) || 0) * 100,
    } : current);
    setActiveDraft(null);
    setLastExecutionResult(null);
    setOrderError("");
  };

  const handleQuickTrade = (stock: ScreenedStockItem | ETradePosition | ETradeQuote, defaultAction: "BUY" | "SELL" = "BUY") => {
    setOrderContext(null);
    setOrderAssetClass("equity");
    setOrderSymbol(stock.symbol);
    setOrderAction(defaultAction);
    const quoteBid = (stock as any).bid;
    const quoteAsk = (stock as any).ask;
    let p = (stock as any).lastPrice || (stock as any).currentPrice || (stock as any).price || 100;
    if (defaultAction === "SELL" && quoteBid > 0) {
      p = quoteBid;
    } else if (defaultAction === "BUY" && quoteAsk > 0) {
      p = quoteAsk;
    }
    setOrderLimitPrice(Number(p).toFixed(2));
    setOrderQuote(stock as any);
    setActiveDraft(null); // Invalidate any previous approval
    setLastExecutionResult(null);
    setSubTab("order");
    onSelectSubTab?.("order");
  };

  const handleCloseOptionPosition = (position: ETradePosition) => {
    if (!position.optionType || !position.strikePrice || !position.expirationDate) return;
    const closingSide = position.positionType === "SHORT" ? "BUY" : "SELL";
    const contractPrice = Number(position.currentPrice || position.marketPrice || position.pricePaid || 0);
    handleTradeOrder({
      assetClass: "options",
      symbol: position.symbol,
      action: closingSide === "BUY" ? "BUY_TO_COVER" : "SELL",
      quantity: Math.max(1, Math.floor(Math.abs(position.quantity))),
      label: `Close ${position.positionType === "SHORT" ? "short" : "long"} ${position.optionType.toLowerCase()} position · ${position.expirationDate} $${position.strikePrice}`,
      legs: [`${closingSide} ${Math.abs(position.quantity)} ${position.optionType} ${position.symbol} $${position.strikePrice} exp ${position.expirationDate}`],
      optionLegs: [{
        securityType: "OPTN",
        side: closingSide,
        quantity: 1,
        optionType: position.optionType,
        strike: position.strikePrice,
        expirationDate: position.expirationDate,
      }],
      // Option positions are quoted per share; strategy prices are per contract.
      strategyNetDebit: (closingSide === "BUY" ? 1 : -1) * contractPrice * 100,
    });
  };

  const handlePreviewOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setOrderError("");
    setPreviewLoading(true);
    setActiveDraft(null);
    setLastExecutionResult(null);

    if (orderAssetClass === "options") {
      const optionLegs = orderContext?.optionLegs?.filter((leg) => leg.securityType === "OPTN") || [];
      const hasIncompleteLeg = optionLegs.some((leg) => !leg.optionType || !Number.isFinite(leg.strike) || Number(leg.strike) <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(leg.expirationDate || ""));
      if (!optionLegs.length || hasIncompleteLeg) {
        setOrderError("Complete each option leg with a call or put, positive strike, expiration date, and contract count before requesting broker preview.");
        setPreviewLoading(false);
        return;
      }
    }

    const price = parseFloat(orderLimitPrice);
    if (orderType === "LIMIT" && (isNaN(price) || price <= 0)) {
      setOrderError("Please specify a valid limit price");
      setPreviewLoading(false);
      return;
    }

    try {
      // Issue #3089: preview routes through the selected broker, not
      // the hardwired E*TRADE route.
      const brokerId = readTenantProvidersState().brokerId;
      const brokerLabel = BROKER_OPTIONS.find((o) => o.id === brokerId)?.label ?? brokerId;
      const resp = await fetch("/api/broker/order/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({
          broker: brokerId,
          assetClass: orderAssetClass,
          symbol: orderSymbol.toUpperCase(),
          orderAction,
          action: orderAction,
          quantity: Number(orderQuantity),
          orderType,
          limitPrice: orderType === "LIMIT" ? price : undefined,
          optionLegs: orderContext?.optionLegs?.map((leg) => ({ ...leg, underlyingSymbol: orderSymbol.toUpperCase(), quantity: leg.quantity * Number(orderQuantity) })),
          strategyNetDebit: orderContext?.strategyNetDebit === undefined ? undefined : orderContext.strategyNetDebit * Number(orderQuantity),
        }),
      });

      const data = await resp.json() as any;
      if (resp.ok && data.orderId) {
        setActiveDraft(data);
        fetchOrders();
      } else {
        setOrderError(data.error || `Failed to preview order on ${brokerLabel}`);
      }
    } catch (err: any) {
      setOrderError(err.message || "Failed to preview order");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleExecuteDraft = async (
    draftId: string,
    decision: "approved" | "rejected",
    draftOverride?: any
  ) => {
    const draft = draftOverride || activeDraft;
    setExecutingDraft(true);
    setOrderError("");
    try {
      const resp = await fetch("/api/broker/order/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({
          orderId: draftId,
          draftId,
          decision,
          symbol: draft?.symbol,
          action: draft?.orderAction || draft?.action,
          quantity: draft?.quantity,
          orderType: draft?.orderType,
          limitPrice: draft?.limitPrice,
          previewId: draft?.previewId ? String(draft.previewId) : undefined,
        }),
      });

      const data = await resp.json() as ETradeOrderExecutionResult;
      setLastExecutionResult(data);
      if (data.success || decision === "rejected") {
        setActiveDraft(null);
        setOrderError("");
        fetchOrders();
        fetchPositions();
      } else {
        setOrderError(data.message || "Order execution failed");
      }
    } catch (err: any) {
      setOrderError(err.message || "Execution request failed");
    } finally {
      setExecutingDraft(false);
    }
  };

  // Issue #1773 (OWASP ASI-02): re-preview is preview ONLY. The old
  // handler re-previewed and then executed the fresh draft in the
  // same click, so the user approved a payload they never saw. The
  // fresh draft now becomes the active draft and its execution
  // preview renders above the approve button; execution happens
  // only on an explicit approve of that fresh preview.
  const handleRefreshPreview = async () => {
    if (!activeDraft) return;
    setExecutingDraft(true);
    setOrderError("");
    try {
      const previewResp = await fetch("/api/broker/order/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-environment": activeEnv },
        body: JSON.stringify({
          broker: readTenantProvidersState().brokerId,
          assetClass: activeDraft.optionLegs?.some((leg) => leg.securityType === "OPTN") ? "options" : "equity",
          symbol: activeDraft.symbol,
          orderAction: activeDraft.action,
          action: activeDraft.action,
          quantity: activeDraft.quantity,
          orderType: activeDraft.orderType,
          limitPrice: activeDraft.limitPrice,
          optionLegs: activeDraft.optionLegs,
          strategyNetDebit: activeDraft.strategyNetDebit,
        }),
      });
      const freshDraft = await previewResp.json() as any;
      if (previewResp.ok && freshDraft.orderId) {
        setActiveDraft(freshDraft);
        setLastExecutionResult(null);
        setOrderError("Fresh preview ready — review the updated execution preview above, then approve to submit. Nothing has been executed.");
      } else {
        const previewBrokerLabel = BROKER_OPTIONS.find((o) => o.id === readTenantProvidersState().brokerId)?.label ?? presentation.label;
        setOrderError(freshDraft.error || `Failed to generate fresh preview on ${previewBrokerLabel}`);
      }
    } catch (err: any) {
      setOrderError(err.message || "Failed to refresh preview");
    } finally {
      setExecutingDraft(false);
    }
  };

  const copyDidToClipboard = (did: string) => {
    navigator.clipboard.writeText(did);
    setCopiedDid(true);
    setTimeout(() => setCopiedDid(false), 2000);
  };

  const tradingAgentDid = "did:agent:openaimp:trading";
  // Issue #1759: provider-neutral display DID; no-login fallback is
  // unknown (not another provider's prefix), legacy no-provider
  // sessions fall back to the GitHub derivation inside the helper.
  const userDid = user?.login ? getDisplayUserDid(user.login, user.providerId) : "did:user:unknown:authorized_trader";

  const getRsiBadgeClass = (rsi?: number) => {
    if (rsi === undefined) return "rsi-neutral";
    if (rsi <= 35) return "rsi-oversold";
    if (rsi >= 70) return "rsi-overbought";
    return "rsi-neutral";
  };

  const getRsiLabel = (rsi?: number) => {
    if (rsi === undefined) return "Unavailable";
    if (rsi <= 35) return "Oversold";
    if (rsi >= 70) return "Overbought";
    return "Neutral";
  };

  const sendNlqToChat = (prompt = nlqQuery) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    const tabLabels: Record<typeof effectiveSubTab, string> = {
      autopilot: "Autopilot Control Center",
      scanner: "Strategy/Symbol Scanner",
      screeners: "Multi-Asset Screeners",
      "stock-hub": "Stock Hub",
      reports: "Reports",
      "goal-screen": "Goal Screen",
      review: "Proposal Review",
      "track-record": "Track Record",
      "iv-history": "IV History",
      options: "Auto Options Research",
      "assets-hub": "Assets Hub",
      order: "Order Ticket",
      portfolio: "Portfolio",
      ledger: "Order History",
      omnichannel: "Email & Slack Agents",
      voice: "Voice Trading Desk",
    };
    onSendPrompt?.(cleanPrompt, `${presentation.label} · ${tabLabels[effectiveSubTab]}`);
  };

  const accountValue = account?.netAccountValue;
  const isLive = activeEnv === "PROD";

  // Issue #3669: what the ORDER page shows as connected, per selected
  // broker — E*TRADE's OAuth object, Alpaca's connect read, and for any
  // other broker the neutral status's `configured` flag (no connect
  // surface of its own yet; never another broker's answer).
  const orderBrokerConnected =
    selectedBroker === "etrade"
      ? Boolean(oauthStatus?.authenticated)
      : selectedBroker === "alpaca"
        ? Boolean(alpacaConnectStatus?.configured || alpacaConnectStatus?.signedIn)
        : Boolean((brokerStatus as { configured?: boolean } | null)?.configured);
  // Issue #3669: the displayed mode comes from the TEST/PROD selection
  // alone. The order page keeps its own derivation so the badge never
  // depends on the hub's shared live flag: before #3668 landed
  // (9112193f), hub `isLive` ORed the broker status in, so once a status
  // read reported live it stuck true even after the user clicked Paper.
  // #3668 fixed `isLive` to the same selection, so the two now agree —
  // the separate derivation stays as the badge's own contract.
  const orderTradingType: "paper" | "live" = activeEnv === "PROD" ? "live" : "paper";

  useEffect(() => {
    onBrokerPropsChange?.({
      activeEnv,
      oauthStatus,
      account,
      brokerStatus,
      maskAccount,
      setMaskAccount,
      diagnosticsLoading,
      oauthLoading,
      oauthMsg,
      setOauthMsg,
      handleSwitchEnvironment,
      handleSwitchAndConnect,
      runDiagnostics,
      handleRenewOAuth,
      handleRevokeOAuth,
      handleStartOAuth,
      onOpenEtapiTuning: () => setConfigModalOpen(true),
      userLogin: user?.login,
      userName: user?.name,
      userAvatar: user?.avatar,
    });
  }, [
    activeEnv,
    oauthStatus,
    account,
    brokerStatus,
    maskAccount,
    diagnosticsLoading,
    oauthLoading,
    oauthMsg,
    user?.login,
  ]);

  const orderLegs = orderContext?.optionLegs ?? [];

  return (
    <div className="etrade-trading-hub">
      {/* #1159: OAuth feedback used to live only inside the PIN modal,
          which opens only on success — a failed start showed nothing on
          the hub. This persistent banner surfaces it here (hidden while
          the modal is open, where the message already renders). Tone:
          known confirmations read success/info; anything else —
          including arbitrary upstream errors — defaults to danger. */}
      {oauthMsg && !showPinModal && (
        <Notice
          tone={
            oauthMsg.startsWith("Switched to") || oauthMsg.includes("disconnected.")
              ? "info"
              : oauthMsg.includes("established") || oauthMsg.includes("Connected!") || oauthMsg.includes("renewed successfully")
                ? "success"
                : "danger"
          }
          variant="strip"
          title={`${presentation.label} connection`}
          onDismiss={() => {
            setOauthMsg("");
            setBlockedAuthUrl(null);
          }}
        >
          {oauthMsg}
          {(oauthMsg.includes("SANDBOX") || oauthMsg.includes("switch environment to TEST")) && (
            <div>
              <Button type="button" variant="primary" size="sm" onClick={() => void handleSwitchAndConnect("TEST")}>
                Switch to TEST &amp; Connect
              </Button>
            </div>
          )}
        </Notice>
      )}
      {/* Blocked-popup fallback after the PIN modal is dismissed (#3197):
          the button re-opens the PIN modal bound to the ORIGINAL
          request token — it does NOT start a fresh Connect. A fresh
          Connect would mint a new token and invalidate the PIN the
          user obtained from this banner's link (comment 6635403540):
          the modal itself links the authorize URL while open, so
          re-opening the modal keeps both the link and the token. */}
      {!showPinModal && !oauthMsg && blockedAuthUrl && (
        <Notice
          tone="warning"
          variant="strip"
          title="E*TRADE connection"
          onDismiss={() => setBlockedAuthUrl(null)}
        >
          Your browser blocked the E*TRADE authorization tab. Reopen the PIN form to open it from there:
          <div>
            <Button type="button" variant="primary" size="sm" onClick={() => setShowPinModal(true)}>
              Reopen PIN form →
            </Button>
          </div>
        </Notice>
      )}
      <Modal
        open={disconnectConfirmOpen}
        onClose={() => setDisconnectConfirmOpen(false)}
        title="Disconnect E*TRADE account?"
        footer={
          <>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setDisconnectConfirmOpen(false);
                void doRevokeOAuth();
              }}
            >
              Disconnect
            </Button>{" "}
            <Button type="button" variant="secondary" onClick={() => setDisconnectConfirmOpen(false)}>
              Cancel
            </Button>
          </>
        }
      >
        <p>Disconnect your E*TRADE account? You can reconnect at any time.</p>
      </Modal>
      {/* OAuth PIN Verification Modal */}
      {showPinModal && (
        <Modal open size="none" panelClassName="etrade-pin-modal" title="Authorize E*TRADE Application" onClose={() => setShowPinModal(false)}>
              <p style={{ margin: "0 0 1rem 0", color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)", lineHeight: "1.4" }}>
                An E*TRADE authorization window has opened in a new tab. Log in, authorize application access, and enter the verification PIN provided by E*TRADE.
              </p>
              <div className="step-instruction">
                <span className="step-number">1</span>
                <span>If the tab did not open, click the button below:</span>
              </div>
              {requestTokenInfo?.authorizeUrl && (
                <a
                  href={requestTokenInfo.authorizeUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-open-etrade"
                >
                  ↗ Open E*TRADE Login &amp; Authorization
                </a>
              )}
              <div className="step-instruction">
                <span className="step-number">2</span>
                <span>Copy the verification code (PIN) displayed by E*TRADE and paste it here:</span>
              </div>
              <form onSubmit={handleSubmitPin} className="pin-form">
                <TextInput
                  type="text"
                  className="pin-input"
                  placeholder="Enter E*TRADE Verification Code (e.g. ABC1234)"
                  value={oauthPin}
                  onChange={(e) => setOauthPin(e.target.value)}
                  autoFocus
                />
                {oauthMsg && <div style={{ color: "var(--color-danger)", fontSize: "var(--font-size-body-sm)", marginBottom: "0.75rem" }}>⚠️ {oauthMsg}</div>}
                <div className="modal-btn-row">
                  <Button
                    type="submit"
                    className="btn-submit-pin"
                    variant="primary"
                    disabled={oauthSubmitting || !oauthPin.trim()}
                   loading={oauthSubmitting}>
                    {"✓ Complete Authorization & Store Token"}
                  </Button>
                  <Button
                    className="btn-cancel-modal"
                    variant="secondary"
                    onClick={() => setShowPinModal(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
      </Modal>
      )}


      {/* Active HITL Safety Preview Banner (Always visible when a draft is active) */}
      {activeDraft && (
        <div className="hitl-floating-preview-card">
          <div className="hitl-card-header">
            <div className="hitl-badge-group">
              <span className="hitl-shield-icon">🛡️</span>
              <h4>HUMAN-IN-THE-LOOP ORDER PREVIEW AWAITING APPROVAL</h4>
            </div>
            <span className="order-id-tag">ID: <code>{activeDraft.orderId}</code></span>
          </div>

          <div className="hitl-card-body">
            <div className="hitl-order-details-grid">
              <div className="hitl-stat">
                <span className="stat-label">Action</span>
                <span className={`stat-value action-pill ${activeDraft.optionLegs?.length ? "strategy" : activeDraft.action.toLowerCase()}`}>
                  {activeDraft.optionLegs?.length ? "STRATEGY" : activeDraft.action}
                </span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">Symbol</span>
                <span className="stat-value ticker-val">{activeDraft.symbol}</span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">Quantity</span>
                <span className="stat-value">{activeDraft.quantity} {activeDraft.optionLegs?.length ? "strategy units" : "shares"}</span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">Order Type</span>
                <span className="stat-value">{activeDraft.brokerOrderType && activeDraft.brokerOrderType !== "EQ" ? `${activeDraft.brokerOrderType} · ${activeDraft.orderType}` : activeDraft.orderType}</span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">{activeDraft.optionLegs?.length ? "Net limit / unit" : "Limit / Est Price"}</span>
                <span className="stat-value">${(activeDraft.limitPrice || activeDraft.estimatedPrice).toFixed(2)}</span>
              </div>
              <div className="hitl-stat">
                <span className="stat-label">{activeDraft.strategyNetDebit !== undefined && activeDraft.strategyNetDebit < 0 ? "Estimated Credit" : "Estimated Total"}</span>
                <span className="stat-value total-val">${activeDraft.estimatedTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            </div>

            {activeDraft.optionLegs?.length ? (
              <div className="options-order-context" aria-label="Exact broker order legs">
                <strong>Legs sent to {presentation.label}</strong>
                <ul>{activeDraft.optionLegs.map((leg, index) => (
                  <li key={`${leg.securityType}-${leg.optionType || "stock"}-${leg.strike || 0}-${leg.expirationDate || "equity"}-${index}`}>
                    {leg.side} {leg.quantity} {leg.securityType === "EQ" ? `${leg.underlyingSymbol} shares` : `${leg.underlyingSymbol} ${leg.optionType} $${leg.strike} ${leg.expirationDate}`}
                  </li>
                ))}</ul>
              </div>
            ) : null}

            <div className="hitl-attestation-box">
              {activeDraft.previewId && (
                <div className="attest-item">
                  <span className="attest-label">{presentation.label} Upstream Session:</span>
                  <code style={{ color: "var(--color-success)", fontWeight: "bold" }}>Preview #{activeDraft.previewId} (Verified)</code>
                </div>
              )}
              {activeDraft.previewNotes && (
                <div className="attest-item" style={{ gridColumn: "1 / -1", background: "var(--color-warning-subtle)", padding: "var(--space-1-5) var(--space-2-5)", borderRadius: "6px", border: "1px solid var(--color-warning)" }}>
                  <span className="attest-label" style={{ color: "var(--color-warning)" }}>⚠️ Broker Notice:</span>
                  <span style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-secondary)" }}>{activeDraft.previewNotes}</span>
                </div>
              )}
              <div className="attest-item">
                <span className="attest-label">Proposer DID:</span>
                <code>{activeDraft.proposerDid}</code>
              </div>
              <div className="attest-item">
                <span className="attest-label">Cryptographic Stamp:</span>
                <code className="sig-snippet">{activeDraft.proofSignature.slice(0, 32)}…</code>
              </div>
              <div className="attest-item">
                <span className="attest-label">Commission:</span>
                <span className="zero-comm">{activeDraft.estimatedCommission > 0 ? `$${activeDraft.estimatedCommission.toFixed(2)} broker estimate` : activeDraft.optionLegs?.length ? `See ${presentation.label} account disclosure` : `$0.00 (${presentation.label} online)`}</span>
              </div>
            </div>

            <div className="hitl-safety-notice">
              🛡️ <strong>Safety Guarantee:</strong> No trade will be executed without your explicit authorization. Funds remain untouched until you approve.
            </div>

            {/* Issue #1773 (OWASP ASI-02): the exact execution
                payload, fees, and slippage limits, shown BEFORE the
                approve button — approval is over this preview. */}
            <TradeExecutionPreview draft={activeDraft} />

            <div className="hitl-action-buttons">
              {(orderError.includes("timed out") || orderError.includes("resubmit") || lastExecutionResult?.message?.includes("timed out") || lastExecutionResult?.message?.includes("resubmit")) ? (
                <Button
                  className="btn-approve-order"
                  variant="primary"
                  style={{ background: "var(--color-accent)", borderColor: "var(--color-border-focus)" }}
                  disabled={executingDraft}
                  onClick={handleRefreshPreview}
                 loading={executingDraft}>
                  {"↻ Re-preview order (no execution)"}
                </Button>
              ) : (
                <Button
                  className="btn-approve-order"
                  variant="primary"
                  disabled={executingDraft}
                  onClick={() => handleExecuteDraft(activeDraft.orderId, "approved")}
                 loading={executingDraft}>
                  {`✅ Approve & Submit Trade to ${presentation.label}`}
                </Button>
              )}
              <Button variant="primary"
                type="button"
                style={{ padding: "var(--space-2-5) var(--space-4)", fontSize: "var(--font-size-body)" }}
                onClick={() => {
                  const price = activeDraft.limitPrice || activeDraft.estimatedPrice || 100;
                  setRiskSubject({
                    title: `${activeDraft.action} ${activeDraft.quantity}x ${activeDraft.symbol}`,
                    underlyingSymbol: activeDraft.symbol,
                    underlyingPrice: price,
                    strategyType: `${activeDraft.action} ${activeDraft.orderType} Order`,
                    sentiment: activeDraft.action.toLowerCase().includes("buy") ? "bullish" : "bearish",
                    quantity: activeDraft.quantity,
                    maxLoss: activeDraft.estimatedTotal,
                    breakevens: [price],
                    breakevenText: `Order Price: $${price.toFixed(2)}`,
                  });
                }}
                title="Risk Analysis — Analyze pre-trade risk profile and defense playbook"
                aria-label="Risk Analysis"
              >
                <span className="risk-shield-icon" aria-hidden="true">🛡️</span>
                <span>Risk Analysis</span>
              </Button>
              <Button
                className="btn-reject-order"
                variant="danger"
                tone="subtle"
                disabled={executingDraft}
                onClick={() => handleExecuteDraft(activeDraft.orderId, "rejected")}
              >
                ❌ Cancel Draft
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Execution Confirmation Alert */}
      {lastExecutionResult && (
        <div className={`execution-result-banner ${lastExecutionResult.success ? "success" : "rejected"}`}>
          <div className="exec-icon">{lastExecutionResult.success ? "🎉" : "🚫"}</div>
          <div className="exec-text">
            <strong>{lastExecutionResult.message}</strong>
            <div className="exec-sub">
              Ref: <code>{lastExecutionResult.brokerOrderRef}</code> •
              Status: <strong>{lastExecutionResult.status.toUpperCase()}</strong> •
              Authorizer: <code>{lastExecutionResult.authorizerDid || userDid}</code>
            </div>
            {(!lastExecutionResult.success && (lastExecutionResult.message?.includes("timed out") || lastExecutionResult.message?.includes("resubmit"))) && activeDraft && (
              <div style={{ marginTop: "8px" }}>
                <Button variant="trade"
                  type="button"
                  disabled={executingDraft}
                  onClick={handleRefreshPreview}
                 loading={executingDraft}>
                  {"↻ Re-preview order (no execution)"}
                </Button>
              </div>
            )}
          </div>
          <Button
            className="btn-dismiss-exec"
            variant="ghost"
            size="sm"
            onClick={() => setLastExecutionResult(null)}
          >
            ✕
          </Button>
        </div>
      )}

      {/* SUBTAB 0: AUTOPILOT CONTROL CENTER */}
      <PageShell title={shellTitle} scopeNote={shellScopeNote}>
      {effectiveSubTab === "autopilot" && (
        <AutopilotControlCenter
          user={user}
          isLiveAccount={isLive}
          onSendPrompt={onSendPrompt}
          onNavigateOrder={(sym) => {
            setOrderSymbol(sym);
            handleNavigateSubTab("order");
          }}
        />
      )}

      {/* C2: the screening subtabs render the one hub directly on
          the equivalent tab — no redirect notices. */}
      {effectiveSubTab === "iv-history" && renderOptionsHub("iv-history")}

      {effectiveSubTab === "screeners" && renderScreenersHub("forex")}
      {effectiveSubTab === "assets-hub" && renderScreenersHub("forex")}
      {effectiveSubTab === "stock-hub" && renderStockHub("stocks")}

      {/* Issue #2970: reports, schedules, goal-screen, review, and
          track-record render their panels directly — the same props
          the hub passed them. Issue #2971 removed them from the hub,
          so these branches are now the only home for those panels. */}
      {effectiveSubTab === "reports" && <ReportsPanel />}

      {/* Issue #3121 S2: the schedules branch is gone — the
          consolidated home renders from the shell (Chat.tsx
          TAB_CONTENT), not through this hub. */}

      {effectiveSubTab === "goal-screen" && <GoalScreenPanel activeEnv={activeEnv} userLogin={user?.login} />}

      {effectiveSubTab === "review" && <ScreeningReviewPanel userLogin={user?.login} />}

      {effectiveSubTab === "track-record" && (
        <TrackRecordPanel userLogin={user?.login} />
      )}

      {/* SUBTAB 1: MARKET SCREENER & SCANNER — folded into the hub. */}
      {effectiveSubTab === "scanner" && renderOptionsHub("strategy-scanner")}

      {effectiveSubTab === "options" && renderOptionsHub()}

      {/* SUBTAB 2: ORDER TICKET & HITL PREVIEW */}
      {effectiveSubTab === "order" && (
        <OrderTicketPanel
          ticket={{
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
            // Issue #3669: the order branch receives the broker-neutral
            // connection model, not the raw E*TRADE OAuth object — the
            // panel never sees another broker's connect flow.
            brokerId: selectedBroker,
            tradingType: orderTradingType,
            brokerConnected: orderBrokerConnected,
            activeEnv,
            onConnectBroker: handleStartOAuth,
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
          }}
        />
      )}

      {/* SUBTAB 3: PORTFOLIO & POSITIONS */}
      {effectiveSubTab === "portfolio" && (
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
                onClick={() => handleNavigateSubTab("order")}
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
                    <span className="summary-amount">{summary.positionCount}</span>
                    <span className="summary-change">
                      {summary.optionCount} options · {summary.equityCount} equities &amp; ETFs
                    </span>
                  </div>
                </>
              );
            })()}
          </div>

          <div className="portfolio-table-wrap" id="section-positions" style={{ scrollMarginTop: 80 }}>
            <Table
                      columns={[
                        { key: "symbol", header: "Symbol & Company", render: (pos: any) => (<><div className="ticker-company"><span className="ticker-badge">{pos.symbol}</span><span className="company-title">{pos.securityType === "OPTN" ? `${pos.optionType || "Option"} $${Number(pos.strikePrice || 0).toFixed(2)} · ${pos.expirationDate || "Expiry unavailable"}` : pos.description}</span></div>{pos.securityType === "OPTN" && <span className="position-type-badge">{pos.positionType === "SHORT" ? "Short option" : "Long option"}</span>}</>) },
                        { key: "qty", header: "Quantity", render: (pos: any) => <span className="qty-val">{pos.quantity} {pos.securityType === "OPTN" ? "contracts" : "shares"}</span> },
                        { key: "cost", header: "Avg Cost Basis", render: (pos: any) => <span>${Number(pos.costBasis ?? pos.pricePaid ?? 0).toFixed(2)}</span> },
                        { key: "price", header: "Current Price", render: (pos: any) => <span className="price-tag">${Number(pos.currentPrice ?? pos.marketPrice ?? 0).toFixed(2)}</span> },
                        { key: "mkt", header: "Total Market Value", render: (pos: any) => <span className="mkt-val">${Number(pos.marketValue ?? (Number(pos.currentPrice ?? pos.marketPrice ?? 0) * Number(pos.quantity ?? 0))).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> },
                        { key: "unreal", header: "Unrealized Gain / Loss", render: (pos: any) => { const g = Number(pos.unrealizedGainLoss ?? pos.totalGain ?? 0); const gp = Number(pos.unrealizedGainLossPercent ?? pos.totalGainPercent ?? 0); const isPos = g >= 0; return <span className={`change-pill ${isPos ? "positive" : "negative"}`}>{isPos ? "+" : ""}${g.toFixed(2)} ({isPos ? "+" : ""}{gp.toFixed(2)}%)</span>; } },
                        { key: "day", header: "Day's Gain", render: (pos: any) => { const d = Number(pos.daysGain ?? 0); const dp = Number(pos.daysGainPercent ?? 0); const isPos = d >= 0; return <span className={`change-pill ${isPos ? "positive" : "negative"}`}>{isPos ? "+" : ""}${d.toFixed(2)} ({isPos ? "+" : ""}{dp.toFixed(2)}%)</span>; } },
                        { key: "actions", header: "Actions", render: (pos: any) => { const costBasis = Number(pos.costBasis ?? pos.pricePaid ?? 0); const curPrice = Number(pos.currentPrice ?? pos.marketPrice ?? 0); const mktVal = Number(pos.marketValue ?? (curPrice * Number(pos.quantity ?? 0))); const unrealizedGain = Number(pos.unrealizedGainLoss ?? pos.totalGain ?? 0); return (<div className="table-actions-cell">{pos.securityType === "OPTN" && pos.optionType && pos.strikePrice && pos.expirationDate ? (<Button variant="danger" tone="subtle" size="sm" type="button" onClick={() => handleCloseOptionPosition(pos)} title="Build a broker-priced closing order for this option position">- Close Option</Button>) : pos.securityType === "OPTN" ? (<span className="position-action-unavailable" title="The broker did not return enough contract details to build a closing order.">Contract details unavailable</span>) : (<><Button variant="trade" tone="subtle" size="sm" type="button" onClick={() => handleQuickTrade(pos, "BUY")} title="Add more shares">+ Buy</Button><Button variant="danger" tone="subtle" size="sm" type="button" onClick={() => handleQuickTrade(pos, "SELL")} title="Sell to close position">- Close</Button></>)}<Button variant="warning" tone="subtle" size="sm" type="button" onClick={() => { setRiskSubject({ title: `${pos.quantity}x ${pos.symbol} (${pos.description || "Long Equity"})`, underlyingSymbol: pos.symbol, underlyingPrice: curPrice, strategyType: "Long Equity Position", sentiment: "bullish", quantity: pos.quantity, positionType: "EQUITY", costBasis: costBasis, unrealizedPnL: unrealizedGain, maxLoss: mktVal, maxProfit: null, breakevens: [costBasis], breakevenText: `Cost basis: $${costBasis.toFixed(2)}/share` }); }} title="Analyze position risk profile and hedging strategies">🛡️ Risk</Button></div>); } },
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
                              <Button variant="trade" onClick={() => handleNavigateSubTab("order")}>
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
              <AlpacaBrokerPanel activeEnv={activeEnv} />
            )}
          </ErrorBoundary>

          <ErrorBoundary label="Portfolio Risk panel">
            {/* Issue #3356: the catalogue decides whether risk is served, and the
                panel reads the SELECTED broker's book. A broker that declares no risk
                model gets a named notice instead of another broker's numbers. */}
            {riskBroker && brokerSupports(riskBroker, "portfolioRisk") ? (
              <PortfolioRiskPanel activeEnv={activeEnv} onPreviewHedge={handleTradeOrder} broker={riskBroker} />
            ) : (
              <Notice tone="neutral" title="Portfolio risk analytics are not available for this broker">
                The selected broker declares no portfolio risk model. No other broker's positions are
                substituted for it.
              </Notice>
            )}
          </ErrorBoundary>
        </div>
      )}

      {/* SUBTAB 4: ORDER HISTORY LEDGER */}
      {effectiveSubTab === "ledger" && (
        <Card className="trading-section">
          <div className="ledger-header-row">
            <h4>📜 Order Execution Ledger (Audited Trade Records)</h4>
            <Button
              variant="secondary"
              disabled={ordersLoading}
              onClick={fetchOrders}
             loading={ordersLoading}>
              {"🔄 Refresh Ledger"}
            </Button>
          </div>

          <div className="ledger-table-wrap">
            <Table
                      columns={[
                        { key: "id", header: "Order ID", render: (ord: any) => <code>{ord.id}</code> },
                        { key: "symbol", header: "Symbol", render: (ord: any) => <span className="ticker-badge">{ord.symbol}</span> },
                        { key: "action", header: "Action", render: (ord: any) => <span className={`action-pill ${ord.action.toLowerCase()}`}>{ord.action}</span> },
                        { key: "qty", header: "Shares", render: (ord: any) => <>{ord.quantity}</> },
                        { key: "price", header: "Price", render: (ord: any) => <>${ord.price.toFixed(2)}</> },
                        { key: "total", header: "Total Value", render: (ord: any) => <>${ord.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</> },
                        { key: "status", header: "Status", render: (ord: any) => <span className={`tx-status-pill ${ord.status}`}>{ord.status.toUpperCase()}</span> },
                        { key: "ref", header: "Broker Ref", render: (ord: any) => <code className="broker-ref-snippet">{ord.orderRef || "—"}</code> },
                        { key: "did", header: "Proposer DID", render: (ord: any) => <code className="did-snippet" title={ord.proposerDid}>{ord.proposerDid.replace("did:agent:openaimp:", "")}</code> },
                        { key: "date", header: "Date & Time", render: (ord: any) => <span className="time-snippet">{new Date(ord.createdAt).toLocaleString()}</span> },
                        { key: "actions", header: "Action", render: (ord: any) => <Button variant="warning" tone="subtle" size="sm" type="button" onClick={() => { setRiskSubject({ title: `${ord.action} ${ord.quantity}x ${ord.symbol}`, underlyingSymbol: ord.symbol, underlyingPrice: ord.price, strategyType: `${ord.action} Trade`, sentiment: ord.action.toLowerCase().includes("buy") ? "bullish" : "bearish", quantity: ord.quantity, positionType: "EQUITY", maxLoss: ord.totalValue, breakevens: [ord.price], breakevenText: `Price: $${ord.price.toFixed(2)}` }); }} title="Analyze risk profile for this ledger trade">🛡️ Risk</Button> },
                      ]}
                      rows={orders}
                      rowKey={(ord: any) => ord.id}
                      empty={ordersLoading ? <Spinner label="Loading orders ledger" /> : <EmptyState title="No trade orders recorded yet." />}
                    />
          </div>
        </Card>
      )}

      {/* Omnichannel Trading Desks (Autonomous Email & Slack Desks) */}
      {effectiveSubTab === "omnichannel" && (
        <div className="tab-pane active omnichannel-pane">
          {/* Issue #3429: the desks execute against E*TRADE, so another broker is told\n              before it types a command — the backend refuses the same request. */}
          {selectedBroker !== "etrade" && (
            <Notice tone="warning" title={`${presentation.label} does not run these desks`}>
              The email, Slack and voice desks execute against E*TRADE. Nothing here is previewed or\n              routed for {presentation.label}; use the Trading Hub order ticket or the neutral order API.
            </Notice>
          )}
          {/* Header Card */}
          <div className="omnichannel-header-card">
            <div className="omnichannel-header-top">
              <div>
                <span className="omnichannel-header-badge">
                  Autonomous Multi-Agent Architecture
                </span>
                <h3 className="omnichannel-header-title">
                  💬 Omnichannel Trading Desks (Email &amp; Slack)
                </h3>
                <p className="omnichannel-header-desc">
                  Autonomous market research, quoting, and Human-in-the-Loop order drafting via Inbound Email and Slack Bot communication channels. All orders require explicit human authorization before live {presentation.label} execution.
                </p>
              </div>
              <div className="omnichannel-header-status">
                <span className="omnichannel-live-badge">
                  ✓ {presentation.label} REST API · {isLive ? "LIVE" : "PAPER"}
                </span>
              </div>
            </div>
          </div>

          <div className="omnichannel-grid">
            {/* Channel 1: Autonomous Email Trading Desk */}
            <div className="omnichannel-card">
              <div className="omnichannel-card-header">
                <h4 className="omnichannel-card-title email">
                  <span>✉️</span> Autonomous Email Trading Desk
                </h4>
                <span className="omnichannel-badge-subtle cyan">
                  send_email &amp; PostalMime
                </span>
              </div>

              <div className="omnichannel-meta-box">
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Inbound Address:</strong> <code>trade@agent.openaimp.com</code>
                </div>
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Security Guarantee:</strong> Stamped with Trading DID (<code>did:agent:openaimp:trading</code>).
                </div>
                <div>
                  <strong>Commands:</strong> <code>Quote &lt;SYMBOL&gt;</code>, <code>Screen stocks priced between $20 and $200</code>, <code>Preview Buy 10 NVDA limit 125</code>, <code>APPROVE &lt;orderId&gt;</code>.
                </div>
              </div>

              {/* Email Simulator Form */}
              <div className="omnichannel-simulator-card">
                <h5 className="omnichannel-simulator-title">
                  🧪 Interactive Email Simulator
                </h5>
                <div className="omnichannel-form-group">
                  <div>
                    <TextInput label="From (Sender Email):" id="omni-email-from"
                      type="email"
                      value={emailFrom}
                      onChange={(e) => setEmailFrom(e.target.value)}
                    />
                  </div>
                  <div>
                    <TextInput label="Subject:" id="omni-email-subject"
                      type="text"
                      value={emailSubject}
                      onChange={(e) => setEmailSubject(e.target.value)}
                    />
                  </div>
                  <div>
                    <TextInput label="Email Body:" id="omni-email-body"
                      multiline
                      rows={2}
                      value={emailBody}
                      onChange={(e) => setEmailBody(e.target.value)}
                    />
                  </div>

                  {/* Preset Quick Chips */}
                  <div className="omnichannel-chip-row">
                    <Button
                      onClick={() => { setEmailSubject("Quote NVDA"); setEmailBody("What is the current price and technicals?"); }}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      📈 Quote NVDA
                    </Button>
                    <Button
                      onClick={() => { setEmailSubject("Screen stock price range"); setEmailBody("Show stocks priced between $20 and $200"); }}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      🔍 Screen Price Range
                    </Button>
                    <Button
                      onClick={() => { setEmailSubject("Order Preview"); setEmailBody("Buy 10 shares of NVDA limit 125.00"); }}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      🛡️ Buy 10 NVDA
                    </Button>
                    {activeDraft && (
                      <Button
                        onClick={() => { setEmailSubject("Order Approval"); setEmailBody(`APPROVE ${activeDraft.orderId}`); }}
                        variant="primary"
                        tone="subtle"
                        size="sm"
                      >
                        ✓ APPROVE {activeDraft.orderId}
                      </Button>
                    )}
                  </div>

                  <Button
                    disabled={emailLoading}
                    onClick={handleSimulateEmail}
                    variant="primary"
                   loading={emailLoading}>
                    {"⚡ Send Test Email to Agent"}
                  </Button>
                </div>
              </div>

              {/* Email Result Output */}
              {emailResult && (
                <div className="omnichannel-result-box">
                  <div className="omnichannel-result-header">
                    <span className="omnichannel-result-title">Agent Email Reply:</span>
                    <span className="omnichannel-result-action">
                      {emailResult.actionType || "reply"}
                    </span>
                  </div>
                  <h6 className="omnichannel-result-subject">
                    Subject: {emailResult.responseSubject}
                  </h6>
                  {emailResult.responseHtml ? (
                    <div
                      className="omnichannel-result-html"
                      dangerouslySetInnerHTML={{ __html: emailResult.responseHtml }}
                    />
                  ) : (
                    <pre className="omnichannel-result-pre">
                      {emailResult.responseText}
                    </pre>
                  )}
                </div>
              )}
            </div>

            {/* Channel 2: Autonomous Slack Trading Desk */}
            <div className="omnichannel-card">
              <div className="omnichannel-card-header">
                <h4 className="omnichannel-card-title slack">
                  <span>🤖</span> Autonomous Slack Trading Desk
                </h4>
                <span className="omnichannel-badge-subtle purple">
                  Events &amp; Block Kit
                </span>
              </div>

              <div className="omnichannel-meta-box">
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Event Request URL:</strong> <code className="slack-url">https://agent.openaimp.com/slack/events</code>
                </div>
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Interactivity URL:</strong> <code className="slack-url">https://agent.openaimp.com/slack/interactions</code>
                </div>
                <div>
                  <strong>OAuth App Install:</strong> <a href="/slack/install" target="_blank" rel="noreferrer" className="slack-install-link">Install to Workspace</a>
                </div>
              </div>

              {/* Slack Simulator Form */}
              <div className="omnichannel-simulator-card">
                <h5 className="omnichannel-simulator-title">
                  🧪 Interactive Slack Bot Simulator
                </h5>
                <div className="omnichannel-form-group">
                  <div>
                    <TextInput label="Slack Message / Mention:" id="omni-slack-message"
                      type="text"
                      value={slackPrompt}
                      onChange={(e) => setSlackPrompt(e.target.value)}
                    />
                  </div>

                  {/* Preset Quick Chips */}
                  <div className="omnichannel-chip-row">
                    <Button
                      onClick={() => handleSimulateSlack("@${presentation.botName} quote NVDA")}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      📈 Quote NVDA
                    </Button>
                    <Button
                      onClick={() => handleSimulateSlack("@${presentation.botName} screen stocks priced between $20 and $200")}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      🔍 Screen Price Range
                    </Button>
                    <Button
                      onClick={() => handleSimulateSlack("@${presentation.botName} preview buy 10 NVDA limit 125.00")}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      ⚡ Buy 10 NVDA Ticket
                    </Button>
                    <Button
                      onClick={() => handleSimulateSlack("@${presentation.botName} show my portfolio positions")}
                      variant="secondary"
                      tone="subtle"
                      size="sm"
                    >
                      💼 Portfolio
                    </Button>
                  </div>

                  <Button
                    disabled={slackLoading}
                    onClick={() => handleSimulateSlack()}
                    variant="primary"
                   loading={slackLoading}>
                    {"⚡ Simulate Slack Message"}
                  </Button>
                </div>
              </div>

              {/* Slack Block Kit Card Viewer */}
              {slackResult?.response && (
                <div className="omnichannel-slack-viewer">
                  <div className="omnichannel-slack-user-header">
                    <span style={{ fontSize: "var(--font-size-title)" }}>🤖</span>
                    <div>
                      <strong className="slack-bot-name">{presentation.botName}</strong>{" "}
                      <span className="slack-app-tag">APP</span>
                      <span className="slack-time">Just now</span>
                    </div>
                  </div>

                  <div className="omnichannel-slack-body">
                    {slackResult.response.blocks?.map((block: any, bIdx: number) => {
                      if (block.type === "header") {
                        return <h5 key={bIdx} className="slack-block-heading">{block.text?.text}</h5>;
                      }
                      if (block.type === "section" && block.fields) {
                        return (
                          <div key={bIdx} className="slack-block-fields">
                            {block.fields.map((f: any, fIdx: number) => (
                              <div key={fIdx} className="omnichannel-slack-field">
                                {f.text?.split("\n").map((line: string, lIdx: number) => (
                                  <div key={lIdx}>{line.replace(/\*/g, "")}</div>
                                ))}
                              </div>
                            ))}
                          </div>
                        );
                      }
                      if (block.type === "section" && block.text) {
                        return <p key={bIdx} className="slack-block-text">{block.text.text?.replace(/\*/g, "")}</p>;
                      }
                      if (block.type === "actions") {
                        return (
                          <div key={bIdx} className="slack-actions-row">
                            {block.elements?.map((btn: any, btnIdx: number) => (
                              <Button
                                variant={btn.style === "primary" ? "primary" : "danger"}
                                key={btnIdx}
                                disabled={slackActionLoading}
                                onClick={() => handleSlackActionButton(btn.action_id, btn.value)}
                                style={{
                                  background: btn.style === "primary" ? "var(--color-success)" : "var(--color-danger)",
                                  color: "var(--color-text-inverse)",
                                  border: "none",
                                  borderRadius: "var(--radius-xs, 4px)",
                                  padding: "var(--space-1-5) var(--space-3)",
                                  fontWeight: "bold",
                                  fontSize: "var(--font-size-body-sm)",
                                  cursor: "pointer",
                                }}
                              >
                                {btn.text?.text}
                              </Button>
                            ))}
                          </div>
                        );
                      }
                      if (block.type === "context") {
                        return (
                          <div key={bIdx} className="slack-context-row">
                            {block.elements?.[0]?.text?.replace(/`/g, "")}
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Autonomous Voice Trading Desk */}
      {effectiveSubTab === "voice" && (
        <div className="tab-pane active voice-pane">
          {/* Issue #3429: the voice desk is E*TRADE\x27s service; say so for another broker. */}
          {selectedBroker !== "etrade" && (
            <Notice tone="warning" title={`${presentation.label} does not run the voice desk`}>
              The voice desk executes against E*TRADE. Nothing spoken here is previewed or routed for\n              {presentation.label}; use the Trading Hub order ticket or the neutral order API.
            </Notice>
          )}
          {/* Header Card */}
          <div className="voice-header-card">
            <div className="voice-header-top">
              <div>
                <span className="voice-header-badge">
                  Real-Time Voice Architecture
                </span>
                <h3 className="voice-header-title">
                  <span>🎙️</span> {presentation.deskName}
                </h3>
                <p className="voice-header-desc">
                  Real-time conversational voice trading with speech synthesis and recognition. Verbal quote inquiries, technical screening, and strict two-stage verbal Human-in-the-Loop order drafting.
                </p>
              </div>
              <div className="voice-header-status">
                <span className={`voice-status-pill ${voiceStatus}`}>
                  <span className={`voice-status-dot ${voiceStatus}`} />
                  {voiceStatus.toUpperCase()}
                </span>
              </div>
            </div>
          </div>

          <div className="voice-main-grid">
            {/* Visualizer & Mic Control Bar */}
            <div className="voice-control-card">
              <div className="voice-control-actions">
                <Button
                  type="button"
                  onClick={handleToggleVoiceRecording}
                  variant={speechRecognitionActive ? "danger" : "primary"}
                >
                  <span>{speechRecognitionActive ? "🛑 Stop Listening" : "🎙️ Push to Talk / Speak"}</span>
                </Button>

                <Button
                  type="button"
                  onClick={() => setVoiceIsMuted(!voiceIsMuted)}
                  variant="secondary"
                >
                  {voiceIsMuted ? "🔇 Voice Muted" : "🔊 Audio On"}
                </Button>
              </div>

              {/* Animated Audio Visualizer Bars */}
              <div className="voice-visualizer-bars">
                {[12, 24, 38, 20, 32, 16, 28, 36, 18, 26, 34, 14].map((h, i) => (
                  <div
                    key={i}
                    className={`voice-vbar ${voiceStatus}`}
                    style={{
                      height: voiceStatus === "speaking" || voiceStatus === "listening" ? `${Math.max(8, (h * (voiceStatus === "listening" ? 1.2 : 0.9)))}px` : "6px",
                    }}
                  />
                ))}
              </div>

              {/* Interim Real-Time Transcript Display */}
              {voiceInterim && (
                <div className="voice-interim-box">
                  🎙️ <em>{voiceInterim}…</em>
                </div>
              )}

              {/* Quick Spoken Chips */}
              <div className="voice-chips-row">
                <Button
                  onClick={() => handleVoiceTurn("What is Nvidia trading at?")}
                  variant="secondary"
                  tone="subtle"
                  size="sm"
                >
                  📈 "What is Nvidia trading at?"
                </Button>
                <Button
                  onClick={() => handleVoiceTurn("Screen stocks priced between $20 and $200")}
                  variant="secondary"
                  tone="subtle"
                  size="sm"
                >
                  🔍 "Screen price range"
                </Button>
                <Button
                  onClick={() => handleVoiceTurn("What is my portfolio balance?")}
                  variant="secondary"
                  tone="subtle"
                  size="sm"
                >
                  💼 "Check portfolio balance"
                </Button>
                <Button
                  onClick={() => handleVoiceTurn("Buy 10 shares of NVDA at market")}
                  variant="primary"
                  tone="subtle"
                  size="sm"
                >
                  ⚡ "Buy 10 NVDA at market"
                </Button>
                {activeDraft && (
                  <>
                    <Button
                      onClick={() => handleVoiceTurn(`Confirm order ${activeDraft.orderId}`)}
                      variant="primary"
                      tone="subtle"
                      size="sm"
                    >
                      ✓ "Confirm order {activeDraft.orderId}"
                    </Button>
                    <Button
                      onClick={() => handleVoiceTurn(`Cancel order ${activeDraft.orderId}`)}
                      variant="danger"
                      tone="subtle"
                      size="sm"
                    >
                      ✕ "Cancel order {activeDraft.orderId}"
                    </Button>
                  </>
                )}
              </div>

              {/* Text Fallback Input Box */}
              <form
                onSubmit={(e) => { e.preventDefault(); handleVoiceTurn(); }}
                className="voice-input-form"
              >
                <TextInput
                  type="text"
                  placeholder="Or type a spoken command: e.g. 'What is Apple trading at?' or 'Buy 10 NVDA at market'"
                  value={voiceInputText}
                  onChange={(e) => setVoiceInputText(e.target.value)}
                  className="voice-text-input"
                />
                <Button
                  type="submit"
                  disabled={voiceLoading || !voiceInputText.trim()}
                  className="btn-voice-send"
                  variant="primary"
                 loading={voiceLoading}>
                  {"Send Voice Turn"}
                </Button>
              </form>
            </div>

            {/* Conversation Feed */}
            <div className="voice-feed-card">
              <h5 className="voice-feed-title">
                <span>💬</span> Live Voice Conversation History
              </h5>

              <div className="voice-feed-scroll">
                {voiceTranscript.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`voice-turn ${msg.role === "user" ? "user-turn" : "bot-turn"}`}
                  >
                    <div className="voice-turn-meta">
                      <span>{msg.role === "user" ? "👤 Trader (Voice)" : `🤖 ${presentation.deskAgentName}`}</span>
                      <span>• {msg.timestamp}</span>
                    </div>

                    <div className={`voice-bubble ${msg.role === "user" ? "user-bubble" : "bot-bubble"}`}>
                      <div>{msg.text}</div>

                      {/* Embedded HITL Order Preview Card in Voice Feed */}
                      {msg.actionType === "preview" && msg.orderDraft && (
                        <div className="voice-order-preview-box">
                          <div className="voice-order-preview-title">
                            🛡️ Order Preview Staged (HITL Required)
                          </div>
                          <div className="voice-order-preview-details">
                            <div><strong>Order ID:</strong> <code>{msg.orderDraft.orderId}</code></div>
                            <div><strong>Action:</strong> {msg.orderDraft.action} {msg.orderDraft.quantity} {msg.orderDraft.quantity === 1 ? "share" : "shares"} of {msg.orderDraft.symbol} {msg.orderDraft.orderType === "LIMIT" ? `(LIMIT @ $${(msg.orderDraft.limitPrice || msg.orderDraft.estimatedPrice)?.toFixed(2)})` : "(MARKET)"}</div>
                            <div><strong>Estimated Total:</strong> ${msg.orderDraft.estimatedTotal?.toFixed(2)} USD</div>
                          </div>
                          {/* Issue #1773 (OWASP ASI-02): the voice
                              approve path shows the same exact
                              payload, fees, and slippage limits. */}
                          <TradeExecutionPreview draft={msg.orderDraft} />
                          <div className="voice-order-preview-actions">
                            <Button
                              onClick={() => handleVoiceOrderAction("approve", msg.orderDraft.orderId)}
                              variant="primary"
                              tone="subtle"
                            >
                              ✓ Voice Approve &amp; Execute
                            </Button>
                            <Button
                              onClick={() => handleVoiceOrderAction("cancel", msg.orderDraft.orderId)}
                              variant="danger"
                              tone="subtle"
                            >
                              ✕ Cancel Draft
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* Embedded Execution Receipt */}
                      {msg.actionType === "approval" && msg.brokerOrderRef && (
                        <div className="voice-receipt-box">
                          ✓ Broker Ref: <code>{msg.brokerOrderRef}</code> • Status: <strong>EXECUTED</strong>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      </PageShell>

      {/* Quote Inspection Modal */}
      {inspectSymbol && (
        <Modal open size="none" panelClassName="quote-modal-content" onClose={() => setInspectSymbol(null)}
          title={<div className="ticker-group">
            <span className="modal-ticker">{inspectSymbol}</span>
            <span className="modal-company">{inspectQuote?.companyName || "Loading…"}</span>
          </div>}>

            {inspectLoading ? (
              <div className="modal-loading">Fetching real-time Level 1 Quote…</div>
            ) : inspectQuote ? (<>

                <div className="price-big-row">
                  <span className="big-price">${inspectQuote.lastPrice.toFixed(2)}</span>
                  <span className={`big-change ${inspectQuote.change >= 0 ? "positive" : "negative"}`}>
                    {inspectQuote.change >= 0 ? "+" : ""}{inspectQuote.change.toFixed(2)} ({inspectQuote.changePercent.toFixed(2)}%)
                  </span>
                </div>

                <div className="quote-grid-3">
                  <div className="grid-item">
                    <span className="label">Bid</span>
                    <span className="val">${inspectQuote.bid.toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Ask</span>
                    <span className="val">${inspectQuote.ask.toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Spread</span>
                    <span className="val">${(inspectQuote.ask - inspectQuote.bid).toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Open</span>
                    <span className="val">${inspectQuote.open.toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Day High</span>
                    <span className="val">${inspectQuote.high.toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Day Low</span>
                    <span className="val">${inspectQuote.low.toFixed(2)}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">52-Week High</span>
                    <span className="val">{inspectQuote.week52High !== undefined ? `$${inspectQuote.week52High.toFixed(2)}` : "—"}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">52-Week Low</span>
                    <span className="val">{inspectQuote.week52Low !== undefined ? `$${inspectQuote.week52Low.toFixed(2)}` : "—"}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Volume</span>
                    <span className="val">{(inspectQuote.volume / 1e6).toFixed(2)}M</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">P/E Ratio</span>
                    <span className="val">{inspectQuote.peRatio || "N/A"}</span>
                  </div>
                  <div className="grid-item">
                    <span className="label">Market Cap</span>
                    <span className="val">
                      {inspectQuote.marketCap ? `$${(inspectQuote.marketCap / 1e9).toFixed(1)}B` : "N/A"}
                    </span>
                  </div>
                  <div className="grid-item">
                    <span className="label">RSI (14)</span>
                    <span className={`val ${getRsiBadgeClass(inspectQuote.rsi)}`}>
                      {inspectQuote.rsi?.toFixed(1) || "N/A"}
                    </span>
                  </div>
                </div>

                <div className="modal-actions-bar">
                  <Button
                    className="btn-modal-buy"
                    variant="trade"
                    onClick={() => {
                      handleQuickTrade(inspectQuote, "BUY");
                      setInspectSymbol(null);
                    }}
                  >
                    ⚡ Trade {inspectQuote.symbol}
                  </Button>
                  <Button
                    className="btn-modal-dismiss"
                    variant="secondary"
                    onClick={() => setInspectSymbol(null)}
                  >
                    Close
                  </Button>
                </div>
              </>
            ) : (
              <div className="modal-error">Could not retrieve quote details.</div>
            )}
      </Modal>
      )}
      {/* Live REST Diagnostics Modal */}
      {showDiagnosticsModal && (
        <Modal open size="none" panelClassName="etrade-pin-modal diagnostics-modal" title={`${(diagnostics?.broker || selectedBroker) === "alpaca" ? "🦙" : "⚡"} ${brokerPresentation(diagnostics?.broker || selectedBroker).label} Diagnostics [${diagnostics?.environment || activeEnv}]`} onClose={() => setShowDiagnosticsModal(false)}>
              {diagnostics ? (
                <>
                  <div className="diag-header-row">
                    <span className={`status-pill status-${diagnostics.status || "unknown"}`}>
                      {diagnostics.status === "healthy" ? "🟢 Live REST Upstream Connected & Verified" : (diagnostics.status === "auth_required" ? "🟡 Authentication / Session Required" : (diagnostics.status === "not_configured" ? "🟡 Unconfigured / Sign-in Required" : "🔴 Upstream Gateway Error"))}
                    </span>
                    <span className="diag-gateway-text">
                      Gateway: <code>{diagnostics.apiUrl || (diagnostics.broker === "alpaca" ? (diagnostics.environment === "PROD" ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets") : "Unknown")}</code>
                    </span>
                  </div>

                  {diagnostics.lastError && (
                    <div className="diag-error-box">
                      <strong className="diag-error-title">Upstream Message / Error:</strong>
                      <div className="diag-error-msg">
                        {diagnostics.lastError}
                      </div>
                      {diagnostics.lastError.includes("only in SANDBOX environment") && (
                        <div className="diag-sandbox-switch">
                          <span className="diag-sandbox-hint">
                            💡 This Consumer Key belongs to E*TRADE Sandbox (apisb.etrade.com). Switch to TEST to test with this key!
                          </span>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={async () => {
                              setShowDiagnosticsModal(false);
                              await handleSwitchEnvironment("TEST");
                              await runDiagnostics(diagnostics?.broker, "TEST");
                            }}
                          >
                            🧪 Switch to TEST &amp; Re-run
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="diag-grid">
                    <div className="diag-card">
                      <div className="diag-label">{diagnostics.broker === "alpaca" ? "API Key ID" : "Consumer Key"}</div>
                      <div className="diag-val">
                        {diagnostics.credentials?.apiKeyMasked || (diagnostics.credentials?.apiKeyConfigured ? "✓ Configured" : "MISSING")}
                      </div>
                    </div>
                    <div className="diag-card">
                      <div className="diag-label">{diagnostics.broker === "alpaca" ? "API Secret Key" : "Consumer Secret"}</div>
                      <div className="diag-val">
                        {diagnostics.credentials?.apiSecretConfigured ? "✓ Securely Configured" : "MISSING"}
                      </div>
                    </div>
                    <div className="diag-card">
                      <div className="diag-label">{diagnostics.broker === "alpaca" ? "Key Source / Session" : "Session Token Vault"}</div>
                      <div className={`diag-val ${diagnostics.oauthToken?.present ? "token-active" : "token-inactive"}`}>
                        {diagnostics.broker === "alpaca"
                          ? (diagnostics.oauthToken?.present ? "✓ Configured & Active" : "No Active Key")
                          : (diagnostics.oauthToken?.present ? "✓ Present & Active" : "No Active Token")}
                      </div>
                    </div>
                    <div className="diag-card">
                      <div className="diag-label">Upstream Accounts</div>
                      <div className="diag-val">
                        {diagnostics.upstreamAccounts?.count ?? 0} account(s) detected
                      </div>
                    </div>
                  </div>

                  {diagnostics.upstreamAccounts?.accounts && diagnostics.upstreamAccounts.accounts.length > 0 && (
                    <div className="diag-account-details">
                      <strong className="diag-account-title">
                        Live Account Details:
                      </strong>
                      {diagnostics.upstreamAccounts.accounts.map((acct: any, idx: number) => (
                        <div key={idx} className="diag-account-row">
                          • ID: <code>{acct.accountId}</code> | Key: <code>{acct.accountKey}</code> | Type: <strong>{acct.accountType || acct.accountDesc}</strong>
                        </div>
                      ))}
                      {diagnostics.upstreamBalance && (
                        <div className="diag-balance-row">
                          • Live Balance Fetched: Net Value: <strong>${Number(diagnostics.upstreamBalance.netAccountValue || diagnostics.upstreamBalance.computed?.realTimeValues?.totalAccountValue || 0).toFixed(2)}</strong> | Cash: <strong>${Number(diagnostics.upstreamBalance.cashAvailableForInvestment || diagnostics.upstreamBalance.computed?.cashAvailableForInvestment || 0).toFixed(2)}</strong>
                        </div>
                      )}
                    </div>
                  )}

                  <details className="diag-raw-box">
                    <summary className="diag-raw-summary">
                      🔍 View Raw Upstream Diagnostic Payload (JSON)
                    </summary>
                    <pre className="diag-raw-pre">
                      {JSON.stringify(diagnostics, null, 2)}
                    </pre>
                  </details>

                  <details className="diagnostics-drawer">
                    <summary className="diagnostics-summary">
                      ⚙️ Technical Diagnostics &amp; Audit Metadata (Agent DID &amp; Microservice Provenance)
                    </summary>
                    <div className="diagnostics-content">
                      <div><strong>Trading Agent DID:</strong> <code>{tradingAgentDid}</code></div>
                      <div><strong>Microservice Architecture:</strong> Model Context Protocol (MCP) &amp; OAuth 1.0a REST Client</div>
                      <div><strong>Attestation Mechanism:</strong> Internal W3C DID cryptographic stamping for microservice audit logs (not a third-party brokerage guarantee)</div>
                      <div><strong>Transactional Ledger:</strong> Institutional Execution Ledger (Audited Trades &amp; System Events)</div>
                    </div>
                  </details>

                  <div className="diag-modal-actions">
                    {(!diagnostics.oauthToken?.present || diagnostics.status === "auth_required" || diagnostics.status === "not_configured") && (
                      <Button
                        className="btn-oauth-connect"
                        variant="primary"
                        onClick={() => {
                          setShowDiagnosticsModal(false);
                          if (diagnostics.broker === "alpaca") {
                            setShowAlpacaSignInModal(true);
                          } else {
                            handleStartOAuth();
                          }
                        }}
                      >
                        {diagnostics.broker === "alpaca" ? "🦙 Connect / Configure Alpaca Account" : "⚡ Connect E*TRADE Account"}
                      </Button>
                    )}
                    <Button
                      className="btn-sync-diagnostics"
                      variant="secondary"
                      disabled={diagnosticsLoading}
                      onClick={() => runDiagnostics(diagnostics?.broker, diagnostics?.environment || activeEnv)}
                    >
                      {diagnosticsLoading ? "⏳ Testing..." : "🔄 Re-run Diagnostics"}
                    </Button>
                    <Button
                      className="btn-cancel-modal"
                      variant="secondary"
                      onClick={() => setShowDiagnosticsModal(false)}
                    >
                      Close
                    </Button>
                  </div>
                </>
              ) : (
                <div style={{ padding: "calc(var(--space-6) + var(--space-2))", textAlign: "center", color: "var(--color-text-muted)" }}>
                  Running diagnostics against E*TRADE upstream API...
                </div>
              )}
      </Modal>
      )}

      {showAlpacaSignInModal && (
        <Modal
          open
          size="md"
          title="🦙 Alpaca Broker Connection &amp; API Keys"
          onClose={() => setShowAlpacaSignInModal(false)}
        >
          <AlpacaSignInCard activeEnv={activeEnv} collapsedWhenConfigured={false} />
        </Modal>
      )}

      {/* Dynamic ETAPI Engine Tuning & Configuration Modal */}
      <EtapiConfigModal
        isOpen={configModalOpen}
        onClose={() => setConfigModalOpen(false)}
        activeEnv={activeEnv}
        userLogin={user?.login}
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
