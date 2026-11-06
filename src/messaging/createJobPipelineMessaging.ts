/**
 * Issue #3534 (Pipeline J1) — the job-pipeline queue substrate
 * composition root, mirroring createMessagingPorts (#1739). This
 * is the only module that reads the pipeline queue binding out
 * of the environment and builds the provider adapter around it;
 * domain code imports this helper and the port types, never a
 * binding.
 *
 * The binding (wrangler.jsonc, producer-only in this slice — its
 * consumer arrives with the first job handler in J2, exactly the
 * #1739 sequencing):
 *  - JOB_PIPELINE_EVENTS: the pipeline pub/sub queue. Producer
 *    publishes stage/job status events; per-subscriber queues
 *    fan out from it as stages wire their subscriptions.
 *
 * Absence is a NAMED state, not a silent fallback (the
 * THINK_WEBHOOK_SECRET pattern): createJobPipelineMessaging
 * returns state "job_pipeline_queue_not_configured" with null
 * ports, and the engine proceeds with the instance store as the
 * durable truth while status publication is skipped. A provider
 * queue is never silently replaced by an in-memory queue in
 * production — tests construct InMemoryMessagingAdapter
 * explicitly.
 */
import {
  CfQueueMessagingAdapter,
  type QueueSendBinding,
} from "./cfQueueMessagingAdapter";
import type { MessagingPorts } from "./messagingPorts";

export const JOB_PIPELINE_QUEUE_NOT_CONFIGURED = "job_pipeline_queue_not_configured";

export interface JobPipelineMessagingEnv {
  JOB_PIPELINE_EVENTS?: unknown;
}

export type JobPipelineMessaging =
  | { state: "configured"; ports: MessagingPorts }
  | { state: typeof JOB_PIPELINE_QUEUE_NOT_CONFIGURED; ports: null };

function asSendBinding(value: unknown): QueueSendBinding | null {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { send?: unknown }).send === "function"
  ) {
    return value as QueueSendBinding;
  }
  return null;
}

/**
 * Build the pipeline messaging ports from the worker
 * environment, or the named unconfigured state when the queue
 * binding is absent or malformed.
 */
export function createJobPipelineMessaging(
  env: JobPipelineMessagingEnv,
  opts?: { seenIds?: Set<string> },
): JobPipelineMessaging {
  const queue = asSendBinding(env.JOB_PIPELINE_EVENTS);
  if (!queue) {
    if (env.JOB_PIPELINE_EVENTS) {
      console.warn(
        "[job-pipeline] JOB_PIPELINE_EVENTS binding is present but has no send capability — pipeline messaging unavailable (job_pipeline_queue_not_configured).",
      );
    }
    return { state: JOB_PIPELINE_QUEUE_NOT_CONFIGURED, ports: null };
  }
  const adapter = new CfQueueMessagingAdapter(queue, { seenIds: opts?.seenIds });
  return {
    state: "configured",
    ports: {
      producer: adapter,
      consumer: adapter,
      publisher: adapter,
      subscriber: adapter,
    },
  };
}
