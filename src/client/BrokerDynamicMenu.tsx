import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  NAVIGATION_ITEMS,
  DEFAULT_VISIBLE_NAV_TABS,
  NAV_TAB_PRESETS,
} from "./components/NavigationMenu";
import { isTabFeatureEnabled } from "./featureFlags";
import { PillGroup, Button, TextInput, Select } from "./components/ui";
import { AlpacaSignInCard } from "./AlpacaSignInCard";
import { apiFetch } from "./apiFetch";
import { syncTarget, connectStatusEndpoint } from "./brokerEndpoints";
import { brokerPresentation } from "../trading";
import { PublicTokenCard } from "./PublicTokenCard";
import { brokerCredentialGuidance, isBrokerId } from "../trading";
import { brokerOptions } from "./brokerOptions";
import { fetchWatchlists, type ETradeWatchlist } from "./accountApi";
import {
  loadTapeSelection,
  saveTapeSelection,
  subscribeTapeSelection,
  type TapeSetSelection,
} from "./quotes/symbolSetResolver";
import {
  switchBrokerEnvironment,
  useBrokerEnvironment,
  BROKER_ENV_CHANGED_EVENT,
  type BrokerEnvironment,
} from "./brokerEnvironment";
import {
  AdBannerConfig,
  getStoredAdBannerConfig,
  saveStoredAdBannerConfig,
} from "./adBannerConfig";
import { useAutoRefresh } from "./autoRefresh";
import { useTenantProviders, DATA_PROVIDER_OPTIONS, labelForDataProvider } from "./tenantProviders";
import { getPollingConfig } from "./pollingConfig";
import {
  FONT_SCALE_PRESETS,
  getStoredFontScale,
  applyTypography,
  adjustFontScale,
} from "./typography";
import {
  loadTickerEnabled,
  saveTickerEnabled,
  subscribeTickerEnabled,
} from "./quotes/tickerVisibility";

export interface SettingsMenuProps {
  /**
   * Environment value passed from parent or defaulted to single broker environment.
   */
  activeEnv?: "TEST" | "PROD";
  oauthStatus?: {
    authenticated?: boolean;
    renewable?: boolean;
    accessTokenExpiresAt?: string;
    environment?: string;
    error?: string;
  } | null;
  account?: {
    accountId?: string;
    accountDesc?: string;
    netAccountValue?: number;
  } | null;
  brokerStatus?: {
    environment?: string;
    activeEnvironment?: string;
  } | null;
  maskAccount?: boolean;
  setMaskAccount?: (val: boolean) => void;
  diagnosticsLoading?: boolean;
  oauthLoading?: boolean;
  oauthMsg?: string;
  setOauthMsg?: (msg: string) => void;
  handleSwitchEnvironment?: (env: "TEST" | "PROD") => void;
  handleSwitchAndConnect?: (env: "TEST" | "PROD") => void;
  runDiagnostics?: (brokerId?: string, overrideEnv?: string) => void;
  handleRenewOAuth?: () => void;
  handleRevokeOAuth?: () => void;
  handleStartOAuth?: () => void;
  onOpenEtapiTuning?: () => void;
  userLogin?: string;
  userName?: string;
  userAvatar?: string;
  defaultSymbol?: string;
  // System & appearance preferences
  theme?: string;
  onCycleTheme?: () => void;
  onSelectTheme?: (theme: "light" | "dark" | "high-contrast" | "system") => void;
  currentLayout?: "left" | "top";
  onToggleLayout?: (layout: "left" | "top") => void;
  accountMode?: "paper" | "live";
  onToggleAccountMode?: () => void;
  // Navbar Tab visibility customization
  visibleTabs?: Record<string, boolean>;
  onToggleTabVisibility?: (tabId: string) => void;
  onSetVisibleTabs?: (tabs: Record<string, boolean>) => void;
  // Centralized Auto-Refresh Settings
  autoRefreshEnabled?: boolean;
  autoRefreshInterval?: number;
  onToggleAutoRefresh?: (enabled: boolean, interval?: number) => void;
  // HITL confirmation for research-report dispatch
  reportDispatchHitl?: boolean;
  onToggleReportDispatchHitl?: (enabled: boolean) => void;
  pendingReportConfirmations?: Array<{
    confirmationId: string;
    kind: string;
    createdAt: string;
    detail: string;
  }>;
  onRefreshReportConfirmations?: () => void;
  onDecideReportConfirmation?: (confirmationId: string, decision: "approved" | "rejected") => void;
  // Ads & Sponsor Banners Configuration
  adBannerConfig?: AdBannerConfig;
  onUpdateAdBannerConfig?: (config: AdBannerConfig) => void;
  onOpenPartnerDeals?: () => void;
  /** Force the dropdown panel open on initial render (e.g. tests). */
  initialOpen?: boolean;
}

export type BrokerDynamicMenuProps = SettingsMenuProps;
export type ETradeDynamicMenuProps = SettingsMenuProps;

export function BrokerDynamicMenu({
  activeEnv,
  oauthStatus,
  account,
  brokerStatus,
  maskAccount,
  setMaskAccount,
  diagnosticsLoading = false,
  oauthLoading = false,
  oauthMsg = "",
  setOauthMsg,
  handleSwitchEnvironment,
  handleSwitchAndConnect,
  runDiagnostics,
  handleRenewOAuth,
  handleRevokeOAuth,
  handleStartOAuth,
  onOpenEtapiTuning,
  userLogin = "OpenAIMP",
  userName = "OpenAIMP",
  userAvatar,
  defaultSymbol = "NVDA",
  theme = "auto",
  onCycleTheme,
  onSelectTheme,
  currentLayout = "left",
  onToggleLayout,
  accountMode,
  onToggleAccountMode,
  visibleTabs,
  onToggleTabVisibility,
  onSetVisibleTabs,
  autoRefreshEnabled,
  autoRefreshInterval,
  onToggleAutoRefresh,
  reportDispatchHitl = false,
  onToggleReportDispatchHitl,
  pendingReportConfirmations = [],
  onRefreshReportConfirmations,
  onDecideReportConfirmation,
  adBannerConfig,
  onUpdateAdBannerConfig,
  onOpenPartnerDeals,
  initialOpen = false,
}: SettingsMenuProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPinned, setIsPinned] = useState(initialOpen);
  const menuRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [localMsg, setLocalMsg] = useState("");
  const [localDiagLoading, setLocalDiagLoading] = useState(false);
  const [showKeyPairSignIn, setShowKeyPairSignIn] = useState(false);
  // Issue #3990: the personal-token card toggle, mirroring the
  // key-pair toggle above — one open card per credential kind.
  const [showTokenCard, setShowTokenCard] = useState(false);

  // Central auto-refresh
  const [autoRefreshState, setAutoRefreshState] = useAutoRefresh();
  const [tenantProviders, setTenantProviders] = useTenantProviders();
  const [providerSaveError, setProviderSaveError] = useState("");
  const handleSetTenantProviders = (next: { dataProviderId: string; brokerId: string }) => {
    setProviderSaveError("");
    void setTenantProviders(next).catch(() => {
      setProviderSaveError("Could not save provider selection. The previous selection is still in effect.");
    });
  };
  const effectiveAutoRefreshEnabled = autoRefreshEnabled !== undefined ? autoRefreshEnabled : autoRefreshState.enabled;
  const effectiveAutoRefreshInterval = autoRefreshInterval !== undefined ? autoRefreshInterval : autoRefreshState.interval;

  const handleSetAutoRefresh = (enabled: boolean, interval?: number) => {
    if (onToggleAutoRefresh) {
      onToggleAutoRefresh(enabled, interval);
    } else {
      setAutoRefreshState(enabled, interval);
    }
  };

  // Ticker and Tape selection
  const [tickerEnabled, setTickerEnabled] = useState<boolean>(() => loadTickerEnabled());
  useEffect(() => {
    return subscribeTickerEnabled((val) => setTickerEnabled(val));
  }, []);

  const handleToggleTicker = (enabled: boolean) => {
    setTickerEnabled(enabled);
    saveTickerEnabled(enabled);
  };

  const [quoteSource, setQuoteSource] = useState<"auto" | "alpaca" | "yahoo">("auto");
  const [tapeSelection, setTapeSelection] = useState<TapeSetSelection>(() => loadTapeSelection() ?? { kind: "default" });
  const [tapeCustomDraft, setTapeCustomDraft] = useState<string>(() =>
    loadTapeSelection()?.kind === "custom" ? (loadTapeSelection() as { text: string }).text : "",
  );
  const [tapeWatchlists, setTapeWatchlists] = useState<ETradeWatchlist[]>([]);
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/market/quotes/source")
      .then((res) =>
        res.ok ? (res.json() as Promise<{ source?: unknown }>) : Promise.reject(new Error("source read failed")),
      )
      .then((data) => {
        if (!cancelled && (data?.source === "alpaca" || data?.source === "yahoo")) {
          setQuoteSource(data.source);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return subscribeTapeSelection((next) => {
      setTapeSelection(next);
      if (next.kind === "custom") setTapeCustomDraft(next.text);
    });
  }, []);

  const handleQuoteSourceChange = (next: "auto" | "alpaca" | "yahoo") => {
    const previous = quoteSource;
    setQuoteSource(next);
    apiFetch("/api/market/quotes/source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: next }),
    })
      .then((res) => {
        if (!res.ok) throw new Error("source write failed");
        return res.json() as Promise<{ source?: unknown }>;
      })
      .then((data) => {
        if (data?.source === "auto" || data?.source === "alpaca" || data?.source === "yahoo") {
          setQuoteSource(data.source);
        }
      })
      .catch(() => {
        setQuoteSource(previous);
      });
  };

  const tapeSelectionValue =
    tapeSelection.kind === "default"
      ? "default"
      : tapeSelection.kind === "preset"
        ? `preset:${tapeSelection.preset}`
        : tapeSelection.kind === "custom"
          ? "custom"
          : tapeSelection.kind === "watchlist"
            ? `watchlist:${tapeSelection.id}`
            : "holdings";

  const handleTapeSetChange = (value: string) => {
    let next: TapeSetSelection | null = null;
    if (value === "default") next = { kind: "default" };
    else if (value === "custom") next = { kind: "custom", text: tapeCustomDraft };
    else if (value === "holdings") next = { kind: "holdings" };
    else if (value.startsWith("preset:")) {
      const preset = value.slice("preset:".length);
      if (preset === "indices" || preset === "mega-cap" || preset === "crypto") {
        next = { kind: "preset", preset };
      }
    } else if (value.startsWith("watchlist:")) {
      const id = value.slice("watchlist:".length);
      const found = tapeWatchlists.find((w) => String(w.watchlistId) === id);
      next = { kind: "watchlist", id, name: found?.name };
    }
    if (next) {
      setTapeSelection(next);
      saveTapeSelection(next);
    }
  };

  // Local state for Ad / Sponsor banner configuration
  const [localAdConfig, setLocalAdConfig] = useState<AdBannerConfig>(() => getStoredAdBannerConfig());
  const [loginProviderName, setLoginProviderName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    globalThis
      .fetch("/api/me")
      .then((r) => r.json())
      .then((data: unknown) => {
        if (cancelled) return;
        const provider = (data as { provider?: { name?: unknown } } | null)?.provider;
        if (provider && typeof provider.name === "string" && provider.name !== "") {
          setLoginProviderName(provider.name);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (adBannerConfig) {
      setLocalAdConfig(adBannerConfig);
    }
  }, [adBannerConfig]);

  const effectiveAdConfig = adBannerConfig || localAdConfig;

  const handleToggleAdMaster = (enabled: boolean) => {
    const next: AdBannerConfig = {
      ...effectiveAdConfig,
      enabled,
    };
    setLocalAdConfig(next);
    saveStoredAdBannerConfig(next);
    onUpdateAdBannerConfig?.(next);
  };

  const handleToggleAdOption = (key: keyof AdBannerConfig, val: boolean) => {
    const next: AdBannerConfig = {
      ...effectiveAdConfig,
      [key]: val,
    };
    setLocalAdConfig(next);
    saveStoredAdBannerConfig(next);
    onUpdateAdBannerConfig?.(next);
  };

  // Local state for visible navbar tabs
  const [localVisibleTabs, setLocalVisibleTabs] = useState<Record<string, boolean>>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("nextgentp_visible_nav_tabs");
        if (saved) return { ...DEFAULT_VISIBLE_NAV_TABS, ...JSON.parse(saved) };
      } catch {}
    }
    return DEFAULT_VISIBLE_NAV_TABS;
  });

  const effectiveVisibleTabs = visibleTabs || localVisibleTabs;

  const handleToggleTab = (tabId: string) => {
    if (onToggleTabVisibility) {
      onToggleTabVisibility(tabId);
    } else {
      const next = {
        ...effectiveVisibleTabs,
        [tabId]: effectiveVisibleTabs[tabId] === false ? true : false,
      };
      setLocalVisibleTabs(next);
      if (typeof window !== "undefined") {
        localStorage.setItem("nextgentp_visible_nav_tabs", JSON.stringify(next));
      }
    }
  };

  const handleApplyPreset = (preset: Record<string, boolean>) => {
    if (onSetVisibleTabs) {
      onSetVisibleTabs(preset);
    } else {
      setLocalVisibleTabs(preset);
      if (typeof window !== "undefined") {
        localStorage.setItem("nextgentp_visible_nav_tabs", JSON.stringify(preset));
      }
    }
  };

  // Global Typography Preferences
  const [fontScale, setFontScale] = useState<number>(getStoredFontScale);
  useEffect(() => {
    function handleTypographyChange(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.scale !== undefined) setFontScale(detail.scale);
    }
    window.addEventListener("typography-changed", handleTypographyChange);
    return () => {
      window.removeEventListener("typography-changed", handleTypographyChange);
    };
  }, []);

  const handleFontScaleChange = (newScale: number) => {
    setFontScale(newScale);
    applyTypography(newScale);
  };


  // Issue #3812: the platform default is Alpaca (paper), so the menu
  // never falls back to E*TRADE when no selection is stored.
  const selectedBrokerId = tenantProviders.brokerId ?? "alpaca";
  const selectedBrokerLabel = brokerPresentation(selectedBrokerId).label;
  const brokerIcon = brokerPresentation(selectedBrokerId).icon;
  // Issue #3855: the connect surface switches on the broker's credential
  // kind, not its id — a key-pair broker gets the key-pair surface, an
  // OAuth broker gets the OAuth surface, whatever firm either one is.
  // An unrecognised id keeps the menu's standing OAuth fallback (the
  // pre-#3855 else-branch), never a guessed broker.
  const selectedBrokerCredentialKind = isBrokerId(selectedBrokerId)
    ? brokerCredentialGuidance(selectedBrokerId).kind
    : "oauth1_per_login";

  // Single environment value with immediate local reactivity
  const [localEnv, setLocalEnv] = useState<BrokerEnvironment | null>(null);
  const brokerEnv = useBrokerEnvironment();
  const effectiveEnv = localEnv ?? activeEnv ?? (accountMode ? (accountMode === "live" ? "PROD" : "TEST") : "TEST");

  useEffect(() => {
    const handleEnvChanged = (e: Event) => {
      const next = (e as CustomEvent).detail?.env;
      if (next === "TEST" || next === "PROD") {
        setLocalEnv(next);
      }
    };
    window.addEventListener(BROKER_ENV_CHANGED_EVENT, handleEnvChanged);
    return () => {
      window.removeEventListener(BROKER_ENV_CHANGED_EVENT, handleEnvChanged);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchWatchlists(effectiveEnv)
      .then((data) => {
        if (!cancelled) setTapeWatchlists(data.watchlists);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [effectiveEnv]);

  const effectiveMsg = oauthMsg !== undefined ? oauthMsg : localMsg;
  const clearMsg = () => {
    if (setOauthMsg) {
      setOauthMsg("");
    } else {
      setLocalMsg("");
    }
  };

  const isOpen = isHovered || isPinned;
  const isLive = effectiveEnv === "PROD";


  // Issue #3855: the credential connect read, gated on the broker's
  // credential kind — not on its id. A key-pair or personal-token
  // broker answers on its own connect surface (the endpoint module
  // decides the URL); a broker with no connect surface here gets no
  // fetch, never another broker's status read. Issue #3990 extends
  // the read to personal_token (Public): the same three facts
  // (configured / signedIn / source) from the neutral connect read.
  const [brokerCredentialStatus, setBrokerCredentialStatus] = useState<{
    configured?: boolean;
    signedIn?: boolean;
  } | null>(null);

  useEffect(() => {
    if (
      selectedBrokerCredentialKind !== "api_key_pair" &&
      selectedBrokerCredentialKind !== "personal_token"
    )
      return;
    const statusUrl = connectStatusEndpoint(selectedBrokerId);
    if (!statusUrl) return;
    let cancelled = false;
    const url = `${statusUrl}?environment=${encodeURIComponent(effectiveEnv)}`;
    apiFetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data === "object") {
          const body = data as Record<string, unknown>;
          setBrokerCredentialStatus({
            configured: Boolean(body.configured),
            signedIn: Boolean(body.signedIn),
          });
        }
      })
      .catch(() => {
        if (!cancelled) setBrokerCredentialStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBrokerId, selectedBrokerCredentialKind, effectiveEnv]);

  const isConnected =
    selectedBrokerCredentialKind === "api_key_pair" ||
    selectedBrokerCredentialKind === "personal_token"
      ? Boolean(brokerCredentialStatus?.configured || brokerCredentialStatus?.signedIn)
      : !!oauthStatus?.authenticated;

  const handleMouseEnter = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 220);
  };

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsPinned((prev) => !prev);
  };

  useEffect(() => {
    function handleToggleSettings() {
      setIsPinned((prev) => !prev);
    }
    window.addEventListener("open-settings-menu", handleToggleSettings);
    return () => {
      window.removeEventListener("open-settings-menu", handleToggleSettings);
    };
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        !isPinned
      ) {
        setIsHovered(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsPinned(false);
        setIsHovered(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, isPinned]);

  // Issue #3784: one switch action posts /environment/switch exactly
  // once. The `handleSwitchEnvironment` prop (Chat's plain POST
  // wiring, or the trading hub's switch + status refetch) IS the
  // switch when present; the direct import is only the fallback
  // for a menu rendered without the prop. Calling both posted
  // twice per click — the incident's duplicate /environment/switch
  // jobs. Same target, same echo adoption either way.
  const onSwitchEnv = (target: "TEST" | "PROD") => {
    setLocalEnv(target);
    if (handleSwitchEnvironment) {
      handleSwitchEnvironment(target);
    } else {
      void switchBrokerEnvironment(target);
    }
  };

  const onRunDiagnostics = () => {
    setIsPinned(false);
    setIsHovered(false);
    if (runDiagnostics) {
      runDiagnostics(selectedBrokerId, effectiveEnv);
      return;
    }

    const target = syncTarget(selectedBrokerId);
    if (target.diagnostics && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("open-etrade-diagnostics"));
      window.dispatchEvent(new CustomEvent("sync-etrade-api"));
    }

    setLocalDiagLoading(true);
    const startedAt = Date.now();
    fetch(target.path, { headers: { "x-environment": effectiveEnv } })
      .then(async (response) => ({ ok: response.ok, body: (await response.json().catch(() => ({}))) as any }))
      .then(({ ok, body }) => {
        const latency = Date.now() - startedAt;
        if (!ok) {
          setLocalMsg(`${selectedBrokerLabel} did not answer the check. Try again, or reconnect the broker in Settings.`);
          return;
        }
        if (target.diagnostics) {
          setLocalMsg(
            body?.status
              ? `API Diagnostics Result: ${body.status} (Ping: ${latency}ms)`
              : `Diagnostics returned no status (Ping: ${latency}ms).`,
          );
          return;
        }
        const configured = body?.status?.configured === true || body?.configured === true;
        setLocalMsg(`${selectedBrokerLabel} connection synced: ${configured ? "active" : "standby"} (Ping: ${latency}ms)`);
      })
      .catch(() => {
        setLocalMsg(`${selectedBrokerLabel} status check failed.`);
      })
      .finally(() => {
        setLocalDiagLoading(false);
      });
  };

  const onStartOAuth = () => {
    setIsPinned(false);
    setIsHovered(false);
    if (handleStartOAuth) {
      handleStartOAuth();
    } else if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("start-etrade-oauth"));
    }
  };

  const onRenewOAuth = () => {
    setIsPinned(false);
    setIsHovered(false);
    if (handleRenewOAuth) {
      handleRenewOAuth();
    } else if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("renew-etrade-oauth"));
    }
  };

  const onRevokeOAuth = () => {
    setIsPinned(false);
    setIsHovered(false);
    if (handleRevokeOAuth) {
      handleRevokeOAuth();
    } else if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("revoke-etrade-oauth"));
    }
  };

  const toggleKeyPairSignIn = () => setShowKeyPairSignIn((open) => !open);
  const isDiagnosticsRunning = diagnosticsLoading || localDiagLoading;

  return (
    <div
      className="etrade-dynamic-menu-container settings-menu-container broker-dynamic-menu-container"
      ref={menuRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Button
        type="button"
        className={`etrade-dynamic-menu-trigger settings-menu-trigger icon-only-settings-btn ${isConnected ? "connected" : "disconnected"} ${isLive ? "prod" : "test"} ${isOpen ? "open" : ""} ${isPinned ? "pinned" : ""}`}
        onClick={handleTriggerClick}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title={
          isPinned
            ? "Settings pinned open (click to unpin)"
            : `Settings (${selectedBrokerLabel} · ${brokerPresentation(selectedBrokerId).modeShort[isLive ? "live" : "paper"]}) — Broker, preferences, layout & themes`
        }
        aria-label="Settings"
      >
        <span className="menu-settings-icon" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </span>
        <span className={`menu-status-dot ${isConnected ? "connected" : "disconnected"}`} />
      </Button>

      {isOpen && (
        <div className="etrade-dynamic-dropdown-panel settings-dropdown-panel broker-dynamic-dropdown-panel" role="menu">
          {/* Header: User Info (Top-Left) & Broker Info / Connection (Top-Right) */}
          <div className="etrade-panel-header unified-menu-header">
            {/* Top-Left: User Info */}
            <div className="settings-user-card compact">
              <div className="settings-user-meta">
                {userAvatar ? (
                  <img src={userAvatar} alt={userLogin} className="settings-user-avatar" />
                ) : (
                  <div className="settings-user-avatar-placeholder">
                    {userLogin.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="settings-user-details">
                  <span className="settings-user-name">{userName || userLogin}</span>
                  <span className="settings-user-login">@{userLogin}</span>
                  {loginProviderName && (
                    <span className="settings-user-login">Logged in via {loginProviderName}</span>
                  )}
                </div>
              </div>
            </div>

            {/* Top-Right: Broker Info / Connection */}
            <div className="etrade-panel-brand broker-header-right">
              <div className="etrade-brand-text-row">
                <div className="etrade-brand-title">
                  <span className="brand-icon">{brokerIcon}</span>
                  <h5>{`${selectedBrokerLabel} Brokerage API`}</h5>
                </div>
                <span className={`brand-status-text ${isConnected ? "connected" : "disconnected"}`}>
                  {isConnected
                    ? selectedBrokerCredentialKind === "api_key_pair"
                      ? brokerCredentialStatus?.signedIn
                        ? "● User Key Connected"
                        : "● Deployment Key Active"
                      : selectedBrokerCredentialKind === "personal_token"
                      ? "● Personal Token Connected"
                      : "● OAuth Session Active"
                    : "○ Disconnected"}
                </span>
              </div>
              <span
                className={`etrade-env-badge broker-env-badge ${
                  !isConnected ? "offline" : isLive ? "prod" : "test"
                }`}
              >
                {!isConnected
                  ? "OFFLINE"
                  : brokerPresentation(selectedBrokerId).modeShort[isLive ? "live" : "paper"].toUpperCase()}
              </span>
            </div>
          </div>

          {/* Broker Selection (First Choice) */}
          <div className="etrade-panel-section broker-select-section">
            <div className="section-label-row">
              <span>Broker</span>
              <small>{selectedBrokerLabel} selected</small>
            </div>
            {providerSaveError && (
              <div className="provider-save-error" role="alert">
                {providerSaveError}
              </div>
            )}
            <PillGroup
              className="settings-pref-btn-group broker-select-pills"
              ariaLabel="Broker choice"
              size="sm"
              variant="default"
              options={brokerOptions().map((opt) => ({
                id: opt.id,
                label: opt.label,
                icon: opt.icon,
                tooltip: `Select ${opt.label} as active broker`,
              }))}
              value={selectedBrokerId}
              onChange={(v) => handleSetTenantProviders({ ...tenantProviders, brokerId: v })}
            />
          </div>

          {/* Data provider (Second Choice) — issue #3990: the data-source
              list is separate from the broker list. A broker may also be
              a data source (kind "broker"); Yahoo and Nasdaq are pure
              data providers (kind "pure", no trading). The kind rides
              the tooltip so the split is visible, not implied. */}
          <div className="etrade-panel-section data-provider-select-section">
            <div className="section-label-row">
              <span>Data provider</span>
              <small>{labelForDataProvider(tenantProviders, tenantProviders.dataProviderId)} selected</small>
            </div>
            <PillGroup
              className="settings-pref-btn-group data-provider-select-pills"
              ariaLabel="Data provider choice"
              size="sm"
              variant="default"
              options={DATA_PROVIDER_OPTIONS.map((opt) => ({
                id: opt.id,
                label: opt.label,
                tooltip:
                  opt.kind === "broker"
                    ? `Select ${opt.label} as data provider (broker — also provides trading)`
                    : `Select ${opt.label} as data provider (pure data provider — no trading)`,
              }))}
              value={tenantProviders.dataProviderId}
              onChange={(v) => handleSetTenantProviders({ ...tenantProviders, dataProviderId: v })}
            />
          </div>

          {/* Environment & Connection (Harmonized Single Line with Toggle Button) */}
          <div className="etrade-panel-section">
            <div className="section-label-row">
              <span>Environment &amp; Connection</span>
              <small>{brokerPresentation(selectedBrokerId).modeWord[isLive ? "live" : "paper"]}</small>
            </div>
            <div className="etrade-controls-single-line broker-controls-single-line">
              <Button
                type="button"
                size="sm"
                className={`btn-env-mini active ${isLive ? "prod" : ""}`}
                onClick={() => onSwitchEnv(isLive ? "TEST" : "PROD")}
                title={`Current mode: ${brokerPresentation(selectedBrokerId).modeWord[isLive ? "live" : "paper"]}. Click to toggle to ${brokerPresentation(selectedBrokerId).modeWord[isLive ? "paper" : "live"]}.`}
              >
                {isLive ? "🔴 Live" : `🧪 ${brokerPresentation(selectedBrokerId).modeShort[isLive ? "live" : "paper"]}`}
              </Button>
              <Button
                type="button"
                size="sm"
                className="btn-action-mini sync"
                disabled={isDiagnosticsRunning}
                onClick={onRunDiagnostics}
                loading={isDiagnosticsRunning}
                title="Test latency and sync API diagnostics"
              >
                🔄 Sync
              </Button>
              {selectedBrokerCredentialKind === "api_key_pair" ? (
                <Button
                  type="button"
                  size="sm"
                  className="btn-action-mini connect"
                  onClick={toggleKeyPairSignIn}
                  aria-expanded={showKeyPairSignIn}
                  title={isConnected ? `${selectedBrokerLabel} connection status & BYOK` : `Connect ${selectedBrokerLabel}`}
                >
                  {showKeyPairSignIn
                    ? `${brokerIcon} Close info`
                    : isConnected
                    ? `${brokerIcon} Connected`
                    : `${brokerIcon} Connect ${selectedBrokerLabel}`}
                </Button>
              ) : selectedBrokerCredentialKind === "personal_token" ? (
                <Button
                  type="button"
                  size="sm"
                  className="btn-action-mini connect"
                  onClick={() => setShowTokenCard((open) => !open)}
                  aria-expanded={showTokenCard}
                  title={isConnected ? `${selectedBrokerLabel} connection status & token` : `Connect ${selectedBrokerLabel}`}
                >
                  {showTokenCard
                    ? `${brokerIcon} Close info`
                    : isConnected
                    ? `${brokerIcon} Connected`
                    : `${brokerIcon} Connect ${selectedBrokerLabel}`}
                </Button>
              ) : isConnected ? (
                <>
                  {oauthStatus?.renewable && (
                    <Button
                      type="button"
                      size="sm"
                      className="btn-action-mini renew"
                      onClick={onRenewOAuth}
                      title="Renew active OAuth token before expiration"
                    >
                      ⚡ Renew
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    className="btn-action-mini disconnect"
                    onClick={onRevokeOAuth}
                    title="Disconnect and revoke current OAuth session"
                  >
                    ⚡ Disconnect
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="btn-action-mini connect"
                  disabled={oauthLoading}
                  onClick={onStartOAuth}
                  loading={oauthLoading}
                  title="Authenticate via OAuth"
                >
                  ⚡ Connect
                </Button>
              )}
            </div>

            {/* Embedded key-pair credentials card */}
            {selectedBrokerCredentialKind === "api_key_pair" && showKeyPairSignIn && (
              <div className="embedded-alpaca-signin">
                <AlpacaSignInCard
                  activeEnv={effectiveEnv}
                  collapsedWhenConfigured={false}
                />
              </div>
            )}

            {/* Embedded personal-token card (issue #3990) */}
            {selectedBrokerCredentialKind === "personal_token" && showTokenCard && (
              <div className="embedded-public-token">
                <PublicTokenCard />
              </div>
            )}
          </div>

          {/* Preferences & Appearance Settings */}
          <div className="etrade-panel-section settings-pref-section">
            <div className="section-label-row">
              <span>Preferences &amp; Interface</span>
              <small>Theme &amp; navigation</small>
            </div>

            <div className="settings-prefs-stack">
              {/* Theme Settings */}
              {(onCycleTheme || onSelectTheme) && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Theme:</span>
                  <PillGroup
                    className="settings-pref-btn-group"
                    ariaLabel="Theme mode"
                    size="sm"
                    variant="default"
                    options={[
                      { id: "system", label: "Auto", icon: "🌓", tooltip: "Follow OS preference" },
                      { id: "dark", label: "Dark", icon: "🌙", tooltip: "High-contrast dark theme" },
                      { id: "light", label: "Light", icon: "☀️", tooltip: "Clean light theme" },
                    ]}
                    value={theme === "auto" ? "system" : theme}
                    onChange={(val) => {
                      if (onSelectTheme) {
                        onSelectTheme(val as "light" | "dark" | "system");
                      } else if (onCycleTheme) {
                        onCycleTheme();
                      }
                    }}
                  />
                </div>
              )}

              {/* Navigation Bar Layout */}
              {onToggleLayout && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Navigation Layout:</span>
                  <PillGroup
                    className="settings-pref-btn-group"
                    ariaLabel="Navigation layout"
                    size="sm"
                    variant="default"
                    options={[
                      { id: "left", label: "Sidebar", icon: "⫷", tooltip: "Collapsible left sidebar" },
                      { id: "top", label: "Top Bar", icon: "⏶", tooltip: "Horizontal top bar" },
                    ]}
                    value={currentLayout}
                    onChange={(val) => onToggleLayout(val as "left" | "top")}
                  />
                </div>
              )}

              {/* Typography & Font Scaling */}
              <div className="settings-pref-row typography-pref-row">
                <span className="pref-row-lbl">Font Scale:</span>
                <PillGroup
                  className="settings-pref-btn-group"
                  ariaLabel="Font scale"
                  size="sm"
                  variant="default"
                  options={FONT_SCALE_PRESETS.map((p) => ({
                    id: String(p.scale),
                    label: p.label,
                    tooltip: p.pct,
                  }))}
                  value={String(fontScale)}
                  onChange={(val) => handleFontScaleChange(Number(val))}
                />
              </div>

              {/* Policy Account Mode */}
              {onToggleAccountMode && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Policy Mode:</span>
                  <PillGroup
                    className="settings-pref-btn-group"
                    ariaLabel="Policy account mode"
                    size="sm"
                    variant="default"
                    options={[
                      { id: "paper", label: "Paper", icon: "🧪", tooltip: "Simulated paper money" },
                      { id: "live", label: "Live Real", icon: "🔴", tooltip: "Live brokerage execution" },
                    ]}
                    value={isLive ? "live" : "paper"}
                    onChange={(mode) => {
                      const target = mode === "live" ? "PROD" : "TEST";
                      // Issue #3784: onSwitchEnv already switches to
                      // the same target — the old onToggleAccountMode
                      // call here posted a second switch (Chat's
                      // toggle POSTs directly), and onSwitchEnv's
                      // direct leg made it three.
                      onSwitchEnv(target);
                    }}
                  />
                </div>
              )}

              {/* Centralized Auto-Refresh Settings */}
              <div className="settings-pref-row">
                <span className="pref-row-lbl">Auto-Refresh:</span>
                <PillGroup
                  className="settings-pref-btn-group"
                  ariaLabel="Auto-refresh"
                  size="sm"
                  variant="default"
                  options={[
                    { id: "off", label: "OFF", icon: "⏹", tooltip: "Pause automatic background refresh" },
                    { id: "on", label: "ON", icon: "▶", tooltip: "Enable automatic background refresh" },
                  ]}
                  value={effectiveAutoRefreshEnabled ? "on" : "off"}
                  onChange={(v) => handleSetAutoRefresh(v === "on")}
                />
              </div>

              {/* Auto-Refresh Polling Interval */}
              {effectiveAutoRefreshEnabled && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Refresh Cadence:</span>
                  <PillGroup
                    className="settings-pref-btn-group"
                    ariaLabel="Refresh cadence"
                    size="sm"
                    variant="default"
                    options={getPollingConfig().autoRefreshIntervalOptionsS.map((s) => ({
                      id: String(s * 1000),
                      label: `${s}s`,
                      tooltip: `${s} seconds background refresh interval`,
                    }))}
                    value={String(effectiveAutoRefreshInterval)}
                    onChange={(val) => handleSetAutoRefresh(true, Number(val))}
                  />
                </div>
              )}

              {/* HITL Confirmation for Research-Report Dispatch */}
              {onToggleReportDispatchHitl && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Research HITL:</span>
                  <PillGroup
                    className="settings-pref-btn-group"
                    ariaLabel="Research report dispatch confirmation"
                    size="sm"
                    variant="default"
                    options={[
                      { id: "held", label: "Confirm First", icon: "🛡️", tooltip: "Hold report emails/webhooks until you approve" },
                      { id: "autonomous", label: "Autonomous", icon: "⚡", tooltip: "Send reports as soon as generated" },
                    ]}
                    value={reportDispatchHitl ? "held" : "autonomous"}
                    onChange={(val) => onToggleReportDispatchHitl(val === "held")}
                  />
                </div>
              )}

              {/* Pending Report Dispatch Confirmations */}
              {reportDispatchHitl && pendingReportConfirmations.length > 0 && (
                <div className="settings-pending-confirmations">
                  <div className="section-label-row">
                    <span>Pending Report Confirmations</span>
                    <small>Awaiting your approval</small>
                  </div>
                  <div className="pending-confirmations-list">
                    {pendingReportConfirmations.map((item) => (
                      <div key={item.confirmationId} className="pending-confirmation-row">
                        <div className="confirmation-meta">
                          <span className="confirmation-kind">{item.kind}</span>
                          <span className="confirmation-detail">{item.detail}</span>
                        </div>
                        {onDecideReportConfirmation && (
                          <div className="confirmation-actions">
                            <Button
                              type="button"
                              className="btn-confirmation-approve"
                              onClick={() => onDecideReportConfirmation(item.confirmationId, "approved")}
                              title="Approve delivery"
                            >
                              Approve
                            </Button>
                            <Button
                              type="button"
                              className="btn-confirmation-reject"
                              onClick={() => onDecideReportConfirmation(item.confirmationId, "rejected")}
                              title="Reject and discard"
                            >
                              Reject
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Ads & Partner Deals Configuration */}
              <div className="settings-pref-row">
                <span className="pref-row-lbl">Sponsor Banners:</span>
                <PillGroup
                  className="settings-pref-btn-group"
                  ariaLabel="Sponsor banners"
                  size="sm"
                  variant="default"
                  options={[
                    { id: "on", label: "Enabled", icon: "📢", tooltip: "Show non-intrusive sponsor deals and ecosystem promos" },
                    { id: "off", label: "Disabled", icon: "🚫", tooltip: "Hide promotional banners and partner offers" },
                  ]}
                  value={effectiveAdConfig.enabled ? "on" : "off"}
                  onChange={(val) => handleToggleAdMaster(val === "on")}
                />
              </div>

              {effectiveAdConfig.enabled && onOpenPartnerDeals && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Partner Deals:</span>
                  <Button
                    type="button"
                    className="btn-partner-deals"
                    onClick={onOpenPartnerDeals}
                    title="View curated developer and brokerage deals"
                  >
                    🎁 Browse Partner Deals &amp; Discounts
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Ticker Tape Controls */}
          <div className="etrade-panel-section ticker-tape-section">
            <div className="section-label-row">
              <span>Market Data &amp; Ticker Tape</span>
              <small>Streaming benchmark ticker</small>
            </div>

            <div className="settings-pref-row ticker-toggle-pref-row">
              <span className="pref-row-lbl">Ticker Tape:</span>
              <PillGroup
                className="settings-pref-btn-group"
                ariaLabel="Ticker tape display"
                size="sm"
                variant="default"
                options={[
                  { id: "off", label: "Off", icon: "⏸️", tooltip: "Hide streaming market ticker tape (default)" },
                  { id: "on", label: "On", icon: "▶️", tooltip: "Show real-time streaming benchmark quote ticker" },
                ]}
                value={tickerEnabled ? "on" : "off"}
                onChange={(val) => handleToggleTicker(val === "on")}
              />
            </div>

            <div className="ticker-controls-single-line">
              <Select
                className="ticker-compact-select"
                value={quoteSource}
                onChange={(e) => handleQuoteSourceChange(e.target.value as "auto" | "alpaca" | "yahoo")}
                aria-label="Quote source"
                title="Select upstream quote provider"
              >
                <option value="auto">Auto Quote Source</option>
                <option value="alpaca">Alpaca Market Data</option>
                <option value="yahoo">Yahoo Finance (Free)</option>
              </Select>

              <Select
                className="ticker-compact-select"
                value={tapeSelectionValue}
                onChange={(e) => handleTapeSetChange(e.target.value)}
                aria-label="Tape set"
                title="Select symbols displayed in top ticker tape"
              >
                <option value="default">Default Ticker Set</option>
                <option value="preset:indices">Major Indices</option>
                <option value="preset:mega-cap">Mega-Cap Tech</option>
                <option value="preset:crypto">Crypto &amp; BTC ETFs</option>
                <option value="holdings">My Portfolio Holdings</option>
                {tapeWatchlists.length > 0 && (
                  <optgroup label="Watchlists">
                    {tapeWatchlists.map((w) => (
                      <option key={w.watchlistId} value={`watchlist:${w.watchlistId}`}>
                        {w.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="custom">Custom Ticker Set...</option>
              </Select>

              {tapeSelection.kind === "custom" && (
                <div className="ticker-custom-row settings-pref-row">
                  <TextInput
                    type="text"
                    className="ticker-custom-input"
                    aria-label="Custom symbols"
                    value={tapeCustomDraft}
                    onChange={(e) => setTapeCustomDraft(e.target.value.toUpperCase())}
                    placeholder="AAPL, MSFT, NVDA"
                    title="Comma-separated ticker symbols"
                  />
                  <Button
                    type="button"
                    className="btn-ticker-apply"
                    onClick={() => {
                      const next: TapeSetSelection = { kind: "custom", text: tapeCustomDraft };
                      setTapeSelection(next);
                      saveTapeSelection(next);
                    }}
                    title="Apply custom symbol list"
                  >
                    Apply
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Navbar Visible Tabs Configuration */}
          <div className="etrade-panel-section settings-nav-tabs-section">
            <div className="section-label-row">
              <span>Navbar Visible Tabs</span>
              <small>Toggle tabs shown in the navigation bar</small>
            </div>

            <div className="nav-tabs-preset-row">
              <span className="preset-label">Presets:</span>
              <div className="nav-tabs-preset-buttons">
                <Button
                  type="button"
                  className="btn-preset-mini"
                  onClick={() => handleApplyPreset(NAV_TAB_PRESETS.all)}
                  title="Show all available navigation tabs"
                >
                  All Tabs
                </Button>
                <Button
                  type="button"
                  className="btn-preset-mini"
                  onClick={() => handleApplyPreset(NAV_TAB_PRESETS.traderFocus)}
                  title="Show core trading and execution tabs only"
                >
                  Trader Focus
                </Button>
                <Button
                  type="button"
                  className="btn-preset-mini"
                  onClick={() => handleApplyPreset(NAV_TAB_PRESETS.minimal)}
                  title="Minimalist view: Autopilot, Orders, Portfolio, Research, Copilot"
                >
                  Minimal
                </Button>
              </div>
            </div>

            <div className="nav-tabs-grid">
              {NAVIGATION_ITEMS.filter((item) => isTabFeatureEnabled(item.id)).map((item) => {
                const isChecked = effectiveVisibleTabs[item.id] !== false;
                return (
                  <Button
                    key={item.id}
                    type="button"
                    className={`nav-tab-toggle-pill ${isChecked ? "checked" : "unchecked"}`}
                    onClick={() => handleToggleTab(item.id)}
                    title={`${item.label} (${item.category}): ${isChecked ? "Visible in navbar (click to hide)" : "Hidden from navbar (click to show)"}`}
                    aria-pressed={isChecked}
                  >
                    <span className="tab-pill-check">{isChecked ? "✓" : "○"}</span>
                    <span className="tab-pill-text">{item.shortLabel || item.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>

          {/* Banner message / alert */}
          {effectiveMsg && (
            <div className="etrade-panel-message" role="status">
              <div className="msg-content">{effectiveMsg}</div>
              <div className="msg-actions">
                {(effectiveMsg.includes("SANDBOX") || effectiveMsg.includes("switch environment to TEST")) && (
                  <Button
                    type="button"
                    className="btn-msg-fix"
                    onClick={() => {
                      // Issue #3784: handleSwitchAndConnect switches
                      // (through handleSwitchEnvironment) AND starts
                      // OAuth — the old onSwitchEnv call here posted
                      // a second switch before it, and onSwitchEnv's
                      // direct leg made it three.
                      handleSwitchAndConnect?.("TEST");
                    }}
                  >
                    Switch to TEST &amp; Connect
                  </Button>
                )}
                <Button
                  type="button"
                  className="btn-msg-dismiss"
                  aria-label="Dismiss message"
                  onClick={clearMsg}
                >
                  ✕
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const SettingsMenu = BrokerDynamicMenu;
export default BrokerDynamicMenu;
