/**
 * Issue #3021 — Workflow Runs lifecycle states + schedule provenance.
 *
 * The page surfaces exactly one lifecycle state per run — scheduled /
 * in-progress / done / cancelled — and per-run schedule provenance
 * (mechanism + identity + reason + next firing + delay). The mapping
 * is total: every recorded status, including Cloudflare workflow
 * instance statuses and the unknown fallback, lands in exactly one
 * state, never unclassified. Schedule facts are never invented: a
 * mechanism, identity, or reason the stores do not record is null.
 *
 * Working defaults (NOT Venus rulings — the two pins were proposed
 * 2026-11-03 and remain unruled): failed / skipped sit inside done
 * (success-vs-failure stays visible as the run's outcome within
 * done, not a fifth state), and the unknown fallback maps to
 * in-progress with its raw status still shown on the row.
 */
import type { WorkflowRun, WorkflowRunJobRow } from "./workflowRuns";

export type WorkflowLifecycleState = "scheduled" | "in-progress" | "done" | "cancelled";

export type WorkflowScheduleMechanism =
  | "cron-trigger"
  | "queue"
  | "agent-scheduler"
  | "workflow-binding"
  | "manual"
  | "unknown";

export interface WorkflowRunSchedule {
  mechanism: WorkflowScheduleMechanism;
  /** Schedule id, cron expression, or delay — null when unrecorded. */
  identity: string | null;
  /** Why this mechanism was chosen — recorded at creation, else null. */
  reason: string | null;
  /** Next firing for schedule rows (ISO), null when not computable. */
  nextFiringAt: string | null;
  /** Queue delay in seconds (configured delay), null when not a delay. */
  delaySeconds: number | null;
}

/**
 * Roll the recorded status vocabulary — run statuses, Cloudflare
 * workflow instance statuses (mapInstanceStatus), and stage
 * transition statuses — onto the four lifecycle states. Total by
 * construction: anything unrecognized is in-progress (visible, never
 * dropped), and the raw status stays on the row for inspection.
 */
export function lifecycleStateForRunStatus(status: string): WorkflowLifecycleState {
  switch ((status ?? "").trim()) {
    case "cancelled":
    case "terminated":
      return "cancelled";
    case "completed":
    case "partial":
    case "failed":
    case "skipped":
    case "complete":
    case "errored":
      return "done";
    case "queued":
    case "running":
    case "awaiting":
    case "held":
    case "paused":
    case "waiting":
    case "waitingForPause":
    case "unknown":
    default:
      return "in-progress";
  }
}

/**
 * A run's lifecycle state. A run whose stages are all cancelled is
 * cancelled even when its status verb is unknown — the recorded
 * cancellation wins over the verb. Otherwise the status mapping
 * decides.
 */
export function lifecycleStateForRun(run: {
  status: string;
  stages: Array<{ status: string }>;
}): WorkflowLifecycleState {
  if (run.status === "cancelled" || run.status === "terminated") return "cancelled";
  if (
    run.stages.length > 0 &&
    run.stages.every((s) => s.status === "cancelled" || s.status === "terminated")
  ) {
    return "cancelled";
  }
  return lifecycleStateForRunStatus(run.status);
}

function parseObject(text: unknown): Record<string, any> | null {
  if (typeof text !== "string" || !text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function msOf(value: unknown): number | null {
  const text = str(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Derive a job-chain run's schedule provenance from its jobs and its
 * computed trigger. Precedence is the scheduling fact, not the
 * trigger label:
 *  1. a queued job with a future not_before is delayed queue work;
 *  2. a command carrying a workflow-binding marker is binding work;
 *  3. a job carrying a schedule id / name / cron is agent-scheduler
 *     work (the SDK schedule that armed it — including Trigger-Now
 *     dispatches of that schedule, whose trigger reads manual);
 *  4. a scheduled trigger with no schedule evidence is a Worker cron
 *     trigger (the DO tick and its dispatches carry no schedule id);
 *  5. manual / autonomous-without-evidence fall through to manual /
 *     cron-trigger / unknown without inventing an identity.
 */
export function scheduleProvenanceForJobs(
  jobs: WorkflowRunJobRow[],
  trigger: string,
  nowMs: number,
): WorkflowRunSchedule | null {
  if (jobs.length === 0) return null;

  for (const job of jobs) {
    const notBefore = msOf(job.not_before);
    if (job.status === "queued" && notBefore !== null && notBefore > nowMs) {
      const created = msOf(job.created_at);
      const delaySeconds = created !== null ? Math.round((notBefore - created) / 1000) : null;
      return {
        mechanism: "queue",
        identity: delaySeconds !== null ? `delay ${delaySeconds}s` : "delayed",
        reason: null,
        nextFiringAt: new Date(notBefore).toISOString(),
        delaySeconds,
      };
    }
  }

  for (const job of jobs) {
    const payload = parseObject(job.payload_json);
    if (!payload) continue;
    if (payload.scheduleMechanism === "workflow-binding") {
      return {
        mechanism: "workflow-binding",
        identity: str(payload.scheduleIdentity),
        reason: str(payload.scheduleReason),
        nextFiringAt: null,
        delaySeconds: null,
      };
    }
    const scheduleId = str(payload.scheduleId) ?? str(payload.scheduleName) ?? str(payload.cron);
    if (scheduleId) {
      return {
        mechanism: "agent-scheduler",
        identity: scheduleId,
        reason: str(payload.scheduleReason) ?? str(payload.reason) ?? null,
        nextFiringAt: null,
        delaySeconds: null,
      };
    }
  }

  if (trigger === "scheduled" || trigger === "autonomous") {
    return { mechanism: "cron-trigger", identity: null, reason: null, nextFiringAt: null, delaySeconds: null };
  }
  if (trigger === "manual" || trigger === "agent") {
    return {
      mechanism: "manual",
      identity: trigger === "agent" ? "not-scheduled" : null,
      reason: null,
      nextFiringAt: null,
      delaySeconds: null,
    };
  }
  return { mechanism: "unknown", identity: null, reason: null, nextFiringAt: null, delaySeconds: null };
}

/**
 * A job-chain run is "scheduled" (not in-progress) only when no stage
 * has started and at least one queued job is not yet due — a chain
 * with a started stage is in flight even when a later stage is
 * delayed (per-stage not_before timing, not a scheduled run).
 */
export function isDelayedRun(jobs: WorkflowRunJobRow[], nowMs: number): boolean {
  if (jobs.length === 0) return false;
  if (!jobs.every((j) => j.status === "queued")) return false;
  return jobs.some((j) => {
    const notBefore = msOf(j.not_before);
    return notBefore !== null && notBefore > nowMs;
  });
}

/**
 * Schedule provenance for a run with no job rows (outcome-only,
 * report-only, saga-chain): the trigger alone decides, and only the
 * mechanism is known — identity and reason stay null, never guessed.
 */
export function scheduleProvenanceForTrigger(trigger: string): WorkflowRunSchedule {
  if (trigger === "scheduled" || trigger === "autonomous") {
    return { mechanism: "cron-trigger", identity: null, reason: null, nextFiringAt: null, delaySeconds: null };
  }
  if (trigger === "manual" || trigger === "agent") {
    return {
      mechanism: "manual",
      identity: trigger === "agent" ? "not-scheduled" : null,
      reason: null,
      nextFiringAt: null,
      delaySeconds: null,
    };
  }
  return { mechanism: "unknown", identity: null, reason: null, nextFiringAt: null, delaySeconds: null };
}

/** An Agents SDK schedule row (cf_agent_schedules), as the route reads it. */
export interface ScheduleRecord {
  id: string;
  callback: string;
  payload: Record<string, unknown> | null;
  type: "scheduled" | "delayed" | "cron" | "interval";
  /** Unix timestamp in seconds for the next execution; absent for paused items (no next run). */
  time?: number;
  cron?: string;
  intervalSeconds?: number;
  delayInSeconds?: number;
  /** Issue #273 paused items: cancelled at SDK level, kept as a record so pausing never makes a job vanish. */
  paused?: boolean;
}

const CALLBACK_LABELS: Record<string, { label: string; family: WorkflowRun["family"] }> = {
  autonomousMarketScreen: { label: "Scheduled market screen", family: "stock" },
  autonomousGoalScreen: { label: "Scheduled goal screen", family: "goal" },
  autonomousStrategyDiscovery: { label: "Scheduled strategy discovery", family: "discovery" },
  collectIvHistory: { label: "Scheduled IV collection", family: "research" },
  sendScheduledReminder: { label: "Scheduled reminder", family: "other" },
  expireStaleOrderDraft: { label: "Scheduled order-draft expiry", family: "other" },
  autoRenewETradeTokens: { label: "Scheduled token renewal", family: "other" },
};

/**
 * An agent-scheduler schedule record as a Workflow Runs row. Schedule
 * rows are scheduled-state by construction: the SDK lists active
 * schedules only, so a listed row has not fired away — one-time
 * schedules delete themselves after execution, and a fired recurring
 * schedule's runs surface as their own job-chain rows. startedAt is
 * empty (a schedule has no start time; its next firing is in the
 * Schedule column), so schedule rows sort after timed runs and are
 * reached via the lifecycle / schedule filters (filter-before-slice).
 */
export function runFromScheduleRecord(record: ScheduleRecord, _ownerLogin: string): WorkflowRun {
  const known = CALLBACK_LABELS[record.callback];
  const nextFiringAt =
    typeof record.time === "number" && Number.isFinite(record.time)
      ? new Date(record.time * 1000).toISOString()
      : null;
  const identity =
    record.type === "cron"
      ? (record.cron ?? null)
      : record.type === "interval"
        ? (typeof record.intervalSeconds === "number" ? `every ${record.intervalSeconds}s` : null)
        : record.type === "delayed"
          ? (typeof record.delayInSeconds === "number" ? `delay ${record.delayInSeconds}s` : null)
          : nextFiringAt;
  const payload = record.payload ?? {};
  const reason = str(payload.reason) ?? str(payload.description) ?? null;
  const title = known ? known.label : `Scheduled — ${record.callback}`;
  return {
    id: record.id,
    runId: record.id,
    workflow: "Scheduled task",
    family: known?.family ?? "other",
    title: record.paused ? `${title} (paused)` : title,
    source: "schedule",
    trigger: "scheduled",
    triggerDetail: `Agent schedule ${record.id}${identity ? ` — ${identity}` : ""}${record.paused ? " — paused" : ""}`,
    triggeredBy: null,
    status: "queued",
    lifecycle: "scheduled",
    schedule: {
      mechanism: "agent-scheduler",
      identity,
      reason,
      nextFiringAt,
      delaySeconds: record.type === "delayed" ? (record.delayInSeconds ?? null) : null,
    },
    startedAt: "",
    finishedAt: null,
    durationMs: null,
    stageCount: 0,
    completedStages: 0,
    failedStages: 0,
    stages: [],
    inputs: {},
    outputs: {},
    artifacts: [],
    deliveryStates: {},
    error: null,
    fanoutCapReason: null,
    resumedSkippedUnits: [],
  };
}

/**
 * Workflow binding schedules: the platform fires an instance on each
 * cron firing (event.schedule in run()). The registry is the
 * human-readable half of wrangler.jsonc's workflows[].schedules —
 * the pin test proves the two agree, so the page never renders a
 * schedule the platform is not actually configured to fire.
 *
 * Cadence choice (working default, not a ruling): every 30 minutes mirrors the
 * DO tick that dispatches scheduled screens today — the migration
 * target. At ship the schedule branch evaluates binding-owned
 * schedules only (none migrated yet), so firings are cheap skips
 * until the first schedule migrates (follow-up issue).
 */
export interface BindingSchedule {
  workflow: string;
  binding: string;
  className: string;
  cron: string;
  reason: string;
}

export const BINDING_SCHEDULES: readonly BindingSchedule[] = [
  {
    workflow: "screener-screen-workflow",
    binding: "SCREENER_WORKFLOW",
    className: "ScreenerScreenWorkflow",
    cron: "*/30 * * * *",
    reason:
      "Scheduled screens ride the DO tick today (cron to scheduled() to agent dispatch); the binding schedule moves that firing onto the workflow so a scheduled screen executes as a workflow instance with its runs surfaced. At ship the schedule branch handles firings without duplicating the tick: only binding-owned schedules execute, and none are migrated yet.",
  },
];

/** Config-derived scheduled rows for every registered binding schedule. */
export function bindingScheduleRows(): WorkflowRun[] {
  return BINDING_SCHEDULES.map((entry) => ({
    id: `binding-schedule:${entry.binding}:${entry.cron}`,
    runId: `binding-schedule:${entry.binding}:${entry.cron}`,
    workflow: "Scheduled task",
    family: "stock",
    title: `Scheduled — ${entry.workflow} (${entry.cron})`,
    source: "schedule",
    trigger: "scheduled",
    triggerDetail: `Workflow binding schedule — ${entry.binding} ${entry.cron}`,
    triggeredBy: null,
    status: "queued",
    lifecycle: "scheduled",
    schedule: {
      mechanism: "workflow-binding",
      identity: entry.cron,
      reason: entry.reason,
      nextFiringAt: null,
      delaySeconds: null,
    },
    startedAt: "",
    finishedAt: null,
    durationMs: null,
    stageCount: 0,
    completedStages: 0,
    failedStages: 0,
    stages: [],
    inputs: {},
    outputs: {},
    artifacts: [],
    deliveryStates: {},
    error: null,
    fanoutCapReason: null,
    resumedSkippedUnits: [],
  }));
}

/**
 * Issue #3021 deliverable (b): the session user's own agent
 * schedules as Workflow Runs rows. The caller reads the orchestrator
 * schedule list (mirroring the saga audit read); this layer keeps
 * ONLY rows whose payload records the session login — unattributed
 * rows are dropped, never shown to another user — and a row with a
 * malformed shape is skipped, never fabricated. Paused items (issue
 * #273) keep their payload, so they filter the same way and surface
 * with "(paused)" in the title.
 */
export function scheduleRunsFromItems(items: unknown[], userLogin: string): WorkflowRun[] {
  const runs: WorkflowRun[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" && row.id ? row.id : null;
    const callback = typeof row.callback === "string" && row.callback ? row.callback : null;
    const type = row.type;
    if (!id || !callback || (type !== "scheduled" && type !== "delayed" && type !== "cron" && type !== "interval")) continue;
    const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : null;
    // Fail-closed scoping: only the session user's own schedules.
    if (payload?.userLogin !== userLogin) continue;
    const record: ScheduleRecord = {
      id,
      callback,
      payload,
      type,
      ...(typeof row.time === "number" ? { time: row.time } : {}),
      ...(typeof row.cron === "string" ? { cron: row.cron } : {}),
      ...(typeof row.intervalSeconds === "number" ? { intervalSeconds: row.intervalSeconds } : {}),
      ...(typeof row.delayInSeconds === "number" ? { delayInSeconds: row.delayInSeconds } : {}),
      ...(row.paused === true ? { paused: true } : {}),
    };
    runs.push(runFromScheduleRecord(record, userLogin));
  }
  return runs;
}

/**
 * Resolve a workflow event to the binding-schedule branch. A firing
 * from a binding schedule carries a schedule object with cron and
 * scheduledTime, per the platform's WorkflowEvent type; a normal
 * command start never does. The branch must be checked before the
 * command validation gate — a schedule firing carries no command
 * payload and must not fail closed as a missing identity.
 */
export function resolveScheduleBranch(event: {
  schedule?: { cron?: string; scheduledTime?: number } | null;
  payload?: unknown;
}): { handled: boolean; cron?: string; scheduledTime?: number } {
  const cron = event.schedule?.cron;
  if (typeof cron === "string" && cron.trim()) {
    return { handled: true, cron, scheduledTime: event.schedule?.scheduledTime };
  }
  return { handled: false };
}
