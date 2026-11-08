import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const HERE = join(__dirname, "..");
const PANEL = "src/client/GoalScreenPanel.tsx";
const HUB = "src/client/ETradeTradingHub.tsx";
const GATE = "tests/ux_conformance_gates_3047.test.ts";
const REGISTER = "tests/ux_shell_exceptions_3047.json";

function src(p: string): string {
  return readFileSync(join(HERE, p), "utf8");
}

describe("goal-screen shell composition (#3050)", () => {
  it("GoalScreenPanel renders one PageShell with its five sections", () => {
    const panel = src(PANEL);
    expect(panel).toContain('<PageShell');
    expect(panel).toContain('title="Goal Screen"');
    expect(panel).toContain('<PageSection title="Run a goal screen">');
    expect(panel).toContain(
      '<PageSection title="Start a paid saga journey">',
    );
    expect(panel).toContain(
      '<PageSection title="Pending journey decisions">',
    );
    expect(panel).toContain(
      '<PageSection title="Staged run in progress">',
    );
    expect(panel).toContain('<PageSection title="Results">');
  });

  it("the bespoke goal-screen classes are gone from the component", () => {
    const panel = src(PANEL);
    for (const cls of [
      "goal-screen-report-actions",
      "goal-screen-download-",
    ]) {
      expect(panel).not.toContain(cls);
    }
    expect(panel).not.toContain("<h1");
  });

  it("the hub goal-screen branch still renders the panel", () => {
    const hub = src(HUB);
    expect(hub).toContain('effectiveSubTab === "goal-screen"');
    expect(hub).toContain("<GoalScreenPanel");
  });

  it("the gate flipped goal-screen from migration to conforming", () => {
    expect(src(GATE)).toContain(
      '"goal-screen": "src/client/GoalScreenPanel.tsx"',
    );
    const register = JSON.parse(src(REGISTER)) as {
      subTabs: Record<string, unknown>;
    };
    expect(register.subTabs["goal-screen"]).toBeUndefined();
  });
});
