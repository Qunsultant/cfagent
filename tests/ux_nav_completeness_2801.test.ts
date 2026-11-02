/**
 * Left-nav completeness (issue #2801).
 *
 * After #2784, three capabilities were still reachable only by digging
 * through a host panel: Goal Screen (stocks dashboard card only),
 * the options run-records surface (research schedules mode), and the
 * options NLQ query surface (research nlq mode). Each gets its own
 * sub-menu. The trading hub's "nlq" sub-tab is the opposite case: a
 * render branch no caller can ever select (no sub-tab setter, no route
 * mapping, its result state never set) — removed, not linked, because
 * the NLQ capability itself lives in Records NLQ and chat.
 * (Issue #2896: the screeners menu became the Stock Hub menu, so
 * Goal Screen's home is its top-level Intelligence item, not a sub.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUB_MENU_CONFIGS, DEFAULT_LEFT_NAV_CONFIG } from "../src/client/navConfig";
import { NAV_ICON_MAP } from "../src/client/components/NavigationMenu";
import {
  deepLinkForNavNode,
  deepLinkHrefForNavNode,
} from "../src/client/deepLinks";
import { researchSurfaceForParam } from "../src/client/options/researchSurface";

const hubSrc = readFileSync(join(__dirname, "../src/client/ETradeTradingHub.tsx"), "utf8");

describe("nav completeness (#2801)", () => {
  it("keeps Goal Screen as a top-level Intelligence item (#2896 moved the menu)", () => {
    const intel = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-intelligence");
    expect(intel).toBeDefined();
    const found = intel!.items.find((i) => i.id === "goal-screen");
    expect(found).toBeDefined();
    expect(found!.label).toBe("Goal Screen");
    expect(found!.description.length).toBeGreaterThan(0);
    expect(found!.icon).toBe("Goal");
    expect(NAV_ICON_MAP[found!.icon!]).toBeDefined();
    expect(deepLinkForNavNode(null, "goal-screen")).toEqual({
      tab: "screeners",
      view: "goal-screen",
    });
    expect(deepLinkHrefForNavNode(null, "goal-screen")).toBe(
      "?tab=screeners&view=goal-screen",
    );
  });

  it("adds Run Records and NLQ as sub-menus under options-screener", () => {
    for (const [id, label, icon, research] of [
      ["run-records", "Run Records", "Runs", "schedules"],
      ["nlq", "NLQ", "Search", "nlq"],
    ] as const) {
      const found = SUB_MENU_CONFIGS["options-screener"].find((s) => s.id === id);
      expect(found).toBeDefined();
      expect(found!.label).toBe(label);
      expect(found!.description.length).toBeGreaterThan(0);
      expect(found!.icon).toBe(icon);
      expect(NAV_ICON_MAP[found!.icon!]).toBeDefined();
      expect(deepLinkForNavNode("options-screener", id)).toEqual({
        tab: "options",
        params: { research },
      });
      expect(deepLinkHrefForNavNode("options-screener", id)).toBe(
        `?tab=options&research=${research}`,
      );
      // The panel already adopts these modes (#2784's mapping); the
      // new subs only need to name them.
      expect(researchSurfaceForParam(research)).not.toBeNull();
    }
  });

  it("removes the unreachable trading-hub nlq sub-tab branch", () => {
    expect(hubSrc).not.toContain('effectiveSubTab === "nlq"');
    expect(hubSrc).not.toContain('| "nlq"');
    expect(hubSrc).not.toContain('nlq: "Trading"');
  });
});
