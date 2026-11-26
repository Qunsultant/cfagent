/**
 * Issue #6503 — the Recreate-registered schedule seeds agree with
 * their automatic paths.
 *
 * The six system schedules + nine built-in goals are seeded twice:
 * automatically (the onStart reconcile / the goals re-seed) and
 * from the catalogued `seed.d1.unified_schedules.*` entries
 * (Recreate phase 3). The five system seeds are Recreate steps
 * only — they are NOT migration-applied (#6503 step 7: a fresh
 * store starts empty; the reconcile seeds them), while the goals
 * seed IS migration-applied (migration 0092). This test is the
 * guard against the two copies drifting: the seed SQL must carry
 * exactly the rows the automatic paths would write.
 *
 * - The goals seed's nine definitions are exactly
 *   `config/builtin-scheduled-goals.json` (id, cron, operation,
 *   enabled → state, whole object as the definition).
 * - The five schedule seeds are exactly `systemScheduleSeedSpecs`
 *   minus the ledger sweep (kind `internal`, created paused on the
 *   monthly interval 2,592,000s, live callback, system provenance).
 * - There is deliberately NO seed entry for
 *   `sweep-stale-ledger-tasks`: its row is per-user and the handler
 *   skips with no owner, so a payload-less catalogue row would be
 *   dead and would block the reconcile's per-user seeding.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  D1_CATALOGUE_ENTRIES,
  D1_MIGRATION_CODES,
} from "../src/data/schemaComponent/d1Catalogue";
import {
  planForLeg,
  resolveRecreatePlan,
  selectSteps,
} from "../src/data/schemaComponent/recreateRunner";
import { emptySchemaModel } from "../src/data/schemaComponent/equalityHarness";

const SEED_LITERAL_TS = "2026-11-25T00:00:00.000Z";
const MONTHLY_SECONDS = 2592000;

const GOALS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "config",
  "builtin-scheduled-goals.json",
);

function seedEntry(code: string) {
  const entry = D1_CATALOGUE_ENTRIES.find((e) => e.code === code);
  expect(entry).toBeDefined();
  expect(entry!.kind).toBe("seed");
  expect(entry!.form).toBe("literal");
  expect(entry!.statement.startsWith("INSERT OR IGNORE")).toBe(true);
  return entry!;
}

/** One VALUES tuple of the goals seed, in column order. */
const GOAL_TUPLE =
  /\('([^']*)', 'goal', '([^']*)', NULL, '([^']*)', '(\{[^']*\})', NULL, NULL, NULL, NULL, '([^']*)', '([^']*)'\)/g;
/** One VALUES tuple of a system-schedule seed, in column order. */
const SCHEDULE_TUPLE =
  /\('([^']*)', 'internal', 'paused', '([^']*)', NULL, '(\{[^']*\})', NULL, '(\{[^']*\})', NULL, '([^']*)', '([^']*)', '([^']*)'\)/g;

describe("schedule seeds agree with their automatic paths (#6503)", () => {
  it("the goals seed carries exactly config/builtin-scheduled-goals.json", () => {
    const goals = JSON.parse(readFileSync(GOALS_PATH, "utf8")) as Array<
      Record<string, unknown>
    >;
    expect(goals).toHaveLength(9);
    const entry = seedEntry("seed.d1.unified_schedules.insert_builtin_goals");
    const rows = [...entry.statement.matchAll(GOAL_TUPLE)].map((m) => ({
      id: m[1],
      state: m[2],
      operation: m[3],
      definition: JSON.parse(m[4]) as Record<string, unknown>,
      createdAt: m[5],
      updatedAt: m[6],
    }));
    expect(rows).toHaveLength(9);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const goal of goals) {
      const row = byId.get(goal.id as string);
      expect(row).toBeDefined();
      // State follows `enabled`, exactly as `goalToRecord` writes it.
      expect(row!.state).toBe(goal.enabled === true ? "active" : "paused");
      expect(row!.operation).toBe(goal.operation);
      // The definition is the whole goal object, verbatim.
      expect(row!.definition).toEqual(goal);
      // `goalToRecord` never sets pausedAt; the seed mirrors that
      // (the tuple regex only matches when paused_at is NULL).
      expect(row!.createdAt).toBe(SEED_LITERAL_TS);
      expect(row!.updatedAt).toBe(SEED_LITERAL_TS);
    }
  });

  it("the five schedule seeds carry exactly the reconcile specs", () => {
    const expected: Array<{ id: string; callback: string }> = [
      { id: "token-renewal", callback: "autoRenewETradeTokens" },
      { id: "retention", callback: "retention" },
      { id: "nightly-research", callback: "runResearchSchedule" },
      { id: "sweep-stale-async-jobs", callback: "sweepStaleAsyncJobs" },
      { id: "schedule-watchdog", callback: "watchdogMissedSchedules" },
    ];
    for (const { id, callback } of expected) {
      const entry = seedEntry(
        `seed.d1.unified_schedules.insert_${id.replaceAll("-", "_")}`,
      );
      const rows = [...entry.statement.matchAll(SCHEDULE_TUPLE)];
      expect(rows).toHaveLength(1);
      const m = rows[0];
      expect(m[1]).toBe(id);
      expect(m[2]).toBe(callback);
      expect(JSON.parse(m[3])).toEqual({
        type: "interval",
        intervalSeconds: MONTHLY_SECONDS,
        callback,
      });
      expect(JSON.parse(m[4])).toEqual({
        origin: "system",
        createdBy: "system",
        reason: id,
        createdAt: SEED_LITERAL_TS,
      });
      expect(m[5]).toBe(SEED_LITERAL_TS);
      expect(m[6]).toBe(SEED_LITERAL_TS);
      expect(m[7]).toBe(SEED_LITERAL_TS);
    }
  });

  it("there is no seed entry for the per-user ledger sweep", () => {
    const codes = D1_CATALOGUE_ENTRIES.map((e) => e.code);
    expect(codes.filter((c) => c.includes("sweep-stale-ledger"))).toEqual([]);
    expect(
      D1_CATALOGUE_ENTRIES.filter((e) =>
        e.statement.includes("sweep-stale-ledger-tasks"),
      ),
    ).toEqual([]);
  });

  it("migration 0092 carries the schema entries then the goals seed, in order", () => {
    // Issue #6503 step 7 — the five system seeds are Recreate
    // steps, not migration-applied: a fresh store starts empty and
    // the onStart reconcile seeds them, so the migration applies
    // the schema plus the goals seed only.
    expect(D1_MIGRATION_CODES[92]).toEqual([
      "schema.d1.unified_schedules.create_table",
      "schema.d1.unified_schedules.create_index_unified_schedules_kind_idx",
      "schema.d1.unified_schedules.create_index_unified_schedules_state_idx",
      "schema.d1.unified_schedules.create_index_unified_schedules_created_idx",
      "seed.d1.unified_schedules.insert_builtin_goals",
    ]);
  });

  it("on a fresh store the Recreate selection picks the table creation and all six seeds", () => {
    // This is the registration proof: the seeds run through the
    // Recreate flow when the table is being built. (On a healthy
    // store they are skipped as "present" — the #6538 selection
    // rule — which the recreate suite pins via its stub world.)
    const plan = planForLeg(resolveRecreatePlan(), "d1");
    const { schema, seeds } = selectSteps(plan, emptySchemaModel());
    expect(schema.map((s) => s.code)).toContain(
      "schema.d1.unified_schedules.create_table",
    );
    const seedCodes = seeds.map((s) => s.code);
    for (const code of [
      "seed.d1.unified_schedules.insert_token_renewal",
      "seed.d1.unified_schedules.insert_retention",
      "seed.d1.unified_schedules.insert_nightly_research",
      "seed.d1.unified_schedules.insert_sweep_stale_async_jobs",
      "seed.d1.unified_schedules.insert_schedule_watchdog",
      "seed.d1.unified_schedules.insert_builtin_goals",
    ]) {
      expect(seedCodes).toContain(code);
    }
  });
});
