/**
 * Issue Qunsultant/cfagent#3121 Slice S5 — named entry points for the
 * three Worker crons (inventory §3 Q(b), Option A CONFIRMED 2026-11-07
 * on #3592, comment 6708544001: the crons stay in `wrangler.jsonc`).
 *
 * `scheduled()` is a thin dispatch (`event.cron` → entry point) and
 * each cron runs through a named consolidated-scheduler entry point:
 * `tick` (`*\/30`), `renewTokens` (`0 3`), `retention` (`0 4`). The
 * branch bodies moved here verbatim from
 * `src/server/routes/queue.ts` `handleScheduledEvent` — same gate
 * order, same dispatch order, same per-tick trace, same observer
 * wiring, same guards (the five tick-riding jobs keep theirs
 * unchanged), same skip-when-unprovisioned behavior.
 *
 * Issue #4234 (ADR 0030) adds a fourth entry point, `watchdog`
 * (`0 * * * *`, hourly): the ONE Worker cron that still fires. It
 * checks the heartbeat SDK alarm exists and fired recently on the
 * ScheduledAgent, re-arms it when missing or stale, and records one
 * ledger row. It is NOT a duty cron — it lives outside the agent by
 * design, it never calls onCron, and it is NOT in `WORKER_CRONS` or
 * `CRON_ENTRY_POINTS` below; it routes by name in
 * `entryPointForCron`, before the duty-cron table. The three duty
 * crons stay OFF per #4112; their work moves onto the one SDK alarm
 * tick (see `src/services/heartbeatClock.ts`).
 *
 * A ledger row records the DISPATCH, not downstream outcomes:
 * downstream work (the tick's six POSTs, the retention pass, the
 * renewal sweep) has its own rows. A row's outcome is `success` when
 * the entry point dispatched, `failure` when the entry point itself
 * threw, `skipped` when the gate denied it (with the reason in
 * `detail`). `jobId` and `scheduleId` are the cron expression (§4
 * Q(b): a cron run's `scheduleId` IS its cron expression);
 * `asyncJobId` / `workflowId` are explicit nulls — no async job and
 * no workflow stand behind a dispatch itself.
 *
 * Hexagonal: this module is pure domain code. Cloudflare surfaces
 * arrive only through injected deps (stubs, env-bound fns, the
 * waitUntil-or-await closure, the record poster); the only imports
 * are pure helpers (trace, background headers, the #2037 observer),
 * the S1 primitives, and types. No `env.*` read, no fetch, no stub
 * creation lives here.
 *
 * S5 corrections to the inventory doc, verified against queue.ts
 * while moving the bodies (the doc said six dispatches; the code
 * has seven — onCron plus six POSTs):
 * - onCron is NOT observed: it dispatches direct, exactly as in
 *   queue.ts. The five observed POSTs are research, reflection,
 *   adaptation, corpus-sync, and reports-index-backfill; the digest
 *   POST is direct and unobserved.
 * - `newTraceContext()` takes no name argument; one trace per tick,
 *   one fresh child span per dispatch — the traceparents share a
 *   trace id, not a span id.
 * - The renewal completion log is `[scheduled] E*TRADE
 *   account-token renewal completed` with the counts object, not a
 *   formatted `refreshed N, skipped M, failed K` string.
 * - The fail-loud alert posts through `postSlackText` with no
 *   channel parameter (there is no `SLACK_CHANNEL_SCHEDULED_JOBS`
 *   constant); the channel routing lives in the Slack delivery env.
 */
import {
  buildLedgerLinkage,
  postGoalScheduleAuditEvent,
  WORKER_CRONS,
  WORKER_TICK_CRON,
} from "./consolidatedScheduling";
import {
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MS,
  HEARTBEAT_ALARM_CALLBACK,
  HEARTBEAT_WATCHDOG_CRON,
  type HeartbeatWatchdogConfig,
} from "../config/heartbeatWatchdog";
import {
  decideHeartbeatWatchdog,
  decideScheduleWatchdogHeartbeat,
} from "./heartbeatWatchdog";
import {
  MISSED_FIRE_CODE,
  SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID,
  SCHEDULE_WATCHDOG_HEARTBEAT_OPERATION,
} from "./scheduleWatchdog";
import { renderChannelText } from "../outcomes/outcomeAspects";
import { dispatchTickRiders } from "./tickRiders";

/** Re-exported so the router's watchdog cron is one named value (#4234). */
export { HEARTBEAT_WATCHDOG_CRON };
import {
  buildJobRunRecord,
  type JobRunOutcome,
  type JobRunRecord,
} from "./jobRunRecords";
import { backgroundDispatchHeaders } from "../security/backgroundAttribution";
import type { ObservabilitySink } from "../observability/observabilityPorts";

/** The four named cron entry points: the three S5 duty crons plus the #4234 watchdog. */
export type CronEntryPointName =
  | "tick"
  | "renewTokens"
  | "retention"
  | "watchdog";

export interface CronEntryPoint {
  cron: string;
  entryPoint: CronEntryPointName;
}

/**
 * Attach a name to a cron expression. The tick constant is the S1
 * export; the other two expressions are the S1 `WORKER_CRONS`
 * members — they are named exactly once, here, and the table below
 * is derived from `WORKER_CRONS`, so a drift between the table and
 * S1 fails the S5-P08 pin loudly instead of silently forking.
 *
 * Issue #4234 (ADR 0030): the hourly watchdog cron routes here by
 * name, before the duty-cron table — it is NOT a duty cron, so it is
 * NOT in `WORKER_CRONS` and NOT in the table below. This function is
 * the single router: `resolveCronEntryPoint` delegates to it.
 */
function entryPointForCron(cron: string): CronEntryPointName | null {
  if (cron === WORKER_TICK_CRON) return "tick";
  if (cron === "0 3 * * *") return "renewTokens";
  if (cron === "0 4 * * *") return "retention";
  if (cron === HEARTBEAT_WATCHDOG_CRON) return "watchdog";
  return null;
}

/** The routing table, single-sourced from S1 `WORKER_CRONS` (the three duty crons only; the watchdog routes by name above). */
export const CRON_ENTRY_POINTS: readonly CronEntryPoint[] =
  WORKER_CRONS.flatMap((cron) => {
    const entryPoint = entryPointForCron(cron);
    return entryPoint === null ? [] : [{ cron, entryPoint }];
  });

/** Map a cron expression to its entry point; non-strings and unknown crons → null. */
export function resolveCronEntryPoint(
  cron: unknown,
): CronEntryPointName | null {
  if (typeof cron !== "string") return null;
  return entryPointForCron(cron);
}

/* =================================================================
 * Ledger record input: build + validate (pure).
 * ================================================================= */

export interface CronDispatchRecordInput {
  cron: string;
  entryPoint: CronEntryPointName;
  outcome: JobRunOutcome;
  started: string;
  finished: string;
  error?: string;
  detail?: string;
  /** Issue #5100 (F3 of #5094): the binding tuple the dispatch executed against. */
  accountType?: string;
  accountId?: string;
  bindingScope?: string;
  bindingSource?: string;
}

/**
 * Build the dispatch row via the S1 builder + linkage. Validation
 * runs through `buildJobRunRecord` (dates, finished ≥ started,
 * failure-needs-error, skipped-needs-detail), and the §4 linkage
 * through `buildLedgerLinkage` (trigger `worker-cron`, scheduleId
 * the cron expression, explicit nulls for asyncJobId/workflowId).
 *
 * The `system` is restamped after validation: the S1 builder's
 * runtime allowlist (`SYSTEMS` in `src/services/jobRunRecords.ts`)
 * did not admit `"worker-cron"` when S5 landed, and that file was
 * concurrently edited by the parallel #3650 fix — admitting the new
 * system there waited until #3650 landed, rather than colliding
 * with it. S6 admits it now that #3650 has landed
 * (Qunsultant/cfagent#3723); the restamp below is RETAINED as-is
 * (the record's system is explicit, not derived — zero behavior
 * change, and the S5-P06 shape pin still holds). The vocabulary
 * itself was widened in S5 in `src/data/jobRunRecordPorts.ts`
 * (`JobRunSystem` gains `"worker-cron"`), so the restamped record
 * is a well-typed `JobRunRecord` and the DO-SQLite store (which
 * inserts the system string verbatim, with no allowlist) round-trips
 * it unchanged. See the PR body known-nuance note.
 */
export function buildCronDispatchRecord(
  input: CronDispatchRecordInput,
): JobRunRecord {
  const linkage = buildLedgerLinkage({
    payload: { scheduleId: input.cron },
    trigger: "worker-cron",
    triggeredBy: "scheduled",
  });
  const validated = buildJobRunRecord({
    // Validation vehicle only — restamped to "worker-cron" below.
    system: "orchestrator-schedule",
    jobId: input.cron,
    operation: input.entryPoint,
    started: input.started,
    finished: input.finished,
    outcome: input.outcome,
    triggeredBy: "scheduled",
    ...linkage,
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    // Issue #5100 (F3 of #5094): the binding tuple the dispatch executed against.
    ...(input.accountType !== undefined ? { accountType: input.accountType } : {}),
    ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
    ...(input.bindingScope !== undefined ? { bindingScope: input.bindingScope } : {}),
    ...(input.bindingSource !== undefined ? { bindingSource: input.bindingSource } : {}),
  });
  return { ...validated, system: "worker-cron" };
}

/**
 * Validate a record-route payload (builder-validation discipline,
 * same as `parseOutcomePayload`). Rejects: a non-object body; a cron
 * that is not one of the routed crons (the three duty crons + the
 * #4234 watchdog cron); an entryPoint that is not the one its cron
 * resolves to; an outcome outside success/failure/skipped; a missing
 * or non-ISO started/finished; a finished before started; an
 * error/detail present but not a string; `skipped` without a detail;
 * `failure` without an error.
 */
export function parseCronDispatchRecordPayload(
  body: unknown,
): CronDispatchRecordInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const cron = record.cron;
  if (typeof cron !== "string") return null;
  const entryPoint = resolveCronEntryPoint(cron);
  if (!entryPoint) return null;
  if (record.entryPoint !== entryPoint) return null;
  const outcome = record.outcome;
  if (outcome !== "success" && outcome !== "failure" && outcome !== "skipped") {
    return null;
  }
  const started = record.started;
  const finished = record.finished;
  if (typeof started !== "string" || !Number.isFinite(Date.parse(started))) {
    return null;
  }
  if (typeof finished !== "string" || !Number.isFinite(Date.parse(finished))) {
    return null;
  }
  if (Date.parse(finished) < Date.parse(started)) return null;
  if (record.error !== undefined && typeof record.error !== "string") {
    return null;
  }
  if (record.detail !== undefined && typeof record.detail !== "string") {
    return null;
  }
  if (
    outcome === "skipped" &&
    (typeof record.detail !== "string" || !record.detail.trim())
  ) {
    return null;
  }
  if (
    outcome === "failure" &&
    (typeof record.error !== "string" || !record.error.trim())
  ) {
    return null;
  }
  return {
    cron,
    entryPoint,
    outcome,
    started,
    finished,
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
  };
}

/* =================================================================
 * Entry points. Every dep is injected; see the module header.
 * ================================================================= */

export interface CronEntryPointDeps {
  cron: string;
  entryPoint: CronEntryPointName;
  /** The configured service login, or null when none is configured. */
  serviceUserLogin: string | null;
  /** The eager #2331 gate evaluation, passed in by the dispatcher. */
  serviceProvisioned: boolean;
  /** The shared Orchestrator stub ({ fetch }), created by the dispatcher. */
  orchestrator: { fetch: (request: Request) => Promise<unknown> };
  /**
   * The ScheduledAgent stub ({ onCron }). The watchdog's reads +
   * re-arm are optional: only the watchdog entry point uses them,
   * and the S5 duty-entry-point deps never carry them.
   */
  scheduledAgent: {
    onCron: () => Promise<unknown>;
    /** SDK schedule list (watchdog only). */
    listSchedules?: () => Promise<Array<{ id: string; callback: string }>>;
    /** Recorded tick history, newest first (watchdog only). */
    getTickHistory?: () => Promise<Array<{ timestamp: string }>>;
    /** Re-arm primitive (watchdog only). */
    ensureHeartbeatAlarm?: (
      intervalSeconds: number,
      opts?: { force?: boolean },
    ) => Promise<{ armed: boolean; alreadyArmed: boolean }>;
    /**
     * Issue #6503 step 12 — newest-first run history for one
     * ledger job (outer observation only): the ScheduledAgent's
     * public `listJobRuns`, the same merged read the Schedules
     * home's last-run joins use. The observation filters it by
     * operation (see `observeScheduleWatchdogHeartbeat`).
     */
    listJobRuns?: (
      jobId?: string,
      limit?: number,
    ) => Promise<Array<{ jobId: string; operation: string; started: string }>>;
  };
  /**
   * Watchdog config (watchdog entry point only; resolved by the
   * dispatcher from env). Absent → the built-in defaults, so a
   * caller that never wires the watchdog still gets the ADR 0030
   * backstop instead of a crash.
   */
  heartbeatWatchdog?: HeartbeatWatchdogConfig;
  /** Bound token renewal (production: `renewAllStoredETradeTokens(env)`). */
  renewTokens: () => Promise<unknown>;
  /** Observability sink factory (production: `createObservabilitySink(env)`). */
  createSink: () => ObservabilitySink;
  /** Slack poster (production: `postSlackText` to the scheduled-jobs channel). */
  slackPoster: (text: string) => Promise<unknown>;
  /** waitUntil-or-await (production: the ctx.waitUntil-or-await closure). */
  dispatchAndAwait: (promise: Promise<unknown>) => Promise<void>;
  /**
   * Ledger-row poster (production: POST the record route via the
   * orchestrator stub). NEVER throws — it logs and resolves on any
   * failure, so a record failure can never fail the dispatch it
   * records.
   */
  recordDispatch: (input: CronDispatchRecordInput) => Promise<void>;
  now: () => Date;
  logError: (...args: unknown[]) => void;
  logInfo: (...args: unknown[]) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function gateDeniedDetail(deps: CronEntryPointDeps, what: string): string {
  const reason = !deps.serviceUserLogin
    ? "SERVICE_USER_LOGIN is not configured"
    : "service user is not provisioned for the platform tier";
  return `${reason} — ${what} skipped rather than running unattended work without a verified identity (#2331 slice 2)`;
}

/**
 * The `*\/30` tick: the ScheduledAgent `onCron()` RPC, then six
 * piggyback POST dispatches, all unconditional from the dispatcher
 * — fire/no-fire is decided inside each route/job by its own durable
 * guard. Moved verbatim from `handleScheduledEvent`: onCron is
 * direct and unobserved; research / reflection / adaptation /
 * corpus-sync / reports-index-backfill ride the #2037 failure
 * observer; the digest POST is direct and unobserved. One trace per
 * tick; every dispatch carries a child span of it. A failing
 * observed dispatch NEVER fails the tick (the observer swallows).
 * The six dispatches live in `src/services/tickRiders.ts` (issue
 * #4234): the SDK alarm tick dispatches the same riders through the
 * same helper — one dispatch list, never two.
 */
export async function runTickEntryPoint(
  deps: CronEntryPointDeps,
): Promise<void> {
  const started = deps.now().toISOString();
  if (!deps.serviceUserLogin || !deps.serviceProvisioned) {
    deps.logError(
      "[scheduled] Service user is not provisioned for the platform tier — skipping the ScheduledAgent tick and the research/reflection/adaptation dispatches rather than running unattended work without a verified identity (#2331 slice 2). Provision the platform tier via POST /api/admin/service-user/provision to resume scheduled goals.",
    );
    await deps.recordDispatch({
      cron: deps.cron,
      entryPoint: "tick",
      outcome: "skipped",
      started,
      finished: deps.now().toISOString(),
      detail: gateDeniedDetail(deps, "tick"),
    });
    return;
  }
  const userLogin = deps.serviceUserLogin;
  try {
    // PR #4 — ScheduledAgent tick: evaluate due goals, budget-check,
    // create Orchestrator jobs (issue #166).
    await deps.dispatchAndAwait(deps.scheduledAgent.onCron());
    // Issue #4234 — the six piggyback dispatches ride this tick from
    // the one shared helper (see src/services/tickRiders.ts): the
    // SDK alarm tick dispatches the same riders, in the same order,
    // under one trace.
    await dispatchTickRiders({
      userLogin,
      orchestratorFetch: (request) => deps.orchestrator.fetch(request),
      createSink: deps.createSink,
      dispatchAndAwait: deps.dispatchAndAwait,
      slackPoster: deps.slackPoster,
    });
    // Issue #1077 Phase 5b slice 1: the parallel social tick is gone.
    // Social posting is now a ScheduledAgent goal ("daily-social-post",
    // disabled by default) evaluated by the onCron call at the top of
    // this entry point — no second scheduler, no second fire check.
    await deps.recordDispatch({
      cron: deps.cron,
      entryPoint: "tick",
      outcome: "success",
      started,
      finished: deps.now().toISOString(),
    });
  } catch (err) {
    await deps.recordDispatch({
      cron: deps.cron,
      entryPoint: "tick",
      outcome: "failure",
      started,
      finished: deps.now().toISOString(),
      error: errorMessage(err),
    });
    throw err;
  }
}

/**
 * The `0 3` token-renewal pass: `renewTokens` enumerates every
 * stored token and asserts no identity — it runs either way, gate
 * or no gate. Moved verbatim from `handleScheduledEvent`, with the
 * ledger record chained off the renewal promise so the row records
 * in BOTH the waitUntil and await paths, the original rejection
 * still propagates exactly as today (waitUntil path: unobserved
 * background rejection; await path: propagates out of the entry
 * point), and a record failure never swallows the renewal error.
 */
export async function runRenewTokensEntryPoint(
  deps: CronEntryPointDeps,
): Promise<void> {
  const started = deps.now().toISOString();
  let renewPromise: Promise<unknown>;
  try {
    renewPromise = deps.renewTokens().then((counts) => {
      deps.logInfo(
        "[scheduled] E*TRADE account-token renewal completed",
        counts,
      );
    });
  } catch (err) {
    await deps.recordDispatch({
      cron: deps.cron,
      entryPoint: "renewTokens",
      outcome: "failure",
      started,
      finished: deps.now().toISOString(),
      error: errorMessage(err),
    });
    throw err;
  }
  const recorded = renewPromise.then(
    async () => {
      await deps.recordDispatch({
        cron: deps.cron,
        entryPoint: "renewTokens",
        outcome: "success",
        started,
        finished: deps.now().toISOString(),
      });
    },
    async (err) => {
      await deps.recordDispatch({
        cron: deps.cron,
        entryPoint: "renewTokens",
        outcome: "failure",
        started,
        finished: deps.now().toISOString(),
        error: errorMessage(err),
      });
      throw err;
    },
  );
  await deps.dispatchAndAwait(recorded);
}

/**
 * Issue #3121 #4240 — the retention pass's outcome as one stable
 * line for the dispatch row's `detail`, built from the
 * trigger-retention route's own response (no second source, no
 * second parser — the Schedules home renders this string
 * verbatim). Prune counts are the route's three windows summed
 * (messages + events + memory); a skipped storage prune reads
 * `pruned=skipped` (the master switch was off, not zero rows).
 * The orphan sweep reads `orphans=<found>/<scanned> deleted=<n>`
 * (or `orphanSweep=error: …` when the sweep itself failed), and
 * the R2 snapshot export reads `snapshot=ok tables=<t> rows=<r>`
 * (or `snapshot=skipped: …` / `snapshot=error: …`). Returns
 * undefined when the body carries nothing to summarize — a
 * success row with no detail is honest, a fabricated one is not.
 */
export function retentionPassSummary(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const parts: string[] = [];
  if (b.skipped === true) {
    parts.push("pruned=skipped");
  } else {
    const pruned = num(b.pruned) ?? 0;
    const events = num(b.eventsPruned) ?? 0;
    const memory = num(b.memoryPruned) ?? 0;
    if ("pruned" in b || "eventsPruned" in b || "memoryPruned" in b) {
      parts.push(`pruned=${pruned + events + memory}`);
    }
  }
  const jobOutcomes = num(b.jobOutcomesPruned);
  if (jobOutcomes !== undefined) parts.push(`jobOutcomes=${jobOutcomes}`);
  // #5160 — the IDP profile prune leg reports its deleted count
  // (or its skip reason) the same way the other legs do.
  const idpPrune = b.idpProfilePrune;
  if (idpPrune && typeof idpPrune === "object") {
    const p = idpPrune as Record<string, unknown>;
    if (typeof p.skipped === "string" && p.skipped) {
      parts.push(`idpProfiles=skipped: ${p.skipped}`);
    } else if (num(p.deleted) !== undefined) {
      parts.push(`idpProfiles=${num(p.deleted) ?? 0}`);
    }
  }
  const sweep = b.orphanSweep;
  if (sweep && typeof sweep === "object") {
    const s = sweep as Record<string, unknown>;
    if (typeof s.error === "string" && s.error) {
      parts.push(`orphanSweep=error: ${s.error}`);
    } else if (num(s.scanned) !== undefined || num(s.orphans) !== undefined) {
      parts.push(
        `orphans=${num(s.orphans) ?? 0}/${num(s.scanned) ?? 0} deleted=${num(s.deleted) ?? 0}`,
      );
    }
  }
  const snap = b.snapshot;
  if (snap && typeof snap === "object") {
    const s = snap as Record<string, unknown>;
    if (typeof s.error === "string" && s.error) {
      parts.push(`snapshot=error: ${s.error}`);
    } else if (typeof s.skipped === "string" && s.skipped) {
      parts.push(`snapshot=skipped: ${s.skipped}`);
    } else if (typeof s.key === "string" && s.key) {
      parts.push(
        `snapshot=ok tables=${num(s.tables) ?? 0} rows=${num(s.rows) ?? 0}`,
      );
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * The `0 4` retention pass: POST the trigger-retention route under
 * the service identity. Moved verbatim from `handleScheduledEvent`,
 * plus the S5 response check the slice adds: a non-2xx response is
 * logged, never thrown — the retention pass's own outcome is its
 * route's business, and a failed dispatch must not fail the tick
 * layer that sent it.
 *
 * Issue #4240 — a 2xx response's body is summarized into the
 * success row's `detail` (retentionPassSummary), so the Schedules
 * home can show the pass's prune/export outcomes. The parse is
 * best-effort: an unparseable body omits the detail, never fails
 * the dispatch.
 */
export async function runRetentionEntryPoint(
  deps: CronEntryPointDeps,
): Promise<void> {
  const started = deps.now().toISOString();
  if (!deps.serviceUserLogin || !deps.serviceProvisioned) {
    deps.logError(
      "[scheduled] SERVICE_USER_LOGIN is not configured or the service user is not provisioned for the platform tier — skipping the retention dispatch rather than running unattended work without a verified identity (#2331 slice 2).",
    );
    await deps.recordDispatch({
      cron: deps.cron,
      entryPoint: "retention",
      outcome: "skipped",
      started,
      finished: deps.now().toISOString(),
      detail: gateDeniedDetail(deps, "retention dispatch"),
    });
    return;
  }
  try {
    let passSummary: string | undefined;
    const responsePromise = deps.orchestrator
      .fetch(
        new Request("https://agent.internal/schedules/trigger-retention", {
          method: "POST",
          headers: { ...backgroundDispatchHeaders(deps.serviceUserLogin) },
        }),
      )
      .then(async (response) => {
        const status = (response as { status?: unknown } | null)?.status;
        if (typeof status !== "number" || status < 200 || status >= 300) {
          deps.logError(
            `[scheduled] retention dispatch returned non-2xx status ${String(status)} — the retention pass may not have run; see the orchestrator route result.`,
          );
        } else {
          try {
            const json = (response as { json?: unknown })?.json;
            if (typeof json === "function") {
              passSummary = retentionPassSummary(
                await (response as Response).json(),
              );
            }
          } catch {
            // Best-effort: an unparseable body omits the detail.
          }
        }
        return response;
      });
    await deps.dispatchAndAwait(responsePromise);
    await deps.recordDispatch({
      cron: deps.cron,
      entryPoint: "retention",
      outcome: "success",
      started,
      finished: deps.now().toISOString(),
      ...(passSummary !== undefined ? { detail: passSummary } : {}),
    });
  } catch (err) {
    await deps.recordDispatch({
      cron: deps.cron,
      entryPoint: "retention",
      outcome: "failure",
      started,
      finished: deps.now().toISOString(),
      error: errorMessage(err),
    });
    throw err;
  }
}

/**
 * Issue #6503 step 12 — the schedule-watchdog self-watch: the
 * outer observation's read + alert half. The pure finding lives
 * in `decideScheduleWatchdogHeartbeat`
 * (src/services/heartbeatWatchdog.ts); this function owns the
 * ledger read through the ScheduledAgent stub and the alert.
 *
 * Read: `listJobRuns` for the heartbeat job id, newest first,
 * filtered by operation to `schedule.watchdog_heartbeat`. The
 * same job id is also written by the Orchestrator sweep
 * (`schedule.watchdog_sweep`), so the filter is the point — a
 * fresh sweep row must never mask a stale heartbeat row, and a
 * plain latest-by-job read would do exactly that.
 *
 * Alert (missing or stale): the same shape the watchdog itself
 * uses — a `schedule.missed_fire` audit event naming the watchdog
 * as the missed job (scheduleId the heartbeat job id, callback
 * the heartbeat operation, code `missed_fire`, expected tick +
 * last run), plus the catalog missed-schedule Slack text through
 * the entry point's Slack poster. Both deliveries are
 * best-effort: a failed audit post or Slack post is logged, never
 * thrown — the finding is already in the dispatch row's detail.
 *
 * No claim row is written: a missed-fire claim under the observed
 * operation would read back as a fresh heartbeat and
 * self-suppress the next hourly run, so the alert repeats while
 * the condition persists and clears the moment the watchdog runs
 * again.
 *
 * Throws only when the run history itself cannot be read (a
 * non-list reply counts as unreadable); the caller catches that
 * as an observation failure and the cron run continues.
 */
export interface ScheduleWatchdogHeartbeatObservationResult {
  /**
   * "unavailable" = the stub exposes no run history (an unwired
   * caller); the alarm check already ran and the dispatch row is
   * untouched.
   */
  finding: "healthy" | "missing" | "stale" | "unavailable";
  /** One line for the watchdog dispatch row's detail. */
  detail: string;
  /** Whether the missed-watchdog alert (audit + Slack) went out. */
  alerted: boolean;
}

export async function observeScheduleWatchdogHeartbeat(
  deps: CronEntryPointDeps,
  config: HeartbeatWatchdogConfig,
  nowMs: number,
): Promise<ScheduleWatchdogHeartbeatObservationResult> {
  const listJobRuns = deps.scheduledAgent.listJobRuns;
  if (typeof listJobRuns !== "function") {
    return {
      finding: "unavailable",
      detail:
        "schedule-watchdog heartbeat observation unavailable — scheduled agent exposes no run history (listJobRuns)",
      alerted: false,
    };
  }
  const rows = await listJobRuns(SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID, 200);
  if (!Array.isArray(rows)) {
    throw new Error(
      "scheduled agent run history is not a list (listJobRuns)",
    );
  }
  const heartbeatRow = rows.find(
    (row) => row.operation === SCHEDULE_WATCHDOG_HEARTBEAT_OPERATION,
  );
  const startedMs = heartbeatRow ? Date.parse(heartbeatRow.started) : NaN;
  const decision = decideScheduleWatchdogHeartbeat({
    lastHeartbeatAtMs:
      heartbeatRow && Number.isFinite(startedMs) ? startedMs : null,
    nowMs,
    staleAfterMs: config.staleAfterMs,
    intervalSeconds: config.intervalSeconds,
  });
  if (decision.finding === "healthy") {
    return {
      finding: "healthy",
      detail: `schedule-watchdog heartbeat: ${decision.detail}`,
      alerted: false,
    };
  }
  const lastRunIso = decision.lastRunIso;
  const expectedTick =
    decision.expectedTickIso ?? "never (no heartbeat row recorded)";
  const detail =
    `missed-fire: expected ${expectedTick} ` +
    `(last run: ${lastRunIso ?? "never"}) | callback: ${SCHEDULE_WATCHDOG_HEARTBEAT_OPERATION}`;
  const audited = await postGoalScheduleAuditEvent(
    (request) => deps.orchestrator.fetch(request),
    {
      type: "schedule.missed_fire",
      agent: "orchestrator",
      payload: {
        scheduleId: SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID,
        callback: SCHEDULE_WATCHDOG_HEARTBEAT_OPERATION,
        code: MISSED_FIRE_CODE,
        ...(decision.expectedTickIso !== undefined
          ? { expectedTick: decision.expectedTickIso }
          : {}),
        lastRun: lastRunIso,
      },
    },
  );
  if (!audited) {
    deps.logError(
      "[scheduled] schedule-watchdog heartbeat alert: audit event not recorded (schedule.missed_fire) — the finding is in the dispatch row",
    );
  }
  try {
    await deps.slackPoster(
      renderChannelText(
        "missed_schedule_alert",
        "slack",
        {
          scheduleId: SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID,
          kind: "schedule",
          callback: SCHEDULE_WATCHDOG_HEARTBEAT_OPERATION,
          expectedTick,
          lastRun: lastRunIso ?? "never",
          detail,
        },
        "legacy_missed_schedule_alert",
      ),
    );
  } catch (err) {
    deps.logError(
      "[scheduled] schedule-watchdog heartbeat alert: Slack post failed:",
      errorMessage(err),
    );
    return {
      finding: decision.finding,
      detail: `schedule-watchdog heartbeat: ${decision.detail} (Slack alert failed)`,
      alerted: false,
    };
  }
  return {
    finding: decision.finding,
    detail: `schedule-watchdog heartbeat: ${decision.detail}`,
    alerted: true,
  };
}

/**
 * Issue #4234 (ADR 0030) — the hourly heartbeat watchdog entry point.
 *
 * Reads the alarm list + last tick from the ScheduledAgent stub,
 * decides via the pure `decideHeartbeatWatchdog`, re-arms only on
 * positive evidence (missing → plain re-arm; stale → force re-arm;
 * healthy → nothing), records exactly one ledger row per run, and
 * NEVER calls onCron (the watchdog does no tick work). On unreadable
 * evidence or a re-arm failure it records a failure row naming the
 * error, then rethrows — fail-closed, never re-arm on evidence it
 * cannot see.
 */
export async function runWatchdogEntryPoint(
  deps: CronEntryPointDeps,
): Promise<void> {
  const started = deps.now().toISOString();
  const config: HeartbeatWatchdogConfig = deps.heartbeatWatchdog ?? {
    intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    staleAfterMs: DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MS,
  };
  try {
    const { listSchedules, getTickHistory, ensureHeartbeatAlarm } =
      deps.scheduledAgent;
    if (
      typeof listSchedules !== "function" ||
      typeof getTickHistory !== "function" ||
      typeof ensureHeartbeatAlarm !== "function"
    ) {
      throw new Error(
        "scheduled agent exposes no heartbeat alarm reads (listSchedules / getTickHistory / ensureHeartbeatAlarm)",
      );
    }
    const schedules = await listSchedules();
    const alarmExists = schedules.some(
      (schedule) => schedule.callback === HEARTBEAT_ALARM_CALLBACK,
    );
    const ticks = await getTickHistory();
    const lastTickAtMs =
      ticks.length > 0 ? Date.parse(ticks[0].timestamp) : null;
    const decision = decideHeartbeatWatchdog({
      alarmExists,
      lastTickAtMs:
        lastTickAtMs !== null && Number.isFinite(lastTickAtMs)
          ? lastTickAtMs
          : null,
      nowMs: deps.now().getTime(),
      staleAfterMs: config.staleAfterMs,
    });
    if (decision.rearm) {
      await ensureHeartbeatAlarm(config.intervalSeconds, {
        force: decision.forceRearm,
      });
    }
    // Issue #6503 step 12 — the schedule-watchdog self-watch: the
    // outer observation also reads the watchdog's own heartbeat
    // row. Best-effort and never fatal: a read failure is logged
    // and noted in the dispatch row, and the run continues — the
    // heartbeat-alarm re-arm above already ran.
    let observationDetail = "";
    try {
      const observation = await observeScheduleWatchdogHeartbeat(
        deps,
        config,
        deps.now().getTime(),
      );
      if (observation.finding === "unavailable") {
        deps.logError(
          "[scheduled] heartbeat watchdog: " + observation.detail,
        );
      } else {
        observationDetail = `; ${observation.detail}`;
      }
    } catch (err) {
      deps.logError(
        "[scheduled] heartbeat watchdog: schedule-watchdog heartbeat observation failed:",
        errorMessage(err),
      );
      observationDetail = `; schedule-watchdog heartbeat observation failed: ${errorMessage(err)}`;
    }
    await deps.recordDispatch({
      cron: deps.cron,
      entryPoint: "watchdog",
      outcome: "success",
      started,
      finished: deps.now().toISOString(),
      detail: `heartbeat watchdog: ${decision.finding} — ${decision.detail}${observationDetail}`,
    });
  } catch (err) {
    await deps.recordDispatch({
      cron: deps.cron,
      entryPoint: "watchdog",
      outcome: "failure",
      started,
      finished: deps.now().toISOString(),
      error: errorMessage(err),
      detail: `heartbeat watchdog failed: ${errorMessage(err)}`,
    });
    throw err;
  }
}

const ENTRY_POINT_RUNNERS: Record<
  CronEntryPointName,
  (deps: CronEntryPointDeps) => Promise<void>
> = {
  tick: runTickEntryPoint,
  renewTokens: runRenewTokensEntryPoint,
  retention: runRetentionEntryPoint,
  watchdog: runWatchdogEntryPoint,
};

/** Run one entry point by name (the thin dispatcher's single call). */
export async function runCronEntryPoint(
  name: CronEntryPointName,
  deps: CronEntryPointDeps,
): Promise<void> {
  return ENTRY_POINT_RUNNERS[name](deps);
}
