/**
 * Issue #3788 (parent incident #3781) — the durable-schedule watchdog
 * sweep. The sibling of #3784's stale-async-job sweep, armed the same
 * way (OrchestratorAgent.onStart, 15-minute interval) and sharing its
 * shape: per-row try/catch, exactly-once claims, audit + Slack + ledger
 * on every finding, never a second implementation of the sweep tick or
 * the Slack seam.
 *
 * What it watches: durable schedules (listSchedules) whose callback is
 * in the recorded set (the four creatable callbacks plus the internal
 * callbacks whose methods now record their own runs — see
 * RECORDED_SCHEDULE_CALLBACKS). A schedule whose last callback-run
 * record is older than its expected tick + grace has missed its
 * firing. Schedules whose callback leaves no ledger record are
 * SKIPPED and counted (skippedUnrecorded), never flagged: the watchdog
 * cannot observe them, and a watchdog that cries wolf on unobservable
 * schedules is worse than none. The framework sweeps themselves
 * (sweepStaleAsyncJobs, sweepStaleLedgerTasks, this watchdog) are in
 * that skipped set by construction — since #3121 #4242 their runs DO
 * land in the ledger (the sweeps via the #3394 wrapper, this watchdog
 * via its heartbeat), but keyed by record id, not alarm id, so the
 * watchdog's alarm-id lookup still cannot observe them; the home
 * shows their runs instead. See the durable doc
 * docs/architecture/security/schedule-watchdog-3788.md for the
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
import {
  createJobRunRecordAdapter,
  recordLedgerRunD1,
  resolveLedgerAttribution,
} from "../../data/createJobRunRecordPorts";
import { createD1UnifiedSchedulePorts } from "../../data/createUnifiedSchedulePorts";
import type { SqlStorage } from "../../orm";
import { resolveEffectiveMissedScheduleGrace } from "../../services/scheduleControls";

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
  userLogin?: string;
  jobId?: string;
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
  /** #5157: optional instance owner login for alert attribution. */
  userLogin?: string;
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
  // Issue #6503 step 13 — the grace is a managed setting
  // (`schedule.missedScheduleGraceMinutes`): a managed value wins
  // over the env carrier, which wins over the 60-minute default.
  // ctx.sql is the orchestrator's storage, the same store the
  // schedules-home controls write to, so the managed leg is live
  // here. The ScheduledAgent's own goal watchdog
  // (src/agents/scheduled-agent.ts runScheduleWatchdog) reads the
  // same key from its own storage and cannot see this store, so
  // that path keeps the env/default behavior until the cross-DO
  // mirror follow-up lands.
  const graceMs = resolveEffectiveMissedScheduleGrace(ctx.sql, ctx.env).ms;
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

  // Issue #6101 — the ledger is D1 (the store resolves from the
  // sweep env; the DO `ctx.sql` below stays for the grace managed-
  // setting read only). The attribution carries the instance owner
  // as the run's user when the context names one.
  const ledgerStore = createJobRunRecordAdapter(
    ctx.env as { AGENT_DB?: unknown; IAAA_TENANT_ID?: unknown; PLATFORM_ID?: unknown },
  );
  const ledgerAttribution = resolveLedgerAttribution(
    ctx.env as { AGENT_DB?: unknown; IAAA_TENANT_ID?: unknown; PLATFORM_ID?: unknown },
    ctx.userLogin ? { userId: ctx.userLogin } : {},
  );
  // Issue #6503 (G3) — the stored state behind the alarm list,
  // read once before the loop: a paused (or deleted) row has no
  // expected tick, so the sweep never flags it as missed. The alarm
  // id is the lookup key for the six system rows (keyed by
  // catalogue id, SDK id in alarmId); the record id is the key for
  // screen/stage rows (id == alarm id). An unreadable store
  // examines as before — the sweep's best-effort posture, and the
  // pure finder still skips any row its caller marks paused.
  const pausedById = new Map<string, boolean>();
  try {
    const d1 = (ctx.env as { AGENT_DB?: unknown } | null | undefined)?.AGENT_DB;
    if (d1) {
      const unified = createD1UnifiedSchedulePorts({ d1: d1 as never }).unifiedSchedules;
      for (const record of await unified.list()) {
        if (record.state !== "paused" && record.state !== "deleted") continue;
        pausedById.set(record.id, true);
        if (record.alarmId) pausedById.set(record.alarmId, true);
      }
    }
  } catch {
    // An unreadable store examines as before (see above).
  }
  const result: ScheduleWatchdogSweepResult = { ...empty };
  for (const schedule of schedules) {
    if (typeof schedule.id !== "string" || !schedule.id) continue;
    if (typeof schedule.callback !== "string" || !recorded.has(schedule.callback)) {
      result.skippedUnrecorded++;
      continue;
    }
    // Issue #6503 (G3) — a paused row is not examined at all (the
    // goals consumer's `if (!goal.enabled) continue` mirror): it
    // has no expected tick, so there is nothing to miss.
    if (pausedById.get(schedule.id) === true) continue;
    result.examined++;
    try {
      let latestRun: { started: string } | undefined;
      try {
        latestRun = ledgerStore
          ? await ledgerStore.latestByJob(schedule.id)
          : undefined;
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
        // Issue #6101 — the claim-first write lands in D1; the
        // derived identity makes a retry a no-op, so the exactly-
        // once claim holds. An unbound D1 throws the named error
        // and the row alerts nothing this tick, as before.
        if (!ledgerStore) {
          throw new Error(
            "[run-ledger] D1 run-ledger binding unbound (AGENT_DB) (#6101).",
          );
        }
        await recordLedgerRunD1(
          ledgerStore,
          {
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
          },
          ledgerAttribution,
        );
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
        ...(ctx.userLogin ? { userLogin: ctx.userLogin } : {}),
      });
      if (typeof ctx.notifyMissedSchedule === "function") {
        const info: MissedScheduleAlertInfo = {
          scheduleId: schedule.id,
          callback: schedule.callback,
          expectedTick: finding.expectedTickIso ?? "",
          lastRun: finding.lastRunIso ?? null,
          graceMs,
          ...(ctx.userLogin ? { userLogin: ctx.userLogin } : {}),
          jobId: schedule.id,
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
    // Issue #6101 — the heartbeat lands in D1 like the claim.
    if (!ledgerStore) {
      throw new Error(
        "[run-ledger] D1 run-ledger binding unbound (AGENT_DB) (#6101).",
      );
    }
    await recordLedgerRunD1(
      ledgerStore,
      {
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
      },
      ledgerAttribution,
    );
  } catch {
    // Best-effort heartbeat.
  }
  return result;
}

export function formatMissedScheduleAlertDetail(info: MissedScheduleAlertInfo): string {
  const callbackPart = info.callback ? ` | callback: ${info.callback}` : "";
  const ownerPart = info.userLogin ? ` | user: ${info.userLogin}` : "";
  return `missed-fire: expected ${info.expectedTick} (last run: ${info.lastRun ?? "never"})${callbackPart}${ownerPart}`;
}
