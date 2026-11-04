/**
 * Issue #3026 (follower of #2601) — pins for the alarm-surface inventory.
 * The register must be total over src/, every entry must name its gap,
 * and no entry may be able to fire a second stage. A new file that
 * touches the framework queue fails until it is dispositioned.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALARM_SURFACE_REGISTER,
  assertAlarmInventory,
  filesOnAlarmSurface,
} from "../src/agents/orchestrator/alarmInventory";

/** Every src file that mentions the framework alarm/schedule tables. */
function sourceFilesOnAlarmSurface(): string[] {
  // Hermetic scan: a plain recursive read, no external binary — a test that
  // shells out to rg is a test that passes only on its author's machine.
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const text = readFileSync(path, "utf8");
      if (/cf_agents_jobs|cf_agents_schedules/.test(text)) found.push(path.replace(/\\/g, "/"));
    }
  };
  walk("src");
  return found
    .filter(Boolean)
    // The register itself NAMES the framework tables (that is its job).
    // It schedules nothing — it is data plus assertions — so it is the one
    // file excluded from its own totality scan, explicitly.
    .filter((file) => file !== "src/agents/orchestrator/alarmInventory.ts")
    .sort();
}

describe("alarm-surface inventory (#3026)", () => {
  it("is total over src: every file on the alarm surface is dispositioned", () => {
    const scanned = sourceFilesOnAlarmSurface();
    expect(scanned.length).toBeGreaterThan(0);
    expect([...filesOnAlarmSurface()].sort()).toEqual(scanned);
  });

  it("names a documented gap for every entry", () => {
    for (const entry of ALARM_SURFACE_REGISTER) {
      expect(entry.documentedGap.trim().length).toBeGreaterThan(0);
    }
  });

  it("never lets the alarm surface start a second stage", () => {
    expect(ALARM_SURFACE_REGISTER.every((entry) => entry.singleShot)).toBe(true);
    expect(() => assertAlarmInventory()).not.toThrow();
  });

  it("refuses an entry with no gap, a duplicate, or a chained site", () => {
    expect(() => assertAlarmInventory([])).toThrow(/empty/i);
    expect(() =>
      assertAlarmInventory([
        { file: "a.ts", kind: "agent-schedule", what: "x", documentedGap: " ", singleShot: true },
      ]),
    ).toThrow(/documented gap/i);
    expect(() =>
      assertAlarmInventory([
        { file: "a.ts", kind: "agent-schedule", what: "x", documentedGap: "g", singleShot: true },
        { file: "a.ts", kind: "agent-schedule", what: "y", documentedGap: "g", singleShot: true },
      ]),
    ).toThrow(/duplicate/i);
    expect(() =>
      assertAlarmInventory([
        { file: "a.ts", kind: "agent-schedule", what: "x", documentedGap: "g", singleShot: false },
      ]),
    ).toThrow(/chain engine/i);
  });

  it("keeps the register readable: each entry says what schedules work", () => {
    for (const entry of ALARM_SURFACE_REGISTER) {
      expect(entry.what.trim().length).toBeGreaterThan(10);
      // The register is data, not prose: a file listed must exist.
      expect(() => readFileSync(entry.file, "utf8")).not.toThrow();
    }
  });
});
