import { describe, expect, it } from "vitest";
import { renderLandingPage } from "../src/client/landing";

function styleOf(html: string): string {
  const match = html.match(/<style>([\s\S]*?)<\/style>/);
  expect(match).not.toBeNull();
  return match![1];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ruleFontFamily(style: string, selector: string): string | null {
  const re = new RegExp(
    `${escapeRegExp(selector)}\\s*\\{[^}]*font-family:\\s*var\\((--font-[a-z]+)\\)`,
  );
  return re.exec(style)?.[1] ?? null;
}

describe("Landing token alignment (issue #2752 slice 8, part 1: fonts)", () => {
  const html = renderLandingPage();
  const style = styleOf(html);

  it("loads no JetBrains Mono anywhere", () => {
    expect(html).not.toContain("JetBrains");
  });

  it("defines the token font variables the landing page now consumes", () => {
    expect(style).toContain("--font-mono: 'Inter'");
    expect(style).toContain("--font-code: ui-monospace");
    expect(style).toContain("--font-numeric: 'Inter'");
  });

  it("renders numeric displays in the numeric font", () => {
    for (const selector of [
      ".ticker-item",
      ".kpi-main-val",
      ".pos-sym",
      ".pos-pnl.gain",
      ".stat-counter-box h4",
    ]) {
      expect(ruleFontFamily(style, selector)).toBe("--font-numeric");
    }
  });

  it("renders identifier strings in the code font", () => {
    for (const selector of [".console-url-pill", ".risk-did-meta"]) {
      expect(ruleFontFamily(style, selector)).toBe("--font-code");
    }
  });

  it("renders small labels in the (Inter) mono token", () => {
    for (const selector of [".kbd-shortcut", ".split-badge", ".verdict-tag"]) {
      expect(ruleFontFamily(style, selector)).toBe("--font-mono");
    }
  });
});
