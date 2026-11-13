/**
 * Issue #4352 (parent #4348, epic #4329) — the ticker push is schedulable.
 *
 * Owner ask: "Ticker push must be schedulable just like any other job." The
 * feed is a live record (ADR 0029 D-0), so the slice makes its THREE facts —
 * paused, cadence, armed — real: the agent reads the record before arming, the
 * route reaches the agent by id, and the row offers the controls.
 *
 * Pins:
 *  - 4352-P01 pause cancels the schedule and records the decision; a paused feed
 *    is never re-armed by a start, a connection, or a push.
 *  - 4352-P02 resume clears the pause and arms again.
 *  - 4352-P03 the cadence is an operator fact: a set interval is armed and
 *    recorded, and a value below the floor is refused by name.
 *  - 4352-P04 the record carries the pause (state paused) and its definition
 *    keeps the cadence and the pause across later writes.
 *  - 4352-P05 the route reaches the feed by its record id; deleting a live
 *    feed stops it (#4389 made Delete one of the five controls).
 *  - 4352-P06 the row offers the same button set as every other row (issue
 *    #4389 finished the parity: Edit · Details · Trigger Now · Pause/Resume ·
 *    Delete) and keeps its health badge.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TICKER_PUSH_MIN_INTERVAL_SECONDS, TickerAgent } from "../src/agents/ticker-agent";
import {
  TICKER_PUSH_RECORD_ID,
  tickerPushScheduleToRecord,
} from "../src/services/unifiedScheduleManagement";
import { MockSqlStorage } from "./mock-sql";

function source(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

interface Recorded {
  intervals: number[];
  cancels: string[];
}

/** The ticker-test idiom (tests/schedule-3121-4237-ticker-push.test.ts). */
function bareAgent(sql: MockSqlStorage): { agent: any; seen: Recorded } {
  const seen: Recorded = { intervals: [], cancels: [] };
  const agent = Object.create(TickerAgent.prototype);
  agent.env = {};
  agent.ctx = { storage: { sql } };
  agent.scheduleEvery = async (secs: number, cb: string) => {
    seen.intervals.push(secs);
    return { id: `sched-${seen.intervals.length}`, callback: cb };
  };
  agent.listSchedules = async () => [{ id: "sched-old", callback: "pushTicks" }];
  agent.cancelSchedule = async (id: string) => {
    seen.cancels.push(id);
    return true;
  };
  // One listener is connected, so a start would arm an unpaused feed.
  agent.getConnections = () => [{ id: "c1" }];
  return { agent, seen };
}

describe("4352-P01 pause is recorded and survives a start", () => {
  it("cancels the schedule, records the pause, and never re-arms", async () => {
    const { agent, seen } = bareAgent(new MockSqlStorage());
    await agent.pauseTickerPush();
    expect(seen.cancels).toContain("sched-old");
    const record = await agent.getTickerPushRecord();
    expect(record?.state).toBe("paused");
    expect(record?.definition.paused).toBe(true);
    expect(record?.definition.armed).toBe(false);

    // A start with a live listener asks to arm; the pause wins.
    const before = seen.intervals.length;
    await agent.onStart();
    expect(seen.intervals.length).toBe(before);
    expect((await agent.getTickerPushRecord())?.state).toBe("paused");
  });
});

describe("4352-P02 resume arms again", () => {
  it("clears the pause and arms the feed", async () => {
    const { agent, seen } = bareAgent(new MockSqlStorage());
    await agent.pauseTickerPush();
    const before = seen.intervals.length;
    await agent.resumeTickerPush();
    expect(seen.intervals.length).toBe(before + 1);
    const record = await agent.getTickerPushRecord();
    expect(record?.state).toBe("active");
    expect(record?.definition.paused).toBe(false);
  });
});

describe("4352-P03 the cadence is an operator fact", () => {
  it("arms the interval the operator sets and records it", async () => {
    const { agent, seen } = bareAgent(new MockSqlStorage());
    const applied = await agent.setTickerPushInterval(900);
    expect(applied).toEqual({ ok: true, intervalSeconds: 900 });
    expect(seen.intervals.at(-1)).toBe(900);
    expect((await agent.getTickerPushRecord())?.definition.intervalSeconds).toBe(900);
  });

  it("refuses a cadence below the floor, by name", async () => {
    const { agent } = bareAgent(new MockSqlStorage());
    await expect(agent.setTickerPushInterval(TICKER_PUSH_MIN_INTERVAL_SECONDS - 1)).rejects.toThrow(
      /at least 5 seconds/,
    );
    await expect(agent.setTickerPushInterval(Number.NaN)).rejects.toThrow(/at least 5 seconds/);
  });
});

describe("4352-P04 the record carries both facts", () => {
  it("state and definition agree, and a later write keeps them", () => {
    const first = tickerPushScheduleToRecord(
      { intervalSeconds: 900, armed: false, paused: true },
      "2026-11-13T12:00:00.000Z",
    );
    expect(first.state).toBe("paused");
    expect(first.definition.paused).toBe(true);
    const later = tickerPushScheduleToRecord(
      { intervalSeconds: 900, armed: true, lastPushAt: "2026-11-13T12:05:00.000Z" },
      "2026-11-13T12:05:00.000Z",
      first,
    );
    // A push never clears a pause on its own; only a resume does.
    expect(later.state).toBe("paused");
    expect(later.definition.paused).toBe(true);
    expect(later.definition.intervalSeconds).toBe(900);
  });
});

describe("4352-P05 the route reaches the feed by id", () => {
  const route = source("src/agents/routes/schedules.ts");

  it("branches pause / resume / cadence on the feed's record id", () => {
    expect(route).toContain("scheduleId === TICKER_PUSH_RECORD_ID");
    expect(route).toContain("pauseTickerPush()");
    expect(route).toContain("resumeTickerPush()");
    expect(route).toContain("setTickerPushInterval(seconds)");
    expect(route).toContain("TICKER_PUSH_RECORD_ID");
  });

  it("deleting a live feed stops it (the row's dialog says so)", () => {
    // Issue #4389 — Delete is every row's control; on a feed it is the only
    // destructive thing there is: cancel the push.
    expect(route).toContain("await tickerPushStub().pauseTickerPush();");
    expect(route).toContain("return Response.json({ scheduleId, cancelled: true });");
  });
});

describe("4352-P06 the row offers the controls", () => {
  const panel = source("src/client/SchedulesPanel.tsx");

  it("offers the one button set, and keeps the health badge", () => {
    // Issue #4389 — one action cell for every kind: the feed is not a special
    // case any more, and the health badge lives in the Schedule cell.
    const actions = panel.slice(panel.indexOf('key: "actions"'));
    for (const label of ["Edit", "Details", "Trigger Now", "Delete"]) {
      expect(actions).toMatch(new RegExp(`>\\s*${label}\\s*<`));
    }
    expect(actions).toContain('{s.paused ? "Resume" : "Pause"}');
    // The feed's health badge stays on the row, in the Schedule cell.
    const scheduleCell = panel.slice(panel.indexOf('key: "schedule"'), panel.indexOf('key: "id"'));
    expect(scheduleCell).toContain("Missed push");
  });

  it("the feed's id is the record id the route branches on", () => {
    expect(TICKER_PUSH_RECORD_ID).toBe("ticker-push");
  });
});
