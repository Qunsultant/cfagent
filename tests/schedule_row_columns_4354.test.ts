/**
 * Issue #4354 (parent #4348, epic #4329) — a schedule row fits.
 *
 * Pins:
 *  - 4354-P01 the scope value renders IN FULL: no 90-character cut, no
 *    ellipsis appended by the summary (the owner could not read the
 *    `taskId`/`scheduleHash` an operator needs).
 *  - 4354-P02 the cadence and scope columns have a minimum width, so a value
 *    holds its line instead of pushing the row to three-plus lines.
 *  - 4354-P03 the list applies both, and the table still scrolls horizontally
 *    (a wide row is scrolled, never clipped).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, "..", "src/client/SchedulesPanel.tsx"), "utf8");
const sheet = readFileSync(join(here, "..", "src/client/scheduledOptions.css"), "utf8");

describe("4354-P01 the scope shows its whole value", () => {
  it("the summary no longer truncates", () => {
    // The old body cut at 90 characters and appended "…".
    expect(panel).not.toContain("text.slice(0, 90)");
    expect(panel).not.toContain("text.length > 90");
    expect(panel).toContain("return keys");
    expect(panel).toContain(".join(\" · \")");
  });

  it("keeps a readable rendering for object values", () => {
    expect(panel).toContain('typeof v === "object" ? "…" : String(v)');
  });
});

describe("4354-P02 the columns have a floor", () => {
  it("the cadence and scope columns hold their content", () => {
    const cadence = sheet.slice(sheet.indexOf(".schedule-row-cadence"));
    expect(cadence.slice(0, 120)).toContain("min-width: 220px");
    const scope = sheet.slice(sheet.indexOf(".schedule-row-scope"));
    expect(scope.slice(0, 120)).toContain("min-width: 260px");
  });
});

describe("4354-P03 the list applies both, and still scrolls", () => {
  it("names the two cell classes on the columns", () => {
    expect(panel).toContain('cellClassName: "schedule-row-cadence"');
    expect(panel).toContain('cellClassName: "schedule-row-scope"');
  });

  it("keeps the horizontal scroll frame on the table", () => {
    expect(panel).toContain('containerClassName="sched-table-scroll"');
    const scroll = sheet.slice(sheet.indexOf(".sched-table-scroll"));
    expect(scroll.slice(0, 160)).toContain("overflow");
  });
});
