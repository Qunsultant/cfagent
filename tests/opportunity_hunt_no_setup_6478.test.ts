// @vitest-environment node
/**
 * Issue 6478 — the hunt retains every symbol it evaluated, including the ones
 * that produced no setup, so the report can show what was evaluated and found
 * uninteresting (issue #6473 item 4).
 *
 * Pins:
 * - 6478-P01 the run keeps a capped trailing series for every scanned symbol,
 *   and none for a symbol skipped for short history;
 * - 6478-P02 grouping returns a row for every evaluated symbol: a no-setup row
 *   carries patternCount 0, its series, and its last close, with no entries
 *   or exits (the shape both renderers draw from);
 * - 6478-P03 the PDF lists the evaluated population apart from the setup
 *   population and gives every no-setup symbol a detail section that says so
 *   (its chart is drawn from the row's series, pinned in P02);
 * - 6478-P04 a run with zero setups still lists and details every evaluated
 *   symbol rather than collapsing to a single "No setups" line.
 */
import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { runOpportunityHunt, type OpportunityHuntResult } from "../src/services/opportunityHunt";
import { groupHuntSetupsBySymbol } from "../src/client/opportunityHuntView";
import { OPPORTUNITY_HUNT_CHART_BARS } from "../src/config/opportunityHuntLevels";
import { generateOpportunityHuntPdf } from "../src/trading/opportunityHuntReportPdf";

const asMap = (entries: Record<string, number[]>) => new Map(Object.entries(entries));

/** 16 flat bars then 5 higher: the fast SMA overtakes the slow one (an entry). */
const RISING = [...Array(16).fill(100), ...Array(5).fill(120)];
/** A flat series: no strategy fires, and the symbol must still be reported. */
const FLAT = Array(20).fill(50);

function result(): OpportunityHuntResult {
  return runOpportunityHunt({
    closesBySymbol: asMap({
      AAAA: RISING,
      BBBB: FLAT,
      CCCC: [1, 2, 3], // below the five-bar floor → skipped, not evaluated
    }),
    now: () => new Date("2026-11-24T21:58:00.000Z"),
  });
}

/**
 * Extract the drawn text from a pdf-lib PDF (same reader as the report suite):
 * inflate FlateDecode streams and decode hex/literal strings.
 */
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

describe("hunt evaluated symbols (issue 6478)", () => {
  it("P01: retains a capped series for every scanned symbol, none for a skipped one", () => {
    const run = result();
    expect(run.scanned).toBe(2);
    expect(run.skipped).toBe(1);
    expect(Object.keys(run.seriesBySymbol).sort()).toEqual(["AAAA", "BBBB"]);
    expect(run.seriesBySymbol.BBBB).toEqual(FLAT);
    expect(run.seriesBySymbol.CCCC).toBeUndefined();
    // The cap still applies to a long evaluated series.
    const long = runOpportunityHunt({
      closesBySymbol: asMap({ LONG: Array.from({ length: 120 }, (_, i) => i + 1) }),
    });
    expect(long.seriesBySymbol.LONG).toHaveLength(OPPORTUNITY_HUNT_CHART_BARS);
  });

  it("P02: a no-setup evaluated symbol is a zero-pattern row with its closes", () => {
    const rows = groupHuntSetupsBySymbol(result());
    expect(rows.map((row) => row.symbol)).toEqual(["AAAA", "BBBB"]);
    const bbbb = rows[1];
    expect(bbbb.patternCount).toBe(0);
    expect(bbbb.entries).toEqual([]);
    expect(bbbb.exits).toEqual([]);
    expect(bbbb.lastClose).toBe(50);
    expect(bbbb.closes).toEqual(FLAT);
    expect(bbbb.entryLow).toBeNull();
    expect(bbbb.stopLoss).toBeNull();
    expect(bbbb.exitPrice).toBeNull();
    // A setup symbol still carries its own series and roll-ups.
    expect(rows[0].closes).toEqual(RISING);
    expect(rows[0].patternCount).toBeGreaterThan(0);
  });

  it("P03: the PDF separates evaluated from with-setups and details the no-setup symbol", async () => {
    const text = extractPdfText(await generateOpportunityHuntPdf(result()));
    expect(text).toContain("Symbols evaluated: 2");
    expect(text).toContain("Symbols with setups: 1");
    expect(text).toContain("Symbols evaluated (2)");
    expect(text).toContain("BBBB - no setup");
    expect(text).toContain("No setup - this symbol was evaluated and no strategy produced an entry or exit signal.");
    // The setup symbol's detail is unchanged.
    expect(text).toContain("AAAA - recommendations");
  });

  it("P04: a zero-setup run still lists every evaluated symbol", async () => {
    const flatOnly = runOpportunityHunt({
      closesBySymbol: asMap({ BBBB: FLAT, DDDD: Array(20).fill(75) }),
      now: () => new Date("2026-11-24T21:58:00.000Z"),
    });
    expect(flatOnly.setups).toEqual([]);
    expect(groupHuntSetupsBySymbol(flatOnly).map((row) => row.symbol)).toEqual(["BBBB", "DDDD"]);
    const text = extractPdfText(await generateOpportunityHuntPdf(flatOnly));
    expect(text).toContain("No setups");
    expect(text).toContain("BBBB - no setup");
    expect(text).toContain("DDDD - no setup");
    expect(text).toContain("Symbols evaluated (2)");
  });
});
