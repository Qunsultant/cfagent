import React, { useState, useRef, useEffect, useCallback } from "react";
import { OptionsDataDownloadDropdown } from "./options/OptionsDataDownloadDropdown";
import {
  NAVIGATION_ITEMS,
  DEFAULT_VISIBLE_NAV_TABS,
  NAV_TAB_PRESETS,
} from "./components/NavigationMenu";
import { isTabFeatureEnabled } from "./featureFlags";
import { PillGroup, Button, TextInput } from "./components/ui";
import {
  switchBrokerEnvironment,
  useBrokerEnvironment,
} from "./brokerEnvironment";
import {
  AdBannerConfig,
  getStoredAdBannerConfig,
  saveStoredAdBannerConfig,
} from "./adBannerConfig";
import { useAutoRefresh } from "./autoRefresh";
import { useTenantProviders, DATA_PROVIDER_OPTIONS, BROKER_OPTIONS } from "./tenantProviders";
import { getPollingConfig } from "./pollingConfig";
import {
  FONT_SCALE_PRESETS,
  getStoredFontScale,
  applyTypography,
  adjustFontScale,
} from "./typography";

export interface SettingsMenuProps {
  /**
   * Issue #2482: retained for interface compatibility (the hub passes
   * the full broker props object), but it is NO LONGER an environment
   * authority — the menu reads the single value from the
   * brokerEnvironment module, standalone and hub-embedded alike.
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
  runDiagnostics?: () => void;
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
  // Issue #277: HITL confirmation for research-report dispatch
  // (POST /trading/reports/email|webhook). Default ON (#1144) = held
  // for confirmation; the toggle opts out to autonomous dispatch.
  reportDispatchHitl?: boolean;
  onToggleReportDispatchHitl?: (enabled: boolean) => void;
  // Issue #277: pending report-dispatch confirmations for review.
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
}

export type ETradeDynamicMenuProps = SettingsMenuProps;

export function SettingsMenu({
  oauthStatus,
  account,
  brokerStatus,
  maskAccount,
  setMaskAccount,
  diagnosticsLoading = false,
  oauthLoading = false,
  oauthMsg = "",
  setOauthMsg,
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
}: SettingsMenuProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [downloadSymbol, setDownloadSymbol] = useState(defaultSymbol);
  const menuRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [localMask, setLocalMask] = useState(true);
  const [localMsg, setLocalMsg] = useState("");
  const [localDiagLoading, setLocalDiagLoading] = useState(false);

  // Issue #2481 — when uncontrolled, the menu reads the same
  // central switch (autoRefresh.ts) as every gated surface, not
  // its own localStorage copy. When Chat controls the menu, the
  // props win and the toggle delegates to Chat, which writes
  // through the same module.
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

  // Local state for Ad / Sponsor banner configuration
  const [localAdConfig, setLocalAdConfig] = useState<AdBannerConfig>(() => getStoredAdBannerConfig());
  // #1274: login-provider display + request access. /api/me reports
  // provider {id, name, issuer} only for wired sessions with a known
  // issuer; a failed or provider-less response simply shows no line
  // (legacy sessions keep the previous display, unchanged).
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

  // Local state for visible navbar tabs if not controlled by parent
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

  // Global Typography Preferences (Single Universal Font: Inter)
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

  // Issue #2482: the single environment value. The old localEnv state
  // (backed by the etrade_active_env key, which could disagree with
  // the hub's cfagent_env key) is gone.
  const effectiveEnv = useBrokerEnvironment();
  const effectiveMask = maskAccount !== undefined ? maskAccount : localMask;
  const toggleMask = () => {
    if (setMaskAccount) {
      setMaskAccount(!effectiveMask);
    } else {
      setLocalMask(!effectiveMask);
    }
  };

  const effectiveMsg = oauthMsg !== undefined ? oauthMsg : localMsg;
  const clearMsg = () => {
    if (setOauthMsg) {
      setOauthMsg("");
    } else {
      setLocalMsg("");
    }
  };

  const isOpen = isHovered || isPinned;

  const isLive =
    effectiveEnv === "PROD" ||
    brokerStatus?.environment === "live" ||
    brokerStatus?.activeEnvironment === "PROD";

  const isConnected = !!oauthStatus?.authenticated;
  const accountValue = account?.netAccountValue;

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

  // Sync defaultSymbol when prop changes
  useEffect(() => {
    if (defaultSymbol && defaultSymbol.trim()) {
      setDownloadSymbol(defaultSymbol.trim().toUpperCase());
    }
  }, [defaultSymbol]);

  // Listen for global open-settings-menu event (e.g. from sidebar or hotkey)
  useEffect(() => {
    function handleToggleSettings() {
      setIsPinned((prev) => !prev);
    }
    window.addEventListener("open-settings-menu", handleToggleSettings);
    return () => {
      window.removeEventListener("open-settings-menu", handleToggleSettings);
    };
  }, []);

  // Close menu on click outside or Escape
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsPinned(false);
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
  }, [isOpen]);

  const onSwitchEnv = (target: "TEST" | "PROD") => {
    // Issue #2482: one write-through path. The module persists the
    // selection server-side and broadcasts etrade-env-changed; the hub
    // listener refetches and resets drafts from that event, so the menu
    // no longer calls the parent handler or posts to a second spelling.
    void switchBrokerEnvironment(target);
  };

  const handleOpenTuning = () => {
    setIsPinned(false);
    setIsHovered(false);
    if (onOpenEtapiTuning) {
      onOpenEtapiTuning();
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("open-etapi-tuning"));
    }
  };

  const onRunDiagnostics = () => {
    setIsPinned(false);
    setIsHovered(false);
    if (runDiagnostics) {
      runDiagnostics();
    } else {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("open-etrade-diagnostics"));
        window.dispatchEvent(new CustomEvent("sync-etrade-api"));
      }
      setLocalDiagLoading(true);
      fetch(`/api/etrade/diagnostics`, {
        headers: { "x-environment": effectiveEnv },
      })
        .then((r) => r.json())
        .then((data: any) => {
          if (data && data.status) {
            setLocalMsg(`API Diagnostics Result: ${data.status} (Ping: ${data.latencyMs ?? 42}ms)`);
          }
        })
        .catch((err) => {
          setLocalMsg(`Diagnostics Error: ${err.message}`);
        })
        .finally(() => {
          setLocalDiagLoading(false);
        });
    }
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

  const isDiagnosticsRunning = diagnosticsLoading || localDiagLoading;

  return (
    <div
      className="etrade-dynamic-menu-container settings-menu-container"
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
            : `Settings (${isLive ? "PROD" : "TEST"}) — Broker, preferences, layout & themes`
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
        <div className="etrade-dynamic-dropdown-panel settings-dropdown-panel" role="menu">
          {/* Header */}
          <div className="etrade-panel-header">
            <div className="etrade-panel-brand">
              <span className="brand-icon">⚡</span>
              <div className="etrade-brand-text-row">
                <h5>E*TRADE Brokerage API</h5>
                <span className={`brand-status-text ${isConnected ? "connected" : "disconnected"}`}>
                  {isConnected ? "● OAuth Session Active" : "○ Offline / Not Connected"}
                </span>
              </div>
            </div>
            <div className="etrade-panel-header-actions">
              <span className={`etrade-env-badge ${isLive ? "prod" : "test"}`}>
                {isLive ? "PROD (LIVE)" : "TEST (SANDBOX)"}
              </span>
            </div>
          </div>

          {/* Account Details Card (Single Horizontal Line) */}
          <div className="etrade-panel-account-card">
            <div className="account-stat-cell">
              <span className="stat-lbl">Account Value</span>
              <span className="stat-val value-highlight">
                {effectiveMask
                  ? "••••••"
                  : accountValue === undefined
                  ? "Unavailable"
                  : `$${accountValue.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}`}
              </span>
            </div>
            <span className="account-stat-divider" aria-hidden="true" />
            <div className="account-stat-cell">
              <span className="stat-lbl">Account #</span>
              <span className="stat-val acct-number">
                {account?.accountId && account.accountId !== "unconnected"
                  ? effectiveMask
                    ? `••••${account.accountId.slice(-4)}`
                    : account.accountId
                  : "••••4748"}
              </span>
            </div>
            <Button
              type="button"
              className="btn-mask-mini"
              onClick={toggleMask}
              title={effectiveMask ? "Reveal account value" : "Mask account value"}
            >
              {effectiveMask ? "👁️ Show" : "🔒 Hide"}
            </Button>
          </div>

          {/* Environment Switcher ("PROD...") */}
          <div className="etrade-panel-section">
            <div className="section-label-row">
              <span>Environment</span>
              <small>{isLive ? "Live execution" : "Paper sandbox testing"}</small>
            </div>
            <div className="etrade-env-switch-bar">
              <Button
                type="button"
                className={!isLive ? "active" : ""}
                onClick={() => onSwitchEnv("TEST")}
              >
                🧪 TEST (Sandbox)
              </Button>
              <Button
                type="button"
                className={isLive ? "active" : ""}
                onClick={() => onSwitchEnv("PROD")}
              >
                🔴 PROD (Live)
              </Button>
            </div>
          </div>

          {/* Connection Actions & Diagnostics */}
          <div className="etrade-panel-section">
            <div className="section-label-row">
              <span>Connection &amp; Diagnostics</span>
            </div>
            <div className="etrade-actions-grid">
              <Button
                type="button"
                className="btn-menu-action sync"
                disabled={isDiagnosticsRunning}
                onClick={onRunDiagnostics}
               loading={isDiagnosticsRunning}>
                {"🔄 Test & Sync API"}
              </Button>
              {isConnected ? (
                <>
                  {oauthStatus?.renewable && (
                    <Button
                      type="button"
                      className="btn-menu-action renew"
                      disabled={oauthLoading}
                      onClick={onRenewOAuth}
                    >
                      🔑 Renew Token
                    </Button>
                  )}
                  <Button
                    type="button"
                    className="btn-menu-action disconnect"
                    disabled={oauthLoading}
                    onClick={onRevokeOAuth}
                  >
                    🔌 Disconnect
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  className="btn-menu-action connect"
                  disabled={oauthLoading}
                  onClick={onStartOAuth}
                 loading={oauthLoading}>
                  {"⚡ Connect E*TRADE"}
                </Button>
              )}
            </div>
            {effectiveMsg && (
              <div className="etrade-menu-msg-banner">
                <span>{effectiveMsg}</span>
                <Button
                  type="button"
                  className="etrade-menu-msg-dismiss"
                  onClick={clearMsg}
                  title="Dismiss message"
                >
                  ✕
                </Button>
              </div>
            )}
          </div>

          {/* Tuning & Options Data Download (Single Horizontal Line) */}
          <div className="etrade-panel-section">
            <div className="section-label-row">
              <span>Tuning &amp; Options Data</span>
              <small>Parameters &amp; export</small>
            </div>
            <div className="etrade-tools-cluster single-row">
              <Button
                type="button"
                className="btn-menu-tuning"
                onClick={handleOpenTuning}
                title="Configure ETAPI trade engine and safety controls"
              >
                ⚙️ ETAPI Engine Tuning
              </Button>

              <div className="menu-download-row">
                <TextInput
                  type="text"
                  className="menu-symbol-input"
                  value={downloadSymbol}
                  onChange={(e) => setDownloadSymbol(e.target.value.toUpperCase())}
                  placeholder="Ticker"
                  maxLength={10}
                  title="Symbol for options dataset export"
                />
                <OptionsDataDownloadDropdown
                  symbol={downloadSymbol.trim() || "NVDA"}
                  activeEnv={effectiveEnv}
                  userLogin={userLogin}
                  label="📥 Options Data"
                  className="menu-data-download-btn"
                />
              </div>
            </div>
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
                    ariaLabel="Theme"
                    size="sm"
                    variant="default"
                    options={[
                      { id: "light", label: "Light", icon: "☀️", tooltip: "Light Theme" },
                      { id: "dark", label: "Dark", icon: "🌙", tooltip: "Dark Theme" },
                      { id: "high-contrast", label: "Contrast", icon: "◐", tooltip: "High Contrast Theme" },
                      { id: "system", label: "Auto", icon: "🖥️", tooltip: "System / Auto Theme" },
                    ]}
                    value={(theme as "light" | "dark" | "high-contrast" | "system") ?? "system"}
                    onChange={(next) => (onSelectTheme ? onSelectTheme(next) : onCycleTheme?.())}
                  />
                </div>
              )}

              {/* Global Font Size Settings */}
              <div className="settings-pref-row">
                <span className="pref-row-lbl">Font Size:</span>
                <div className="settings-pref-btn-group font-size-controls-group">
                  <Button size="sm" variant="secondary" onClick={() => { const next = adjustFontScale(-0.05); setFontScale(next); }} title="Decrease application font size" disabled={fontScale <= 0.75}>A-</Button>
                  <span className="font-scale-pct" title="Current font scale level">
                    {Math.round(fontScale * 100)}%
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => { const next = adjustFontScale(0.05); setFontScale(next); }} title="Increase application font size" disabled={fontScale >= 1.5}>A+</Button>
                  <span className="font-controls-divider" aria-hidden="true" />
                  <PillGroup
                    ariaLabel="Font size presets"
                    size="sm"
                    variant="default"
                    options={FONT_SCALE_PRESETS.map((p) => ({ id: p.id, label: p.label, tooltip: `Scale to ${p.label} (${p.pct})` }))}
                    value={FONT_SCALE_PRESETS.find((p) => Math.abs(fontScale - p.scale) < 0.03)?.id ?? ""}
                    onChange={(id) => { const preset = FONT_SCALE_PRESETS.find((p) => p.id === id); if (preset) handleFontScaleChange(preset.scale); }}
                  />
                </div>
              </div>

              {/* Navigation Layout Settings */}
              {onToggleLayout && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Navigation:</span>
                  <PillGroup
                    className="settings-pref-btn-group"
                    ariaLabel="Navigation layout"
                    size="sm"
                    variant="default"
                    options={[
                      { id: "top", label: "Top Menu", icon: "⊞", tooltip: "Switch to Top Nav Bar" },
                      { id: "left", label: "Left Sidebar", icon: "⊟", tooltip: "Switch to Left Sidebar" },
                    ]}
                    value={currentLayout ?? "top"}
                    onChange={(layout) => onToggleLayout?.(layout)}
                  />
                </div>
              )}

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
                    value={accountMode ?? "paper"}
                    onChange={(mode) => { if (mode !== accountMode) onToggleAccountMode?.(); }}
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

              {effectiveAutoRefreshEnabled && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Cadence:</span>
                  <div className="settings-pref-btn-group">
                    <PillGroup
                    ariaLabel="Auto-refresh cadence"
                    size="sm"
                    variant="default"
                    options={getPollingConfig().autoRefreshIntervalOptionsS.map((sec) => ({ id: String(sec), label: sec < 60 ? `${sec}s` : `${sec / 60}m`, tooltip: `Auto-refresh every ${sec < 60 ? `${sec} seconds` : `${sec / 60} min`}` }))}
                    value={String(effectiveAutoRefreshInterval)}
                    onChange={(v) => handleSetAutoRefresh(true, Number(v))}
                  />
                  </div>
                </div>
              )}

              {/* Per-tenant provider / broker selection (slice 1):
                  two independent selectors. Changing a selection
                  writes the server row; surfaces gated on the
                  selection re-render from the same module. */}
              <div className="settings-pref-row">
                <span className="pref-row-lbl">Data provider:</span>
                <PillGroup
                    className="settings-pref-btn-group"
                    ariaLabel="Data provider"
                    size="sm"
                    variant="default"
                    options={DATA_PROVIDER_OPTIONS.map((o) => ({ id: o.id, label: o.label, tooltip: `Use ${o.label} as the data provider` }))}
                    value={tenantProviders.dataProviderId}
                    onChange={(v) => handleSetTenantProviders({ ...tenantProviders, dataProviderId: v })}
                  />
              </div>
              <div className="settings-pref-row">
                <span className="pref-row-lbl">Broker:</span>
                <PillGroup
                    className="settings-pref-btn-group"
                    ariaLabel="Broker"
                    size="sm"
                    variant="default"
                    options={BROKER_OPTIONS.map((o) => ({ id: o.id, label: o.label, tooltip: `Use ${o.label} as the broker` }))}
                    value={tenantProviders.brokerId}
                    onChange={(v) => handleSetTenantProviders({ ...tenantProviders, brokerId: v })}
                  />
              </div>
              {providerSaveError && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">{providerSaveError}</span>
                </div>
              )}

              {/* Issue #277: optional HITL confirmation for report dispatch */}
              {onToggleReportDispatchHitl && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Report dispatch HITL:</span>
                  <PillGroup
                    className="settings-pref-btn-group"
                    ariaLabel="Report dispatch confirmation"
                    size="sm"
                    variant="default"
                    options={[
                      { id: "auto", label: "Autonomous", icon: "⏹", tooltip: "Send research reports autonomously (current behavior)" },
                      { id: "confirm", label: "Require confirmation", icon: "✅", tooltip: "Hold research reports for human confirmation before dispatch" },
                    ]}
                    value={reportDispatchHitl ? "confirm" : "auto"}
                    onChange={(v) => onToggleReportDispatchHitl?.(v === "confirm")}
                  />
                </div>
              )}

              {/* Issue #277: pending report confirmations awaiting review */}
              {(reportDispatchHitl || pendingReportConfirmations.length > 0) && onDecideReportConfirmation && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Pending confirmations:</span>
                  <div className="settings-pref-pending-list">
                    {pendingReportConfirmations.length === 0 ? (
                      <span className="pending-empty">None awaiting review.</span>
                    ) : (
                      pendingReportConfirmations.map((item) => (
                        <div key={item.confirmationId} className="pending-confirm-row">
                          <span className="pending-detail" title={`${item.kind} · ${item.createdAt}`}>
                            {item.kind === "email" ? "📧" : "🔗"} {item.detail}
                          </span>
                          <div className="settings-pref-btn-group">
                            <Button size="sm" variant="primary" onClick={() => onDecideReportConfirmation(item.confirmationId, "approved")} title={`Approve and dispatch (ID ${item.confirmationId})`}>✅ Approve</Button>
                            <Button size="sm" variant="danger" onClick={() => onDecideReportConfirmation(item.confirmationId, "rejected")} title={`Reject (ID ${item.confirmationId})`}>❌ Reject</Button>
                          </div>
                        </div>
                      ))
                    )}
                    {onRefreshReportConfirmations && (
                      <Button size="sm" variant="secondary" onClick={() => onRefreshReportConfirmations()} title="Refresh the pending confirmations list">⟳ Refresh</Button>
                    )}
                  </div>
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

          {/* User Account & Session */}
          <div className="etrade-panel-section user-session-section">
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
                      onSwitchEnv("TEST");
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

export const ETradeDynamicMenu = SettingsMenu;
