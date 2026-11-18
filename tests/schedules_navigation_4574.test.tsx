/** @vitest-environment jsdom */
/**
 * Issue #4574 — Queues merges into Schedules; the covered Async-jobs copy goes.
 *
 * The Queues page contributes only the dead-letter queue (its async-jobs
 * copy is covered identically by the Schedules background-tasks view —
 * same component, same props, same endpoint — and its approvals link
 * goes away with the page, Approvals already being the one home per
 * #4538). The DLQ becomes the sixth Schedules view; `?tab=queues`
 * redirects to it. This revises #4561's settled "Queues-page
 * async-jobs copy STAYS" decision — the condition in Ceos's directive
 * (coverage) is met, so the copy goes.
 * (Issue #4260, later: the scheduling-channel flags become the seventh
 * view — the pins below now assert seven.)
 *
 * Pins:
 * - 4574-P01 the home resolves exactly seven views, Flags last.
 * - 4574-P02 the Schedules left-nav item carries one sub-menu entry per
 *   view, each with a label, description, and a resolvable icon.
 * - 4574-P03 the new view resolves through the deep-link catalog to
 *   `?tab=schedules&view=dead-letter-queue`, the surface lists seven
 *   values, and the home mounts a TabPanel for it carrying the DLQ.
 * - 4574-P04 `?tab=queues` redirects to the new view; no queues route,
 *   nav entry, or TAB_CONTENT entry remains; QueuesPage is deprecated
 *   in place (no-deletion rule, Policy Gate (i)/(j)) and allowlisted
 *   as a known orphan.
 * - 4574-P05 the async-jobs panel has one LIVE mount — the Schedules
 *   background-tasks view is the one home for async jobs (the retired
 *   QueuesPage keeps its dead mount inside the deprecated file).
 * - 4574-P06 the home renders the Dead-letter queue tab and mounts the
 *   DLQ panel on it.
 * - 4574-P07 the Schedules "queue" (admin queue) view is untouched and
 *   still distinct from the new view.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The DLQ panel fetches on mount; the navigation is under test, not it.
vi.mock("../src/client/DlqPanel", () => ({
  DlqPanel: () => <div data-testid="dlq-panel">dead-letter queue</div>,
}));

import { SchedulesHome } from "../src/client/SchedulesHome";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  SCHEDULES_HOME_VIEWS,
  SCHEDULES_HOME_VIEW_LABELS,
  legacySchedulesRedirect,
} from "../src/client/schedulesHomeView";
import {
  DEFAULT_LEFT_NAV_CONFIG,
  findNavItemConfig,
} from "../src/client/navConfig";
import { NAV_ICON_MAP } from "../src/client/components/NavigationMenu";
import {
  DEEP_LINK_OVERRIDES,
  SURFACE_TAB_DEFS,
  deepLinkForNavNode,
  deepLinkHrefForNavNode,
} from "../src/client/deepLinks";
import navConfigData from "../src/client/nav-config.json";

const here = join(process.cwd());
function read(rel: string): string {
  return readFileSync(join(here, rel), "utf8").replace(/\r\n/g, "\n");
}

const SEVEN_VIEWS = [
  "list",
  "runs",
  "goals",
  "queue",
  "background-tasks",
  "dead-letter-queue",
  "flags",
] as const;
const SEVEN_LABELS = [
  "Schedules",
  "Run ledger",
  "Goal schedules",
  "Queue",
  "Background Tasks",
  "Dead-letter queue",
  "Flags",
];

describe("4574-P01 the home resolves exactly seven views (#4574)", () => {
  it("SCHEDULES_HOME_VIEWS lists the seven views, Flags last", () => {
    expect([...SCHEDULES_HOME_VIEWS]).toEqual([...SEVEN_VIEWS]);
    expect(SEVEN_VIEWS.map((v) => SCHEDULES_HOME_VIEW_LABELS[v])).toEqual(SEVEN_LABELS);
  });
});

describe("4574-P02 Schedules carries one sub-menu entry per view (#4574)", () => {
  it("the Schedules item has seven sub-items with labels, descriptions, and icons", () => {
    const platform = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(platform).toBeDefined();
    const item = platform!.items.find((i) => i.id === "schedules");
    expect(item).toBeDefined();
    expect(item!.subItems).toHaveLength(7);
    for (const [index, view] of SEVEN_VIEWS.entries()) {
      const sub = item!.subItems![index];
      expect(sub.id).toBe(view);
      expect(sub.label).toBe(SEVEN_LABELS[index]);
      expect(sub.description).toBeTruthy();
      expect(sub.description!.length).toBeGreaterThan(0);
      expect(sub.icon).toBeTruthy();
      expect(NAV_ICON_MAP[sub.icon!]).toBeDefined();
    }
    expect(findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "schedules")).toBeDefined();
  });
});

describe("4574-P03 the new view resolves through the catalog (#4574)", () => {
  it("dead-letter-queue deep-links to ?tab=schedules&view=dead-letter-queue", () => {
    expect(deepLinkForNavNode("schedules", "dead-letter-queue")).toEqual({
      tab: "schedules",
      view: "dead-letter-queue",
    });
    expect(deepLinkHrefForNavNode("schedules", "dead-letter-queue")).toBe(
      "?tab=schedules&view=dead-letter-queue",
    );
    expect(DEEP_LINK_OVERRIDES["schedules:dead-letter-queue"]).toEqual({
      tab: "schedules",
      view: "dead-letter-queue",
    });
  });

  it("the surface def carries all seven values and the home mounts a TabPanel for it", () => {
    const surface = SURFACE_TAB_DEFS.find((d) => d.surface === "schedules");
    expect(surface).toBeDefined();
    expect(surface!.page).toBe("schedules");
    expect(surface!.param).toBe("view");
    expect([...surface!.values]).toEqual([...SEVEN_VIEWS]);
    const home = read("src/client/SchedulesHome.tsx");
    expect(home).toContain('tabId="dead-letter-queue"');
    expect(home).toContain('deepLink.view === "dead-letter-queue"');
    expect(home).toContain("DlqPanel");
  });
});

describe("4574-P04 the Queues page is retired (#4574)", () => {
  it("?tab=queues redirects to the new Schedules view", () => {
    expect(legacySchedulesRedirect("?tab=queues")).toEqual({
      tab: "schedules",
      view: "dead-letter-queue",
    });
    expect(legacySchedulesRedirect("?tab=schedules&view=dead-letter-queue")).toBeNull();
  });

  it("no queues route, nav entry, or TAB_CONTENT entry remains; the page is deprecated in place", () => {
    const routes = (navConfigData.routes as { id: string; navEntry?: unknown }[]).map(
      (r) => r.id,
    );
    expect(routes).not.toContain("queues");
    // #4575 merged audit + NLQ into the one audit-vault route: 43 → 42.
    // #4585 split Platform Admin into DataHub + SecurityHub: 42 → 44.
    // Issue 4682 adds the Marketing Hub route: 44 → 45.
    // Issue #5169 adds the Observability route: 45 → 46.
    // PR #5256 (#3696): the nav-settings route joins the table; 46 → 47.
    expect(routes).toHaveLength(47);
    const chat = read("src/client/Chat.tsx");
    expect(chat).not.toContain("QueuesPage");
    expect(chat).not.toContain("queues: (");
    // No-deletion rule (Policy Gate (i)): the file stays, deprecated in
    // place with its successor named, and allowlisted as a known orphan.
    const retired = read("src/client/QueuesPage.tsx");
    expect(retired).toContain("@deprecated");
    expect(retired).toContain("superseded by");
    expect(retired).toContain("dead-letter-queue");
    const wiring = read("tests/tab_content_wiring_gates.test.ts");
    expect(wiring).toContain('"src/client/QueuesPage.tsx"');
  });
});

describe("4574-P05 async jobs has one live home (#4574)", () => {
  it("AsyncJobsPanel has one live mount, in the Schedules home", () => {
    expect(read("src/client/SchedulesHome.tsx")).toContain("<AsyncJobsPanel embedded />");
    // The retired QueuesPage keeps its dead mount inside the deprecated
    // file (no-deletion rule); it is not a live mount.
    const files = readdirSync(join(here, "src/client")).filter((f) =>
      f.endsWith(".tsx"),
    );
    const mounters: string[] = [];
    for (const file of files) {
      const src = read(`src/client/${file}`);
      if (src.includes("<AsyncJobsPanel")) mounters.push(file);
    }
    expect(mounters.sort()).toEqual(["QueuesPage.tsx", "SchedulesHome.tsx"]);
    expect(read("src/client/QueuesPage.tsx")).toContain("@deprecated");
  });
});

describe("4574-P06 the home renders the Dead-letter queue tab (#4574)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(node);
    });
  }

  async function settle(times = 4) {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("the Dead-letter queue tab mounts the DLQ panel", async () => {
    window.history.pushState(null, "", "/?tab=schedules&view=dead-letter-queue");
    await render(
      <ToastProvider>
        <SchedulesHome />
      </ToastProvider>,
    );
    await settle();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    expect(tabs).toEqual(SEVEN_LABELS);
    expect(container.querySelector('[data-testid="dlq-panel"]')).toBeTruthy();
    expect(container.textContent).toContain("Dead-letter queue");
    expect(container.textContent).toContain("Unreplayed records");
  });

  it("the default list view still renders all seven tabs", async () => {
    window.history.pushState(null, "", "/?tab=schedules");
    await render(
      <ToastProvider>
        <SchedulesHome />
      </ToastProvider>,
    );
    await settle();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    expect(tabs).toEqual(SEVEN_LABELS);
  });
});

describe("4574-P07 the admin queue view is untouched (#4574)", () => {
  it("the home still mounts ScheduleQueueView on tabId=queue, distinct from the new view", () => {
    const home = read("src/client/SchedulesHome.tsx");
    expect(home).toContain("ScheduleQueueView");
    expect(home).toContain('tabId="queue"');
    expect(home).toContain('deepLink.view === "queue"');
    expect(SCHEDULES_HOME_VIEW_LABELS["queue"]).toBe("Queue");
    expect(SCHEDULES_HOME_VIEW_LABELS["dead-letter-queue"]).toBe("Dead-letter queue");
  });
});
