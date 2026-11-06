/**
 * Options research deep links (issue #2784).
 *
 * Every inventoried options surface gets its own link: the link opens
 * the surface, not just its host page. Research modes are plain panel
 * state today, so this issue adds the `research` URL param scheme on
 * the options host (?tab=options) and wires the nav subs, the catalog
 * page cards, and the panel's mode/section adoption to it.
 * (Issue #2954: the nav subs became copy-hub view links, except
 * Best Trade which keeps its research link; the research scheme itself
 * survives as the copy hub's legacy mapping.)
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
import { OPTIONS_HUB_TABS } from "../src/client/OptionsHub";
import {
  researchSurfaceForParam,
  researchParamForMode,
  OPTIONS_RESEARCH_SURFACE_VALUES,
} from "../src/client/options/researchSurface";

const panelSrc = readFileSync(join(__dirname, "../src/client/options/OptionsResearchPanel.tsx"), "utf8");
const catalogSrc = readFileSync(join(__dirname, "../src/client/OptionsScreenerPage.tsx"), "utf8");
const hubSrc = readFileSync(join(__dirname, "../src/client/ETradeTradingHub.tsx"), "utf8");

const KEPT_SUBS = [
  { id: "discovery", label: "Discovery" },
  { id: "strategy-panel", label: "Strategy Panel" },
] as const;

describe("options-screener sub-menus (#2784)", () => {
  it("lists the surviving research surfaces as sub-menus under options-screener", () => {
    const subs = SUB_MENU_CONFIGS["options-screener"];
    for (const sub of KEPT_SUBS) {
      const found = subs.find((s) => s.id === sub.id);
      expect(found).toBeDefined();
      expect(found!.label).toBe(sub.label);
      expect(found!.description.length).toBeGreaterThan(0);
      expect(found!.icon).toBeDefined();
      expect(NAV_ICON_MAP[found!.icon!]).toBeDefined();
    }
    // #2954 removed the compare / LLM ideas / LLM evaluate subs (their
    // content folded into Custom Thesis / the AI Ideas tab).
    // #2994 removed the Best Trade sub the same way; its research link
    // survives as a kept override (see the deep-link test below).
    for (const id of ["compare", "llm-ideas", "llm-evaluate", "best-trade"]) {
      expect(subs.find((s) => s.id === id)).toBeUndefined();
    }
  });

  it("deep-links discovery/strategy-panel views and the kept best-trade research link", () => {
    const cases = [
      [
        "discovery",
        { tab: "options", view: "strategy-discovery", params: { discoveryView: "discovery" } },
        "?tab=options&view=strategy-discovery&discoveryView=discovery",
      ],
      [
        "strategy-panel",
        { tab: "options", view: "strategy-discovery", params: { discoveryView: "builder" } },
        "?tab=options&view=strategy-discovery&discoveryView=builder",
      ],
      [
        "best-trade",
        { tab: "options", params: { research: "best-trade" } },
        "?tab=options&research=best-trade",
      ],
    ] as const;
    for (const [id, link, href] of cases) {
      expect(deepLinkForNavNode("options-screener", id)).toEqual(link);
      expect(deepLinkHrefForNavNode("options-screener", id)).toBe(href);
    }
  });

  it("renames the Contract Screen sub to Contracts Screener (#2954): it lands on the contracts tab", () => {
    expect(deepLinkForNavNode("options-screener", "contracts-screener")).toEqual({
      tab: "options",
      view: "contracts-screener",
    });
  });

  it("registers the options-hub surface in the deep-link catalog", () => {
    const def = SURFACE_TAB_DEFS.find((d) => d.surface === "options-hub");
    expect(def).toBeDefined();
    expect(def!.page).toBe("options");
    expect(def!.param).toBe("view");
    for (const value of OPTIONS_HUB_TABS) {
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
    expect(researchSurfaceForParam("custom")).toEqual({
      surface: "custom",
      mode: "custom",
      sectionId: null,
    });
  });

  it("the schedules surface is retired (U-03 #3121): it resolves to no mode", () => {
    expect(researchSurfaceForParam("schedules")).toBeNull();
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
