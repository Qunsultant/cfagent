/**
 * @vitest-environment jsdom
 *
 * Issue #2161 (epic #2150 slice 2) — referrals + ads + revenue as shell
 * pages with tabbed browsing, following the #2149 pattern exactly:
 * `shellRetain` route flags (NOT the trading `retain` flag), entries
 * moved from TAB_CONTENT to SHELL_CONTENT, internal URL-synced tabs
 * (?view=) with visited panels retained mounted-hidden. Props stay in
 * Chat (categories, external ads, tables and ads are shared across
 * these pages and with nlq), so this slice moves rendering, not state.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { ROUTES } from "../src/client/routes";
import { TRADING_TABS, SHELL_RETAINED_PAGES } from "../src/client/chat/types";
import { AdsTab, type AdsTabProps } from "../src/client/chat/tabs/AdsTab";
import { ReferralsTab, type ReferralsTabProps } from "../src/client/chat/tabs/ReferralsTab";
import { RevenueTab, type RevenueTabProps } from "../src/client/chat/tabs/RevenueTab";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const read = (p: string) => readFileSync(p, "utf8");

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  window.history.pushState(null, "", "/");
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

function tabButtons(c: HTMLElement) {
  return [...c.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
}

function panel(c: HTMLElement, id: string) {
  return c.querySelector(`#${id}`) as HTMLElement | null;
}

async function renderEl(el: React.ReactElement) {
  root = createRoot(container);
  await act(async () => {
    root!.render(el);
  });
}

async function clickTab(label: string) {
  const btn = tabButtons(container).find((b) => b.textContent?.trim() === label)!;
  expect(btn).toBeTruthy();
  await act(async () => {
    btn.click();
  });
}

const bannerConfig = {
  enabled: false,
  showSponsorSpotlight: false,
  showAdNetworkStrip: false,
  showGoogleAdUnits: false,
  tabVisibility: { referrals: false, ads: false },
};

const adsProps: AdsTabProps = {
  adFormError: "",
  adFormSuccess: "",
  ads: [
    {
      id: "a1",
      title: "Quant Pro",
      tagline: "Market intel",
      sponsor: "Acme",
      badge: "Featured",
      url: "https://example.com",
      ctaText: "Claim offer",
      accentColor: "#FF6B35",
      impressions: 1200,
      clicks: 34,
      createdAt: "2026-10-28",
    },
  ],
  adsLoading: false,
  fetchAds: vi.fn(),
  handleAdClick: vi.fn(),
  handleCreateAd: vi.fn(),
  newAdColor: "#FF6B35",
  newAdCta: "Claim",
  newAdSponsor: "Acme",
  newAdTagline: "tag",
  newAdTitle: "Title",
  newAdUrl: "https://example.com",
  savingAd: false,
  setNewAdColor: vi.fn(),
  setNewAdCta: vi.fn(),
  setNewAdSponsor: vi.fn(),
  setNewAdTagline: vi.fn(),
  setNewAdTitle: vi.fn(),
  setNewAdUrl: vi.fn(),
};

const referralsProps: ReferralsTabProps = {
  activeShareRefId: null,
  adBannerConfig: bannerConfig,
  categories: [],
  copiedReferral: false,
  copiedShareRefId: null,
  discordCopied: false,
  externalAds: [],
  fetchReferrals: vi.fn(),
  googleAdsEnabled: false,
  googlePublisherId: "",
  googleSlotId: "",
  handleCopyDiscordEmbed: vi.fn(),
  handleCopyPersonalRef: vi.fn(),
  handleCopyRefDiscordEmbed: vi.fn(),
  handleCreateReferral: vi.fn(),
  handleDeleteReferral: vi.fn(),
  handleExternalAdClick: vi.fn(),
  handleReferralClick: vi.fn(),
  newRefCategory: "",
  newRefReward: "",
  newRefTitle: "",
  newRefUrl: "",
  personalReferralUrl: "https://example.com/ref/abc",
  refFormError: "",
  refFormSuccess: "",
  referrals: [
    {
      id: "r1",
      userLogin: "tester",
      title: "Market Data Pro",
      url: "https://example.com/?ref=x",
      category: "AI & Dev Tools",
      rewardText: "$10 credit",
      clicks: 7,
      signups: 2,
      createdAt: "2026-10-28",
    },
  ],
  referralsLoading: false,
  savingRef: false,
  setActiveShareRefId: vi.fn(),
  setNewRefCategory: vi.fn(),
  setNewRefReward: vi.fn(),
  setNewRefTitle: vi.fn(),
  setNewRefUrl: vi.fn(),
  user: { login: "tester", name: "Tester", avatar: "" },
};

const revenueProps: RevenueTabProps = {
  adBannerConfig: bannerConfig,
  ads: [],
  browseTable: vi.fn(),
  catErrorMsg: "",
  catSuccessMsg: "",
  categories: [],
  extAdErrorMsg: "",
  extAdSuccessMsg: "",
  externalAds: [],
  fetchCategories: vi.fn(),
  fetchExternalAds: vi.fn(),
  fetchRevenueSummary: vi.fn(),
  fetchTables: vi.fn(),
  googleAdFormat: "responsive",
  googleAdsEnabled: false,
  googlePublisherId: "",
  googleSlotId: "",
  handleCreateCategory: vi.fn(),
  handleCreateExternalAd: vi.fn(),
  handleDeleteCategory: vi.fn(),
  handleExternalAdClick: vi.fn(),
  newCatDesc: "",
  newCatIcon: "",
  newCatName: "",
  newCatOrder: "",
  newExtCpc: "",
  newExtCpm: "",
  newExtCta: "",
  newExtNetwork: "direct",
  newExtPlacement: "header_leaderboard",
  newExtTagline: "",
  newExtTitle: "",
  newExtUrl: "",
  revenueLoading: false,
  revenueSummary: null,
  savingCat: false,
  savingExtAd: false,
  setGoogleAdFormat: vi.fn(),
  setGoogleAdsEnabled: vi.fn(),
  setGooglePublisherId: vi.fn(),
  setGoogleSlotId: vi.fn(),
  setNewCatDesc: vi.fn(),
  setNewCatIcon: vi.fn(),
  setNewCatName: vi.fn(),
  setNewCatOrder: vi.fn(),
  setNewExtCpc: vi.fn(),
  setNewExtCpm: vi.fn(),
  setNewExtCta: vi.fn(),
  setNewExtNetwork: vi.fn(),
  setNewExtPlacement: vi.fn(),
  setNewExtTagline: vi.fn(),
  setNewExtTitle: vi.fn(),
  setNewExtUrl: vi.fn(),
  setSelectedBrowseTable: vi.fn(),
  setTab: vi.fn(),
  tables: [],
};

describe("shell wiring (issue #2161)", () => {
  it("referrals, ads and revenue carry shellRetain and nothing else gains it", () => {
    const shellIds = ROUTES.filter((r) => "shellRetain" in r && (r as any).shellRetain).map((r) => r.id);
    expect([...shellIds].sort()).toEqual(["ads", "payments", "referrals", "revenue", "social"]);
    expect([...SHELL_RETAINED_PAGES].sort()).toEqual(["ads", "payments", "referrals", "revenue", "social"]);
  });

  it("trading set is unchanged by the shell move (#2896 adds stock-hub, #2954 adds assets-hub)", () => {
    expect([...TRADING_TABS].sort()).toEqual(
      ["assets-hub", "autopilot", "ledger", "omnichannel", "options", "order", "orders", "portfolio", "reports", "scanner", "schedules", "screeners", "stock-hub", "trading", "voice"].sort(),
    );
  });

  it("Chat renders the three pages from SHELL_CONTENT, not TAB_CONTENT", () => {
    const chat = read("src/client/Chat.tsx");
    const tabSlice = chat.slice(chat.indexOf("const TAB_CONTENT"), chat.indexOf("const SHELL_CONTENT"));
    const shellSlice = chat.slice(chat.indexOf("const SHELL_CONTENT"));
    for (const comp of ["ReferralsTab", "AdsTab", "RevenueTab"]) {
      expect(tabSlice).not.toContain(`<${comp}`);
      expect(shellSlice).toContain(`<${comp}`);
    }
  });
});

describe("ads shell page", () => {
  it("shows Offers by default and switches to Submit with URL sync and retention", async () => {
    await renderEl(<AdsTab {...adsProps} />);
    expect(tabButtons(container).map((b) => b.textContent?.trim())).toEqual(["Offers", "Submit"]);
    expect(panel(container, "ads-panel-offers")?.hidden).toBe(false);
    expect(container.textContent).toContain("Quant Pro");
    await clickTab("Submit");
    expect(window.location.search).toContain("view=submit");
    expect(panel(container, "ads-panel-submit")?.hidden).toBe(false);
    expect(panel(container, "ads-panel-offers")?.hidden).toBe(true);
    expect(container.textContent).toContain("Campaign / Product Title");
  });
});

describe("referrals shell page", () => {
  it("shows Share by default and walks every tab with retention", async () => {
    await renderEl(<ReferralsTab {...referralsProps} />);
    expect(tabButtons(container).map((b) => b.textContent?.trim())).toEqual([
      "Share",
      "Activity",
      "Links",
      "Community",
    ]);
    expect(panel(container, "referrals-panel-share")?.hidden).toBe(false);
    expect(container.textContent).toContain("Share Multi-Agent Studio");
    await clickTab("Activity");
    expect(window.location.search).toContain("view=activity");
    expect(container.textContent).toContain("Referrals Placed");
    await clickTab("Links");
    expect(container.textContent).toContain("Place a New Referral Link");
    expect(container.textContent).toContain("Market Data Pro");
    expect(panel(container, "referrals-panel-share")?.hidden).toBe(true);
    await clickTab("Community");
    expect(container.textContent).toContain("Official Developer Social Platforms");
    expect(panel(container, "referrals-panel-links")).not.toBeNull();
  });
});

describe("revenue shell page", () => {
  it("shows Metrics by default and walks every tab with retention", async () => {
    await renderEl(<RevenueTab {...revenueProps} />);
    expect(tabButtons(container).map((b) => b.textContent?.trim())).toEqual([
      "Metrics",
      "Placements",
      "Categories",
      "Schemas",
      "Google Ads",
    ]);
    expect(panel(container, "revenue-panel-metrics")?.hidden).toBe(false);
    expect(container.textContent).toContain("Total Gross Platform Revenue");
    await clickTab("Placements");
    expect(window.location.search).toContain("view=placements");
    expect(container.textContent).toContain("External Ad Network Placements");
    await clickTab("Categories");
    expect(container.textContent).toContain("Referral Categories & Taxonomy Manager");
    await clickTab("Schemas");
    expect(container.textContent).toContain("Institutional Data Schemas & Record Counts");
    await clickTab("Google Ads");
    expect(container.textContent).toContain("Google Ads & Multi-Network Display Engine");
    expect(panel(container, "revenue-panel-metrics")).not.toBeNull();
  });
});
