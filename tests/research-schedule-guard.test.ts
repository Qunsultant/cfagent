/**
 * Issue #354 — tests for the pure research-schedule guard.
 *
 * The fire/no-fire decision (weekday Mon-Fri, at/after 21:00 UTC, not
 * already fired today) is pure and SDK-free, so it is tested here without
 * the Worker harness. The durable half (mas_settings marker) is covered by
 * the orchestrator integration tests.
 */
import { describe, it, expect } from "vitest";
import {
  shouldFireResearchTick,
  researchTickDateKey,
} from "../src/services/researchScheduleGuard";
import { DEFAULT_RESEARCH_JOB_CONFIG } from "../src/config/researchJobConfig";

/** Monday 2026-10-19 21:05 UTC. */
function mon2105(): Date {
  return new Date(Date.UTC(2026, 9, 19, 21, 5, 0));
}

describe("researchTickDateKey", () => {
  it("formats the UTC date, not local time", () => {
    expect(researchTickDateKey(new Date(Date.UTC(2026, 9, 19, 23, 59)))).toBe(
      "2026-10-19"
    );
    // Just after midnight UTC is a new key even if still yesterday locally.
    expect(researchTickDateKey(new Date(Date.UTC(2026, 9, 20, 0, 1)))).toBe(
      "2026-10-20"
    );
  });
});

describe("shouldFireResearchTick", () => {
  it("fires on a weekday at/after 21:00 UTC when nothing fired today", () => {
    const d = shouldFireResearchTick(mon2105(), null);
    expect(d.fire).toBe(true);
    if (d.fire) expect(d.dateKey).toBe("2026-10-19");
  });

  it("fires at exactly 21:00 UTC (boundary inclusive)", () => {
    const d = shouldFireResearchTick(new Date(Date.UTC(2026, 9, 19, 21, 0, 0)), null);
    expect(d.fire).toBe(true);
  });

  it("does not fire at 20:30 on a weekday (too early)", () => {
    const d = shouldFireResearchTick(
      new Date(Date.UTC(2026, 9, 19, 20, 30, 0)),
      null
    );
    expect(d.fire).toBe(false);
    if (!d.fire) expect(d.reason).toBe("too-early");
  });

  it("does not fire on Saturday 21:00", () => {
    const d = shouldFireResearchTick(
      new Date(Date.UTC(2026, 9, 24, 21, 5, 0)),
      null
    );
    expect(d.fire).toBe(false);
    if (!d.fire) expect(d.reason).toBe("weekend");
  });

  it("does not fire on Sunday 21:00", () => {
    const d = shouldFireResearchTick(
      new Date(Date.UTC(2026, 9, 25, 21, 5, 0)),
      null
    );
    expect(d.fire).toBe(false);
    if (!d.fire) expect(d.reason).toBe("weekend");
  });

  it("does not fire a second time the same day (21:30 tick)", () => {
    const first = shouldFireResearchTick(mon2105(), null);
    expect(first.fire).toBe(true);
    const dateKey = first.fire ? first.dateKey : null;
    const second = shouldFireResearchTick(
      new Date(Date.UTC(2026, 9, 19, 21, 30, 0)),
      dateKey
    );
    expect(second.fire).toBe(false);
    if (!second.fire) expect(second.reason).toBe("already-fired");
  });

  it("fires again the next weekday", () => {
    const tue = shouldFireResearchTick(
      new Date(Date.UTC(2026, 9, 20, 21, 5, 0)),
      "2026-10-19"
    );
    expect(tue.fire).toBe(true);
  });

  it("a stale marker from a previous day does not block today", () => {
    const d = shouldFireResearchTick(mon2105(), "2026-10-16");
    expect(d.fire).toBe(true);
  });

  it("the fire hour is one declaration: the research config (#6030)", () => {
    expect(DEFAULT_RESEARCH_JOB_CONFIG.scheduleUtcHour).toBe(21);
  });
});
