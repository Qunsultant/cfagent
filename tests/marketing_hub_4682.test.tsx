/**
 * @vitest-environment jsdom
 *
 * Issue 4682 — the Marketing Hub: the three standalone marketing
 * pages (referrals, ads, social) render as sections of the one
 * `?tab=marketing-hub` home, each section's inner tabs on its own
 * nested param (referralsTab / adsTab / socialTab), so an inner tab
 * never overwrites the hub tab it is nested inside (the #4576
 * flowsTab/researchTab shape). Composition test, not per-file
 * assertions: mount the hub and assert the three surfaces render on
 * their canonical addresses, exactly one h1 composes on the page
 * (the #3050 PR2 nested-shell defect class), and section switching
 * retains visited panels mounted-hidden — the SocialPostingPanel
 * brief draft must survive a round trip.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarketingHubHome } from "../src/client/MarketingHubHome";
import type { AdsTabProps } from "../src/client/chat/tabs/AdsTab";
import type { ReferralsTabProps } from "../src/client/chat/tabs/ReferralsTab";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/client/socialPostingApi", () => ({
  DAILY_SOCIAL_POST_GOAL_ID: "daily-social-post",
  SOCIAL_BRIEF_MAX_CHARS: 280,
  SOCIAL_CHANNEL_ORDER: ["x", "threads"],
  todayInNewYork: () => "2026-10-28",
  getBrief: async () => ({ brief: "hello brief", date: "2026-10-28" }),
  saveBrief: async (brief: string, date: string) => ({ date }),
  getTokenHealth: async () => ({
    channels: [{ channel: "x", presence: "configured", validity: "unknown" }],
  }),
  listPendingApprovals: async () => ({
    approvals: [
      { draftId: "d1", channel: "x", status: "pending", requestedAtMs: 1761600000000, text: "pending draft" },
    ],
  }),
  listPosts: async () => ({
    ok: true,
    date: "2026-10-28",
    posts: [
      {
        draftId: "p1",
        channel: "x",
        status: "posted",
        createdAtMs: 1761600000000,
        text: "posted text",
        platformPostId: "123",
        submissionEndpoint: "https://x.com",
        postUrl: "https://x.com/post/123",
      },
    ],
  }),
}));

vi.mock("../src/client/jobsApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/client/jobsApi")>();
  return {
    ...original,
    listGoals: async () => ({
      goals: [
        {
          id: "daily-social-post",
          name: "Daily social post",
          cron: "0 9 * * *",
          operation: "social-post",
          budgetCents: 500,
          lastRun: null,
          enabled: false,
        },
      ],
    }),
    triggerGoal: async () => ({
      tick: { timestamp: 1761600000000, goalsEvaluated: 1, jobsCreated: 0, jobsSkipped: 0, errors: [] },
    }),
  };
});

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

describe("Marketing Hub composition (issue 4682)", () => {
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

  async function renderHub() {
    root = createRoot(container);
    await act(async () => {
      root!.render(<MarketingHubHome adsProps={adsProps} referralsProps={referralsProps} />);
    });
  }

  function tabButtons(c: HTMLElement) {
    return [...c.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
  }

  function clickTab(label: string) {
    const btn = tabButtons(container).find((b) => b.textContent?.trim() === label)!;
    expect(btn).toBeTruthy();
    return act(async () => {
      btn.click();
    });
  }

  function assertSingleHubHeading() {
    const headings = [...container.querySelectorAll("h1")];
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent?.trim()).toBe("Marketing Hub");
  }

  it("renders referrals by default on ?tab=marketing-hub, with one h1", async () => {
    window.history.pushState(null, "", "/?tab=marketing-hub");
    await renderHub();
    // The hub's own section tabs — the full section labels, the
    // same labels the left-nav sub-menu carries.
    expect(
      tabButtons(container)
        .filter((b) => b.id.startsWith("marketing-hub-tab-"))
        .map((b) => b.textContent?.trim()),
    ).toEqual(["Referrals & Earn", "Sponsored Marketplace", "Social Posting"]);
    expect(container.querySelector("#marketing-hub-panel-referrals")?.hidden).toBe(false);
    expect(container.querySelector("#referrals-panel-share")?.hidden).toBe(false);
    // The Share panel's invite copy (the referrals list itself lives
    // on the Links inner tab).
    expect(container.textContent).toContain("Share Multi-Agent Studio");
    assertSingleHubHeading();
  });

  it("renders the ads section on ?tab=marketing-hub&view=ads&adsTab=submit", async () => {
    window.history.pushState(null, "", "/?tab=marketing-hub&view=ads&adsTab=submit");
    await renderHub();
    expect(container.querySelector("#marketing-hub-panel-ads")?.hidden).toBe(false);
    expect(container.querySelector("#marketing-hub-panel-referrals")).toBeNull();
    expect(container.querySelector("#ads-panel-submit")?.hidden).toBe(false);
    expect(container.querySelector("#ads-panel-offers")).toBeNull();
    assertSingleHubHeading();
  });

  it("renders the social section on ?tab=marketing-hub&view=social&socialTab=posts", async () => {
    window.history.pushState(null, "", "/?tab=marketing-hub&view=social&socialTab=posts");
    await renderHub();
    expect(container.querySelector("#marketing-hub-panel-social")?.hidden).toBe(false);
    expect(container.querySelector("#social-panel-posts")?.hidden).toBe(false);
    expect(container.textContent).toContain("posted text");
    assertSingleHubHeading();
  });

  it("retains visited sections mounted-hidden, so the social brief draft survives a round trip", async () => {
    window.history.pushState(null, "", "/?tab=marketing-hub&view=social");
    await renderHub();
    expect(container.querySelector("#social-panel-brief")?.hidden).toBe(false);
    expect(container.querySelector("textarea")?.value).toBe("hello brief");

    await clickTab("Sponsored Marketplace");
    expect(container.querySelector("#marketing-hub-panel-ads")?.hidden).toBe(false);
    // The visited social section stays mounted-hidden, not unmounted.
    const socialPanel = container.querySelector("#marketing-hub-panel-social");
    expect(socialPanel).not.toBeNull();
    expect((socialPanel as HTMLElement).hidden).toBe(true);
    expect(container.querySelector("textarea")?.value).toBe("hello brief");

    await clickTab("Referrals & Earn");
    expect(container.querySelector("#marketing-hub-panel-referrals")?.hidden).toBe(false);
    expect(container.querySelector("#marketing-hub-panel-social")).not.toBeNull();
    expect(container.querySelector("#marketing-hub-panel-ads")).not.toBeNull();

    await clickTab("Social Posting");
    expect(container.querySelector("#marketing-hub-panel-social")?.hidden).toBe(false);
    expect(container.querySelector("#social-panel-brief")?.hidden).toBe(false);
    expect(container.querySelector("textarea")?.value).toBe("hello brief");
    assertSingleHubHeading();
  });
});
