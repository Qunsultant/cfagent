import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePolling } from "./usePolling";
import { useAutoRefresh } from "./autoRefresh";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import { Skeleton, Button, Select, TextInput, Badge, Card, CardHeader, Notice, Checkbox, FieldShell, Flex, Grid, PageSection, Stack } from "./components/ui";
import { apiFetch as fetch } from "./apiFetch";
import {
  getScreeningProviders,
  noScreeningProviderMessage,
  YAHOO_FINANCE_VARIANT_ID,
  providerSupportsFilter,
  resolveInitialScreeningProviderId,
  type ScreeningAssetClass,
} from "./screeningAdapters";
import { readTenantProvidersState } from "./tenantProviders";
import {
  buildPaidScreenBody,
  isBrokerUnavailableError,
  isCheckoutEmailRequiredError,
  isMonetizationWorkflowError,
  isPaymentStarted,
  mapScreenErrorFromBody,
  readMonetizationState,
  type MonetizationState,
} from "./paidScreenSubmit";
import { checkPayment, getOfferCompare, getPricing, isOfferPayloadView } from "./commercialApi";
import type { ScreenedStockItem } from "../types";
import {
  StockCriteriaPanel,
  defaultStockCriteria,
  stockCriteriaToFilter,
  stockFilterToCriteria,
  type StockCriteriaState,
} from "./StockCriteriaPanel";
import {
  parseAppliedPatternParams,
  patternQualificationLines,
  type AppliedPattern,
} from "./patternApplyHandoff";
import { ScreenerPresetManager } from "./ScreenerPresetManager";
import { CapabilityNavBar, CopilotTriggerButton, type CapabilityTabItem } from "./components/CapabilityNavBar";
import { ScreenerResultsView, type ScreenerResultData } from "./ScreenerResultsView";
import { UpgradeOffer } from "./UpgradeOffer";
import { RunDetailView, type RunDetailConfirmation } from "./RunDetailView";
import { MorningDigest } from "./MorningDigest";
import { MarketDataResearchHub, type User as ResearchUser } from "./MarketDataResearchHub";
import { PatternsPanel } from "./PatternsPanel";
import { PresetsPanel } from "./PresetsPanel";
import { buildAppliedPatternParams } from "./patternApplyHandoff";
import { stockPatternById } from "../workflows/stockPatternCatalog";
import { navigateToTab, subscribeToRouteChanges } from "./router";
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

export type StockHubTab = "stocks" | "new-screen" | "run-screen" | "research" | "patterns" | "presets";

export const STOCK_HUB_TABS: readonly StockHubTab[] = [
  "stocks",
  "new-screen",
  "run-screen",
  "research",
  "patterns",
  "presets",
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
  // Issue #3525 S3 + #4430 (S1a): the initial selection follows the
  // tenant's configured data provider (registry id -> hub variant)
  // rather than assuming one brand. The selection is tenant-resolved
  // only — no broker or variant is ever substituted as a default. A
  // tenant provider with no hub variant resolves to no selection, and
  // the correction effect below must NOT repair that to the first
  // variant — the run stays blocked with the coded
  // NO_SCREENING_PROVIDER_FOR_TENANT message.
  const tenantProvidersState = readTenantProvidersState();
  const [providerId, setProviderId] = useState(() =>
    resolveInitialScreeningProviderId(tenantProvidersState.dataProviderId, providers),
  );
  const [symbolSearch, setSymbolSearch] = useState("");
  const [stockLimit, setStockLimit] = useState("100");
  const [exchange, setExchange] = useState("ALL");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [trend, setTrend] = useState("all");
  // Issue #1496 (#940-B): stock criteria panel state. All toggles default
  // off, so existing run behavior is unchanged until the user opts in.
  const [stockCriteria, setStockCriteria] = useState<StockCriteriaState>(defaultStockCriteria);
  // Issue #2909 (G2): the pattern most recently applied from the
  // Patterns tab, when its criteria are still intact. Any manual
  // criteria edit (or a preset application) clears it, so a run
  // is only ever a "pattern run" while its criteria are exactly
  // the pattern's — an edited run is a hand-built run, and its
  // spec carries no patternRef.
  const [appliedPattern, setAppliedPattern] = useState<AppliedPattern | null>(null);
  const appliedSearchRef = useRef<string | null>(null);
  const handleCriteriaChange = useCallback((next: StockCriteriaState) => {
    setStockCriteria(next);
    setAppliedPattern(null);
  }, []);
  // Issue #2909 (G2): consume the Apply handoff on every route
  // change (the hub is retained across tab switches, so a
  // mount-only effect would miss a later Apply). A search string
  // already consumed is never re-applied, so user edits after
  // Apply are never overwritten by a stale handoff.
  useEffect(() => {
    const applyFromSearch = () => {
      if (typeof window === "undefined") return;
      const search = window.location.search;
      if (appliedSearchRef.current === search) return;
      const parsed = parseAppliedPatternParams(search);
      if (!parsed) return;
      appliedSearchRef.current = search;
      setStockCriteria(stockFilterToCriteria(parsed.filter));
      setAppliedPattern(parsed);
    };
    // The navigation that carries the handoff may predate this
    // mount (the Patterns hub navigates before StockHub mounts),
    // so consume once on mount as well as on later changes.
    applyFromSearch();
    return subscribeToRouteChanges(applyFromSearch);
  }, []);
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
  // Issue #3246: the at-limit offer, set only when a screen
  // submission answers 402. The offer component fetches the
  // server-computed offer (a read, never a paid submission) and
  // renders the fixed error string as its fallback.
  const [offer402, setOffer402] = useState<{ runRequestId?: string } | null>(null);
  // Issue #3239: paid-seam state for the manual run — the monetization
  // flag decides whether the run rides the payment workflow, and a
  // 202 payment_started parks here until the payment is verified.
  const [monetization, setMonetization] = useState<MonetizationState>("unknown");
  const [checkoutEmail, setCheckoutEmail] = useState("");
  // Issue #2373 (S1b): the remaining automatic free runs
  // (10/product/UTC-month) — the only balance surface before this
  // slice was the post-402 UpgradeOffer. Null = unknown/unread.
  const [freeRunsRemaining, setFreeRunsRemaining] = useState<number | null>(null);
  const [paymentStarted, setPaymentStarted] = useState<{
    runRequestId: string;
    workflowId?: string;
  } | null>(null);
  const [paymentCheck, setPaymentCheck] = useState("");
  const [paymentLink, setPaymentLink] = useState<string | null>(null);
  const [paymentChallenge, setPaymentChallenge] = useState<{
    network: string | null;
    amountUSD?: number;
    recipient?: string;
  } | null>(null);
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [retryPaid, setRetryPaid] = useState(false);
  // Issue #4430 (S1a): the switch-to-workflow-variant action after a broker-gate
  // 409 — the workflow-backed variant runs the screen without the gate.
  const [offerSwitchToYahoo, setOfferSwitchToYahoo] = useState(false);
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

  // Issue #3239: the monetization flag decides whether the run below
  // rides the paid seam. A failed read stays "unknown": the run keeps
  // today's sync request and a 402 maps to the payment message with a
  // retry action, instead of the client guessing the flag.
  useEffect(() => {
    let cancelled = false;
    void readMonetizationState(getPricing).then((state) => {
      if (!cancelled) setMonetization(state);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Issue #2373 (S1b): the free-run balance, read from the same
  // offer-compare endpoint the UpgradeOffer uses (a read, never a
  // paid submission). A failed or ineligible read degrades
  // silently: the balance line simply stays hidden, exactly as
  // the UpgradeOffer's additive fetch behaves. Refreshed on
  // mount while monetization is on, and after a run completes.
  const loadFreeRunsRemaining = useCallback(async () => {
    try {
      const res = await getOfferCompare("stock");
      if (!isOfferPayloadView(res)) return;
      const remaining = res.current?.freeRunsRemaining;
      setFreeRunsRemaining(typeof remaining === "number" ? remaining : null);
    } catch {
      // Degrade silently: no balance line, no error state.
    }
  }, []);

  useEffect(() => {
    if (monetization !== "on") {
      setFreeRunsRemaining(null);
      return;
    }
    void loadFreeRunsRemaining();
  }, [monetization, loadFreeRunsRemaining]);

  // Issue #329 (P1): 30 s -> 60 s, and paused entirely while the tab is hidden.
  // Issue #2481 — screener auto-load polling is gated by the
  // global auto-refresh switch; the initial load above is unaffected.
  const [autoRefresh] = useAutoRefresh();
  usePolling(loadAuto, { fastMs: 60_000, idleMs: 60_000, enabled: autoRefresh.enabled });

  // Issue #4430 (S1a): an invalid selection is cleared to no selection,
  // never repaired to the first variant — that silent substitution
  // resolved to an endpoint the tenant's configured broker does not
  // implement, and the broker gate refused the run with 409. No selection
  // blocks the run with the coded NO_SCREENING_PROVIDER_FOR_TENANT
  // message (rendered below).
  useEffect(() => {
    if (providerId !== "" && providers.length > 0 && !providers.some((provider) => provider.id === providerId)) {
      setProviderId("");
    }
  }, [providers, providerId]);

  const activeProvider = providers.find((provider) => provider.id === providerId);
  const endpoint = activeProvider?.endpointByAssetClass[assetClass];
  // Issue #4430 (S1a): true when the tenant's configured provider has
  // no hub variant — the run is blocked before any fetch, with the
  // coded message, instead of posting to a substituted endpoint.
  const noScreeningProvider = providers.length > 0 && !activeProvider;
  const switchToYahoo = () => {
    setProviderId(YAHOO_FINANCE_VARIANT_ID);
    setOfferSwitchToYahoo(false);
    setError("");
  };

  const runScreen = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await executeScreen(false);
  };

  // Issue #3239: the retry action after a 402 re-runs the same screen
  // through the payment workflow instead of re-sending a sync request
  // the seam will refuse again.
  const retryPaidScreen = async () => {
    await executeScreen(true);
  };

  const executeScreen = async (forcePaid: boolean) => {
    if (!endpoint || loading) return;
    setLoading(true);
    setError("");
    setOffer402(null);
    setRetryPaid(false);
    setOfferSwitchToYahoo(false);
    setPaymentStarted(null);
    setPaymentCheck("");
    setPaymentLink(null);
    setPaymentChallenge(null);
    setManualResult(null);
    setSummary("");
    try {
      const filters = {
        // Issue #2886 (S2): criteria first — the panel's carried-over
        // non-panel keys (extra) must never override the form's own
        // visible fields (universe, sector, price range, trend, limit,
        // search), which are spread after this and win on a clash.
        // The seven panel fields never collide with the form fields,
        // so their behaviour is unchanged by the reorder.
        ...stockCriteriaToFilter(stockCriteria),
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
        // (evaluateUniverse), on both providers. (The criteria spread
        // itself sits at the top of this literal — issue #2886 S2.)
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
      // Issue #2909 (G2): a run with intact applied-pattern
      // criteria pins the pattern at run creation — the server
      // stamps patternRef onto the spec and the canonical body,
      // and replay shows it. Unmapped guardrails ride as a run
      // qualification, never as filter fields they are not.
      // An edited criteria set clears appliedPattern above, so
      // no patternRef is sent for a hand-built run.
      if (appliedPattern) {
        requestBody.patternRef = {
          patternId: appliedPattern.patternId,
          version: appliedPattern.version,
        };
        if (appliedPattern.unmappedGuardrails.length > 0) {
          requestBody.patternQualifications = patternQualificationLines(appliedPattern.unmappedGuardrails);
        }
      }

      // Issue #3239: monetization ON rides the paid seam (async);
      // every other state sends today's sync body unchanged. A
      // forced-paid retry always rides the seam. Issue #2373
      // (S1b, gate-before-email): the checkout email is NOT
      // demanded here — the server gate decides coverage first,
      // and a covered run starts with no email at all. Only when
      // the gate says payment is actually needed does the seam
      // answer 400 checkout_email_required, and the error branch
      // below then shows the email prompt (retryPaid).
      const paidMode = forcePaid || monetization === "on";
      const checkout = checkoutEmail.trim();
      const paidBody = paidMode
        ? buildPaidScreenBody(requestBody, { monetization: "on", checkoutEmail: checkout })
        : requestBody;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify(paidBody),
      });

      // Issue #3239: parse-safe — a non-JSON error body (the #3197
      // raw-HTML class) must not become a parser message.
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        code?: string;
        status?: string;
        runRequestId?: string;
        workflowId?: string;
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

      // Issue #3239: the seam's 202 answers payment state, not rows —
      // park it for the payment notice below instead of rendering
      // an empty result.
      if (isPaymentStarted(data)) {
        setPaymentStarted({ runRequestId: data.runRequestId, workflowId: data.workflowId });
        setShardedResults([]);
        setSummary(`Payment started — run request ${data.runRequestId}. Complete the payment to start the run.`);
        return;
      }
      if (!response.ok) {
        if (isMonetizationWorkflowError(response.status, data.error)) setRetryPaid(true);
        // Issue #2373 (S1b): the gate said payment is needed and
        // no checkout contact was supplied — show the email
        // prompt (retryPaid) instead of the bare 400 text.
        if (isCheckoutEmailRequiredError(response.status, data.error, data.code)) setRetryPaid(true);
        // Issue #4430 (S1a): a broker-gate 409 offers the switch to
        // the workflow-backed variant instead of the generic 409 text.
        // mapScreenErrorFromBody reads `error` or `message`, so the
        // coded reason survives whichever field the body carries.
        if (isBrokerUnavailableError(response.status, data.error, data.code)) setOfferSwitchToYahoo(true);
        // Issue #3246: a 402 surfaces the upgrade offer (with the
        // run request id when the body carries one) instead of the
        // bare fixed string; every other error keeps the string.
        if (response.status === 402) setOffer402({ runRequestId: data.runRequestId });
        throw new Error(mapScreenErrorFromBody(response.status, data));
      }
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
      // Issue #2373 (S1b): the run spent a free run or covered
      // itself another way — refresh the balance line.
      if (monetization === "on") void loadFreeRunsRemaining();
    }
  };

  // Issue #3239: manual re-read of the payment state, mirroring the
  // checkout panel's verify button — no auto-poller over status
  // values this panel does not own.
  const handleCheckPayment = async () => {
    if (!paymentStarted) return;
    setCheckingPayment(true);
    setPaymentCheck("");
    setPaymentLink(null);
    setPaymentChallenge(null);
    try {
      const res = await checkPayment(paymentStarted.runRequestId);
      if (res.paid && res.delivered) {
        setPaymentCheck("Payment verified — the run is starting. Results will appear in Stocks history and your delivery targets.");
      } else if (res.paid && !res.delivered) {
        setPaymentCheck("Payment verified, but the run could not be woken yet. Tap Check payment status again to retry.");
      } else {
        setPaymentCheck(
          `Not paid yet (checkout state: ${res.state ?? "unknown"}).${res.paymentUrl ? " Use the payment link below, then check again." : " Complete the payment for this request, then check again."}`,
        );
      }
      setPaymentLink(res.paymentUrl ?? null);
      setPaymentChallenge(
        res.challengeFlow
          ? {
              network: res.challengeFlow.network,
              amountUSD: res.challengeFlow.amountUSD,
              recipient: res.challengeFlow.recipient,
            }
          : null,
      );
    } catch {
      setPaymentCheck("Could not read the payment status. Try again.");
    } finally {
      setCheckingPayment(false);
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
        description: "Zero-credential dual market-data feed, fundamental peer comparison.",
      },
    },
    {
      // Issue #2954: Patterns + Presets move here from ScreenersHub
      // and exist nowhere else.
      id: "patterns",
      label: "Patterns",
      icon: "🧩",
      tooltip: {
        eyebrow: "STOCK PATTERN CATALOG",
        title: "Patterns",
        description: "Stock market setup signatures from the setup catalog — read-only, apply one to a new screen.",
      },
    },
    {
      id: "presets",
      label: "Presets",
      icon: "💾",
      tooltip: {
        eyebrow: "PRESET CATALOG",
        title: "Presets",
        description: "Your saved screening configurations, plus proposed starter presets to copy to My Presets.",
      },
    },
  ];

  return (
    <PageSection>
      <CapabilityNavBar
        ariaLabel="Stock Hub capabilities"
        tabs={screenerTabs}
        activeTabId={hubTab}
        onTabChange={handleTabChange}
        rightContent={
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)" }}>
            <CopilotTriggerButton label="✨ Ask Copilot" />
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
          <Card padding="md" style={{ marginBottom: "1rem" }}>
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
                          whiteSpace: "normal",
                          flexWrap: "wrap",
                          justifyContent: "flex-start",
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
                        <Badge tone={status === "success" ? "success" : status === "partial" ? "warning" : "danger"}>
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
          </Card>
          {/* Issue #2746: One-shot manual screen moved to its own page / view (?tab=screeners&view=new-screen). */}
          <Stack gap="2">
            <Card padding="md">
              <CardHeader
                title="Run a new screen"
                subtitle="Execute a manual stock screen with custom filters, presets, and delivery targets."
                meta={
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleTabChange("new-screen")}
                  >
                    Run a new screen &rarr;
                  </Button>
                }
              />
            </Card>
            {/* Issue #2723: Provider connectivity consolidated into Platform Admin -> Data Providers. */}
            <Card padding="md" id="provider-dashboard">
              <CardHeader
                title="Provider connectivity & health"
                subtitle="Live provisioning lifecycle, capture health, and route metrics are consolidated in Platform Admin."
                meta={
                  <Button href="/?tab=platform-admin&view=data-providers" variant="secondary" size="sm">
                    View Data Providers &rarr;
                  </Button>
                }
              />
            </Card>
          </Stack>
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
          <Stack gap="2" style={{ padding: "0 var(--space-4)" }}>
            <h2 style={{ fontSize: "1.125rem", margin: "1.5rem 0 0.25rem" }}>Run a new screen</h2>
            <p style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-muted)", margin: "0 0 0.75rem" }}>
              Provider health: see the <a href="/?tab=platform-admin&view=data-providers">provider dashboard</a> in Platform Admin.
            </p>
            {appliedPattern && (
              <Notice tone={appliedPattern.unmappedGuardrails.length > 0 ? "warning" : "success"} density="compact">
                Pattern {appliedPattern.patternId} (v{appliedPattern.version}) applied — the criteria below carry its filter.
                {appliedPattern.unmappedGuardrails.length > 0 && (
                  <>
                    {" "}Qualified run: this pattern's guardrails below are NOT enforced by this screen and will be recorded
                    as a run qualification, never silently dropped:
                    <ul style={{ marginTop: "var(--space-1)", paddingLeft: "var(--space-4)" }}>
                      {patternQualificationLines(appliedPattern.unmappedGuardrails).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </>
                )}
              </Notice>
            )}
            {noScreeningProvider && (
              <Notice tone="warning" density="compact">
                {noScreeningProviderMessage(tenantProvidersState.dataProviderId)}
              </Notice>
            )}
            <form onSubmit={(event) => void runScreen(event)}>
              <Stack gap="2">
              <Grid autoFit minColumnWidth="xs" gap="2">
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
              </Grid>
              <Grid autoFit minColumnWidth="lg" gap="2">
                <ScreenerPresetManager
                  assetClass="stocks"
                  userLogin={userLogin}
                  currentFilter={stockCriteriaToFilter(stockCriteria)}
                  onApplyPreset={handleCriteriaChange}
                />
                <StockCriteriaPanel
                  criteria={stockCriteria}
                  onChange={handleCriteriaChange}
                  lastSentFilters={lastSentStockFilters}
                />
              </Grid>
              <Grid autoFit minColumnWidth="lg" gap="2">
                <Stack gap="2">
                  <h3>Delivery &amp; report</h3>
                  <p className="ui-footnote">Deliver this run like the scheduled Stock Market Screen does.</p>
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
                </Stack>
                <Stack gap="2">
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
                </Stack>
              </Grid>
              {monetization === "on" && freeRunsRemaining !== null && (
                <span className="ui-meta">{freeRunsRemaining} free runs remaining this month</span>
              )}
              {(monetization === "on" || retryPaid) && (
                <TextInput label="Checkout email"
                  type="email"
                  value={checkoutEmail}
                  onChange={(event) => setCheckoutEmail(event.target.value)}
                  placeholder="Payment contact email"
                  hint="Needed only when the run needs payment — a covered run starts without it."
                />
              )}
              <Flex gap="2">
                <Button type="submit" variant="primary" disabled={loading || !endpoint} loading={loading}>{"Run stock screen"}</Button>
              </Flex>
              </Stack>
            </form>

            {paymentStarted && (
              <Notice tone="info" density="compact" onDismiss={() => setPaymentStarted(null)}>
                Payment started — run request {paymentStarted.runRequestId}. Complete the payment to start the run.
                <Button loading={checkingPayment} onClick={() => void handleCheckPayment()}>Check payment status</Button>
                {paymentCheck && <p>{paymentCheck}</p>}
                {paymentLink && (
                  <p>
                    <a href={paymentLink} target="_blank" rel="noreferrer">
                      Complete payment
                    </a>
                  </p>
                )}
                {paymentChallenge && (
                  <p>
                    Pay {paymentChallenge.amountUSD ?? "?"} USDC on {paymentChallenge.network ?? "the configured network"}
                    {paymentChallenge.recipient ? ` to ${paymentChallenge.recipient}` : ""}.
                  </p>
                )}
              </Notice>
            )}
            {error && !offer402 && (
              <Notice tone="danger" density="compact" onDismiss={() => setError("")}>
                {error}
              </Notice>
            )}
            {error && offer402 && (
              <UpgradeOffer
                trigger="manual_402"
                family="stock"
                runRequestId={offer402.runRequestId}
                fallback={error}
              />
            )}
            {retryPaid && (
              <Button onClick={() => void retryPaidScreen()} disabled={loading}>Start payment workflow</Button>
            )}
            {offerSwitchToYahoo && (
              <Button onClick={() => switchToYahoo()} disabled={loading}>Switch to Yahoo Finance</Button>
            )}
            {manualResult && <ScreenerResultsView result={manualResult} />}
            {shardedResults.length > 0 && shardedResults.map((r) => (
              <div key={r.universe} style={{ marginTop: "1.5rem" }}>
                <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>🌐 {r.universe}</h3>
                <ScreenerResultsView result={r} />
              </div>
            ))}
            {!manualResult && summary && <Flex gap="2" justify="between" align="center" wrap><span className="ui-meta">{summary}</span><span className="ui-meta">{activeProvider?.label} · {activeEnv}</span></Flex>}

            <Card padding="md" id="provider-dashboard">
              <CardHeader
                title="Provider connectivity & health"
                subtitle="Live provisioning lifecycle, capture health, and route metrics are consolidated in Platform Admin."
                meta={
                  <Button href="/?tab=platform-admin&view=data-providers" variant="secondary" size="sm">
                    View Data Providers &rarr;
                  </Button>
                }
              />
            </Card>
          </Stack>
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

      {/* 4. Patterns Panel (Issue #2954: moved here from ScreenersHub). */}
      {visitedTabs.has("patterns") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-patterns"
          aria-labelledby="cap-tab-patterns"
          hidden={hubTab !== "patterns"}
          style={hubTab !== "patterns" ? { display: "none" } : undefined}
        >
          <PatternsPanel
            onApplyPattern={(filter, patternId) => {
              // Issue #2954 (moved here from ScreenersHub) + #2909 (G2):
              // Apply fully determines the New Screen panel — the
              // pattern rides as URL params the StockHub decodes into
              // its criteria. Unknown ids fall back to the bare tab
              // switch, never an invented pattern.
              const pattern = stockPatternById(patternId);
              if (pattern) {
                navigateToTab(
                  "stock-hub",
                  "new-screen",
                  buildAppliedPatternParams(pattern),
                );
              } else {
                handleTabChange("new-screen");
              }
            }}
          />
        </div>
      )}

      {/* 5. Presets Panel (Issue #2954: moved here from ScreenersHub). */}
      {visitedTabs.has("presets") && (
        <div
          role="tabpanel"
          id="screener-tabpanel-presets"
          aria-labelledby="cap-tab-presets"
          hidden={hubTab !== "presets"}
          style={hubTab !== "presets" ? { display: "none" } : undefined}
        >
          <PresetsPanel
            userLogin={userLogin}
            // Issue #2886 (S2): the Presets tab saves the LIVE criteria
            // (same expression as the new-screen form) — the
            // literal {} here used to save every Presets-tab preset as
            // an empty filter, which then loaded as "(0 criteria)".
            currentFilter={stockCriteriaToFilter(stockCriteria)}
            // Issue #2860 (audit F3): the presets tab Apply
            // was navigate-only — the criteria the panel
            // passes up were dropped and New Screen opened
            // with whatever draft was there. Apply through
            // handleCriteriaChange first (sets the criteria
            // and clears any applied pattern), then navigate
            // — the same order PresetsPanel already uses
            // internally (apply, then navigate).
            onApplyPreset={(criteria) => {
              handleCriteriaChange(criteria);
              handleTabChange("new-screen");
            }}
            onNavigateNewScreen={() => handleTabChange("new-screen")}
          />
        </div>
      )}


      <p className="ui-footnote">
        Provider adapters declare the instrument classes and screening endpoint they support. Add a broker, market-data API, or MCP connector by registering its capabilities and mapping its response to the common result table; unsupported instrument classes are not silently routed to an unrelated feed.
      </p>
    </PageSection>
  );
}
