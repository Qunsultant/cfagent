/**
 * Issue #388 — Reports/Schedules nav wiring regression.
 *
 * PR #324 wired ReportsPanel/SchedulesPanel into the trading hub and added
 * the nav items, but Chat.tsx never learned the two tab ids: they were
 * missing from TRADING_TABS (so the hub container was hidden) and from
 * mapTabToTradingSubTab (so the hub would have shown autopilot anyway),
 * and Chat's main view has no branch for them — the tabs rendered a blank
 * page. These source pins keep the three legs of the wiring in place.
 *
 * Issue #3121 S2: schedules leaves the hub. The three legs below now
 * apply to reports only; schedules renders from the shell (Chat.tsx
 * TAB_CONTENT → SchedulesHome), and the pins after them keep the
 * de-hubbing in place — a hub schedules branch reappearing is a
 * second schedules surface, not a fix.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getRoute } from "../src/client/routes";

const here = dirname(fileURLToPath(import.meta.url));
const chatTypesSrc = readFileSync(join(here, "..", "src", "client", "chat", "types.ts"), "utf8").replace(/\r\n/g, "\n");
const chatSrc = readFileSync(join(here, "..", "src", "client", "Chat.tsx"), "utf8").replace(/\r\n/g, "\n");
const hubSrc = readFileSync(
  join(here, "..", "src", "client", "ETradeTradingHub.tsx"),
  "utf8",
);

describe("reports/schedules nav wiring (#388)", () => {
  it.each(["reports"])(
    "%s is a trading tab (hub container not hidden)",
    (tab) => {
      // #2077: the retained set lives in the route table, not a hand list.
      expect(getRoute(tab)).toMatchObject({ retain: true });
    },
  );

  it.each(["reports"])(
    "mapTabToTradingSubTab maps %s to itself",
    (tab) => {
      expect(chatTypesSrc).toContain(`case "${tab}":\n      return "${tab}";`);
    },
  );

  it.each(["reports"])(
    "the hub renders a panel for the %s subtab",
    (tab) => {
      expect(hubSrc).toContain(`effectiveSubTab === "${tab}"`);
    },
  );

  it("the trading-view container hides only for non-trading tabs", () => {
    expect(chatSrc).toContain("hidden={!isTradingTab(tab)}");
  });

  it("schedules is de-hubbed (#3121 S2): not a trading tab, no hub mapping, no hub branch", () => {
    expect(getRoute("schedules")).not.toMatchObject({ retain: true });
    expect(chatTypesSrc).not.toContain('case "schedules":');
    expect(hubSrc).not.toContain('effectiveSubTab === "schedules"');
    expect(hubSrc).not.toContain('from "./SchedulesPanel"');
  });

  it("schedules renders from the shell (TAB_CONTENT → SchedulesHome)", () => {
    expect(chatSrc).toContain("schedules: (\n      <SchedulesHome");
    expect(chatSrc).toContain('import { SchedulesHome } from "./SchedulesHome";');
  });
});
