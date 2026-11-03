/**
 * Issue #2840 (#2837 sub-issue, Q2) — the scheduled-goal
 * in-flight firing claim: the screen-lock pattern, extended to
 * goals.
 *
 * THE GAP IT CLOSES: addGoal already refuses a duplicate goal
 * id, but nothing stopped two submissions of the SAME goal
 * from firing concurrently — a manual trigger from browser
 * session B while session A's trigger (or the cron tick) was
 * still running fired the goal a second time, because the
 * forced path bypasses the isDue check. Goals live on the
 * shared ScheduledAgent "default" instance, so visibility was
 * never the problem (any signed-in session lists the same
 * goals, ticks, and per-run records); the missing piece was
 * the in-flight guard itself.
 *
 * CLAIM MECHANICS (two layers, same verdict):
 * - In-memory claim on the instance (synchronous check-and-
 *   set, so same-isolate concurrency is decided atomically by
 *   the JS event loop: no await sits between the check and
 *   the set).
 * - Durable marker in the instance's ctx.storage, so a firing
 *   that survives an isolate restart still reads as in flight
 *   to the next isolate until the stale window passes.
 * A second submitter while either layer holds a fresh claim
 * gets "already in flight" with the first run's id — never a
 * duplicate firing, never a silent skip.
 *
 * RELEASE IS A COMPLETED MARKER, NOT A DELETE: the finally
 * overwrites the marker with status "completed" via put, so
 * release needs no delete method (test doubles and stores
 * that only offer get/put still release correctly — a
 * delete-based release left the marker behind on such
 * stores and wedged the next re-fire, found by the #1224
 * pipeline re-fire test). A completed marker never blocks a
 * later claim; only a "running" marker does.
 *
 * STALE WINDOW (30 minutes, the stuck-run alert horizon):
 * a marker older than this is takeover-eligible. Trade-off,
 * stated plainly: a firing whose isolate dies mid-run blocks
 * re-firing for up to the window, and a second submitter
 * inside the window is told "in flight" on marker evidence
 * alone (the same honesty level as the screen lock's 5-minute
 * stale window). The marker is completed in a finally on
 * every firing exit, so only a crash leaves a "running"
 * marker behind.
 *
 * RUN ID: `goal:<goalId>:<startedMs>` — deterministic from
 * the claim, shared by both submitters, and the key the second
 * submitter uses to find the first run's per-run record
 * (listJobRuns, same goal id, same shared instance).
 */

/** Stale window for a firing marker (matches the stuck-run alert horizon). */
export const GOAL_FIRING_STALE_MS = 30 * 60 * 1000;

export interface GoalFiringMarker {
  runId: string;
  startedMs: number;
  triggeredBy: "manual" | "scheduled";
  /** "running" blocks a later claim; "completed" never does. */
  status: "running" | "completed";
}

/** Durable marker key in the ScheduledAgent instance storage. */
export function goalFiringKey(goalId: string): string {
  return `goalFiring:${goalId}`;
}

/** Deterministic run id for one firing claim. */
export function goalFiringRunId(goalId: string, startedMs: number): string {
  return `goal:${goalId}:${startedMs}`;
}

/**
 * Stale boundary: exactly STALE_MS old still counts as in
 * flight (mirrors the screen lock's boundary rule); older
 * than that is takeover-eligible.
 */
export function isGoalFiringStale(marker: GoalFiringMarker, nowMs: number): boolean {
  return nowMs - marker.startedMs > GOAL_FIRING_STALE_MS;
}

function isMarker(value: unknown): value is GoalFiringMarker {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  // A marker written before the status field existed (or by a
  // hand-rolled store) reads as "running" — fail-closed toward
  // the in-flight verdict, never toward a silent duplicate.
  return (
    typeof m.runId === "string" &&
    m.runId.length > 0 &&
    typeof m.startedMs === "number" &&
    Number.isFinite(m.startedMs) &&
    (m.triggeredBy === "manual" || m.triggeredBy === "scheduled") &&
    (m.status === undefined || m.status === "running" || m.status === "completed")
  );
}

/** A stored marker's status, defaulting a status-less marker to "running". */
function markerStatus(marker: GoalFiringMarker): "running" | "completed" {
  return marker.status ?? "running";
}

export type GoalFiringClaimResult =
  | { claimed: true; runId: string }
  | { claimed: false; runId: string };

/**
 * Claim one goal's firing, synchronously for the in-memory
 * layer (atomic within the isolate) and durably for the
 * marker layer. `readMarker`/`writeMarker` are the instance
 * storage seams; both are awaited only AFTER the in-memory
 * decision, so a concurrent same-isolate contender can never
 * interleave between check and set.
 *
 * Returns claimed:false with the holder's run id when either
 * layer holds a fresh RUNNING claim. A completed marker never
 * blocks (the previous firing finished — the new claim simply
 * overwrites it). A stale marker in either layer is taken
 * over (the new claim replaces it). A storage error
 * propagates — the caller fails that goal's firing visibly
 * rather than firing without a provable claim.
 */
export async function claimGoalFiring(
  inMemory: Map<string, GoalFiringMarker>,
  deps: {
    goalId: string;
    triggeredBy: "manual" | "scheduled";
    nowMs: number;
    readMarker: () => Promise<unknown>;
    writeMarker: (marker: GoalFiringMarker) => Promise<void>;
  },
): Promise<GoalFiringClaimResult> {
  const existing = inMemory.get(deps.goalId);
  if (existing && !isGoalFiringStale(existing, deps.nowMs)) {
    return { claimed: false, runId: existing.runId };
  }
  const stored = await deps.readMarker();
  if (isMarker(stored) && markerStatus(stored) === "running" && !isGoalFiringStale(stored, deps.nowMs)) {
    // A live firing from a previous isolate: seed the map so
    // later same-isolate claims agree, and report in flight.
    inMemory.set(deps.goalId, stored);
    return { claimed: false, runId: stored.runId };
  }
  const marker: GoalFiringMarker = {
    runId: goalFiringRunId(deps.goalId, deps.nowMs),
    startedMs: deps.nowMs,
    triggeredBy: deps.triggeredBy,
    status: "running",
  };
  inMemory.set(deps.goalId, marker);
  try {
    await deps.writeMarker(marker);
  } catch (err) {
    // A failed durable write must not leave a memory-only claim
    // behind: the next contender would read "in flight" for a
    // firing with no durable evidence. Release, then propagate.
    if (inMemory.get(deps.goalId)?.runId === marker.runId) {
      inMemory.delete(deps.goalId);
    }
    throw err;
  }
  return { claimed: true, runId: marker.runId };
}

/**
 * Release a firing claim, but only when this caller holds it
 * (run-id match — never frees another firing's claim). The
 * release overwrites the durable marker with status
 * "completed" via put (no delete needed): a later claim reads
 * it as free, while a crashed firing's "running" marker still
 * blocks until its stale window passes. The write is
 * best-effort: a failed write leaves a "running" marker that
 * goes stale on its own window, and must never fail a firing
 * that already completed. A release for a claim this caller
 * does not hold (another firing took over) is a no-op — it
 * must never overwrite the new firing's marker.
 */
export async function releaseGoalFiring(
  inMemory: Map<string, GoalFiringMarker>,
  deps: {
    goalId: string;
    runId: string;
    writeMarker: (marker: GoalFiringMarker) => Promise<void>;
  },
): Promise<void> {
  const held = inMemory.get(deps.goalId);
  if (!held || held.runId !== deps.runId) {
    return;
  }
  inMemory.delete(deps.goalId);
  try {
    await deps.writeMarker({ ...held, status: "completed" });
  } catch {
    // Best-effort: the stale window reaps the marker.
  }
}
