/**
 * Issue #3788 (parent incident #3781) — the durable-schedule watchdog
 * sweep. The sibling of #3784's stale-async-job sweep, armed the same
 * way (OrchestratorAgent.onStart, 15-minute interval) and sharing its
 * shape: per-row try/catch, exactly-once claims, audit + Slack + ledger
 * on every finding, never a second implementation of the sweep tick or
 * the Slack seam.
 *
 * What it watches: durable schedules (listSchedules) whose callback is
 * in the recorded set (the four creatable callbacks plus the four
 * internal callbacks whose methods now record their own runs — see
 * RECORDED_SCHEDULE_CALLBACKS). A schedule whose last callback-run
 * record is older than its expected tick + grace has missed its
 * firing. Schedules whose callback leaves no ledger record are
 * SKIPPED and counted (skippedUnrecorded), never flagged: the watchdog
 * cannot observe them, and a watchdog that cries wolf on unobservable
 * schedules is worse than none. The framework sweeps themselves
 * (sweepStaleAsyncJobs, sweepStaleLedgerTasks, this watchdog) are in
 * that skipped set by construction — their firing is observable via
 * their own effects (rows transitioned, tasks closed, heartbeat rows)
 * and the watchdog's heartbeat covers the tick path. See the durable
 * doc docs/architecture/security/schedule-watchdog-3788.md for the
 * per-firing-type coverage table.
 *
 * Exactly-once: the missed-fire ledger record IS the claim. It is
 * written first (claim-first, the #2567 precedent): its started time
 * is the sweep tick, after the expected tick, so the next sweep reads
 * a run at/after the tick and stays silent. A sweep that cannot write
 * the claim alerts nothing for that row this tick and retries on the
 * next one. The audit event (schedule.missed_fire, code missed_fire)
 * and the Slack delivery (notifyMissedSchedule hook, the #2567 seam)
 * follow the claim; a delivery failure is audited by the hook and
 * never re-opens the claim.
 *
 * The heartbeat: one ledger row per sweep (job
 * schedule-watchdog-heartbeat, outcome success, examined/missed/
 * skippedUnrecorded counts). No heartbeat in 24h means the sweep tick
 * path itself is dead. A grace of 0 disables the watchdog entirely:
 * no findings, no heartbeat.
 */
import { SqlJobRunRecordStore } from "../../data/doSqliteJobRunRecordAdapter";
import type { SqlStorage } from "../../orm";
import { resolveMissedScheduleGraceMs } from "../../config/missedScheduleAlert";
import { recordLedgerRun } from "../../services/unifiedLedger";
import {
  findMissedDurableSchedule,
  missedFiringDetail,
  SCHEDULE_WATCHDOG_FIRST_SEEN_KEY,
  SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID,
  type DurableScheduleShape,
} from "../../services/scheduleWatchdog";

export type ScheduleWatchdogSchedule = DurableScheduleShape;

/** What the Slack hook receives for one missed firing. */
export interface MissedScheduleAlertInfo {
  scheduleId: string;
  callback: string;
  expectedTick: string;
  lastRun: string | null;
  graceMs: number;
}

export interface ScheduleWatchdogSweepResult {
  examined: number;
  alerted: number;
  missed: number;
  skippedUnrecorded: number;
}

export interface ScheduleWatchdogContext {
  env: Record<string, unknown>;
  sql: SqlStorage;
  /** Agent storage for the first-seen map (get/put of one key). */
  storage: {
    get: (key: string) => Promise<unknown>;
    put: (key: string, value: unknown) => Promise<void>;
  };
  listSchedules: () => Promise<ScheduleWatchdogSchedule[]>;
  audit: (type: string, agent: "orchestrator", payload: Record<string, unknown>) => void;
  /** Slack delivery hook (the #2567 seam); absent = audit + ledger only. */
  notifyMissedSchedule?: (info: MissedScheduleAlertInfo) => Promise<void>;
}

export interface ScheduleWatchdogOptions {
  /** Callbacks with a per-run ledger record (the watchable set). */
  recordedCallbacks: readonly string[];
  nowMs?: number;
}

type FirstSeenMap = Record<string, string>;

function readFirstSeen(value: unknown): FirstSeenMap {
  if (!value || typeof value !== "object") return {};
  const out: FirstSeenMap = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

export async function watchdogMissedSchedules(
  ctx: ScheduleWatchdogContext,
  options: ScheduleWatchdogOptions,
): Promise<ScheduleWatchdogSweepResult> {
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const empty: ScheduleWatchdogSweepResult = {
    examined: 0,
    alerted: 0,
    missed: 0,
    skippedUnrecorded: 0,
  };
  const graceMs = resolveMissedScheduleGraceMs(ctx.env as { MISSED_SCHEDULE_GRACE_MINUTES?: string });
  if (graceMs <= 0) return empty;

  const schedules = await ctx.listSchedules().catch(() => [] as ScheduleWatchdogSchedule[]);
  const recorded = new Set(options.recordedCallbacks);

  // First-seen attribution (same rule as the goals watchdog): a
  // schedule first observed after its expected tick is never flagged
  // for that tick. Stamped once per id, pruned to listed schedules.
  let firstSeen: FirstSeenMap = {};
  try {
    firstSeen = readFirstSeen(await ctx.storage.get(SCHEDULE_WATCHDOG_FIRST_SEEN_KEY));
    let changed = false;
    for (const s of schedules) {
      if (typeof s.id === "string" && s.id && !(s.id in firstSeen)) {
        firstSeen[s.id] = nowIso;
        changed = true;
      }
    }
    for (const id of Object.keys(firstSeen)) {
      if (!schedules.some((s) => s.id === id)) {
        delete firstSeen[id];
        changed = true;
      }
    }
    if (changed) await ctx.storage.put(SCHEDULE_WATCHDOG_FIRST_SEEN_KEY, firstSeen);
  } catch {
    // A first-seen failure fails closed to "unseen": no finding can
    // be attributed, but the sweep still runs and heartbeats.
    firstSeen = {};
  }

  const store = new SqlJobRunRecordStore(ctx.sql);
  const result: ScheduleWatchdogSweepResult = { ...empty };
  for (const schedule of schedules) {
    if (typeof schedule.id !== "string" || !schedule.id) continue;
    if (typeof schedule.callback !== "string" || !recorded.has(schedule.callback)) {
      result.skippedUnrecorded++;
      continue;
    }
    result.examined++;
    try {
      let latestRun: { started: string } | undefined;
      try {
        latestRun = store.latestByJob(schedule.id);
      } catch {
        latestRun = undefined;
      }
      const firstSeenAtMs = firstSeen[schedule.id]
        ? Date.parse(firstSeen[schedule.id])
        : undefined;
      const finding = findMissedDurableSchedule({
        schedule,
        latestRun,
        firstSeenAtMs: Number.isFinite(firstSeenAtMs) ? firstSeenAtMs : undefined,
        nowMs,
        graceMs,
      });
      if (!finding) continue;
      // Claim-first: the ledger record is the exactly-once claim.
      // A failed write alerts nothing for this row this tick.
      try {
        recordLedgerRun(store, {
          system: "orchestrator-schedule",
          jobId: schedule.id,
          operation: schedule.callback,
          started: nowIso,
          finished: nowIso,
          outcome: "skipped",
          triggeredBy: "scheduled",
          trigger: "scheduled",
          scheduleId: schedule.id,
          asyncJobId: null,
          workflowId: null,
          detail: missedFiringDetail(schedule.id, finding, schedule.cron),
        });
      } catch {
        continue;
      }
      result.missed++;
      result.alerted++;
      ctx.audit("schedule.missed_fire", "orchestrator", {
        scheduleId: schedule.id,
        callback: schedule.callback,
        code: "missed_fire",
        expectedTick: finding.expectedTickIso,
        lastRun: finding.lastRunIso ?? null,
      });
      if (typeof ctx.notifyMissedSchedule === "function") {
        const info: MissedScheduleAlertInfo = {
          scheduleId: schedule.id,
          callback: schedule.callback,
          expectedTick: finding.expectedTickIso ?? "",
          lastRun: finding.lastRunIso ?? null,
          graceMs,
        };
        void Promise.resolve()
          .then(() => ctx.notifyMissedSchedule!(info))
          .catch(() => {
            // Delivery failures are audited by the hook itself; a
            // throwing hook must never surface on the sweep path.
          });
      }
    } catch {
      // Per-row try/catch (the #3784 sweep shape): one bad row never
      // fails the sweep or its caller.
      continue;
    }
  }

  // Heartbeat: the sweep ran, with examined counts. Best-effort — a
  // failed heartbeat never fails the sweep.
  try {
    recordLedgerRun(store, {
      system: "orchestrator-schedule",
      jobId: SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID,
      operation: "schedule.watchdog_sweep",
      started: nowIso,
      finished: nowIso,
      outcome: "success",
      triggeredBy: "scheduled",
      trigger: "scheduled",
      scheduleId: null,
      asyncJobId: null,
      workflowId: null,
      detail:
        `examined=${result.examined} missed=${result.missed} ` +
        `skippedUnrecorded=${result.skippedUnrecorded}`,
    });
  } catch {
    // Best-effort heartbeat.
  }
  return result;
}
