import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const HERE = join(__dirname, "..");
const PANEL = "src/client/components/AutopilotControlCenter.tsx";
const HUB = "src/client/ETradeTradingHub.tsx";
const GATE = "tests/ux_conformance_gates_3047.test.ts";
const REGISTER = "tests/ux_shell_exceptions_3047.json";

function src(p: string): string {
  return readFileSync(join(HERE, p), "utf8");
}

describe("autopilot shell composition (#3050)", () => {
  it("AutopilotControlCenter renders one PageTemplate with the six sections and the kpiRibbon slot", () => {
    const panel = src(PANEL);
    expect(panel).toContain('<PageTemplate');
    expect(panel).toContain('title="Autopilot control center"');
    expect(panel).toContain("kpiRibbon=");
    expect(panel).toContain("<KpiRibbon");
    expect(panel).toContain(
      '<PageSection title="Strategy Equity vs S&P 500 Benchmark"',
    );
    expect(panel).toContain('<PageSection title="Autopilot Status">');
    // #4409: the limits title lives in its DetailCard, not the
    // PageSection, so "Edit limits" sits in the same CardHeader row.
    expect(panel).toContain('title="Live policy limits"');
    expect(panel).toContain('<PageSection title="Job outcomes">');
    expect(panel).toContain(
      '<PageSection title="Recent autonomous actions">',
    );
    expect(panel).toContain('<PageSection title="Policy decisions">');
  });

  it("the bespoke chrome classes are gone from the component", () => {
    const panel = src(PANEL);
    for (const cls of [
      "autopilot-title",
      "executive-kpi-",
      "policy-limit-",
      "form-field",
      "card-section-title",
    ]) {
      expect(panel).not.toContain(cls);
    }
    expect(panel).not.toContain("<h1");
  });

  it("the hub autopilot branch still renders the control center", () => {
    const hub = src(HUB);
    expect(hub).toContain('effectiveSubTab === "autopilot"');
    expect(hub).toContain("<AutopilotControlCenter");
  });

  it("the gate flipped autopilot from migration to conforming", () => {
    expect(src(GATE)).toContain(
      '"autopilot": "src/client/components/AutopilotControlCenter.tsx"',
    );
    const register = JSON.parse(src(REGISTER)) as {
      subTabs: Record<string, unknown>;
    };
    expect(register.subTabs["autopilot"]).toBeUndefined();
  });
});
