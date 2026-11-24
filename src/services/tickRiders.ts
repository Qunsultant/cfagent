/**
 * Issue #4234 (ADR 0030) — the tick's six piggyback dispatches,
 * extracted from `runTickEntryPoint`
 * (`src/services/consolidatedCronEntries.ts`) so the one SDK alarm
 * tick dispatches exactly the same riders as the Worker tick did:
 * one dispatch list, one trace, five observed + digest direct, same
 * URLs in the same order. The Worker entry point and the alarm tick
 * (`ScheduledAgent.onCron`) both call this helper — one dispatch
 * list, never two.
 *
 * Dispatch order (pinned by the S5 parity suite): research,
 * reflection, adaptation, corpus-sync, reports-index-backfill, then
 * the digest. The five observed POSTs ride the #2037 failure
 * observer (a failing observed dispatch NEVER fails the tick — the
 * observer swallows); the digest POST is direct and unobserved.
 * Fire/no-fire is decided inside each route/job by its own durable
 * guard; the riders fire unconditionally from the tick.
 */
import {
  observeInternalDispatch,
  type ScheduledJobId,
} from "../observability/scheduledJobOutcomes";
import { backgroundDispatchHeadersWithTrace } from "../security/backgroundAttribution";
import {
  childSpan,
  formatTraceparent,
  newTraceContext,
  type ObservabilitySink,
} from "../observability/observabilityPorts";
import { commercialBarePath } from "../data/commercialUrlCatalog";

/** The caller-injected surfaces the riders need (no env read here). */
export interface TickRiderDeps {
  /** The configured service login (the gate already proved it set). */
  userLogin: string;
  /** The shared Orchestrator stub's fetch. */
  orchestratorFetch: (request: Request) => Promise<unknown>;
  /** Observability sink factory. */
  createSink: () => ObservabilitySink;
  /** waitUntil-or-await (production: the ctx.waitUntil-or-await closure). */
  dispatchAndAwait: (promise: Promise<unknown>) => Promise<void>;
  /** Slack poster for the fail-loud alert. */
  slackPoster: (text: string) => Promise<unknown>;
}

/**
 * Dispatch the tick's six piggyback POSTs, in the pinned order,
 * under one trace. The `onCron` goal evaluation is NOT part of this
 * helper — the caller runs it first (the Worker entry point calls
 * the ScheduledAgent RPC; the alarm tick IS the onCron call).
 */
export async function dispatchTickRiders(
  deps: TickRiderDeps,
): Promise<void> {
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
        const recorded = (await deps.orchestratorFetch(
          new Request("https://agent.internal/scheduled-job-outcome", {
            method: "POST",
            headers: backgroundDispatchHeadersWithTrace(
              deps.userLogin,
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
      deps.userLogin,
      formatTraceparent(childSpan(tickTrace)),
    );
  // Issue #6299 — the research rider is RETIRED: the OODA cadence is one
  // stored schedule record (#6029 a), fired by the tick's own schedule
  // evaluation through `runPipelineJobSchedule`, so this tick no longer
  // names `/research/scheduled-tick` and there is no second scheduler.
  // Issue #705 — the weekly reflection job rides this tick.
  await deps.dispatchAndAwait(
    observeTickDispatch(
      "reflection",
      deps.orchestratorFetch(
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
      deps.orchestratorFetch(
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
      deps.orchestratorFetch(
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
      deps.orchestratorFetch(
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
    deps.orchestratorFetch(
      new Request(`https://agent.internal${commercialBarePath("lifecycleDigestRunDue")}`, {
        method: "POST",
        headers: dispatchHeaders(),
      }),
    ),
  );
}
