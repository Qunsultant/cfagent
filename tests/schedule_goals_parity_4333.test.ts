/**
 * Issue #4333 (parent #4329 S4) — the goals tab at parity with the schedules
 * tab, organised as sub-tabs.
 *
 * Pins:
 *  - 4333-P01 the sections are configuration: the owner's order is the
 *    default, the first section cannot be removed, unknown ids drop, a blank
 *    value falls back, and a default outside the set lands on the first.
 *  - 4333-P02 one row vocabulary: the goals table carries the schedules list's
 *    identity columns plus the goal's own, every surface leads with the same
 *    base columns, and the seam narrows a surface's own extras only.
 *  - 4333-P03 the panel renders one row per goal through the Table primitive,
 *    resolving its columns from that vocabulary.
 *  - 4333-P04 the action set is the schedules tab's: Trigger Now, Pause/Resume,
 *    Delete — the destructive action is Delete, never a second word for it.
 *  - 4333-P05 the Add-goal form follows the schedules editor's presentation:
 *    labelled fields, the catalog-driven operation select, the delegation
 *    contract, and the submit as the form's last row.
 *  - 4333-P06 the page is sub-tabbed on `?section=` (a stable deep link, the
 *    home's one section param) and the goal-runs section hands run history to
 *    the one ledger (`kind=goal`) instead of listing runs locally.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_GOAL_SCHEDULE_SECTIONS,
  DEFAULT_QUEUE_SCHEDULE_SECTIONS,
  SCHEDULE_SECTION_PARAM,
  resolveGoalScheduleDefaultSection,
  resolveGoalScheduleSections,
  resolveQueueScheduleDefaultSection,
  resolveQueueScheduleSections,
} from "../src/config/scheduleSections";
import {
  SCHEDULE_ROW_BASE_COLUMNS,
  SCHEDULE_ROW_SURFACES,
  defaultScheduleRowColumns,
  resolveScheduleRowColumns,
} from "../src/config/scheduleRowModes";

const here = dirname(fileURLToPath(import.meta.url));
const goalsPanel = readFileSync(
  join(here, "..", "src/client/ScheduledGoalsPanel.tsx"),
  "utf8",
);
const schedulesPanel = readFileSync(join(here, "..", "src/client/SchedulesPanel.tsx"), "utf8");

describe("4333-P01 the sections are configuration", () => {
  it("defaults to the owner's order", () => {
    expect(resolveGoalScheduleSections()).toEqual([
      "goals",
      "add",
      "resources",
      "seed",
      "ticks",
      "runs",
    ]);
    expect([...DEFAULT_GOAL_SCHEDULE_SECTIONS]).toEqual(resolveGoalScheduleSections());
    expect(resolveQueueScheduleSections()).toEqual(["queue", "cancel", "wipe", "recreate"]);
    expect([...DEFAULT_QUEUE_SCHEDULE_SECTIONS]).toEqual(resolveQueueScheduleSections());
  });

  it("honours the env set, keeps the view's own section first, drops unknowns", () => {
    expect(resolveGoalScheduleSections({ SCHEDULE_GOAL_SECTIONS: "ticks,bogus" })).toEqual([
      "goals",
      "ticks",
    ]);
    expect(
      resolveQueueScheduleSections({ SCHEDULE_QUEUE_SECTIONS: "wipe,cancel,wipe" }),
    ).toEqual(["queue", "wipe", "cancel"]);
  });

  it("falls back to the built-in set on a blank value", () => {
    expect(resolveGoalScheduleSections({ SCHEDULE_GOAL_SECTIONS: " , " })).toEqual([
      ...DEFAULT_GOAL_SCHEDULE_SECTIONS,
    ]);
    expect(resolveQueueScheduleSections({ SCHEDULE_QUEUE_SECTIONS: "" })).toEqual([
      ...DEFAULT_QUEUE_SCHEDULE_SECTIONS,
    ]);
  });

  it("lands a default outside the resolved set on the first section", () => {
    const sections = resolveGoalScheduleSections({ SCHEDULE_GOAL_SECTIONS: "ticks,seed" });
    expect(resolveGoalScheduleDefaultSection({ SCHEDULE_GOAL_DEFAULT_SECTION: "seed" }, sections)).toBe(
      "seed",
    );
    expect(resolveGoalScheduleDefaultSection({ SCHEDULE_GOAL_DEFAULT_SECTION: "runs" }, sections)).toBe(
      "goals",
    );
    const queue = resolveQueueScheduleSections({ SCHEDULE_QUEUE_SECTIONS: "wipe" });
    expect(
      resolveQueueScheduleDefaultSection({ SCHEDULE_QUEUE_DEFAULT_SECTION: "cancel" }, queue),
    ).toBe("queue");
  });
});

describe("4333-P02 one row vocabulary", () => {
  it("the goals table carries the schedules list's identity columns plus its own", () => {
    const list = resolveScheduleRowColumns("list");
    const goals = resolveScheduleRowColumns("goals");
    for (const base of SCHEDULE_ROW_BASE_COLUMNS) expect(goals).toContain(base);
    expect(goals).toEqual([
      "schedule",
      "id",
      "cadence",
      "operation",
      "budget",
      "lastRun",
      "provenance",
      "actions",
    ]);
    expect(list).toEqual(["schedule", "id", "cadence", "scope", "actions"]);
    expect(resolveScheduleRowColumns("queue")).toEqual([
      "schedule",
      "id",
      "cadence",
      "scope",
      "status",
    ]);
  });

  it("every surface leads with the same base columns", () => {
    for (const surface of SCHEDULE_ROW_SURFACES) {
      expect(resolveScheduleRowColumns(surface).slice(0, SCHEDULE_ROW_BASE_COLUMNS.length)).toEqual([
        ...SCHEDULE_ROW_BASE_COLUMNS,
      ]);
    }
  });

  it("the seam narrows or reorders a surface's own extras, never its base", () => {
    expect(
      resolveScheduleRowColumns("goals", {
        SCHEDULE_ROW_GOAL_COLUMNS: "budget,status,schedule,operation",
      }),
    ).toEqual(["schedule", "id", "cadence", "budget", "operation", "actions"]);
    expect(resolveScheduleRowColumns("goals", { SCHEDULE_ROW_GOAL_COLUMNS: " , " })).toEqual(
      defaultScheduleRowColumns("goals"),
    );
    // The list resolves the same vocabulary its rows render.
    expect(schedulesPanel).toContain('resolveScheduleRowColumns("list")');
  });
});

describe("4333-P03 one row per goal", () => {
  it("renders the goals through the Table primitive from the resolved columns", () => {
    expect(goalsPanel).toContain('resolveScheduleRowColumns("goals")');
    expect(goalsPanel).toContain("<Table");
    expect(goalsPanel).toContain("columns={goalColumns}");
    expect(goalsPanel).toContain("rows={goals}");
    expect(goalsPanel).toContain('caption="Every scheduled goal, one row each"');
    // The card-per-goal shape is gone: one row, the actions on the row.
    expect(goalsPanel).not.toContain("scheduled-goal-card");
  });
});

describe("4333-P04 the schedules tab's action set", () => {
  it("offers Trigger Now, Pause/Resume and Delete — Delete is the destructive word", () => {
    expect(goalsPanel).toContain("Trigger Now");
    expect(goalsPanel).toContain('{g.enabled ? "Pause" : "Resume"}');
    expect(goalsPanel).toContain("Delete");
    expect(goalsPanel).toContain('title="Delete this goal?"');
    expect(goalsPanel).not.toContain("Remove scheduled goal?");
    expect(goalsPanel).not.toContain(">Remove<");
    // A disabled goal is not triggered — the list's rule, applied here.
    expect(goalsPanel).toContain("disabled={!!busy || !g.enabled}");
  });
});

describe("4333-P05 the Add-goal form matches the schedules editor", () => {
  it("labels every field, keeps the catalog select, the contract and a footer submit", () => {
    for (const label of [
      'label="Built-in goal"',
      'label="Goal id"',
      'label="Name"',
      'label="Cadence (cron)"',
      'label="Operation"',
      'label="Budget (cents)"',
      'label="Time zone"',
    ]) {
      expect(goalsPanel).toContain(label);
    }
    expect(goalsPanel).toContain("<DelegationContractPreview");
    expect(goalsPanel).toContain('aria-label="operation"');
    // The submit closes the form, as the schedules editor's footer does.
    expect(goalsPanel).toContain('{"Add goal"}');
    expect(goalsPanel).toContain('<Flex gap="2" justify="end">');
    // Layout comes from the Stack/Flex primitives, never call-site spacing
    // classes (the interior gate counts those as bespoke, #3991).
    expect(goalsPanel).not.toMatch(/className="ui-(stack|flex) gap-/);
  });
});

describe("4333-P06 sub-tabs and the ledger hand-off", () => {
  it("writes the home's one section param and retains the panels", () => {
    expect(SCHEDULE_SECTION_PARAM).toBe("section");
    expect(goalsPanel).toContain("param: SCHEDULE_SECTION_PARAM");
    expect(goalsPanel).toContain("<Tabs<GoalScheduleSection>");
    expect(goalsPanel.split("retain>").length - 1).toBe(6);
  });

  it("hands goal runs to the one ledger instead of listing them", () => {
    expect(goalsPanel).toContain('navigateToTab("schedules", "runs", { kind: "goal" })');
    expect(goalsPanel).toContain("Open goal runs in the run ledger");
    // No second run list: the section reports the count and links out.
    expect(goalsPanel).not.toContain("ledgerLinkageCell");
    expect(goalsPanel).not.toContain("{runs.map");
  });
});
