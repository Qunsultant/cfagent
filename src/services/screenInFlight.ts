/**
 * Issue #2840 (#2837 sub-issue, Q2) — the screen second-submitter
 * contract: "already in flight" with the run's id and status.
 *
 * The screen run lock (ScreenRunLockPort, #1993) already proves
 * per-USER dedup: its scope is (userLogin, universe) on the
 * per-owner ScreenerAgent instance, so a second browser session
 * for the same user hits the same lock as the first — the lock
 * never sees a browser session id at all. What was missing was
 * the second submitter's answer: the refusal carried only the
 * universe and the holder's age, no run id and no status, and
 * the routes returned a bare 429 message.
 *
 * RUN ID WITHOUT A SCHEMA CHANGE: the lock row carries no run
 * id (adding a column would need a v2 migration for managed
 * instances plus an ALTER path for legacy-created tables, for a
 * value the holder's startedAt already determines). The
 * in-flight run id is therefore DERIVED, deterministically,
 * from the lock's own key + holder start:
 * `screen:<userLogin>:<universe>:<startedAtMs>`. Two submitters
 * refused by the same holder row derive the same id; a new run
 * after release derives a different one (a new startedAt). The
 * id names the in-flight run for the second submitter's retry
 * and for support; it is not a storage key and never a secret
 * (no token is ever embedded — the holder's release token
 * stays in the lock row only).
 *
 * STATUS: the probe's vocabulary is binary — "running" while
 * the row is fresh (inside the 5-minute stale window), "idle"
 * otherwise. A stale row is takeover-eligible, not in flight,
 * so it reports no run id. The second submitter's result
 * visibility needs no new surface: results live on the same
 * per-owner instance (getLatest/getHistory), so the second
 * session reads the first session's completed result there.
 */

/** In-flight run status in the probe/second-submitter vocabulary. */
export type ScreenInFlightStatus = "running" | "idle";

export interface ScreenInFlightProbe {
  running: boolean;
  startedAt: number | null;
  /** The in-flight run id while running; null when idle. */
  runId: string | null;
  status: ScreenInFlightStatus;
}

/**
 * Deterministic in-flight run id for one lock holder row.
 * Stable across submitters refused by the same row.
 */
export function screenRunIdFor(
  userLogin: string,
  universe: string,
  startedAtMs: number,
): string {
  return `screen:${userLogin}:${universe}:${startedAtMs}`;
}

/**
 * Extend a lock probe ({running, startedAt}) with the run id +
 * status the second submitter is shown. A running probe with
 * no startedAt (should not happen — the port always reports
 * one for a live row) degrades to status running with a null
 * run id rather than an invented one.
 */
export function screenInFlightFromProbe(
  probe: { running: boolean; startedAt: number | null },
  userLogin: string,
  universe: string,
): ScreenInFlightProbe {
  if (!probe.running) {
    return { running: false, startedAt: probe.startedAt, runId: null, status: "idle" };
  }
  return {
    running: true,
    startedAt: probe.startedAt,
    runId:
      typeof probe.startedAt === "number" && Number.isFinite(probe.startedAt)
        ? screenRunIdFor(userLogin, universe, probe.startedAt)
        : null,
    status: "running",
  };
}

/**
 * The lock-refusal message runScreen throws. The historical
 * prefix ("Screen already running for <universe> (started
 * <age>s ago)") is preserved verbatim — the #832 routes match
 * on "already running" — with the run id + status appended so
 * the second submitter can name the run it is waiting on.
 */
export function formatScreenAlreadyRunning(
  userLogin: string,
  universe: string,
  startedAtMs: number | null,
  nowMs: number,
): string {
  const age = startedAtMs ? Math.round((nowMs - startedAtMs) / 1000) : 0;
  const runId =
    typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
      ? screenRunIdFor(userLogin, universe, startedAtMs)
      : "unknown";
  return (
    `Screen already running for ${universe} (started ${age}s ago). ` +
    `Run ${runId} is already in flight (status: running). Please wait for it to complete.`
  );
}

/** The error runScreen throws on a lock refusal, carrying the run id + status as fields. */
export class ScreenAlreadyRunningError extends Error {
  public readonly runId: string | null;
  public readonly status: ScreenInFlightStatus = "running";
  public readonly universe: string;
  public readonly startedAt: number | null;
  constructor(userLogin: string, universe: string, startedAtMs: number | null, nowMs: number) {
    super(formatScreenAlreadyRunning(userLogin, universe, startedAtMs, nowMs));
    this.name = "ScreenAlreadyRunningError";
    this.universe = universe;
    this.startedAt = startedAtMs;
    this.runId =
      typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
        ? screenRunIdFor(userLogin, universe, startedAtMs)
        : null;
  }
}

/**
 * Read run id + status off a thrown lock refusal (typed error,
 * or any error whose message carries the #2840 run-id shape).
 * Returns null when the error is not a lock refusal — routes
 * keep their historical bare-429 shape in that case.
 */
export function screenAlreadyRunningDetails(error: unknown): {
  runId: string | null;
  status: ScreenInFlightStatus;
} | null {
  if (error instanceof ScreenAlreadyRunningError) {
    return { runId: error.runId, status: "running" };
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message.includes("already running")) return null;
  const match = message.match(/Run (screen:\S+) is already in flight \(status: running\)/);
  return { runId: match ? match[1] : null, status: "running" };
}
