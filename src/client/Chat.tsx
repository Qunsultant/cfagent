import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { startPolling } from "./polling";
import { getPollingConfig } from "./pollingConfig";
import { useAutoRefresh } from "./autoRefresh";
import { useTenantProviders, labelForBroker, brokerUnavailableNotice, isBrokerId } from "./tenantProviders";
import { BRAND } from "./branding";
import { apiFetch as fetch } from "./apiFetch";
import { McpApiExplorer } from "./McpApiExplorer";
import { GoogleAdUnit } from "./GoogleAdUnit";
import { TradeHub } from "./TradeHub";
import { ErrorBoundary } from "./ErrorBoundary";
import { FirstRunGate } from "./FirstRunGate";
import { type BrokerDynamicMenuProps, type SettingsMenuProps } from "./BrokerDynamicMenu";
import { useBrokerEnvironment, switchBrokerEnvironment, fetchBrokerEnvironment, brokerModeLabel } from "./brokerEnvironment";
import { OptionsScreenerPage } from "./OptionsScreenerPage";
import { OodaResearchPage } from "./OodaResearchPage";
import { PlatformAdminPage } from "./PlatformAdminPage";
import { WorkflowsHub } from "./WorkflowsHub";
import { WorkflowCatalogPage } from "./WorkflowCatalogPage";
import { WorkflowRunsPanel } from "./WorkflowRunsPanel";
import { AgentsPanel } from "./AgentsPanel";
import { ProductHub } from "./ProductHub";
import { BillingServicingPanel } from "./BillingServicingPanel";
import { PageChromeContext } from "./components/ui/PageShell";
import { AdBannerConfig, applyServerAdsConfig, getStoredAdBannerConfig, saveStoredAdBannerConfig, type ServerAdsConfig } from "./adBannerConfig";
import { PartnerDealsModal } from "./components/PartnerDealsModal";
import { NavigationMenu, NavTabId, NavLayoutMode, NavIcons, NAV_TAB_PRESETS, NAV_PRESET_STORAGE_KEY, buildPresetMap, completeVisibleTabs, derivePresetKey, isNavPresetKey, type NavPresetKey } from "./components/NavigationMenu";
import { fetchPlatformContext, usePlatformContext } from "./platformContextStore";
import { mergeVisibleTabs } from "./platformContextNav";
import { NavSettingsPage } from "./NavSettingsPage";
import { legacyAuditVaultRedirect, legacyDualHomeRedirect, legacyMarketingHubRedirect, legacyPlatformAdminHubRedirect, legacyProductRedirect, navigateToTab, readTabFromLocation, replaceToTab, subscribeToRouteChanges } from "./router";
import { legacySchedulesRedirect } from "./schedulesHomeView";
import { SchedulesHome } from "./SchedulesHome";
import { AuditVaultPage } from "./AuditVaultPage";
import { DataHubHome } from "./DataHubHome";
import { SecurityHubHome } from "./SecurityHubHome";
import { ObservabilityHome } from "./ObservabilityHome";
import { MarketingHubHome } from "./MarketingHubHome";
import type { TradeOrderContext } from "./trading/tradeOrderContext";
import { getCrumb } from "./routes";
import { StockSearchBar } from "./components/StockSearchBar";
import { MarketTickerTape } from "./components/MarketTickerTape";
import { useTickerEnabled } from "./quotes/tickerVisibility";
import { MarketStatusPill } from "./components/MarketStatusPill";
import { AskAgentWidget } from "./components/AskAgentWidget";
import { getStoredTheme, applyTheme, ThemeMode, initThemeListener } from "./theme";
import { adAccentPalette } from "./designTokens";
import { Button, TextInput, Badge, Select, Table, Card, Notice, Modal, PageShell, PageSection, EmptyState, SkipLink } from "./components/ui";
import { MarkdownContent } from "./chat/MarkdownContent";
import { renderInlineFormatted } from "./chat/renderInlineFormatted";
import { ReasoningView } from "./chat/ReasoningView";
import { ToolResultView } from "./chat/ToolResultView";
import { AgentChatTabContent } from "./chat/AgentChatTabContent";
import { isTradingTab, mapTabToTradingSubTab, SHELL_RETAINED_PAGES } from "./chat/types";
import type { User, AuditLogEvent, MemoryItem, ReferralItem, AdItem, CategoryItem, ExternalAdItem, RevenueSummaryData, TableMetadataItem } from "./chat/types";
import { RevenueTab } from "./chat/tabs/RevenueTab";
import { EndpointsTab } from "./chat/tabs/EndpointsTab";
import { DocsAndReportsPanel } from "./DocsAndReportsPanel";
import { PaymentWorkflowAssurance } from "./PaymentWorkflowAssurance";
import { CheckoutPanel } from "./CheckoutPanel";
import { PaymentsPage } from "./PaymentsPage";
import { SearchHub } from "./search/SearchHub";
import {
  isTabFeatureEnabled,
  TAB_TO_FEATURE_MAP,
  FeatureDisabledNotice,
} from "./featureFlags";
import { createClientLogger } from "./clientLogger";

const log = createClientLogger("client/Chat");

export function Chat({ user }: { user: User }) {
  const [routeSearch, setRouteSearch] = useState<string>(() =>
    typeof window !== "undefined" ? window.location.search : "",
  );
  const [tab, setTab] = useState<NavTabId>(() => {
    // S1 (#1808): the URL is the source of truth for navigation.
    const fromUrl = readTabFromLocation();
    // Issue #1806: Screener-first rollout — if default from url is autopilot, but autopilot is disabled and screener is enabled, start on assets-hub
    if (fromUrl === "autopilot" && typeof window !== "undefined" && !window.location.search.includes("tab=autopilot")) {
      if (isTabFeatureEnabled("assets-hub") && !isTabFeatureEnabled("autopilot")) {
        return "assets-hub";
      }
      if (!isTabFeatureEnabled("autopilot")) {
        return isTabFeatureEnabled("assets-hub") ? "assets-hub" : "chat";
      }
    }
    return fromUrl;
  });
  // S1 (#1808): the URL is the source of truth for navigation. Tab state
  // follows the router: the initial ?tab=, back/forward, and every
  // navigation through handleSelectTab below. Issue #3121 S2: a retired
  // schedules address (duplicate or admin outpost) is replaced by the
  // consolidated home on arrival and on every route change, so the old
  // address never renders a surface — see schedulesHome.ts.
  useEffect(() => {
    const applyRoute = () => {
      // Issue #4530 — redirects run BEFORE the tab is adopted: a retired
      // address resolves through `resolveRouteId`, whose unknown-id fallback
      // is "autopilot", so adopting first painted the wrong panel for one
      // pass before the redirect landed. `replaceToTab` dispatches
      // `routechange` synchronously, so the nested call adopts the target.
      if (typeof window !== "undefined") {
        const redirect = legacySchedulesRedirect(window.location.search);
        if (redirect) {
          replaceToTab(redirect.tab, redirect.view, redirect.params);
          return;
        }
        const productRedirect = legacyProductRedirect(window.location.search);
        if (productRedirect) {
          replaceToTab(productRedirect.tab, productRedirect.view, productRedirect.params);
          return;
        }
        // Issue #4575: audit + NLQ are the two views of the Audit & Vault
        // menu, so their old top-level addresses resolve onto those views.
        const auditVaultRedirect = legacyAuditVaultRedirect(window.location.search);
        if (auditVaultRedirect) {
          replaceToTab(auditVaultRedirect.tab, auditVaultRedirect.view, auditVaultRedirect.params);
          return;
        }
        // Issue #4585: six Platform Admin sections moved into the DataHub
        // and SecurityHub hubs, so their old addresses resolve onto the
        // new hub views.
        const platformAdminHubRedirect = legacyPlatformAdminHubRedirect(
          window.location.search,
        );
        if (platformAdminHubRedirect) {
          replaceToTab(
            platformAdminHubRedirect.tab,
            platformAdminHubRedirect.view,
            platformAdminHubRedirect.params,
          );
          return;
        }
        // Issue #4626 (S1 of #4625): the five retired dual-homed
        // addresses resolve onto the home where their workflow lives.
        const dualHomeRedirect = legacyDualHomeRedirect(window.location.search);
        if (dualHomeRedirect) {
          replaceToTab(dualHomeRedirect.tab, dualHomeRedirect.view, dualHomeRedirect.params);
          return;
        }
        // Issue 4682: the three retired standalone marketing
        // addresses resolve onto their Marketing Hub section.
        const marketingHubRedirect = legacyMarketingHubRedirect(window.location.search);
        if (marketingHubRedirect) {
          replaceToTab(marketingHubRedirect.tab, marketingHubRedirect.view, marketingHubRedirect.params);
          return;
        }
      }
      setTab(readTabFromLocation());
      if (typeof window !== "undefined") {
        setRouteSearch(window.location.search);
      }
    };
    applyRoute();
    return subscribeToRouteChanges(applyRoute);
  }, []);
  // Accepts values and updater functions, like the state setter it
  // replaces (the trading view passes it as setTab): updaters resolve
  // against the current URL tab, which mirrors tab state.
  const handleSelectTab = useCallback(
    (next: string | ((prev: NavTabId) => NavTabId)) => {
      navigateToTab(typeof next === "function" ? next(readTabFromLocation()) : next);
    },
    [],
  );
  // Issue #3361: the schedules home's preview-trade handoff — seed the
  // shell's pending order context, then navigate to the order tab; the
  // hub consumes the context on arrival (see TradeHub).
  const handleSchedulesPreviewTrade = useCallback(
    (ctx: TradeOrderContext) => {
      setPendingOrderContext(ctx);
      handleSelectTab("order");
    },
    [handleSelectTab],
  );
  const [brokerProps, setBrokerProps] = useState<BrokerDynamicMenuProps | null>(null);
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const [tbdMenuOpen, setTbdMenuOpen] = useState(false);
  const isTbdTab = tab === "chat" || tab === "payments" || tab === "marketing-hub" || tab === "revenue";

  // Navigation Layout state (flexible top or left sidebar)
  const [navLayout, setNavLayout] = useState<NavLayoutMode>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("cf_nav_layout");
      if (saved === "top" || saved === "left") return saved;
    }
    return "left";
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("cf_nav_collapsed") === "true";
    }
    return false;
  });
  const brokerEnv = useBrokerEnvironment();
  const accountMode: "paper" | "live" = brokerEnv === "PROD" ? "live" : "paper";
  const handleToggleAccountMode = () => {
    const next = accountMode === "paper" ? "PROD" : "TEST";
    void switchBrokerEnvironment(next);
  };

  useEffect(() => {
    void fetchBrokerEnvironment();
  }, []);

  // Theme state: light | dark | system
  const [theme, setTheme] = useState<ThemeMode>(() => getStoredTheme());

  useEffect(() => {
    return initThemeListener(() => {
      setTheme(getStoredTheme());
    });
  }, []);

  const handleSelectTheme = (next: ThemeMode) => {
    setTheme(next);
    applyTheme(next);
  };

  const handleCycleTheme = () => {
    setTheme((prev) => {
      const next: ThemeMode = prev === "light" ? "dark" : prev === "dark" ? "high-contrast" : prev === "high-contrast" ? "system" : "light";
      applyTheme(next);
      return next;
    });
  };

  const handleToggleNavLayout = (newLayout: NavLayoutMode) => {
    setNavLayout(newLayout);
    if (typeof window !== "undefined") {
      localStorage.setItem("cf_nav_layout", newLayout);
    }
  };

  // Visible navbar tabs customization state (persisted across sessions).
  // Issues 3696/3697: the map is completed over the left-nav config on
  // load — an explicitly saved empty selection (preset `none`) stays
  // empty and is never merged back over with the alltabs default. The
  // selected preset key is persisted beside the map so the page can show
  // it as active after a reload.
  const [visibleTabs, setVisibleTabs] = useState<Record<string, boolean>>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("nextgentp_visible_nav_tabs");
        const savedPreset = localStorage.getItem(NAV_PRESET_STORAGE_KEY);
        if (saved) return completeVisibleTabs(JSON.parse(saved), savedPreset);
      } catch {}
    }
    return { ...NAV_TAB_PRESETS.alltabs };
  });

  const [navPresetKey, setNavPresetKey] = useState<NavPresetKey | null>(() =>
    derivePresetKey(visibleTabs),
  );

  // #6151 S1 — whether a localStorage map was adopted as the
  // implicit selection on this load. The state initializer above
  // already read the same key; this flag only records that it
  // existed, so the persona-default effect below knows a fresh
  // user from an adopting one.
  const [hadAdoptedSelection] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("nextgentp_visible_nav_tabs") !== null;
    } catch {
      return false;
    }
  });

  // #6151 S1 — the platform context is the source of truth for nav
  // availability from here on. The store fetches once at bootstrap;
  // the effective map passed down is selection ∩ availability.
  const platformContext = usePlatformContext();
  useEffect(() => {
    void fetchPlatformContext();
  }, []);

  // Fresh users (no adopted selection) follow the persona default
  // the server resolved. In S1 every default is alltabs, so this is
  // a no-op for the shipped config — the seam is what S2/S4 use when
  // a default narrows. Applied once: a later refetch must never
  // overwrite the user's in-session toggles.
  const appliedPersonaDefaultRef = useRef(false);
  useEffect(() => {
    if (!platformContext || hadAdoptedSelection || appliedPersonaDefaultRef.current) return;
    if (!isNavPresetKey(platformContext.personaDefault)) return;
    appliedPersonaDefaultRef.current = true;
    const next = buildPresetMap(platformContext.personaDefault);
    setVisibleTabs(next);
    setNavPresetKey(platformContext.personaDefault);
  }, [platformContext, hadAdoptedSelection]);

  // Before the context lands the effective map is the selection
  // (today's behavior — no flash of hidden tabs); after it lands,
  // the server's availability caps the selection.
  const effectiveVisibleTabs = useMemo(() => {
    if (!platformContext) return visibleTabs;
    return mergeVisibleTabs(visibleTabs, platformContext.visibleTabs);
  }, [visibleTabs, platformContext]);

  const applyVisibleTabs = (
    next: Record<string, boolean>,
    presetKey?: NavPresetKey | null,
  ) => {
    const key = presetKey ?? derivePresetKey(next);
    setVisibleTabs(next);
    setNavPresetKey(key);
    // #6151 S1: the selection is session-scoped until S3 — the
    // localStorage map is adopted once on load (above) and never
    // written again. The stale map stays on disk for S3 to offer
    // as "save as preset".
  };

  const handleToggleTabVisibility = (tabId: string) => {
    applyVisibleTabs({
      ...visibleTabs,
      [tabId]: visibleTabs[tabId] === false ? true : false,
    });
  };

  const handleSetVisibleTabs = (
    newTabs: Record<string, boolean>,
    presetKey?: NavPresetKey | null,
  ) => {
    applyVisibleTabs(newTabs, presetKey);
  };

  // Universal Workspace Refresh state (accessible everywhere from top bar)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string>(() => {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  });
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  // Issue #2481 — the global auto-refresh switch now lives in
  // autoRefresh.ts (single key family, single write path); Chat
  // no longer keeps its own copy. The dynamic panel is controlled
  // from here via the props below.
  const [autoRefreshState, setAutoRefreshState] = useAutoRefresh();
  const [tenantProviders] = useTenantProviders();
  const selectedBrokerLabel = labelForBroker(tenantProviders, tenantProviders.brokerId);
  const autoRefreshEnabled = autoRefreshState.enabled;
  const autoRefreshInterval = autoRefreshState.interval;
  const tickerEnabled = useTickerEnabled();

  // Issue #277: server-owned setting for HITL confirmation on
  // research-report dispatch. Default ON (#1144, owner decision).
  const [reportDispatchHitl, setReportDispatchHitl] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/trading/settings/report-dispatch-hitl", {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { enabled?: unknown };
        if (!cancelled && typeof data.enabled === "boolean") setReportDispatchHitl(data.enabled);
      } catch {
        // Server unreachable or setting unavailable: keep default ON.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Issue #277: pending report-dispatch confirmations awaiting review.
  const [pendingReportConfirmations, setPendingReportConfirmations] = useState<
    Array<{ confirmationId: string; kind: string; createdAt: string; detail: string }>
  >([]);

  const refreshPendingReportConfirmations = async () => {
    try {
      const res = await fetch("/api/trading/reports/pending", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { pending?: unknown };
      setPendingReportConfirmations(Array.isArray(data.pending) ? data.pending as Array<{ confirmationId: string; kind: string; createdAt: string; detail: string }> : []);
    } catch {
      // Leave the previous list in place on fetch failure.
    }
  };

  useEffect(() => {
    if (reportDispatchHitl) void refreshPendingReportConfirmations();
    else setPendingReportConfirmations([]);
  }, [reportDispatchHitl]);

  const handleDecideReportConfirmation = async (confirmationId: string, decision: "approved" | "rejected") => {
    try {
      const res = await fetch("/api/trading/reports/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmationId, decision }),
      });
      if (res.ok) await refreshPendingReportConfirmations();
    } catch {
      // Keep the list as-is; the operator can refresh and retry.
    }
  };

  const handleToggleReportDispatchHitl = async (enabled: boolean) => {
    setReportDispatchHitl(enabled);
    try {
      const res = await fetch("/api/trading/settings/report-dispatch-hitl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) setReportDispatchHitl(!enabled);
    } catch {
      // Server write failed: revert the toggle so the UI matches the server.
      setReportDispatchHitl(!enabled);
    }
  };

  const handleToggleAutoRefresh = (enabled: boolean, interval?: number) => {
    setAutoRefreshState(enabled, interval);
  };

  const handleGlobalRefresh = useCallback(async () => {
    setIsRefreshing(true);
    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setLastRefreshedAt(now);

    // Broadcast global refresh event so all active tab panels update simultaneously
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("app-refresh", { detail: { timestamp: Date.now(), timeStr: now } }));
    }

    try {
      fetch("/api/market/quotes").catch(() => {});
    } catch {}

    setTimeout(() => {
      setIsRefreshing(false);
    }, 600);
  }, []);

  // Global Auto-Refresh periodic timer (issue #2419: shared treatment
  // via startPolling — hidden-pause added; the toggle, the user
  // interval, and the floor are unchanged, but the floor itself is
  // now externalized instead of a literal 5).
  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const intervalMs =
      Math.max(getPollingConfig().chatAutoRefreshFloorS, autoRefreshInterval) * 1000;
    return startPolling(handleGlobalRefresh, { fastMs: intervalMs, idleMs: intervalMs });
  }, [autoRefreshEnabled, autoRefreshInterval, handleGlobalRefresh]);

  const handleToggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        localStorage.setItem("cf_nav_collapsed", String(next));
      }
      return next;
    });
  };

  const handleAskAgent = (queryText: string) => {
    setPendingPrompt({ prompt: queryText, sourceTab: `Global Search / ${BRAND.name}` });
    handleSelectTab("chat");
  };

  // Configurable Ad & Sponsor Banner settings (externalized from workspace tabs)
  const [adBannerConfig, setAdBannerConfig] = useState<AdBannerConfig>(() => getStoredAdBannerConfig());
  const [showPartnerDealsModal, setShowPartnerDealsModal] = useState<boolean>(false);

  // One shared confirm Modal for the three Chat-owned deletes (referral,
  // category, memory). Previously the category delete used a native
  // confirm() and the other two deleted silently on click.
  type ChatDeleteTarget = { kind: "referral" | "category" | "memory"; id: string; label: string };
  const [deleteTarget, setDeleteTarget] = useState<ChatDeleteTarget | null>(null);

  const handleUpdateAdBannerConfig = (newConfig: AdBannerConfig) => {
    setAdBannerConfig(newConfig);
    saveStoredAdBannerConfig(newConfig);
  };

  // Issue #2022: server-resolved ad allowance. The server ad lists
  // are the enforcement boundary; this display override ANDs the
  // server allowance with local preference so a Subscribed caller
  // sees no ad surface even where rendering does not come from a
  // fetched list (Google units in tabs). A failed fetch leaves local
  // preference untouched — fail-open to current behavior, never hide
  // a Free user's ads on a transient failure.
  const [serverAdsConfig, setServerAdsConfig] = useState<ServerAdsConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ads/banner-config")
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data === "object") setServerAdsConfig(data as ServerAdsConfig);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const effectiveAdBannerConfig = applyServerAdsConfig(adBannerConfig, serverAdsConfig);

  useEffect(() => {
    const handleOpenDeals = () => setShowPartnerDealsModal(true);
    window.addEventListener("open-partner-deals-modal", handleOpenDeals);
    return () => window.removeEventListener("open-partner-deals-modal", handleOpenDeals);
  }, []);

  // External Ads & Monetization state
  const [externalAds, setExternalAds] = useState<ExternalAdItem[]>([]);
  const [externalAdsLoading, setExternalAdsLoading] = useState(false);
  const [activeExtAdIndex, setActiveExtAdIndex] = useState(0);
  const [newExtTitle, setNewExtTitle] = useState("");
  const [newExtNetwork, setNewExtNetwork] = useState<"direct" | "ethicalads" | "carbon" | "adsense" | "google">("google");
  const [newExtPlacement, setNewExtPlacement] = useState<"header_leaderboard" | "in_stream" | "footer_deck" | "sidebar">("header_leaderboard");
  const [newExtTagline, setNewExtTagline] = useState("");
  const [newExtUrl, setNewExtUrl] = useState("");
  const [newExtCta, setNewExtCta] = useState("Learn More →");
  const [newExtCpm, setNewExtCpm] = useState("24.50");
  const [newExtCpc, setNewExtCpc] = useState("2.10");
  const [savingExtAd, setSavingExtAd] = useState(false);
  const [extAdSuccessMsg, setExtAdSuccessMsg] = useState("");
  const [extAdErrorMsg, setExtAdErrorMsg] = useState("");

  // Google Ads & AdSense state
  const [googleAdsEnabled, setGoogleAdsEnabled] = useState(true);
  const [googlePublisherId, setGooglePublisherId] = useState("ca-pub-9842109842109842");
  const [googleSlotId, setGoogleSlotId] = useState("7812903456");
  const [googleAdFormat, setGoogleAdFormat] = useState<"responsive" | "leaderboard" | "rectangle">("responsive");

  // Social sharing state
  const [discordCopied, setDiscordCopied] = useState(false);
  const [activeShareRefId, setActiveShareRefId] = useState<string | null>(null);
  const [copiedShareRefId, setCopiedShareRefId] = useState<string | null>(null);

  // Categories ORM state
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [newCatIcon, setNewCatIcon] = useState("🏷️");
  const [newCatDesc, setNewCatDesc] = useState("");
  const [newCatOrder, setNewCatOrder] = useState("10");
  const [savingCat, setSavingCat] = useState(false);
  const [catSuccessMsg, setCatSuccessMsg] = useState("");
  const [catErrorMsg, setCatErrorMsg] = useState("");

  // Revenue Analytics state
  const [revenueSummary, setRevenueSummary] = useState<RevenueSummaryData | null>(null);
  const [revenueLoading, setRevenueLoading] = useState(false);

  // Schema & Tables Explorer state
  const [tables, setTables] = useState<TableMetadataItem[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [selectedBrowseTable, setSelectedBrowseTable] = useState("mas_categories");
  const [browseSearch, setBrowseSearch] = useState("");
  const [browsedData, setBrowsedData] = useState<{ tableName: string; total: number; rows: any[] } | null>(null);
  const [browsingLoading, setBrowsingLoading] = useState(false);
  // #1968: the row a user opened for its full payload (expanded JSON).
  const [browsedDetailRow, setBrowsedDetailRow] = useState<any | null>(null);

  // Agent connection state & session management
  const [chatNonce, setChatNonce] = useState(0);
  const [chatStatus, setChatStatus] = useState<"ready" | "streaming" | "submitted" | "error">("ready");
  const [isResettingChat, setIsResettingChat] = useState(false);
  const [chatResetNotice, setChatResetNotice] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<{ prompt: string; sourceTab: string } | null>(null);
  // Issue #3361 (#3121 S2 follow-up): the shell-level order-context
  // handoff (the pendingPrompt idiom). The de-hubbed schedules home
  // hands the converted preview candidate here; the trading hub
  // consumes it through its own handleTradeOrder when the order
  // sub-tab becomes active, then clears it. Nothing travels in the
  // URL and the home stays out of the hub.
  const [pendingOrderContext, setPendingOrderContext] = useState<TradeOrderContext | null>(null);

  const isBusy = chatStatus === "streaming" || chatStatus === "submitted";
  const statusLabel = isBusy ? "Thinking…" : chatStatus === "error" ? "Error" : "Ready";
  const statusDotClass = isBusy ? "streaming" : chatStatus === "error" ? "error" : "ready";

  const handleResetChatSession = async (purge = true) => {
    if (isResettingChat) return;
    setIsResettingChat(true);
    setChatResetNotice(null);
    setAuthExpired(false);
    try {
      const resp = await fetch(`/api/clear?purge=${purge ? "true" : "false"}`, { method: "POST" });
      if (resp.status === 401) {
        setAuthExpired(true);
        setChatResetNotice("Session expired. Please log in again.");
        return;
      }
      setChatResetNotice(purge ? "Chat session and conversation history successfully reset." : "Agent connection re-established.");
      setTimeout(() => setChatResetNotice(null), 4000);
    } catch (err) {
      log.warn("chat.clear_contact_failed", {
        message: "Failed to contact /api/clear",
        error: err instanceof Error ? err.message : String(err),
      });
      setChatResetNotice("Chat session reset locally.");
      setTimeout(() => setChatResetNotice(null), 3000);
    } finally {
      setIsResettingChat(false);
      setChatStatus("ready");
      setChatNonce((n) => n + 1);
    }
  };

  // The audit vault, the event log and the NLQ surface own their state in
  // AuditVaultPage (#4575) — the shell keeps none of it.

  // Referrals state
  const [referrals, setReferrals] = useState<ReferralItem[]>([]);
  const [referralsLoading, setReferralsLoading] = useState(false);
  const [copiedReferral, setCopiedReferral] = useState(false);
  const [newRefTitle, setNewRefTitle] = useState("");
  const [newRefUrl, setNewRefUrl] = useState("");
  const [newRefCategory, setNewRefCategory] = useState("AI & Dev Tools");
  const [newRefReward, setNewRefReward] = useState("");
  const [savingRef, setSavingRef] = useState(false);
  const [refFormSuccess, setRefFormSuccess] = useState("");
  const [refFormError, setRefFormError] = useState("");

  // Sponsored Ads state
  const [ads, setAds] = useState<AdItem[]>([]);
  const [adsLoading, setAdsLoading] = useState(false);
  const [newAdTitle, setNewAdTitle] = useState("");
  const [newAdTagline, setNewAdTagline] = useState("");
  const [newAdSponsor, setNewAdSponsor] = useState("");
  const [newAdBadge, setNewAdBadge] = useState("PROMOTED");
  const [newAdUrl, setNewAdUrl] = useState("");
  const [newAdCta, setNewAdCta] = useState("Claim Deal →");
  const [newAdColor, setNewAdColor] = useState<string>(adAccentPalette[0].value);
  const [savingAd, setSavingAd] = useState(false);
  const [adFormSuccess, setAdFormSuccess] = useState("");
  const [adFormError, setAdFormError] = useState("");

  const personalReferralUrl = typeof window !== "undefined"
    ? `${window.location.origin}/?ref=${encodeURIComponent(user.login)}`
    : `https://agent.openaimp.com/?ref=${encodeURIComponent(user.login)}`;

  const handleCopyPersonalRef = () => {
    navigator.clipboard.writeText(personalReferralUrl);
    setCopiedReferral(true);
    setTimeout(() => setCopiedReferral(false), 2500);
  };

  const handleCopyDiscordEmbed = () => {
    const text = `**Join ${BRAND.name}:** [Autonomous AI Trading & Strategy Platform](${personalReferralUrl})`;
    navigator.clipboard.writeText(text);
    setDiscordCopied(true);
    setTimeout(() => setDiscordCopied(false), 2500);
  };

  const handleCopyRefDiscordEmbed = (refUrl: string, refTitle: string, refId: string) => {
    const text = `**${refTitle}**: [${refUrl}](${refUrl})`;
    navigator.clipboard.writeText(text);
    setCopiedShareRefId(refId);
    setTimeout(() => setCopiedShareRefId(null), 2500);
  };


  // Initial load of partner ads, categories, external ads, and revenue
  useEffect(() => {
    fetchAds();
    fetchCategories();
    fetchExternalAds();
    fetchRevenueSummary();
  }, []);

  // Record impression whenever active external ad changes (gated on ad enablement)
  useEffect(() => {
    if (
      effectiveAdBannerConfig.enabled &&
      effectiveAdBannerConfig.showAdNetworkStrip &&
      Boolean(effectiveAdBannerConfig.tabVisibility[tab]) &&
      externalAds.length > 0 &&
      externalAds[activeExtAdIndex]
    ) {
      recordExternalAdImpression(externalAds[activeExtAdIndex]);
    }
  }, [activeExtAdIndex, externalAds.length, effectiveAdBannerConfig, tab]);

  // Load tab-specific data when tab changes
  useEffect(() => {
    if (tab === "marketing-hub") {
      fetchReferrals();
      fetchCategories();
      fetchAds();
    } else if (tab === "revenue") {
      fetchRevenueSummary();
      fetchExternalAds();
      fetchCategories();
      fetchTables();
    }
  }, [tab]);

  const fetchReferrals = async () => {
    setReferralsLoading(true);
    try {
      const resp = await fetch("/api/referrals");
      const data = await resp.json() as { referrals?: ReferralItem[] };
      setReferrals(data.referrals || []);
    } catch {
      // Ignore
    } finally {
      setReferralsLoading(false);
    }
  };

  const fetchAds = async () => {
    setAdsLoading(true);
    try {
      const resp = await fetch("/api/ads");
      const data = await resp.json() as { ads?: AdItem[] };
      setAds(data.ads || []);
    } catch {
      // Ignore
    } finally {
      setAdsLoading(false);
    }
  };

  const handleAdClick = (ad: AdItem) => {
    try {
      fetch("/api/ads/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ad.id }),
      });
      setAds((prev) =>
        prev.map((a) => (a.id === ad.id ? { ...a, clicks: a.clicks + 1 } : a))
      );
    } catch {
      // Ignore
    }
    window.open(ad.url, "_blank", "noopener,noreferrer");
  };

  const handleReferralClick = (ref: ReferralItem) => {
    try {
      fetch("/api/referrals/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ref.id }),
      });
      setReferrals((prev) =>
        prev.map((r) => (r.id === ref.id ? { ...r, clicks: r.clicks + 1 } : r))
      );
    } catch {
      // Ignore
    }
    window.open(ref.url, "_blank", "noopener,noreferrer");
  };

  const handleDeleteReferral = async (id: string) => {
    setDeleteTarget({
      kind: "referral",
      id,
      label: referrals.find((r) => r.id === id)?.title ?? id,
    });
  };

  const handleCreateReferral = async (e: React.FormEvent) => {
    e.preventDefault();
    setRefFormError("");
    setRefFormSuccess("");
    if (!newRefTitle.trim() || !newRefUrl.trim()) {
      setRefFormError("Please enter both title and target referral URL");
      return;
    }
    setSavingRef(true);
    try {
      const res = await fetch("/api/referrals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newRefTitle.trim(),
          url: newRefUrl.trim(),
          category: newRefCategory,
          rewardText: newRefReward.trim() || "Exclusive community referral bonus",
        }),
      });
      const data = await res.json() as { referral?: ReferralItem; error?: string };
      if (data.referral) {
        setReferrals((prev) => [data.referral!, ...prev]);
        setNewRefTitle("");
        setNewRefUrl("");
        setNewRefReward("");
        setRefFormSuccess("🎉 Referral link published successfully!");
        setTimeout(() => setRefFormSuccess(""), 4000);
      } else {
        setRefFormError(data.error || "Failed to create referral link");
      }
    } catch (err: any) {
      setRefFormError(err.message || "Failed to save referral");
    } finally {
      setSavingRef(false);
    }
  };

  const handleCreateAd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdFormError("");
    setAdFormSuccess("");
    if (!newAdTitle.trim() || !newAdUrl.trim()) {
      setAdFormError("Please enter campaign title and target URL");
      return;
    }
    setSavingAd(true);
    try {
      const res = await fetch("/api/ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newAdTitle.trim(),
          tagline: newAdTagline.trim() || "Special offer for autonomous agent builders.",
          sponsor: newAdSponsor.trim() || user.name || "Community Partner",
          badge: newAdBadge.trim() || "PROMOTED",
          url: newAdUrl.trim(),
          ctaText: newAdCta.trim() || "Claim Deal →",
          accentColor: newAdColor,
        }),
      });
      const data = await res.json() as { ad?: AdItem; error?: string };
      if (data.ad) {
        setAds((prev) => [data.ad!, ...prev]);
        setNewAdTitle("");
        setNewAdTagline("");
        setNewAdSponsor("");
        setNewAdUrl("");
        setAdFormSuccess("🚀 Sponsored ad launched successfully!");
        setTimeout(() => setAdFormSuccess(""), 4000);
      } else {
        setAdFormError(data.error || "Failed to submit ad");
      }
    } catch (err: any) {
      setAdFormError(err.message || "Failed to submit ad");
    } finally {
      setSavingAd(false);
    }
  };

  const fetchCategories = async () => {
    setCategoriesLoading(true);
    try {
      const resp = await fetch("/api/categories");
      const data = (await resp.json()) as { categories?: CategoryItem[] };
      if (data.categories) {
        setCategories(data.categories);
        if (data.categories.length > 0 && !newRefCategory) {
          setNewRefCategory(data.categories[0].name);
        }
      }
    } catch {
      // Ignore
    } finally {
      setCategoriesLoading(false);
    }
  };

  const fetchExternalAds = async () => {
    setExternalAdsLoading(true);
    try {
      const resp = await fetch("/api/external-ads");
      const data = (await resp.json()) as { ads?: ExternalAdItem[] };
      if (data.ads) {
        setExternalAds(data.ads);
      }
    } catch {
      // Ignore
    } finally {
      setExternalAdsLoading(false);
    }
  };

  const fetchRevenueSummary = async () => {
    setRevenueLoading(true);
    try {
      const resp = await fetch("/api/revenue");
      const data = (await resp.json()) as RevenueSummaryData;
      setRevenueSummary(data);
    } catch {
      // Ignore
    } finally {
      setRevenueLoading(false);
    }
  };

  const fetchTables = async () => {
    setTablesLoading(true);
    try {
      const resp = await fetch("/api/schema/tables");
      const data = (await resp.json()) as { tables?: TableMetadataItem[] };
      if (data.tables) {
        setTables(data.tables);
      }
    } catch {
      // Ignore
    } finally {
      setTablesLoading(false);
    }
  };

  const browseTable = async (tableName: string, search?: string) => {
    setBrowsingLoading(true);
    try {
      const resp = await fetch("/api/schema/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: tableName, search: search || "" }),
      });
      const data = (await resp.json()) as { tableName: string; total: number; rows: any[] };
      setBrowsedData(data);
    } catch {
      setBrowsedData(null);
    } finally {
      setBrowsingLoading(false);
    }
  };

  const recordExternalAdImpression = (ad: ExternalAdItem) => {
    try {
      fetch("/api/external-ads/impression", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ad.id }),
      });
      setExternalAds((prev) =>
        prev.map((a) => (a.id === ad.id ? { ...a, impressions: a.impressions + 1, earnings: a.earnings + (a.cpmRate || 15) / 1000 } : a))
      );
    } catch {
      // Ignore
    }
  };

  const handleExternalAdClick = (ad: ExternalAdItem) => {
    try {
      fetch("/api/external-ads/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ad.id }),
      });
      setExternalAds((prev) =>
        prev.map((a) => (a.id === ad.id ? { ...a, clicks: a.clicks + 1, earnings: a.earnings + (a.cpcRate || 1.25) } : a))
      );
      if (revenueSummary) {
        setRevenueSummary((prev) =>
          prev ? { ...prev, totalAdClicks: prev.totalAdClicks + 1, adNetworkRevenue: prev.adNetworkRevenue + (ad.cpcRate || 1.25) } : null
        );
      }
    } catch {
      // Ignore
    }
    window.open(ad.targetUrl, "_blank", "noopener,noreferrer");
  };

  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setCatErrorMsg("");
    setCatSuccessMsg("");
    if (!newCatName.trim()) {
      setCatErrorMsg("Category name is required");
      return;
    }
    setSavingCat(true);
    try {
      const resp = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newCatName.trim(),
          icon: newCatIcon.trim() || "🏷️",
          description: newCatDesc.trim() || `Referrals in ${newCatName.trim()}`,
          sortOrder: Number(newCatOrder) || 10,
        }),
      });
      const data = (await resp.json()) as { success?: boolean; category?: CategoryItem; error?: string };
      if (data.category) {
        setCategories((prev) => [...prev, data.category!].sort((a, b) => a.sortOrder - b.sortOrder));
        setNewCatName("");
        setNewCatDesc("");
        setCatSuccessMsg(`✅ Category "${data.category.name}" created in ORM mas_categories!`);
        setTimeout(() => setCatSuccessMsg(""), 4000);
      } else {
        setCatErrorMsg(data.error || "Failed to create category");
      }
    } catch (err: any) {
      setCatErrorMsg(err.message || "Failed to create category");
    } finally {
      setSavingCat(false);
    }
  };

  const handleDeleteCategory = async (id: string) => {
    setDeleteTarget({
      kind: "category",
      id,
      label: categories.find((c) => c.id === id)?.name ?? id,
    });
  };

  const handleCreateExternalAd = async (e: React.FormEvent) => {
    e.preventDefault();
    setExtAdErrorMsg("");
    setExtAdSuccessMsg("");
    if (!newExtTitle.trim() || !newExtUrl.trim()) {
      setExtAdErrorMsg("Title and Target URL are required");
      return;
    }
    setSavingExtAd(true);
    try {
      const resp = await fetch("/api/external-ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newExtTitle.trim(),
          network: newExtNetwork,
          placement: newExtPlacement,
          tagline: newExtTagline.trim(),
          targetUrl: newExtUrl.trim(),
          ctaText: newExtCta.trim() || "Learn More →",
          cpmRate: parseFloat(newExtCpm) || 18.5,
          cpcRate: parseFloat(newExtCpc) || 1.5,
        }),
      });
      const data = (await resp.json()) as { success?: boolean; ad?: ExternalAdItem; error?: string };
      if (data.ad) {
        setExternalAds((prev) => [data.ad!, ...prev]);
        setNewExtTitle("");
        setNewExtTagline("");
        setNewExtUrl("");
        setExtAdSuccessMsg(`🎉 External Ad Placement "${data.ad.title}" activated on ${data.ad.network.toUpperCase()}!`);
        setTimeout(() => setExtAdSuccessMsg(""), 4000);
        fetchRevenueSummary();
      } else {
        setExtAdErrorMsg(data.error || "Failed to create external ad");
      }
    } catch (err: any) {
      setExtAdErrorMsg(err.message || "Failed to create external ad");
    } finally {
      setSavingExtAd(false);
    }
  };

  const confirmDeleteTarget = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      if (target.kind === "referral") {
        await fetch(`/api/referrals?id=${encodeURIComponent(target.id)}`, { method: "DELETE" });
        setReferrals((prev) => prev.filter((r) => r.id !== target.id));
      } else if (target.kind === "category") {
        await fetch(`/api/categories?id=${encodeURIComponent(target.id)}`, { method: "DELETE" });
        setCategories((prev) => prev.filter((c) => c.id !== target.id));
      }
    } catch {
      // Ignore
    }
  };

  // #2077 (#1804 S6): the route-table-derived content switch. One
  // table-keyed lookup replaces the 14 inline {tab === ...} conditionals
  // that used to live in <main>; coverage is pinned against ROUTES in
  // tests/route_content_switch_1804.test.ts. Trading ids have no entry
  // here — they render through the retained TradeHub below,
  // hidden for non-trading tabs via isTradingTab (table-backed retain
  // flags, see routes.ts) — with one exception: "schedules" is
  // de-hubbed (#3121 S2) and renders its home here, not through the
  // hub. docs previously rendered blank; its existing panel is wired
  // here (no props).
  const TAB_CONTENT: Record<string, ReactNode> = {
    agents: (
      <ErrorBoundary label="Agents">
        <AgentsPanel />
      </ErrorBoundary>
    ),
    "audit-vault": (
      <AuditVaultPage
        isBusy={isBusy}
        onAsk={(prompt, sourceTab) => {
          setPendingPrompt({ prompt, sourceTab });
          handleSelectTab("chat");
        }}
      />
    ),
    chat: (
          <AgentChatTabContent
            key={chatNonce}
            user={user}
            ads={ads}
            showSponsorSpotlight={effectiveAdBannerConfig.enabled && effectiveAdBannerConfig.showSponsorSpotlight && Boolean(effectiveAdBannerConfig.tabVisibility.chat)}
            onAdClick={handleAdClick}
            onOpenAdsTab={() => {
              navigateToTab("marketing-hub", "ads");
              setTbdMenuOpen(false);
            }}
            onNavigateTab={(targetTab) => {
              handleSelectTab(targetTab as any);
              setTbdMenuOpen(false);
            }}
            onStatusChange={setChatStatus}
            onResetSession={handleResetChatSession}
            isResetting={isResettingChat}
            resetNotice={chatResetNotice}
            authExpired={authExpired}
            pendingPrompt={pendingPrompt}
            onClearPendingPrompt={() => setPendingPrompt(null)}
          />
    ),
    docs: (
      <ErrorBoundary label="Docs & Reports">
        <DocsAndReportsPanel />
      </ErrorBoundary>
    ),
    endpoints: (
          <EndpointsTab

          />
    ),
    // Issue #2596, slice 1: the Options Screener's own page. It is
    // not a retained trading-hub tab, so it lives in TAB_CONTENT
    // like the other standalone pages; its cards link to the
    // existing surfaces, they do not re-render them.
    "options-screener": (
      new URLSearchParams(routeSearch).get("view") === "ooda" ? (
        <OodaResearchPage userLogin={user.login} />
      ) : (
        <OptionsScreenerPage
          onSelectTab={(newTab) => {
            handleSelectTab(newTab);
            setTbdMenuOpen(false);
          }}
        />
      )
    ),
    "platform-admin": (
      <PlatformAdminPage
        user={{ login: user.login, name: user.name, avatar: user.avatar }}
        adBannerConfig={adBannerConfig}
        onUpdateAdBannerConfig={handleUpdateAdBannerConfig}
        onOpenPartnerDeals={() => setShowPartnerDealsModal(true)}
      />
    ),
    // Issue #3121 S2: the consolidated schedules home — the ONE
    // schedules surface. De-hubbed: it renders directly from the shell,
    // not through the retained TradeHub (a broker-neutral home
    // cannot live inside a broker hub, #3216).
    schedules: (
      <SchedulesHome userLogin={user.login} onPreviewTrade={handleSchedulesPreviewTrade} />
    ),
    // Issue #4585: the DataHub home — data providers, data lifecycle,
    // and parameters & export, moved out of Platform Admin.
    "data-hub": (
      <DataHubHome userLogin={user.login} />
    ),
    // Issue #4585: the SecurityHub home — IAAA admin, users, admin
    // access, and the user profile, moved out of Platform Admin.
    "security-hub": (
      <SecurityHubHome
        userLogin={user.login}
        user={{ login: user.login, name: user.name, avatar: user.avatar }}
      />
    ),
    // Issue #5169: the Observability home — the R2 archive file
    // browser (the interim view until the S8 dashboard lands).
    observability: (
      <ObservabilityHome />
    ),
    // Issues 3696/3697/3828: the Settings page — dynamic settings menu
    // + navigation presets + visible-tabs pills live here, reached from
    // the fixed bottom-left trigger (outside side-nav and top-nav).
    "nav-settings": (
      <NavSettingsPage
        visibleTabs={effectiveVisibleTabs}
        activePreset={navPresetKey}
        onToggleTabVisibility={handleToggleTabVisibility}
        onApplyPreset={(key) => handleSetVisibleTabs(NAV_TAB_PRESETS[key], key)}
        settingsMenuProps={{
          userLogin: user.login,
          userName: user.name,
          userAvatar: user.avatar,
          theme,
          onCycleTheme: handleCycleTheme,
          onSelectTheme: handleSelectTheme,
          currentLayout: navLayout,
          onToggleLayout: handleToggleNavLayout,
          activeEnv: brokerEnv,
          accountMode,
          onToggleAccountMode: handleToggleAccountMode,
          handleSwitchEnvironment: (target) => void switchBrokerEnvironment(target),
          autoRefreshEnabled,
          autoRefreshInterval,
          onToggleAutoRefresh: handleToggleAutoRefresh,
          reportDispatchHitl,
          onToggleReportDispatchHitl: handleToggleReportDispatchHitl,
          pendingReportConfirmations,
          onRefreshReportConfirmations: refreshPendingReportConfirmations,
          onDecideReportConfirmation: handleDecideReportConfirmation,
          adBannerConfig: effectiveAdBannerConfig,
          onUpdateAdBannerConfig: handleUpdateAdBannerConfig,
          onOpenPartnerDeals: () => setShowPartnerDealsModal(true),
          ...(brokerProps || {}),
        } satisfies SettingsMenuProps}
      />
    ),
    // Issue #4530: the Product Hub is the ONLY place for
    // product-domain URLs — the standalone products entry retired
    // (its addresses redirect to the hub tabs).
    "product-hub": (
      <ErrorBoundary label="Product Hub">
        <ProductHub />
      </ErrorBoundary>
    ),
    billing: (
      <ErrorBoundary label="Billing">
        {/* Issue #4691 — the Billing route is a tab of the app (the
            crumb is the title), so the host applies "tab" chrome to the
            panel: its PageShell renders content-only, no second h1.
            The panel itself is unchanged for its host. */}
        <PageChromeContext.Provider value="tab">
          <BillingServicingPanel />
        </PageChromeContext.Provider>
      </ErrorBoundary>
    ),
    "payment-assurance": (
      <ErrorBoundary label="Payment Assurance">
        <PaymentWorkflowAssurance userLogin={user.login} />
      </ErrorBoundary>
    ),
    "checkout": (
          <CheckoutPanel userLogin={user.login} />
    ),
    search: (
      <ErrorBoundary label="Search">
        <SearchHub />
      </ErrorBoundary>
    ),
    "workflow-runs": (
          <WorkflowRunsPanel />
    ),
    "workflow-catalog": (
      <ErrorBoundary label="Workflow catalog">
        <WorkflowCatalogPage />
      </ErrorBoundary>
    ),
    workflows: (
          <div className="workflows-view" style={{ width: "100%", height: "100%", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <WorkflowsHub
              onNavigateTab={(targetTab) => {
                handleSelectTab(targetTab as any);
                setTbdMenuOpen(false);
              }}
              onSendPrompt={(prompt, sourceTab) => {
                setPendingPrompt({ prompt, sourceTab: sourceTab || "Platform Workflows" });
                handleSelectTab("chat");
              }}
            />
          </div>
    ),

  };

  // Shell-retained pages (#2149, #2161): standalone pages rendered mounted-hidden
  // when inactive (the trading hub's retained-render precedent, outside
  // the hub). TAB_CONTENT holds only the non-retained ids now.
  const SHELL_CONTENT: Record<string, ReactNode> = {
    payments: <PaymentsPage active={tab === "payments"} user={user} />,
    // Issue 4682: the Marketing Hub is the ONE marketing surface — the
    // referrals, ads, and social pages render here as hub sections, not
    // as standalone shell pages. Props stay in Chat (the three pages
    // share Chat state), so this entry passes them through as objects.
    "marketing-hub": (
      <MarketingHubHome
        adsProps={{
          adFormError,
          adFormSuccess,
          ads,
          adsLoading,
          fetchAds,
          handleAdClick,
          handleCreateAd,
          newAdColor,
          newAdCta,
          newAdSponsor,
          newAdTagline,
          newAdTitle,
          newAdUrl,
          savingAd,
          setNewAdColor,
          setNewAdCta,
          setNewAdSponsor,
          setNewAdTagline,
          setNewAdTitle,
          setNewAdUrl,
        }}
        referralsProps={{
          activeShareRefId,
          adBannerConfig: effectiveAdBannerConfig,
          categories,
          copiedReferral,
          copiedShareRefId,
          discordCopied,
          externalAds,
          fetchReferrals,
          googleAdsEnabled,
          googlePublisherId,
          googleSlotId,
          handleCopyDiscordEmbed,
          handleCopyPersonalRef,
          handleCopyRefDiscordEmbed,
          handleCreateReferral,
          handleDeleteReferral,
          handleExternalAdClick,
          handleReferralClick,
          newRefCategory,
          newRefReward,
          newRefTitle,
          newRefUrl,
          personalReferralUrl,
          refFormError,
          refFormSuccess,
          referrals,
          referralsLoading,
          savingRef,
          setActiveShareRefId,
          setNewRefCategory,
          setNewRefReward,
          setNewRefTitle,
          setNewRefUrl,
          user,
        }}
      />
    ),
    revenue: (
          <RevenueTab
            adBannerConfig={effectiveAdBannerConfig}
            ads={ads}
            browseTable={browseTable}
            catErrorMsg={catErrorMsg}
            catSuccessMsg={catSuccessMsg}
            categories={categories}
            extAdErrorMsg={extAdErrorMsg}
            extAdSuccessMsg={extAdSuccessMsg}
            externalAds={externalAds}
            fetchCategories={fetchCategories}
            fetchExternalAds={fetchExternalAds}
            fetchRevenueSummary={fetchRevenueSummary}
            fetchTables={fetchTables}
            googleAdFormat={googleAdFormat}
            googleAdsEnabled={googleAdsEnabled}
            googlePublisherId={googlePublisherId}
            googleSlotId={googleSlotId}
            handleCreateCategory={handleCreateCategory}
            handleCreateExternalAd={handleCreateExternalAd}
            handleDeleteCategory={handleDeleteCategory}
            handleExternalAdClick={handleExternalAdClick}
            newCatDesc={newCatDesc}
            newCatIcon={newCatIcon}
            newCatName={newCatName}
            newCatOrder={newCatOrder}
            newExtCpc={newExtCpc}
            newExtCpm={newExtCpm}
            newExtCta={newExtCta}
            newExtNetwork={newExtNetwork}
            newExtPlacement={newExtPlacement}
            newExtTagline={newExtTagline}
            newExtTitle={newExtTitle}
            newExtUrl={newExtUrl}
            revenueLoading={revenueLoading}
            revenueSummary={revenueSummary}
            savingCat={savingCat}
            savingExtAd={savingExtAd}
            setGoogleAdFormat={setGoogleAdFormat}
            setGoogleAdsEnabled={setGoogleAdsEnabled}
            setGooglePublisherId={setGooglePublisherId}
            setGoogleSlotId={setGoogleSlotId}
            setNewCatDesc={setNewCatDesc}
            setNewCatIcon={setNewCatIcon}
            setNewCatName={setNewCatName}
            setNewCatOrder={setNewCatOrder}
            setNewExtCpc={setNewExtCpc}
            setNewExtCpm={setNewExtCpm}
            setNewExtCta={setNewExtCta}
            setNewExtNetwork={setNewExtNetwork}
            setNewExtPlacement={setNewExtPlacement}
            setNewExtTagline={setNewExtTagline}
            setNewExtTitle={setNewExtTitle}
            setNewExtUrl={setNewExtUrl}
            setSelectedBrowseTable={setSelectedBrowseTable}
            setTab={handleSelectTab}
            tables={tables}
          />
    ),
  };

  return (
    <div className={`app-container ${navLayout === "left" ? "layout-sidebar" : "layout-top"} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <SkipLink />
      {/* #2471: first-run setup over the hub until this user completes it. #3256: "Sign up" inside the flow opens the checkout tab. */}
      <FirstRunGate userLogin={user.login} onOpenCheckout={() => handleSelectTab("checkout")} />
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={
          deleteTarget?.kind === "memory"
            ? "Delete memory?"
            : deleteTarget?.kind === "category"
              ? "Delete category?"
              : "Delete referral?"
        }
        footer={
          <>
            <Button
              type="button"
              variant="danger"
              onClick={() => void confirmDeleteTarget()}
            >
              Delete
            </Button>{" "}
            <Button type="button" variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
          </>
        }
      >
        <p>
          Delete {deleteTarget?.kind} &quot;{deleteTarget?.label}&quot;? This cannot be undone.
        </p>
      </Modal>
      {/* 1. Left Sidebar Navigation (When layout === 'left') */}
      {navLayout === "left" && (
        <NavigationMenu
          layout="left"
          onToggleLayout={handleToggleNavLayout}
          activeTab={tab}
          onSelectTab={(newTab) => {
            handleSelectTab(newTab);
            setTbdMenuOpen(false);
          }}
          alertBadgeCount={unreadAlerts}
          collapsed={sidebarCollapsed}
          onToggleCollapse={handleToggleSidebarCollapsed}
          user={user}
          agentStatus={{ dotClass: statusDotClass, label: statusLabel }}
          accountMode={accountMode}
          onToggleAccountMode={handleToggleAccountMode}
          theme={theme}
          onCycleTheme={handleCycleTheme}
          onAskAgent={handleAskAgent}
          visibleTabs={effectiveVisibleTabs}
          onSetVisibleTabs={handleSetVisibleTabs}
        />
      )}

      {/* Main Content Layout Container */}
      <div id="main-content" tabIndex={-1} className={navLayout === "left" ? "app-main-layout" : "app-top-layout"}>
        {/* Sub-Header for Left Sidebar mode OR Full Header for Top Nav mode */}
        {navLayout === "left" ? (
          <header className="app-sub-header">
            <div className="sub-header-left">
              <div className="sub-header-brand-crumbs">
                <span className="crumb-module">{getCrumb(tab)}</span>
                <span className="crumb-divider">{" / "}</span>
                <span className="crumb-subtitle top-nav-control">
                  {brokerModeLabel({
                    broker: tenantProviders.brokerId,
                    brokerLabel: selectedBrokerLabel,
                    accountMode,
                  })}
                </span>
              </div>
              <MarketStatusPill variant="sub-header" />
            </div>

            <div className="sub-header-right">
              {/* Global Stock Search Bar */}
              <StockSearchBar
                onSelectTab={(newTab) => {
                  handleSelectTab(newTab);
                  setTbdMenuOpen(false);
                }}
                onAskAgent={handleAskAgent}
              />

              {/* Universal Top Bar Refresh Button */}
              <Button
                variant="secondary"
                className="nav-refresh-btn top-nav-control"
                onClick={handleGlobalRefresh}
                disabled={isRefreshing}
                title={`Refresh active workspace & market data feeds${lastRefreshedAt ? ` (last refreshed: ${lastRefreshedAt})` : ""}`}
                aria-label="Refresh workspace data"
              >
                <span className={`nav-refresh-icon ${isRefreshing ? "spin" : ""}`}>↻</span>
                <span className="nav-refresh-text">Refresh</span>
                {lastRefreshedAt && <span className="nav-refresh-time">{lastRefreshedAt}</span>}
              </Button>

              {/* Trade Button (Orange/Amber pill matching reference) */}
              <Button
                variant="secondary"
                className="nav-trade-btn top-nav-control"
                onClick={() => {
                  handleSelectTab("order");
                  setTbdMenuOpen(false);
                }}
                title="Quick Trade & Fast Order Ticket"
              >
                Trade
              </Button>

              {/* User Sign Out — Top Right Corner Fixed Icon with Hover Tooltip */}
              {user && (
                <a
                  href="/auth/logout"
                  className="top-nav-logout-btn icon-only-logout"
                  title={`Sign Out (@${user.login} · ${user.name})`}
                  aria-label="Sign out"
                >
                  <span className="top-nav-logout-icon"><NavIcons.Logout /></span>
                </a>
              )}
            </div>
          </header>
        ) : (
          <header className="app-top-header nextgentp-top-header app-header">
            <NavigationMenu
              layout="top"
              alertBadgeCount={unreadAlerts}
              onToggleLayout={handleToggleNavLayout}
              activeTab={tab}
              onSelectTab={(newTab) => {
                handleSelectTab(newTab);
                setTbdMenuOpen(false);
              }}
              user={user}
              agentStatus={{ dotClass: statusDotClass, label: statusLabel }}
              accountMode={accountMode}
              onToggleAccountMode={handleToggleAccountMode}
              onRefresh={handleGlobalRefresh}
              isRefreshing={isRefreshing}
              lastRefreshedAt={lastRefreshedAt}
              theme={theme}
              onCycleTheme={handleCycleTheme}
              onAskAgent={handleAskAgent}
              visibleTabs={effectiveVisibleTabs}
              onSetVisibleTabs={handleSetVisibleTabs}
            />
          </header>
        )}

      {/* Real-Time Market Ticker Tape (Streaming Live Benchmark Quotes, Optional - Default OFF) */}
      {tickerEnabled && (
        <MarketTickerTape
          onSelectTab={(newTab) => {
            handleSelectTab(newTab);
            setTbdMenuOpen(false);
          }}
          onSelectSymbol={(sym) => {
            handleAskAgent(`Quote and analyze ${sym}`);
          }}
        />
      )}

      {/* External Ad Network Monetization Strip (Configurable via Settings) */}
      {effectiveAdBannerConfig.enabled && effectiveAdBannerConfig.showAdNetworkStrip && Boolean(effectiveAdBannerConfig.tabVisibility[tab]) && externalAds.length > 0 && externalAds[activeExtAdIndex] && (
        <div className="external-ad-banner-strip">
          <div className="ext-ad-badge-group">
            <span className="ext-network-badge">
              {externalAds[activeExtAdIndex].network === "google" || externalAds[activeExtAdIndex].network === "adsense"
                ? "🌐 Google Ads"
                : externalAds[activeExtAdIndex].network === "ethicalads"
                ? "🛡️ EthicalAds"
                : externalAds[activeExtAdIndex].network === "carbon"
                ? "⚡ Carbon Ads"
                : "⭐ Direct Partner"}
            </span>
            <span className="ext-placement-badge">
              {externalAds[activeExtAdIndex].placement.replace("_", " ").toUpperCase()}
            </span>
          </div>

          <div className="ext-ad-content">
            <span className="ext-ad-title">{externalAds[activeExtAdIndex].title}</span>
            <span className="ext-ad-divider">—</span>
            <span className="ext-ad-tagline">{externalAds[activeExtAdIndex].tagline}</span>
          </div>

          <div className="ext-ad-earnings-pill" title="Live platform revenue generated by this placement">
            💰 CPM: ${externalAds[activeExtAdIndex].cpmRate.toFixed(2)} | CPC: ${externalAds[activeExtAdIndex].cpcRate.toFixed(2)} | Earned: ${externalAds[activeExtAdIndex].earnings.toFixed(2)}
          </div>

          <div className="ext-ad-actions">
            <Button
              variant="primary"
              onClick={() => handleExternalAdClick(externalAds[activeExtAdIndex])}
            >
              {externalAds[activeExtAdIndex].ctaText}
            </Button>
            {externalAds.length > 1 && (
              <Button
                variant="secondary"
                size="sm"
                title="View next ad in rotation"
                onClick={() => setActiveExtAdIndex((prev) => (prev + 1) % externalAds.length)}
              >
                ↻ Next ({activeExtAdIndex + 1}/{externalAds.length})
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Main Tab Content */}
      <main className="tab-viewport">
        {!isTabFeatureEnabled(tab) ? (
          <FeatureDisabledNotice
            featureName={TAB_TO_FEATURE_MAP[tab]}
            tabLabel={tab}
          />
        ) : (
          <>
            {TAB_CONTENT[tab] ??
              (isTradingTab(tab) ? null : (
                <Notice tone="warning" title="Missing tab content">
                  No content is wired for tab &ldquo;{tab}&rdquo; yet. This is a
                  wiring gap, not an empty tab.
                </Notice>
              ))}

        {/* Shell-retained pages (#2149): always mounted, hidden unless
            active, so in-flight work and state survive tab switches. */}
        {[...SHELL_RETAINED_PAGES].map((pageId) => (
          <div key={pageId} hidden={tab !== pageId}>
            {SHELL_CONTENT[pageId]}
          </div>
        ))}

        {/* Agentic Trading Hub */}
        {/* Kept mounted (hidden) so in-flight and finished requests survive tab switches */}
        <div className="trading-view" hidden={!isTradingTab(tab)}>
          {!isBrokerId(tenantProviders.brokerId) ? (
            <Notice tone="warning" title="[FAILURE_BROKER_UNAVAILABLE] Broker surface unavailable">
              {brokerUnavailableNotice(tenantProviders.brokerId, selectedBrokerLabel)}
            </Notice>
          ) : (
          <ErrorBoundary label={`${selectedBrokerLabel} Trading Hub`}>
          <TradeHub
            user={user}
            activeSubTab={mapTabToTradingSubTab(tab)}
            pendingOrderContext={pendingOrderContext}
            onConsumePendingOrderContext={() => setPendingOrderContext(null)}
            onSelectSubTab={(newSubTab) => {
              handleSelectTab(newSubTab);
            }}
            onBrokerPropsChange={setBrokerProps}
            onUnreadAlertsChange={setUnreadAlerts}
            onSendPrompt={(prompt, sourceTab) => {
              setPendingPrompt({ prompt, sourceTab: sourceTab || `${selectedBrokerLabel} Brokerage` });
              handleSelectTab("chat");
            }}
          />
          </ErrorBoundary>
          )}
        </div>

          </>
        )}
      </main>
      </div>

      {/* Floating Ask Agent Widget (Docked bottom-right) */}
      <AskAgentWidget
        onAskAgent={handleAskAgent}
        onOpenFullChat={() => {
          handleSelectTab("chat");
          setTbdMenuOpen(false);
        }}
        agentStatus={{ dotClass: statusDotClass, label: statusLabel }}
        activeTab={tab}
      />

      {/* Settings trigger (issues 3696/3697/3828): fixed
          bottom-left, rendered by the shell OUTSIDE both nav modes (not
          in side-nav), so it stays reachable under any preset including
          `none`. */}
      <Button
        variant="secondary"
        size="sm"
        title="Settings"
        aria-label="Settings"
        onClick={() => handleSelectTab("nav-settings")}
        style={{
          position: "fixed",
          left: "var(--space-3, 0.75rem)",
          bottom: "var(--space-3, 0.75rem)",
          zIndex: 1000,
        }}
      >
        <NavIcons.Settings /> Settings
      </Button>

      {/* Externalized Partner Deals & Showcase Modal */}
      <PartnerDealsModal
        isOpen={showPartnerDealsModal}
        onClose={() => setShowPartnerDealsModal(false)}
        ads={ads}
        externalAds={externalAds}
        onAdClick={handleAdClick}
        onExternalAdClick={handleExternalAdClick}
      />
    </div>
  );
}
