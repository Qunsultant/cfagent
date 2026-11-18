import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PRIMITIVES_CSS = readFileSync(join(ROOT, "src/client/components/ui/primitives.css"), "utf8");
const SEARCH_BAR_TSX = readFileSync(join(ROOT, "src/client/components/StockSearchBar.tsx"), "utf8");
const MAIN_TSX = readFileSync(join(ROOT, "src/client/main.tsx"), "utf8");

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match ? match[1] : "";
}

describe("Ctrl-K palette layout (#5501): filter pills and result groups never overlap", () => {
  it("loads primitives.css after styles.deprecated.css so palette layout rules win", () => {
    const depIdx = MAIN_TSX.indexOf("./styles.deprecated.css");
    const primIdx = MAIN_TSX.indexOf("./components/ui/primitives.css");
    expect(depIdx).toBeGreaterThan(-1);
    expect(primIdx).toBeGreaterThan(depIdx);
  });

  it("keeps StockSearchBar palette slots wired to the expected classes", () => {
    expect(SEARCH_BAR_TSX).toContain('panelClassName="stock-search-modal-dialog"');
    expect(SEARCH_BAR_TSX).toContain('className="stock-search-modal-header"');
    expect(SEARCH_BAR_TSX).toContain('className="stock-search-filter-pills"');
    expect(SEARCH_BAR_TSX).toContain('className="stock-search-results-list"');
    expect(SEARCH_BAR_TSX).toContain('className="stock-search-modal-footer"');
  });

  it("pins non-shrinking header, filter pills, and footer alongside a min-height-0 scrollable results list", () => {
    const header = ruleBody(PRIMITIVES_CSS, ".stock-search-modal-dialog .stock-search-modal-header");
    expect(header).toMatch(/flex-shrink:\s*0/);

    const pills = ruleBody(PRIMITIVES_CSS, ".stock-search-modal-dialog .pill-group.stock-search-filter-pills");
    expect(pills).toMatch(/display:\s*flex/);
    expect(pills).toMatch(/flex-wrap:\s*wrap/);
    expect(pills).toMatch(/flex-shrink:\s*0/);
    expect(pills).toMatch(/overflow-x:\s*visible/);
    expect(pills).toMatch(/overflow-y:\s*visible/);

    const results = ruleBody(PRIMITIVES_CSS, ".stock-search-modal-dialog .stock-search-results-list");
    expect(results).toMatch(/min-height:\s*0/);
    expect(results).toMatch(/overflow-y:\s*auto/);

    const footer = ruleBody(PRIMITIVES_CSS, ".stock-search-modal-dialog .stock-search-modal-footer");
    expect(footer).toMatch(/flex-shrink:\s*0/);

    const row = ruleBody(PRIMITIVES_CSS, ".stock-search-modal-dialog .search-result-row");
    expect(row).toMatch(/border-left:\s*3px\s+solid\s+transparent/);
  });
});
