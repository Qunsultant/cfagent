/**
 * Feed-job residency configuration (#4171).
 *
 * Feed jobs execute in workflow residency only: ScheduledAgent
 * is the control plane/dispatcher and JobPipelineWorkflow runs
 * the engine. The switch is externalized in the same env-knob
 * idiom as the feed timeouts; "host" is the retired value and
 * refuses by name rather than silently executing on the host.
 */
export type FeedJobResidency = "workflow";

export const FEED_JOB_RESIDENCY_ENV = "FEED_JOB_RESIDENCY";
export const FEED_JOB_WORKFLOW_POLL_MS_ENV = "FEED_JOB_WORKFLOW_POLL_MS";

const DEFAULT_POLL_MS = 1000;

export function resolveFeedJobResidency(
  env: Record<string, unknown> | undefined | null,
): FeedJobResidency {
  const raw = env?.[FEED_JOB_RESIDENCY_ENV];
  if (raw === undefined || raw === null || raw === "") return "workflow";
  const value = String(raw).trim().toLowerCase();
  if (value === "workflow") return "workflow";
  if (value === "host") {
    throw new Error(
      "feed_job_host_residency_retired: FEED_JOB_RESIDENCY=host is retired (#4171); feed jobs execute in workflow residency only",
    );
  }
  throw new Error(
    `FEED_JOB_RESIDENCY must be "workflow", got ${JSON.stringify(raw)}`,
  );
}

export function resolveFeedWorkflowPollMs(
  env: Record<string, unknown> | undefined | null,
): number {
  const raw = env?.[FEED_JOB_WORKFLOW_POLL_MS_ENV];
  if (raw === undefined || raw === null || raw === "") return DEFAULT_POLL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `FEED_JOB_WORKFLOW_POLL_MS must be a positive number of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}
