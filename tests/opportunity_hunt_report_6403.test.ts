/**
 * Issue 6403 — the Opportunity Hunt downloadable report (PDF).
 *
 * The PDF renders the SAME output the panel shows (issue 6406):
 * one row per symbol, pattern count, entry and exit signals grouped
 * per entry and per exit with their price ranges, and a price chart
 * carrying the recommendation levels. The grouping is the panel's
 * own helper, so the PDF cannot drift from the panel.
 */
import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { inflateSync } from "node:zlib";
import {
  generateOpportunityHuntPdf,
  opportunityHuntPdfFileName,
} from "../src/trading/opportunityHuntReportPdf";
import {
  generateReportPdf,
  getReportFileName,
} from "../src/services/unifiedReportPipeline";
import { opportunityHuntReportUrl } from "../src/services/screenerReportUrl";
import type { OpportunityHuntResult } from "../src/services/opportunityHunt";

function huntResult(overrides: Partial<OpportunityHuntResult> = {}): OpportunityHuntResult {
  return {
    scanned: 2,
    skipped: 0,
    setups: [
      {
        symbol: "AAA",
        strategy: "sma_crossover",
        direction: "entry",
        lastClose: 100,
        detail: "(Fast SMA 101.00 > Slow 99.00)",
        levels: { entryLow: 99.5, entryHigh: 100.5, stopLoss: 95, takeProfit: 110 },
      },
      {
        symbol: "AAA",
        strategy: "mean_reversion",
        direction: "exit",
        lastClose: 100,
        detail: "(close 3.0% above entry)",
        entryPrice: 97,
      },
      {
        symbol: "BBB",
        strategy: "breakout",
        direction: "entry",
        lastClose: 50,
        detail: "(close above 20-day high)",
        levels: { entryLow: 49.75, entryHigh: 50.25, stopLoss: 48.5, takeProfit: 51.5 },
      },
    ],
    summary:
      "Opportunity hunt: 3 setup(s) across 2 symbol(s), 2 entries, 1 exit — AAA:sma_crossover, AAA:mean_reversion, BBB:breakout",
    asOf: "2026-11-24T14:14:00.000Z",
    holdingsStatus: { available: true, broker: "alpaca" },
    seriesBySymbol: {
      AAA: [95, 96, 97, 98, 99, 100],
      BBB: [46, 47, 48, 49, 50, 50],
    },
    ...overrides,
  };
}

/**
 * Extract the drawn text from a pdf-lib PDF: inflate every stream
 * block (FlateDecode) and read the strings. pdf-lib draws WinAnsi
 * text as HEX strings (`<4F70...> Tj`) in the content stream, so
 * this decodes hex pairs to characters (and literal `(...)`
 * strings, for the uncompressed objects). A stream that fails to
 * inflate is read as-is; a stream that is not text is skipped by
 * the string matching (it yields no readable strings).
 */
function extractPdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const parts: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw)) !== null) {
    const chunk = Buffer.from(m[1], "latin1");
    let text: string;
    try {
      text = inflateSync(chunk).toString("latin1");
    } catch {
      text = chunk.toString("latin1");
    }
    parts.push(text);
  }
  const joined = parts.join("\n");
  const strings: string[] = [];
  // Hex strings: <4F7070...> — decode each byte pair.
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
  // Literal strings: (text) — unescape the PDF string escapes.
  const litRe = /\((?:\\.|[^\\()])*\)/g;
  let lm: RegExpExecArray | null;
  while ((lm = litRe.exec(joined)) !== null) {
    const inner = lm[0].slice(1, -1);
    strings.push(
      inner.replace(/\\([()\\])/g, "$1").replace(/\\n/g, "\n").replace(/\\r/g, "\r"),
    );
  }
  return strings.join(" ");
}

describe("opportunity hunt report PDF (issue 6403)", () => {
  it("produces a valid PDF, every page Letter landscape", async () => {
    const bytes = await generateOpportunityHuntPdf(huntResult());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]); // %PDF
    const doc = await PDFDocument.load(bytes);
    const pages = doc.getPages();
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const { width, height } = page.getSize();
      expect(width).toBe(792);
      expect(height).toBe(612);
    }
  });

  it("renders the same output the panel shows: one row per symbol, both entry and exit signals, price ranges", async () => {
    const bytes = await generateOpportunityHuntPdf(huntResult());
    const text = extractPdfText(bytes);
    // Title + summary.
    expect(text).toContain("Opportunity Hunt Report");
    expect(text).toContain("Opportunity hunt: 3 setup(s) across 2 symbol(s)");
    // One row per symbol (both symbols in the table).
    expect(text).toContain("AAA");
    expect(text).toContain("BBB");
    // Entry and exit signals, grouped per entry and per exit.
    expect(text).toContain("Entry recommendations");
    expect(text).toContain("Exit recommendations");
    // Price ranges: entry range, stop-loss, take-profit, and the
    // exit's cost basis / gain.
    expect(text).toContain("$99.50");
    expect(text).toContain("$100.50");
    expect(text).toContain("$95.00");
    expect(text).toContain("$110.00");
    expect(text).toContain("$97.00");
    // Strategy breakdown chart + pattern-count chart titles.
    expect(text).toContain("Setups by strategy");
    expect(text).toContain("Pattern count by symbol");
  });

  it("renders a completed hunt with no setups (empty table, not an error)", async () => {
    const bytes = await generateOpportunityHuntPdf(
      huntResult({ setups: [], summary: "Opportunity hunt: 0 setup(s) across 2 symbol(s) — none" }),
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPages().length).toBeGreaterThan(0);
    const text = extractPdfText(bytes);
    expect(text).toContain("No setups");
    expect(text).toContain("Opportunity Hunt Report");
  });

  it("states the holdings reason when exits are unavailable (never a silent drop)", async () => {
    const bytes = await generateOpportunityHuntPdf(
      huntResult({
        holdingsStatus: {
          available: false,
          reason: "provider_unsupported: public does not expose positions",
          broker: "public",
        },
      }),
    );
    const text = extractPdfText(bytes);
    expect(text).toContain("Exit signals unavailable");
    expect(text).toContain("provider_unsupported");
  });

  it("grows with the symbol count (table + per-symbol detail)", async () => {
    const one = await generateOpportunityHuntPdf(
      huntResult({
        setups: [
          {
            symbol: "AAA",
            strategy: "sma_crossover",
            direction: "entry",
            lastClose: 100,
            detail: "(Fast SMA 101.00 > Slow 99.00)",
            levels: { entryLow: 99.5, entryHigh: 100.5, stopLoss: 95, takeProfit: 110 },
          },
        ],
        summary: "Opportunity hunt: 1 setup(s) across 1 symbol(s), 1 entry, 0 exits — AAA:sma_crossover",
        seriesBySymbol: { AAA: [95, 96, 97, 98, 99, 100] },
      }),
    );
    const many = await generateOpportunityHuntPdf(huntResult());
    const onePages = (await PDFDocument.load(one)).getPages().length;
    const manyPages = (await PDFDocument.load(many)).getPages().length;
    expect(manyPages).toBeGreaterThanOrEqual(onePages);
    expect(manyPages).toBeGreaterThan(1);
  });

  it("follows the #297 filename convention", () => {
    expect(opportunityHuntPdfFileName(huntResult())).toBe(
      "opportunity-hunt_2026-11-24T14-14-00Z.pdf",
    );
  });

  it("routes through the ONE dispatch (pipeline type opportunity-hunt)", async () => {
    const bytes = await generateReportPdf("opportunity-hunt", huntResult());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(await getReportFileName("opportunity-hunt", huntResult())).toBe(
      "opportunity-hunt_2026-11-24T14-14-00Z.pdf",
    );
  });

  it("builds the download URL on the hunt report.pdf route", () => {
    expect(
      opportunityHuntReportUrl("https://agent.openaimp.com", "report:pdf:opportunity-hunt:abcd1234"),
    ).toBe(
      "https://agent.openaimp.com/api/opportunity-hunt/report.pdf?key=report%3Apdf%3Aopportunity-hunt%3Aabcd1234",
    );
    expect(opportunityHuntReportUrl(undefined, "report:pdf:opportunity-hunt:abcd1234")).toBe(
      "https://agent.openaimp.com/api/opportunity-hunt/report.pdf?key=report%3Apdf%3Aopportunity-hunt%3Aabcd1234",
    );
  });
});
