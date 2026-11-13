/**
 * Issue #4334 (parent #4329 S5) — the admin queue, organised.
 *
 * Pins:
 *  - 4334-P01 the sections are configuration: the owner's order is the
 *    default, the dump cannot be removed, unknown ids drop, a blank value
 *    falls back, and a default outside the set lands on the first.
 *  - 4334-P02 the view is sub-tabbed on the home's one `?section=` param, with
 *    retained panels so a previewed result survives a section switch.
 *  - 4334-P03 rows present like the schedules tab: the dump resolves the shared
 *    column vocabulary and the plan table uses the same cell shapes.
 *  - 4334-P04 the platform-admin gate is unchanged: the same server probe, the
 *    same refusal, and the panel mounts only after it passes.
 *  - 4334-P05 no action moved out from behind the gate: every section lives
 *    inside the gated panel, and the view still decides access.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_QUEUE_SCHEDULE_SECTIONS,
  SCHEDULE_SECTION_PARAM,
  resolveQueueScheduleDefaultSection,
  resolveQueueScheduleSections,
} from "../src/config/scheduleSections";
import {
  SCHEDULE_ROW_COLUMN_LABELS,
  defaultScheduleRowColumns,
  resolveScheduleRowColumns,
} from "../src/config/scheduleRowModes";

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, "..", "src/client/AdminQueueWipePanel.tsx"), "utf8");
const view = readFileSync(join(here, "..", "src/client/ScheduleQueueView.tsx"), "utf8");

describe("4334-P01 the queue's sections are configuration", () => {
  it("defaults to the owner's order and keeps the dump first", () => {
    expect(resolveQueueScheduleSections()).toEqual(["queue", "cancel", "wipe", "recreate"]);
    expect([...DEFAULT_QUEUE_SCHEDULE_SECTIONS]).toEqual(resolveQueueScheduleSections());
    expect(resolveQueueScheduleSections({ SCHEDULE_QUEUE_SECTIONS: "wipe,bogus" })).toEqual([
      "queue",
      "wipe",
    ]);
    expect(resolveQueueScheduleSections({ SCHEDULE_QUEUE_SECTIONS: " , " })).toEqual([
      ...DEFAULT_QUEUE_SCHEDULE_SECTIONS,
    ]);
  });

  it("falls a default outside the resolved set back to the dump", () => {
    const sections = resolveQueueScheduleSections({ SCHEDULE_QUEUE_SECTIONS: "wipe,recreate" });
    expect(
      resolveQueueScheduleDefaultSection({ SCHEDULE_QUEUE_DEFAULT_SECTION: "recreate" }, sections),
    ).toBe("recreate");
    expect(
      resolveQueueScheduleDefaultSection({ SCHEDULE_QUEUE_DEFAULT_SECTION: "cancel" }, sections),
    ).toBe("queue");
  });
});

describe("4334-P02 sub-tabs on the home's section param", () => {
  it("renders one retained panel per section", () => {
    expect(SCHEDULE_SECTION_PARAM).toBe("section");
    expect(panel).toContain("param: SCHEDULE_SECTION_PARAM");
    expect(panel).toContain("<Tabs<QueueScheduleSection>");
    for (const id of ["queue", "cancel", "wipe", "recreate"]) {
      expect(panel).toContain(`tabId="${id}"`);
    }
    expect(panel.split("retain>").length - 1).toBe(4);
  });
});

describe("4334-P03 rows present like the schedules tab", () => {
  it("the dump resolves the shared column vocabulary", () => {
    expect(panel).toContain('resolveScheduleRowColumns("queue")');
    expect(panel).toContain("columns={dumpColumns}");
    expect(resolveScheduleRowColumns("queue")).toEqual([
      "schedule",
      "id",
      "cadence",
      "scope",
      "status",
    ]);
    expect(defaultScheduleRowColumns("queue")).toEqual(resolveScheduleRowColumns("queue"));
    // The headers are the vocabulary's, not a second set of words.
    expect(panel).toContain("SCHEDULE_ROW_COLUMN_LABELS.schedule");
    expect(panel).toContain("SCHEDULE_ROW_COLUMN_LABELS.cadence");
    expect(SCHEDULE_ROW_COLUMN_LABELS.scope).toBe("Scope");
    // The one naming/cadence rule, reused — never re-implemented here.
    expect(panel).toContain("scheduleDisplayName");
    expect(panel).toContain("cronToEnglish");
  });

  it("the Track 1 plan table presents the same way", () => {
    expect(panel).toContain("columns={planColumns}");
    expect(panel).toContain("trackCadenceOf");
    // No call-site spacing classes: layout comes from Stack/Flex.
    expect(panel).not.toMatch(/className="ui-(stack|flex) gap-/);
  });
});

describe("4334-P04 the platform-admin gate is unchanged", () => {
  it("keeps the same server probe and the same refusal", () => {
    expect(view).toContain("fetchAdminOverview()");
    expect(view).toContain("isOverviewGateRefusal(message)");
    expect(view).toContain('title="Not an IAAA admin"');
    expect(view).toContain("return <AdminQueueWipePanel />;");
  });
});

describe("4334-P05 every section stays behind the gate", () => {
  it("the sub-tabs live inside the gated panel, not beside it", () => {
    // The Tabs render inside AdminQueueWipePanel (the gated component), so no
    // section is reachable without passing the view's probe.
    expect(panel).toContain("Admin queue sections");
    expect(view).not.toContain("<Tabs");
    expect(view).not.toContain("SCHEDULE_QUEUE_SECTIONS");
  });
});
