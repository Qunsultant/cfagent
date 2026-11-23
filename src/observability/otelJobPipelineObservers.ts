/**
 * Issue #6179 — the shared OTel job-pipeline observer helper: the
 * "same helper, later slice" the ScheduledAgent host comment
 * promises (src/agents/scheduledTasksPipeline.ts, S1 #5081).
 *
 * The S1/S2/S3 slices wired the logging + metrics + traces
 * observers (and the wrapped step journal) onto the ScheduledAgent
 * host's control only, and explicitly deferred the workflow /
 * options / in-memory hosts. This module is the one construction
 * every host uses: build the three per-signal deps from env,
 * compose them into the chained run-settled observer + the wrapped
 * step journal, and hand the pair to a JobPipelineControl as its
 * runSettledObserver + journal (the engine's existing seams —
 * no engine internals are touched).
 *
 * The composition mirrors the ScheduledAgent host exactly: the
 * logging observer first, then metrics, then traces (the chain
 * order is the signal order); the journal wraps traces → metrics
 * → logging → identity. Each observer checks the per-domain j1j7
 * switch first and no-ops when it is OFF, and each is best-effort
 * (a signal failure can never fail the run).
 *
 * Caching: `getOtelJobPipelineObservers` builds one observer set
 * per env object (one per isolate — the host guidance is "call
 * once per host"). The handles are never shut down by callers;
 * like the ScheduledAgent host's cached control, their lifetime
 * is the isolate's lifetime. A fresh env object (a test, a
 * different isolate) gets a fresh set.
 */
import type { Env } from "../types";
import { createOtelJobPipelineLogger, createOtelLogging } from "./otelProvider";
import {
  chainRunSettledObservers,
  createOtelJobPipelineRunSettledObserver,
  createOtelJobStepJournal,
  type JobRunSettledObserver,
  type OtelJobPipelineObserverDeps,
} from "./otelJobPipeline";
import { createOtelMetrics } from "./otelMetricsProvider";
import {
  createOtelJobPipelineMetricsRunSettledObserver,
  createOtelJobPipelineMetricsStepJournal,
  type OtelJobPipelineMetricsObserverDeps,
} from "./otelJobPipelineMetrics";
import { createOtelTracing } from "./otelTracesProvider";
import {
  createOtelJobPipelineTracesRunSettledObserver,
  createOtelJobPipelineTracesStepJournal,
  type OtelJobPipelineTracesObserverDeps,
} from "./otelJobPipelineTraces";
import type { JobStepJournal } from "../services/jobPipelineEngine";

/** The three per-signal observer deps, one set per host. */
export interface OtelJobPipelineObserverSet {
  logging: OtelJobPipelineObserverDeps;
  metrics: OtelJobPipelineMetricsObserverDeps;
  tracing: OtelJobPipelineTracesObserverDeps;
}

/** The composed observers a JobPipelineControl takes (the engine's seam). */
export interface OtelJobPipelineObservers {
  runSettledObserver: JobRunSettledObserver;
  journal: JobStepJournal;
}

/**
 * Build the three per-signal observer deps from env — the
 * ScheduledAgent host's exact construction (S1 #5081, S2 #5082,
 * S3 #2808), extracted so every host builds the same deps.
 */
export function createOtelJobPipelineObserverDeps(env: Env): OtelJobPipelineObserverSet {
  // Issue #5081 (S1): the OTel J1–J7 logging stack. Both the
  // observer and the journal check the per-domain j1j7 switch
  // first and no-op when it is OFF.
  const otel = createOtelLogging(env);
  const otelLogger = createOtelJobPipelineLogger(env, otel);
  const logging: OtelJobPipelineObserverDeps = {
    logger: otelLogger,
    isEnabled: () => otel.isDomainEnabled("j1j7"),
    flush: () => otel.flush(),
  };
  // Issue #5082 (S2): the OTel J1–J7 metrics stack, built
  // alongside the logging stack.
  const otelMetrics = createOtelMetrics(env);
  const metrics: OtelJobPipelineMetricsObserverDeps = {
    recorder: otelMetrics.recorder,
    isEnabled: () => otelMetrics.isDomainEnabled("j1j7"),
    flush: () => otelMetrics.flush(),
  };
  // Issue #2808 (S3): the OTel J1–J7 tracing stack, built
  // alongside the logging and metrics stacks.
  const otelTraces = createOtelTracing(env);
  const tracing: OtelJobPipelineTracesObserverDeps = {
    tracer: otelTraces.tracer,
    isEnabled: () => otelTraces.isDomainEnabled("j1j7"),
    flush: () => otelTraces.flush(),
  };
  return { logging, metrics, tracing };
}

/**
 * Compose the three per-signal deps into the chained run-settled
 * observer + the wrapped step journal — the same order the
 * ScheduledAgent host uses (logging, then metrics, then traces;
 * the journal wraps traces → metrics → logging → identity).
 *
 * Issue #6250 — the optional inner journal is a host's pre-existing
 * journal (e.g. the workflow step journal): it runs inside the
 * logging journal instead of the identity journal, so the host's
 * journal is kept, never replaced, exactly as the run-settled
 * observer is chained rather than replaced. Absent, the composition
 * is byte-for-byte the #6179 one.
 */
export function createOtelJobPipelineObservers(
  deps: OtelJobPipelineObserverSet,
  innerJournal?: JobStepJournal,
): OtelJobPipelineObservers {
  return {
    runSettledObserver: chainRunSettledObservers(
      createOtelJobPipelineRunSettledObserver(deps.logging),
      createOtelJobPipelineMetricsRunSettledObserver(deps.metrics),
      createOtelJobPipelineTracesRunSettledObserver(deps.tracing),
    ),
    journal: createOtelJobPipelineTracesStepJournal({
      ...deps.tracing,
      inner: createOtelJobPipelineMetricsStepJournal({
        ...deps.metrics,
        inner: createOtelJobStepJournal({
          ...deps.logging,
          ...(innerJournal ? { inner: innerJournal } : {}),
        }),
      }),
    }),
  };
}

/** One observer set per env object (one per isolate). */
const cachedByEnv = new WeakMap<object, OtelJobPipelineObservers>();

/**
 * One per-signal dep set per env object (one per isolate). The
 * providers are the expensive part (transports, batch processors);
 * the composition into observer + journal is cheap closures, so a
 * caller that needs a different inner journal (the factory, for a
 * host's pre-existing journal) composes from these cached deps
 * instead of rebuilding the providers per control.
 *
 * Issue #6250 — the factory's env path uses this so a per-dispatch
 * control build never re-creates the OTel providers.
 */
const cachedDepsByEnv = new WeakMap<object, OtelJobPipelineObserverSet>();

/** The cached per-signal deps for an env object (built once). */
export function getOtelJobPipelineObserverDeps(env: Env): OtelJobPipelineObserverSet {
  const cached = cachedDepsByEnv.get(env);
  if (cached) return cached;
  const deps = createOtelJobPipelineObserverDeps(env);
  cachedDepsByEnv.set(env, deps);
  return deps;
}

/**
 * The cached accessor call sites use: build the observer set
 * from env once per env object and reuse it. A leg that has no
 * env in scope does not call this — it leaves `otel` absent and
 * runs exactly as before.
 */
export function getOtelJobPipelineObservers(env: Env): OtelJobPipelineObservers {
  const cached = cachedByEnv.get(env);
  if (cached) return cached;
  const observers = createOtelJobPipelineObservers(getOtelJobPipelineObserverDeps(env));
  cachedByEnv.set(env, observers);
  return observers;
}

/**
 * Issue #6250 — the ONE env → observer-set composition the Job
 * Pipeline Control factory's `env` path resolves through. The
 * factory cannot import this module as a value (the provider chain
 * reaches the Node-only `@opentelemetry/context-async-hooks`, which
 * the vite browser bundle cannot include — CI Fast gates + Test &
 * Build red on PR #6261), so the Worker entry registers this
 * function as the factory's resolver
 * (`setJobPipelineControlOtelResolver` in
 * `../services/jobPipelineControlFactory`, `src/server.ts`). The
 * per-signal deps come from the cache above, so a per-dispatch
 * control build never re-creates the OTel providers; a host's
 * pre-existing journal threads in as the inner journal.
 */
export function resolveJobPipelineControlObservers(
  env: Env | Record<string, unknown>,
  innerJournal?: JobStepJournal,
): OtelJobPipelineObservers {
  return createOtelJobPipelineObservers(
    getOtelJobPipelineObserverDeps(env as Env),
    ...(innerJournal ? [innerJournal] : []),
  );
}
