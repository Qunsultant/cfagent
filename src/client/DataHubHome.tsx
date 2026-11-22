/**
 * Issue #4585 — the DataHub home.
 *
 * The ONE data surface (`?tab=data-hub`, inventory §8.3 pattern): it
 * renders directly from the shell (`Chat.tsx` `TAB_CONTENT`), NOT through
 * the Platform Admin page — the six moved sections live in their own hub
 * now. Its views are the sub-route scheme in `dataHubView.ts`:
 * data-providers (DataProvidersPanel + BYOK cards), data-lifecycle
 * (DataLifecyclePanel), downloads (DownloadsPanel).
 *
 * View state follows the URL (`?view=`), the same pattern as
 * PlatformAdminPage and SchedulesHome: the component re-reads the URL on
 * every route change, and a tab click navigates through `navigateToTab`,
 * so back/forward, bookmarks, and reloads all land on the same view.
 * Inactive views unmount (TabPanel default).
 */
import { useEffect, useState } from "react";
import { Card, CardHeader, Grid, PageSection, PageShell, Tabs, TabPanel, type TabOption } from "./components/ui";
import { DataProvidersPanel } from "./DataProvidersPanel";
import { FeedsPanel } from "./FeedsPanel";
import { AlpacaSignInCard } from "./AlpacaSignInCard";
import { DataLifecyclePanel } from "./DataLifecyclePanel";
import { DownloadsPanel } from "./DownloadsPanel";
import { navigateToTab, subscribeToRouteChanges } from "./router";
import {
  DATA_HUB_VIEW_LABELS,
  DATA_HUB_VIEWS,
  parseDataHubDeepLink,
  type DataHubDeepLink,
  type DataHubView,
} from "./dataHubView";

const DATA_HUB_TABS: TabOption<DataHubView>[] = DATA_HUB_VIEWS.map((id) => ({
  id,
  label: DATA_HUB_VIEW_LABELS[id],
}));

export interface DataHubHomeProps {
  userLogin?: string;
}

export function DataHubHome({ userLogin }: DataHubHomeProps = {}) {
  const [deepLink, setDeepLink] = useState<DataHubDeepLink>(() =>
    typeof window !== "undefined"
      ? parseDataHubDeepLink(window.location.search)
      : { view: "data-providers" },
  );

  useEffect(() => {
    return subscribeToRouteChanges(() => {
      if (typeof window !== "undefined") {
        setDeepLink(parseDataHubDeepLink(window.location.search));
      }
    });
  }, []);

  const handleSelectView = (nextView: DataHubView) => {
    navigateToTab("data-hub", nextView);
  };

  return (
    <PageShell
      title="DataHub"
      scopeNote="Market-data providers, data lifecycle, and parameters & export"
    >
      <PageSection>
      <Tabs<DataHubView>
        idBase="data-hub"
        ariaLabel="DataHub views"
        tabs={DATA_HUB_TABS}
        value={deepLink.view}
        onChange={handleSelectView}
      />

      <TabPanel idBase="data-hub" tabId="data-providers" active={deepLink.view === "data-providers"}>
        <Card>
          <CardHeader title="Data Providers" subtitle="Provisioning lifecycle for market-data providers" />
          <DataProvidersPanel />
        </Card>
        <Card>
          <CardHeader title="BYOK Provider Credentials" subtitle="Bring Your Own Keys for broker execution and market data" />
          <Grid columns={2} gap="3">
            <AlpacaSignInCard activeEnv="TEST" collapsedWhenConfigured={false} />
            <AlpacaSignInCard activeEnv="PROD" collapsedWhenConfigured={false} />
          </Grid>
        </Card>
      </TabPanel>

      <TabPanel idBase="data-hub" tabId="feeds" active={deepLink.view === "feeds"}>
        <Card>
          <CardHeader title="Feeds" subtitle="The stored-index feed family on the one pipeline" />
          <FeedsPanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="data-hub" tabId="data-lifecycle" active={deepLink.view === "data-lifecycle"}>
        <Card>
          <CardHeader title="Data Lifecycle" subtitle="Clean state, platform bootstrap & tenant bootstrap" />
          <DataLifecyclePanel />
        </Card>
      </TabPanel>

      <TabPanel idBase="data-hub" tabId="downloads" active={deepLink.view === "downloads"}>
        <Card>
          <DownloadsPanel userLogin={userLogin} />
        </Card>
      </TabPanel>
      </PageSection>
    </PageShell>
  );
}
