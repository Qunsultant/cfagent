// @vitest-environment jsdom
/**
 * Issue #6378 — view a stage's output on the OODA page, inline.
 *
 * Pins:
 *  - 6378-P01 the route keeps only the requested stage's `output`; the key is
 *    absent from the others (never `undefined`), and an empty/`1` request
 *    keeps every stage's output — the whole-read form;
 *  - 6378-P02 the viewer renders a record list as a table with the record's
 *    own headers, so real rows are visible without a download;
 *  - 6378-P03 a zero-row artifact says "0 rows recorded" — honest, not an
 *    empty panel;
 *  - 6378-P04 a stage whose step recorded a status verb names it above the
 *    artifact (`not_configured`), and invents no rows;
 *  - 6378-P05 a stage with no output artifact says exactly that;
 *  - 6378-P06 a nested artifact (a report's rows inside the output) renders
 *    its table under the artifact's own key.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StageOutputView } from "../src/client/options/ResearchRunsPanel";
import { withRequestedStageOutput } from "../src/agents/routes/screenerResearch";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function render(node: React.ReactNode) {
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  await flush();
  return container.textContent ?? "";
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  root = null;
});

describe("#6378 — the requested stage's output, on demand", () => {
  it("P01: only the requested stage keeps its output; the key is absent elsewhere", () => {
    const read = {
      engineRunId: "run-6378",
      stages: [
        { stageId: "feed", output: { quotes: 42 } },
        { stageId: "analyze", output: { ideas: [1, 2] } },
        { stageId: "generate", output: null },
      ],
    };
    const sliced = withRequestedStageOutput(read, "analyze");
    expect(sliced.stages.find((s) => s.stageId === "analyze")?.output).toEqual({ ideas: [1, 2] });
    expect(Object.prototype.hasOwnProperty.call(sliced.stages[0], "output")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sliced.stages[2], "output")).toBe(false);
    // The whole-read form is untouched: every stage keeps what it had.
    expect(withRequestedStageOutput(read, "")).toBe(read);
    expect(withRequestedStageOutput(read, "1")).toBe(read);
  });

  it("P02: a record list renders as a table with the record's own headers", async () => {
    const text = await render(
      <StageOutputView
        output={{
          quotes: [
            { symbol: "AAPL", last: 191.2 },
            { symbol: "MSFT", last: 402.5 },
          ],
        }}
      />,
    );
    expect(text).toContain("quotes");
    expect(text).toContain("symbol");
    expect(text).toContain("last");
    expect(text).toContain("AAPL");
    expect(text).toContain("402.5");
    expect(text).toContain("2 rows");
  });

  it("P03: a zero-row artifact says 0 rows recorded", async () => {
    const text = await render(<StageOutputView output={{ evaluations: [] }} />);
    expect(text).toContain("evaluations");
    expect(text).toContain("0 rows recorded");
  });

  it("P04: a coded status names itself above the artifact and invents no rows", async () => {
    const text = await render(<StageOutputView output={{ status: "not_configured" }} stepStatus="not_configured" />);
    expect(text).toContain("Stage output status");
    expect(text).toContain("not_configured");
    expect(text).not.toContain("rows recorded");
  });

  it("P05: a stage with no output artifact says exactly that", async () => {
    const text = await render(<StageOutputView output={null} stepStatus={null} />);
    expect(text).toContain("No output artifact was recorded for this stage");
  });

  it("P06: a nested artifact renders its own table under its key", async () => {
    const text = await render(
      <StageOutputView
        output={{ report: { ideas: [{ symbol: "NVDA", thesis: "capex cycle" }] } }}
      />,
    );
    expect(text).toContain("report");
    expect(text).toContain("NVDA");
    expect(text).toContain("capex cycle");
    expect(text).toContain("1 row");
  });
});
