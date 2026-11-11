/**
 * Issue Qunsultant/cfagent#488 — schedule model unification questions (#457).
 *
 * Red-first tests for src/services/scheduleSystems.ts: the inventory of
 * the three schedule systems must track the live sources, so drift in
 * any of them fails here instead of silently re-confusing the two
 * schedule models (Orchestrator durable schedules vs ScheduledAgent
 * goals) that #457 documented.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREATABLE_SCHEDULE_CALLBACKS_INVENTORY,
  SCHEDULE_SYSTEMS,
  SCHEDULE_UNIFICATION_ANSWERS,
  SCHEDULE_UNIFICATION_CARRIED,
  SCHEDULED_GOAL_IDS_INVENTORY,
  WORKER_CRON_TRIGGERS_INVENTORY,
} from "../src/services/scheduleSystems";

const root = join(__dirname, "..");

function block(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("schedule systems inventory", () => {
  it("names exactly the three schedule systems, with distinct ids", () => {
    expect(SCHEDULE_SYSTEMS.map((s) => s.id)).toEqual([
      "orchestrator-durable-schedules",
      "scheduled-agent-goals",
      "worker-cron-triggers",
    ]);
    for (const system of SCHEDULE_SYSTEMS) {
      expect(system.owner).toBeTruthy();
      expect(system.storage).toBeTruthy();
      expect(system.creation).toBeTruthy();
      expect(system.execution).toBeTruthy();
    }
  });

  it("tracks CREATABLE_SCHEDULE_CALLBACKS in src/agents/orchestrator.ts", () => {
    // #2942: the definition moved to orchestrator/scheduleCallbacks.ts (re-exported from orchestrator.ts).
    const orchestrator = readFileSync(join(root, "src", "agents", "orchestrator", "scheduleCallbacks.ts"), "utf8");
    const slice = block(
      orchestrator,
      "export const CREATABLE_SCHEDULE_CALLBACKS = [",
      "] as const"
    );
    const live = [...slice.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(CREATABLE_SCHEDULE_CALLBACKS_INVENTORY).toEqual(live);
  });

  it("tracks DEFAULT_SCHEDULES ids in src/schedule.ts", () => {
    const schedule = readFileSync(join(root, "src", "schedule.ts"), "utf8");
    const slice = block(schedule, "export const DEFAULT_SCHEDULES", "\n];");
    const live = [...slice.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
    expect(SCHEDULED_GOAL_IDS_INVENTORY).toEqual(live);
  });

  it("declares no cron trigger in wrangler.jsonc (#4112 owner direction)", () => {
    const wrangler = readFileSync(join(root, "wrangler.jsonc"), "utf8");
    // Comment lines are not entries: the block survives only as a comment.
    const active = wrangler
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(active).not.toContain('"crons"');
    expect(active).not.toContain('"triggers"');
    // The inventory stays: it is the code's dispatch table, kept for re-enable.
    expect(WORKER_CRON_TRIGGERS_INVENTORY.length).toBeGreaterThan(0);
  });

  it("answers the unification questions with evidence, and carries the rest with an owner", () => {
    expect(SCHEDULE_UNIFICATION_ANSWERS.length).toBeGreaterThan(0);
    for (const answer of SCHEDULE_UNIFICATION_ANSWERS) {
      expect(answer.question).toBeTruthy();
      expect(answer.answer).toBeTruthy();
      expect(answer.evidence).toBeTruthy();
    }
    for (const carried of SCHEDULE_UNIFICATION_CARRIED) {
      expect(carried.question).toBeTruthy();
      expect(carried.owner).toBeTruthy();
      expect(carried.reason).toBeTruthy();
    }
    // The carried questions must not also be claimed answered.
    const answered = new Set(SCHEDULE_UNIFICATION_ANSWERS.map((a) => a.question));
    for (const carried of SCHEDULE_UNIFICATION_CARRIED) {
      expect(answered.has(carried.question)).toBe(false);
    }
  });
});
