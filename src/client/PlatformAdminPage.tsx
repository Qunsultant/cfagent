import { NavIcons } from "./components/NavigationMenu";
/**
 * Platform Admin Page (Issue: dedicated platform admin page with tabbed sub-menus).
 *
 * Promotes Platform Admin from an overlay drawer dialog into a first-class,
 * full-page destination in the main viewport (<main className="tab-viewport">).
 *
 * Tabbed interface covers the administration surfaces from platformAdminConfig:
 *  - ads: Workspace Banners & Sponsor Spotlight
 *  - provenance: Technical diagnostics, DID, MCP client, and institutional ledger
 *  - api-keys: MCP transport access for external clients
 *  - tenants: Tenant create, list, settings, and read-only membership view (#2221)
 *  - accounts: Account administration — self-service setup, tier, credits, subscriptions & catalogue
 *
 * Issue #3121 S2 folded two sections into the schedules home
 * (`?tab=schedules`): `scheduled-goals` → `view=goals`
 * (ScheduledGoalsPanel) and `jobs` → `view=runs`
 * (ScheduleRunLedgerPanel). Issue #4561 finished the job: the last
 * schedule outpost, `background-tasks` → `view=background-tasks`
 * (AsyncJobsPanel), moved to the home too, and the goals/runs links
 * left the platform-admin sub-menu. Their old addresses redirect
 * there (see schedulesHome.ts `legacySchedulesRedirect`); the section
 * ids are gone from platformAdminConfig, so this page simply no
 * longer renders panels for them.
 *
 * Issue #4585 moved six more sections into their own hubs:
 * `data-providers`, `data-lifecycle`, and `downloads` → DataHub
 * (`?tab=data-hub`); `iaaa-admin`, `users`, and `admin-access` →
 * SecurityHub (`?tab=security-hub`, which also surfaces the user
 * profile). Their old addresses redirect there (see router.ts
 * `legacyPlatformAdminHubRedirect`); this page renders the remaining
 * 7 sections.
 *
 * Built strictly with src/client/components/ui/ primitives (PageShell, Card, Tabs, TabPanel)
 * and token-only styling per docs/architecture/UX/ux-architecture.md §20.
 *
 * Issue #4575 removed the last two duplicate sections: `free-runs` and
 * `products` were reachable from two homes (here and the product hub),
 * and `legacyProductRedirect` already sent the Platform Admin addresses
 * to `?tab=product-hub` — so these panels were unreachable by navigation.
 * The hub owns both views; this page renders the remaining 7 sections
 * after #4585.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  PageSection,
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
import { ApiKeysPanel } from "./ApiKeysPanel";
import { TenantAdminPanel } from "./TenantAdminPanel";
import { ChannelsAdminPanel } from "./ChannelsAdminPanel";
import { AccountAdminPanel } from "./AccountAdminPanel";
import { EngineTuningPanel } from "./options/EtapiConfigModal";
import NavAdminConfigPanel from "./NavAdminConfigPanel";
import {
  AdsSection,
  ProvenanceSection,
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
  { id: "ads", label: "Ads & Banners", icon: <NavIcons.Banners /> },
  { id: "provenance", label: "Diagnostics & Provenance", icon: <NavIcons.Provenance /> },
  { id: "api-keys", label: "API Keys", icon: <NavIcons.ApiKeys /> },
  { id: "tenants", label: "Tenants", icon: <NavIcons.Agents /> },
  { id: "channels", label: "Channels", icon: <NavIcons.Omnichannel /> },
  { id: "accounts", label: "Accounts", icon: <NavIcons.Contracts /> },
  { id: "engine-tuning", label: "Engine Tuning", icon: <NavIcons.Settings /> },
  {
    id: "nav-config",
    label: "Nav & Menu Access",
    icon: <NavIcons.Approvals />,
  },
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

  return (
    <PageShell
      title={platformAdminTitle(config)}
      scopeNote="Workspace administration, background jobs, external connectivity, and security governance"
    >
      <PageSection>
        <Tabs<PlatformAdminSectionId>
          idBase="platform-admin"
          ariaLabel="Platform Admin Sections"
          tabs={PLATFORM_ADMIN_TABS}
          value={active}
          onChange={handleSelectTab}
        />
      </PageSection>

      <TabPanel idBase="platform-admin" tabId="ads" active={active === "ads"}>
        <Card>
          <AdsSection
            ads={ads}
            onToggleMaster={toggleMaster}
            onToggleOption={toggleOption}
            {...(onOpenPartnerDeals ? { onOpenPartnerDeals } : {})}
          />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="provenance" active={active === "provenance"}>
        <Card>
          <ProvenanceSection />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="api-keys" active={active === "api-keys"}>
        <Card>
          <CardHeader
            title="API Keys"
            meta={<span className="ui-meta-sm">MCP transport access for external clients</span>}
          />
          <ApiKeysPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="tenants" active={active === "tenants"}>
        <Card>
          <CardHeader
            title="Tenants"
            meta={<span className="ui-meta-sm">Tenant create, list, settings &amp; members</span>}
          />
          <TenantAdminPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="channels" active={active === "channels"}>
        <Card>
          <CardHeader
            title="Channels"
            meta={<span className="ui-meta-sm">Delivery-channel enablement per tenant</span>}
          />
          <ChannelsAdminPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="accounts" active={active === "accounts"}>
        <Card>
          <CardHeader
            title="Accounts"
            meta={<span className="ui-meta-sm">Self-service account setup, tier, credits, subscriptions &amp; catalogue</span>}
          />
          <AccountAdminPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="engine-tuning" active={active === "engine-tuning"}>
        <Card>
          <EngineTuningPanel userLogin={user?.login} />
        </Card>
      </TabPanel>

      <TabPanel idBase="platform-admin" tabId="nav-config" active={active === "nav-config"}>
        <Card>
          <NavAdminConfigPanel />
        </Card>
      </TabPanel>

    </PageShell>
  );
}
