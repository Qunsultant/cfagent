/** @vitest-environment jsdom */
/**
 * Issue #3074 (R8 remainder) — the catalog's Run action: a link to each
 * runnable family's EXISTING submission surface, absent where no verified
 * path exists.
 */
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkflowCatalogPanel } from "../src/client/WorkflowCatalogPanel";
import { WORKFLOW_CATALOG, assertWorkflowCatalog } from "../src/workflows/workflowCatalog";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<WorkflowCatalogPanel />);
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
});

function runLinks(): HTMLAnchorElement[] {
  return [...container.querySelectorAll("a")].filter(
    (a) => (a.textContent ?? "").trim() === "Run",
  );
}

describe("catalog Run action (#3074 R8)", () => {
  it("links each runnable workflow to its own submission surface", () => {
    const hrefs = runLinks().map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("?tab=stock-hub&view=new-screen");
    expect(hrefs).toContain("?tab=options-screener");
    // options and strategy both point at the options surface
    expect(hrefs.filter((href) => href === "?tab=options-screener").length).toBe(2);
  });

  it("offers no Run link for a workflow that is not runnable", () => {
    // trading-leg is the read-only one
    expect(runLinks()).toHaveLength(3);
    expect(container.textContent).toContain("No submission path yet");
  });

  it("the registry keeps runnable and runPath in lockstep", () => {
    expect(() => assertWorkflowCatalog()).not.toThrow();
    for (const workflow of WORKFLOW_CATALOG) {
      expect(Boolean(workflow.runPath)).toBe(workflow.runnable);
    }
  });

  it("refuses a runnable workflow with no runPath, and a runPath on a non-runnable one", () => {
    const stock = WORKFLOW_CATALOG.find((w) => w.id === "stock-screener")!;
    expect(() =>
      assertWorkflowCatalog([{ ...stock, runPath: null }]),
    ).toThrow(/names no runPath/i);
    expect(() =>
      assertWorkflowCatalog([{ ...stock, runnable: false }]),
    ).toThrow(/not runnable but declares a runPath/i);
  });
});
