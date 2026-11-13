/**
 * Issue #4330 (parent #4329 S1) — every Schedules sub-tab scrolls.
 *
 * Pins:
 *  - 4330-P01 the four sub-tabs (list, runs, goals, queue) each render inside
 *    the shared scroll frame — one frame per tab, not one for the page.
 *  - 4330-P02 the frame gives BOTH axes: a long ledger scrolls vertically, a
 *    wide table horizontally.
 *  - 4330-P03 the height comes from the shared `--panel-scroll-max-height`
 *    token (the Docs run-list clamp), so the long tables scroll identically.
 *  - 4330-P04 the frame is a design-system utility (`ui-` class in the
 *    primitives sheet), not a bespoke page class — the interior-consistency
 *    gate (#3991) counts bespoke classes and the bespoke-CSS freeze (#3047)
 *    registers sheets, so the reusable shape is the only one that fits both.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const home = readFileSync(join(here, "..", "src/client/SchedulesHome.tsx"), "utf8");
const primitives = readFileSync(
  join(here, "..", "src/client/components/ui/primitives.css"),
  "utf8",
);

describe("4330-P01 one frame per sub-tab", () => {
  it("wraps every tab panel's card content", () => {
    expect(home.split('className="ui-scroll-frame"').length - 1).toBe(4);
    for (const view of ["list", "runs", "goals", "queue"]) {
      expect(home).toContain(`tabId="${view}"`);
    }
  });
});

describe("4330-P02 both axes", () => {
  it("the frame scrolls vertically and horizontally", () => {
    const rule = primitives.slice(primitives.indexOf(".ui-scroll-frame"));
    expect(rule).toContain("overflow: auto");
  });
});

describe("4330-P03 the shared viewport clamp", () => {
  it("uses the Docs run-list clamp so the two long tables behave alike", () => {
    const rule = primitives.slice(
      primitives.indexOf(".ui-scroll-frame"),
      primitives.indexOf(".ui-scroll-frame") + 300,
    );
    expect(rule).toContain("max-height: var(--panel-scroll-max-height)");
    expect(rule).toContain("scrollbar-gutter: stable");
  });
});

describe("4330-P04 a primitive, not a bespoke class", () => {
  it("uses the ui- utility and imports no page stylesheet", () => {
    expect(home).not.toContain("schedules-scroll-frame");
    expect(home).not.toContain("schedulesHome.css");
    expect(primitives).toContain(".ui-scroll-frame");
  });
});
