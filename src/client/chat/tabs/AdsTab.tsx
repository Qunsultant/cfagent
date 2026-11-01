import React from "react";
import { adAccentPalette } from "../../designTokens";
import { Badge, Card, Select, Button, TextInput, PageShell, FieldShell, Tabs, TabPanel, Notice } from "../../components/ui";
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
 * and still flow through Card/Badge style props; all layout is tokens.
 */
export function AdsTab({adFormError, adFormSuccess, ads, adsLoading, fetchAds, handleAdClick, handleCreateAd, newAdColor, newAdCta, newAdSponsor, newAdTagline, newAdTitle, newAdUrl, savingAd, setNewAdColor, setNewAdCta, setNewAdSponsor, setNewAdTagline, setNewAdTitle, setNewAdUrl}: AdsTabProps) {
  const { activeTab, visitedTabs, handleTabChange } = useUrlSyncedTabs<AdsTabId>({
    param: "view",
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
          <div className="ui-stat-grid">
            {ads.map((ad) => (
              <Card
                key={ad.id}
                style={{
                  borderColor: `${ad.accentColor}50`,
                  boxShadow: `0 8px 32px ${ad.accentColor}15`,
                }}
              >
                <div className="ui-stack">
                  <div className="ui-row">
                    <Badge
                      size="xs"
                      uppercase
                      style={{ background: `${ad.accentColor}25`, color: ad.accentColor }}
                    >
                      {ad.badge}
                    </Badge>
                    <span className="ui-meta-sm">Sponsored by {ad.sponsor}</span>
                  </div>

                  <h4>{ad.title}</h4>
                  <p className="ui-meta">{ad.tagline}</p>

                  <div className="ui-row">
                    <Badge size="xs" tone="neutral">👁️ {ad.impressions} impressions</Badge>
                    <Badge size="xs" tone="neutral">🖱️ {ad.clicks} clicks</Badge>
                  </div>

                  <div>
                    <Button
                      type="button"
                      style={{ background: ad.accentColor }}
                      onClick={() => handleAdClick(ad)}
                    >
                      {ad.ctaText}
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </TabPanel>
        <TabPanel idBase="ads" tabId="submit" active={activeTab === "submit"} retain={visitedTabs.has("submit")}>
          <Card>
            <div className="ui-stack">
              <div>
                <h4>📢 Submit a Sponsored Placement</h4>
                <p className="ui-meta">Feature your tool, API, or infrastructure platform to autonomous agent developers across the network.</p>
              </div>

              <form onSubmit={handleCreateAd} className="ui-stack">
                {adFormSuccess && <Notice tone="success">{adFormSuccess}</Notice>}
                {adFormError && <Notice tone="danger">{adFormError}</Notice>}

                <div className="ui-form-row">
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
                </div>

                <FieldShell id="ad-tagline" label="Tagline / Offer Description *">
                  <TextInput
                    type="text"
                    placeholder="e.g. Accelerate multi-turn LLM reasoning with sub-millisecond vector lookups."
                    value={newAdTagline}
                    onChange={(e) => setNewAdTagline(e.target.value)}
                    required
                  />
                </FieldShell>

                <div className="ui-form-row-3">
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
                </div>

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
        </TabPanel>
      </PageShell>
    </div>
  );
}
