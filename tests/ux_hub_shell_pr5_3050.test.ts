import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const HERE = join(__dirname, "..");
const HUB = "src/client/ETradeTradingHub.tsx";
const GATE = "tests/ux_conformance_gates_3047.test.ts";
const REGISTER = "tests/ux_shell_exceptions_3047.json";

const PANELS: Array<{ file: string; title: string; section: string }> = [
  {
    file: "src/client/PortfolioPanel.tsx",
    title: 'title="Portfolio"',
    section: '<PageSection title="Portfolio & holdings">',
  },
  {
    file: "src/client/LedgerPanel.tsx",
    title: 'title="Order Execution Ledger"',
    section: '<PageSection title="Order execution ledger">',
  },
  {
    file: "src/client/OmnichannelPanel.tsx",
    title: 'title="Omnichannel Trading Desks"',
    section: '<PageSection title="Omnichannel trading desks">',
  },
  {
    file: "src/client/VoicePanel.tsx",
    title: 'title="Voice Trading Desk"',
    section: '<PageSection title="Voice trading desk">',
  },
];

function src(p: string): string {
  return readFileSync(join(HERE, p), "utf8");
}

describe("hub shell migration PR5 (#3050)", () => {
  it("each panel renders one PageShell with its title and section", () => {
    for (const { file, title, section } of PANELS) {
      const panel = src(file);
      expect(panel).toContain("<PageShell");
      expect(panel).toContain(title);
      expect(panel).toContain(section);
      expect(panel).not.toContain("<h1");
    }
  });

  it("the hub branches render the panels", () => {
    const hub = src(HUB);
    for (const [id, panel] of [
      ["portfolio", "<PortfolioPanel"],
      ["ledger", "<LedgerPanel"],
      ["omnichannel", "<OmnichannelPanel"],
      ["voice", "<VoicePanel"],
    ] as const) {
      expect(hub).toContain(`effectiveSubTab === "${id}"`);
      expect(hub).toContain(panel);
    }
  });

  it("the gate flipped the four sub-tabs from migration to conforming", () => {
    const gate = src(GATE);
    for (const { file } of PANELS) {
      const id = file
        .replace("src/client/", "")
        .replace("Panel.tsx", "")
        .toLowerCase();
      expect(gate).toContain(`"${id}": "${file}"`);
    }
    const register = JSON.parse(src(REGISTER)) as {
      subTabs: Record<string, unknown>;
    };
    for (const id of ["portfolio", "ledger", "omnichannel", "voice"]) {
      expect(register.subTabs[id]).toBeUndefined();
    }
  });
});
