import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const HERE = join(__dirname, "..");
const CSS = "src/client/styles.css";
const NAV = "src/client/components/NavigationMenu.tsx";
const CHAT = "src/client/Chat.tsx";
const PILL = "src/client/components/MarketStatusPill.tsx";
const SEARCH = "src/client/components/StockSearchBar.tsx";
const PANEL = "src/client/components/AutopilotControlCenter.tsx";

function src(p: string): string {
  return readFileSync(join(HERE, p), "utf8");
}

/** Extract the declaration block of a flat `.selector { ... }` rule. */
function ruleBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  expect(close).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

// One shared top-bar control geometry (#3825): the Autopilot tab's
// (`.top-menu-item-btn` — 26px, caption, padding 0 0.65rem, radius 5px).
// Every Tier-1 control uses it; no control carries its own size.
const CONTROL_SELECTORS = [
  ".pill-market-status",
  ".sub-header-market-pill",
  ".stock-search-trigger-btn",
  ".nav-refresh-btn",
  ".nav-trade-btn",
  ".nav-font-size-ctrl",
  ".crumb-subtitle",
];

describe("top-bar control uniformity (#3825)", () => {
  it("one shared class carries the control geometry", () => {
    const css = src(CSS);
    const block = ruleBlock(css, ".top-nav-control");
    expect(block).toContain("height: 26px");
    expect(block).toContain("font-size: var(--font-size-caption)");
    expect(block).toContain("padding: 0 0.65rem");
    expect(block).toContain("border-radius: 5px");
  });

  it("no Tier-1 control declares its own size", () => {
    const css = src(CSS);
    for (const selector of CONTROL_SELECTORS) {
      const block = ruleBlock(css, selector);
      for (const decl of ["height:", "font-size:", "padding:", "border-radius:"]) {
        expect(block).not.toContain(decl);
      }
    }
  });

  it("every Tier-1 control applies the shared class", () => {
    expect(src(PILL)).toContain("top-nav-control");
    expect(src(SEARCH)).toContain("stock-search-trigger-btn top-nav-control");
    const nav = src(NAV);
    expect(nav).toContain("nav-refresh-btn top-nav-control");
    expect(nav).toContain("nav-trade-btn top-nav-control");
    expect(nav).toContain("nav-font-size-ctrl top-nav-control");
    const chat = src(CHAT);
    expect(chat).toContain("nav-refresh-btn top-nav-control");
    expect(chat).toContain("nav-trade-btn top-nav-control");
    expect(chat).toContain("crumb-subtitle top-nav-control");
  });

  it("no hover lift on the top-bar buttons (tabs do not lift)", () => {
    const css = src(CSS);
    expect(ruleBlock(css, ".nav-refresh-btn:hover")).not.toContain("translateY");
    expect(ruleBlock(css, ".nav-trade-btn:hover")).not.toContain("translateY");
  });

  it("the inner clock and shortcut hint are plain caption text, not mini pills", () => {
    const css = src(CSS);
    for (const selector of [".nav-refresh-time", ".stock-search-kbd", ".nav-refresh-icon"]) {
      const block = ruleBlock(css, selector);
      expect(block).not.toContain("font-size:");
      expect(block).not.toContain("background:");
    }
    expect(ruleBlock(css, ".nav-refresh-time")).not.toContain("border-radius:");
    expect(ruleBlock(css, ".stock-search-kbd")).not.toContain("border:");
  });

  it("the Job outcomes TIME column shows date + time", () => {
    const panel = src(PANEL);
    // #4409: the header is a SortHeader button now, not a plain string.
    expect(panel).toContain('label="DATE & TIME"');
    const section = panel.slice(panel.indexOf('<PageSection title="Job outcomes">'));
    // #4407: one canonical date+time helper (the #3825 precedent); the old
    // two-call toLocaleDateString/toLocaleTimeString formatting is gone.
    // The helper's date+time output is pinned in
    // tests/autopilot_provenance_4407.test.tsx.
    expect(section).toContain("formatAutopilotTimestamp(job.createdAt)");
  });
});
