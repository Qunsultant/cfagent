/**
 * Issue #3992 PR-1 — deadline substrate pins.
 *
 * A feed run could hang forever and record nothing (incident
 * #3976's live confirmation): every awaited leg of a feed run —
 * the index refresh, the provider fetch, the capture write — was
 * a bare await with no bound, and the pipeline execution awaiting
 * the run had no deadline of its own. This PR is the SUBSTRATE
 * only: the timeout catalogue, the four leg codes, and the race
 * helper the later PRs wire into the runners. No runner,
 * pipeline, or provider behaviour changes here.
 *
 * Pins:
 *  1. Catalogue: FEED_JOB_TIMEOUTS carries the four recorded
 *     bounds (refresh / fetch / capture / execution), each a
 *     positive finite number, each strictly below the async
 *     executor's 90-minute backstop, the execution bound above
 *     every leg bound.
 *  2. Codes: FEED_JOB_CODES gains exactly the four timeout
 *     entries, pairwise distinct and colliding with no
 *     pre-existing value in the map.
 *  3. Helper: withFeedDeadline propagates an early settle
 *     unchanged (value or original error), rejects a
 *     never-settling leg at the bound with a FeedJobTimeoutError
 *     carrying the leg's code, leaves no dangling timer after
 *     any settle, settles exactly once even if the work resolves
 *     late, and refuses a non-positive or non-finite bound by
 *     name — synchronously, before any timer exists.
 *  4. The injected timers seam is honoured: scheduling and
 *     clearing go through it, and firing it produces the
 *     timeout rejection.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FEED_JOB_TIMEOUTS,
  FeedJobTimeoutError,
  withFeedDeadline,
  type FeedDeadlineTimers,
} from "../src/services/feedJobTimeouts";
import { FEED_JOB_CODES } from "../src/services/feedJobs";

/** The async executor's backstop: ASYNC_JOB_MAX_RUNTIME_MINUTES,
 *  default 90 (src/agents/orchestrator/asyncJobs.ts). Every feed
 *  bound must sit far below it so a leg failure is recorded as a
 *  feed failure long before the executor kills the job. */
const EXECUTOR_BACKSTOP_MS = 90 * 60 * 1000;

describe("FEED_JOB_TIMEOUTS catalogue (#3992 PR-1)", () => {
  it("carries the four bounds recorded on the issue", () => {
    expect(FEED_JOB_TIMEOUTS.refreshMs).toBe(30_000);
    expect(FEED_JOB_TIMEOUTS.fetchMs).toBe(60_000);
    expect(FEED_JOB_TIMEOUTS.captureMs).toBe(30_000);
    expect(FEED_JOB_TIMEOUTS.executionMs).toBe(240_000);
  });

  it("every bound is a positive finite number", () => {
    for (const [name, bound] of Object.entries(FEED_JOB_TIMEOUTS)) {
      expect(Number.isFinite(bound), `${name} must be finite`).toBe(true);
      expect(bound, `${name} must be positive`).toBeGreaterThan(0);
    }
  });

  it("every bound sits strictly below the executor's 90-minute backstop", () => {
    for (const [name, bound] of Object.entries(FEED_JOB_TIMEOUTS)) {
      expect(bound, `${name} must be below the backstop`).toBeLessThan(EXECUTOR_BACKSTOP_MS);
    }
  });

  it("the execution bound exceeds every leg bound", () => {
    const legs = [FEED_JOB_TIMEOUTS.refreshMs, FEED_JOB_TIMEOUTS.fetchMs, FEED_JOB_TIMEOUTS.captureMs];
    expect(FEED_JOB_TIMEOUTS.executionMs).toBeGreaterThan(Math.max(...legs));
  });
});

describe("FEED_JOB_CODES timeout entries (#3992 PR-1)", () => {
  it("names the four timeout codes", () => {
    expect(FEED_JOB_CODES.refreshTimeout).toBe("FEED_REFRESH_TIMEOUT");
    expect(FEED_JOB_CODES.fetchTimeout).toBe("FEED_FETCH_TIMEOUT");
    expect(FEED_JOB_CODES.captureTimeout).toBe("FEED_CAPTURE_TIMEOUT");
    expect(FEED_JOB_CODES.deadlineExceeded).toBe("FEED_DEADLINE_EXCEEDED");
  });

  it("the four timeout codes are pairwise distinct", () => {
    const codes = [
      FEED_JOB_CODES.refreshTimeout,
      FEED_JOB_CODES.fetchTimeout,
      FEED_JOB_CODES.captureTimeout,
      FEED_JOB_CODES.deadlineExceeded,
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("no value in FEED_JOB_CODES collides with any other", () => {
    const values = Object.values(FEED_JOB_CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("FeedJobTimeoutError (#3992 PR-1)", () => {
  it("is an Error carrying the stable code it was raised with", () => {
    const error = new FeedJobTimeoutError("FEED_FETCH_TIMEOUT", 60_000);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("FeedJobTimeoutError");
    expect(error.code).toBe("FEED_FETCH_TIMEOUT");
    expect(error.message).toContain("FEED_FETCH_TIMEOUT");
  });
});

describe("withFeedDeadline (#3992 PR-1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the work's value when the work settles first", async () => {
    vi.useFakeTimers();
    const result = withFeedDeadline(Promise.resolve("quotes"), 1_000, FEED_JOB_CODES.fetchTimeout);
    await expect(result).resolves.toBe("quotes");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates the work's original rejection unchanged", async () => {
    vi.useFakeTimers();
    const boom = new Error("provider exploded");
    const result = withFeedDeadline(Promise.reject(boom), 1_000, FEED_JOB_CODES.fetchTimeout);
    await expect(result).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is still pending 1ms before the bound and rejects with the leg's code at it", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => undefined);
    let settled = false;
    let rejection: unknown;
    const result = withFeedDeadline(never, 1_000, FEED_JOB_CODES.fetchTimeout);
    void result.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        rejection = error;
      },
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(rejection).toBeInstanceOf(FeedJobTimeoutError);
    expect((rejection as FeedJobTimeoutError).code).toBe("FEED_FETCH_TIMEOUT");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles exactly once: a late resolution after the timeout changes nothing", async () => {
    vi.useFakeTimers();
    let resolveWork: ((value: string) => void) | undefined;
    const work = new Promise<string>((resolve) => {
      resolveWork = resolve;
    });
    const outcomes: string[] = [];
    const result = withFeedDeadline(work, 500, FEED_JOB_CODES.deadlineExceeded);
    void result.then(
      (value) => outcomes.push(`resolved:${value}`),
      (error: unknown) => outcomes.push(`rejected:${(error as FeedJobTimeoutError).code}`),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(outcomes).toEqual(["rejected:FEED_DEADLINE_EXCEEDED"]);
    resolveWork?.("late quotes");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcomes).toEqual(["rejected:FEED_DEADLINE_EXCEEDED"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses the non-positive or non-finite bound %s by name, before any timer exists",
    (bound) => {
      vi.useFakeTimers();
      let message = "";
      try {
        void withFeedDeadline(Promise.resolve("x"), bound, FEED_JOB_CODES.fetchTimeout);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("bound");
      expect(message).toContain(String(bound));
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("schedules and clears through the injected timers seam", async () => {
    const scheduled: Array<() => void> = [];
    const cleared: unknown[] = [];
    const timers: FeedDeadlineTimers = {
      setTimeout: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      clearTimeout: (handle) => {
        cleared.push(handle);
      },
    };
    const result = withFeedDeadline(Promise.resolve("x"), 100, FEED_JOB_CODES.captureTimeout, timers);
    await expect(result).resolves.toBe("x");
    expect(scheduled).toHaveLength(1);
    expect(cleared).toHaveLength(1);
  });

  it("rejects with the leg's code when the injected timer fires", async () => {
    let fire: (() => void) | undefined;
    const timers: FeedDeadlineTimers = {
      setTimeout: (callback) => {
        fire = callback;
        return 1;
      },
      clearTimeout: () => undefined,
    };
    const result = withFeedDeadline(
      new Promise<string>(() => undefined),
      100,
      FEED_JOB_CODES.captureTimeout,
      timers,
    );
    const assertion = expect(result).rejects.toBeInstanceOf(FeedJobTimeoutError);
    fire?.();
    await assertion;
    await expect(result).rejects.toMatchObject({ code: "FEED_CAPTURE_TIMEOUT" });
  });
});
