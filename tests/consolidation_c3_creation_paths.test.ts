/**
 * Consolidation C3 (issue #1277, epic #1151) — one scheduling
 * capability: the creation-path enumeration pin required by the
 * epic's C3 acceptance ("a pin test enumerates all screen-schedule
 * creation paths").
 *
 * The claim under test: every screen-scheduling creation path writes
 * through the one schedule store with payloads built by the one
 * shared builder (buildSchedulePayload, src/trading/screeningSchemas):
 *
 *   1. REST create route        src/agents/routes/schedules.ts
 *   2. NLQ executor             src/agents/nlq/execution.ts (via the
 *                               scheduling port in nlqPorts.ts)
 *   3. UI (ScheduledOptionsManager / StrategyDiscoveryPanel) — via
 *      the REST create route; no client-side arming exists.
 *   4. PUT update path          src/services/scheduleManagement.ts
 *      (resolveScheduleUpdate re-validates through the builder)
 *   5. Strategy-scan baseline   src/agents/orchestrator/
 *      arm                        scheduleMaintenance.ts (#1277:
 *                               routed through the builder — it
 *                               previously hand-built its payload)
 *   6. Trigger routes (run-now, NOT creation) validate through the
 *      builder with applyCreationDefaults: false.
 *
 * The pin enumerates every `.schedule(` / `.scheduleEvery(` call
 * site in src/ by file with its role. A new arming site anywhere
 * fails this test until it is enumerated here and, if it arms a
 * screening callback, routed through the builder.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildSchedulePayload } from "../src/trading/screeningSchemas";
import {
  ensureStrategyScanSchedule,
  type ScheduleMaintenanceContext,
} from "../src/agents/orchestrator/scheduleMaintenance";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const ARMING_PATTERN = /\.(schedule|scheduleEvery)\s*\(/;

/** Post-C3 enumeration: file → number of arming call sites + role. */
const ARMING_SITES: Record<string, { count: number; role: string }> = {
  "src/agents/orchestrator.ts": {
    count: 11,
    role: "context binding arrows for the extracted modules + the stale-task sweep arm (non-screening) + the #2681 migration re-arm pass-throughs (schedule/scheduleEvery bound into the migration context; actual arming happens in routes/orchestratorMigration.ts, not inline)",
  },
  "src/agents/routes/orchestratorMigration.ts": {
    count: 3,
    role: "migration re-arm: re-arms exported schedules on the target instance from the migration payload (#2681)",
  },
  "src/agents/routes/schedules.ts": {
    count: 7,
    role: "the schedule store's own arming helpers (create route + resume/update re-arm); payloads arrive builder-validated",
  },
  "src/agents/nlq/execution.ts": {
    count: 4,
    role: "NLQ executor arming via the scheduling port; payloads built by buildSchedulePayload",
  },
  "src/agents/orchestrator/nlqPorts.ts": {
    count: 2,
    role: "NLQ scheduling port bindings onto the agent's SDK schedule methods",
  },
  "src/agents/orchestrator/asyncJobs.ts": {
    count: 3,
    role: "async-job substrate arming executeAsyncJob (submit, recovery, not-before re-arm) — job execution, not schedule creation",
  },
  "src/agents/orchestrator/scheduleMaintenance.ts": {
    count: 1,
    role: "strategy-scan baseline arm; payload built by buildSchedulePayload (#1277)",
  },
  "src/agents/routes/etradeBrokerOrders.ts": {
    count: 1,
    role: "order-draft expiry arm (expireStaleOrderDraft — not a screening schedule)",
  },
  "src/actors/cfAgentsAdapter.ts": {
    count: 2,
    role: "actor schedule port bindings onto the agent's SDK schedule methods (delegation, not arming — #1738)",
  },
  "src/agents/ticker-agent.ts": {
    count: 1,
    role: "ticker tick-push arm (pushTicks every 5s — quote streaming, not a screening schedule; no builder payload — #2230)",
  },
};

describe("screen-schedule creation paths — enumeration pin", () => {
  it("enumerates every schedule-arming call site in src/", () => {
    const found: Record<string, number> = {};
    for (const file of walk("src")) {
      const rel = file.replace(/\\/g, "/");
      const count = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => ARMING_PATTERN.test(line)).length;
      if (count > 0) found[rel] = count;
    }
    const expected: Record<string, number> = {};
    for (const [file, site] of Object.entries(ARMING_SITES)) expected[file] = site.count;
    expect(found).toEqual(expected);
  });

  it("every screening creation/validation path routes through buildSchedulePayload", () => {
    for (const file of [
      "src/agents/routes/schedules.ts",
      "src/agents/nlq/execution.ts",
      "src/services/scheduleManagement.ts",
      "src/agents/orchestrator/scheduleMaintenance.ts",
    ]) {
      expect(readFileSync(file, "utf8")).toContain("buildSchedulePayload");
    }
  });

  it("the three trigger routes are run-now paths validated by the builder (not creation paths)", () => {
    const src = readFileSync("src/agents/routes/schedules.ts", "utf8");
    const occurrences = src.split("applyCreationDefaults: false").length - 1;
    expect(occurrences).toBe(3);
  });

  it("the ScheduledAgent substrate stays out of the screening schedule store (delineation, #1236/#1224)", () => {
    const src = readFileSync("src/agents/scheduled-agent.ts", "utf8");
    expect(ARMING_PATTERN.test(src)).toBe(false);
    expect(src).toContain("NOT a screening scheduler");
  });
});

describe("ensureStrategyScanSchedule — baseline arm through the builder", () => {
  it("arms the payload buildSchedulePayload produces for the baseline criteria", async () => {
    const armed: Array<{ when: unknown; callback: string; payload: unknown; options: unknown }> = [];
    const throwingSql = {
      exec: () => {
        throw new Error("paused store unavailable in this harness");
      },
    };
    const ctx = {
      agentCtx: { storage: { sql: throwingSql } },
      listSchedules: async () => [],
      cancelSchedule: async () => true,
      schedule: async (when: unknown, callback: string, payload?: unknown, options?: unknown) => {
        armed.push({ when, callback, payload, options });
        return {};
      },
      audit: () => {},
      screenerExecutionContextKey: "k",
      legacyScheduleMigrationKey: "m",
      strategyScanCron: "0 * * * *",
    } as unknown as ScheduleMaintenanceContext;

    await ensureStrategyScanSchedule(ctx, { userLogin: "alice", environment: "PROD" });

    expect(armed).toHaveLength(1);
    expect(armed[0].callback).toBe("autonomousOptionsAnalysis");
    expect(armed[0].when).toBe("0 * * * *");
    const expected = buildSchedulePayload(
      "autonomousOptionsAnalysis",
      { universe: "NASDAQ100" },
      { userLogin: "alice", environment: "PROD", trigger: "scheduled" },
    );
    expect(expected.ok).toBe(true);
    if (expected.ok) {
      // The armed record is the builder's record — including the
      // creation-default maxItems stamp the service would otherwise
      // apply itself at run time (same UNIVERSES default).
      expect(armed[0].payload).toEqual(expected.value);
      expect((armed[0].payload as { maxItems?: number }).maxItems).toBeGreaterThan(0);
    }
  });

  it("does not re-arm when a scan schedule already exists for the user", async () => {
    let scheduleCalls = 0;
    const ctx = {
      agentCtx: { storage: { sql: { exec: () => [] } } },
      listSchedules: async () => [
        { callback: "autonomousOptionsAnalysis", payload: { userLogin: "alice" } },
      ],
      cancelSchedule: async () => true,
      schedule: async () => {
        scheduleCalls++;
        return {};
      },
      audit: () => {},
      screenerExecutionContextKey: "k",
      legacyScheduleMigrationKey: "m",
      strategyScanCron: "0 * * * *",
    } as unknown as ScheduleMaintenanceContext;
    await ensureStrategyScanSchedule(ctx, { userLogin: "alice", environment: "PROD" });
    expect(scheduleCalls).toBe(0);
  });
});
