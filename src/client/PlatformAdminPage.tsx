import { NavIcons } from "./components/NavigationMenu";
/**
 * Platform Admin Page (Issue: dedicated platform admin page with tabbed sub-menus).
 *
 * Promotes Platform Admin from an overlay drawer dialog into a first-class,
 * full-page destination in the main viewport (<main className="tab-viewport">).
 *
 * Tabbed interface covers the administration surfaces from platformAdminConfig:
 *  - ads: Workspace Banners & Sponsor Spotlight
 *  - background-tasks: Async execution queue & background jobs
 *  - provenance: Technical diagnostics, DID, MCP client, and institutional ledger
 *  - api-keys: MCP transport access for external clients
 *  - tenants: Tenant create, list, settings, and read-only membership view (#2221)
 *  - data-providers: Market-data provider provisioning lifecycle
 *  - accounts: Account administration — self-service setup, tier, credits, subscriptions & catalogue
 *  - free-runs: Free-run allowance per product, per month (#3315)
 *  - iaaa-admin: Read-only memberships, genesis, and audit
 *  - users: User profiles, tenant memberships & account linkage
 *  - data-lifecycle: Clean state, platform bootstrap, and tenant bootstrap (#3250)
 *  - admin-access: Request admin access from the platform owner
 *
 * Issue #3121 S2 folded two sections into the schedules home
 * (`?tab=schedules`): `scheduled-goals` → `view=goals`
 * (ScheduledGoalsPanel) and `jobs` → `view=runs`
 * (ScheduleRunLedgerPanel). Their old addresses redirect there (see
 * schedulesHome.ts `legacySchedulesRedirect`), and the left-nav
 * entries link straight to the home (nav-config.json deep-link
 * overrides) — so they are gone from this page's tab list, not kept
 * as a second home. The section ids stay valid in
 * platformAdminConfig (the nav entries still exist); this page simply
 * no longer renders panels for them.
 *
 * Built strictly with src/client/components/ui/ primitives (PageShell, Card, Tabs, TabPanel)
 * and token-only styling per docs/agents/ux-architecture.md §20.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  Card,
  Grid,
  PageShell,
  Tabs,
  TabPanel,
  type TabOption,
} from "./components/ui";
import {
  DEFAULT_PLATFORM_ADMIN_CONFIG,
  platformAdminTitle,
  type PlatformAdminConfig,
  type PlatformAdminSectionId,
} from "./platformAdminConfig";
import {
  getStoredAdBannerConfig,
  saveStoredAdBannerConfig,
  type AdBannerConfig,
} from "./adBannerConfig";
import { AsyncJobsPanel } from "./AsyncJobsPanel";
import { ApiKeysPanel } from "./ApiKeysPanel";
import { DataProvidersPanel } from "./DataProvidersPanel";
import { AlpacaSignInCard } from "./AlpacaSignInCard";
import { TenantAdminPanel } from "./TenantAdminPanel";
import { DataLifecyclePanel } from "./DataLifecyclePanel";
import { ChannelsAdminPanel } from "./ChannelsAdminPanel";
import { AccountAdminPanel } from "./AccountAdminPanel";
import { FreeRunAllowanceSection } from "./FreeRunAllowanceSection";
import { IaaaAdminPanel } from "./IaaaAdminPanel";
import { UserAdminPanel } from "./UserAdminPanel";
import { EngineTuningPanel } from "./options/EtapiConfigModal";
import { DownloadsPanel } from "./DownloadsPanel";
import {
  AdsSection,
  ProvenanceSection,
  AdminAccessSection,
  isPlatformAdminSectionId,
  type PlatformAdminUser,
} from "./PlatformAdminPanel";
import {
  navigateToTab,
  parseViewFromSearch,
  subscribeToRouteChanges,
} from "./router";
import { csrfHeaders } from "./apiFetch";

export interface PlatformAdminPageProps {
  initialSection?: string;
  config?: PlatformAdminConfig;
  adBannerConfig?: AdBannerConfig;
  onUpdateAdBannerConfig?: (config: AdBannerConfig) => void;
  onOpenPartnerDeals?: () => void;
  user?: PlatformAdminUser;
  onSelectSection?: (sectionId: PlatformAdminSectionId) => void;
}

export const PLATFORM_ADMIN_TABS: TabOption<PlatformAdminSectionId>[] = [
  { id: "ads", label: "Ads & Banners", icon: <NavIcons.Banners /> },
  { id: "background-tasks", label: "Background Tasks", icon: <NavIcons.Tasks /> },
  { id: "provenance", label: "Diagnostics & Provenance", icon: <NavIcons.Provenance /> },
  { id: "api-keys", label: "API Keys", icon: <NavIcons.ApiKeys /> },
  { id: "tenants", label: "Tenants", icon: <NavIcons.Agents /> },
  { id: "channels", label: "Channels", icon: <NavIcons.Omnichannel /> },
  { id: "data-providers", label: "Data Providers", icon: <NavIcons.DataProviders /> },
  { id: "accounts", label: "Accounts", icon: <NavIcons.Contracts /> },
  { id: "free-runs", label: "Free Runs", icon: <NavIcons.Runs /> },
  { id: "iaaa-admin", label: "IAAA Admin", icon: <NavIcons.IaaaAdmin /> },
  { id: "users", label: "Users", icon: <NavIcons.Agents /> },
  { id: "data-lifecycle", label: "Data Lifecycle", icon: <NavIcons.Database /> },
  { id: "engine-tuning", label: "Engine Tuning", icon: <NavIcons.Settings /> },
  { id: "downloads", label: "Parameters & Export", icon: <NavIcons.Database /> },
  { id: "admin-access", label: "Admin Access", icon: <NavIcons.AdminAccess /> },
];

export function PlatformAdminPage({
  initialSection,
  config = DEFAULT_PLATFORM_ADMIN_CONFIG,
  adBannerConfig,
  onUpdateAdBannerConfig,
  onOpenPartnerDeals,
  user,
  onSelectSection,
}: PlatformAdminPageProps) {
  const [active, setActive] = useState<PlatformAdminSectionId>(() => {
    if (initialSection && isPlatformAdminSectionId(initialSection)) {
      return initialSection;
    }
    if (typeof window !== "undefined") {
      const fromUrl = parseViewFromSearch(window.location.search, isPlatformAdminSectionId);
      if (fromUrl && isPlatformAdminSectionId(fromUrl)) {
        return fromUrl;
      }
    }
    return "ads";
  });

  const [ads, setAds] = useState<AdBannerConfig>(() => adBannerConfig ?? getStoredAdBannerConfig());
  const [requesting, setRequesting] = useState(false);
  const [accessStatus, setAccessStatus] = useState("");

  useEffect(() => {
    if (adBannerConfig) setAds(adBannerConfig);
  }, [adBannerConfig]);

  useEffect(() => {
    return subscribeToRouteChanges(() => {
      if (typeof window !== "undefined") {
        const fromUrl = parseViewFromSearch(window.location.search, isPlatformAdminSectionId);
        if (fromUrl && isPlatformAdminSectionId(fromUrl)) {
          setActive(fromUrl);
        }
      }
    });
  }, []);

  const handleSelectTab = useCallback(
    (nextSection: PlatformAdminSectionId) => {
      setActive(nextSection);
      navigateToTab("platform-admin", nextSection);
      onSelectSection?.(nextSection);
    },
    [onSelectSection]
  );

  const applyAds = useCallback(
    (next: AdBannerConfig) => {
      setAds(next);
      saveStoredAdBannerConfig(next);
      onUpdateAdBannerConfig?.(next);
    },
    [onUpdateAdBannerConfig]
  );

  const toggleMaster = useCallback(
    (enabled: boolean) => applyAds({ ...ads, enabled }),
    [ads, applyAds]
  );

  const toggleOption = useCallback(
    (key: keyof Omit<AdBannerConfig, "enabled">, value: boolean) =>
      applyAds({ ...ads, [key]: value }),
    [ads, applyAds]
  );

  const requestAdminAccess = useCallback(async () => {
    setRequesting(true);
    setAccessStatus("");
    try {
      const res = await globalThis.fetch("/api/iaaa/access-request", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
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

  return (
    <PageShell
      title={platformAdminTitle(config)}
      scopeNote="Workspace administration, background jobs, external connectivity, and security governance"
    >
      <div className="platform-admin-tabs-wrapper">
        <Tabs<PlatformAdminSectionId>
          idBase="platform-admin"
          ariaLabel="Platform Admin Sections"
          tabs={PLATFORM_ADMIN_TABS}
          value={active}
          onChange={handleSelectTab}
        />
      </div>

      <TabPanel idBase="platform-admin" tabId="ads" active={active === "ads"}>
        <Card padding="md">
          <AdsSection
            ads={ads}
            onToggleMaster={toggleMaster}
            onToggleOption={toggleOption}
            {...(onOpenPartnerDeals ? { onOpenPartnerDeals } : {})}
          />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="background-tasks" active={active === "background-tasks"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>Background Tasks</span>
            <small>Async jobs &amp; execution queue</small>
          </div>
          <AsyncJobsPanel embedded />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="provenance" active={active === "provenance"}>
        <Card padding="md">
          <ProvenanceSection />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="api-keys" active={active === "api-keys"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>API Keys</span>
            <small>MCP transport access for external clients</small>
          </div>
          <ApiKeysPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="tenants" active={active === "tenants"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>Tenants</span>
            <small>Tenant create, list, settings &amp; members</small>
          </div>
          <TenantAdminPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="channels" active={active === "channels"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>Channels</span>
            <small>Delivery-channel enablement per tenant</small>
          </div>
          <ChannelsAdminPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="data-providers" active={active === "data-providers"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>Data Providers</span>
            <small>Provisioning lifecycle for market-data providers</small>
          </div>
          <DataProvidersPanel />
        </Card>
        <Card padding="md">
          <div className="section-label-row">
            <span>BYOK Provider Credentials</span>
            <small>Bring Your Own Keys for broker execution and market data</small>
          </div>
          <Grid columns={2} gap="3">
            <AlpacaSignInCard activeEnv="TEST" collapsedWhenConfigured={false} />
            <AlpacaSignInCard activeEnv="PROD" collapsedWhenConfigured={false} />
          </Grid>
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="accounts" active={active === "accounts"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>Accounts</span>
            <small>Self-service account setup, tier, credits, subscriptions &amp; catalogue</small>
          </div>
          <AccountAdminPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="free-runs" active={active === "free-runs"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>Free Runs</span>
            <small>Free-run allowance per product, per month</small>
          </div>
          <FreeRunAllowanceSection />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="iaaa-admin" active={active === "iaaa-admin"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>IAAA Admin</span>
            <small>Read-only memberships, genesis &amp; audit</small>
          </div>
          <IaaaAdminPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="users" active={active === "users"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>Users</span>
            <small>User profiles, tenant memberships &amp; account linkage</small>
          </div>
          <UserAdminPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="data-lifecycle" active={active === "data-lifecycle"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>Data Lifecycle</span>
            <small>Clean state, platform bootstrap &amp; tenant bootstrap</small>
          </div>
          <DataLifecyclePanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="engine-tuning" active={active === "engine-tuning"}>
        <Card padding="md">
          <EngineTuningPanel userLogin={user?.login} />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="downloads" active={active === "downloads"}>
        <Card padding="md">
          <DownloadsPanel userLogin={user?.login} />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="admin-access" active={active === "admin-access"}>
        <Card padding="md">
          <AdminAccessSection
            requesting={requesting}
            status={accessStatus}
            onRequest={() => void requestAdminAccess()}
            user={user}
          />
        </Card>
      </TabPanel>
    </PageShell>
  );
}
