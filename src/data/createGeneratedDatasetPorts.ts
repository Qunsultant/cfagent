/**
 * Issue #3538 (Pipeline J5), on the CDO data foundation
 * (#3548 pattern) — the composition root for the
 * generated-dataset port family (the
 * createAnalyzedDatasetPorts precedent): the build that
 * resolves a runtime environment to the residency's adapter,
 * or refuses YIELDING NULL — a composition-root value, not a
 * thrown exception and never an artifact faking persistence.
 *
 * PORTABILITY RULE (the foundation's rule): never construct an
 * adapter by hand above src/data/; import this factory. The
 * residency wiring lives here, attached to the family.
 */
import type { GeneratedDatasetStore, GeneratedDatasetStoreOptions } from "./generatedDatasetPorts";
import { D1GeneratedDatasetStore, createD1GeneratedDatasetDb } from "./d1GeneratedDatasetAdapter";

/** The env slice the generated-dataset port family reads. */
export interface GeneratedDatasetPortEnv {
  AGENT_DB?: D1Database;
}

/**
 * Build the production (D1) generated-dataset store, or null
 * when the environment carries no AGENT_DB binding — the
 * production refusal, which the generate plane surfaces as a
 * named not-configured state (GENERATE_JOB_NOT_CONFIGURED)
 * instead of executing against nowhere.
 */
export function createGeneratedDatasetPorts(
  env: GeneratedDatasetPortEnv,
  node?: "remote",
  options?: GeneratedDatasetStoreOptions,
): GeneratedDatasetStore | null {
  void node;
  if (env.AGENT_DB) {
    return new D1GeneratedDatasetStore(createD1GeneratedDatasetDb(env.AGENT_DB), options);
  }
  return null;
}
