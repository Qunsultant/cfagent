/**
 * Platform Admin Page (Issue: dedicated platform admin page with tabbed sub-menus).
 *
 * Promotes Platform Admin from an overlay drawer dialog into a first-class,
 * full-page destination in the main viewport (<main className="tab-viewport">).
 *
 * Tabbed interface covers the eight administration surfaces from platformAdminConfig:
 *  - ads: Workspace Banners & Sponsor Spotlight
 *  - background-tasks: Async execution queue & background jobs
 *  - scheduled-goals: ScheduledAgent goals, ticks, and add-goal form
 *  - provenance: Technical diagnostics, DID, MCP client, and institutional ledger
 *  - api-keys: MCP transport access for external clients
 *  - data-providers: Market-data provider provisioning lifecycle
 *  - iaaa-admin: Read-only memberships, genesis, and audit
 *  - admin-access: Request admin access from the platform owner
 *
 * Built strictly with src/client/components/ui/ primitives (PageShell, Card, Tabs, TabPanel)
 * and token-only styling per docs/agents/ux-architecture.md §20.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  Card,
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
import { ScheduledGoalsPanel } from "./ScheduledGoalsPanel";
import { ApiKeysPanel } from "./ApiKeysPanel";
import { DataProvidersPanel } from "./DataProvidersPanel";
import { IaaaAdminPanel } from "./IaaaAdminPanel";
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
  { id: "ads", label: "Ads & Banners" },
  { id: "background-tasks", label: "Background Tasks" },
  { id: "scheduled-goals", label: "Scheduled Goals" },
  { id: "provenance", label: "Diagnostics & Provenance" },
  { id: "api-keys", label: "API Keys" },
  { id: "data-providers", label: "Data Providers" },
  { id: "iaaa-admin", label: "IAAA Admin" },
  { id: "admin-access", label: "Admin Access" },
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

  return (
    <PageShell
      title={platformAdminTitle(config)}
      scopeNote="Workspace administration, background jobs, external connectivity, and security governance"
    >
      <Tabs<PlatformAdminSectionId>
        idBase="platform-admin"
        ariaLabel="Platform Admin Sections"
        tabs={PLATFORM_ADMIN_TABS}
        value={active}
        onChange={handleSelectTab}
      />

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

      <TabPanel idBase="platform-admin" tabId="scheduled-goals" active={active === "scheduled-goals"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>Scheduled goals</span>
            <small>ScheduledAgent goals, ticks &amp; add-goal form</small>
          </div>
          <ScheduledGoalsPanel embedded />
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

      <TabPanel idBase="platform-admin" tabId="data-providers" active={active === "data-providers"}>
        <Card padding="md">
          <div className="section-label-row">
            <span>Data Providers</span>
            <small>Provisioning lifecycle for market-data providers</small>
          </div>
          <DataProvidersPanel />
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
