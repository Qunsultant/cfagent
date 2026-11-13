/**
 * Issue #3026 (follower of #2601) — the alarm-surface inventory.
 *
 * #2601 named the DO-alarm scheduler as seam B and sequenced its
 * narrowing AFTER workflow step retries (#3025), because narrowing the
 * alarm before the event path is proven would remove the working
 * fallback for an unproven one. This module is the part that can land
 * before that ordering is satisfied: a total, classified register of
 * every place this repository touches the Agents SDK framework alarm
 * queue, each entry carrying the gap that keeps it there.
 *
 * The structural claim the pin protects (issue #3026 acceptance 1):
 * NO site on the alarm surface fires a multi-stage chain. The alarm may
 * start one unit; stage advance and retry budgets belong to the
 * stage-runner contract (`planNext`, `resolveStageRetryBudget`). A new
 * site — or a site that starts a second stage — fails the inventory pin
 * until it is dispositioned here.
 *
 * There are no direct `setAlarm` calls in this repository: the alarm is
 * the Agents SDK's own queue row in cf_agents_jobs, paired with the
 * mas_async_jobs record (ADR 0022 D-0, the claim relies on instance
 * serialization). The register therefore keys on the framework tables,
 * which is the surface a reviewer can actually grep.
 */

/** What a site does with the framework alarm/schedule tables. */
export type AlarmSurfaceKind =
  | "framework-alarm-pairing"
  | "framework-queue-index"
  | "framework-queue-maintenance"
  | "agent-schedule"
  | "privacy-export";

export interface AlarmSurfaceEntry {
  /** Repo-relative file that touches the framework queue/schedule tables. */
  file: string;
  kind: AlarmSurfaceKind;
  /** What schedules work here, in one line. */
  what: string;
  /**
   * The named gap that keeps this on the alarm surface instead of
   * Queues or Workflows. Never empty — an undocumented alarm is the
   * drift this register exists to stop.
   */
  documentedGap: string;
  /**
   * True when one fire can start at most one unit — never a chain.
   * A false entry is the failure shape #2601 seam B exists to remove.
   */
  singleShot: boolean;
}

/**
 * Every file on the alarm surface, dispositioned. Ordered by file so a
 * diff that adds one is visible at a glance.
 */
export const ALARM_SURFACE_REGISTER: readonly AlarmSurfaceEntry[] = [
  {
    file: "src/agents/orchestrator.ts",
    kind: "framework-queue-index",
    what: "ensureFrameworkQueueIndexes: creates the seek indexes the re-arm/claim scans rely on (issue #2280).",
    documentedGap:
      "Two single CREATE INDEX statements; DDL only, schedules nothing. Framework queue has no time index otherwise, and the owner (SDK) does not ship one.",
    singleShot: true,
  },
  {
    file: "src/agents/routes/maintenance.ts",
    kind: "framework-queue-maintenance",
    what: "Operator maintenance over the framework queue rows (inspection/cleanup paths).",
    documentedGap:
      "Maintenance only: it reads and prunes existing rows, it never arms a future run. A second-stage trigger here would be the chain-engine shape the inventory forbids.",
    singleShot: true,
  },
  {
    file: "src/agents/routes/schedules.ts",
    kind: "agent-schedule",
    what: "The schedules surface: creates/updates the Agents SDK schedule rows that fire one run each.",
    documentedGap:
      "Free-plan 5-cron ceiling and per-goal exact-time firing stay custom (recorded in #2616 / #2621); reuse step 6 moves this to Agent schedules, and that move is a behaviour change tracked there.",
    singleShot: true,
  },
  {
    file: "src/data/asyncJobPorts.ts",
    kind: "framework-alarm-pairing",
    what: "The mas_async_jobs port family: the record half whose other half is the framework alarm row in cf_agents_jobs (ADR 0022 D-0).",
    documentedGap:
      "The claim's atomicity is instance serialization plus the guarded UPDATE; moving the pairing off the framework queue is ADR 0022's decision to reverse, not a refactor (seam B, #3026).",
    singleShot: true,
  },
  {
    file: "src/data/frameworkQueueIndexSchema.ts",
    kind: "framework-queue-index",
    what: "The framework-queue index array for #2280's seek indexes; the index statements now live in the ORM catalogue (ormCatalogue.ts) and this module only assembles them via ormIndexSql.",
    documentedGap:
      "Schema only; no scheduling. The module documents the queue scans the indexes serve and assembles the index array from the ORM catalogue, where the DDL text has its one home.",
    singleShot: true,
  },
  {
    file: "src/data/schemaComponent/ormCatalogue.ts",
    kind: "framework-queue-index",
    what: "The ORM catalogue's framework-queue index entries: the index statements for cf_agents_jobs (the #2280 seek indexes), moved here from frameworkQueueIndexSchema.ts by #4282 P2a.",
    documentedGap:
      "Schema only; no scheduling. The catalogue is DDL text plus accessors — it executes nothing itself; the index ensure functions call the executor. The framework queue has no time index otherwise, and the owner (SDK) does not ship one.",
    singleShot: true,
  },
  {
    file: "src/privacy/privacyDsar.ts",
    kind: "privacy-export",
    what: "DSAR export/erasure over the framework queue rows owned by a user.",
    documentedGap:
      "Read/delete for a legal obligation; schedules nothing. It must keep seeing these rows, so it stays even after any narrowing.",
    singleShot: true,
  },
  {
    file: "src/services/consolidatedScheduling.ts",
    kind: "framework-queue-index",
    what: "Shared scheduling primitives (#3121 S1): pins the Agents SDK hung-timeout mechanism location (O1) and resolves the consolidated-ledger linkage for alarm firings.",
    documentedGap:
      "Documentation-only reference to the framework jobs table's hung-timeout column: the module names cf_agents_jobs.hung_timeout_seconds to pin where the 30s SDK default lives (O1); it performs no queue I/O, arms nothing, and reads no rows. The reference stays so the mechanism location is greppable from the scheduler core instead of living only in node_modules.",
    singleShot: true,
  },
  {
    file: "src/data/unifiedSchedulePorts.ts",
    kind: "framework-queue-index",
    what: "The one ScheduleStore port (#3121 Phase 2, #3123): the record model + table name for unified_schedules; names cf_agents_jobs only to state the SDK table stays the alarm substrate.",
    documentedGap:
      "Documentation-only reference to the framework jobs table: the module names cf_agents_jobs in its header comment to record that the SDK table stays the alarm substrate (framework-owned, cannot be replaced); it performs no queue I/O, arms nothing, and reads no rows — arming goes through the ScheduleAlarms port (ctx.schedule/scheduleEvery) in the routes. The reference stays so the substrate decision is greppable from the store port.",
    singleShot: true,
  },
];

/** The files the register covers. */
export function filesOnAlarmSurface(
  entries: readonly AlarmSurfaceEntry[] = ALARM_SURFACE_REGISTER,
): string[] {
  return entries.map((entry) => entry.file);
}

/**
 * Assert the register's invariants. Refuses loudly rather than guessing:
 * an empty gap, a non-single-shot entry, a duplicate file, or an empty
 * register is a defect in the inventory, not a runtime condition.
 */
export function assertAlarmInventory(
  entries: readonly AlarmSurfaceEntry[] = ALARM_SURFACE_REGISTER,
): void {
  if (entries.length === 0) {
    throw new Error("Alarm inventory refused: the register is empty (the alarm surface is not nothing).");
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.file.trim()) {
      throw new Error("Alarm inventory refused: an entry carries no file.");
    }
    if (seen.has(entry.file)) {
      throw new Error(`Alarm inventory refused: duplicate file ${entry.file} (one entry per site).`);
    }
    seen.add(entry.file);
    if (!entry.documentedGap || entry.documentedGap.trim().length === 0) {
      throw new Error(
        `Alarm inventory refused: ${entry.file} carries no documented gap — an undocumented alarm is the drift this register prevents.`,
      );
    }
    if (!entry.singleShot) {
      throw new Error(
        `Alarm inventory refused: ${entry.file} can start more than one unit — the alarm surface must never be the chain engine (issue #3026, seam B).`,
      );
    }
  }
}
