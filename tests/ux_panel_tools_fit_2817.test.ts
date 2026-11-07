/**
 * Settings panel tools-row fit contract (issue #2817).
 *
 * Recurrence of #2720: the "Tuning & Options Data" single row fits
 * only when EVERY element in it can shrink and clip. The #2720 pin
 * asserted class-name presence only, so a dropped shrink/clip rule
 * in any of the three CSS files that feed this row shipped silently.
 * This pin asserts the full contract: row, tuning button, download
 * row, symbol input, download wrapper, and download button.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesSrc = readFileSync(join(__dirname, "../src/client/styles.css"), "utf8");
const dropdownSrc = readFileSync(join(__dirname, "../src/client/options/strategyDiscovery.css"), "utf8");
const menuSrc = readFileSync(join(__dirname, "../src/client/BrokerDynamicMenu.tsx"), "utf8");

// Flat top-level rule block for a selector: from the selector's
// opening brace to its closing brace. These rules nest nothing.
function ruleBlock(src: string, selector: string): string {
  const at = src.indexOf(selector);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = src.indexOf("{", at);
  const close = src.indexOf("}", open);
  expect(open).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThanOrEqual(0);
  return src.slice(open + 1, close);
}

describe("Settings panel tools-row fit contract (#2817)", () => {
  it("extracted Tuning & Options Data from dynamic menu to Platform Admin (#3719)", () => {
    expect(menuSrc).not.toContain("btn-menu-tuning");
    expect(menuSrc).not.toContain("menu-download-row");
  });

  it("the row itself is a clipped flex row that cannot exceed the panel", () => {
    const block = ruleBlock(stylesSrc, ".etrade-tools-cluster.single-row");
    expect(block).toContain("display: flex");
    expect(block).toContain("max-width: 100%");
    expect(block).toContain("overflow: hidden");
  });

  it("the tuning button shrinks and clips (the #2720 half of the contract)", () => {
    const block = ruleBlock(stylesSrc, ".btn-menu-tuning {");
    expect(block).toContain("flex:");
    expect(block).toContain("min-width: 0");
    expect(block).toContain("overflow: hidden");
    expect(block).toContain("text-overflow: ellipsis");
  });

  it("the download row shrinks and its wrapper is a shrinking flex item", () => {
    const row = ruleBlock(stylesSrc, ".menu-download-row {");
    expect(row).toContain("display: flex");
    expect(row).toContain("min-width: 0");
    const wrap = ruleBlock(stylesSrc, ".menu-download-row .menu-data-download-btn");
    expect(wrap).toContain("display: flex");
    expect(wrap).toContain("min-width: 0");
  });

  it("the symbol input keeps a fixed narrow width instead of growing", () => {
    const block = ruleBlock(stylesSrc, ".menu-symbol-input {");
    expect(block).toContain("flex-shrink: 0");
  });

  it("the download button shrinks and clips its label (the #2817 gap)", () => {
    const block = ruleBlock(stylesSrc, ".menu-download-row .options-download-main-btn");
    expect(block).toContain("width: 100%");
    expect(block).toContain("white-space: nowrap");
    expect(block).toContain("min-width: 0");
    expect(block).toContain("overflow: hidden");
    expect(block).toContain("text-overflow: ellipsis");
  });

  it("the dropdown's own file does not re-expand the button", () => {
    // strategyDiscovery.css owns the button's base look; it must not
    // set a fixed width or min-width that defeats the panel's shrink.
    const block = ruleBlock(dropdownSrc, ".options-download-main-btn {");
    expect(block).not.toContain("min-width: 3");
    expect(block).toContain("white-space: nowrap");
  });
});
