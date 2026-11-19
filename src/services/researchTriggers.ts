/**
 * Issue #319 (amendment 2) — run entry points as thin triggers.
 *
 * The manual route and the scheduled tick both invoke the SAME publish
 * entry with only the trigger source differing. Zero duplicated
 * screening/validation/report logic between them.
 */

import type { TriggerSource } from "./researchPipeline";

export type PublishEntry<R> = (
  trigger: TriggerSource,
  userLogin?: string,
  opts?: { runId?: string },
) => Promise<R>;

/** Thin trigger for the manual run route. */
export function triggerManualResearch<R>(
  publish: PublishEntry<R>,
  userLogin?: string,
  opts?: { runId?: string },
): Promise<R> {
  return publish("manual", userLogin, opts);
}

/**
 * Thin trigger for the scheduled tick (server.ts cron). The caller
 * supplies the tick's identity (the configured service identity,
 * asserted by server.ts on the dispatch); there is deliberately no
 * default value — an absent login reaches the publish entry, which
 * fails closed (issue #2327).
 */
export function triggerScheduledResearch<R>(
  publish: PublishEntry<R>,
  userLogin?: string,
  opts?: { runId?: string },
): Promise<R> {
  return publish("scheduled", userLogin, opts);
}
