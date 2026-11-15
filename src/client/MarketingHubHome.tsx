/**
 * Issue 4682 — the Marketing Hub home.
 *
 * The ONE marketing surface (`?tab=marketing-hub`): the three
 * non-ProductHub marketing routes — referrals, ads, social — render
 * here as sections on the shared `view` param, following the
 * DataHubHome / SchedulesHome hub shape. ProductHub is untouched:
 * it stays its own route with its own sub-menu.
 *
 * View state follows the URL (`?view=`): the component reads it
 * through useUrlSyncedTabs (no initialTab — a fresh load honors the
 * URL, per the S2 fix), a section click writes it, and back/forward
 * and left-nav navigation re-read it, so bookmarks and reloads land
 * on the same section.
 *
 * Retention: sections mount on first visit and stay mounted-hidden
 * after that (TabPanel retain + the visitedTabs set), so the social
 * brief draft and the ads/referrals inner-tab state survive section
 * switches — the same retention the three pages had as standalone
 * shell-retained pages.
 *
 * Chrome: the hub renders the one PageShell (the h1). Each section
 * panel renders its own PageShell, so the hub applies "tab" chrome
 * around them (the Billing / trading-hub host precedent): a section
 * shell renders content-only, never a second h1.
 */
import { PageSection, PageShell, Tabs, TabPanel, type TabOption } from "./components/ui";
import { PageChromeContext } from "./components/ui/PageShell";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import { SocialPostingPanel } from "./SocialPostingPanel";
import { AdsTab, type AdsTabProps } from "./chat/tabs/AdsTab";
import { ReferralsTab, type ReferralsTabProps } from "./chat/tabs/ReferralsTab";
import {
  MARKETING_HUB_VIEW_LABELS,
  MARKETING_HUB_VIEWS,
  isMarketingHubView,
  type MarketingHubView,
} from "./marketingHubView";

const MARKETING_HUB_TABS: TabOption<MarketingHubView>[] = MARKETING_HUB_VIEWS.map((id) => ({
  id,
  label: MARKETING_HUB_VIEW_LABELS[id],
}));

export interface MarketingHubHomeProps {
  /** Chat-owned ads state + handlers (state stays in Chat — no refactor). */
  adsProps: AdsTabProps;
  /** Chat-owned referrals state + handlers (state stays in Chat). */
  referralsProps: ReferralsTabProps;
}

export function MarketingHubHome({ adsProps, referralsProps }: MarketingHubHomeProps) {
  const { activeTab, visitedTabs, handleTabChange } = useUrlSyncedTabs<MarketingHubView>({
    param: "view",
    isValid: isMarketingHubView,
    defaultTab: "referrals",
  });

  return (
    <PageShell
      title="Marketing Hub"
      scopeNote="Referrals, sponsored offers, and social posting — one home for the marketing surfaces"
    >
      <PageSection>
        <Tabs<MarketingHubView>
          idBase="marketing-hub"
          ariaLabel="Marketing Hub sections"
          tabs={MARKETING_HUB_TABS}
          value={activeTab}
          onChange={handleTabChange}
        />
      </PageSection>

      {visitedTabs.has("referrals") && (
        <TabPanel
          idBase="marketing-hub"
          tabId="referrals"
          active={activeTab === "referrals"}
          retain
        >
          <PageChromeContext.Provider value="tab">
            <ReferralsTab {...referralsProps} param="referralsTab" />
          </PageChromeContext.Provider>
        </TabPanel>
      )}

      {visitedTabs.has("ads") && (
        <TabPanel
          idBase="marketing-hub"
          tabId="ads"
          active={activeTab === "ads"}
          retain
        >
          <PageChromeContext.Provider value="tab">
            <AdsTab {...adsProps} param="adsTab" />
          </PageChromeContext.Provider>
        </TabPanel>
      )}

      {visitedTabs.has("social") && (
        <TabPanel
          idBase="marketing-hub"
          tabId="social"
          active={activeTab === "social"}
          retain
        >
          <PageChromeContext.Provider value="tab">
            <SocialPostingPanel active={activeTab === "social"} param="socialTab" />
          </PageChromeContext.Provider>
        </TabPanel>
      )}
    </PageShell>
  );
}
