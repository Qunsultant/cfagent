/**
 * @vitest-environment jsdom
 *
 * Issue #2149 (epic #2150 slice 1) — social + payments as shell pages
 * with tabbed browsing: internal URL-synced tabs (?view=), visited tabs
 * retained mounted-hidden, and page-level shell retention so switching
 * away and back preserves state. The shell-retain mechanism is a
 * dedicated `shellRetain` route field — NOT the trading `retain` flag,
 * which derives TRADING_TABS and would misroute these pages to the hub.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ROUTES } from "../src/client/routes";
import { TRADING_TABS } from "../src/client/chat/types";
import { SHELL_RETAINED_PAGES } from "../src/client/chat/types";
import { SocialPostingPanel } from "../src/client/SocialPostingPanel";
import { PaymentsPage } from "../src/client/PaymentsPage";

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

// Issue #3121 Phase 2 (#3123) — the goal wrappers moved from
// scheduleApi to jobsApi; the mock replaces only the two the panel
// calls and keeps every other jobsApi export real.
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

function tabButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
}

function panelFor(container: HTMLElement, tabId: string): HTMLElement | null {
  return container.querySelector(`[id$="-panel-${tabId}"]`);
}

describe("shell-retain routing (#2149)", () => {
  it("social + payments carry shellRetain, not the trading retain flag", () => {
    for (const id of ["social", "payments"]) {
      const route = ROUTES.find((r) => r.id === id);
      expect(route).toBeDefined();
      expect((route as any).shellRetain).toBe(true);
      expect(TRADING_TABS.has(id)).toBe(false);
      expect(SHELL_RETAINED_PAGES.has(id)).toBe(true);
    }
  });

  it("the trading set is still exactly the historical 13 ids plus stock-hub (#388, #2896) plus assets-hub (#2954) plus goal-screen, review, track-record (#2970) minus schedules (#3121 S2 — shell-rendered, not hub-hosted)", () => {
    expect([...TRADING_TABS].sort()).toEqual(
      [
        "assets-hub", "autopilot", "goal-screen", "ledger", "omnichannel", "options", "order", "orders",
        "portfolio", "reports", "review", "scanner", "screeners", "stock-hub", "track-record", "trading", "voice",
      ].sort(),
    );
  });
});

describe("social page tabs (#2149)", () => {
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

  async function renderPanel() {
    root = createRoot(container);
    await act(async () => {
      root!.render(<SocialPostingPanel />);
    });
  }

  it("shows five tabs, brief by default, and retains visited panels", async () => {
    await renderPanel();
    const labels = tabButtons(container).map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Brief", "Goals", "Approvals", "Posts", "Token health"]);
    expect(panelFor(container, "brief")?.hidden).toBe(false);
    expect(container.querySelector("textarea")?.value).toBe("hello brief");

    const postsTab = tabButtons(container).find((b) => b.textContent?.trim() === "Posts")!;
    await act(async () => {
      postsTab.click();
    });
    expect(window.location.search).toContain("view=posts");
    expect(panelFor(container, "posts")?.hidden).toBe(false);
    expect(container.textContent).toContain("posted text");

    const briefTab = tabButtons(container).find((b) => b.textContent?.trim() === "Brief")!;
    await act(async () => {
      briefTab.click();
    });
    // Visited panels stay mounted-hidden (retain), not unmounted.
    expect(panelFor(container, "posts")).not.toBeNull();
    expect(panelFor(container, "posts")?.hidden).toBe(true);
    expect(panelFor(container, "brief")?.hidden).toBe(false);
  });

  it("reads the initial tab from ?view=", async () => {
    window.history.pushState(null, "", "/?tab=social&view=approvals");
    await renderPanel();
    expect(panelFor(container, "approvals")?.hidden).toBe(false);
    expect(container.textContent).toContain("pending draft");
  });
});

describe("payments page tabs (#2149)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const transactions = [
    {
      id: "tx1", gateway: "stripe", status: "completed", action: "charge",
      amount: 25, currency: "USD", customer: "Acme", note: "",
      proposerDid: "did:agent:openaimp:payments", authorizerDid: "",
      checkoutUrl: "", createdAt: "2026-10-28T10:00:00Z", proofSignature: "",
    },
  ];
  const gateways = [
    { id: "stripe", name: "Stripe", mode: "live", capabilities: ["cards"] },
    { id: "paypal", name: "PayPal", mode: "test", capabilities: ["wallet"] },
  ];

  beforeEach(() => {
    window.history.pushState(null, "", "/?tab=payments");
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/payments/transactions")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            transactions,
            summary: { totalVolume: 25, completedCount: 1, pendingCount: 0, verifiedDidCount: 1 },
          }),
        };
      }
      if (url.includes("/api/payments/gateways")) {
        return { ok: true, status: 200, json: async () => ({ gateways }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as never;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderPage() {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <PaymentsPage
          active
          user={{ login: "tester", name: "Tester", avatar: "" }}
        />,
      );
    });
  }

  it("shows five tabs with gateways by default and each panel's content", async () => {
    await renderPage();
    const labels = tabButtons(container).map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Gateways", "Stats", "Wallet", "Create", "Ledger"]);
    expect(container.textContent).toContain("Stripe");
    expect(container.textContent).toContain("PayPal");

    const statsTab = tabButtons(container).find((b) => b.textContent?.trim() === "Stats")!;
    await act(async () => {
      statsTab.click();
    });
    expect(window.location.search).toContain("view=stats");
    expect(container.textContent).toContain("Total Settled Volume");

    const ledgerTab = tabButtons(container).find((b) => b.textContent?.trim() === "Ledger")!;
    await act(async () => {
      ledgerTab.click();
    });
    expect(container.textContent).toContain("Acme");

    const createTab = tabButtons(container).find((b) => b.textContent?.trim() === "Create")!;
    await act(async () => {
      createTab.click();
    });
    expect(container.textContent).toContain("Initialize Payment");
  });

  it("shows an empty state when there are no transactions", async () => {
    (globalThis.fetch as any) = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/payments/transactions")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            transactions: [],
            summary: { totalVolume: 0, completedCount: 0, pendingCount: 0, verifiedDidCount: 0 },
          }),
        };
      }
      if (url.includes("/api/payments/gateways")) {
        return { ok: true, status: 200, json: async () => ({ gateways: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    await renderPage();
    const ledgerTab = tabButtons(container).find((b) => b.textContent?.trim() === "Ledger")!;
    await act(async () => {
      ledgerTab.click();
    });
    expect(container.textContent).toContain("No transactions recorded yet.");
  });
});
