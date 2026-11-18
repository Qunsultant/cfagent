/**
 * Issue #4438 — the durable delivery-suppression claims door
 * (audit item E-3 from #3943's §15): the seam + door + both
 * ends' adapters, in one leaf module (the canonical leg's
 * shape, src/services/canonicalReportLeg.ts).
 *
 * The problem: the workflow residency has no DO SQLite of
 * its own, so its deliver stage claimed into a bare
 * in-memory suppressor — a restart/retry of the run could
 * re-send a pair an earlier attempt already delivered. The
 * host residency claims into its own DO's mas_delivery_claims
 * and the orchestrator executor into the Orchestrator DO's
 * — three tables, no sharing. The door ends that: every
 * residency claims through the shared Orchestrator
 * instance's door, into the ONE mas_delivery_claims table
 * that instance owns (src/data/deliveryClaimsStore.ts, the
 * #2913 store — reused, not re-invented).
 *
 * The door is check-and-set inside the DO: the handler below
 * claims through the sync suppressor over the DO's SQL
 * store, so the claim lands durably before the caller sends,
 * under the per-instance serialization the DO residency
 * provides (the store header's rule, unchanged). A door
 * failure fails the claim closed: the caller must not send
 * without a claim, so the error propagates and the run
 * fails with a named error instead of duplicating.
 *
 * The key discipline stays in the ONE module
 * (src/workflows/screenDeliverySuppression.ts): the door
 * takes the structured (runId, destination) pair and names
 * the canonical key in its results, so no caller parses a
 * key string back apart.
 */
import {
  deliverySuppressionKey,
  type AsyncDeliverySuppressor,
  type DeliverySuppressor,
} from "../workflows/screenDeliverySuppression";

/** One (runId, destination) pair, structured — never a parsed key string. */
export interface DeliveryClaimInput {
  runId: string;
  destination: string;
}

/** A claim check's outcome: whether the pair is/was claimed, and its canonical key. */
export interface DeliveryClaimResult {
  claimed: boolean;
  key: string;
}

/**
 * The orchestrator door the workflow residency claims
 * through (#4438): the deliver stage never touches
 * mas_delivery_claims directly — it calls the shared
 * Orchestrator instance's door, which claims through the
 * one seam (the sync suppressor over the DO's SQL store)
 * inside that DO. One method per operation, the same shape
 * as the generate leg's recordPipelineGenerateReport door.
 */
export interface DeliveryClaimsDoor {
  tryClaimDelivery(input: DeliveryClaimInput): Promise<DeliveryClaimResult>;
  wasClaimedDelivery(input: DeliveryClaimInput): Promise<DeliveryClaimResult>;
  releaseDeliveryClaim(input: DeliveryClaimInput): Promise<void>;
}

/**
 * The door handler (orchestrator side): claim through the
 * given sync suppressor — the DO's own durable store — and
 * name the canonical key in every result. The
 * OrchestratorAgent door methods are thin wrappers over
 * this factory, like recordPipelineGenerateReport over its
 * seam.
 */
export function createDeliveryClaimsDoor(
  suppressor: DeliverySuppressor,
): DeliveryClaimsDoor {
  return {
    async tryClaimDelivery(input) {
      return {
        claimed: suppressor.tryClaim(input.runId, input.destination),
        key: deliverySuppressionKey(input.runId, input.destination),
      };
    },
    async wasClaimedDelivery(input) {
      return {
        claimed: suppressor.wasClaimed(input.runId, input.destination),
        key: deliverySuppressionKey(input.runId, input.destination),
      };
    },
    async releaseDeliveryClaim(input) {
      suppressor.release(input.runId, input.destination);
    },
  };
}

/**
 * The door-backed suppressor (caller side): an async
 * suppressor whose backing is the door. The door is
 * resolved lazily on the first claim and memoized — deps
 * objects build without touching the DO namespace (the
 * generate leg's lazy-record idiom), and an unbound
 * namespace fails the first claim closed with the gateway's
 * named error, never a silent in-memory send.
 */
export function createDoorDeliverySuppressor(
  getDoor: () => DeliveryClaimsDoor,
): AsyncDeliverySuppressor {
  let door: DeliveryClaimsDoor | undefined;
  const resolve = (): DeliveryClaimsDoor => (door ??= getDoor());
  return {
    async tryClaim(runId, destination) {
      return (await resolve().tryClaimDelivery({ runId, destination })).claimed;
    },
    async wasClaimed(runId, destination) {
      return (await resolve().wasClaimedDelivery({ runId, destination })).claimed;
    },
    async release(runId, destination) {
      await resolve().releaseDeliveryClaim({ runId, destination });
    },
  };
}
