import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Touch-target floor pins (#1578, A2; WCAG 2.2 AA 2.5.8).
 *
 * Assessment-01 found interactive icons and table action buttons in
 * ScannerPanel and MemoryBrowser measuring under 24px. ScannerPanel's
 * E3 migration already lands on primitive Buttons (whose small size
 * carries a 30px floor) and MemoryBrowser's raw Search button is
 * converted to a Button in this PR — but nothing pinned the floor
 * itself. These tests pin the CSS facts the audit row depends on, so
 * a future size tweak cannot silently reintroduce sub-24px targets:
 * every primitive small control meets the 24px minimum, and the modal
 * close button (the one icon-only control in every dialog) is
 * guaranteed 24x24 via explicit min sizes.
 */

const ROOT = join(__dirname, "..");
const PRIMITIVES = readFileSync(join(ROOT, "src", "client", "components", "ui", "primitives.css"), "utf8");
const TOKENS = readFileSync(join(ROOT, "src", "client", "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function extractBlock(css: string, selector: string): string | null {
  const idx = css.indexOf(selector);
  if (idx === -1) return null;
  const start = css.indexOf("{", idx);
  if (start === -1) return null;
  let depth = 0;
  let end = start;
  for (; end < css.length; end += 1) {
    if (css[end] === "{") depth += 1;
    else if (css[end] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return css.slice(start + 1, end);
}

function rootVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  const m = TOKENS.match(/:root\s*\{/);
  if (!m || m.index === undefined) return vars;
  const body = extractBlock(TOKENS.slice(m.index), ":root") ?? "";
  for (const decl of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[decl[1]] = decl[2].trim();
  return vars;
}

const ROOT_VARS = rootVars();

/** Resolve a CSS length to pixels: px literals, rem (16px base), or a
 *  var() pointing at a :root token. Returns null when unresolvable. */
function toPx(value: string | undefined): number | null {
  if (!value) return null;
  const px = value.match(/^([\d.]+)px$/);
  if (px) return parseFloat(px[1]);
  const rem = value.match(/^([\d.]+)rem$/);
  if (rem) return parseFloat(rem[1]) * 16;
  const v = value.match(/^var\((--[\w-]+)/);
  if (v) return toPx(ROOT_VARS[v[1]]);
  return null;
}

function minSize(css: string, selector: string, prop: "min-height" | "min-width"): number | null {
  const block = extractBlock(css, selector);
  if (!block) return null;
  const m = block.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`));
  return toPx(m?.[1].trim());
}

describe("touch-target floors (#1578, A2; WCAG 2.2 AA 2.5.8)", () => {
  it.each([
    [".ui-btn.size-sm", "min-height"],
    [".ui-btn.size-md", "min-height"],
    [".pill-group.size-sm .pill-btn", "min-height"],
    [".segmented-control.size-sm .segmented-btn", "min-height"],
  ] as const)("primitive %s %s is at least 24px", (selector, prop) => {
    const px = minSize(PRIMITIVES, selector, prop);
    expect(px, `${selector} must declare ${prop} (currently ${px})`).not.toBeNull();
    expect(px!).toBeGreaterThanOrEqual(24);
  });

  it("modal close button is at least 24x24", () => {
    expect(minSize(TOKENS, ".btn-close-modal", "min-height")).toBeGreaterThanOrEqual(24);
    expect(minSize(TOKENS, ".btn-close-modal", "min-width")).toBeGreaterThanOrEqual(24);
  });
});
