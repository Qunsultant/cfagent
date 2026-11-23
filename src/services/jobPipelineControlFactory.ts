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
 * The observers are best-effort and guarded (each checks the
 * per-domain j1j7 switch first and no-ops when it is OFF; a signal
 * failure can never fail, retry, or duplicate the run), so wiring
 * them cannot change a run's outcome — one dispatch still writes
 * exactly one ledger row.
 */
import type { Env } from "../types";
import {
  createJobPipelineControl as createBareJobPipelineControl,
  type JobPipelineControl,
  type JobPipelineDeps,
  type JobStepJournal,
} from "./jobPipelineEngine";
import { chainRunSettledObservers } from "../observability/otelJobPipeline";
import {
  createOtelJobPipelineObservers,
  getOtelJobPipelineObserverDeps,
  type OtelJobPipelineObservers,
} from "../observability/otelJobPipelineObservers";

/** What the factory needs beyond the engine deps: where the OTel observers come from. */
export interface CreateJobPipelineControlOptions {
  /**
   * The Worker env (or a string-valued env record). The observer set
   * is built from it and cached once per env object.
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
 * journal when one is present); an `env` builds the set from the
 * cached per-env deps, threading a pre-existing journal as the
 * inner journal so the host's journal is kept. Absent both, there
 * is nothing to wire — the caller gets a bare control.
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
  if (!opts.env) return undefined;
  const observerDeps = getOtelJobPipelineObserverDeps(opts.env as Env);
  return createOtelJobPipelineObservers(
    observerDeps,
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
