/**
 * Issue #6250 — THE ONE factory for the Job Pipeline Control.
 *
 * Owner directive 2026-11-23: "there must be one code base for it
 * and it must be wired only once." The engine was constructed 18
 * separate times across the codebase and only the ScheduledAgent host
 * wired the OTel run-settled observers, so OODA/research jobs ran
 * through the engine but never emitted `job.run.settled` — Grafana
 * had zero `ai-search-agent` logs even for a normally-settling OODA
 * run. Every dispatch site constructs its control through this
 * factory and no site constructs one directly (pinned by
 * tests/job_pipeline_control_factory_6250.test.ts).
 *
 * The factory wires the OTel run-settled observers (log + metrics +
 * traces, chained) exactly once, plus the journal, so EVERY job that
 * runs through the engine emits `job.run.settled` — no site can
 * forget them. A host's pre-existing runSettledObserver is CHAINED
 * first (kept, never replaced — the feed-run observer on the
 * ScheduledAgent host) and a pre-existing journal is wrapped as the
 * inner journal (kept, never replaced — the workflow step journal);
 * the composition order mirrors the ScheduledAgent host exactly
 * (logging, then metrics, then traces; journal traces → metrics →
 * logging → inner).
 *
 * Why a separate module instead of extending the engine's bare
 * `createJobPipelineControl` (src/services/jobPipelineEngine.ts):
 * the observer helpers import the engine's `identityJobStepJournal`
 * as a VALUE, so the engine importing them would be a runtime
 * import cycle. This module is the leaf composer: it imports the
 * engine and the observers, and nothing imports it back. The bare
 * factory stays for tests and for hosts that explicitly pass no
 * observers — it is the constructor, this is the wiring.
 *
 * Wiring sources, in precedence order:
 * 1. `otel` — an already-composed observer set (a caller that built
 *    one via `getOtelJobPipelineObservers`, e.g. the options screen
 *    legs). Wins over `env`.
 * 2. `env` — the Worker env (or a string-valued env record, the
 *    shape the research/options hosts already carry as `input.env`).
 *    The per-signal deps are built from it once per env object
 *    (cached by `getOtelJobPipelineObserverDeps`); the composition
 *    into observer + journal is per control, so a host's
 *    pre-existing journal threads in as the inner journal. The OTel
 *    providers only read string env values, so a string record is
 *    a faithful Env here.
 * 3. neither — a bare control, exactly as before. In-memory and
 *    read-only hosts have no OTel sink (no env in scope, no run
 *    executes); they run through the factory so the construction
 *    stays single, and the absence is explicit at the call site.
 *
 * Why the `env` path resolves through an injected resolver instead
 * of importing the OTel providers: the env → observer-set
 * resolution imports the provider chain
 * (`otelJobPipelineObservers` → `otelProvider` /
 * `otelMetricsProvider` → `otelTraces`), and the tracing provider
 * imports the Node-only `@opentelemetry/context-async-hooks`
 * (`AsyncLocalStorageContextManager`, Node `async_hooks`). The
 * vite browser bundle cannot include it — the build fails with
 * `"AsyncLocalStorage" is not exported by "__vite-browser-external"`
 * (CI Fast gates + Test & Build red on PR #6261 after the rebase
 * onto main `e7d9ac96`; pristine main builds clean). The factory
 * is imported by browser-bundled dispatch sites (the workflow /
 * screen engines — `optionsStageControl` and `optionsWorkflowHost`
 * reach the client bundle through the NLQ/trading surface), so it
 * must stay browser-safe: it imports the engine and the
 * (type-only) observer set, never the providers. The Worker entry
 * (`src/server.ts`) registers the resolver once at startup
 * (`setJobPipelineControlOtelResolver`, the same register-a-builder
 * pattern as `registerDataProviderPortsBuilder` /
 * `registerTransactionRunner` in that file); the resolver is the
 * one composition in `otelJobPipelineObservers`
 * (`resolveJobPipelineControlObservers`). Where no resolver is
 * registered — the browser bundle, and tests that do not register
 * one — an `env` control is bare, exactly as a no-observer
 * control was before: the absence is silent but safe, and the
 * run still completes.
 *
 * The observers are best-effort and guarded (each checks the
 * per-domain j1j7 switch first and no-ops when it is OFF; a signal
 * failure can never fail, retry, or duplicate the run), so wiring
 * them cannot change a run's outcome — one dispatch still writes
 * exactly one ledger row.
 */
import type { Env } from "../types";
import {
  chainRunSettledObservers,
  createJobPipelineControl as createBareJobPipelineControl,
  type JobPipelineControl,
  type JobPipelineDeps,
  type JobStepJournal,
} from "./jobPipelineEngine";
// Type-only: the observer set is a value at runtime, but this module
// must never import the OTel provider chain as a value — see the
// header. The `env` path resolves through the injected resolver
// below, registered by the Worker entry.
import type { OtelJobPipelineObservers } from "../observability/otelJobPipelineObservers";

/**
 * Resolves a Worker env (+ an optional host journal to thread as
 * the inner journal) into a composed observer set. Implemented by
 * `resolveJobPipelineControlObservers`
 * (`../observability/otelJobPipelineObservers`) and registered once
 * by the Worker entry (`src/server.ts`).
 */
export type JobPipelineControlOtelResolver = (
  env: Env | Record<string, unknown>,
  innerJournal?: JobStepJournal,
) => OtelJobPipelineObservers;

/** The resolver registered by the Worker entry, if any. */
let otelEnvResolver: JobPipelineControlOtelResolver | undefined;

/**
 * Register the env → observer-set resolver (Worker entry only, once
 * at startup). Tests that exercise the `env` path register it
 * themselves; where it is not registered an `env` control is bare.
 */
export function setJobPipelineControlOtelResolver(
  resolver: JobPipelineControlOtelResolver,
): void {
  otelEnvResolver = resolver;
}

/** What the factory needs beyond the engine deps: where the OTel observers come from. */
export interface CreateJobPipelineControlOptions {
  /**
   * The Worker env (or a string-valued env record). The observer set
   * is built from it and cached once per env object, through the
   * resolver registered by the Worker entry; where no resolver is
   * registered the control is bare.
   */
  env?: Env | Record<string, unknown>;
  /**
   * An already-composed observer set. Wins over `env` when both are
   * given (the caller already resolved its env).
   */
  otel?: OtelJobPipelineObservers;
}

/**
 * Build the one Job Pipeline Control for a dispatch site, with the
 * OTel run-settled observers + journal wired exactly once. A
 * pre-existing `runSettledObserver` on the deps is chained FIRST;
 * a pre-existing `journal` runs as the inner journal.
 */
export function createJobPipelineControl(
  deps: JobPipelineDeps,
  opts: CreateJobPipelineControlOptions = {},
): JobPipelineControl {
  const wired = resolveWiredObservers(deps, opts);
  if (!wired) return createBareJobPipelineControl(deps);
  return createBareJobPipelineControl({
    ...deps,
    runSettledObserver: deps.runSettledObserver
      ? chainRunSettledObservers(deps.runSettledObserver, wired.runSettledObserver)
      : wired.runSettledObserver,
    journal: wired.journal,
  });
}

/**
 * Resolve the wired observer set for a control. A supplied `otel`
 * set is used as-is (its journal wrapped around a pre-existing
 * journal when one is present); an `env` builds the set through the
 * registered resolver, threading a pre-existing journal as the
 * inner journal so the host's journal is kept. Absent both — or
 * with an `env` but no resolver registered — there is nothing to
 * wire and the caller gets a bare control.
 */
function resolveWiredObservers(
  deps: JobPipelineDeps,
  opts: CreateJobPipelineControlOptions,
): OtelJobPipelineObservers | undefined {
  if (opts.otel) {
    if (!deps.journal) return opts.otel;
    return {
      runSettledObserver: opts.otel.runSettledObserver,
      journal: wrapJournal(opts.otel.journal, deps.journal),
    };
  }
  if (!opts.env || !otelEnvResolver) return undefined;
  return otelEnvResolver(
    opts.env,
    ...(deps.journal ? [deps.journal] : []),
  );
}

/**
 * Run `inner` inside `outer`: the OTel journal logs the step around
 * the host's journal, and the step itself executes exactly once
 * (the inner journal calls the step function once).
 */
function wrapJournal(outer: JobStepJournal, inner: JobStepJournal): JobStepJournal {
  return {
    do: async <T>(name: string, fn: () => Promise<T>): Promise<T> =>
      outer.do(name, () => inner.do(name, fn)),
  };
}
