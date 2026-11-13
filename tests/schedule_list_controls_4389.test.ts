/**
 * Issue #4389 — one button set with one vocabulary (ticker included), sortable
 * columns, a Status column, and Active/Paused filters.
 *
 * Pins:
 *  - 4389-P01 the actions cell is ONE set for every kind — Edit · Details ·
 *    Trigger Now · Pause/Resume · Delete — with no per-kind branch and no
 *    second word for a control.
 *  - 4389-P02 Edit opens the row's own editor, and the cadence dialog is
 *    interval-only for a live feed (no cron preset, no cron field, no apply).
 *  - 4389-P03 the one ordering rule: a click toggles, numbers compare
 *    numerically, strings locale-aware, blanks last in both directions, ties
 *    keep the caller's order.
 *  - 4389-P04 Status is its own column, from the shared row vocabulary.
 *  - 4389-P05 the status filters are configuration and compose with the kinds.
 *  - 4389-P06 the live feed's Details and Trigger Now reach it through its own
 *    DO — the same controls, a real implementation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nextTableSort, sortTableRows, tableSortAria } from "../src/client/tableSort";
import {
  DEFAULT_SCHEDULE_LIST_STATUSES,
  SCHEDULE_LIST_STATUS_LABELS,
  resolveScheduleListStatusFilters,
} from "../src/config/scheduleListModes";
import { resolveScheduleRowColumns } from "../src/config/scheduleRowModes";

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, "..", "src/client/SchedulesPanel.tsx"), "utf8");
const dialog = readFileSync(
  join(here, "..", "src/client/scheduledOptionsManager/CadenceModal.tsx"),
  "utf8",
);
const route = readFileSync(join(here, "..", "src/agents/routes/schedules.ts"), "utf8");

describe("4389-P01 one button set, every kind", () => {
  it("renders the five controls in one cell, with no per-kind branch", () => {
    const actions = panel.slice(panel.indexOf('key: "actions"'), panel.indexOf("  ];"));
    for (const label of ["Edit", "Details", "Trigger Now", "Delete"]) {
      expect(actions).toMatch(new RegExp(`>\\s*${label}\\s*<`));
    }
    expect(actions).toContain('{s.paused ? "Resume" : "Pause"}');
    // The old per-kind branch (a feed with a shorter list) is gone.
    expect(actions).not.toContain('s.kind === "ticker-push"');
    // One Edit, not two vocabularies.
    expect(actions).not.toContain("Edit frequency");
    expect(panel).not.toContain("Edit frequency");
  });
});

describe("4389-P02 the editor follows the row", () => {
  it("Edit picks the screening form or the cadence dialog", () => {
    expect(panel).toContain("if (SCREENING_CALLBACKS.has(s.callback)) {");
    expect(panel).toContain("setEditRequest({ scheduleId: s.id, nonce: Date.now() })");
    expect(panel).toContain("setCadenceTarget(s)");
  });

  it("the feed's cadence dialog is interval-only", () => {
    expect(dialog).toContain('item.kind === "ticker-push"');
    expect(dialog).toContain('preset.body.scheduleType === "interval"');
    expect(dialog).toContain("Interval only");
    // The cron affordances live in the else branch, never for a feed.
    expect(dialog).toContain("Custom cron (UTC)");
    expect(dialog.split("Apply cron").length - 1).toBe(1);
  });
});

describe("4389-P03 the one ordering rule", () => {
  it("toggles direction on the same column, starts ascending on a new one", () => {
    expect(nextTableSort(null, "cadence")).toEqual({ key: "cadence", direction: "asc" });
    expect(nextTableSort({ key: "cadence", direction: "asc" }, "cadence")).toEqual({
      key: "cadence",
      direction: "desc",
    });
    expect(nextTableSort({ key: "cadence", direction: "desc" }, "id")).toEqual({
      key: "id",
      direction: "asc",
    });
    expect(tableSortAria(null, "id")).toBe("none");
    expect(tableSortAria({ key: "id", direction: "desc" }, "id")).toBe("descending");
  });

  const rows = [
    { name: "Beta", n: 2 },
    { name: "alpha", n: 10 },
    { name: "", n: null },
    { name: "beta", n: 2 },
  ];
  const accessor = (row: (typeof rows)[number], key: string) =>
    key === "name" ? row.name : row.n;

  it("orders strings locale-aware and numbers numerically", () => {
    expect(sortTableRows(rows, { key: "n", direction: "asc" }, accessor).map((r) => r.n)).toEqual([
      2, 2, 10, null,
    ]);
    expect(sortTableRows(rows, { key: "name", direction: "asc" }, accessor)[0].name).toBe("alpha");
  });

  it("keeps blanks last in both directions and ties in the caller's order", () => {
    expect(sortTableRows(rows, { key: "n", direction: "desc" }, accessor).at(-1)?.n).toBeNull();
    const names = sortTableRows(rows, { key: "name", direction: "asc" }, accessor).map((r) => r.name);
    expect(names.at(-1)).toBe("");
    // "Beta" precedes "beta" in the caller's order, and a stable sort keeps it.
    expect(names.indexOf("Beta")).toBeLessThan(names.indexOf("beta"));
  });
});

describe("4389-P04 Status is its own column", () => {
  it("comes from the shared vocabulary and renders a badge", () => {
    expect(resolveScheduleRowColumns("list")).toEqual([
      "schedule",
      "id",
      "cadence",
      "status",
      "scope",
      "actions",
    ]);
    expect(panel).toContain('key: "status"');
    expect(panel).toContain('{s.paused ? "Paused" : "Active"}');
    // The status badge is no longer inside the Schedule cell.
    const scheduleCell = panel.slice(panel.indexOf('key: "schedule"'), panel.indexOf('key: "id"'));
    expect(scheduleCell).not.toContain('{s.paused ? "Paused" : "Active"}');
  });
});

describe("4389-P05 the status filters are configuration", () => {
  it("defaults to all · active · paused, and narrows from env", () => {
    expect([...DEFAULT_SCHEDULE_LIST_STATUSES]).toEqual(["all", "active", "paused"]);
    expect(resolveScheduleListStatusFilters()).toEqual(["all", "active", "paused"]);
    expect(SCHEDULE_LIST_STATUS_LABELS.paused).toBe("Paused");
    expect(resolveScheduleListStatusFilters({ SCHEDULE_LIST_STATUSES: "paused,bogus" })).toEqual([
      "all",
      "paused",
    ]);
    expect(resolveScheduleListStatusFilters({ SCHEDULE_LIST_STATUSES: " , " })).toEqual([
      "all",
      "active",
      "paused",
    ]);
  });

  it("the panel composes the status filter with the kind filter", () => {
    expect(panel).toContain("statusFilter === \"paused\" ? Boolean(s.paused) : !s.paused");
    expect(panel).toContain("Filter schedules by status");
  });
});

describe("4389-P06 the feed's Details and Trigger are real", () => {
  it("the route serves the feed's detail from its own DO", () => {
    expect(route).toContain("tickerPushStub().getTickerPushRecord()");
    expect(route).toContain("tickerPushRecordToListItem(");
  });

  it("the route triggers the feed once, refusing while paused", () => {
    expect(route).toContain("tickerPushStub().triggerTickerPush()");
    expect(route).toContain("The live feed is paused — resume it before triggering.");
  });
});
