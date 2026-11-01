import { NAV_ICON_MAP } from "./components/NavigationMenu";
/**
 * Platform Admin side panel (issue #2624, follow-up).
 *
 * @deprecated superseded by src/client/PlatformAdminPage.tsx
 *
 * The settings dropdown had grown to fourteen sections: everyday controls
 * mixed with nine administration surfaces at the bottom, plus the signed-in
 * account card. The administration half now lives here — a right-hand drawer
 * whose menu is externalized config (the #2529 LeftNavBar idiom):
 * `platformAdminConfig.ts` → sections → items.
 *
 * Entry point: the left-nav item "Platform Admin" and its sub-menu
 * (`platform-admin:<section>` ids). The nav shell opens this drawer at the
 * selected section; nothing here depends on the settings menu being mounted.
 *
 * The panel is self-contained: ad-banner preferences come from
 * `adBannerConfig` (localStorage, optional parent override) and the
 * request-admin-access action posts the same endpoint the settings menu used
 * to post. Styling follows docs/agents/ux-architecture.md §20 — primitives,
 * tokens, scoped classes, no inline layout styles.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, PillGroup } from "./components/ui";
import {
  getStoredAdBannerConfig,
  saveStoredAdBannerConfig,
  type AdBannerConfig,
} from "./adBannerConfig";
import { AsyncJobsPanel } from "./AsyncJobsPanel";
import { ScheduledGoalsPanel } from "./ScheduledGoalsPanel";
import { ApiKeysPanel } from "./ApiKeysPanel";
import { DataProvidersPanel } from "./DataProvidersPanel";
import { IaaaAdminPanel } from "./IaaaAdminPanel";
import {
  DEFAULT_PLATFORM_ADMIN_CONFIG,
  platformAdminItems,
  platformAdminTitle,
  type PlatformAdminConfig,
  type PlatformAdminMenuItemConfig,
  type PlatformAdminSectionId,
} from "./platformAdminConfig";

export type { PlatformAdminSectionId };

export interface PlatformAdminUser {
  login: string;
  name?: string;
  avatar?: string;
  providerName?: string;
}

export interface PlatformAdminPanelProps {
  open: boolean;
  onClose: () => void;
  /** Externalized menu config (#2529 idiom); defaults to the shipped config. */
  config?: PlatformAdminConfig;
  /** Section shown when the drawer opens; defaults to the first item. */
  initialSection?: string;
  /** Controlled ad-banner config (optional); defaults to the stored one. */
  adBannerConfig?: AdBannerConfig;
  onUpdateAdBannerConfig?: (config: AdBannerConfig) => void;
  onOpenPartnerDeals?: () => void;
  user?: PlatformAdminUser;
}

export function AdsSection({
  ads,
  onToggleMaster,
  onToggleOption,
  onOpenPartnerDeals,
}: {
  ads: AdBannerConfig;
  onToggleMaster: (enabled: boolean) => void;
  onToggleOption: (key: keyof Omit<AdBannerConfig, "enabled">, value: boolean) => void;
  onOpenPartnerDeals?: () => void;
}) {
  return (
    <div className="etrade-panel-section settings-ads-section">
      <div className="section-label-row">
        <span>Ads &amp; Partner Banners</span>
        <small>{ads.enabled ? "Active (Customized)" : "Disabled (Clean Workspace)"}</small>
      </div>

      <p className="settings-section-desc">
        Promotional banners and sponsor spotlights are externalized by default to keep workspace tabs clean.
        Toggle them on if desired, or browse deals on-demand.
      </p>

      <div className="settings-pref-row">
        <span className="pref-row-lbl">Workspace Banners:</span>
        <PillGroup
          className="settings-pref-btn-group"
          ariaLabel="Workspace banners"
          size="sm"
          variant="default"
          options={[
            { id: "off", label: "OFF (Clean)", icon: "⏹", tooltip: "Disable all promotional banners and ads across workspace tabs (Clean UI)" },
            { id: "on", label: "ON", icon: "▶", tooltip: "Enable promotional banners and customize placements" },
          ]}
          value={ads.enabled ? "on" : "off"}
          onChange={(v) => onToggleMaster(v === "on")}
        />
      </div>

      {ads.enabled && (
        <div className="settings-ads-suboptions">
          <div className="settings-pref-row">
            <span className="pref-row-lbl">Sponsor Spotlight:</span>
            <PillGroup
              className="settings-pref-btn-group"
              ariaLabel="Sponsor Spotlight"
              size="sm"
              variant="default"
              options={[
                { id: "off", label: "OFF" },
                { id: "on", label: "ON" },
              ]}
              value={ads.showSponsorSpotlight ? "on" : "off"}
              onChange={(v) => onToggleOption("showSponsorSpotlight", v === "on")}
            />
          </div>

          <div className="settings-pref-row">
            <span className="pref-row-lbl">Ad Network Strip:</span>
            <PillGroup
              className="settings-pref-btn-group"
              ariaLabel="Ad Network Strip"
              size="sm"
              variant="default"
              options={[
                { id: "off", label: "OFF" },
                { id: "on", label: "ON" },
              ]}
              value={ads.showAdNetworkStrip ? "on" : "off"}
              onChange={(v) => onToggleOption("showAdNetworkStrip", v === "on")}
            />
          </div>

          <div className="settings-pref-row">
            <span className="pref-row-lbl">Google Ad Units:</span>
            <PillGroup
              className="settings-pref-btn-group"
              ariaLabel="Google Ad Units"
              size="sm"
              variant="default"
              options={[
                { id: "off", label: "OFF" },
                { id: "on", label: "ON" },
              ]}
              value={ads.showGoogleAdUnits ? "on" : "off"}
              onChange={(v) => onToggleOption("showGoogleAdUnits", v === "on")}
            />
          </div>
        </div>
      )}

      <div className="settings-ads-external-actions">
        <Button
          type="button"
          className="btn-open-deals-showcase"
          onClick={() => {
            if (onOpenPartnerDeals) {
              onOpenPartnerDeals();
            } else if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("open-partner-deals-modal"));
            }
          }}
          title="Open external Partner Deals & Offers showcase"
        >
          ⭐ Browse Partner Deals &amp; Cloud Credits (External) ↗
        </Button>
      </div>
    </div>
  );
}

export function ProvenanceSection() {
  return (
    <div className="etrade-panel-section etrade-provenance-section">
      <details className="etrade-provenance-drawer" open>
        <summary className="etrade-provenance-summary">
          <span>⚙️ Technical Diagnostics &amp; Provenance</span>
          <span className="provenance-chevron" aria-hidden="true">▾</span>
        </summary>
        <div className="etrade-provenance-content">
          <div className="etrade-provenance-row">
            <strong>DID:</strong>
            <code className="etrade-provenance-code">did:agent:openaimp:trading</code>
          </div>
          <div className="etrade-provenance-row">
            <strong>Architecture:</strong>
            <span>MCP &amp; OAuth 1.0a REST Client</span>
          </div>
          <div className="etrade-provenance-row">
            <strong>Attestation:</strong>
            <span>Internal W3C DID Cryptographic Stamping</span>
          </div>
          <div className="etrade-provenance-row">
            <strong>Ledger Architecture:</strong>
            <span>Institutional Execution Ledger &amp; Audit Trail</span>
          </div>
        </div>
      </details>
    </div>
  );
}

export function AdminAccessSection({
  requesting,
  status,
  onRequest,
  user,
}: {
  requesting: boolean;
  status: string;
  onRequest: () => void;
  user?: PlatformAdminUser;
}) {
  const login = user?.login?.trim();
  // Never invent an identity: if the shell has no session user, say so
  // instead of printing "unknown" / "UN" / "@unknown" (issue #2624 fix-up).
  if (!login) {
    return (
      <div className="etrade-panel-section user-session-section">
        <div className="section-label-row">
          <span>Request admin access</span>
          <small>No signed-in identity</small>
        </div>
        <p className="settings-section-desc">
          The session user is not available on this page, so an access request cannot be attributed.
          Reload the page after signing in and try again.
        </p>
      </div>
    );
  }
  const initials = (user?.name || login).slice(0, 2).toUpperCase();
  return (
    <div className="etrade-panel-section user-session-section">
      <div className="section-label-row">
        <span>Request admin access</span>
        <small>Signed in as {login}</small>
      </div>
      <div className="settings-user-card compact">
        <div className="settings-user-meta">
          {user?.avatar ? (
            <img src={user.avatar} alt={login} className="settings-user-avatar" />
          ) : (
            <div className="settings-user-avatar-placeholder">{initials}</div>
          )}
          <div className="settings-user-details">
            <span className="settings-user-name">{user?.name || login}</span>
            <span className="settings-user-login">@{login}</span>
            {user?.providerName && <span className="settings-user-login">Logged in via {user.providerName}</span>}
            <Button type="button" disabled={requesting} onClick={onRequest}>
              Request admin access
            </Button>
            {status && (
              <span className="settings-user-login" role="status">
                {status}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PlatformAdminPanel({
  open,
  onClose,
  config = DEFAULT_PLATFORM_ADMIN_CONFIG,
  initialSection,
  adBannerConfig,
  onUpdateAdBannerConfig,
  onOpenPartnerDeals,
  user,
}: PlatformAdminPanelProps) {
  const items = platformAdminItems(config);
  const firstItem = items[0];
  const [active, setActive] = useState<string>(initialSection ?? firstItem.id);
  const [ads, setAds] = useState<AdBannerConfig>(() => adBannerConfig ?? getStoredAdBannerConfig());
  const [requesting, setRequesting] = useState(false);
  const [accessStatus, setAccessStatus] = useState("");
  const panelRef = useRef<HTMLElement | null>(null);

  // Ad preferences: parent-controlled when given, stored otherwise.
  useEffect(() => {
    if (adBannerConfig) setAds(adBannerConfig);
  }, [adBannerConfig]);

  const applyAds = useCallback(
    (next: AdBannerConfig) => {
      setAds(next);
      saveStoredAdBannerConfig(next);
      onUpdateAdBannerConfig?.(next);
    },
    [onUpdateAdBannerConfig],
  );

  const toggleMaster = useCallback((enabled: boolean) => applyAds({ ...ads, enabled }), [ads, applyAds]);
  const toggleOption = useCallback(
    (key: keyof Omit<AdBannerConfig, "enabled">, value: boolean) => applyAds({ ...ads, [key]: value }),
    [ads, applyAds],
  );

  const requestAdminAccess = useCallback(async () => {
    setRequesting(true);
    setAccessStatus("");
    try {
      const res = await globalThis.fetch("/api/iaaa/access-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestedRole: "tenant-admin" }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 201) {
        setAccessStatus("Access requested — pending admin approval.");
      } else if (res.status === 409) {
        setAccessStatus("You already have a pending access request.");
      } else {
        setAccessStatus(data.error || "Access request was not submitted.");
      }
    } catch {
      setAccessStatus("Access request was not submitted.");
    } finally {
      setRequesting(false);
    }
  }, []);

  // Opening the drawer always lands on the requested section (or the first
  // one), never on whatever was left selected in a previous turn.
  useEffect(() => {
    if (open) setActive(initialSection ?? firstItem.id);
  }, [open, initialSection, firstItem.id]);

  // Escape closes the drawer without touching anything else on the page.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const activeSection = items.find((entry) => entry.id === active) ?? firstItem;

  return (
    <div
      className="platform-admin-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="platform-admin-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Platform Admin"
        ref={panelRef}
      >
        <header className="platform-admin-header">
          <div className="platform-admin-title-block">
            <h4 className="platform-admin-title">{platformAdminTitle(config)}</h4>
            <p className="platform-admin-subtitle">Administration surfaces for this workspace</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="platform-admin-close"
            onClick={onClose}
            aria-label="Close Platform Admin"
            title="Close Platform Admin"
          >
            ✕
          </Button>
        </header>

        <div className="platform-admin-body">
          <nav className="platform-admin-menu" aria-label="Platform Admin sections">
            {items.map((section: PlatformAdminMenuItemConfig) => {
              const ItemIcon = section.icon ? NAV_ICON_MAP[section.icon] : null;
              return (
                <Button
                  key={section.id}
                  type="button"
                  variant="ghost"
                  className={`platform-admin-menu-item ${active === section.id ? "active" : ""}`}
                  aria-current={active === section.id ? "page" : undefined}
                  onClick={() => setActive(section.id)}
                  title={section.description}
                >
                  <div className="platform-admin-menu-row">
                    {ItemIcon && (
                      <span className="platform-admin-menu-icon" aria-hidden="true">
                        <ItemIcon active={active === section.id} />
                      </span>
                    )}
                    <span className="platform-admin-menu-label">{section.label}</span>
                  </div>
                  <span className="platform-admin-menu-desc">{section.description}</span>
                </Button>
              );
            })}
          </nav>

          <div className="platform-admin-content" role="region" aria-label={activeSection.label}>
            {active === "ads" && (
              <AdsSection
                ads={ads}
                onToggleMaster={toggleMaster}
                onToggleOption={toggleOption}
                {...(onOpenPartnerDeals ? { onOpenPartnerDeals } : {})}
              />
            )}
            {active === "background-tasks" && (
              <div className="etrade-panel-section settings-async-tasks-section">
                <div className="section-label-row">
                  <span>Background Tasks</span>
                  <small>Async jobs &amp; execution queue</small>
                </div>
                <AsyncJobsPanel embedded />
              </div>
            )}
            {active === "scheduled-goals" && (
              <div className="etrade-panel-section settings-scheduled-goals-section">
                <div className="section-label-row">
                  <span>Scheduled goals</span>
                  <small>ScheduledAgent goals, ticks &amp; add-goal form</small>
                </div>
                <ScheduledGoalsPanel embedded />
              </div>
            )}
            {active === "provenance" && <ProvenanceSection />}
            {active === "api-keys" && (
              <div className="etrade-panel-section settings-api-keys-section">
                <div className="section-label-row">
                  <span>API Keys</span>
                  <small>MCP transport access for external clients</small>
                </div>
                <ApiKeysPanel />
              </div>
            )}
            {active === "data-providers" && (
              <div className="etrade-panel-section settings-data-providers-section">
                <div className="section-label-row">
                  <span>Data Providers</span>
                  <small>Provisioning lifecycle for market-data providers</small>
                </div>
                <DataProvidersPanel />
              </div>
            )}
            {active === "iaaa-admin" && (
              <div className="etrade-panel-section settings-iaaa-admin-section">
                <div className="section-label-row">
                  <span>IAAA Admin</span>
                  <small>Read-only memberships, genesis &amp; audit</small>
                </div>
                <IaaaAdminPanel />
              </div>
            )}
            {active === "admin-access" && (
              <AdminAccessSection
                requesting={requesting}
                status={accessStatus}
                onRequest={() => void requestAdminAccess()}
                user={user}
              />
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

/** Section id the nav passes in (`platform-admin:api-keys` → `api-keys`). */
export function isPlatformAdminSectionId(value: unknown): value is PlatformAdminSectionId {
  if (typeof value !== 'string') return false;
  return DEFAULT_PLATFORM_ADMIN_CONFIG.sections[0].items.some((item) => item.id === value);
}
