import React from "react";
import { GoogleAdUnit } from "../../GoogleAdUnit";
import { AdBannerConfig } from "../../adBannerConfig";
import type { AdItem } from "../types";
import type { CategoryItem } from "../types";
import type { ExternalAdItem } from "../types";
import { NavTabId } from "../../components/NavigationMenu";
import type { RevenueSummaryData } from "../types";
import type { TableMetadataItem } from "../types";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { PageShell } from "../../components/ui/PageShell";
import { Card } from "../../components/ui/Card";
import { Notice } from "../../components/ui/Notice";
import { Select } from "../../components/ui/Select";
import { Table } from "../../components/ui/Table";
import { TextInput } from "../../components/ui/TextInput";
import { FieldShell } from "../../components/ui/Field";
import { Tabs, TabPanel } from "../../components/ui/Tabs";
import { useUrlSyncedTabs } from "../../useUrlSyncedTabs";

export interface RevenueTabProps {
  adBannerConfig: AdBannerConfig;
  ads: AdItem[];
  browseTable: (tableName: string, search?: string) => Promise<void>;
  catErrorMsg: string;
  catSuccessMsg: string;
  categories: CategoryItem[];
  extAdErrorMsg: string;
  extAdSuccessMsg: string;
  externalAds: ExternalAdItem[];
  fetchCategories: () => Promise<void>;
  fetchExternalAds: () => Promise<void>;
  fetchRevenueSummary: () => Promise<void>;
  fetchTables: () => Promise<void>;
  googleAdFormat: "responsive" | "leaderboard" | "rectangle";
  googleAdsEnabled: boolean;
  googlePublisherId: string;
  googleSlotId: string;
  handleCreateCategory: (e: React.FormEvent) => Promise<void>;
  handleCreateExternalAd: (e: React.FormEvent) => Promise<void>;
  handleDeleteCategory: (id: string) => Promise<void>;
  handleExternalAdClick: (ad: ExternalAdItem) => void;
  newCatDesc: string;
  newCatIcon: string;
  newCatName: string;
  newCatOrder: string;
  newExtCpc: string;
  newExtCpm: string;
  newExtCta: string;
  newExtNetwork: "direct" | "ethicalads" | "carbon" | "adsense" | "google";
  newExtPlacement: "header_leaderboard" | "in_stream" | "footer_deck" | "sidebar";
  newExtTagline: string;
  newExtTitle: string;
  newExtUrl: string;
  revenueLoading: boolean;
  revenueSummary: RevenueSummaryData | null;
  savingCat: boolean;
  savingExtAd: boolean;
  setGoogleAdFormat: React.Dispatch<React.SetStateAction<"responsive" | "leaderboard" | "rectangle">>;
  setGoogleAdsEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setGooglePublisherId: React.Dispatch<React.SetStateAction<string>>;
  setGoogleSlotId: React.Dispatch<React.SetStateAction<string>>;
  setNewCatDesc: React.Dispatch<React.SetStateAction<string>>;
  setNewCatIcon: React.Dispatch<React.SetStateAction<string>>;
  setNewCatName: React.Dispatch<React.SetStateAction<string>>;
  setNewCatOrder: React.Dispatch<React.SetStateAction<string>>;
  setNewExtCpc: React.Dispatch<React.SetStateAction<string>>;
  setNewExtCpm: React.Dispatch<React.SetStateAction<string>>;
  setNewExtCta: React.Dispatch<React.SetStateAction<string>>;
  setNewExtNetwork: React.Dispatch<React.SetStateAction<"direct" | "ethicalads" | "carbon" | "adsense" | "google">>;
  setNewExtPlacement: React.Dispatch<React.SetStateAction<"header_leaderboard" | "in_stream" | "footer_deck" | "sidebar">>;
  setNewExtTagline: React.Dispatch<React.SetStateAction<string>>;
  setNewExtTitle: React.Dispatch<React.SetStateAction<string>>;
  setNewExtUrl: React.Dispatch<React.SetStateAction<string>>;
  setSelectedBrowseTable: React.Dispatch<React.SetStateAction<string>>;
  setTab: React.Dispatch<React.SetStateAction<NavTabId>>;
  tables: TableMetadataItem[];
}

type RevenueTabId = "metrics" | "placements" | "categories" | "schemas" | "ads";
const REVENUE_TABS: Array<{ id: RevenueTabId; label: string }> = [
  { id: "metrics", label: "Metrics" },
  { id: "placements", label: "Placements" },
  { id: "categories", label: "Categories" },
  { id: "schemas", label: "Schemas" },
  { id: "ads", label: "Google Ads" },
];
const isRevenueTab = (v: unknown): v is RevenueTabId =>
  v === "metrics" || v === "placements" || v === "categories" || v === "schemas" || v === "ads";

/**
 * Revenue & Monetization Management as a shell page (issue #2161,
 * epic #2150 slice 2): URL-synced inner tabs (?view=) with visited
 * panels retained mounted-hidden. All metrics, tables, and forms move
 * to primitives and utilities; copy and handlers are unchanged.
 */
export function RevenueTab({adBannerConfig, ads, browseTable, catErrorMsg, catSuccessMsg, categories, extAdErrorMsg, extAdSuccessMsg, externalAds, fetchCategories, fetchExternalAds, fetchRevenueSummary, fetchTables, googleAdFormat, googleAdsEnabled, googlePublisherId, googleSlotId, handleCreateCategory, handleCreateExternalAd, handleDeleteCategory, handleExternalAdClick, newCatDesc, newCatIcon, newCatName, newCatOrder, newExtCpc, newExtCpm, newExtCta, newExtNetwork, newExtPlacement, newExtTagline, newExtTitle, newExtUrl, revenueLoading, revenueSummary, savingCat, savingExtAd, setGoogleAdFormat, setGoogleAdsEnabled, setGooglePublisherId, setGoogleSlotId, setNewCatDesc, setNewCatIcon, setNewCatName, setNewCatOrder, setNewExtCpc, setNewExtCpm, setNewExtCta, setNewExtNetwork, setNewExtPlacement, setNewExtTagline, setNewExtTitle, setNewExtUrl, setSelectedBrowseTable, setTab, tables}: RevenueTabProps) {
  const { activeTab, visitedTabs, handleTabChange } = useUrlSyncedTabs<RevenueTabId>({
    param: "view",
    isValid: isRevenueTab,
    defaultTab: "metrics",
  });
  return (
    <div>
      <PageShell
        title="Revenue & Monetization Management"
        scopeNote="Platform revenue accounting across external ad networks (CPM/CPC), sponsored marketplace placements, agent payment processing fees, and referral partner payouts with transactional double-entry ledger persistence."
      >
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              fetchRevenueSummary();
              fetchExternalAds();
              fetchCategories();
              fetchTables();
            }}
            disabled={revenueLoading}
           loading={revenueLoading}>
            {"🔄 Refresh Financials"}
          </Button>
        </div>

        <Tabs
          tabs={REVENUE_TABS}
          value={activeTab}
          onChange={handleTabChange}
          ariaLabel="Revenue sections"
          idBase="revenue"
        />
        <TabPanel idBase="revenue" tabId="metrics" active={activeTab === "metrics"} retain={visitedTabs.has("metrics")}>
          <div className="ui-stat-grid">
            <Card padding="none" highlight>
              <div className="ui-row">
                <span>💵</span>
                <div className="ui-stack">
                  <strong>${revenueSummary?.grossRevenue?.toFixed(2) || "0.00"}</strong>
                  <span className="ui-meta-sm">Total Gross Platform Revenue</span>
                </div>
              </div>
            </Card>

            <Card padding="none">
              <div className="ui-row">
                <span>🌐</span>
                <div className="ui-stack">
                  <strong>${revenueSummary?.adNetworkRevenue?.toFixed(2) || "0.00"}</strong>
                  <span className="ui-meta-sm">External Ad Networks (CPM + CPC)</span>
                </div>
              </div>
            </Card>

            <Card padding="none">
              <div className="ui-row">
                <span>🚀</span>
                <div className="ui-stack">
                  <strong>${revenueSummary?.marketplaceRevenue?.toFixed(2) || "0.00"}</strong>
                  <span className="ui-meta-sm">Direct Sponsored Marketplace</span>
                </div>
              </div>
            </Card>

            <Card padding="none">
              <div className="ui-row">
                <span>💳</span>
                <div className="ui-stack">
                  <strong>${revenueSummary?.paymentPlatformFees?.toFixed(2) || "0.00"}</strong>
                  <span className="ui-meta-sm">Payment Processing Fees (2.5%)</span>
                </div>
              </div>
            </Card>

            <Card padding="none">
              <div className="ui-row">
                <span>🎁</span>
                <div className="ui-stack">
                  <strong>-${revenueSummary?.referralPayouts?.toFixed(2) || "0.00"}</strong>
                  <span className="ui-meta-sm">Referral Partner Payouts</span>
                </div>
              </div>
            </Card>

            <Card padding="none" highlight>
              <div className="ui-row">
                <span>💎</span>
                <div className="ui-stack">
                  <strong>${revenueSummary?.netRevenue?.toFixed(2) || "0.00"}</strong>
                  <span className="ui-meta-sm">Net Platform Margin</span>
                </div>
              </div>
            </Card>

            <Card padding="none">
              <div className="ui-row">
                <span>👁️</span>
                <div className="ui-stack">
                  <strong>
                    {revenueSummary?.totalImpressions || 0} / {revenueSummary?.totalAdClicks || 0}
                  </strong>
                  <span className="ui-meta-sm">Ad Views / Link Clicks</span>
                </div>
              </div>
            </Card>

            <Card padding="none">
              <div className="ui-row">
                <span>📈</span>
                <div className="ui-stack">
                  <strong>${revenueSummary?.averageRPM?.toFixed(2) || "18.50"}</strong>
                  <span className="ui-meta-sm">Average Ad Network RPM</span>
                </div>
              </div>
            </Card>
          </div>
        </TabPanel>
        <TabPanel idBase="revenue" tabId="placements" active={activeTab === "placements"} retain={visitedTabs.has("placements")}>
          <Card>
            <div className="ui-stack">
              <div>
                <h4>📡 External Ad Network Placements ({externalAds.length})</h4>
                <p className="ui-meta">
                  Manage active network units (EthicalAds, Carbon Ads, Google AdSense, Direct) generating revenue per 1,000 views (CPM) and per click (CPC).
                </p>
              </div>

              <div>
                <Table
                  columns={[
                    { key: "title", header: "Placement Unit", render: (ad) => (<><strong>{ad.title}</strong><div className="ui-meta-sm">{ad.tagline}</div></>) },
                    { key: "network", header: "Network", render: (ad) => (<Badge size="xs" tone="neutral">{ad.network === "ethicalads" ? "EthicalAds" : ad.network === "carbon" ? "Carbon" : ad.network === "adsense" ? "AdSense" : "Direct"}</Badge>) },
                    { key: "slot", header: "Slot", render: (ad) => <code>{ad.placement}</code> },
                    { key: "cpm", header: "CPM Rate", render: (ad) => <>${ad.cpmRate.toFixed(2)}</> },
                    { key: "cpc", header: "CPC Rate", render: (ad) => <>${ad.cpcRate.toFixed(2)}</> },
                    { key: "views", header: "Views", render: (ad) => <>{ad.impressions}</> },
                    { key: "clicks", header: "Clicks", render: (ad) => <>{ad.clicks}</> },
                    { key: "earned", header: "Total Earned", render: (ad) => <strong>${ad.earnings.toFixed(2)}</strong> },
                    { key: "status", header: "Status", render: (ad) => <Badge size="xs" uppercase tone={ad.isActive ? "success" : "neutral"}>{ad.isActive ? "ACTIVE" : "PAUSED"}</Badge> },
                    { key: "preview", header: "Live Preview", render: (ad) => <Button variant="accent" tone="subtle" size="sm" onClick={() => handleExternalAdClick(ad)}>{ad.ctaText}</Button> },
                  ]}
                  rows={externalAds}
                  rowKey={(ad) => ad.id}
                />
              </div>

              <Card padding="none">
                <div className="ui-stack">
                  <h5>➕ Register New External Ad Network Placement</h5>
                  {extAdSuccessMsg && <Notice tone="success">{extAdSuccessMsg}</Notice>}
                  {extAdErrorMsg && <Notice tone="danger">{extAdErrorMsg}</Notice>}

                  <form onSubmit={handleCreateExternalAd} className="ui-stack">
                    <div className="ui-form-row-3">
                      <FieldShell id="ext-title" label="Ad Campaign Title *">
                        <TextInput
                          type="text"
                          placeholder="e.g. DeepSeek R1 Global Inference"
                          value={newExtTitle}
                          onChange={(e) => setNewExtTitle(e.target.value)}
                          required
                        />
                      </FieldShell>
                      <FieldShell id="ext-network" label="Ad Network Provider">
                        <Select
                          value={newExtNetwork}
                          onChange={(e) => setNewExtNetwork(e.target.value as any)}
                        >
                          <option value="ethicalads">🛡️ EthicalAds Developer Network</option>
                          <option value="carbon">⚡ Carbon Ads</option>
                          <option value="adsense">🌐 Google AdSense</option>
                          <option value="direct">⭐ Direct Sponsor</option>
                        </Select>
                      </FieldShell>
                      <FieldShell id="ext-placement" label="Placement Slot">
                        <Select
                          value={newExtPlacement}
                          onChange={(e) => setNewExtPlacement(e.target.value as any)}
                        >
                          <option value="header_leaderboard">Header Leaderboard (Top)</option>
                          <option value="in_stream">In-Stream Banner (Chat)</option>
                          <option value="footer_deck">Footer Deck</option>
                          <option value="sidebar">Sidebar Rail</option>
                        </Select>
                      </FieldShell>
                    </div>

                    <FieldShell id="ext-tagline" label="Tagline / Promo Copy">
                      <TextInput
                        type="text"
                        placeholder="e.g. Serverless GPUs running 70B reasoning models with sub-second latency."
                        value={newExtTagline}
                        onChange={(e) => setNewExtTagline(e.target.value)}
                      />
                    </FieldShell>

                    <div className="ui-form-row-4">
                      <FieldShell id="ext-url" label="Target URL *">
                        <TextInput
                          type="url"
                          placeholder="https://..."
                          value={newExtUrl}
                          onChange={(e) => setNewExtUrl(e.target.value)}
                          required
                        />
                      </FieldShell>
                      <FieldShell id="ext-cta" label="CTA Label">
                        <TextInput
                          type="text"
                          placeholder="Claim Offer →"
                          value={newExtCta}
                          onChange={(e) => setNewExtCta(e.target.value)}
                        />
                      </FieldShell>
                      <FieldShell id="ext-cpm" label="CPM Rate ($/1,000 views)">
                        <TextInput
                          type="number"
                          step="0.5"
                          placeholder="18.50"
                          value={newExtCpm}
                          onChange={(e) => setNewExtCpm(e.target.value)}
                        />
                      </FieldShell>
                      <FieldShell id="ext-cpc" label="CPC Rate ($/click)">
                        <TextInput
                          type="number"
                          step="0.1"
                          placeholder="1.50"
                          value={newExtCpc}
                          onChange={(e) => setNewExtCpc(e.target.value)}
                        />
                      </FieldShell>
                    </div>

                    <div>
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={savingExtAd || !newExtTitle.trim() || !newExtUrl.trim()}
                       loading={savingExtAd}>
                        {"🚀 Activate Ad Network Unit"}
                      </Button>
                    </div>
                  </form>
                </div>
              </Card>
            </div>
          </Card>
        </TabPanel>
        <TabPanel idBase="revenue" tabId="categories" active={activeTab === "categories"} retain={visitedTabs.has("categories")}>
          <Card>
            <div className="ui-stack">
              <div>
                <h4>🏷️ Referral Categories &amp; Taxonomy Manager</h4>
                <p className="ui-meta">
                  Configure and maintain the categorization taxonomy used by partners to list developer tools, affiliate links, and monetization campaigns.
                </p>
              </div>

              <div>
                <Table
                  columns={[
                    { key: "icon", header: "Icon", align: "center", render: (cat) => <span className="ui-icon-lg">{cat.icon}</span> },
                    { key: "name", header: "Category Name", render: (cat) => <strong>{cat.name}</strong> },
                    { key: "slug", header: "Slug", render: (cat) => <code>{cat.slug}</code> },
                    { key: "desc", header: "Description", render: (cat) => <>{cat.description}</> },
                    { key: "order", header: "Sort Order", render: (cat) => <>{cat.sortOrder}</> },
                    { key: "status", header: "Status", render: (cat) => <Badge size="xs" uppercase tone={cat.isActive ? "success" : "neutral"}>{cat.isActive ? "ACTIVE" : "INACTIVE"}</Badge> },
                    { key: "actions", header: "Actions", render: (cat) => <Button variant="danger" tone="subtle" size="sm" onClick={() => handleDeleteCategory(cat.id)} title="Delete category">🗑️ Delete</Button> },
                  ]}
                  rows={categories}
                  rowKey={(cat) => cat.id}
                />
              </div>

              <Card padding="none">
                <div className="ui-stack">
                  <h5>➕ Add New Referral Category</h5>
                  {catSuccessMsg && <Notice tone="success">{catSuccessMsg}</Notice>}
                  {catErrorMsg && <Notice tone="danger">{catErrorMsg}</Notice>}

                  <form onSubmit={handleCreateCategory} className="ui-stack">
                    <div className="ui-form-row-3">
                      <FieldShell id="cat-name" label="Category Name *">
                        <TextInput
                          type="text"
                          placeholder="e.g. Web3 & Crypto, DevOps & CI/CD"
                          value={newCatName}
                          onChange={(e) => setNewCatName(e.target.value)}
                          required
                        />
                      </FieldShell>
                      <FieldShell id="cat-icon" label="Emoji Icon">
                        <TextInput
                          type="text"
                          placeholder="⚡"
                          value={newCatIcon}
                          onChange={(e) => setNewCatIcon(e.target.value)}
                        />
                      </FieldShell>
                      <FieldShell id="cat-order" label="Sort Priority (Order)">
                        <TextInput
                          type="number"
                          placeholder="10"
                          value={newCatOrder}
                          onChange={(e) => setNewCatOrder(e.target.value)}
                        />
                      </FieldShell>
                    </div>

                    <FieldShell id="cat-desc" label="Description">
                      <TextInput
                        type="text"
                        placeholder="e.g. Decentralized infrastructure, smart contracts, and wallet tooling."
                        value={newCatDesc}
                        onChange={(e) => setNewCatDesc(e.target.value)}
                      />
                    </FieldShell>

                    <div>
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={savingCat || !newCatName.trim()}
                       loading={savingCat}>
                        {"🏷️ Save Category"}
                      </Button>
                    </div>
                  </form>
                </div>
              </Card>
            </div>
          </Card>
        </TabPanel>
        <TabPanel idBase="revenue" tabId="schemas" active={activeTab === "schemas"} retain={visitedTabs.has("schemas")}>
          <Card>
            <div className="ui-stack">
              <div>
                <h4>🗄️ Institutional Data Schemas &amp; Record Counts</h4>
                <p className="ui-meta">
                  Direct view into institutional records, transaction schemas, and enterprise data repositories.
                </p>
              </div>

              <div className="ui-stat-grid">
                {tables.map((tbl) => (
                  <Card padding="none" key={tbl.name}>
                    <div className="ui-stack">
                      <div className="ui-row">
                        <h5><code>{tbl.name}</code></h5>
                        <Badge size="xs" tone="neutral">{tbl.rowCount} rows</Badge>
                      </div>
                      <p className="ui-meta-sm">{tbl.description}</p>
                      <div className="ui-stack">
                        <span className="ui-meta-sm">{tbl.columns.length} columns:</span>
                        <div className="ui-row">
                          {tbl.columns.map((c) => (
                            <Badge key={c.name} size="xs" tone={c.isPrimary ? "purple" : "neutral"}>
                              {c.name} {c.isPrimary ? "(PK)" : ""}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <div>
                        <Button
                          variant="primary"
                          tone="subtle"
                          size="sm"
                          onClick={() => {
                            setSelectedBrowseTable(tbl.name);
                            browseTable(tbl.name);
                            setTab("nlq");
                          }}
                        >
                          🔍 Browse Table Records →
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          </Card>
        </TabPanel>
        <TabPanel idBase="revenue" tabId="ads" active={activeTab === "ads"} retain={visitedTabs.has("ads")}>
          <Card>
            <div className="ui-stack">
              <div>
                <h4>🌐 Google Ads & Multi-Network Display Engine</h4>
                <p className="ui-meta">
                  Configure official Google AdSense and network display banners, test live formats, and track impressions/clicks across the platform.
                </p>
              </div>

              <div className="ui-form-row">
                <Card padding="none">
                  <div className="ui-stack">
                    <h5>⚙️ Google Ads Configuration</h5>
                    <FieldShell id="google-status" label="Google Ads Display Status">
                      <Button
                        variant={googleAdsEnabled ? "primary" : "secondary"}
                        tone="subtle"
                        onClick={() => setGoogleAdsEnabled(!googleAdsEnabled)}
                      >
                        {googleAdsEnabled ? "🟢 Google Ads Active" : "⚪ Google Ads Paused"}
                      </Button>
                    </FieldShell>

                    <FieldShell id="google-publisher" label="Google AdSense Publisher Client ID">
                      <TextInput
                        type="text"
                        placeholder="ca-pub-9842109842109842"
                        value={googlePublisherId}
                        onChange={(e) => setGooglePublisherId(e.target.value)}
                      />
                    </FieldShell>

                    <div className="ui-form-row">
                      <FieldShell id="google-slot" label="Default Ad Slot ID">
                        <TextInput
                          type="text"
                          placeholder="7812903456"
                          value={googleSlotId}
                          onChange={(e) => setGoogleSlotId(e.target.value)}
                        />
                      </FieldShell>
                      <FieldShell id="google-format" label="Display Format">
                        <Select
                          value={googleAdFormat}
                          onChange={(e) => setGoogleAdFormat(e.target.value as any)}
                        >
                          <option value="responsive">Responsive Banner</option>
                          <option value="leaderboard">728x90 Leaderboard</option>
                          <option value="rectangle">300x250 Medium Rectangle</option>
                        </Select>
                      </FieldShell>
                    </div>
                  </div>
                </Card>

                {adBannerConfig.enabled && adBannerConfig.showGoogleAdUnits && Boolean(adBannerConfig.tabVisibility.ads) && googleAdsEnabled && (
                  <Card padding="none">
                    <div className="ui-stack">
                      <h5>Live Google Ads Preview</h5>
                      <GoogleAdUnit
                        format={googleAdFormat}
                        publisherId={googlePublisherId}
                        slot={googleSlotId}
                        ad={externalAds.find((a) => a.network === "google" || a.network === "adsense") || externalAds[0]}
                        onTrackClick={handleExternalAdClick}
                      />
                    </div>
                  </Card>
                )}
              </div>
            </div>
          </Card>
        </TabPanel>
      </PageShell>
    </div>
  );
}
