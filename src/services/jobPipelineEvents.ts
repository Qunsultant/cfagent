/**
 * Issue #3534 (Pipeline J1) — job status publication. Every
 * management-state transition is published as it happens, in the
 * messaging port's CloudEvents v1.0 envelope (the platform
 * envelope standard, #1739): type `job.<state>` as a first-class
 * type value, the job-routing extension `jobid` set, the run's
 * artifact keys carried as claim-check references in `data`
 * (never bulk payloads). Subscribers — the UX surfaces, the
 * copilot, and downstream pipeline stages awaiting an upstream
 * `job.completed` — consume through the messaging ports; a stage
 * publishes its completion and the next stage's subscription is
 * the pub/sub wiring J3–J6 build on.
 */
import {
  assertMessageEnvelope,
  type MessageEnvelope,
  type MessagePublisher,
} from "../messaging/messagingPorts";
import type { JobRunState } from "../data/jobPipelinePorts";

/** The published transition vocabulary (the management states a run passes through). */
export type JobStatusEventState = JobRunState | "checkpointed";

export interface JobStatusEventInput {
  jobId: string;
  runId: string;
  state: JobStatusEventState;
  at: string;
  detail?: string;
  artifactKeys?: string[];
}

/** Build (and validate) the CloudEvents envelope for one transition. */
export function jobStatusEvent(input: JobStatusEventInput): MessageEnvelope {
  // The id is the idempotency key (messaging port contract), so it
  // must be unique per publication — two transitions to the same
  // state within one millisecond are distinct events.
  const suffix =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return assertMessageEnvelope({
    specversion: "1.0",
    id: `job-status:${input.runId}:${input.state}:${input.at}:${suffix}`,
    source: "job-pipeline",
    type: `job.${input.state}`,
    time: input.at,
    subject: input.jobId,
    jobid: input.jobId,
    data: {
      jobId: input.jobId,
      runId: input.runId,
      state: input.state,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.artifactKeys !== undefined ? { artifactKeys: input.artifactKeys } : {}),
    },
  });
}

/**
 * Publish one transition. Publication is best-effort by design
 * (the instance store is the durable truth; a failed publish
 * never fails the run) — but never silent: a rejected fan-out is
 * logged with its coded context.
 */
export async function publishJobStatus(
  publisher: MessagePublisher | null,
  input: JobStatusEventInput,
): Promise<void> {
  if (!publisher) return;
  try {
    const report = await publisher.publish(jobStatusEvent(input));
    if (report.failedTo.length > 0) {
      console.warn(
        `[job-pipeline] status publish for job "${input.jobId}" run "${input.runId}" state "${input.state}" failed to: ${report.failedTo.join(", ")}`,
      );
    }
  } catch (error) {
    console.warn(
      `[job-pipeline] status publish for job "${input.jobId}" run "${input.runId}" state "${input.state}" threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
