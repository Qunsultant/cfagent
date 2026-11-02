import { useCallback, useEffect, useMemo, useState } from "react";
import { usePolling } from "./usePolling";
import { useAutoRefresh } from "./autoRefresh";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import { Skeleton, Button, Select, TextInput, Badge, Card, Notice, Checkbox, FieldShell } from "./components/ui";
import { apiFetch as fetch } from "./apiFetch";
import {
  getScreeningProviders,
  providerSupportsFilter,
  type ScreeningAssetClass,
} from "./screeningAdapters";
import type { ScreenedStockItem } from "../types";
import {
  StockCriteriaPanel,
  defaultStockCriteria,
  stockCriteriaToFilter,
  type StockCriteriaState,
} from "./StockCriteriaPanel";
import { ScreenerPresetManager } from "./ScreenerPresetManager";
import { CapabilityNavBar, CopilotTriggerButton, type CapabilityTabItem } from "./components/CapabilityNavBar";
import { ScreenerResultsView, type ScreenerResultData } from "./ScreenerResultsView";
import { RunDetailView, type RunDetailConfirmation } from "./RunDetailView";
import { MorningDigest } from "./MorningDigest";
import { MarketDataResearchHub, type User as ResearchUser } from "./MarketDataResearchHub";
import { navigateToTab } from "./router";
import type { TradeOrderContext } from "./trading/tradeOrderContext";
import "./optionsResearch.css";

/** Stock Hub (issue #2896): the stock-specific copy of the screener
 *  hub — exactly three tabs. Stocks (autonomous run history + run
 *  detail) and Run a new screen (the manual stock screen form) are
 *  copied from the old hub; Market Research renders
 *  MarketDataResearchHub. Everything else stayed on the old hub. */
/**
 * Issue #2545: the Stocks one-shot form's delivery selection — the
 * scheduled "Stock Market Screen" job's delivery fields, named
 * exactly as the schedule payload names them (deliveryFields in
 * src/trading/screeningSchemas.ts), plus the report flag.
 */
export interface StockRunDeliverySelection {
  pushToSlack: boolean;
  slackChannel: string;
  emailTo: string;
  webhookUrl: string;
  generatePdf: boolean;
}

/**
 * Issue #2545: the one-shot run request body — the screen filters
 * plus the delivery envelope, built with the schedule payload
 * builders' conventions: slackChannel rides only when Slack push is
 * on, blank recipients are omitted (never sent as empty strings),
 * recipients are trimmed. The server splits the envelope out of the
 * engine filter (parseStockScreenRequest) and stamps it onto the
 * run's delivery outcome, so a manual run with delivery options
 * produces the same artifacts as the scheduled run.
 */
export function buildStockRunRequestBody(
  filters: Record<string, unknown>,
  delivery: StockRunDeliverySelection,
): Record<string, unknown> {
  return {
    ...filters,
    pushToSlack: delivery.pushToSlack,
    ...(delivery.pushToSlack && delivery.slackChannel.trim()
      ? { slackChannel: delivery.slackChannel.trim() }
      : {}),
    ...(delivery.emailTo.trim() ? { emailTo: delivery.emailTo.trim() } : {}),
    ...(delivery.webhookUrl.trim() ? { webhookUrl: delivery.webhookUrl.trim() } : {}),
    generatePdf: delivery.generatePdf,
  };
}

export type StockHubTab = "stocks" | "new-screen" | "run-screen" | "research";

export const STOCK_HUB_TABS: readonly StockHubTab[] = [
  "stocks",
  "new-screen",
  "run-screen",
  "research",
] as const;

export function isValidStockHubTab(tab: unknown): tab is StockHubTab {
  return typeof tab === "string" && (STOCK_HUB_TABS as readonly string[]).includes(tab);
}

interface StockHubProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
  user?: ResearchUser;
  onStocksLoaded?: (rows: ScreenedStockItem[]) => void;
  /** S8: the trade-preview handoff threaded into the folded panels —
   *  the Trading Hub passes its order-ticket handler, exactly as it
   *  did when the panels were its own subtabs. */
  onPreviewTrade?: (ctx: TradeOrderContext) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  onJobStateChange?: (state: "idle" | "running" | "ready") => void;
  /** S8: the tab to open on — the Trading Hub's screening redirects
   *  deep-link into the hub with the folded surface's tab. */
  initialTab?: StockHubTab;
  onTabChange?: (tab: StockHubTab) => void;
}


// Issue #212: a persisted autonomous screener run.
// Issue #253: allStocks carries the full scanned set (not just standouts).
// Issue #261: trigger identifies the source for the unified UI.
// Issue #125: universe + partial mirror ScreenerRunResult so retained runs
// can be listed with their scope and status (see screenRunStatus).
interface ScreenRun {
  timestamp: string;
  pdfKey?: string;
  reportUrl?: string;
  pdfStatus?: "generated" | "failed" | "skipped";
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed" | "skipped";
  xlsxError?: string;
  trigger?: "manual" | "scheduled";
  universe?: string;
  sector: string;
  success: boolean;
  totalScanned: number;
  matchedCount: number;
  partial?: {
    quotedCount: number;
    requestedCount: number;
    failedSymbols: string[];
    failureReasons: Record<string, number>;
  };
  opportunities: Array<{
    symbol: string;
    companyName: string;
    signal: string;
    momentumScore: number;
    lastPrice: number;
    changePercent: number;
  }>;
  allStocks?: Array<{
    symbol: string;
    companyName: string;
    signal: string;
    momentumScore: number;
    lastPrice: number;
    changePercent: number;
    rsi14: number | null;
    source: string;
  }>;
  error?: string;
}

// Issue #125: run status, derived from the fields ScreenerRunResult
// actually carries — a failed run has success:false (+ error); a partial
// run is a success that ran on an incomplete quote set (#462 qualification);
// anything else is a clean success. Quiet runs (success, zero standouts)
// are ordinary successes — they are history, not alerts.
export type ScreenRunStatus = "success" | "partial" | "failed";

export function screenRunStatus(run: Pick<ScreenRun, "success" | "partial">): ScreenRunStatus {
  if (!run.success) return "failed";
  if (run.partial) return "partial";
  return "success";
}

export const SCREEN_RUN_STATUS_LABELS: Record<ScreenRunStatus, string> = {
  success: "Success",
  partial: "Partial",
  failed: "Failed",
};

// Issue #125: the viewed run is tracked by timestamp so a polling refresh
// that prepends a newer run never silently re-points the view at a
// different run; a selection that has aged out of the retained history
// (or no selection yet) falls back to the latest run.
export function resolveSelectedRun<T extends { timestamp: string }>(
  runs: T[],
  selectedTimestamp: string | null,
): T | undefined {
  if (selectedTimestamp) {
    const found = runs.find((run) => run.timestamp === selectedTimestamp);
    if (found) return found;
  }
  return runs[0];
}

function numberFilter(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}

export function StockHub({
  activeEnv,
  userLogin,
  user,
  onStocksLoaded,
  onPreviewTrade,
  onSendPrompt,
  onJobStateChange,
  initialTab,
  onTabChange,
}: StockHubProps) {
  // Tabbed browsing via the shared hook (S2, #2027): canonical param is
  // `view`; `screenerTab` (and `tab`) stay as read-only legacy aliases so
  // existing bookmarks and hash links keep resolving.
  const { activeTab: hubTab, visitedTabs, handleTabChange } =
    useUrlSyncedTabs<StockHubTab>({
      param: "view",
      aliases: ["screenerTab", "tab"],
      isValid: isValidStockHubTab,
      defaultTab: "stocks",
      initialTab: initialTab ?? null,
      onTabChange,
    });

  // Stock Hub serves stocks only; every tab here screens stocks.
  const assetClass: ScreeningAssetClass = "stocks";
  const providers = useMemo(() => getScreeningProviders(assetClass), [assetClass]);
  const [providerId, setProviderId] = useState("etrade");
  const [symbolSearch, setSymbolSearch] = useState("");
  const [stockLimit, setStockLimit] = useState("100");
  const [exchange, setExchange] = useState("ALL");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [trend, setTrend] = useState("all");
  // Issue #1496 (#940-B): stock criteria panel state. All toggles default
  // off, so existing run behavior is unchanged until the user opts in.
  const [stockCriteria, setStockCriteria] = useState<StockCriteriaState>(defaultStockCriteria);
  // Issue #2545: delivery/report selection for the one-shot run — the
  // scheduled stock screen's delivery defaults (Slack push on, PDF
  // report attached), so the form opens at scheduled-run parity.
  const [deliveryPushToSlack, setDeliveryPushToSlack] = useState(true);
  const [deliverySlackChannel, setDeliverySlackChannel] = useState("");
  const [deliveryEmailTo, setDeliveryEmailTo] = useState("");
  const [deliveryWebhookUrl, setDeliveryWebhookUrl] = useState("");
  const [deliveryGeneratePdf, setDeliveryGeneratePdf] = useState(true);
  // Run request object sent with the last stock run, for the panel's view.
  // (The request body, not just the filter: it also carries universe and
  // minScore, and exchange as a plain string — hence Record, not
  // StockScreenerFilter. The panel reads only its seven managed keys.)
  const [lastSentStockFilters, setLastSentStockFilters] = useState<Record<string, unknown> | null>(null);
  // Issue #261: manual run result for the unified ScreenerResultsView.
  const [universe, setUniverse] = useState("TECH");
  const [sector, setSector] = useState("ALL");
  const [minScore, setMinScore] = useState("");
  const [shardedResults, setShardedResults] = useState<any[]>([]);
  const [manualResult, setManualResult] = useState<ScreenerResultData | null>(null);
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Issue #212: latest screener runs (retained history; each run carries
  // its own trigger — manual runs are not scheduled runs).
  const [autoRuns, setAutoRuns] = useState<ScreenRun[]>([]);
  const [autoLoading, setAutoLoading] = useState(true);
  // Issue #125: which retained run the results view shows (null = latest).
  const [selectedAutoTs, setSelectedAutoTs] = useState<string | null>(null);
  const selectedAutoRun = resolveSelectedRun(autoRuns, selectedAutoTs) ?? autoRuns[0];

  // Issue #1326: delivery confirmations for the selected run, joined
  // exactly server-side via its canonical row (run_id =
  // `screener:<timestamp>`). Re-fetched whenever the selection changes.
  const [runConfirmations, setRunConfirmations] = useState<RunDetailConfirmation[]>([]);
  const [runConfirmationsLoading, setRunConfirmationsLoading] = useState(false);
  useEffect(() => {
    const ts = selectedAutoRun?.timestamp;
    if (!ts) {
      setRunConfirmations([]);
      return;
    }
    let cancelled = false;
    setRunConfirmationsLoading(true);
    fetch(`/api/trading/reports/confirmations?runId=${encodeURIComponent(`screener:${ts}`)}`)
      .then((res) => (res.ok ? res.json() : { confirmations: [] }))
      .then((data: unknown) => {
        const list = (data as { confirmations?: unknown } | null)?.confirmations;
        if (!cancelled) setRunConfirmations(Array.isArray(list) ? (list as RunDetailConfirmation[]) : []);
      })
      .catch(() => {
        if (!cancelled) setRunConfirmations([]);
      })
      .finally(() => {
        if (!cancelled) setRunConfirmationsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAutoRun?.timestamp]);

  const loadAuto = useCallback(async () => {
    try {
      const res = await fetch("/api/screener/latest");
      if (!res.ok) return;
      const data = (await res.json()) as { runs?: unknown };
      if (Array.isArray(data.runs)) setAutoRuns(data.runs as ScreenRun[]);
    } catch {
      // Non-critical: panel stays empty.
    } finally {
      setAutoLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAuto();
  }, [loadAuto]);

  // Issue #329 (P1): 30 s -> 60 s, and paused entirely while the tab is hidden.
  // Issue #2481 — screener auto-load polling is gated by the
  // global auto-refresh switch; the initial load above is unaffected.
  const [autoRefresh] = useAutoRefresh();
  usePolling(loadAuto, { fastMs: 60_000, idleMs: 60_000, enabled: autoRefresh.enabled });

  useEffect(() => {
    if (providers.length > 0 && !providers.some((provider) => provider.id === providerId)) {
      setProviderId(providers[0]?.id || "");
    }
  }, [providers, providerId]);

  const activeProvider = providers.find((provider) => provider.id === providerId);
  const endpoint = activeProvider?.endpointByAssetClass[assetClass];

  const runScreen = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!endpoint || loading) return;
    setLoading(true);
    setError("");
    setManualResult(null);
    setSummary("");
    try {
      const filters = {
        universe,
        ...(sector && sector !== "ALL" ? { sector } : {}),
        ...(minScore.trim() !== "" ? { minScore: Number(minScore) } : {}),
        ...(providerSupportsFilter(activeProvider, assetClass, "search") ? { search: symbolSearch.trim() || undefined } : {}),
        ...(providerSupportsFilter(activeProvider, assetClass, "limit") ? { limit: numberFilter(stockLimit) } : {}),
        ...(providerSupportsFilter(activeProvider, assetClass, "exchange") ? { exchange } : {}),
        ...(providerSupportsFilter(activeProvider, assetClass, "price-range") ? {
          minPrice: numberFilter(minPrice),
          maxPrice: numberFilter(maxPrice),
        } : {}),
        ...(providerSupportsFilter(activeProvider, assetClass, "trend") ? {
          gainersOnly: trend === "gainers" || undefined,
          losersOnly: trend === "losers" || undefined,
        } : {}),
        // Issue #1496 (#940-B): enabled panel criteria only; a toggled-off
        // criterion is absent, never sent as a null/zero the engine would
        // misread. All seven fields genuinely filter on the manual path
        // (evaluateUniverse), on both providers.
        ...stockCriteriaToFilter(stockCriteria),
      };
      setLastSentStockFilters(filters);

      // Issue #2545: the delivery envelope rides the same request —
      // the server splits it out of the engine filter and delivers
      // through the scheduled run's follow-up path.
      const requestBody = buildStockRunRequestBody(filters, {
        pushToSlack: deliveryPushToSlack,
        slackChannel: deliverySlackChannel,
        emailTo: deliveryEmailTo,
        webhookUrl: deliveryWebhookUrl,
        generatePdf: deliveryGeneratePdf,
      });

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify(requestBody),
      });

      const data = (await response.json()) as {
        error?: string;
        stocks?: ScreenedStockItem[];
        opportunities?: Array<{
          symbol: string;
          companyName: string;
          signal: string;
          momentumScore: number;
          lastPrice: number;
          changePercent: number;
        }>;
        filterSummary?: string;
        discoveryMessage?: string;
        validationError?: string;
        totalScanned?: number;
        matchedCount?: number;
        discovery?: {
          mode?: string;
          candidateCount?: number;
          listingCount?: number;
          sourceCounts?: Record<string, number>;
          message?: string;
        };
        scannedAt?: string;
        pdfKey?: string;
        reportUrl?: string;
      };

      if (!response.ok) throw new Error(data.error || `Screening request failed [HTTP ${response.status}].`);
      if (data.validationError) throw new Error(data.validationError);

      // Issue #261: manual results feed the unified ScreenerResultsView.
      // Issue #270: sharded ALL results render per-universe sections.
      const mapRow = (s: any) => ({
        symbol: s.symbol,
        companyName: s.companyName || s.symbol,
        signal: s.signal || "unknown",
        momentumScore: s.momentumScore ?? 0,
        lastPrice: s.lastPrice ?? 0,
        changePercent: s.changePercent ?? 0,
        rsi14: s.rsi14 ?? null,
        source: s.source || "E*TRADE live",
        indicators: s.indicators,
        factorGrades: s.factorGrades,
        technicals: s.technicals,
      });
      if ((data as any).sharded) {
        const shards = (data as any).universes || [];
        setShardedResults(
          shards.map((u: any) => ({
            universe: u.universe,
            timestamp: u.scannedAt || new Date().toISOString(),
            pdfKey: u.pdfKey,
            reportUrl: u.reportUrl,
            trigger: "manual" as const,
            sector: "Technology",
            success: u.success,
            totalScanned: u.totalScanned ?? 0,
            matchedCount: u.matchedCount ?? 0,
            opportunities: (u.opportunities ?? []).map(mapRow),
            allStocks: (u.stocks ?? []).map(mapRow),
            discoveryMessage: u.discoveryMessage,
          }))
        );
        setManualResult(null);
        setSummary(`${shards.length} universes screened in parallel`);
        return;
      }
      setShardedResults([]);
      const stockResults = data.stocks || [];
      setManualResult({
        timestamp: data.scannedAt || new Date().toISOString(),
        pdfKey: data.pdfKey,
        pdfStatus: (data as any).pdfStatus,
        pdfError: (data as any).pdfError,
        reportUrl: data.reportUrl,
        xlsxKey: (data as any).xlsxKey,
        xlsxStatus: (data as any).xlsxStatus,
        xlsxUrl: (data as any).xlsxUrl,
        quoteTrace: (data as any).quoteTrace,
        trigger: "manual",
        sector: "Technology",
        success: true,
        totalScanned: data.totalScanned ?? stockResults.length,
        matchedCount: data.matchedCount ?? stockResults.length,
        opportunities: (data.opportunities ?? []).map(mapRow),
        allStocks: stockResults.map(mapRow),
        discoveryMessage: data.discoveryMessage,
      });
      setSummary(data.filterSummary || `${data.totalScanned ?? 0} scanned · ${data.matchedCount ?? stockResults.length} matched`);
      onStocksLoaded?.(stockResults);
      void loadAuto();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Screening request failed.");
    } finally {
      setLoading(false);
    }
  };

  const screenerTabs: CapabilityTabItem[] = [
    {
      id: "stocks",
      label: "Stocks",
      icon: "📈",
      badge: "LIVE",
      badgeType: "live",
      tooltip: {
        eyebrow: "EQUITIES SCREENING",
        title: "Stock Universe Screener",
        description: "Screen common stocks and ETFs by price, volume, exchange, and trend.",
      },
    },
    {
      id: "new-screen",
      label: "Run a New Screen",
      icon: "⚡",
      badge: "New",
      badgeType: "live",
      tooltip: {
        eyebrow: "MANUAL STOCK SCREEN",
        title: "Run a New Screen",
        description: "Execute a manual stock screen with custom filters, presets, and delivery targets.",
      },
    },
    {
      id: "research",
      label: "Market Research",
      icon: "🔍",
      badge: "Feed",
      badgeType: "cyan",
      tooltip: {
        eyebrow: "MARKET RESEARCH",
        title: "Market Research",
        description: "Zero-credential Yahoo Finance and Alpaca dual feed, fundamental peer comparison.",
      },
    },
  ];

  return (
    <section className="trading-section screeners-hub">
      <CapabilityNavBar
        ariaLabel="Stock Hub capabilities"
        tabs={screenerTabs}
        activeTabId={hubTab}
        onTabChange={handleTabChange}
        rightContent={
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
            <CopilotTriggerButton label="✨ Ask Copilot" />
            {/* Issue #2438: the header shows the selected run's identity
                or nothing — never manual-run leftovers ("Last scan" /
                "N matched" described a manual run the user may never
                have made, above autonomous content). */}
            {hubTab === "stocks" && selectedAutoRun && (
              <span>
                Viewing:{" "}
                <strong style={{ color: "var(--color-text-primary)" }}>
                  {(selectedAutoRun.universe || "nasdaq100").toUpperCase()} ·{" "}
                  {new Date(selectedAutoRun.timestamp).toLocaleString()} ·{" "}
                  {SCREEN_RUN_STATUS_LABELS[screenRunStatus(selectedAutoRun)]}
                </strong>
              </span>
            )}
          </div>
        }
      />

      {/* Tabbed Browsing Panels — reference multi-tab state retention:
          Panels mount on first visit and stay preserved in the DOM with role="tabpanel",
          id, and aria-labelledby linking back to their corresponding tab button. */}

      {/* 1. Stocks Screener Panel */}
      {visitedTabs.has("stocks") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-stocks"
          aria-labelledby="cap-tab-stocks"
          hidden={hubTab !== "stocks"}
          style={hubTab !== "stocks" ? { display: "none" } : undefined}
        >
          {/* Issue #1328: morning digest above the runs panel — one briefing
              of last night's runs, linking each entry to its run detail
              (child 3) and held items to the pending-review queue (child 1).
              Issue #2438: the detail card's back-to-digest control scrolls
              back here. */}
          <div id="morning-digest" style={{ marginBottom: "1rem" }}>
            <MorningDigest
              runs={autoRuns}
              onSelectRun={(timestamp) => {
                setSelectedAutoTs(timestamp);
                if (typeof document !== "undefined") {
                  document.getElementById("selected-run-detail")?.scrollIntoView?.({ block: "start" });
                }
              }}
              onViewQueue={() => navigateToTab("screeners", "reports")}
            />
          </div>
          {/* Issue #212: autonomous screener panel — retained run history. */}
          <div className="screener-feed-callout" style={{ marginBottom: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "0.5rem", flexWrap: "wrap" }}>
              <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>🤖 Autonomous Screen</span>
              <span style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
                Retained run history from the screener agent — newest first, up to 20 runs. Each run is labeled with its real trigger. Panel refreshes every 60 seconds.
              </span>
            </div>
            {autoLoading ? (
              <div role="status" aria-label="Loading latest autonomous run">
                <div style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>Loading latest autonomous run…</div>
                <Skeleton lines={3} />
              </div>
            ) : autoRuns.length === 0 ? (
              <div style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)" }}>
                No screener runs recorded yet. Runs appear here when a manual or scheduled screen completes.
              </div>
            ) : (
              <>
                {/* Issue #2075: what the counts mean — scanned is symbols
                    evaluated, matched is passed the screen's filters,
                    standout is flagged opportunities. */}
                <div style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)", marginBottom: "0.75rem" }}>
                  Scanned = symbols evaluated · Matched = passed the screen's filters · Standout = flagged opportunities
                </div>
                {/* Issue #125: per-run history — every retained run is
                    selectable (newest first), across universes. Selecting a
                    run swaps the results view + PDF + exports below to that
                    run. Issue #2438: this compact list IS the history —
                    the #830 grouped universe cards duplicated it and are
                    gone. */}
                <div
                  aria-label="Screener run history"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-1-5)",
                    marginBottom: "0.75rem",
                  }}
                >
                  {autoRuns.map((run) => {
                    const status = screenRunStatus(run);
                    const isSelected = selectedAutoRun?.timestamp === run.timestamp;
                    const oppCount = run.opportunities?.length ?? 0;
                    return (
                      <Button
                        key={run.timestamp}
                        type="button"
                        className="screener-run-item"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedAutoTs(run.timestamp)}
                        style={{
                          textAlign: "left",
                          padding: "var(--space-2) var(--space-3)",
                          borderRadius: "6px",
                          border: isSelected
                            ? "2px solid var(--color-accent)"
                            : "1px solid var(--color-border-subtle)",
                          background: "var(--color-surface)",
                          cursor: "pointer",
                          fontSize: "var(--font-size-body-sm)",
                          color: "var(--color-text-primary)",
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>
                          {new Date(run.timestamp).toLocaleString()}
                        </span>
                        {" · "}
                        {(run.universe || "nasdaq100").toUpperCase()}
                        {run.sector && run.sector !== "ALL" ? ` · ${run.sector} sector` : ""}
                        {" · "}
                        {run.trigger === "manual" ? "Manual" : "Scheduled"}
                        {" · "}
                        {run.totalScanned ?? 0} scanned · {run.matchedCount ?? 0} matched · {oppCount} standout
                        {" "}
                        <Badge tone={status === "success" ? "success" : status === "partial" ? "warning" : "danger"} className="screener-run-status">
                          {SCREEN_RUN_STATUS_LABELS[status]}
                        </Badge>
                        {" · "}
                        <span>{isSelected ? "Viewing" : "View"}</span>
                      </Button>
                    );
                  })}
                </div>
                {/* Issue #2438: ONE detail card with a single heading
                    hierarchy — outcome Badge, trigger, counts, tables,
                    artifacts, delivery — instead of two competing
                    cards. RunDetailView renders bare (artifacts +
                    delivery only); this card carries the heading and
                    the outcome row. */}
                {selectedAutoRun && (
                  <div
                    id="selected-run-detail"
                    aria-label="Selected job run data"
                    style={{ marginBottom: "0.75rem" }}
                  >
                    <Card padding="md">
                      <h3 style={{ margin: "0 0 0.5rem" }}>Run detail</h3>
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                        <Badge
                          tone={
                            screenRunStatus(selectedAutoRun) === "success"
                              ? "success"
                              : screenRunStatus(selectedAutoRun) === "partial"
                              ? "warning"
                              : "danger"
                          }
                        >
                          {SCREEN_RUN_STATUS_LABELS[screenRunStatus(selectedAutoRun)]}
                        </Badge>
                        <span>
                          {selectedAutoRun.matchedCount} matched of {selectedAutoRun.totalScanned} scanned
                        </span>
                        <span style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)" }}>
                          {(selectedAutoRun.universe || "nasdaq100").toUpperCase()}
                          {selectedAutoRun.sector && selectedAutoRun.sector !== "ALL" ? ` · ${selectedAutoRun.sector}` : ""}
                          {" · "}
                          {selectedAutoRun.trigger === "manual" ? "Manual" : "Scheduled"} ·{" "}
                          {new Date(selectedAutoRun.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <div style={{ marginTop: "0.75rem" }}>
                        <ScreenerResultsView
                          result={{ ...selectedAutoRun, trigger: selectedAutoRun.trigger ?? "scheduled" }}
                        />
                      </div>
                      <div style={{ marginTop: "0.75rem" }}>
                        <RunDetailView
                          run={selectedAutoRun}
                          confirmations={runConfirmations}
                          confirmationsLoading={runConfirmationsLoading}
                          chrome="bare"
                          replayRunId={`screener:${selectedAutoRun.timestamp}`}
                        />
                      </div>
                      <div style={{ marginTop: "0.75rem" }}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            if (typeof document !== "undefined") {
                              document.getElementById("morning-digest")?.scrollIntoView?.({ block: "start" });
                            }
                          }}
                        >
                          Back to digest
                        </Button>
                      </div>
                    </Card>
                  </div>
                )}
              </>
            )}
          </div>
          {/* Issue #2746: One-shot manual screen moved to its own page / view (?tab=screeners&view=new-screen). */}
          <div className="provider-dashboard-callout">
            <Card padding="md">
              <div className="provider-callout-inner">
                <div>
                  <h3 className="provider-callout-title">Run a new screen</h3>
                  <p className="provider-callout-desc">
                    Execute a manual stock screen with custom filters, presets, and delivery targets.
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => handleTabChange("new-screen")}
                >
                  Run a new screen &rarr;
                </Button>
              </div>
            </Card>
          </div>
          {/* Issue #2723: Provider connectivity consolidated into Platform Admin -> Data Providers. */}
          <div id="provider-dashboard" className="provider-dashboard-callout">
            <Card padding="md">
              <div className="provider-callout-inner">
                <div>
                  <h4 className="provider-callout-title">Provider connectivity &amp; health</h4>
                  <p className="provider-callout-desc">
                    Live provisioning lifecycle, capture health, and route metrics are consolidated in Platform Admin.
                  </p>
                </div>
                <a
                  href="/?tab=platform-admin&view=data-providers"
                  className="ui-btn ui-btn-secondary ui-btn-sm provider-callout-link"
                >
                  View Data Providers &rarr;
                </a>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* 1b. Run a New Screen Panel (Issue #2746) */}
      {(visitedTabs.has("new-screen") || visitedTabs.has("run-screen")) && (
        <div
          role="tabpanel"
          id="screener-tabpanel-new-screen"
          aria-labelledby="cap-tab-new-screen"
          hidden={hubTab !== "new-screen" && hubTab !== "run-screen"}
          style={hubTab !== "new-screen" && hubTab !== "run-screen" ? { display: "none" } : undefined}
        >
          <div style={{ padding: "0 var(--space-4)" }}>
            <h2 style={{ fontSize: "1.125rem", margin: "1.5rem 0 0.25rem" }}>Run a new screen</h2>
            <p style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)", margin: "0 0 0.75rem" }}>
              Provider health: see the <a href="/?tab=platform-admin&view=data-providers">provider dashboard</a> in Platform Admin.
            </p>
            <form className="options-request-form screeners-filter-form" onSubmit={(event) => void runScreen(event)}>
              <Select label="Data provider / API" value={providerId} onChange={(event) => setProviderId(event.target.value)}>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
              </Select>

              <TextInput label="Ticker or company search"
                value={symbolSearch}
                onChange={(event) => setSymbolSearch(event.target.value)}
                placeholder="Optional; e.g. NVDA, AAPL"
                disabled={!providerSupportsFilter(activeProvider, assetClass, "search")}
                hint={providerSupportsFilter(activeProvider, assetClass, "search") ? undefined : `Not supported by ${activeProvider?.label ?? "this provider"}`}
              />
              <Select label="Exchange" value={exchange} onChange={(event) => setExchange(event.target.value)}
                disabled={!providerSupportsFilter(activeProvider, assetClass, "exchange")}
                hint={providerSupportsFilter(activeProvider, assetClass, "exchange") ? undefined : `Not supported by ${activeProvider?.label ?? "this provider"}`}>
                <option value="ALL">All U.S. listings</option>
                <option value="NASDAQ">Nasdaq</option>
                <option value="NYSE">NYSE</option>
                <option value="AMEX">AMEX</option>
              </Select>
              <TextInput label="Min price" type="number" min="0" step="0.01" value={minPrice} onChange={(event) => setMinPrice(event.target.value)}
                disabled={!providerSupportsFilter(activeProvider, assetClass, "price-range")}
                hint={providerSupportsFilter(activeProvider, assetClass, "price-range") ? undefined : `Not supported by ${activeProvider?.label ?? "this provider"}`} />
              <TextInput label="Max price" type="number" min="0" step="0.01" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)}
                disabled={!providerSupportsFilter(activeProvider, assetClass, "price-range")}
                hint={providerSupportsFilter(activeProvider, assetClass, "price-range") ? undefined : `Not supported by ${activeProvider?.label ?? "this provider"}`} />
              <Select label="Universe" value={universe} onChange={(event) => setUniverse(event.target.value)} title="Index/ETF universe to screen">
                <option value="TECH">Technology (discovery)</option>
                <option value="NASDAQ100">Nasdaq-100</option>
                <option value="SP100">S&P 100</option>
                <option value="SP500">S&P 500</option>
                <option value="RUSSELL2000">Russell 2000</option>
                <option value="ETF">ETFs</option>
                <option value="LEV_ETF">Leveraged ETFs</option>
                <option value="ALL">All (auto-sharded, parallel)</option>
              </Select>
              <Select label="Sector" value={sector} onChange={(event) => setSector(event.target.value)} title="Industry sector filter">
                <option value="ALL">All Sectors</option>
                <option value="Technology">Technology</option>
                <option value="Semiconductors">Semiconductors</option>
                <option value="Financial">Financial / Banking</option>
                <option value="Healthcare">Healthcare / Biotech</option>
                <option value="Consumer Discretionary">Consumer Discretionary</option>
                <option value="Communication Services">Communication Services</option>
                <option value="Energy">Energy</option>
                <option value="Industrials">Industrials</option>
              </Select>
              <TextInput label="Min Score (0–100)"
                type="number"
                min="0"
                max="100"
                value={minScore}
                onChange={(event) => setMinScore(event.target.value)}
                placeholder="Optional; e.g. 50"
              />
              <Select label="Daily trend" value={trend} onChange={(event) => setTrend(event.target.value)}
                disabled={!providerSupportsFilter(activeProvider, assetClass, "trend")}
                hint={providerSupportsFilter(activeProvider, assetClass, "trend") ? undefined : `Not supported by ${activeProvider?.label ?? "this provider"}`}>
                <option value="all">All</option>
                <option value="gainers">Gainers</option>
                <option value="losers">Losers</option>
              </Select>
              <TextInput label="Max results" type="number" min="1" value={stockLimit} onChange={(event) => setStockLimit(event.target.value)}
                disabled={!providerSupportsFilter(activeProvider, assetClass, "limit")}
                hint={providerSupportsFilter(activeProvider, assetClass, "limit") ? undefined : `Not supported by ${activeProvider?.label ?? "this provider"}`} />
              <div className="screener-criteria-presets-deck">
                <ScreenerPresetManager
                  assetClass="stocks"
                  userLogin={userLogin}
                  currentFilter={stockCriteriaToFilter(stockCriteria)}
                  onApplyPreset={setStockCriteria}
                />
                <StockCriteriaPanel
                  criteria={stockCriteria}
                  onChange={setStockCriteria}
                  lastSentFilters={lastSentStockFilters}
                />
              </div>
              <div className="screener-criteria-presets-deck">
                <div>
                  <h3>Delivery &amp; report</h3>
                  <p>Deliver this run like the scheduled Stock Market Screen does.</p>
                  <FieldShell id="stock-delivery-slack-push" label="Slack push">
                    <Checkbox id="stock-delivery-slack-push" checked={deliveryPushToSlack} onChange={(event) => setDeliveryPushToSlack(event.target.checked)} />
                  </FieldShell>
                  {deliveryPushToSlack && (
                    <TextInput label="Slack channel"
                      value={deliverySlackChannel}
                      onChange={(event) => setDeliverySlackChannel(event.target.value)}
                      placeholder="Optional; e.g. #trading-desk (blank = the configured channel)"
                    />
                  )}
                </div>
                <div>
                  <TextInput label="Email recipients"
                    type="email"
                    value={deliveryEmailTo}
                    onChange={(event) => setDeliveryEmailTo(event.target.value)}
                    placeholder="Optional; e.g. trader@firm.com"
                  />
                  <TextInput label="Webhook URL"
                    type="url"
                    value={deliveryWebhookUrl}
                    onChange={(event) => setDeliveryWebhookUrl(event.target.value)}
                    placeholder="Optional; https://…"
                  />
                  <FieldShell id="stock-delivery-pdf" label="PDF report" hint="Attach the run's generated PDF report to deliveries">
                    <Checkbox id="stock-delivery-pdf" checked={deliveryGeneratePdf} onChange={(event) => setDeliveryGeneratePdf(event.target.checked)} />
                  </FieldShell>
                </div>
              </div>
              <div className="options-form-footer">
                <Button type="submit" variant="primary" disabled={loading || !endpoint} loading={loading}>{"Run stock screen"}</Button>
              </div>
            </form>

            {error && (
              <Notice tone="danger" density="compact" onDismiss={() => setError("")}>
                {error}
              </Notice>
            )}
            {manualResult && <ScreenerResultsView result={manualResult} />}
            {shardedResults.length > 0 && shardedResults.map((r) => (
              <div key={r.universe} style={{ marginTop: "1.5rem" }}>
                <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>🌐 {r.universe}</h3>
                <ScreenerResultsView result={r} />
              </div>
            ))}
            {!manualResult && summary && <div className="screener-results-header"><span>{summary}</span><span>{activeProvider?.label} · {activeEnv}</span></div>}

            <div className="provider-dashboard-callout">
              <Card padding="md">
                <div className="provider-callout-inner">
                  <div>
                    <h4 className="provider-callout-title">Provider connectivity &amp; health</h4>
                    <p className="provider-callout-desc">
                      Live provisioning lifecycle, capture health, and route metrics are consolidated in Platform Admin.
                    </p>
                  </div>
                  <a
                    href="/?tab=platform-admin&view=data-providers"
                    className="ui-btn ui-btn-secondary ui-btn-sm provider-callout-link"
                  >
                    View Data Providers &rarr;
                  </a>
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}

      {/* 3. Market Research Panel */}
      {visitedTabs.has("research") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-research"
          aria-labelledby="cap-tab-research"
          hidden={hubTab !== "research"}
          style={hubTab !== "research" ? { display: "none" } : undefined}
        >
          <MarketDataResearchHub
            user={user}
            onSendPrompt={onSendPrompt}
            onTradeSymbol={() => navigateToTab("order")}
          />
        </div>
      )}


      <p className="options-assumptions">
        Provider adapters declare the instrument classes and screening endpoint they support. Add a broker, market-data API, or MCP connector by registering its capabilities and mapping its response to the common result table; unsupported instrument classes are not silently routed to an unrelated feed.
      </p>
    </section>
  );
}
