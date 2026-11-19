/**
 * Issue #319 (amendment 2) — run entry points as thin triggers.
 *
 * The manual route and the scheduled tick both invoke the SAME publish
 * entry with only the trigger source differing. Zero duplicated
 * screening/validation/report logic between them.
 */

import type { TriggerSource } from "./researchPipeline";

const runIdStack: string[] = [];

/** Bind the active engine `runId` across async research dispatch without altering 2-arg trigger signatures (#581). */
export async function runWithResearchRunId<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  runIdStack.push(runId);
  try {
    return await fn();
  } finally {
    runIdStack.pop();
  }
}

export function currentResearchRunId(): string | undefined {
  return runIdStack[runIdStack.length - 1];
}

export type PublishEntry<R> = (
  trigger: TriggerSource,
  userLogin?: string
) => Promise<R>;

/** Thin trigger for the manual run route. */
export function triggerManualResearch<R>(
  publish: PublishEntry<R>,
  userLogin?: string
): Promise<R> {
  return publish("manual", userLogin);
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
  userLogin?: string
): Promise<R> {
  return publish("scheduled", userLogin);
}
