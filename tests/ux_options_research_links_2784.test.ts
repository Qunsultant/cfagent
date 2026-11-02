/**
 * Options research deep links (issue #2784).
 *
 * Every inventoried options surface gets its own link: the link opens
 * the surface, not just its host page. Research modes are plain panel
 * state today, so this issue adds the `research` URL param scheme on
 * the options host (?tab=options) and wires the nav subs, the catalog
 * page cards, and the panel's mode/section adoption to it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUB_MENU_CONFIGS } from "../src/client/navConfig";
import { NAV_ICON_MAP } from "../src/client/components/NavigationMenu";
import {
  deepLinkForNavNode,
  deepLinkHrefForNavNode,
  SURFACE_TAB_DEFS,
} from "../src/client/deepLinks";
import {
  researchSurfaceForParam,
  researchParamForMode,
  OPTIONS_RESEARCH_SURFACE_VALUES,
} from "../src/client/options/researchSurface";

const panelSrc = readFileSync(join(__dirname, "../src/client/options/OptionsResearchPanel.tsx"), "utf8");
const catalogSrc = readFileSync(join(__dirname, "../src/client/OptionsScreenerPage.tsx"), "utf8");
const hubSrc = readFileSync(join(__dirname, "../src/client/ETradeTradingHub.tsx"), "utf8");

const NEW_SUBS = [
  { id: "discovery", label: "Discovery" },
  { id: "strategy-panel", label: "Strategy Panel" },
  { id: "best-trade", label: "Best Trade" },
  { id: "compare", label: "Compare" },
  { id: "llm-ideas", label: "LLM Ideas" },
  { id: "llm-evaluate", label: "LLM Evaluate" },
] as const;

describe("options-screener sub-menus (#2784)", () => {
  it("lists the six research surfaces as sub-menus under options-screener", () => {
    const subs = SUB_MENU_CONFIGS["options-screener"];
    for (const sub of NEW_SUBS) {
      const found = subs.find((s) => s.id === sub.id);
      expect(found).toBeDefined();
      expect(found!.label).toBe(sub.label);
      expect(found!.description.length).toBeGreaterThan(0);
      expect(found!.icon).toBeDefined();
      expect(NAV_ICON_MAP[found!.icon!]).toBeDefined();
    }
  });

  it("deep-links every new sub to the options host with its research value", () => {
    for (const sub of NEW_SUBS) {
      expect(deepLinkForNavNode("options-screener", sub.id)).toEqual({
        tab: "options",
        params: { research: sub.id },
      });
      expect(deepLinkHrefForNavNode("options-screener", sub.id)).toBe(
        `?tab=options&research=${sub.id}`,
      );
    }
  });

  it("fixes the Contract Screen sub: it lands on contracts mode, not the default mode", () => {
    expect(deepLinkForNavNode("options-screener", "options")).toEqual({
      tab: "options",
      params: { research: "contracts" },
    });
  });

  it("registers the options-research surface in the deep-link catalog", () => {
    const def = SURFACE_TAB_DEFS.find((d) => d.surface === "options-research");
    expect(def).toBeDefined();
    expect(def!.page).toBe("options");
    expect(def!.param).toBe("research");
    for (const value of OPTIONS_RESEARCH_SURFACE_VALUES) {
      expect(def!.values).toContain(value);
    }
  });
});

describe("research param scheme (#2784)", () => {
  it("maps each surface value to its panel mode and focus section", () => {
    expect(researchSurfaceForParam("discovery")).toEqual({
      surface: "discovery",
      mode: "discovery",
      sectionId: "options-research-runs",
    });
    expect(researchSurfaceForParam("strategy-panel")).toEqual({
      surface: "strategy-panel",
      mode: "discovery",
      sectionId: "options-research-strategy",
    });
    expect(researchSurfaceForParam("contracts")).toEqual({
      surface: "contracts",
      mode: "contracts",
      sectionId: null,
    });
    expect(researchSurfaceForParam("best-trade")).toEqual({
      surface: "best-trade",
      mode: "custom",
      sectionId: "options-research-custom-actions",
    });
    expect(researchSurfaceForParam("compare")).toEqual({
      surface: "compare",
      mode: "custom",
      sectionId: "options-research-custom-actions",
    });
    expect(researchSurfaceForParam("llm-ideas")).toEqual({
      surface: "llm-ideas",
      mode: "llm-ideas",
      sectionId: null,
    });
    expect(researchSurfaceForParam("llm-evaluate")).toEqual({
      surface: "llm-evaluate",
      mode: "discovery",
      sectionId: "options-research-strategy",
    });
    expect(researchSurfaceForParam("schedules")).toEqual({
      surface: "schedules",
      mode: "schedules",
      sectionId: null,
    });
    expect(researchSurfaceForParam("custom")).toEqual({
      surface: "custom",
      mode: "custom",
      sectionId: null,
    });
  });

  it("rejects unknown values instead of landing on a wrong surface", () => {
    expect(researchSurfaceForParam("bogus")).toBeNull();
    expect(researchSurfaceForParam(null)).toBeNull();
  });

  it("writes the mode back to the param, keeping a custom surface when inside it", () => {
    expect(researchParamForMode("discovery", "best-trade")).toBe("discovery");
    expect(researchParamForMode("custom", "best-trade")).toBe("best-trade");
    expect(researchParamForMode("custom", "compare")).toBe("compare");
    expect(researchParamForMode("custom", "discovery")).toBe("custom");
    expect(researchParamForMode("llm-ideas", null)).toBe("llm-ideas");
  });

  it("the panel adopts the param and carries the focus-section ids", () => {
    expect(panelSrc).toContain("researchSurfaceForParam");
    expect(panelSrc).toContain('get("research")');
    expect(panelSrc).toContain("options-research-strategy");
    expect(panelSrc).toContain("options-research-runs");
    expect(panelSrc).toContain("options-research-custom-actions");
  });

  it("the catalog page links its cards through the deep-link catalog", () => {
    expect(catalogSrc).toContain("deepLinkHrefForNavNode");
  });

  it("the trading hub no longer carries the dead llm-ideas sub-tab", () => {
    expect(hubSrc).not.toContain('"llm-ideas"');
  });
});
