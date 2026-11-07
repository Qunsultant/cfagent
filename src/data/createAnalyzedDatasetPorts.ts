/**
 * Issue #3537 (Pipeline J4), on the CDO data foundation
 * (#3548 pattern) — the composition root for the
 * analyzed-dataset port family (the
 * createEnrichedDatasetPorts precedent): the build that
 * resolves a runtime environment to the residency's adapter,
 * or refuses YIELDING NULL — a composition-root value, not a
 * thrown exception and never an artifact faking persistence.
 *
 * PORTABILITY RULE (the foundation's rule): never construct an
 * adapter by hand above src/data/; import this factory. The
 * residency wiring lives here, attached to the family.
 */
import type { AnalyzedDatasetStore, AnalyzedDatasetStoreOptions } from "./analyzedDatasetPorts";
import { D1AnalyzedDatasetStore, createD1AnalyzedDatasetDb } from "./d1AnalyzedDatasetAdapter";

/** The env slice the analyzed-dataset port family reads. */
export interface AnalyzedDatasetPortEnv {
  AGENT_DB?: D1Database;
}

/**
 * Build the production (D1) analyzed-dataset store, or null
 * when the environment carries no AGENT_DB binding — the
 * production refusal, which the analyze plane surfaces as a
 * named not-configured state (ANALYZE_JOB_NOT_CONFIGURED)
 * instead of executing against nowhere.
 */
export function createAnalyzedDatasetPorts(
  env: AnalyzedDatasetPortEnv,
  node?: "remote",
  options?: AnalyzedDatasetStoreOptions,
): AnalyzedDatasetStore | null {
  void node;
  if (env.AGENT_DB) {
    return new D1AnalyzedDatasetStore(createD1AnalyzedDatasetDb(env.AGENT_DB), options);
  }
  return null;
}
