/**
 * Visibility-aware polling (issue #329, plan item P1).
 *
 * Why: an idle dashboard tab spent ~24.5k requests/day — 21.6k of it on a 4 s
 * `/api/jobs` poll — and the Workers Free plan allows 100k requests/day *and*
 * 100k KV reads/day, spent one-per-request. Four left-open tabs therefore
 * exhausted the day's budget. Slowing the polls and stopping them while the tab
 * is hidden is the only change that moves that ceiling; the storage work in
 * #416 was about resilience, not capacity.
 *
 * Deliberately React-free: the scheduler is testable with fake timers and a fake
 * `document`, and the hook below is a thin `useEffect` wrapper.
 */

export interface PollSchedule {
  /** Cadence while `isBusy()` reports work in flight. */
  fastMs: number;
  /** Cadence while idle. */
  idleMs: number;
  /** Optional: true when the fast cadence is warranted (e.g. a running job). */
  isBusy?: () => boolean;
  /**
   * Issue #2376 slice 1 — run once at subscribe, then follow the cadence.
   * Surfaces that fetch on mount (saga status, journey gates, checkout
   * status) need the first fetch immediately, not after one cadence.
   * Default false preserves the existing schedule (first run after the
   * cadence) for every current caller. A hidden tab still runs nothing
   * until visible: the tick's hidden check wins over immediacy, and the
   * visibility handler runs the first tick when the tab returns.
   */
  immediate?: boolean;
  /** Injectable for tests; defaults to the global document. */
  doc?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
}

/**
 * Issue #4213 — the largest delay a timer can actually be armed with.
 *
 * `setTimeout`/`setInterval` take a signed 32-bit delay. A cadence above this
 * ceiling is out of contract: engines either wrap the value (3e12 wraps to
 * ~24.5 days on a WebIDL `long` conversion) or clamp it, and either way the
 * caller's intent — "poll effectively never", the shape #4213 sets for the
 * options-flow and goal-tracking cadences — depends on integer wrap rather
 * than on a stated rule. One value is all it takes to wrap to a *small* delay,
 * which would turn a cost cut into a poll storm.
 *
 * The scheduler therefore arms `min(cadence, MAX_TIMER_DELAY_MS)`: a cadence
 * above the ceiling still means "not in this session", and the behaviour is
 * identical on every engine instead of inherited from its integer conversion.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Clamp a cadence to what a timer can hold. Non-finite and negative values arm
 * immediately, which is the behaviour `setTimeout` already had for them.
 */
function armDelayMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(MAX_TIMER_DELAY_MS, ms);
}

/**
 * Runs `run` on a schedule that pauses while the tab is hidden and switches
 * cadence between idle and busy. Returns a stop function.
 *
 * Schedule is computed *after* each run settles, so a poll that discovers a
 * newly-queued job immediately moves to the fast cadence.
 */
export function startPolling(
  run: () => void | Promise<void>,
  schedule: PollSchedule
): () => void {
  const doc = schedule.doc ?? (typeof document === "undefined" ? undefined : document);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const isHidden = () => doc?.visibilityState === "hidden";

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const delay = () => (schedule.isBusy?.() ? schedule.fastMs : schedule.idleMs);

  const arm = () => {
    clear();
    if (stopped || isHidden()) return;
    timer = setTimeout(() => void tick(), armDelayMs(delay()));
  };

  const tick = async () => {
    if (stopped) return;
    if (isHidden()) {
      // Hidden mid-flight: stop scheduling; the visibility handler resumes.
      clear();
      return;
    }
    try {
      await run();
    } catch {
      // A poll failure must never break the schedule; callers surface their own
      // error state.
    }
    arm();
  };

  const onVisibility = () => {
    if (isHidden()) {
      clear();
      return;
    }
    // Back in view: fetch immediately, then resume the cadence.
    void tick();
  };

  doc?.addEventListener("visibilitychange", onVisibility);
  if (schedule.immediate) {
    // First run now, then the cadence (after the run settles, as usual).
    void tick();
  } else {
    arm();
  }

  return () => {
    stopped = true;
    clear();
    doc?.removeEventListener("visibilitychange", onVisibility);
  };
}
