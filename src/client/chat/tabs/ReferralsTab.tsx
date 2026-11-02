import React from "react";
import { GoogleAdUnit } from "../../GoogleAdUnit";
import { AdBannerConfig } from "../../adBannerConfig";
import type { CategoryItem } from "../types";
import type { ExternalAdItem } from "../types";
import type { ReferralItem } from "../types";
import type { User } from "../types";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { PageShell } from "../../components/ui/PageShell";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { Select } from "../../components/ui/Select";
import { TextInput } from "../../components/ui/TextInput";
import { FieldShell } from "../../components/ui/Field";
import { Tabs, TabPanel } from "../../components/ui/Tabs";
import { useUrlSyncedTabs } from "../../useUrlSyncedTabs";
import { BRAND } from "../../branding";

export interface ReferralsTabProps {
  activeShareRefId: string | null;
  adBannerConfig: AdBannerConfig;
  categories: CategoryItem[];
  copiedReferral: boolean;
  copiedShareRefId: string | null;
  discordCopied: boolean;
  externalAds: ExternalAdItem[];
  fetchReferrals: () => Promise<void>;
  googleAdsEnabled: boolean;
  googlePublisherId: string;
  googleSlotId: string;
  handleCopyDiscordEmbed: () => void;
  handleCopyPersonalRef: () => void;
  handleCopyRefDiscordEmbed: (refUrl: string, refTitle: string, refId: string) => void;
  handleCreateReferral: (e: React.FormEvent) => Promise<void>;
  handleDeleteReferral: (id: string) => Promise<void>;
  handleExternalAdClick: (ad: ExternalAdItem) => void;
  handleReferralClick: (ref: ReferralItem) => void;
  newRefCategory: string;
  newRefReward: string;
  newRefTitle: string;
  newRefUrl: string;
  personalReferralUrl: string;
  refFormError: string;
  refFormSuccess: string;
  referrals: ReferralItem[];
  referralsLoading: boolean;
  savingRef: boolean;
  setActiveShareRefId: React.Dispatch<React.SetStateAction<string | null>>;
  setNewRefCategory: React.Dispatch<React.SetStateAction<string>>;
  setNewRefReward: React.Dispatch<React.SetStateAction<string>>;
  setNewRefTitle: React.Dispatch<React.SetStateAction<string>>;
  setNewRefUrl: React.Dispatch<React.SetStateAction<string>>;
  user: User;
}

type ReferralsTabId = "share" | "activity" | "links" | "community";
const REFERRALS_TABS: Array<{ id: ReferralsTabId; label: string }> = [
  { id: "share", label: "Share" },
  { id: "activity", label: "Activity" },
  { id: "links", label: "Links" },
  { id: "community", label: "Community" },
];
const isReferralsTab = (v: unknown): v is ReferralsTabId =>
  v === "share" || v === "activity" || v === "links" || v === "community";

/**
 * Referrals & Partner Hub as a shell page (issue #2161, epic #2150
 * slice 2): URL-synced inner tabs (?view=) with visited panels
 * retained mounted-hidden. Share-button skins stay as-is: they are
 * third-party network colors already token-valued, not page layout.
 * All layout, stats, and forms move to primitives and utilities.
 */
export function ReferralsTab({activeShareRefId, adBannerConfig, categories, copiedReferral, copiedShareRefId, discordCopied, externalAds, fetchReferrals, googleAdsEnabled, googlePublisherId, googleSlotId, handleCopyDiscordEmbed, handleCopyPersonalRef, handleCopyRefDiscordEmbed, handleCreateReferral, handleDeleteReferral, handleExternalAdClick, handleReferralClick, newRefCategory, newRefReward, newRefTitle, newRefUrl, personalReferralUrl, refFormError, refFormSuccess, referrals, referralsLoading, savingRef, setActiveShareRefId, setNewRefCategory, setNewRefReward, setNewRefTitle, setNewRefUrl, user}: ReferralsTabProps) {
  const { activeTab, visitedTabs, handleTabChange } = useUrlSyncedTabs<ReferralsTabId>({
    param: "view",
    isValid: isReferralsTab,
    defaultTab: "share",
  });
  const referredSignups = referrals.reduce((sum, r) => sum + r.signups, 0) + (user.login ? 1 : 0);
  return (
    <div>
      <PageShell
        title="Referrals & Partner Hub"
        scopeNote="Invite colleagues to Multi-Agent Studio to unlock GPU compute credits, and place your own developer referral links to earn community rewards."
      >
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchReferrals}
            disabled={referralsLoading}
           loading={referralsLoading}>
            {"🔄 Refresh"}
          </Button>
        </div>

        <Tabs
          tabs={REFERRALS_TABS}
          value={activeTab}
          onChange={handleTabChange}
          ariaLabel="Referrals sections"
          idBase="referrals"
        />
        <TabPanel idBase="referrals" tabId="share" active={activeTab === "share"} retain={visitedTabs.has("share")}>
          <Card>
            <div className="ui-stack">
              <div className="ui-stack">
                <div>
                  <Badge size="xs" uppercase tone="neutral">YOUR EXCLUSIVE INVITE LINK</Badge>
                </div>
                <h4>Share Multi-Agent Studio & Earn $10 Compute Credits</h4>
                <p className="ui-meta">
                  When friends or coworkers sign up using your link, both of you unlock 50,000 free inference tokens and premium agent execution limits.
                </p>
              </div>
              <div className="ui-row">
                <TextInput
                  type="text"
                  readOnly
                  value={personalReferralUrl}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <Button
                  variant="primary"
                  onClick={handleCopyPersonalRef}
                >
                  {copiedReferral ? "✓ Copied!" : "📋 Copy Link"}
                </Button>
              </div>
              <span className="ui-meta-sm">Share to All Social Media Platforms:</span>
              <div className="ui-stat-grid">
                <a
                  href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                    `Build autonomous AI trading and intelligence agents on ${BRAND.name}: ${personalReferralUrl}`
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="social-btn x-twitter"
                  title="Share on X (Twitter)"
                >
                  𝕏 X (Twitter)
                </a>
                <a
                  href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
                    personalReferralUrl
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="social-btn linkedin"
                  title="Share on LinkedIn"
                >
                  💼 LinkedIn
                </a>
                <a
                  href={`https://reddit.com/submit?url=${encodeURIComponent(
                    personalReferralUrl
                  )}&title=${encodeURIComponent(`${BRAND.name}: Autonomous Multi-Agent Trading & Strategy Execution`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="social-btn reddit"
                  title="Share on Reddit"
                >
                  👽 Reddit
                </a>
                <a
                  href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(personalReferralUrl)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="social-btn facebook"
                  title="Share on Facebook"
                >
                  📘 Facebook
                </a>
                <a
                  href={`https://api.whatsapp.com/send?text=${encodeURIComponent(
                    `Build autonomous AI agents on Multi-Agent Studio: ${personalReferralUrl}`
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="social-btn whatsapp"
                  title="Share on WhatsApp"
                >
                  💬 WhatsApp
                </a>
                <a
                  href={`https://t.me/share/url?url=${encodeURIComponent(
                    personalReferralUrl
                  )}&text=${encodeURIComponent("Check out Multi-Agent Studio for edge AI agents")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="social-btn telegram"
                  title="Share on Telegram"
                >
                  ✈️ Telegram
                </a>
                <a
                  href={`https://www.threads.net/intent/post?text=${encodeURIComponent(
                    `Autonomous Multi-Agent Trading Platform: ${personalReferralUrl}`
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="social-btn threads"
                  title="Share on Threads"
                >
                  🧵 Threads
                </a>
                <a
                  href={`https://bsky.app/intent/compose?text=${encodeURIComponent(
                    `Check out ${BRAND.name} for multi-agent trading: ${personalReferralUrl}`
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="social-btn bluesky"
                  title="Share on Bluesky"
                >
                  🦋 Bluesky
                </a>
                <a
                  href={`https://news.ycombinator.com/submitlink?u=${encodeURIComponent(
                    personalReferralUrl
                  )}&t=${encodeURIComponent(`${BRAND.name}: Institutional Multi-Agent Trading System`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="social-btn hackernews"
                  title="Share on Hacker News"
                >
                  🟧 Hacker News
                </a>
                <a
                  href={`https://pinterest.com/pin/create/button/?url=${encodeURIComponent(
                    personalReferralUrl
                  )}&description=${encodeURIComponent("Autonomous Multi-Agent Trading & Strategy Execution")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="social-btn pinterest"
                  title="Pin on Pinterest"
                >
                  📌 Pinterest
                </a>
                <Button
                  variant="secondary"
                  onClick={handleCopyDiscordEmbed}
                  title="Copy Discord rich markdown format"
                >
                  👾 {discordCopied ? "✓ Discord Link Copied!" : "Discord Embed"}
                </Button>
              </div>
            </div>
          </Card>
        </TabPanel>
        <TabPanel idBase="referrals" tabId="activity" active={activeTab === "activity"} retain={visitedTabs.has("activity")}>
          <div className="ui-stat-grid">
            <Card padding="none">
              <div className="ui-row">
                <span>🔗</span>
                <div className="ui-stack">
                  <strong>{referrals.length}</strong>
                  <span className="ui-meta-sm">Referrals Placed</span>
                </div>
              </div>
            </Card>
            <Card padding="none">
              <div className="ui-row">
                <span>🖱️</span>
                <div className="ui-stack">
                  <strong>{referrals.reduce((sum, r) => sum + r.clicks, 0)}</strong>
                  <span className="ui-meta-sm">Total Link Clicks</span>
                </div>
              </div>
            </Card>
            <Card padding="none">
              <div className="ui-row">
                <span>👥</span>
                <div className="ui-stack">
                  <strong>{referredSignups}</strong>
                  <span className="ui-meta-sm">Referred Sign-ups</span>
                </div>
              </div>
            </Card>
            <Card padding="none" highlight>
              <div className="ui-row">
                <span>💎</span>
                <div className="ui-stack">
                  <strong>${(referredSignups * 10).toFixed(0)}.00</strong>
                  <span className="ui-meta-sm">Earned Compute</span>
                </div>
              </div>
            </Card>
          </div>
        </TabPanel>
        <TabPanel idBase="referrals" tabId="links" active={activeTab === "links"} retain={visitedTabs.has("links")}>
          <div className="ui-form-row">
            <Card>
              <div className="ui-stack">
                <div>
                  <h4>➕ Place a New Referral Link</h4>
                  <p className="ui-meta">Publish your affiliate or referral link to your account to share with teammates and fellow developers.</p>
                </div>
                <form onSubmit={handleCreateReferral} className="ui-stack">
                  {refFormSuccess && <Notice tone="success">{refFormSuccess}</Notice>}
                  {refFormError && <Notice tone="danger">{refFormError}</Notice>}

                  <FieldShell id="ref-title" label="Link Title / Service *">
                    <TextInput
                      type="text"
                      placeholder="e.g. Market Data Pro, Cursor AI, Supabase"
                      value={newRefTitle}
                      onChange={(e) => setNewRefTitle(e.target.value)}
                      required
                    />
                  </FieldShell>

                  <FieldShell id="ref-url" label="Destination Referral URL *">
                    <TextInput
                      type="url"
                      placeholder="https://service.com/?ref=yourname"
                      value={newRefUrl}
                      onChange={(e) => setNewRefUrl(e.target.value)}
                      required
                    />
                  </FieldShell>

                  <div className="ui-form-row">
                    <FieldShell id="ref-category" label="Category">
                      <Select
                        value={newRefCategory}
                        onChange={(e) => setNewRefCategory(e.target.value)}
                      >
                        {categories.length > 0 ? (
                          categories.map((cat) => (
                            <option key={cat.id} value={cat.name}>
                              {cat.icon} {cat.name}
                            </option>
                          ))
                        ) : (
                          <>
                            <option value="AI & Dev Tools">🤖 AI & Dev Tools</option>
                            <option value="Cloud & Hosting">☁️ Cloud & Hosting</option>
                            <option value="Database & Storage">🗄️ Database & Storage</option>
                            <option value="Security & Auth">🛡️ Security & Auth</option>
                            <option value="SaaS & Productivity">⚡ SaaS & Productivity</option>
                          </>
                        )}
                      </Select>
                    </FieldShell>

                    <FieldShell id="ref-reward" label="Bonus / Reward Offer">
                      <TextInput
                        type="text"
                        placeholder="e.g. Get $10 in free API credits"
                        value={newRefReward}
                        onChange={(e) => setNewRefReward(e.target.value)}
                      />
                    </FieldShell>
                  </div>

                  <div>
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={savingRef || !newRefTitle.trim() || !newRefUrl.trim()}
                     loading={savingRef}>
                      {"🚀 Publish Referral Link"}
                    </Button>
                  </div>
                </form>
              </div>
            </Card>

            <Card>
              <div className="ui-stack">
                <div>
                  <h4>📋 Your Placed Referral Links ({referrals.length})</h4>
                  <p className="ui-meta">Track clicks and manage your active promotional URLs.</p>
                </div>

                <div className="ui-stack">
                  {referrals.length === 0 ? (
                    <EmptyState
                      icon="🔗"
                      title="No referral links placed yet."
                      description="Use the form on the left to add your first affiliate or tool referral link."
                    />
                  ) : (
                    referrals.map((ref) => (
                      <Card padding="none" key={ref.id}>
                        <div className="ui-stack">
                          <div className="ui-row">
                            <Badge size="xs" tone="accent">{ref.category}</Badge>
                            <Badge size="xs" tone="neutral">🖱️ {ref.clicks} clicks</Badge>
                          </div>
                          <h5>{ref.title}</h5>
                          <p className="ui-meta">🎁 {ref.rewardText}</p>
                          <div className="ui-meta-sm">
                            <code>{ref.url}</code>
                          </div>
                          <div className="ui-row">
                            <Button
                              variant="secondary"
                              tone="subtle"
                              size="sm"
                              onClick={() => handleReferralClick(ref)}
                            >
                              Test Link ↗
                            </Button>
                            <Button
                              variant="primary"
                              tone="subtle"
                              size="sm"
                              onClick={() => setActiveShareRefId(activeShareRefId === ref.id ? null : ref.id)}
                              title="Share on social media"
                            >
                              📢 Share Link
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteReferral(ref.id)}
                              title="Delete this referral"
                            >
                              🗑️ Delete
                            </Button>
                          </div>
                          {activeShareRefId === ref.id && (
                            <div className="ui-row">
                              <span className="ui-meta-sm">Share:</span>
                              <a
                                href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`${ref.title}: ${ref.url}`)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mini-social-btn x-twitter"
                                title="Share on X"
                              >
                                𝕏
                              </a>
                              <a
                                href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(ref.url)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mini-social-btn linkedin"
                                title="Share on LinkedIn"
                              >
                                💼
                              </a>
                              <a
                                href={`https://reddit.com/submit?url=${encodeURIComponent(ref.url)}&title=${encodeURIComponent(ref.title)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mini-social-btn reddit"
                                title="Share on Reddit"
                              >
                                👽
                              </a>
                              <a
                                href={`https://api.whatsapp.com/send?text=${encodeURIComponent(`${ref.title}: ${ref.url}`)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mini-social-btn whatsapp"
                                title="Share on WhatsApp"
                              >
                                💬
                              </a>
                              <a
                                href={`https://t.me/share/url?url=${encodeURIComponent(ref.url)}&text=${encodeURIComponent(ref.title)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mini-social-btn telegram"
                                title="Share on Telegram"
                              >
                                ✈️
                              </a>
                              <a
                                href={`https://threads.net/intent/post?text=${encodeURIComponent(`${ref.title}: ${ref.url}`)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mini-social-btn threads"
                                title="Share on Threads"
                              >
                                🧵
                              </a>
                              <a
                                href={`https://bsky.app/intent/compose?text=${encodeURIComponent(`${ref.title}: ${ref.url}`)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mini-social-btn bluesky"
                                title="Share on Bluesky"
                              >
                                🦋
                              </a>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => handleCopyRefDiscordEmbed(ref.url, ref.title, ref.id)}
                                title="Copy Discord embed"
                              >
                                {copiedShareRefId === ref.id ? "✓" : "👾"}
                              </Button>
                            </div>
                          )}
                        </div>
                      </Card>
                    ))
                  )}
                </div>
              </div>
            </Card>
          </div>
        </TabPanel>
        <TabPanel idBase="referrals" tabId="community" active={activeTab === "community"} retain={visitedTabs.has("community")}>
          <Card>
            <div className="ui-stack">
              <div>
                <h4>🌐 Official Developer Social Platforms & Communities</h4>
                <p className="ui-meta">
                  Connect with the OpenAIMP ecosystem, join real-time agent engineering discussions, and stay updated across all social media networks.
                </p>
              </div>

              <div className="ui-stat-grid">
                <a href="https://github.com/OpenAIMP/cfagent" target="_blank" rel="noopener noreferrer" className="ui-plain-link">
                  <Card padding="none">
                    <div className="ui-row">
                      <span>🐙</span>
                      <div className="ui-stack">
                        <strong>GitHub</strong>
                        <span className="ui-meta-sm">Source code, PRs, and issues</span>
                      </div>
                      <span className="ui-push">↗</span>
                    </div>
                  </Card>
                </a>
                <a href="https://discord.com" target="_blank" rel="noopener noreferrer" className="ui-plain-link">
                  <Card padding="none">
                    <div className="ui-row">
                      <span>👾</span>
                      <div className="ui-stack">
                        <strong>Discord Server</strong>
                        <span className="ui-meta-sm">Real-time agent developer chat</span>
                      </div>
                      <span className="ui-push">↗</span>
                    </div>
                  </Card>
                </a>
                <a href="https://x.com/OpenAIMP" target="_blank" rel="noopener noreferrer" className="ui-plain-link">
                  <Card padding="none">
                    <div className="ui-row">
                      <span>𝕏</span>
                      <div className="ui-stack">
                        <strong>X (Twitter)</strong>
                        <span className="ui-meta-sm">Announcements & product updates</span>
                      </div>
                      <span className="ui-push">↗</span>
                    </div>
                  </Card>
                </a>
                <a href="https://youtube.com/@OpenAIMP" target="_blank" rel="noopener noreferrer" className="ui-plain-link">
                  <Card padding="none">
                    <div className="ui-row">
                      <span>▶️</span>
                      <div className="ui-stack">
                        <strong>YouTube</strong>
                        <span className="ui-meta-sm">Video tutorials & agent architecture demos</span>
                      </div>
                      <span className="ui-push">↗</span>
                    </div>
                  </Card>
                </a>
                <a href="https://t.me/OpenAIMP" target="_blank" rel="noopener noreferrer" className="ui-plain-link">
                  <Card padding="none">
                    <div className="ui-row">
                      <span>✈️</span>
                      <div className="ui-stack">
                        <strong>Telegram Community</strong>
                        <span className="ui-meta-sm">VIP channel & developer group</span>
                      </div>
                      <span className="ui-push">↗</span>
                    </div>
                  </Card>
                </a>
                <a href="https://linkedin.com/company/openaimp" target="_blank" rel="noopener noreferrer" className="ui-plain-link">
                  <Card padding="none">
                    <div className="ui-row">
                      <span>💼</span>
                      <div className="ui-stack">
                        <strong>LinkedIn</strong>
                        <span className="ui-meta-sm">Enterprise agent solutions & news</span>
                      </div>
                      <span className="ui-push">↗</span>
                    </div>
                  </Card>
                </a>
                <a href="https://reddit.com/r/algotrading" target="_blank" rel="noopener noreferrer" className="ui-plain-link">
                  <Card padding="none">
                    <div className="ui-row">
                      <span>👽</span>
                      <div className="ui-stack">
                        <strong>Reddit</strong>
                        <span className="ui-meta-sm">r/algotrading & r/LocalLLaMA discussions</span>
                      </div>
                      <span className="ui-push">↗</span>
                    </div>
                  </Card>
                </a>
                <a href="https://bsky.app/profile/openaimp.bsky.social" target="_blank" rel="noopener noreferrer" className="ui-plain-link">
                  <Card padding="none">
                    <div className="ui-row">
                      <span>🦋</span>
                      <div className="ui-stack">
                        <strong>Bluesky</strong>
                        <span className="ui-meta-sm">Open decentralized social updates</span>
                      </div>
                      <span className="ui-push">↗</span>
                    </div>
                  </Card>
                </a>
                <a href="https://threads.net/@openaimp" target="_blank" rel="noopener noreferrer" className="ui-plain-link">
                  <Card padding="none">
                    <div className="ui-row">
                      <span>🧵</span>
                      <div className="ui-stack">
                        <strong>Threads</strong>
                        <span className="ui-meta-sm">Bite-sized AI developer discussions</span>
                      </div>
                      <span className="ui-push">↗</span>
                    </div>
                  </Card>
                </a>
                <a href="https://instagram.com/openaimp" target="_blank" rel="noopener noreferrer" className="ui-plain-link">
                  <Card padding="none">
                    <div className="ui-row">
                      <span>📷</span>
                      <div className="ui-stack">
                        <strong>Instagram</strong>
                        <span className="ui-meta-sm">Developer behind-the-scenes & clips</span>
                      </div>
                      <span className="ui-push">↗</span>
                    </div>
                  </Card>
                </a>
                <a href="https://tiktok.com/@openaimp" target="_blank" rel="noopener noreferrer" className="ui-plain-link">
                  <Card padding="none">
                    <div className="ui-row">
                      <span>🎵</span>
                      <div className="ui-stack">
                        <strong>TikTok</strong>
                        <span className="ui-meta-sm">Quick tips & AI agent shorts</span>
                      </div>
                      <span className="ui-push">↗</span>
                    </div>
                  </Card>
                </a>
                <a href="https://whatsapp.com" target="_blank" rel="noopener noreferrer" className="ui-plain-link">
                  <Card padding="none">
                    <div className="ui-row">
                      <span>💬</span>
                      <div className="ui-stack">
                        <strong>WhatsApp Community</strong>
                        <span className="ui-meta-sm">Direct alerts & release announcements</span>
                      </div>
                      <span className="ui-push">↗</span>
                    </div>
                  </Card>
                </a>
              </div>
            </div>
          </Card>
        </TabPanel>

        {adBannerConfig.enabled && adBannerConfig.showGoogleAdUnits && Boolean(adBannerConfig.tabVisibility.referrals) && googleAdsEnabled && (
          <div>
            <GoogleAdUnit
              format="responsive"
              publisherId={googlePublisherId}
              slot={googleSlotId}
              ad={externalAds.find((a) => a.network === "google" || a.network === "adsense") || externalAds[0]}
              onTrackClick={handleExternalAdClick}
            />
          </div>
        )}
      </PageShell>
    </div>
  );
}
