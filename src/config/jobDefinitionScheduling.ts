/**
 * Issue #4366 — the definition-scheduling config seam.
 *
 * A definition scheduled from UX creates a unified schedule whose callback
 * is an Orchestrator host method. The name is configuration, not a literal
 * in two places: the route that creates the schedule and the client that
 * asks for it read the same constant.
 *
 * The dynamic-host-declaration alternative (teaching the Think host to
 * re-declare on definition change) is out of scope for this issue and is
 * filed as its own sub-issue under #4366.
 */

export const JOB_DEFINITION_SCHEDULE_CALLBACK = "runPipelineJobSchedule";

/** A deterministic, readable job id for a spec instance. */
export function jobIdForSpec(specId: string, nowMs: number = Date.now()): string {
  return `jobdef:${specId}:${new Date(nowMs).toISOString()}`;
}
