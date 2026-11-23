import { describe, it, expect } from "vitest";
import { cleanForPdf } from "../src/trading/pdfText";

describe("cleanForPdf (shared WinAnsi sanitizer, #5109)", () => {
  it("maps known symbols to WinAnsi-safe replacements", () => {
    expect(cleanForPdf("Δ")).toBe("Delta ");
    expect(cleanForPdf("▲")).toBe("+");
    expect(cleanForPdf("▼")).toBe("-");
    expect(cleanForPdf("→")).toBe("->");
    expect(cleanForPdf("←")).toBe("<-");
    expect(cleanForPdf("•")).toBe("*");
    expect(cleanForPdf("—")).toBe("-");
    expect(cleanForPdf("–")).toBe("-");
    expect(cleanForPdf("“x”")).toBe('"x"');
    expect(cleanForPdf("‘y’")).toBe("'y'");
  });

  it("strips any remaining non-WinAnsi character to a space", () => {
    expect(cleanForPdf("a ≥ b")).toBe("a   b");
    expect(cleanForPdf("⚠ warn")).toBe("  warn");
    expect(cleanForPdf("x ≤ 5")).toBe("x   5");
    const out = cleanForPdf("LEAPS (≥180 DTE) ⚠ warn ≤ 5");
    expect(/^[ -~\u00A0-\u00FF]*$/.test(out)).toBe(true);
  });

  it("passes WinAnsi-safe text through unchanged", () => {
    expect(cleanForPdf("plain ascii 123")).toBe("plain ascii 123");
    expect(cleanForPdf("café — done")).toBe("café - done");
  });

  it("treats nullish input as empty", () => {
    expect(cleanForPdf(null as unknown as string)).toBe("");
    expect(cleanForPdf(undefined as unknown as string)).toBe("");
  });
});
