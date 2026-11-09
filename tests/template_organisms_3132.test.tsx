/** @vitest-environment jsdom */
/**
 * Template organisms I (#3132, Part of #2150): ContextStrip, KpiRibbon,
 * SummaryCard — the three organisms the beautiful pages hand-roll today
 * (order quote peek, autopilot executive ribbon, order calc card),
 * rebuilt as primitives with token-only styling.
 *
 * Each organism reproduces its hand-rolled original's structure and
 * tone (verified against OrderTicketPanel.tsx:557/:783 and
 * AutopilotControlCenter.tsx:775): same children in the same order,
 * same sunken surface, same emphasized total. Two deliberate deltas,
 * both required by design-system §1.6b: no outer margin on any
 * organism (slot spacing is the template's Stack gap), and the
 * KpiRibbon grid is the shared .ui-stat-grid instead of the ribbon's
 * fixed 4-column grid. No page migrates in this slice (Wave 1,
 * #3138–#3140), so nothing visual changes anywhere.
 *
 * Rendered through React, same harness as page_template_3131.test.tsx.
 */
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextStrip } from "../src/client/components/ui/ContextStrip";
import { KpiRibbon } from "../src/client/components/ui/KpiRibbon";
import { SummaryCard } from "../src/client/components/ui/SummaryCard";
import { PageTemplate } from "../src/client/components/ui/PageTemplate";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(node);
  });
}

afterEach(() => {
  if (root) root.unmount();
  root = undefined as any;
  container?.remove();
});

describe("ContextStrip (#3132 — order quote peek, OrderTicketPanel.tsx:557)", () => {
  it("renders company, price, change, bid/ask, status pill, and source badge", () => {
    render(
      <ContextStrip
        company="Apple Inc."
        price="$338.32"
        change="+1.23 (0.36%)"
        changeTone="positive"
        bidAsk="Bid: $338.30 / Ask: $338.35"
        status="REALTIME"
        source="E*TRADE"
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Apple Inc.");
    expect(text).toContain("$338.32");
    expect(text).toContain("+1.23 (0.36%)");
    expect(text).toContain("Bid: $338.30 / Ask: $338.35");
    expect(text).toContain("REALTIME");
    expect(text).toContain("E*TRADE");
    expect(document.querySelector(".ui-context-strip")).not.toBeNull();
    // Price is the emphasized element, in the accent tone.
    expect(document.querySelector(".ui-context-strip strong")?.textContent).toBe("$338.32");
  });

  it("positive change reads success, negative reads danger, missing change reads an em dash", () => {
    render(
      <ContextStrip company="A" price="$1" change="+0.10 (1.00%)" changeTone="positive" />,
    );
    expect(document.querySelector(".ui-context-strip .ui-success")?.textContent).toContain("+0.10");
    act(() => { root.unmount(); });
    container.remove();
    render(
      <ContextStrip company="A" price="$1" change="-0.10 (1.00%)" changeTone="negative" />,
    );
    expect(document.querySelector(".ui-context-strip .ui-danger")?.textContent).toContain("-0.10");
    act(() => { root.unmount(); });
    container.remove();
    render(<ContextStrip company="A" price="$1" />);
    expect(document.querySelector(".ui-context-strip")?.textContent).toContain("—");
  });

  it("renders nothing when there is no company to show (slot rule, §1.6b)", () => {
    render(<ContextStrip company="" price="$1" />);
    expect(document.querySelector(".ui-context-strip")).toBeNull();
    expect(document.body.textContent).toBe("");
  });
});

describe("KpiRibbon (#3132 — autopilot executive ribbon, AutopilotControlCenter.tsx:775)", () => {
  const items = [
    { label: "Portfolio NAV", value: "$10,241,882", sub: "↑ +1.2% today", subTone: "success" as const },
    { label: "Drawdown vs Alert", value: "-2.40%", sub: "Policy Alert: 5.00% Max" },
    { label: "Cash Reserve Target", value: "12.00%", sub: "✓ Protected Capital Floor", subTone: "success" as const },
  ];

  it("renders one card per item, each label/value/sub-trend", () => {
    render(<KpiRibbon items={items} />);
    expect(document.querySelector(".ui-stat-grid")).not.toBeNull();
    expect(document.querySelectorAll(".ui-stat-grid .ui-card")).toHaveLength(3);
    const text = document.body.textContent ?? "";
    for (const item of items) {
      expect(text).toContain(item.label);
      expect(text).toContain(item.value);
      expect(text).toContain(item.sub);
    }
  });

  it("sub-trend tones read through the token utilities", () => {
    render(<KpiRibbon items={items} />);
    expect(document.querySelectorAll(".ui-stat-grid .ui-success")).toHaveLength(2);
  });

  it("renders nothing when there are no items (slot rule, §1.6b)", () => {
    render(<KpiRibbon items={[]} />);
    expect(document.querySelector(".ui-stat-grid")).toBeNull();
    expect(document.body.textContent).toBe("");
  });
});

describe("SummaryCard (#3132 — order calc card, OrderTicketPanel.tsx:783)", () => {
  const rows = [
    { label: "Estimated Price per Share:", value: "$338.32" },
    { label: "Online Commission:", value: "$0.00 USD" },
  ];

  it("renders label/value rows with the total emphasized", () => {
    render(
      <SummaryCard rows={rows} total={{ label: "Estimated Total Order Value:", value: "$3,383.20" }} />,
    );
    expect(document.querySelector(".ui-summary-card")).not.toBeNull();
    const text = document.body.textContent ?? "";
    for (const row of rows) {
      expect(text).toContain(row.label);
      expect(text).toContain(row.value);
    }
    expect(text).toContain("Estimated Total Order Value:");
    expect(text).toContain("$3,383.20");
    const total = document.querySelector(".ui-summary-total");
    expect(total).not.toBeNull();
    expect(total?.textContent).toContain("$3,383.20");
    expect(total?.querySelector("strong")?.textContent).toBe("$3,383.20");
  });

  it("renders rows without a total, and a total without rows", () => {
    render(<SummaryCard rows={rows} />);
    expect(document.querySelector(".ui-summary-card")).not.toBeNull();
    expect(document.querySelector(".ui-summary-total")).toBeNull();
    act(() => { root.unmount(); });
    container.remove();
    render(<SummaryCard rows={[]} total={{ label: "Total:", value: "$0.00" }} />);
    expect(document.querySelector(".ui-summary-card")).not.toBeNull();
    expect(document.querySelector(".ui-summary-total")).not.toBeNull();
  });

  it("renders nothing when there are no rows and no total (slot rule, §1.6b)", () => {
    render(<SummaryCard rows={[]} />);
    expect(document.querySelector(".ui-summary-card")).toBeNull();
    expect(document.body.textContent).toBe("");
  });
});

describe("organisms drop into PageTemplate slots in canonical order", () => {
  it("context strip, KPI ribbon, then workspace — no movement, no new chrome", () => {
    render(
      <PageTemplate
        title="T"
        contextStrip={<ContextStrip company="A" price="$1" />}
        kpiRibbon={<KpiRibbon items={[{ label: "NAV", value: "$1" }]} />}
      >
        <div>workspace</div>
      </PageTemplate>,
    );
    const text = document.body.textContent ?? "";
    const strip = text.indexOf("$1");
    const ribbon = text.indexOf("NAV");
    const workspace = text.indexOf("workspace");
    expect(strip).toBeGreaterThan(-1);
    expect(ribbon).toBeGreaterThan(strip);
    expect(workspace).toBeGreaterThan(ribbon);
  });
});
