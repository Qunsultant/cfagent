import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const HERE = join(__dirname, "..");
const HUB = "src/client/ETradeTradingHub.tsx";
const PANEL = "src/client/TrackRecordPanel.tsx";
const GATE = "tests/ux_conformance_gates_3047.test.ts";
const REGISTER = "tests/ux_shell_exceptions_3047.json";

function src(p: string): string {
  return readFileSync(join(HERE, p), "utf8");
}

describe("track-record shell composition (#3050)", () => {
  it("TrackRecordPanel renders one PageShell with the three dashboards as sections", () => {
    const panel = src(PANEL);
    expect(panel).toContain('<PageShell title="Track record">');
    expect(panel).toContain("<CalibrationDashboard");
    expect(panel).toContain("<EnrichmentDashboard");
    expect(panel).toContain("<ScreeningOutcomesPanel");
    expect(panel).toContain('label="Calibration dashboard"');
    expect(panel).toContain('label="Enrichment dashboard"');
    expect(panel).toContain('label="Track Record panel"');
    expect(panel).toContain('<PageSection title="Calibration dashboard">');
    expect(panel).toContain(
      '<PageSection title="Daily enrichment + minute bars">',
    );
    expect(panel).toContain(
      '<PageSection title="Recommendation track record">',
    );
  });

  it("the hub track-record branch renders the composition, not the dashboards directly", () => {
    const hub = src(HUB);
    expect(hub).toContain('effectiveSubTab === "track-record"');
    expect(hub).toContain("<TrackRecordPanel userLogin={user?.login} />");
    expect(hub).not.toContain("<CalibrationDashboard");
    expect(hub).not.toContain("<EnrichmentDashboard");
    expect(hub).not.toContain("<ScreeningOutcomesPanel");
  });

  it("the gate flipped track-record from migration to conforming", () => {
    expect(src(GATE)).toContain(
      '"track-record": "src/client/TrackRecordPanel.tsx"',
    );
    const register = JSON.parse(src(REGISTER)) as {
      subTabs: Record<string, unknown>;
    };
    expect(register.subTabs["track-record"]).toBeUndefined();
  });
});
