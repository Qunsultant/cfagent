/**
 * Phase 5 Slice 1 (issue #2000) — DLQ depth alert.
 *
 * Working default (not a ruling): depth is the count of
 * un-replayed dead-letter store rows; the alert fires through
 * the existing postSlackText channel when that count crosses
 * the threshold. Platform DLQ depth itself is NOT counted
 * here — worker code cannot observe platform DLQ landings —
 * and is covered by dashboard queue metrics instead (the
 * runbook notes dashboard-native alerts as complementary).
 *
 * Claim-once per incident, the stuck-alert pattern
 * (asyncJobs.maybeAlertStuckRunning): the incident is claimed
 * BEFORE delivery, so a failed delivery does not re-alert on
 * the next landing; the incident clears when the depth drops
 * below the threshold (a replay clearing the backlog clears
 * it promptly, rather than waiting for the next landing).
 * A failed delivery is warned, never thrown: the caller
 * (persist helper) never lets alerting break the drop path.
 */
import type { DeadLetterStore } from "./deadLetterStorePorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "messaging/dlqDepthAlert",
});

export interface DlqDepthAlertDeps {
  store: DeadLetterStore;
  /** 0 disables the alert. */
  threshold: number;
  sendAlert: (text: string) => Promise<void>;
  nowMs?: number;
}

/** Returns true iff an alert was claimed and sent (or attempted) on this call. */
export async function maybeAlertDlqDepth(deps: DlqDepthAlertDeps): Promise<boolean> {
  if (deps.threshold <= 0) return false;
  const depth = await deps.store.unreplayedCount();
  if (depth < deps.threshold) {
    await deps.store.clearDepthIncident();
    return false;
  }
  const nowMs = deps.nowMs ?? Date.now();
  const token = `dlq-depth-${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
  const claimed = await deps.store.claimDepthIncident({ depth, atMs: nowMs, token });
  if (!claimed) return false;
  const text = [
    `DLQ depth alert: ${depth} un-replayed dead-letter records (threshold ${deps.threshold}).`,
    "Diagnosis + replay procedure: docs/operations/runbook/dlq-replay.md",
  ].join("\n");
  try {
    await deps.sendAlert(text);
  } catch (err) {
    // Claim-first trade-off (stuck-alert pattern): the incident
    // stays open, so no second alert fires; the runbook covers
    // the delivery-failure case.
    structuredLog.warn("dlq.alert_delivery_failed", {
      message: "[dlq-depth] alert delivery failed (incident stays open)",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}
