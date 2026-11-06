/**
 * Issue #2954: StockHub / Options copy / Assets Hub tab re-org.
 *
 * Pins the three-page end state: the Options copy hub's 10 tabs (one
 * row, no options container tab), the Assets Hub's 9 leftover tabs,
 * the 1-1 tab/sub-menu mapping, the deep links, and the legacy
 * research-param mapping so old sub-menu bookmarks keep resolving.
 */
import { describe, it, expect } from "vitest";
import {
  OPTIONS_HUB_TABS,
  optionsHubTabForResearch,
  type OptionsHubTab,
} from "../src/client/OptionsHub";
import { SCREENER_HUB_TABS } from "../src/client/ScreenersHub";
import { STOCK_HUB_TABS } from "../src/client/StockHub";
import { SUB_MENU_CONFIGS } from "../src/client/navConfig";
import { deepLinkHrefForNavNode } from "../src/client/deepLinks";

describe("options copy hub tabs (#2954)", () => {
  it("has exactly the 9 tabs in order, one row, no options container tab", () => {
    expect(OPTIONS_HUB_TABS).toEqual([
      "strategy-scanner",
      "options-runs",
      "strategy-discovery",
      "contracts-screener",
      "custom-thesis",
      "nlq-options",
      "ai-strategy-ideas",
      "iv-history",
      "options-flows",
    ]);
    expect(OPTIONS_HUB_TABS).not.toContain("options");
    expect(OPTIONS_HUB_TABS).not.toContain("symbol-research");
  });

  it("maps every legacy research surface to a copy tab", () => {
    const cases: [string, OptionsHubTab][] = [
      ["discovery", "strategy-discovery"],
      ["strategy-panel", "strategy-discovery"],
      ["contracts", "contracts-screener"],
      ["custom", "custom-thesis"],
      ["best-trade", "custom-thesis"],
      ["compare", "custom-thesis"],
      ["nlq", "nlq-options"],
      ["llm-ideas", "ai-strategy-ideas"],
      ["llm-evaluate", "strategy-discovery"],
    ];
    for (const [surface, tab] of cases) {
      expect(optionsHubTabForResearch(surface)).toBe(tab);
    }
    expect(optionsHubTabForResearch("nope")).toBeNull();
  });
});

describe("assets hub tabs (#2954)", () => {
  it("keeps only the tabs on neither the copy nor StockHub (#2971: the 5 own pages leave the hub)", () => {
    expect(SCREENER_HUB_TABS).toEqual(["forex", "futures", "commodities", "bonds"]);
    for (const tab of SCREENER_HUB_TABS) {
      expect(OPTIONS_HUB_TABS).not.toContain(tab);
      expect(STOCK_HUB_TABS).not.toContain(tab);
    }
  });
});

describe("stock hub tabs (#2954)", () => {
  it("gains patterns + presets and keeps the run-screen alias", () => {
    expect(STOCK_HUB_TABS).toEqual([
      "stocks",
      "new-screen",
      "run-screen",
      "research",
      "patterns",
      "presets",
    ]);
  });
});

describe("sub-menu mapping (#2954)", () => {
  it("gives every copy tab its own options-screener sub-menu", () => {
    const subs = SUB_MENU_CONFIGS["options-screener"];
    const ids = subs.map((s) => s.id);
    // One sub per tab, except strategy-discovery which has two view
    // subs (discovery, strategy-panel) instead of one tab sub.
    for (const id of [
      "strategy-scanner",
      "options-runs",
      "contracts-screener",
      "custom-thesis",
      "nlq-options",
      "ai-strategy-ideas",
      "iv-history",
      "options-flows",
      "discovery",
      "strategy-panel",
    ]) {
      expect(ids).toContain(id);
    }
    // Removed subs stay removed.
    for (const id of ["compare", "llm-ideas", "llm-evaluate", "best-trade"]) {
      expect(ids).not.toContain(id);
    }
    // Renamed subs carry the matched names.
    expect(subs.find((s) => s.id === "contracts-screener")?.label).toBe(
      "Contracts Screener",
    );
    expect(subs.find((s) => s.id === "options-runs")?.label).toBe("Options Runs");
    expect(subs.find((s) => s.id === "nlq-options")?.label).toBe("NLQ-options");
  });

  it("removes best-trade from options-screener and keeps docs/workflow-runs in workflow-runs", () => {
    const ids = SUB_MENU_CONFIGS["options-screener"].map((s) => s.id);
    expect(ids).not.toContain("best-trade");
    const workflowIds = SUB_MENU_CONFIGS["workflow-runs"].map((s) => s.id);
    expect(workflowIds).toContain("docs");
    expect(workflowIds).toContain("workflow-runs");
  });

  it("adds patterns + presets to the stock-hub menu and all 4 to assets-hub", () => {
    expect(SUB_MENU_CONFIGS["stock-hub"].map((s) => s.id)).toEqual([
      "screeners",
      "new-screen",
      "research",
      "patterns",
      "presets",
    ]);
    expect(SUB_MENU_CONFIGS["assets-hub"].map((s) => s.id)).toEqual([
      "forex",
      "futures",
      "commodities",
      "bonds",
    ]);
  });
});

describe("deep links (#2954)", () => {
  it("points copy-tab subs at ?tab=options&view=<tab>", () => {
    expect(deepLinkHrefForNavNode("options-screener", "contracts-screener")).toBe(
      "?tab=options&view=contracts-screener",
    );
    expect(deepLinkHrefForNavNode("options-screener", "options-runs")).toBe(
      "?tab=options&view=options-runs",
    );
    expect(deepLinkHrefForNavNode("options-screener", "nlq-options")).toBe(
      "?tab=options&view=nlq-options",
    );
    expect(deepLinkHrefForNavNode("options-screener", "strategy-scanner")).toBe(
      "?tab=options&view=strategy-scanner",
    );
    expect(deepLinkHrefForNavNode("options-screener", "iv-history")).toBe(
      "?tab=options&view=iv-history",
    );
  });

  it("lands discovery on the discovery view and strategy panel on builder", () => {
    expect(deepLinkHrefForNavNode("options-screener", "discovery")).toBe(
      "?tab=options&view=strategy-discovery&discoveryView=discovery",
    );
    expect(deepLinkHrefForNavNode("options-screener", "strategy-panel")).toBe(
      "?tab=options&view=strategy-discovery&discoveryView=builder",
    );
  });

  it("points stock-hub and assets-hub subs at their pages", () => {
    expect(deepLinkHrefForNavNode("stock-hub", "patterns")).toBe(
      "?tab=stock-hub&view=patterns",
    );
    expect(deepLinkHrefForNavNode("stock-hub", "presets")).toBe(
      "?tab=stock-hub&view=presets",
    );
    expect(deepLinkHrefForNavNode("assets-hub", "forex")).toBe(
      "?tab=assets-hub&view=forex",
    );
    expect(deepLinkHrefForNavNode("planned", "forex")).toBe(
      "?tab=assets-hub&view=forex",
    );
    expect(deepLinkHrefForNavNode(null, "goal-screen")).toBe(
      "?tab=goal-screen",
    );
    expect(deepLinkHrefForNavNode("workflow-runs", "review")).toBe(
      "?tab=review",
    );
  });
});
