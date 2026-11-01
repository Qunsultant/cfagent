import React, { useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { startPolling } from "./polling";
import { getPollingConfig } from "./pollingConfig";
import { useAutoRefresh } from "./autoRefresh";
import { useTenantProviders, BROKER_OPTIONS, brokerUnavailableNotice } from "./tenantProviders";
import { BRAND } from "./branding";
import { apiFetch as fetch } from "./apiFetch";
import { McpApiExplorer } from "./McpApiExplorer";
import { GoogleAdUnit } from "./GoogleAdUnit";
import { ETradeTradingHub } from "./ETradeTradingHub";
import { ErrorBoundary } from "./ErrorBoundary";
import { FirstRunGate } from "./FirstRunGate";
import { SettingsMenu, type ETradeDynamicMenuProps } from "./ETradeDynamicMenu";
import { MarketDataResearchHub } from "./MarketDataResearchHub";
import { OptionsFlowsHub } from "./options/flows";
import { OptionsScreenerPage } from "./OptionsScreenerPage";
import { WorkflowsHub } from "./WorkflowsHub";
import { WorkflowRunsPanel } from "./WorkflowRunsPanel";
import { AgentsPanel } from "./AgentsPanel";
import { AdBannerConfig, applyServerAdsConfig, getStoredAdBannerConfig, saveStoredAdBannerConfig, type ServerAdsConfig } from "./adBannerConfig";
import { PartnerDealsModal } from "./components/PartnerDealsModal";
import { NavigationMenu, NavTabId, NavLayoutMode, NavIcons, DEFAULT_VISIBLE_NAV_TABS } from "./components/NavigationMenu";
import { navigateToTab, readTabFromLocation, subscribeToRouteChanges } from "./router";
import { getCrumb } from "./routes";
import { StockSearchBar } from "./components/StockSearchBar";
import { MarketTickerTape } from "./components/MarketTickerTape";
import { AuditEventCard } from "./components/AuditEventCard";
import { MarketStatusPill } from "./components/MarketStatusPill";
import { AskAgentWidget } from "./components/AskAgentWidget";
import { getStoredTheme, applyTheme, ThemeMode, initThemeListener } from "./theme";
import { adAccentPalette } from "./designTokens";
import { Button, TextInput, Badge, Select, Table, Card, Notice, Modal, PageShell, PageSection, EmptyState } from "./components/ui";
import { MarkdownContent } from "./chat/MarkdownContent";
import { renderInlineFormatted } from "./chat/renderInlineFormatted";
import { ReasoningView } from "./chat/ReasoningView";
import { ToolResultView } from "./chat/ToolResultView";
import { AgentChatTabContent } from "./chat/AgentChatTabContent";
import { isTradingTab, mapTabToTradingSubTab, SHELL_RETAINED_PAGES } from "./chat/types";
import type { User, AuditLogEvent, MemoryItem, ReferralItem, AdItem, CategoryItem, ExternalAdItem, RevenueSummaryData, TableMetadataItem } from "./chat/types";
import { ReferralsTab } from "./chat/tabs/ReferralsTab";
import { AdsTab } from "./chat/tabs/AdsTab";
import { RevenueTab } from "./chat/tabs/RevenueTab";
import { EndpointsTab } from "./chat/tabs/EndpointsTab";
import { ApprovalsPanel } from "./ApprovalsPanel";
import { DocsAndReportsPanel } from "./DocsAndReportsPanel";
import { PaymentWorkflowAssurance } from "./PaymentWorkflowAssurance";
import { CheckoutPanel } from "./CheckoutPanel";
import { SocialPostingPanel } from "./SocialPostingPanel";
import { PaymentsPage } from "./PaymentsPage";
import { SearchHub } from "./search/SearchHub";
import {
  isTabFeatureEnabled,
  TAB_TO_FEATURE_MAP,
  FeatureDisabledNotice,
} from "./featureFlags";
export function Chat({ user }: { user: User }) {
  const [tab, setTab] = useState<NavTabId>(() => {
    // S1 (#1808): the URL is the source of truth for navigation.
    const fromUrl = readTabFromLocation();
    // Issue #1806: Screener-first rollout — if default from url is autopilot, but autopilot is disabled and screener is enabled, start on screeners
    if (fromUrl === "autopilot" && typeof window !== "undefined" && !window.location.search.includes("tab=autopilot")) {
      if (isTabFeatureEnabled("screeners") && !isTabFeatureEnabled("autopilot")) {
        return "screeners";
      }
      if (!isTabFeatureEnabled("autopilot")) {
        return isTabFeatureEnabled("screeners") ? "screeners" : "chat";
      }
    }
    return fromUrl;
  });
  // S1 (#1808): the URL is the source of truth for navigation. Tab state
  // follows the router: the initial ?tab=, back/forward, and every
  // navigation through handleSelectTab below.
  useEffect(() => subscribeToRouteChanges(() => { setTab(readTabFromLocation()); }), []);
  // Accepts values and updater functions, like the state setter it
  // replaces (the trading view passes it as setTab): updaters resolve
  // against the current URL tab, which mirrors tab state.
  const handleSelectTab = useCallback(
    (next: string | ((prev: NavTabId) => NavTabId)) => {
      navigateToTab(typeof next === "function" ? next(readTabFromLocation()) : next);
    },
    [],
  );
  const [brokerProps, setBrokerProps] = useState<ETradeDynamicMenuProps | null>(null);
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const [tbdMenuOpen, setTbdMenuOpen] = useState(false);
  const isTbdTab = tab === "chat" || tab === "nlq" || tab === "audit" || tab === "payments" || tab === "referrals" || tab === "ads" || tab === "revenue";

  // NextGenTP Navigation Layout state (flexible top or left sidebar)
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
  const [accountMode, setAccountMode] = useState<"paper" | "live">("paper");

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

  // Visible navbar tabs customization state (persisted across sessions)
  const [visibleTabs, setVisibleTabs] = useState<Record<string, boolean>>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("nextgentp_visible_nav_tabs");
        if (saved) return { ...DEFAULT_VISIBLE_NAV_TABS, ...JSON.parse(saved) };
      } catch {}
    }
    return DEFAULT_VISIBLE_NAV_TABS;
  });

  const handleToggleTabVisibility = (tabId: string) => {
    setVisibleTabs((prev) => {
      const next = {
        ...prev,
        [tabId]: prev[tabId] === false ? true : false,
      };
      if (typeof window !== "undefined") {
        localStorage.setItem("nextgentp_visible_nav_tabs", JSON.stringify(next));
      }
      return next;
    });
  };

  const handleSetVisibleTabs = (newTabs: Record<string, boolean>) => {
    setVisibleTabs(newTabs);
    if (typeof window !== "undefined") {
      localStorage.setItem("nextgentp_visible_nav_tabs", JSON.stringify(newTabs));
    }
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
  const selectedBrokerLabel = BROKER_OPTIONS.find((o) => o.id === tenantProviders.brokerId)?.label ?? tenantProviders.brokerId;
  const autoRefreshEnabled = autoRefreshState.enabled;
  const autoRefreshInterval = autoRefreshState.interval;

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
      console.warn("Failed to contact /api/clear:", err);
      setChatResetNotice("Chat session reset locally.");
      setTimeout(() => setChatResetNotice(null), 3000);
    } finally {
      setIsResettingChat(false);
      setChatStatus("ready");
      setChatNonce((n) => n + 1);
    }
  };

  // NLQ state
  const [nlqInput, setNlqInput] = useState("");
  const [nlqResult] = useState<any>(null);

  // Audit state
  const [auditEvents, setAuditEvents] = useState<AuditLogEvent[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

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

  // Record impression whenever active external ad changes
  useEffect(() => {
    if (externalAds.length > 0 && externalAds[activeExtAdIndex]) {
      recordExternalAdImpression(externalAds[activeExtAdIndex]);
    }
  }, [activeExtAdIndex, externalAds.length]);

  // Load tab-specific data when tab changes
  useEffect(() => {
    if (tab === "audit") {
      fetchAuditData();
    } else if (tab === "referrals") {
      fetchReferrals();
      fetchCategories();
    } else if (tab === "ads") {
      fetchAds();
    } else if (tab === "revenue") {
      fetchRevenueSummary();
      fetchExternalAds();
      fetchCategories();
      fetchTables();
    } else if (tab === "nlq") {
      fetchTables();
    }
  }, [tab]);

  const fetchAuditData = async () => {
    setAuditLoading(true);
    try {
      const [auditResp, memResp] = await Promise.all([
        fetch("/api/audit?limit=30").then((r) => r.json() as Promise<{ events?: AuditLogEvent[] }>).catch(() => ({ events: [] })),
        fetch("/api/memory").then((r) => r.json() as Promise<{ memories?: MemoryItem[] }>).catch(() => ({ memories: [] })),
      ]);
      setAuditEvents(auditResp.events || []);
      setMemories(memResp.memories || []);
    } finally {
      setAuditLoading(false);
    }
  };

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

  const handleDeleteMemory = async (key: string) => {
    setDeleteTarget({ kind: "memory", id: key, label: key });
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
      } else {
        await fetch(`/api/memory?key=${encodeURIComponent(target.id)}`, { method: "DELETE" });
        setMemories((prev) => prev.filter((m) => m.key !== target.id));
      }
    } catch {
      // Ignore
    }
  };

  // #2077 (#1804 S6): the route-table-derived content switch. One
  // table-keyed lookup replaces the 14 inline {tab === ...} conditionals
  // that used to live in <main>; coverage is pinned against ROUTES in
  // tests/route_content_switch_1804.test.ts. Trading ids have no entry
  // here — they render through the retained ETradeTradingHub below,
  // hidden for non-trading tabs via isTradingTab (table-backed retain
  // flags, see routes.ts). docs previously rendered blank; its existing
  // panel is wired here (no props).
  const TAB_CONTENT: Record<string, ReactNode> = {
    agents: (
      <ErrorBoundary label="Agents">
        <AgentsPanel />
      </ErrorBoundary>
    ),
    approvals: (
          <ApprovalsPanel />
    ),
    audit: (
          <div className="audit-view">
            <PageShell
              title="System Audit & Memory Vault"
              scopeNote="Live observability stream into router decisions, sub-agent executions, AI decision evaluations, and firm memory state."
            >
            <div>
              <Button variant="secondary" size="sm" onClick={fetchAuditData} disabled={auditLoading} loading={auditLoading}>
                {"🔄 Refresh Data"}
              </Button>
            </div>

            <div className="audit-grid">
              {/* Memory Vault Panel */}
              <PageSection>
              <Card padding="none" className="audit-panel memory-panel">
                <div className="panel-title">
                  <span>🧠 Persistent Memory Vault</span>
                  <Badge size="xs" tone="info">{memories.length} facts</Badge>
                </div>
                <div className="memory-list">
                  {memories.length === 0 ? (
                    <EmptyState icon="🧠" title="No memories saved yet" description='Try asking the assistant to "Remember that..."' />
                  ) : (
                    memories.map((m) => (
                      <Card padding="none" key={m.key} className="memory-card-item">
                        <div className="mem-header">
                          <span className="mem-key">🔑 {m.key}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteMemory(m.key)}
                            title="Delete memory"
                          >
                            ×
                          </Button>
                        </div>
                        <div className="mem-value">{m.value}</div>
                        <div className="mem-date">{new Date(m.updatedAt).toLocaleString()}</div>
                      </Card>
                    ))
                  )}
                </div>
              </Card>
              </PageSection>

              {/* Audit Events Panel */}
              <PageSection>
              <Card padding="none" className="audit-panel events-panel">
                <div className="panel-title">
                  <span>📋 Real-time Event Log</span>
                  <Badge size="xs" tone="info">{auditEvents.length} events</Badge>
                </div>
                <div className="events-stream">
                  {auditEvents.length === 0 ? (
                    <EmptyState icon="📋" title="No audit events logged yet" />
                  ) : (
                    auditEvents.map((e) => (
                      <AuditEventCard key={e.id} event={e} />
                    ))
                  )}
                </div>
              </Card>
              </PageSection>
            </div>
            </PageShell>
          </div>
    ),
    chat: (
          <AgentChatTabContent
            key={chatNonce}
            user={user}
            ads={ads}
            showSponsorSpotlight={effectiveAdBannerConfig.enabled && effectiveAdBannerConfig.showSponsorSpotlight && Boolean(effectiveAdBannerConfig.tabVisibility.chat)}
            onAdClick={handleAdClick}
            onOpenAdsTab={() => {
              handleSelectTab("ads");
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
    nlq: (
          <div className="nlq-view">
            <PageShell
              title="Natural Language Records & Audit Analytics"
              scopeNote="Query business records, inspect enterprise data schemas, retrieve transaction records, and manage commercial categories with natural language or interactive record browsing."
            >
            <PageSection>

            <div className="nlq-presets">
              <span className="preset-label">Natural Language Queries:</span>
              <Button
                variant="secondary"
                tone="subtle"
                size="sm"
                onClick={() => setNlqInput("List all database tables and schema")}
              >
                🗄️ List tables & schema
              </Button>
              <Button
                variant="secondary"
                tone="subtle"
                size="sm"
                onClick={() => setNlqInput("Show referral categories in categories table")}
              >
                🏷️ Show categories table data
              </Button>
              <Button
                variant="secondary"
                tone="subtle"
                size="sm"
                onClick={() => setNlqInput("Add category 'Web3 & Crypto' to categories table")}
              >
                ➕ Add category 'Web3 & Crypto'
              </Button>
              <Button
                variant="secondary"
                tone="subtle"
                size="sm"
                onClick={() => setNlqInput("Show external ads inventory and earnings")}
              >
                📢 Show external ads & earnings
              </Button>
              <Button
                variant="secondary"
                tone="subtle"
                size="sm"
                onClick={() => setNlqInput("Show transactions and payment records")}
              >
                💳 Show transaction ledger
              </Button>
              <Button
                variant="secondary"
                tone="subtle"
                size="sm"
                onClick={() => setNlqInput("List all user questions asked")}
              >
                💬 List user questions
              </Button>
            </div>

            <form className="chat-input-bar nlq-bar" onSubmit={(event) => {
              event.preventDefault();
              if (nlqInput.trim()) {
                setPendingPrompt({ prompt: nlqInput.trim(), sourceTab: "Records Explorer" });
                setNlqInput("");
                handleSelectTab("chat");
              }
            }}>
              <TextInput
                type="text"
                value={nlqInput}
                onChange={(e) => setNlqInput(e.target.value)}
                placeholder="Ask the shared chat about database records or categories…"
              />
              <Button type="submit" variant="primary" disabled={!nlqInput.trim() || isBusy}>
                Ask in Chat
              </Button>
            </form>
            </PageSection>

            <PageSection>
            {/* Direct ORM Table Explorer Toolbar */}
            <div className="nlq-orm-toolbar">
              <span className="orm-tag">⚡ RECORD EXPLORER:</span>
              <Select
                value={selectedBrowseTable}
                onChange={(e) => setSelectedBrowseTable(e.target.value)}
                className="orm-table-select"
              >
                <option value="mas_categories">🏷️ mas_categories (Referral Categories)</option>
                <option value="mas_referrals">🔗 mas_referrals (Referral Links)</option>
                <option value="mas_external_ads">📡 mas_external_ads (Ad Networks)</option>
                <option value="mas_ads">🚀 mas_ads (Sponsored Deals)</option>
                <option value="mas_transactions">💳 mas_transactions (Payments & DIDs)</option>
                <option value="mas_messages">💬 mas_messages (Conversation History)</option>
                <option value="mas_memory">🧠 mas_memory (Session Facts)</option>
                <option value="mas_events">🛡️ mas_events (Audit Log)</option>
              </Select>

              <TextInput
                value={browseSearch}
                onChange={(e) => setBrowseSearch(e.target.value)}
                placeholder="Search table text…"
                aria-label="Search table text"
                style={{ flex: 1, minWidth: 180 }}
              />

              <Button
                variant="primary"
                onClick={() => browseTable(selectedBrowseTable, browseSearch)}
                loading={browsingLoading}
              >
                {"🔍 Browse Records"}
              </Button>
            </div>

            {/* Direct Table Browsing Results (if opened) */}
            {browsedData && (
              <Card padding="none" className="nlq-results-card orm-browsed-card">
                <div className="browsed-card-header">
                  <div className="browsed-title">
                    <span>🗄️ Table Data: <strong>{browsedData.tableName}</strong></span>
                    <Badge size="xs" tone="neutral">{browsedData.total} Total Records</Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setBrowsedData(null)}
                    title="Close browsed table"
                  >
                    ✕ Close
                  </Button>
                </div>

                {browsedData.rows && browsedData.rows.length > 0 ? (
                  <div className="results-table-container">
                    <Table
                      columns={Object.keys(browsedData.rows[0]).map((col) => ({
                        key: col,
                        header: col,
                        cellClassName: "table-data-cell",
                        render: (row: any) => (typeof row[col] === "object" && row[col] !== null ? JSON.stringify(row[col]) : String(row[col] ?? "—")),
                      }))}
                      rows={browsedData.rows.map((row: any, i: number) => ({ ...row, __rowKey: String(i) }))}
                      rowKey={(row: any) => row.__rowKey}
                      onRowClick={(row: any) => setBrowsedDetailRow(row)}
                    />
                  </div>
                ) : (
                  <EmptyState title={`No records found in table ${browsedData.tableName}`} />
                )}
              </Card>
            )}
            {/* #1968: full-payload detail view. Table cells show one-line
                values; a JSON TEXT column (e.g. mas_events.payload) is only
                usable expanded, so clicking a row opens the whole record
                as pretty JSON — string values that parse as JSON are
                expanded one level (payload text becomes an object). */}
            {browsedDetailRow && (
              <Modal
                open={true}
                onClose={() => setBrowsedDetailRow(null)}
                title={`Record detail: ${browsedData?.tableName ?? "row"}`}
              >
                <pre className="event-payload">{(() => {
                  const expanded: Record<string, unknown> = {};
                  for (const [k, v] of Object.entries(browsedDetailRow)) {
                    if (k === "__rowKey") continue;
                    if (typeof v === "string") {
                      try { expanded[k] = JSON.parse(v); } catch { expanded[k] = v; }
                    } else {
                      expanded[k] = v;
                    }
                  }
                  return JSON.stringify(expanded, null, 2);
                })()}</pre>
              </Modal>
            )}
            </PageSection>

            {/* Natural Language Query Planner & Execution Results */}
            {nlqResult && (
              <PageSection>
              <Card padding="none" className="nlq-results-card">
                {nlqResult.plan && (
                  <div className="plan-badge-group">
                    <Badge size="md" tone="neutral">Domain: <strong>{nlqResult.domain || nlqResult.plan.domain}</strong></Badge>
                    <Badge size="md" tone="neutral">Operation: <strong>{nlqResult.plan.operation}</strong></Badge>
                    {nlqResult.plan.terms && <Badge size="md" tone="neutral">Terms: <strong>"{nlqResult.plan.terms}"</strong></Badge>}
                    <Badge size="md" tone="trade">Matched: <strong>{nlqResult.count}</strong></Badge>
                  </div>
                )}

                {nlqResult.summary && (
                  <Notice tone="info">
                    ℹ️ {nlqResult.summary}
                  </Notice>
                )}

                {/* Domain: Tables & Schemas Rendering */}
                {nlqResult.domain === "tables" && nlqResult.rows && nlqResult.rows.length > 0 && (
                  <div className="tables-schema-grid">
                    {nlqResult.rows.map((tbl: any, idx: number) => (
                      <Card padding="none" key={idx} className="table-schema-card">
                        <div className="schema-card-top">
                          <span className="schema-table-icon">🗄️</span>
                          <h5><code>{tbl.tableName}</code></h5>
                          <Badge size="xs" tone="neutral">{tbl.rowCount} rows</Badge>
                        </div>
                        <p className="schema-desc">{tbl.description}</p>
                        <div className="schema-cols-preview">
                          <span className="cols-count-label">{tbl.columnCount} columns:</span>
                          <span className="cols-string">{tbl.columns}</span>
                        </div>
                        <Button
                          className="browse-data-btn"
                          variant="primary"
                          tone="subtle"
                          size="sm"
                          onClick={() => {
                            setSelectedBrowseTable(tbl.tableName);
                            browseTable(tbl.tableName);
                          }}
                        >
                          🔍 Browse Records →
                        </Button>
                      </Card>
                    ))}
                  </div>
                )}

                {/* Domain: Category Mutation Rendering */}
                {nlqResult.domain === "category_mutation" && nlqResult.rows && (
                  <div className="category-mutation-result">
                    <div className="results-table-container">
                      <Table
                      columns={[
                        { key: "icon", header: "Icon", align: "center", render: (cat: any) => <span style={{ fontSize: "1.25rem", textAlign: "center" }}>{cat.icon}</span> },
                        { key: "name", header: "Category", render: (cat: any) => <strong>{cat.name}</strong> },
                        { key: "slug", header: "Slug", render: (cat: any) => <code>{cat.slug}</code> },
                        { key: "desc", header: "Description", render: (cat: any) => <>{cat.description}</> },
                        { key: "order", header: "Order", render: (cat: any) => <>{cat.sortOrder}</> },
                        { key: "status", header: "Status", render: (cat: any) => <Badge size="xs" uppercase tone={cat.status === "ACTIVE" ? "success" : "neutral"}>{cat.status}</Badge> },
                      ]}
                      rows={nlqResult.rows.map((cat: any, i: number) => ({ ...cat, __rowKey: String(i) }))}
                      rowKey={(row: any) => row.__rowKey}
                    />
                    </div>
                  </div>
                )}

                {/* Domain: Table Data Dynamic Rendering */}
                {nlqResult.domain === "table_data" && nlqResult.rows && nlqResult.rows.length > 0 && (
                  <div className="results-table-container">
                    <Table
                      columns={Object.keys(nlqResult.rows[0]).map((col) => ({
                        key: col,
                        header: col,
                        cellClassName: "table-data-cell",
                        render: (row: any) => (typeof row[col] === "object" && row[col] !== null ? JSON.stringify(row[col]) : String(row[col] ?? "—")),
                      }))}
                      rows={nlqResult.rows.map((row: any, i: number) => ({ ...row, __rowKey: String(i) }))}
                      rowKey={(row: any) => row.__rowKey}
                    />
                  </div>
                )}

                {/* Domain: Conversation History Rendering */}
                {nlqResult.domain === "conversation" && nlqResult.rows && nlqResult.rows.length > 0 && (
                  <div className="results-table-container">
                    <Table
                      columns={[
                        { key: "role", header: "Role", render: (row: any) => <Badge size="xs" tone={row.role === "user" || row.role === "assistant" ? "info" : "neutral"}>{row.role || (row.count !== undefined ? "count" : "")}</Badge> },
                        { key: "agent", header: "Agent", render: (row: any) => <>{row.agent || "—"}</> },
                        { key: "content", header: "Content", cellClassName: "content-cell", render: (row: any) => <>{row.content || (row.count !== undefined ? `Count: ${row.count}` : JSON.stringify(row))}</> },
                        { key: "timestamp", header: "Timestamp", cellClassName: "timestamp-cell", render: (row: any) => <>{row.created_at ? new Date(row.created_at).toLocaleTimeString() : "—"}</> },
                      ]}
                      rows={nlqResult.rows.map((row: any, i: number) => ({ ...row, __rowKey: String(i) }))}
                      rowKey={(row: any) => row.__rowKey}
                    />
                  </div>
                )}

                {(!nlqResult.rows || nlqResult.rows.length === 0) && (
                  <EmptyState title="No records matched the natural language query criteria." />
                )}
              </Card>
              </PageSection>
            )}
            </PageShell>
          </div>
    ),
    "options-flows": (
          <div className="options-flows-view" style={{ width: "100%", height: "100%", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <OptionsFlowsHub
              user={user}
              onSendPrompt={(prompt, sourceTab) => {
                setPendingPrompt({ prompt, sourceTab: sourceTab || "Options Flows" });
                handleSelectTab("chat");
              }}
              onTradeSymbol={(symbol) => {
                handleSelectTab("order");
              }}
            />
          </div>
    ),
    // Issue #2596, slice 1: the Options Screener's own page. It is
    // not a retained trading-hub tab, so it lives in TAB_CONTENT
    // like the other standalone pages; its cards link to the
    // existing surfaces, they do not re-render them.
    "options-screener": (
      <OptionsScreenerPage
        onSelectTab={(newTab) => {
          handleSelectTab(newTab);
          setTbdMenuOpen(false);
        }}
      />
    ),
    "payment-assurance": (
          <PaymentWorkflowAssurance userLogin={user.login} />
    ),
    "checkout": (
          <CheckoutPanel userLogin={user.login} />
    ),
    research: (
          <div className="research-view">
            <MarketDataResearchHub
              user={user}
              onSendPrompt={(prompt, sourceTab) => {
                setPendingPrompt({ prompt, sourceTab: sourceTab || "Yahoo Finance Research" });
                handleSelectTab("chat");
              }}
              onTradeSymbol={(symbol) => {
                handleSelectTab("order");
              }}
            />
          </div>
    ),
    search: (
      <ErrorBoundary label="Search">
        <SearchHub />
      </ErrorBoundary>
    ),
    "workflow-runs": (
          <WorkflowRunsPanel />
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
    social: <SocialPostingPanel active={tab === "social"} />,
    ads: (
          <AdsTab
            adFormError={adFormError}
            adFormSuccess={adFormSuccess}
            ads={ads}
            adsLoading={adsLoading}
            fetchAds={fetchAds}
            handleAdClick={handleAdClick}
            handleCreateAd={handleCreateAd}
            newAdColor={newAdColor}
            newAdCta={newAdCta}
            newAdSponsor={newAdSponsor}
            newAdTagline={newAdTagline}
            newAdTitle={newAdTitle}
            newAdUrl={newAdUrl}
            savingAd={savingAd}
            setNewAdColor={setNewAdColor}
            setNewAdCta={setNewAdCta}
            setNewAdSponsor={setNewAdSponsor}
            setNewAdTagline={setNewAdTagline}
            setNewAdTitle={setNewAdTitle}
            setNewAdUrl={setNewAdUrl}
          />
    ),
    referrals: (
          <ReferralsTab
            activeShareRefId={activeShareRefId}
            adBannerConfig={effectiveAdBannerConfig}
            categories={categories}
            copiedReferral={copiedReferral}
            copiedShareRefId={copiedShareRefId}
            discordCopied={discordCopied}
            externalAds={externalAds}
            fetchReferrals={fetchReferrals}
            googleAdsEnabled={googleAdsEnabled}
            googlePublisherId={googlePublisherId}
            googleSlotId={googleSlotId}
            handleCopyDiscordEmbed={handleCopyDiscordEmbed}
            handleCopyPersonalRef={handleCopyPersonalRef}
            handleCopyRefDiscordEmbed={handleCopyRefDiscordEmbed}
            handleCreateReferral={handleCreateReferral}
            handleDeleteReferral={handleDeleteReferral}
            handleExternalAdClick={handleExternalAdClick}
            handleReferralClick={handleReferralClick}
            newRefCategory={newRefCategory}
            newRefReward={newRefReward}
            newRefTitle={newRefTitle}
            newRefUrl={newRefUrl}
            personalReferralUrl={personalReferralUrl}
            refFormError={refFormError}
            refFormSuccess={refFormSuccess}
            referrals={referrals}
            referralsLoading={referralsLoading}
            savingRef={savingRef}
            setActiveShareRefId={setActiveShareRefId}
            setNewRefCategory={setNewRefCategory}
            setNewRefReward={setNewRefReward}
            setNewRefTitle={setNewRefTitle}
            setNewRefUrl={setNewRefUrl}
            user={user}
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
      {/* #2471: first-run setup over the hub until this user completes it. */}
      <FirstRunGate userLogin={user.login} />
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
          onToggleAccountMode={() => setAccountMode((m) => (m === "paper" ? "live" : "paper"))}
          theme={theme}
          onCycleTheme={handleCycleTheme}
          onAskAgent={handleAskAgent}
          visibleTabs={visibleTabs}
        />
      )}

      {/* Main Content Layout Container */}
      <div className={navLayout === "left" ? "app-main-layout" : "app-top-layout"}>
        {/* Sub-Header for Left Sidebar mode OR Full Header for Top Nav mode */}
        {navLayout === "left" ? (
          <header className="app-sub-header">
            <div className="sub-header-left">
              <div className="sub-header-brand-crumbs">
                <span className="crumb-module">
                  {getCrumb(tab)}
                </span>
                <span className="crumb-divider">/</span>
                <span className="crumb-subtitle">
                  {accountMode === "paper" ? "Paper" : "Live Execution"}
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
                variant="ghost"
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
                variant="trade"
                onClick={() => {
                  handleSelectTab("order");
                  setTbdMenuOpen(false);
                }}
                title="Quick Trade & Fast Order Ticket"
              >
                Trade
              </Button>

              {/* Unified Settings & Broker Menu (Icon-only with hover) */}
              <SettingsMenu
                userLogin={user.login}
                userName={user.name}
                userAvatar={user.avatar}
                theme={theme}
                onCycleTheme={handleCycleTheme}
                onSelectTheme={handleSelectTheme}
                currentLayout={navLayout}
                onToggleLayout={handleToggleNavLayout}
                accountMode={accountMode}
                onToggleAccountMode={() => setAccountMode((m) => (m === "paper" ? "live" : "paper"))}
                visibleTabs={visibleTabs}
                onToggleTabVisibility={handleToggleTabVisibility}
                onSetVisibleTabs={handleSetVisibleTabs}
                autoRefreshEnabled={autoRefreshEnabled}
                autoRefreshInterval={autoRefreshInterval}
                onToggleAutoRefresh={handleToggleAutoRefresh}
                reportDispatchHitl={reportDispatchHitl}
                onToggleReportDispatchHitl={handleToggleReportDispatchHitl}
                pendingReportConfirmations={pendingReportConfirmations}
                onRefreshReportConfirmations={refreshPendingReportConfirmations}
                onDecideReportConfirmation={handleDecideReportConfirmation}
                adBannerConfig={effectiveAdBannerConfig}
                onUpdateAdBannerConfig={handleUpdateAdBannerConfig}
                onOpenPartnerDeals={() => setShowPartnerDealsModal(true)}
                {...(brokerProps || {})}
              />

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
              onToggleAccountMode={() => setAccountMode((m) => (m === "paper" ? "live" : "paper"))}
              onRefresh={handleGlobalRefresh}
              isRefreshing={isRefreshing}
              lastRefreshedAt={lastRefreshedAt}
              headerChildren={
                <SettingsMenu
                  userLogin={user.login}
                  userName={user.name}
                  userAvatar={user.avatar}
                  theme={theme}
                  onCycleTheme={handleCycleTheme}
                onSelectTheme={handleSelectTheme}
                  currentLayout={navLayout}
                  onToggleLayout={handleToggleNavLayout}
                  accountMode={accountMode}
                  onToggleAccountMode={() => setAccountMode((m) => (m === "paper" ? "live" : "paper"))}
                  visibleTabs={visibleTabs}
                  onToggleTabVisibility={handleToggleTabVisibility}
                  onSetVisibleTabs={handleSetVisibleTabs}
                  autoRefreshEnabled={autoRefreshEnabled}
                  autoRefreshInterval={autoRefreshInterval}
                  onToggleAutoRefresh={handleToggleAutoRefresh}
                reportDispatchHitl={reportDispatchHitl}
                onToggleReportDispatchHitl={handleToggleReportDispatchHitl}
                pendingReportConfirmations={pendingReportConfirmations}
                onRefreshReportConfirmations={refreshPendingReportConfirmations}
                onDecideReportConfirmation={handleDecideReportConfirmation}
                  adBannerConfig={effectiveAdBannerConfig}
                  onUpdateAdBannerConfig={handleUpdateAdBannerConfig}
                  onOpenPartnerDeals={() => setShowPartnerDealsModal(true)}
                  {...(brokerProps || {})}
                />
              }
              theme={theme}
              onCycleTheme={handleCycleTheme}
              onAskAgent={handleAskAgent}
              visibleTabs={visibleTabs}
            />
          </header>
        )}

      {/* Real-Time Market Ticker Tape (Streaming Live Benchmark Quotes) */}
      <MarketTickerTape
        onSelectTab={(newTab) => {
          handleSelectTab(newTab);
          setTbdMenuOpen(false);
        }}
        onSelectSymbol={(sym) => {
          handleAskAgent(`Quote and analyze ${sym}`);
        }}
      />

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

        {/* E*TRADE Agentic Trading Hub */}
        {/* Kept mounted (hidden) so in-flight and finished requests survive tab switches */}
        <div className="trading-view" hidden={!isTradingTab(tab)}>
          {tenantProviders.brokerId !== "etrade" ? (
            <Notice tone="warning" title="[FAILURE_BROKER_UNAVAILABLE] Broker surface unavailable">
              {brokerUnavailableNotice(tenantProviders.brokerId, selectedBrokerLabel)}
            </Notice>
          ) : (
          <ErrorBoundary label="E*TRADE Hub">
          <ETradeTradingHub
            user={user}
            activeSubTab={mapTabToTradingSubTab(tab)}
            onSelectSubTab={(newSubTab) => {
              handleSelectTab(newSubTab);
            }}
            onBrokerPropsChange={setBrokerProps}
            onUnreadAlertsChange={setUnreadAlerts}
            onSendPrompt={(prompt, sourceTab) => {
              setPendingPrompt({ prompt, sourceTab: sourceTab || "E*TRADE Brokerage" });
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
