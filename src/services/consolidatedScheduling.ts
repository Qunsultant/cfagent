/**
 * Issue Qunsultant/cfagent#3121 Slice S1 — shared scheduling primitives.
 *
 * The one home for the primitives S2–S6 migrate the four schedule
 * implementations onto: shared timing resolution, the consolidated
 * run-ledger vocabulary + linkage resolvers, the pause/resume/
 * trigger/audit vocabulary, schedule provenance, and the goal-
 * schedule lifecycle audit events (O2). Old paths stay live in S1;
 * nothing here replaces a live path yet — S2–S6 do the migration,
 * one path at a time, each behind its parity tests.
 *
 * This module is pure domain code: no storage, no DO access, no
 * fetch except through an injected function (the goal-audit poster).
 * The ledger shape it resolves onto lives in
 * `src/data/jobRunRecordPorts.ts`; the builder that enforces it at
 * write time lives in `src/services/jobRunRecords.ts`.
 *
 * No behavior change in this slice: every resolver below reproduces
 * the semantics its call site already had (the trigger derivation
 * reproduces `resolveScheduleRunTrigger`; the timing classifier
 * reproduces the create route's if-chain; the lifecycle map
 * reproduces the audit calls the routes already make inline).
 */
import type {
  JobRunLedgerTrigger,
  JobRunTrigger,
  LedgerLinkage,
} from "../data/jobRunRecordPorts";
import type { ScheduleProvenance } from "../schedule";
import { isDue, isValidCron, zonedDateParts } from "../schedule";
import { WORKER_CRON_TRIGGERS_INVENTORY } from "./scheduleSystems";
import type { ResolvedScheduleTiming } from "./unifiedScheduleManagement";

export type { JobRunLedgerTrigger, JobRunTrigger, LedgerLinkage };
export type { ScheduleProvenance };
export { isDue, isValidCron, zonedDateParts };

/* =================================================================
 * O1 — the hung-timeout mechanism, located (inventory §7 O1 / D6).
 *
 * The #2366 seed claim ("SDK default 30s, per-job hungTimeoutSeconds
 * option") is CORRECT, corrected from SDK 0.24.0 to the installed
 * SDK 0.32.0: `DEFAULT_HUNG_TIMEOUT_SECONDS = 30` in the SDK job
 * queue (`node_modules/agents/dist/lifecycle-v1rKHV2C.js`), a
 * per-job `hungTimeoutSeconds` option on the queue insert landing in
 * `cf_agents_jobs.hung_timeout_seconds`, and a scheduler-level
 * `hungScheduleTimeoutSeconds` option (default 30) passed as that
 * per-job value on schedule inserts. cfagent sets no per-job
 * timeout anywhere under `src/`, so every cfagent schedule rides
 * the 30s default; the mechanism is visible in-repo through
 * `src/data/frameworkQueueIndexSchema.ts`, which indexes
 * `cf_agents_jobs.hung_timeout_seconds` for the hung-recheck MIN.
 * A slice that ever sets a per-job timeout must use this constant
 * and pin the change — never a fresh literal.
 * ================================================================= */
export const SDK_HUNG_TIMEOUT_DEFAULT_SECONDS = 30;

/* =================================================================
 * Consolidated run ledger — vocabulary + resolvers (inventory §4).
 *
 * O4 decision (pinned in the inventory doc §4 before any write-site
 * change): `trigger` sits ALONGSIDE `triggeredBy`; it does not
 * supersede it. `triggeredBy` stays the two-valued human-facing
 * origin (scheduled | manual); `trigger` is the five-valued ledger
 * vocabulary. Derivation is total: no NEW row is ever `unknown` or
 * null.
 * ================================================================= */

/** The five-valued ledger trigger vocabulary, in derivation order. */
export const LEDGER_TRIGGERS: readonly JobRunLedgerTrigger[] = [
  "scheduled",
  "manual",
  "worker-cron",
  "async-chain",
  "unknown",
];

export function isLedgerTrigger(value: unknown): value is JobRunLedgerTrigger {
  return (
    typeof value === "string" &&
    (LEDGER_TRIGGERS as readonly string[]).includes(value)
  );
}

/**
 * Derive the ledger trigger for a firing. An explicit valid trigger
 * on the firing payload wins — except an explicit `"unknown"`, which
 * a payload may never stamp (unknown is legacy-rows-only, produced
 * solely by the read normalizer). An absent or invalid explicit
 * trigger falls back to the `triggeredBy` derivation (`scheduled` →
 * `scheduled`, `manual` → `manual`); an absent `triggeredBy`
 * defaults to `scheduled`, reproducing `resolveScheduleRunTrigger`.
 */
export function resolveLedgerTrigger(
  payload: unknown,
  triggeredBy?: JobRunTrigger | unknown,
): JobRunLedgerTrigger {
  if (payload && typeof payload === "object") {
    const explicit = (payload as Record<string, unknown>).trigger;
    if (
      isLedgerTrigger(explicit) &&
      explicit !== "unknown"
    ) {
      return explicit;
    }
  }
  return triggeredBy === "manual" ? "manual" : "scheduled";
}

/**
 * Issue #3650 — a missing id stringified upstream ("undefined" /
 * "null") is a missing id, never a real one. Any layer that reads an
 * id off untrusted input (a stored payload, a schedule object, a
 * stored row) treats these two literals as absent, so the literal
 * can never be stamped, linked, or rendered as an id. One definition
 * for every layer (#1069): the builder, the resolver, the read
 * normalizer, and the ledger cell all call this.
 */
export function isMissingIdLiteral(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value.trim() === "undefined" || value.trim() === "null")
  );
}

/** Read one linkage id off a firing payload: a non-empty string, else null. */
function linkageId(payload: unknown, key: string): string | null {
  if (payload && typeof payload === "object") {
    const value = (payload as Record<string, unknown>)[key];
    // Issue #3650 — a poisoned literal is absent, never an id.
    if (typeof value === "string" && value.trim() && !isMissingIdLiteral(value)) return value;
  }
  return null;
}

/**
 * Build the §4 linkage for a firing from its payload, an optional
 * explicit trigger, and the resolved `triggeredBy`. Every field is
 * always present: ids are explicit nulls when the firing names none
 * (a recorded fact, never a missing column). The `scheduleId` rule:
 * the payload's stamped `scheduleId` wins; else the SDK schedule
 * object's id when it is a real schedule id; else null — the
 * `callback:<name>` fallback is a job-id fallback, never a schedule
 * id, and must not be laundered into one.
 */
export function buildLedgerLinkage(input: {
  payload?: unknown;
  schedule?: { id?: unknown } | undefined;
  triggeredBy?: JobRunTrigger | unknown;
  trigger?: JobRunLedgerTrigger | unknown;
}): LedgerLinkage {
  const trigger =
    isLedgerTrigger(input.trigger) && input.trigger !== "unknown"
      ? input.trigger
      : resolveLedgerTrigger(input.payload, input.triggeredBy);
  const stampedScheduleId = linkageId(input.payload, "scheduleId");
  const scheduleObjectId =
    input.schedule && typeof input.schedule.id === "string" && input.schedule.id
      ? input.schedule.id
      : null;
  return {
    trigger,
    scheduleId: stampedScheduleId ?? scheduleObjectId,
    asyncJobId: linkageId(input.payload, "asyncJobId"),
    workflowId: linkageId(input.payload, "workflowId"),
  };
}

/**
 * Normalize linkage read back from storage (legacy rows predate
 * S1 and carry none of the four fields). A missing trigger reads
 * as `"unknown"` — the only place `unknown` is ever produced — and
 * missing ids read as explicit nulls. No silent backfill: this
 * normalizes the READ value only; it never writes anything back.
 */
export function normalizeLedgerLinkage(
  value: Partial<LedgerLinkage> | null | undefined,
): LedgerLinkage {
  return {
    trigger:
      value && isLedgerTrigger(value.trigger) ? value.trigger : "unknown",
    scheduleId:
      value &&
      typeof value.scheduleId === "string" &&
      value.scheduleId &&
      !isMissingIdLiteral(value.scheduleId)
        ? value.scheduleId
        : null,
    asyncJobId:
      value &&
      typeof value.asyncJobId === "string" &&
      value.asyncJobId &&
      !isMissingIdLiteral(value.asyncJobId)
        ? value.asyncJobId
        : null,
    workflowId:
      value &&
      typeof value.workflowId === "string" &&
      value.workflowId &&
      !isMissingIdLiteral(value.workflowId)
        ? value.workflowId
        : null,
  };
}

/**
 * Issue #3121 S4 — restamp a follow-up submission's §4 linkage with
 * the minted job's own id (inventory §4 Q(c): asyncJobId is the
 * row's OWN job_id).
 *
 * The planners stamp `ledgerLinkage` with the chain-parent main job
 * id — the only id that exists at plan time (see
 * `followupLedgerLinkage` in `src/services/screenerFollowups.ts`).
 * The minter knows the row's own id, so the id is restamped here,
 * at submit time, before the payload is serialized. The other three
 * fields pass through verbatim — this restamps the id only, it never
 * re-derives linkage — and the parent link is untouched: it rides
 * `parent_job_id`, not the linkage. A payload without a
 * `ledgerLinkage` object is returned unchanged (never coerced); the
 * input is never mutated (a new object is returned when restamping).
 */
export function restampLedgerLinkageAsyncJobId(payload: unknown, jobId: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const linkage = record.ledgerLinkage;
  if (!linkage || typeof linkage !== "object" || Array.isArray(linkage)) return payload;
  return { ...record, ledgerLinkage: { ...(linkage as Record<string, unknown>), asyncJobId: jobId } };
}

/**
 * Issue #3121 S4 — stamp a completed chain step's §4 linkage onto
 * its run record (the completed row's `result_json`).
 *
 * The linkage rides the stored payload (stamped by the planners,
 * restamped with the row's own id at submit time); the result
 * carries the same four fields flat, matching the bridged main
 * job's result shape, so a reader of any chain row's result finds
 * `trigger` / `scheduleId` / `asyncJobId` / `workflowId` without
 * joining the payload. `asyncJobId` is forced to the executing
 * row's own id, so pre-S4 rows — whose payload stamps the parent
 * id (S1-era) — still read correctly. A result that is not a plain
 * object, a payload without linkage, or a malformed linkage (an
 * invalid trigger, `unknown` — legacy-rows-only, never stamped onto
 * a new record — or a non-string / empty id) leaves the result
 * untouched: never coerced, never invented.
 */
export function stampLedgerLinkageIntoResult(payload: unknown, result: unknown, jobId: string): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return result;
  const linkage = (payload as Record<string, unknown>).ledgerLinkage;
  if (!linkage || typeof linkage !== "object" || Array.isArray(linkage)) return result;
  const link = linkage as Record<string, unknown>;
  if (!isLedgerTrigger(link.trigger) || link.trigger === "unknown") return result;
  for (const key of ["scheduleId", "workflowId"] as const) {
    const value = link[key];
    if (value !== null && (typeof value !== "string" || !value.trim())) return result;
  }
  return {
    ...(result as Record<string, unknown>),
    trigger: link.trigger,
    scheduleId: typeof link.scheduleId === "string" ? link.scheduleId : null,
    asyncJobId: jobId,
    workflowId: typeof link.workflowId === "string" ? link.workflowId : null,
  };
}

/** The three Worker cron expressions, in wrangler.jsonc order. */
export const WORKER_CRONS: readonly string[] = [...WORKER_CRON_TRIGGERS_INVENTORY];

/** The 30-minute tick — the wake-up behind every tick-evaluated firing. */
export const WORKER_TICK_CRON = "*/30 * * * *";

/**
 * Linkage for a Worker cron dispatch (inventory §4 Q(b): a cron
 * run's `scheduleId` IS its cron expression). Every dispatch of the
 * same cron carries the same linkage; there is no async job and no
 * workflow behind a dispatch itself.
 */
export function cronDispatchLinkage(cron: string): LedgerLinkage {
  return {
    trigger: "worker-cron",
    scheduleId: cron,
    asyncJobId: null,
    workflowId: null,
  };
}

/** Linkage for the 30-minute tick's piggyback dispatches (research / reflection / adaptation / corpus / digest). */
export const WORKER_TICK_LINKAGE: LedgerLinkage = cronDispatchLinkage(WORKER_TICK_CRON);

/* =================================================================
 * Shared timing resolution (inventory §1.1 B-T2-01, §3 Q(a)).
 *
 * `isDue` / `isValidCron` / `zonedDateParts` (re-exported above) are
 * the tick-evaluation semantics — the consolidated scheduler's tick
 * kind evaluates with them verbatim, including the preserved
 * opportunity-hunt quirk (an hour step of 6 in UTC mode is never
 * due). `resolveTimingForm` is the
 * alarm-kind classifier: it reproduces the create route's timing
 * if-chain (interval → scheduleEvery, cron → schedule idempotent,
 * date → schedule at a Date, delay seconds → schedule after a
 * delay) as a pure function S2 migrates the route onto. `time` is
 * epoch SECONDS, matching `ResolvedScheduleTiming` and
 * `armFromTiming` (`new Date(time * 1000)`).
 * ================================================================= */

export const SCHEDULE_TIMING_KINDS: readonly string[] = [
  "cron",
  "interval",
  "scheduled",
  "delayed",
];

export type ScheduleTimingInput = {
  scheduleType?: unknown;
  cron?: unknown;
  intervalSeconds?: unknown;
  date?: unknown;
  delayInSeconds?: unknown;
};

export type TimingFormResolution =
  | { ok: true; timing: ResolvedScheduleTiming }
  | { ok: false; error: string };

export function resolveTimingForm(
  input: ScheduleTimingInput,
  nowMs: number = Date.now(),
): TimingFormResolution {
  const { scheduleType, cron, intervalSeconds, date, delayInSeconds } = input;
  if (scheduleType === "interval" && intervalSeconds) {
    const seconds = Number(intervalSeconds);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      return { ok: false, error: "intervalSeconds must be a positive whole number of seconds." };
    }
    return { ok: true, timing: { type: "interval", intervalSeconds: seconds } };
  }
  if (scheduleType === "cron" && cron) {
    const expression = String(cron).trim();
    if (!expression) {
      return { ok: false, error: "Invalid schedule parameters: provide intervalSeconds, cron, date, or delayInSeconds" };
    }
    return { ok: true, timing: { type: "cron", cron: expression } };
  }
  if (scheduleType === "scheduled" && date) {
    const ms = Date.parse(String(date));
    if (!Number.isFinite(ms)) {
      return { ok: false, error: "Invalid schedule parameters: provide intervalSeconds, cron, date, or delayInSeconds" };
    }
    return { ok: true, timing: { type: "scheduled", time: Math.floor(ms / 1000) } };
  }
  if (delayInSeconds !== undefined) {
    const seconds = Number(delayInSeconds);
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
      return { ok: false, error: "Invalid schedule parameters: provide intervalSeconds, cron, date, or delayInSeconds" };
    }
    return {
      ok: true,
      timing: { type: "delayed", time: Math.floor(nowMs / 1000) + seconds },
    };
  }
  return {
    ok: false,
    error: "Invalid schedule parameters: provide intervalSeconds, cron, date, or delayInSeconds",
  };
}

/* =================================================================
 * Pause / resume / trigger / audit primitives (inventory §1.4
 * B-T2-06). The lifecycle map is the single source of truth for
 * action → audit event that S2 migrates the routes onto; the routes
 * today encode the same mapping inline. The route classifier lets a
 * caller name the lifecycle action a schedule route performs from
 * its path + method alone.
 * ================================================================= */

/** Lifecycle actions a schedule surface can perform on a schedule. */
export const SCHEDULE_LIFECYCLE_ACTIONS: readonly string[] = [
  "create",
  "cancel",
  "pause",
  "resume",
  "trigger",
  "update",
];

/** Action → per-schedule audit event (B-T2-06 funnel, verbatim). */
export const SCHEDULE_LIFECYCLE_AUDIT_EVENTS: Record<string, string> = {
  create: "schedule.created",
  cancel: "schedule.cancelled",
  pause: "schedule.paused",
  resume: "schedule.resumed",
  trigger: "schedule.triggered",
  update: "schedule.updated",
};

export function scheduleLifecycleAuditEvent(action: string): string | undefined {
  return SCHEDULE_LIFECYCLE_AUDIT_EVENTS[action];
}

export function resolveLifecycleAction(
  path: string,
  method: string,
): string | undefined {
  const verb = method.toUpperCase();
  if (path.endsWith("/schedules/create") && verb === "POST") return "create";
  if (path.endsWith("/schedules/cancel") && verb === "POST") return "cancel";
  if (path.endsWith("/pause") && verb === "POST") return "pause";
  if (path.endsWith("/resume") && verb === "POST") return "resume";
  if (path.endsWith("/trigger") && verb === "POST") return "trigger";
  if (path.includes("/schedules/") && verb === "PUT") return "update";
  if (path.includes("/schedules/") && verb === "DELETE") return "cancel";
  return undefined;
}

/* =================================================================
 * Goal-schedule lifecycle audit events — O2 (inventory §7).
 *
 * The T2 funnel (B-T2-06) enumerates eight events through
 * `ctx.audit`; the T3 lifecycle had no enumeration. These four are
 * the same `schedule.<verb>` funnel shape, goal-qualified so they
 * cannot collide with the T2 events (`schedule.triggered` is the T2
 * trigger; `schedule.goal.triggered` is the goal trigger). The
 * builder returns the exact `{ type, agent, payload }` the
 * orchestrator's POST /api/audit/event route validates
 * (`validateStrictAuditWrite`: type ≤ 120 chars, payload ≤ 64 KB);
 * the poster below sends it best-effort and never throws, mirroring
 * the `this.audit` swallow rule — an audit failure must never fail
 * the mutation it records.
 * ================================================================= */

export const GOAL_SCHEDULE_AUDIT_EVENTS: readonly string[] = [
  "schedule.goal.added",
  "schedule.goal.enabled",
  "schedule.goal.triggered",
  "schedule.goal.removed",
  // Issue #3788: the schedule watchdog's missed-fire finding. A goal
  // that misses its firing is a lifecycle event of the goal itself —
  // the same funnel, the same sink — with the expected tick, the last
  // run (or null), and the finding code in the payload.
  "schedule.goal.missed_fire",
];

export type GoalScheduleAuditEvent =
  (typeof GOAL_SCHEDULE_AUDIT_EVENTS)[number];

export function isGoalScheduleAuditEvent(
  value: unknown,
): value is GoalScheduleAuditEvent {
  return (
    typeof value === "string" &&
    (GOAL_SCHEDULE_AUDIT_EVENTS as readonly string[]).includes(value)
  );
}

export function buildGoalScheduleAuditEvent(input: {
  event: GoalScheduleAuditEvent;
  goalId: string;
  operation?: string;
  enabled?: boolean;
  actor?: string | null;
  /** Issue #3788: the missed-fire finding's expected tick (ISO). */
  expectedTick?: string;
  /** Issue #3788: the goal's last run (ISO), or null when it never ran. */
  lastRun?: string | null;
  /** Issue #3788: the finding code (missed_fire / invalid_cron). */
  code?: string;
}): { type: string; agent: string; payload: Record<string, unknown> } {
  return {
    type: input.event,
    agent: "orchestrator",
    payload: {
      goalId: input.goalId,
      ...(input.operation !== undefined ? { operation: input.operation } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.expectedTick !== undefined ? { expectedTick: input.expectedTick } : {}),
      ...(input.lastRun !== undefined ? { lastRun: input.lastRun } : {}),
      ...(input.code !== undefined ? { code: input.code } : {}),
    },
  };
}

/**
 * Best-effort poster for a goal lifecycle audit event, over an
 * injected fetch (production: the orchestrator stub's fetch, posting
 * to `https://agent.internal/audit/event`). Resolves false when the
 * post fails or the route refuses it; never throws and never fails
 * the caller. The mutation it records has already succeeded.
 */
export async function postGoalScheduleAuditEvent(
  fetchFn: (request: Request) => Promise<unknown>,
  event: { type: string; agent: string; payload: Record<string, unknown> },
): Promise<boolean> {
  try {
    const response = (await fetchFn(
      new Request("https://agent.internal/audit/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      }),
    )) as { status?: unknown } | null;
    return (
      !!response &&
      typeof response.status === "number" &&
      response.status >= 200 &&
      response.status < 300
    );
  } catch {
    return false;
  }
}

/* =================================================================
 * Schedule provenance — #2366 items 3–4 on the consolidated path
 * (inventory §4). Provenance travels in the schedule payload: the
 * SDK-owned table schema is untouched (the payload is the app's
 * JSON blob on the row). Framework-internal rows carry
 * `origin: "system"` with a reason naming the cause.
 * ================================================================= */

/**
 * Build a creation provenance value. `createdAt` defaults to now;
 * callers that restamp must pass the original through instead of
 * minting a new one (an update never rewrites creation time).
 */
export function buildScheduleProvenance(input: {
  origin: "user" | "system" | "agent";
  createdBy: string | null;
  /** Issue #3122 — required when origin is "agent". */
  agentId?: string;
  reason?: string;
  createdAt?: string;
}): ScheduleProvenance {
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("Schedule provenance createdAt is not an ISO timestamp.");
  }
  if (input.origin === "agent") {
    if (typeof input.agentId !== "string" || !input.agentId.trim()) {
      throw new Error("Schedule provenance for origin \"agent\" requires an agentId.");
    }
  }
  return {
    origin: input.origin,
    createdBy: input.createdBy,
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    createdAt,
  };
}

/** Framework-internal provenance for one cause (`"recovery"`, `"async-job-arm"`). */
export function systemProvenance(reason: string, now?: Date): ScheduleProvenance {
  return buildScheduleProvenance({
    origin: "system",
    createdBy: "system",
    reason,
    createdAt: (now ?? new Date()).toISOString(),
  });
}

/** Framework-internal provenance for a recovery re-arm. */
export function recoveryProvenance(now?: Date): ScheduleProvenance {
  return systemProvenance("recovery", now);
}

/**
 * Stamp provenance onto a schedule payload, returning a new object.
 * A non-object payload is returned untouched (never coerced); an
 * already-stamped payload keeps its original provenance — stamping
 * is a creation act, and an update that re-stamps would rewrite
 * creation time. Callers that must carry provenance across an update
 * use `carryScheduleProvenance` instead.
 */
export function stampScheduleProvenance(
  payload: unknown,
  provenance: ScheduleProvenance,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (record.provenance !== undefined) return payload;
  return { ...record, provenance };
}

/**
 * Carry an existing provenance across an update that rebuilds the
 * payload (e.g. a criteria re-validation that drops unknown fields):
 * the new payload keeps the old creation record verbatim, never a
 * fresh stamp. A payload with no prior provenance is returned
 * untouched.
 */
export function carryScheduleProvenance(
  existingPayload: unknown,
  newPayload: unknown,
): unknown {
  const existing = provenanceFromPayload(existingPayload);
  if (!existing) return newPayload;
  if (!newPayload || typeof newPayload !== "object" || Array.isArray(newPayload)) {
    return newPayload;
  }
  return { ...(newPayload as Record<string, unknown>), provenance: existing };
}

/** Read + validate a stamped provenance off a payload. Malformed or absent → undefined, never throws. */
export function provenanceFromPayload(payload: unknown): ScheduleProvenance | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>).provenance;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.origin !== "user" && record.origin !== "system" && record.origin !== "agent") return undefined;
  if (
    record.createdBy !== null &&
    (typeof record.createdBy !== "string" || !record.createdBy.trim())
  ) {
    return undefined;
  }
  if (
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    return undefined;
  }
  if (record.reason !== undefined && typeof record.reason !== "string") {
    return undefined;
  }
  // Issue #3122 — an agent stamp without an agent id is malformed
  // (the acting agent is the point of the stamp); a user/system stamp
  // never carries one.
  if (record.origin === "agent") {
    if (typeof record.agentId !== "string" || !record.agentId.trim()) return undefined;
  }
  return {
    origin: record.origin,
    createdBy: record.createdBy as string | null,
    ...(record.origin === "agent" && typeof record.agentId === "string"
      ? { agentId: record.agentId }
      : {}),
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    createdAt: record.createdAt,
  };
}
