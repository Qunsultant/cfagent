/**
 * Issue #4360 — the stage event the consumer persists.
 *
 * One projection: a `job.stage.*` envelope → one JobStageEventRecord.
 * The record's identity is the #2869 stage claim key (`runId::stageId`)
 * plus the action, the unit, and the recorded instant — so a re-delivered
 * publication is ignored while a stage's `started` and its terminal event
 * both persist. A non-stage envelope, or a stage envelope missing its
 * identity, returns null: nothing is invented into the store.
 */
import type { MessageEnvelope } from "../messaging/messagingPorts";
import type { JobStageEventRecord } from "../data/jobStageEventPorts";

const STAGE_EVENT_PREFIX = "job.stage.";

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Build the durable record for one stage envelope, or null when it is not one. */
export function stageEventFromEnvelope(envelope: MessageEnvelope): JobStageEventRecord | null {
  if (!envelope.type.startsWith(STAGE_EVENT_PREFIX)) return null;
  const data =
    envelope.data && typeof envelope.data === "object"
      ? (envelope.data as Record<string, unknown>)
      : null;
  if (!data) return null;
  const jobId = str(data.jobId) ?? envelope.jobid ?? envelope.subject ?? null;
  const runId = str(data.runId);
  const stageId = str(data.stageId);
  const action = str(data.action) ?? envelope.type.slice(STAGE_EVENT_PREFIX.length);
  const at = str(envelope.time) ?? str(data.at) ?? new Date().toISOString();
  const claimKey = str(data.idempotencyKey) ?? (runId && stageId ? `${runId}::${stageId}` : null);
  const unitId = str(data.unitId);
  if (!jobId || !runId || !stageId || !claimKey) return null;
  return {
    eventKey: `${claimKey}::${action}::${unitId ?? "-"}::${at}`,
    claimKey,
    runId,
    jobId,
    stageId,
    unitId,
    action,
    at,
    startedAt: str(data.startedAt),
    endedAt: str(data.endedAt),
    detail: str(data.detail),
  };
}
