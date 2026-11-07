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
  WORKER_CRONS,
  WORKER_TICK_CRON,
} from "./consolidatedScheduling";
import {
  buildJobRunRecord,
  type JobRunOutcome,
  type JobRunRecord,
} from "./jobRunRecords";
import {
  observeInternalDispatch,
  type ScheduledJobId,
} from "../observability/scheduledJobOutcomes";
import {
  backgroundDispatchHeaders,
  backgroundDispatchHeadersWithTrace,
} from "../security/backgroundAttribution";
import {
  childSpan,
  formatTraceparent,
  newTraceContext,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

/** The three named cron entry points. */
export type CronEntryPointName = "tick" | "renewTokens" | "retention";

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
 */
function entryPointForCron(cron: string): CronEntryPointName | null {
  if (cron === WORKER_TICK_CRON) return "tick";
  if (cron === "0 3 * * *") return "renewTokens";
  if (cron === "0 4 * * *") return "retention";
  return null;
}

/** The routing table, single-sourced from S1 `WORKER_CRONS`. */
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
  return (
    CRON_ENTRY_POINTS.find((entry) => entry.cron === cron)?.entryPoint ??
    null
  );
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
 * does not yet admit `"worker-cron"`, and that file is concurrently
 * edited by the parallel #3650 fix — admitting the new system there
 * waits until #3650 lands, rather than colliding with it. The
 * vocabulary itself is widened in `src/data/jobRunRecordPorts.ts`
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
  });
  return { ...validated, system: "worker-cron" };
}

/**
 * Validate a record-route payload (builder-validation discipline,
 * same as `parseOutcomePayload`). Rejects: a non-object body; a cron
 * that is not one of the three Worker crons; an entryPoint that is
 * not the one its cron resolves to; an outcome outside
 * success/failure/skipped; a missing or non-ISO started/finished;
 * a finished before started; an error/detail present but not a
 * string; `skipped` without a detail; `failure` without an error.
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
  /** The ScheduledAgent stub ({ onCron }). */
  scheduledAgent: { onCron: () => Promise<unknown> };
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
    const tickTrace = newTraceContext();
    const observeTickDispatch = (
      job: ScheduledJobId,
      promise: Promise<unknown>,
    ): Promise<void> =>
      observeInternalDispatch(promise, {
        job,
        sink: deps.createSink(),
        trace: tickTrace,
        recordFailure: async (input) => {
          const recorded = (await deps.orchestrator.fetch(
            new Request("https://agent.internal/scheduled-job-outcome", {
              method: "POST",
              headers: backgroundDispatchHeadersWithTrace(
                userLogin,
                formatTraceparent(childSpan(tickTrace)),
              ),
              body: JSON.stringify(input),
            }),
          )) as unknown as { status?: unknown };
          if (
            !recorded ||
            typeof recorded.status !== "number" ||
            recorded.status >= 400
          ) {
            throw new Error("scheduled-job-outcome record failed");
          }
        },
        alertUnreachable: async (failedJob, trace) => {
          await deps.slackPoster(
            `Scheduled job ${failedJob} dispatch failed AND its outcome ` +
              `record is unreachable (trace ${trace.traceId}). The DO did ` +
              `not record this failure — investigate the dispatch layer; ` +
              `see Cloudflare logs for the tick.`,
          );
        },
      });
    const dispatchHeaders = () =>
      backgroundDispatchHeadersWithTrace(
        userLogin,
        formatTraceparent(childSpan(tickTrace)),
      );
    // PR #4 — ScheduledAgent tick: evaluate due goals, budget-check,
    // create Orchestrator jobs (issue #166).
    await deps.dispatchAndAwait(deps.scheduledAgent.onCron());
    // Issue #354 — the daily options-research run (after market close)
    // rides this tick. Fire/no-fire is decided inside the tick route.
    await deps.dispatchAndAwait(
      observeTickDispatch(
        "research",
        deps.orchestrator.fetch(
          new Request("https://agent.internal/research/scheduled-tick", {
            method: "POST",
            headers: dispatchHeaders(),
          }),
        ),
      ),
    );
    // Issue #705 — the weekly reflection job rides this tick.
    await deps.dispatchAndAwait(
      observeTickDispatch(
        "reflection",
        deps.orchestrator.fetch(
          new Request("https://agent.internal/reflection/run", {
            method: "POST",
            headers: dispatchHeaders(),
          }),
        ),
      ),
    );
    // Issue #754 — the weekly strategy-weight adjustment rides this tick.
    await deps.dispatchAndAwait(
      observeTickDispatch(
        "adaptation",
        deps.orchestrator.fetch(
          new Request("https://agent.internal/adaptation/weights/run", {
            method: "POST",
            headers: dispatchHeaders(),
          }),
        ),
      ),
    );
    // Issue #1169 (S4-4) — the weekly corpus sync rides this tick.
    await deps.dispatchAndAwait(
      observeTickDispatch(
        "corpus-sync",
        deps.orchestrator.fetch(
          new Request("https://agent.internal/knowledge/corpus-sync", {
            method: "POST",
            headers: dispatchHeaders(),
          }),
        ),
      ),
    );
    // Issue #3527 (S4) — the weekly reports canonical-index sweep
    // rides this tick on its OWN rider.
    await deps.dispatchAndAwait(
      observeTickDispatch(
        "reports-index-backfill",
        deps.orchestrator.fetch(
          new Request(
            "https://agent.internal/trading/reports/index-backfill-sweep",
            {
              method: "POST",
              headers: dispatchHeaders(),
            },
          ),
        ),
      ),
    );
    // Issue #2659 (monetization Phase 2.4) — the scheduled digest
    // pass rides this tick. Direct dispatch: NOT observed.
    await deps.dispatchAndAwait(
      deps.orchestrator.fetch(
        new Request(
          "https://agent.internal/payments/agentic/commercial/lifecycle/digest/run-due",
          {
            method: "POST",
            headers: dispatchHeaders(),
          },
        ),
      ),
    );
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
 * The `0 4` retention pass: POST the trigger-retention route under
 * the service identity. Moved verbatim from `handleScheduledEvent`,
 * plus the S5 response check the slice adds: a non-2xx response is
 * logged, never thrown — the retention pass's own outcome is its
 * route's business, and a failed dispatch must not fail the tick
 * layer that sent it.
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
    const responsePromise = deps.orchestrator
      .fetch(
        new Request("https://agent.internal/schedules/trigger-retention", {
          method: "POST",
          headers: { ...backgroundDispatchHeaders(deps.serviceUserLogin) },
        }),
      )
      .then((response) => {
        const status = (response as { status?: unknown } | null)?.status;
        if (typeof status !== "number" || status < 200 || status >= 300) {
          deps.logError(
            `[scheduled] retention dispatch returned non-2xx status ${String(status)} — the retention pass may not have run; see the orchestrator route result.`,
          );
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

const ENTRY_POINT_RUNNERS: Record<
  CronEntryPointName,
  (deps: CronEntryPointDeps) => Promise<void>
> = {
  tick: runTickEntryPoint,
  renewTokens: runRenewTokensEntryPoint,
  retention: runRetentionEntryPoint,
};

/** Run one entry point by name (the thin dispatcher's single call). */
export async function runCronEntryPoint(
  name: CronEntryPointName,
  deps: CronEntryPointDeps,
): Promise<void> {
  return ENTRY_POINT_RUNNERS[name](deps);
}
