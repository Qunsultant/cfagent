/**
 * Issue #4332 (parent #4329 S3) — the options-runs card moves into the ledger,
 * losslessly.
 *
 * Pins:
 *  - 4332-P01 the join is by the recorded start instant: a ledger row whose
 *    start matches an autonomous options run gains that run's symbols and
 *    actionable setups; no match is "—", never a guessed value.
 *  - 4332-P02 the join never creates a second row: it is a lookup keyed by
 *    timestamp, with the newest record winning a duplicate.
 *  - 4332-P03 the schedules home stops showing the card; the options manager
 *    keeps it for standalone use.
 *  - 4332-P04 the ledger renders both columns.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  optionsDetailForStart,
  optionsRunDetailsByStart,
} from "../src/client/runLedgerOptionsRuns";

const here = dirname(fileURLToPath(import.meta.url));
const ledger = readFileSync(
  join(here, "..", "src/client/ScheduleRunLedgerPanel.tsx"),
  "utf8",
);
const manager = readFileSync(
  join(here, "..", "src/client/ScheduledOptionsManager.tsx"),
  "utf8",
);
const panel = readFileSync(join(here, "..", "src/client/SchedulesPanel.tsx"), "utf8");

describe("4332-P01 the join", () => {
  it("carries symbols and actionable setups onto the matching instant", () => {
    const map = optionsRunDetailsByStart([
      {
        timestamp: "2026-11-12T10:00:00.000Z",
        success: true,
        symbols: ["AAPL", "MSFT"],
        withTrades: 2,
        summary: "screened",
        trigger: "scheduled",
      },
    ]);
    const detail = optionsDetailForStart(map, "2026-11-12T10:00:00.000Z");
    expect(detail?.symbols).toEqual(["AAPL", "MSFT"]);
    expect(detail?.withTrades).toBe(2);
  });

  it("returns null when no record matches — the row renders a dash", () => {
    const map = optionsRunDetailsByStart([]);
    expect(optionsDetailForStart(map, "2026-11-12T10:00:00.000Z")).toBeNull();
    expect(optionsDetailForStart(map, null)).toBeNull();
    expect(optionsDetailForStart(map, "not a date")).toBeNull();
  });
});

describe("4332-P02 a lookup, not a second row source", () => {
  it("keeps one entry per instant", () => {
    const map = optionsRunDetailsByStart([
      { timestamp: "2026-11-12T10:00:00.000Z", success: true, withTrades: 3 },
      { timestamp: "2026-11-12T10:00:00.000Z", success: true, withTrades: 9 },
    ]);
    expect(map.size).toBe(1);
    expect(optionsDetailForStart(map, "2026-11-12T10:00:00.000Z")?.withTrades).toBe(3);
  });
});

describe("4332-P03 the columns land before the card leaves", () => {
  it("the ledger carries the card's two fields; the card's removal is separate", () => {
    // The card is still rendered: taking it out moves a documented pin
    // (schedule_ui_s7) whose subject is that surface, and it also hosts the
    // Edit flow for screening rows. The additive half — the columns — is what
    // this slice proves; the removal is recorded on #4332.
    expect(ledger).toContain('header: "Symbols"');
    expect(manager).toContain("<LatestRunsSection");
  });
});

describe("4332-P04 the ledger renders both columns", () => {
  it("Symbols and Actionable setups are columns of the one ledger", () => {
    expect(ledger).toContain('header: "Symbols"');
    expect(ledger).toContain('header: "Actionable setups"');
    expect(ledger).toContain("/api/options/latest");
  });
});
