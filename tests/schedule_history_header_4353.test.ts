/**
 * Issue #4353 (parent #4348, epic #4329) — history carries its date, and a
 * section header is one row.
 *
 * Pins:
 *  - 4353-P01 a history row's timestamp is a DATE AND TIME; a missing or
 *    unparseable value says "not recorded" instead of rendering now.
 *  - 4353-P02 the audit section's name, count and description share one heading
 *    row — the table carries no second title (its caption) above it.
 *  - 4353-P03 the schedules list's header does the same: name + count + the
 *    table's description on one row, and the caption is gone.
 *  - 4353-P04 the table is still named for assistive technology: the section is
 *    labelled by its heading, so removing the caption removes nothing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { formatAuditTimestamp } from "../src/client/scheduledOptionsManager/format";

const here = dirname(fileURLToPath(import.meta.url));
const audit = readFileSync(
  join(here, "..", "src/client/scheduledOptionsManager/AuditTrailSection.tsx"),
  "utf8",
);
const panel = readFileSync(join(here, "..", "src/client/SchedulesPanel.tsx"), "utf8");

describe("4353-P01 the timestamp carries a date", () => {
  it("formats a recorded instant as a date and a time", () => {
    const rendered = formatAuditTimestamp("2026-11-13T09:41:00.000Z");
    expect(rendered).toMatch(/\d{4}/);
    expect(rendered).toMatch(/\d{1,2}:\d{2}/);
    expect(rendered).not.toBe("not recorded");
  });

  it("says so when there is no recorded time, never renders now", () => {
    expect(formatAuditTimestamp(undefined)).toBe("not recorded");
    expect(formatAuditTimestamp("")).toBe("not recorded");
    expect(formatAuditTimestamp("not a date")).toBe("not recorded");
  });

  it("the audit row uses the one formatter, not a bare time", () => {
    expect(audit).toContain("formatAuditTimestamp");
    expect(audit).not.toContain("toLocaleTimeString");
  });
});

describe("4353-P02 one heading row on the audit trail", () => {
  it("the name, the count and the description share the heading", () => {
    expect(audit).toContain("Execution History &amp; Audit Trail");
    expect(audit).toContain("Schedule execution history");
    // The description is inside the heading, not a second stacked title.
    const heading = audit.slice(audit.indexOf("<h4"), audit.indexOf("</h4>"));
    expect(heading).toContain("Schedule execution history");
    expect(audit).not.toContain('caption="Schedule execution history"');
  });
});

describe("4353-P03 one heading row on the schedules list", () => {
  it("keeps the count and the description on the heading, and drops the caption", () => {
    const heading = panel.slice(panel.indexOf("<h4"), panel.indexOf("</h4>"));
    expect(heading).toContain("Every durable schedule, one row each");
    expect(heading).toContain("sched-count-pill");
    expect(panel).not.toContain('caption="Every durable schedule, one row each"');
  });
});

describe("4353-P04 the table keeps an accessible name", () => {
  it("the section is labelled by its heading", () => {
    expect(audit).toContain('aria-labelledby="sched-audit-heading"');
    expect(audit).toContain('id="sched-audit-heading"');
  });
});
