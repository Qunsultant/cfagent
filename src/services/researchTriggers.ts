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

/** Issue #5912 — the venue/mode a run names (both optional). */
export interface ResearchRunSelection {
  brokerId?: string;
  mode?: string;
  /**
   * Issue #5911 — the run id when the caller already has one (an engine
   * dispatch minted it). The pipeline then runs under THAT id: one job, one
   * run id, no second mint.
   */
  runId?: string;
}

export type PublishEntry<R> = (
  trigger: TriggerSource,
  userLogin?: string,
  selection?: ResearchRunSelection
) => Promise<R>;

/** Thin trigger for the manual run route. */
export function triggerManualResearch<R>(
  publish: PublishEntry<R>,
  userLogin?: string,
  selection?: ResearchRunSelection
): Promise<R> {
  return selection ? publish("manual", userLogin, selection) : publish("manual", userLogin);
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
