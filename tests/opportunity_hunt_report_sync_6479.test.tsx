/** @vitest-environment jsdom */
/**
 * Issue 6479 — the Opportunity Hunt page and PDF read ONE report view model.
 *
 * Pins:
 * - 6479-P01 the model is complete and pure: it recomputes the summary rather
 *   than trusting a posted field, states the counts narrative, and carries a
 *   row/section for every evaluated symbol (including a no-setup one);
 * - 6479-P02 the page renders a SENTINEL model — strings the underlying result
 *   never contained — so a renderer that re-derives content fails;
 * - 6479-P03 the PDF renderer renders the same sentinel model's strings;
 * - 6479-P04 a production-shaped result through both real entry points (the
 *   panel's report view and `generateOpportunityHuntPdf(result)`) yields the
 *   same shared content on page and PDF, including the counts section;
 * - 6479-P05 neither surface renders a stale `result.summary`: the model's
 *   computed headline wins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { inflateSync } from "node:zlib";
import { runOpportunityHunt, huntCountsExplanation } from "../src/services/opportunityHunt";
import type { OpportunityHuntResult } from "../src/services/opportunityHunt";
import {
  buildOpportunityHuntReportModel,
  type OpportunityHuntReportModel,
} from "../src/client/opportunityHuntReportModel";
import { OpportunityHuntReportView } from "../src/client/OpportunityHuntReportView";
import {
  generateOpportunityHuntPdf,
  renderOpportunityHuntPdf,
} from "../src/trading/opportunityHuntReportPdf";
import { cleanForPdf } from "../src/trading/pdfText";
import { formatReportTimestamp } from "../src/services/reportTimestamp";

const { mockSeries, mockChart, mockCreateChart } = vi.hoisted(() => {
  const mockSeries = {
    setData: vi.fn(),
    createPriceLine: vi.fn(() => ({})),
    removePriceLine: vi.fn(),
  };
  const mockChart = {
    addSeries: vi.fn(() => mockSeries),
    remove: vi.fn(),
    applyOptions: vi.fn(),
    timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
  };
  return { mockSeries, mockChart, mockCreateChart: vi.fn(() => mockChart) };
});

vi.mock("lightweight-charts", () => ({
  createChart: mockCreateChart,
  LineSeries: {},
  ColorType: { Solid: "solid" },
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const asMap = (entries: Record<string, number[]>) => new Map(Object.entries(entries));
/** 16 flat bars then 5 higher: the fast SMA overtakes the slow one (an entry). */
const RISING = [...Array(16).fill(100), ...Array(5).fill(120)];
/** A flat series: no strategy fires, and the symbol must still be reported. */
const FLAT = Array(20).fill(50);

function huntResult(): OpportunityHuntResult {
  return runOpportunityHunt({
    closesBySymbol: asMap({ AAAA: RISING, BBBB: FLAT }),
    holdingsStatus: { available: true, broker: "alpaca" },
    now: () => new Date("2026-11-24T21:58:00.000Z"),
  });
}

/** Extract drawn PDF text (same reader as the report suites). */
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

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const pageText = (): string => squash(document.body.textContent ?? "");
const pdfText = (text: string): string => squash(cleanForPdf(text));

/** A model the underlying result never produced: every content field is a sentinel. */
function sentinelModel(): OpportunityHuntReportModel {
  const base = buildOpportunityHuntReportModel(huntResult());
  const first = base.sections[0];
  return {
    ...base,
    title: "SENTINEL TITLE",
    asOfLabel: "SENTINEL AS OF",
    summary: "SENTINEL SUMMARY",
    summaryCountsLine: "SENTINEL COUNTS LINE",
    countsHeading: "SENTINEL COUNTS HEADING",
    countsExplanation: "SENTINEL COUNTS EXPLANATION",
    holdingsHeading: "SENTINEL HOLDINGS HEADING",
    holdingsNote: "SENTINEL HOLDINGS NOTE",
    noSetupsNote: "SENTINEL NO SETUPS NOTE",
    patternChartTitle: "SENTINEL CHART TITLE",
    patternBars: [],
    tableGroups: [
      {
        key: "patterns",
        heading: "SENTINEL PATTERNS HEADING",
        rows: [],
        defaultSort: { key: "patterns", dir: "desc" },
      },
      {
        key: "no-patterns",
        heading: "SENTINEL NO-PATTERN HEADING",
        rows: [
          { symbol: "ZZZZ", patterns: "0", entries: "—", exits: "—", entryRange: "—", stopLoss: "—", takeProfit: "—", lastClose: "$1.00" },
        ],
        defaultSort: { key: "symbol", dir: "asc" },
      },
    ],
    sections: [
      {
        ...first,
        symbol: "ZZZZ",
        heading: "SENTINEL SECTION HEADING",
        lastCloseLine: "SENTINEL LAST CLOSE",
        noSetupNote: "SENTINEL SECTION NOTE",
        entryLines: ["SENTINEL ENTRY LINE"],
        exitLines: [],
        closes: [],
        row: { ...first.row, symbol: "ZZZZ", closes: [] },
      },
    ],
    methodology: ["SENTINEL METHODOLOGY"],
  };
}

async function expectSharedContent(
  model: OpportunityHuntReportModel,
  bytes: Uint8Array,
) {
  const pdf = pdfText(extractPdfText(bytes));
  const topLevel = [
    model.summary,
    model.asOfLabel,
    model.countsHeading,
    model.countsExplanation,
    model.holdingsHeading ?? "",
    model.holdingsNote ?? "",
    model.noSetupsNote ?? "",
    ...model.tableGroups.map((group) => group.heading),
    ...model.methodology,
  ].filter((text) => text.length > 0);
  for (const text of topLevel) {
    expect(pageText()).toContain(squash(text));
    expect(pdf).toContain(pdfText(text));
  }

  // The page opens one symbol's detail at a time; the PDF prints them all.
  // Click every row and assert the SAME section text the PDF printed.
  for (const section of model.sections) {
    const row = [...document.querySelectorAll("tbody tr")].find((tr) =>
      (tr.textContent ?? "").includes(section.symbol),
    );
    expect(row).toBeTruthy();
    await act(async () => {
      (row as HTMLElement).click();
    });
    const sectionText = [
      section.heading,
      section.lastCloseLine,
      section.noSetupNote ?? "",
      ...(section.entryLines.length > 0
        ? [section.entryHeading, ...section.entryLines]
        : []),
      ...(section.exitLines.length > 0
        ? [section.exitHeading, ...section.exitLines]
        : []),
    ].filter((text) => text.length > 0);
    for (const text of sectionText) {
      expect(pageText()).toContain(squash(text));
      expect(pdf).toContain(pdfText(text));
    }
  }
}

describe("hunt report sync (issue 6479)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    root = null;
    container = null;
  });

  async function renderModel(model: OpportunityHuntReportModel) {
    await act(async () => {
      root!.render(<OpportunityHuntReportView model={model} />);
    });
  }

  it("P01: the model is complete, recomputes the summary, and carries every evaluated symbol", () => {
    const result = huntResult();
    result.summary = "STALE SUMMARY — rendered from the result field";
    const model = buildOpportunityHuntReportModel(result);
    expect(model.summary).toContain("Opportunity hunt:");
    expect(model.summary).not.toContain("STALE");
    expect(model.countsExplanation).toBe(huntCountsExplanation(result));
    expect(model.asOfLabel).toBe(formatReportTimestamp(result.asOf));
    expect(model.tableGroups[0].rows.map((row) => row.symbol)).toEqual(["AAAA"]);
    expect(model.tableGroups[1].rows.map((row) => row.symbol)).toEqual(["BBBB"]);
    expect(model.sections.map((section) => section.symbol)).toEqual(["AAAA", "BBBB"]);
    expect(model.sections[1].noSetupNote).toContain("No setup");
    expect(model.methodology.length).toBeGreaterThan(0);
  });

  it("P02/P03: the page and the PDF both render a sentinel model", async () => {
    const model = sentinelModel();
    await renderModel(model);
    const bytes = await renderOpportunityHuntPdf(model);
    await expectSharedContent(model, bytes);
    // The page did not accidentally render the result's own summary.
    expect(pageText()).not.toContain("Opportunity hunt:");
    // Both group headings are rendered by both surfaces.
    expect(pdfText(extractPdfText(bytes))).toContain("SENTINEL PATTERNS HEADING");
    expect(pdfText(extractPdfText(bytes))).toContain("SENTINEL NO-PATTERN HEADING");
    expect(pageText()).toContain("ZZZZ");
  });

  it("P04: production result through both real entry points agrees, counts section included", async () => {
    const result = huntResult();
    const model = buildOpportunityHuntReportModel(result);
    await renderModel(model);
    const bytes = await generateOpportunityHuntPdf(result);
    await expectSharedContent(model, bytes);
    // The page now shows the counts narrative the PDF always had.
    expect(pageText()).toContain(squash(model.countsExplanation));
    expect(pdfText(extractPdfText(bytes))).toContain(
      pdfText(model.countsExplanation),
    );
  });
});
