// @vitest-environment node
/**
 * Issue 6499 — the Opportunity Hunt report splits evaluated symbols into a
 * patterned section and a no-pattern section, each headed and counted, and the
 * PDF's Exits column is danger red.
 *
 * Pins:
 * - 6499-P01 the shared model produces two groups with exact headings/counts
 *   and the required order (patterns desc then symbol; quiet symbol asc);
 * - 6499-P02 the PDF prints both headings and both groups' rows in that order;
 * - 6499-P03 the shared table renderer colours a configured column (Exits) and
 *   leaves other columns in ink.
 */
import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import type { OpportunityHuntResult } from "../src/services/opportunityHunt";
import { buildOpportunityHuntReportModel } from "../src/client/opportunityHuntReportModel";
import { generateOpportunityHuntPdf } from "../src/trading/opportunityHuntReportPdf";
import { renderTable, type PdfCtx } from "../src/trading/pdfDrawing";

const levels = { entryLow: 9.5, entryHigh: 10.5, stopLoss: 9, takeProfit: 11 };

function result(): OpportunityHuntResult {
  return {
    scanned: 4,
    skipped: 0,
    setups: [
      { symbol: "ZZZZ", strategy: "breakout", direction: "entry", lastClose: 10, detail: "break", levels },
      { symbol: "ZZZZ", strategy: "mean_reversion", direction: "entry", lastClose: 10, detail: "revert", levels },
      { symbol: "ZZZZ", strategy: "rsi_reversal", direction: "entry", lastClose: 10, detail: "dip", levels },
      { symbol: "ZZZZ", strategy: "sma_crossover", direction: "entry", lastClose: 10, detail: "cross", levels },
      { symbol: "AAAA", strategy: "sma_crossover", direction: "entry", lastClose: 10, detail: "cross", levels },
    ],
    summary: "ignored",
    asOf: "2026-11-25T14:00:00.000Z",
    holdingsStatus: { available: true, broker: "alpaca" },
    seriesBySymbol: {
      AAAA: [9, 10],
      ZZZZ: [9, 10],
      BBBB: [5, 5],
      CCCC: [7, 7],
    },
  };
}

function extractPdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const parts: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw)) !== null) {
    const chunk = Buffer.from(m[1], "latin1");
    try {
      parts.push(inflateSync(chunk).toString("latin1"));
    } catch {
      parts.push(chunk.toString("latin1"));
    }
  }
  const joined = parts.join("\n");
  const strings: string[] = [];
  const hexRe = /<([0-9A-Fa-f\s]+)>/g;
  let hm: RegExpExecArray | null;
  while ((hm = hexRe.exec(joined)) !== null) {
    const hex = hm[1].replace(/\s+/g, "");
    if (hex.length % 2 !== 0) continue;
    let decoded = "";
    for (let i = 0; i < hex.length; i += 2) {
      decoded += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    strings.push(decoded);
  }
  const litRe = /\((?:\\\\.|[^\\\\()])*\)/g;
  let lm: RegExpExecArray | null;
  while ((lm = litRe.exec(joined)) !== null) {
    strings.push(
      lm[0]
        .slice(1, -1)
        .replace(/\\\\([()\\\\])/g, "$1")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r"),
    );
  }
  return strings.join(" ");
}

describe("hunt report sections (issue 6499)", () => {
  it("P01: two counted groups, patterned desc by count then symbol, quiet by symbol", () => {
    const model = buildOpportunityHuntReportModel(result());
    expect(model.tableGroups).toHaveLength(2);
    expect(model.tableGroups[0]).toMatchObject({
      key: "patterns",
      heading: "Symbols with patterns (2)",
      defaultSort: { key: "patterns", dir: "desc" },
    });
    expect(model.tableGroups[0].rows.map((row) => row.symbol)).toEqual(["ZZZZ", "AAAA"]);
    expect(model.tableGroups[0].rows.map((row) => row.patterns)).toEqual(["4", "1"]);
    expect(model.tableGroups[1]).toMatchObject({
      key: "no-patterns",
      heading: "Symbols with no patterns (2)",
      defaultSort: { key: "symbol", dir: "asc" },
    });
    expect(model.tableGroups[1].rows.map((row) => row.symbol)).toEqual(["BBBB", "CCCC"]);
  });

  it("P02: the PDF prints both headings and their rows in group order", async () => {
    const text = extractPdfText(await generateOpportunityHuntPdf(result()));
    const patternsHeading = text.indexOf("Symbols with patterns (2)");
    const quietHeading = text.indexOf("Symbols with no patterns (2)");
    expect(patternsHeading).toBeGreaterThan(-1);
    expect(quietHeading).toBeGreaterThan(patternsHeading);
    // The pattern chart above the tables also names ZZZZ; assert within each
    // table section, where order is the model's order.
    const patternsSection = text.slice(patternsHeading, quietHeading);
    expect(patternsSection).toContain("ZZZZ");
    expect(patternsSection).toContain("AAAA");
    expect(patternsSection.indexOf("ZZZZ")).toBeLessThan(patternsSection.indexOf("AAAA"));
    const quietSection = text.slice(quietHeading);
    expect(quietSection).toContain("BBBB");
    expect(quietSection).toContain("CCCC");
    expect(quietSection.indexOf("BBBB")).toBeLessThan(quietSection.indexOf("CCCC"));
  });

  it("P03: the shared table renderer colours the configured column only", () => {
    const drawn: Array<{ text: string; color: { red: number; green: number; blue: number } }> = [];
    const page = {
      drawText: (text: string, opts: { color: { red: number; green: number; blue: number } }) => {
        drawn.push({ text, color: opts.color });
      },
      drawLine: () => {},
    };
    const ctx = {
      doc: {} as PdfCtx["doc"],
      font: { widthOfTextAtSize: () => 5 } as PdfCtx["font"],
      bold: { widthOfTextAtSize: () => 5 } as PdfCtx["bold"],
      page: page as unknown as PdfCtx["page"],
      y: 500,
    } as PdfCtx;

    renderTable(
      ctx,
      "T",
      [
        { header: "Entries", w: 100 },
        { header: "Exits", w: 100 },
      ],
      [["sma_crossover", "mean_reversion"]],
      { columnColors: { 1: [0.85, 0.25, 0.25] } },
    );

    const entry = drawn.find((item) => item.text === "sma_crossover");
    const exit = drawn.find((item) => item.text === "mean_reversion");
    expect(entry?.color).toMatchObject({ red: 0.15, green: 0.15, blue: 0.15 });
    expect(exit?.color).toMatchObject({ red: 0.85, green: 0.25, blue: 0.25 });
  });
});
