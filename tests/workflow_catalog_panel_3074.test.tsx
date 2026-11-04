/** @vitest-environment jsdom */
/**
 * Issue #3074 (#3069 S4) — the catalog page renders what the registry
 * declares: every workflow, every stage, all four mode axes, the
 * approval gate, and a read-only notice where no runner exists.
 */
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkflowCatalogPanel } from "../src/client/WorkflowCatalogPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function render() {
  root = createRoot(container);
  await act(async () => {
    root.render(<WorkflowCatalogPanel />);
  });
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
});

describe("WorkflowCatalogPanel (#3074)", () => {
  it("lists every declared workflow", async () => {
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("stock-screener");
    expect(text).toContain("options-screener");
    expect(text).toContain("trading-leg");
  });

  it("shows the stock screener's six stages with all four mode axes", async () => {
    await render();
    const text = container.textContent ?? "";
    for (const label of [
      "Feed (quotes)",
      "Gather (enrichment)",
      "Analysis (screen)",
      "Store (canonical report)",
      "Serve (report availability)",
      "Deliver (channels)",
    ]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("Timing:");
    expect(text).toContain("Concurrency:");
    expect(text).toContain("Volume:");
    expect(text).toContain("Partitioning:");
    expect(text).toContain("sync / async");
  });

  it("names the producer to consumer chain for a stage", async () => {
    await render();
    expect(container.textContent).toContain("quotes -> enrichment -> enrich");
  });

  it("marks the approval-gated leg and the read-only workflows", async () => {
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Approval required");
    expect(text).toContain("Read-only");
    expect(text).toContain("No submission path yet");
  });

  it("offers no Run action while the submission path is unverified", async () => {
    await render();
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.some((b) => (b.textContent ?? "").trim() === "Run")).toBe(false);
  });

  it("states what the last-run column means", async () => {
    await render();
    expect(container.textContent).toContain("Last run column reads");
  });
});
