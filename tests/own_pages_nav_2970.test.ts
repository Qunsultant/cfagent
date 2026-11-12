/**
 * Own pages (issue #2970, part of epic #2967): Goal Screen, Review,
 * and Track Record gain standalone routes that render their panels
 * directly through the Trading Hub, and Reports/Schedules stop going
 * through the ScreenersHub. The hub still hosts all five tabs until
 * the slimming slice (#2971) removes them.
 *
 * Issue #3121 S2: schedules left the hub before #2971 — it renders
 * from the shell (Chat.tsx TAB_CONTENT → SchedulesHome). The four
 * remaining own pages still render through the hub.
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
// Issue #3050 PR1: the hub no longer imports the track-record dashboards
// directly — it renders TrackRecordPanel, which composes them.
const trackRecordSrc = readFileSync(join(here, "..", "src", "client", "TrackRecordPanel.tsx"), "utf8");

describe("own pages (#2970)", () => {
  it("adds goal-screen, review, and track-record routes with no nav entries", () => {
    const expected = [
      { id: "goal-screen", navGroup: "goal-screen", crumb: "Goal Screen", category: "Intelligence", icon: "Goal" },
      { id: "review", navGroup: "workflow-runs", crumb: "Proposal Review", category: "Platform", icon: "Review" },
      { id: "track-record", navGroup: "workflow-runs", crumb: "Track Record", category: "Platform", icon: "TrackRecord" },
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
    // Issue #3121 S2: schedules is de-hubbed — it falls to the hub
    // default because the shell owns it now, not the hub.
    expect(mapTabToTradingSubTab("schedules")).toBe("autopilot");
  });

  it("renders the four panels directly in the Trading Hub", () => {
    for (const panel of [
      "GoalScreenPanel",
      "ReportsPanel",
      "ScreeningReviewPanel",
      "TrackRecordPanel",
    ]) {
      expect(tradingHubSrc).toContain(`import { ${panel} } from "./${panel}"`);
      expect(tradingHubSrc).toContain(`<${panel}`);
    }
    // Issue #3121 S2: schedules renders from the shell, not the hub.
    expect(tradingHubSrc).not.toContain('import { SchedulesPanel } from "./SchedulesPanel"');
    expect(tradingHubSrc).not.toContain("<SchedulesPanel");
    const chatSrc = readFileSync(join(here, "..", "src", "client", "Chat.tsx"), "utf8");
    expect(chatSrc).toContain('import { SchedulesHome } from "./SchedulesHome";');
    // Issue #4247 class: match the entry regardless of line endings (a CRLF
    // checkout would never satisfy an exact "\n" literal — the assertion is
    // about Chat.tsx routing the schedules tab to SchedulesHome, not spacing).
    expect(chatSrc).toMatch(/schedules: \(\r?\n\s*<SchedulesHome/);
    // Issue #3050 PR1: the track-record dashboards moved one level down —
    // the hub renders TrackRecordPanel, which composes all three.
    for (const dashboard of [
      "CalibrationDashboard",
      "EnrichmentDashboard",
      "ScreeningOutcomesPanel",
    ]) {
      expect(trackRecordSrc).toContain(`import { ${dashboard} } from "./${dashboard}"`);
      expect(trackRecordSrc).toContain(`<${dashboard}`);
    }
    for (const subtab of ["goal-screen", "review", "track-record", "reports"]) {
      expect(tradingHubSrc).toContain(`effectiveSubTab === "${subtab}"`);
    }
    expect(tradingHubSrc).not.toContain('effectiveSubTab === "schedules"');
    expect(tradingHubSrc).not.toContain('renderScreenersHub("reports")');
    expect(tradingHubSrc).not.toContain('renderScreenersHub("schedules")');
  });

  it("points menu links at the own pages and keeps hub-tab links on the hub", () => {
    expect(deepLinkForNavNode(null, "goal-screen")).toEqual({ tab: "goal-screen" });
    expect(deepLinkHrefForNavNode("workflow-runs", "review")).toBe("?tab=review");
    expect(deepLinkHrefForNavNode("workflow-runs", "track-record")).toBe("?tab=track-record");
    // Issue #2971 removes the hub tabs: the keyed assets-hub:*
    // overrides are gone, so the former hub submenu items land on
    // the own pages too.
    for (const sub of ["goal-screen", "reports", "schedules", "review", "track-record"]) {
      expect(deepLinkForNavNode("assets-hub", sub)).toEqual({ tab: sub });
    }
  });
});
