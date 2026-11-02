/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  confidenceMethodRows,
  type ConfidenceMethodInput,
} from "../src/client/options/confidenceMethod";
import { ConfidenceMethodBreakdown } from "../src/client/options/ConfidenceMethodBreakdown";

/**
 * HAX #9 uncertainty (Qunsultant/cfagent#1773, item 5): a best-trade
 * HIGH/MEDIUM/LOW rating must travel with its method breakdown, not
 * as a single unexplained number. The method is the RecommendationAgent
 * rule (src/trading/options/recommendationAgent.ts pickBestTrade):
 * LOW when quote data is not FRESH or any blocker exists; otherwise
 * HIGH when the composite margin over the runner-up is >= 5, liquidity
 * >= 60, and model-implied POP >= 35%; otherwise MEDIUM. The no-view
 * picker (pickBestNoViewTrade) caps at MEDIUM by construction — HIGH
 * is unreachable without a user view. These tests pin the breakdown
 * against that rule, including its edge cases, so the UI can never
 * display a rating whose stated method contradicts the rating.
 */

function viewed(over: Partial<ConfidenceMethodInput>): ConfidenceMethodInput {
  return {
    confidence: "MEDIUM",
    best: {
      candidate: { dataFreshness: "FRESH", liquidityScore: 80, modelImpliedProbabilityOfProfit: 0.5 },
      compositeScore: 80,
    },
    alternatives: [{ compositeScore: 70 }],
    blockers: [],
    ...over,
  };
}

describe("confidenceMethodRows (#1773, HAX uncertainty)", () => {
  it("explains HIGH as margin + liquidity + POP all met with fresh data and no blockers", () => {
    const rows = confidenceMethodRows(viewed({ confidence: "HIGH" }));
    const text = rows.map((r) => `${r.label} ${r.value}`).join(" ");
    expect(text).toContain("FRESH");
    expect(text).toContain("10.0");
    expect(text).toContain("80");
    expect(text).toContain("50.0%");
    expect(rows.every((r) => r.verdict !== "fail")).toBe(true);
  });

  it("explains LOW from stale data even when the other gates pass", () => {
    const rows = confidenceMethodRows(
      viewed({
        confidence: "LOW",
        best: {
          candidate: { dataFreshness: "STALE", liquidityScore: 80, modelImpliedProbabilityOfProfit: 0.5 },
          compositeScore: 80,
        },
      }),
    );
    expect(rows.find((r) => r.label.includes("freshness"))?.verdict).toBe("fail");
  });

  it("explains LOW from blockers even with fresh data", () => {
    const rows = confidenceMethodRows(viewed({ confidence: "LOW", blockers: ["No positive maximum profit after fees."] }));
    expect(rows.find((r) => r.label.includes("Blockers"))?.verdict).toBe("fail");
    expect(rows.map((r) => r.value).join(" ")).toContain("No positive maximum profit after fees.");
  });

  it("explains MEDIUM when a HIGH gate fails with fresh data and no blockers", () => {
    const rows = confidenceMethodRows(
      viewed({
        best: {
          candidate: { dataFreshness: "FRESH", liquidityScore: 40, modelImpliedProbabilityOfProfit: 0.5 },
          compositeScore: 80,
        },
      }),
    );
    expect(rows.find((r) => r.label.includes("Liquidity"))?.verdict).toBe("fail");
  });

  it("uses the best composite as the margin when there is no runner-up", () => {
    const rows = confidenceMethodRows(viewed({ alternatives: [] }));
    expect(rows.map((r) => `${r.label} ${r.value}`).join(" ")).toContain("80.0");
  });

  it("caps the no-view pick at MEDIUM and says HIGH is unreachable", () => {
    const rows = confidenceMethodRows(viewed({ capHigh: true }));
    expect(rows.map((r) => `${r.label} ${r.value}`).join(" ")).toMatch(/HIGH.*unreachable|unreachable.*HIGH/i);
    expect(rows.find((r) => r.label.includes("HIGH"))?.verdict).not.toBe("pass");
  });

  it("handles a no-trade pick (no best candidate) without inventing inputs", () => {
    const rows = confidenceMethodRows({ confidence: "LOW", best: undefined, alternatives: [], blockers: ["No qualifying candidates"] });
    expect(rows.map((r) => r.value).join(" ")).toContain("No qualifying candidates");
    expect(rows.map((r) => r.value).join(" ")).not.toContain("NaN");
    expect(rows.map((r) => r.value).join(" ")).not.toContain("undefined");
  });

  it("never contradicts the displayed rating: recomputed rating equals the input rating", () => {
    const cases: ConfidenceMethodInput[] = [
      viewed({ confidence: "HIGH" }),
      viewed({ confidence: "MEDIUM" }),
      viewed({ confidence: "LOW", blockers: ["x"] }),
      viewed({ confidence: "MEDIUM", capHigh: true }),
      viewed({
        confidence: "LOW",
        best: {
          candidate: { dataFreshness: "UNKNOWN", liquidityScore: 90, modelImpliedProbabilityOfProfit: 0.9 },
          compositeScore: 95,
        },
        alternatives: [{ compositeScore: 10 }],
      }),
    ];
    for (const input of cases) {
      const rows = confidenceMethodRows(input);
      const verdictRow = rows.find((r) => r.label.includes("Rating"));
      expect(verdictRow?.value).toContain(input.confidence);
    }
  });
});

describe("ConfidenceMethodBreakdown render (#1773)", () => {
  it("renders the method rows for a HIGH pick", () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(<ConfidenceMethodBreakdown pick={viewed({ confidence: "HIGH" })} />);
    });
    try {
      const text = container.textContent ?? "";
      expect(text).toMatch(/how this confidence/i);
      expect(text).toContain("FRESH");
      expect(text).toContain("HIGH");
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
      document.body.innerHTML = "";
    }
  });
});
