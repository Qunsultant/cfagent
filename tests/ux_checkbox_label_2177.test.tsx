/** @vitest-environment jsdom */
import React from "react";
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Checkbox } from "../src/client/components/ui/Checkbox";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));

function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return container;
}

describe("Checkbox label prop (#2177)", () => {
  it("renders a wrapping label carrying the input and the text", () => {
    const container = render(<Checkbox label="Out of the money" defaultChecked={false} onChange={() => {}} />);
    const label = container.querySelector("label");
    expect(label).not.toBeNull();
    expect(label?.textContent).toContain("Out of the money");
    expect(label?.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it("clicking the label text toggles the checkbox (implicit association)", () => {
    const container = render(<Checkbox label="Toggle me" defaultChecked={false} onChange={() => {}} />);
    const label = container.querySelector("label") as HTMLLabelElement;
    const input = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(input.checked).toBe(false);
    act(() => {
      label.click();
    });
    expect(input.checked).toBe(true);
  });

  it("renders a bare input when no label is given (backward compatible)", () => {
    const container = render(<Checkbox checked={false} onChange={() => {}} />);
    expect(container.querySelector("label")).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it("accepts a node as label", () => {
    const container = render(
      <Checkbox label={<strong>All strategies (4)</strong>} checked={false} onChange={() => {}} />,
    );
    expect(container.querySelector("label strong")?.textContent).toContain("All strategies");
  });

  it("passes disabled through to the input", () => {
    const container = render(<Checkbox label="Disabled row" disabled checked={false} onChange={() => {}} />);
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
  });

  it("the 22 raw-label sites are gone", () => {
    const files = [
      "src/client/options/flows/FlowFiltersSidebar.tsx",
      "src/client/scheduledOptionsManager/NotificationFields.tsx",
      "src/client/options/StrategyDiscoveryPanel.tsx",
      "src/client/ScannerPanel.tsx",
      "src/client/options/OptionsResearchPanel.tsx",
      "src/client/PaymentWorkflowAssurance.tsx",
      "src/client/GoalScreenPanel.tsx",
      "src/client/options/ResearchRunsPanel.tsx",
      "src/client/ReportsPanel.tsx",
      "src/client/CheckoutPanel.tsx",
    ];
    for (const file of files) {
      const src = readFileSync(join(here, "..", file), "utf8");
      expect(src.split("<label").length - 1).toBe(0);
    }
  });
});
