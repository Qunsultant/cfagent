import React from "react";
import { adAccentPalette } from "../../designTokens";
import { Badge, Card, CardHeader, Grid, Select, Button, TextInput, PageSection, PageShell, FieldShell, Tabs, TabPanel, Notice } from "../../components/ui";
import { useUrlSyncedTabs } from "../../useUrlSyncedTabs";
import type { AdItem } from "../types";

export interface AdsTabProps {
  adFormError: string;
  adFormSuccess: string;
  ads: AdItem[];
  adsLoading: boolean;
  fetchAds: () => Promise<void>;
  handleAdClick: (ad: AdItem) => void;
  handleCreateAd: (e: React.FormEvent) => Promise<void>;
  newAdColor: string;
  newAdCta: string;
  newAdSponsor: string;
  newAdTagline: string;
  newAdTitle: string;
  newAdUrl: string;
  savingAd: boolean;
  setNewAdColor: React.Dispatch<React.SetStateAction<string>>;
  setNewAdCta: React.Dispatch<React.SetStateAction<string>>;
  setNewAdSponsor: React.Dispatch<React.SetStateAction<string>>;
  setNewAdTagline: React.Dispatch<React.SetStateAction<string>>;
  setNewAdTitle: React.Dispatch<React.SetStateAction<string>>;
  setNewAdUrl: React.Dispatch<React.SetStateAction<string>>;
  /** URL param carrying the inner tab. Standalone it is "view"; nested
   *  in the Marketing Hub it is "adsTab", so the inner tab never
   *  overwrites the hub tab it is nested inside (issue 4682). */
  param?: string;
}

type AdsTabId = "offers" | "submit";
const ADS_TABS: Array<{ id: AdsTabId; label: string }> = [
  { id: "offers", label: "Offers" },
  { id: "submit", label: "Submit" },
];
const isAdsTab = (v: unknown): v is AdsTabId => v === "offers" || v === "submit";

/**
 * Sponsored Offers & Partner Marketplace as a shell page (issue #2161,
 * epic #2150 slice 2): URL-synced inner tabs (?view=) with visited
 * panels retained mounted-hidden. Per-ad accent colors are record data
 * and survive only as the submit form's accent Select options (S-U4
 * #4820): no card, badge, or button renders a per-ad color anymore.
 */
export function AdsTab({adFormError, adFormSuccess, ads, adsLoading, fetchAds, handleAdClick, handleCreateAd, newAdColor, newAdCta, newAdSponsor, newAdTagline, newAdTitle, newAdUrl, savingAd, setNewAdColor, setNewAdCta, setNewAdSponsor, setNewAdTagline, setNewAdTitle, setNewAdUrl, param = "view"}: AdsTabProps) {
  const { activeTab, visitedTabs, handleTabChange } = useUrlSyncedTabs<AdsTabId>({
    param,
    isValid: isAdsTab,
    defaultTab: "offers",
  });
  return (
    <div>
      <PageShell
        title="Sponsored Offers & Partner Marketplace"
        scopeNote="Discover verified developer promotions, cloud compute grants, and API discounts. All placements run with real-time impression and click tracking."
      >
        <div>
          <Button
            onClick={fetchAds}
            disabled={adsLoading}
           loading={adsLoading}>
            {"🔄 Refresh"}
          </Button>
        </div>

        <Tabs
          tabs={ADS_TABS}
          value={activeTab}
          onChange={handleTabChange}
          ariaLabel="Sponsored offers sections"
          idBase="ads"
        />
        <TabPanel idBase="ads" tabId="offers" active={activeTab === "offers"} retain={visitedTabs.has("offers")}>
          <PageSection title="Offers">
          <Grid autoFit minColumnWidth="sm" gap="2">
            {ads.map((ad) => (
              <Card key={ad.id}>
                <div className="ui-stack">
                  <div className="ui-row">
                    <Badge size="xs" uppercase>
                      {ad.badge}
                    </Badge>
                    <span className="ui-meta-sm">Sponsored by {ad.sponsor}</span>
                  </div>

                  <CardHeader title={ad.title} />
                  <p className="ui-meta">{ad.tagline}</p>

                  <div className="ui-row">
                    <Badge size="xs" tone="neutral">👁️ {ad.impressions} impressions</Badge>
                    <Badge size="xs" tone="neutral">🖱️ {ad.clicks} clicks</Badge>
                  </div>

                  <div>
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() => handleAdClick(ad)}
                    >
                      {ad.ctaText}
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </Grid>
          </PageSection>
        </TabPanel>
        <TabPanel idBase="ads" tabId="submit" active={activeTab === "submit"} retain={visitedTabs.has("submit")}>
          <PageSection>
          <Card>
            <div className="ui-stack">
              <div>
                <CardHeader title="📢 Submit a Sponsored Placement" />
                <p className="ui-meta">Feature your tool, API, or infrastructure platform to autonomous agent developers across the network.</p>
              </div>

              <form onSubmit={handleCreateAd} className="ui-stack">
                {adFormSuccess && <Notice tone="success">{adFormSuccess}</Notice>}
                {adFormError && <Notice tone="danger">{adFormError}</Notice>}

                <Grid columns={2} gap="2">
                  <FieldShell id="ad-title" label="Campaign / Product Title *">
                    <TextInput
                      type="text"
                      placeholder="e.g. Quantitative Market Intelligence Pro"
                      value={newAdTitle}
                      onChange={(e) => setNewAdTitle(e.target.value)}
                      required
                    />
                  </FieldShell>

                  <FieldShell id="ad-sponsor" label="Sponsor / Brand Name *">
                    <TextInput
                      type="text"
                      placeholder="e.g. Institutional Capital or Acme Corp"
                      value={newAdSponsor}
                      onChange={(e) => setNewAdSponsor(e.target.value)}
                    />
                  </FieldShell>
                </Grid>

                <FieldShell id="ad-tagline" label="Tagline / Offer Description *">
                  <TextInput
                    type="text"
                    placeholder="e.g. Accelerate multi-turn LLM reasoning with sub-millisecond vector lookups."
                    value={newAdTagline}
                    onChange={(e) => setNewAdTagline(e.target.value)}
                    required
                  />
                </FieldShell>

                <Grid columns={3} gap="2">
                  <FieldShell id="ad-url" label="Destination Landing URL *">
                    <TextInput
                      type="url"
                      placeholder="https://..."
                      value={newAdUrl}
                      onChange={(e) => setNewAdUrl(e.target.value)}
                      required
                    />
                  </FieldShell>

                  <FieldShell id="ad-cta" label="CTA Button Label">
                    <TextInput
                      type="text"
                      placeholder="e.g. Claim $50 Credit →"
                      value={newAdCta}
                      onChange={(e) => setNewAdCta(e.target.value)}
                    />
                  </FieldShell>

                  <FieldShell id="ad-color" label="Accent Color">
                    <Select
                      value={newAdColor}
                      onChange={(e) => setNewAdColor(e.target.value)}
                    >
                      {adAccentPalette.map((c) => (
                        <option key={c.value} value={c.value}>{c.label} ({c.value})</option>
                      ))}
                    </Select>
                  </FieldShell>
                </Grid>

                <div>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={savingAd || !newAdTitle.trim() || !newAdUrl.trim()}
                   loading={savingAd}>
                    {"🚀 Launch Sponsored Placement"}
                  </Button>
                </div>
              </form>
            </div>
          </Card>
          </PageSection>
        </TabPanel>
      </PageShell>
    </div>
  );
}
