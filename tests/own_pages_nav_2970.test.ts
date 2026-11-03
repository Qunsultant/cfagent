/**
 * Own pages (issue #2970, part of epic #2967): Goal Screen, Review,
 * and Track Record gain standalone routes that render their panels
 * directly through the Trading Hub, and Reports/Schedules stop going
 * through the ScreenersHub. The hub still hosts all five tabs until
 * the slimming slice (#2971) removes them.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRoute, hasNavEntry } from "../src/client/routes";
import { mapTabToTradingSubTab, isTradingTab } from "../src/client/chat/types";
import { deepLinkForNavNode, deepLinkHrefForNavNode } from "../src/client/deepLinks";

const here = dirname(fileURLToPath(import.meta.url));
const tradingHubSrc = readFileSync(join(here, "..", "src", "client", "ETradeTradingHub.tsx"), "utf8");

describe("own pages (#2970)", () => {
  it("adds goal-screen, review, and track-record routes with no nav entries", () => {
    const expected = [
      { id: "goal-screen", navGroup: "goal-screen", crumb: "Goal Screen", category: "Intelligence", icon: "Goal" },
      { id: "review", navGroup: "workflow-runs", crumb: "Proposal Review", category: "Playbooks", icon: "Review" },
      { id: "track-record", navGroup: "workflow-runs", crumb: "Track Record", category: "Playbooks", icon: "TrackRecord" },
    ];
    for (const e of expected) {
      const route = getRoute(e.id);
      expect(route).toBeDefined();
      expect(route!.navGroup).toBe(e.navGroup);
      expect(route!.crumb).toBe(e.crumb);
      expect(route!.category).toBe(e.category);
      expect(route!.icon).toBe(e.icon);
      expect((route as unknown as { retain?: boolean }).retain).toBe(true);
      expect(hasNavEntry(route!)).toBe(false);
      expect(isTradingTab(e.id)).toBe(true);
    }
  });

  it("maps the own-page tabs to Trading Hub subtabs", () => {
    expect(mapTabToTradingSubTab("goal-screen")).toBe("goal-screen");
    expect(mapTabToTradingSubTab("review")).toBe("review");
    expect(mapTabToTradingSubTab("track-record")).toBe("track-record");
    expect(mapTabToTradingSubTab("reports")).toBe("reports");
    expect(mapTabToTradingSubTab("schedules")).toBe("schedules");
  });

  it("renders the five panels directly in the Trading Hub", () => {
    for (const panel of [
      "GoalScreenPanel",
      "ReportsPanel",
      "SchedulesPanel",
      "ScreeningReviewPanel",
      "ScreeningOutcomesPanel",
    ]) {
      expect(tradingHubSrc).toContain(`import { ${panel} } from "./${panel}"`);
      expect(tradingHubSrc).toContain(`<${panel}`);
    }
    for (const subtab of ["goal-screen", "review", "track-record", "reports", "schedules"]) {
      expect(tradingHubSrc).toContain(`effectiveSubTab === "${subtab}"`);
    }
    expect(tradingHubSrc).not.toContain('renderScreenersHub("reports")');
    expect(tradingHubSrc).not.toContain('renderScreenersHub("schedules")');
  });

  it("points menu links at the own pages and keeps hub-tab links on the hub", () => {
    expect(deepLinkForNavNode(null, "goal-screen")).toEqual({ tab: "goal-screen" });
    expect(deepLinkHrefForNavNode("workflow-runs", "review")).toBe("?tab=review");
    expect(deepLinkHrefForNavNode("workflow-runs", "track-record")).toBe("?tab=track-record");
    // Until #2971 removes the hub tabs, the hub's own submenu items
    // still land on the hub views (keyed overrides, untouched).
    for (const [view, sub] of [
      ["goal-screen", "goal-screen"],
      ["reports", "reports"],
      ["schedules", "schedules"],
      ["review", "review"],
      ["track-record", "track-record"],
    ]) {
      expect(deepLinkForNavNode("assets-hub", sub)).toEqual({ tab: "assets-hub", view });
    }
  });
});
