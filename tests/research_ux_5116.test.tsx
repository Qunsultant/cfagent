import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDefaultLeftNavConfig } from "../src/client/navConfig";
import { OodaResearchPage } from "../src/client/OodaResearchPage";

describe("Issue #5116 (Sub-issue 7 of #5109) — Research UX-URL", () => {
  it("splices the ooda sub-menu next to goal-screen in Intelligence", () => {
    const config = buildDefaultLeftNavConfig();
    const intel = config.sections.find((s) => s.id === "section-intelligence");
    expect(intel).toBeDefined();
    const ids = intel!.items.map((i) => i.id);
    const goalIdx = ids.indexOf("goal-screen");
    const oodaIdx = ids.indexOf("ooda");
    expect(goalIdx).toBeGreaterThanOrEqual(0);
    expect(oodaIdx).toBe(goalIdx + 1);
    const oodaItem = intel!.items[oodaIdx];
    expect(oodaItem).toMatchObject({
      id: "ooda",
      label: "OODA",
      shortLabel: "OODA",
      badge: "OODA",
      badgeType: "ai",
    });
  });

  it("renders OodaResearchPage using UI primitives and ResearchRunsPanel", () => {
    const html = renderToStaticMarkup(<OodaResearchPage userLogin="trader@example.com" />);
    expect(html).toContain("OODA Nightly Research");
    expect(html).toContain("21:00");
  });
});
