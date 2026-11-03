import { useEffect, useRef } from "react";
import { startPolling, type PollSchedule } from "./polling";

/**
 * React wrapper around `startPolling` (issue #329, P1).
 *
 * Callbacks are held in refs so a re-render never restarts the schedule — only
 * the cadences do. `isBusy` is likewise read through a ref, so the poll can
 * change cadence without re-subscribing.
 */
export function usePolling(
  run: () => void | Promise<void>,
  schedule: Omit<PollSchedule, "isBusy"> & {
    isBusy?: () => boolean;
    /**
     * Issue #2481 — the global auto-refresh gate. When false, no
     * timer is started at all (OFF = no periodic refresh); when it
     * flips to true the effect re-subscribes and polling resumes.
     * Defaults to true so callers that have their own gate (or no
     * periodic refresh to gate) keep their existing behaviour.
     */
    enabled?: boolean;
  }
): void {
  const runRef = useRef(run);
  const busyRef = useRef(schedule.isBusy);
  runRef.current = run;
  busyRef.current = schedule.isBusy;

  const { fastMs, idleMs, enabled = true, immediate } = schedule;

  useEffect(() => {
    if (!enabled) return;
    return startPolling(
      () => runRef.current(),
      {
        fastMs,
        idleMs,
        immediate,
        isBusy: busyRef.current ? () => busyRef.current?.() ?? false : undefined,
      }
    );
  }, [fastMs, idleMs, enabled, immediate]);
}
