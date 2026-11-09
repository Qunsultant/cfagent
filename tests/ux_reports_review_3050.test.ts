import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const HERE = join(__dirname, "..");
const REPORTS = "src/client/ReportsPanel.tsx";
const REVIEW = "src/client/ScreeningReviewPanel.tsx";
const HUB = "src/client/ETradeTradingHub.tsx";
const GATE = "tests/ux_conformance_gates_3047.test.ts";
const REGISTER = "tests/ux_shell_exceptions_3047.json";

function src(p: string): string {
  return readFileSync(join(HERE, p), "utf8");
}

describe("reports + review shell composition (#3050)", () => {
  it("ReportsPanel renders one PageShell with its two sections", () => {
    const panel = src(REPORTS);
    expect(panel).toContain("<PageShell");
    expect(panel).toContain('title="Reports"');
    expect(panel).toContain(
      '<PageSection title="Search and filter">',
    );
    expect(panel).toContain('<PageSection title="Reports">');
  });

  it("the reports-panel root class is gone from the component", () => {
    const panel = src(REPORTS);
    expect(panel).not.toContain("reports-panel");
    expect(panel).not.toContain("<h1");
  });

  it("ScreeningReviewPanel renders one PageShell with its four sections", () => {
    const panel = src(REVIEW);
    expect(panel).toContain("<PageShell");
    expect(panel).toContain('title="Proposal Review"');
    expect(panel).toContain('<PageSection title="Challengers">');
    expect(panel).toContain('<PageSection title="Goal proposals">');
    expect(panel).toContain(
      '<PageSection title="Strategy-bank re-selection proposals">',
    );
    expect(panel).toContain('<PageSection title="Strategy weights">');
  });

  it("the review panel's h3/h4 headings became shell and section titles", () => {
    const panel = src(REVIEW);
    expect(panel).not.toContain("<h3");
    expect(panel).not.toContain("<h4");
  });

  it("the hub reports and review branches still render the panels", () => {
    const hub = src(HUB);
    expect(hub).toContain('effectiveSubTab === "reports"');
    expect(hub).toContain("<ReportsPanel");
    expect(hub).toContain("<ScreeningReviewPanel");
  });

  it("the gate flipped reports and review from migration to conforming", () => {
    expect(src(GATE)).toContain(
      '"reports": "src/client/ReportsPanel.tsx"',
    );
    expect(src(GATE)).toContain(
      '"review": "src/client/ScreeningReviewPanel.tsx"',
    );
    const register = JSON.parse(src(REGISTER)) as {
      subTabs: Record<string, unknown>;
    };
    expect(register.subTabs["reports"]).toBeUndefined();
    expect(register.subTabs["review"]).toBeUndefined();
  });
});
