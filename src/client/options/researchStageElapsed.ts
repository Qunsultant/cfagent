/**
 * Issue #6466 part 1 — every run stage shows its elapsed time, always.
 *
 * The stage read already returns startedAt / endedAt / durationMs for every
 * stage; the panel rendered the time only when durationMs was a number, so a
 * running or timed-out stage showed nothing. This pure rule is the one place
 * the display decision lives, so the panel and its tests judge it the same way:
 *
 * - a recorded durationMs wins (finished, or failed with a duration) — the
 *   recorded truth, whatever the status;
 * - a running stage shows live elapsed time from startedAt (now - started);
 * - a timed-out / failed / stopped stage without a duration shows
 *   endedAt - startedAt;
 * - a stage that never started shows nothing (null) — never an invented 0.
 */
export interface StageElapsedInput {
  status: string;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Elapsed milliseconds for one stage row, or null when it never started. */
export function elapsedMsForStage(row: StageElapsedInput, nowMs: number): number | null {
  if (typeof row.durationMs === "number") return Math.max(0, row.durationMs);
  const startedAt = parseTime(row.startedAt);
  if (startedAt === null) return null;
  if (row.status === "running") return Math.max(0, nowMs - startedAt);
  const endedAt = parseTime(row.endedAt);
  if (endedAt === null) return null;
  return Math.max(0, endedAt - startedAt);
}
