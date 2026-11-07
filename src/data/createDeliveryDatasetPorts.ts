/**
 * Issue #3539 (Pipeline J6), on the CDO data foundation
 * (#3548 pattern) — the composition root for the
 * delivery-dataset port family (the createGeneratedDatasetPorts
 * precedent): the build that resolves a runtime environment
 * to the residency's adapter, or refuses YIELDING NULL — a
 * composition-root value, not a thrown exception and never an
 * artifact faking persistence.
 *
 * PORTABILITY RULE (the foundation's rule): never construct
 * an adapter by hand above src/data/; import this factory.
 * The residency wiring lives here, attached to the family.
 */
import type { DeliveryDatasetStore, DeliveryDatasetStoreOptions } from "./deliveryDatasetPorts";
import { D1DeliveryDatasetStore, createD1DeliveryDatasetDb } from "./d1DeliveryDatasetAdapter";

/** The env slice the delivery-dataset port family reads. */
export interface DeliveryDatasetPortEnv {
  AGENT_DB?: D1Database;
}

/**
 * Build the production (D1) delivery-dataset store, or null
 * when the environment carries no AGENT_DB binding — the
 * production refusal, which the deliver plane surfaces as a
 * named not-configured state (DELIVER_JOB_NOT_CONFIGURED)
 * instead of executing against nowhere.
 */
export function createDeliveryDatasetPorts(
  env: DeliveryDatasetPortEnv,
  node?: "remote",
  options?: DeliveryDatasetStoreOptions,
): DeliveryDatasetStore | null {
  void node;
  if (env.AGENT_DB) {
    return new D1DeliveryDatasetStore(createD1DeliveryDatasetDb(env.AGENT_DB), options);
  }
  return null;
}
