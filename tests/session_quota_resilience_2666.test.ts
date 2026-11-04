/**
 * Issue #2666 (slice 2.11 second run, #1819 headroom) — session-store
 * quota resilience: provider limit-error classification + breaker.
 *
 * Tests written FIRST (TDD): this file must fail on the missing module
 * before the implementation lands. Coverage:
 * - The real DO rows-read message classifies as a limit error (it does
 *   NOT match the KV regex today — that is the gap).
 * - D1 free-tier read/write messages classify.
 * - The KV leg is reused (KV message, 429, "too many requests").
 * - Non-limit errors do NOT classify: "no such table", SQLITE_FULL
 *   (disk-full: reads still work per docs, only writes fail),
 *   generic errors, null/undefined.
 * - The breaker trips ONLY on limit errors, counts suppressed reads,
 *   never re-trips while blocked (no indefinite extension under
 *   sustained traffic), and resets via the test seam.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  __resetSessionStoreBreaker,
  isSessionStoreBreakerOpen,
  isSessionStoreLimitError,
  noteSuppressedSessionStoreRead,
  sessionStoreBreakerState,
  tripSessionStoreBreaker,
} from "../src/security/sessionQuotaResilience";

const DO_ROWS_READ =
  "Exceeded allowed rows read in Durable Objects free tier.";
const DO_ROWS_WRITTEN =
  "Exceeded allowed rows written in Durable Objects free tier.";
const D1_READ_LIMIT =
  "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
const D1_WRITE_LIMIT =
  "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
const KV_LIMIT = "KV get() limit exceeded for the day.";

describe("session-store limit classification (#2666)", () => {
  it("classifies the real DO rows-read message", () => {
    expect(isSessionStoreLimitError(new Error(DO_ROWS_READ))).toBe(true);
    expect(isSessionStoreLimitError(DO_ROWS_READ)).toBe(true);
  });

  it("classifies the DO rows-written message", () => {
    expect(isSessionStoreLimitError(new Error(DO_ROWS_WRITTEN))).toBe(true);
  });

  it("classifies D1 free-tier read/write limit messages", () => {
    expect(isSessionStoreLimitError(new Error(D1_READ_LIMIT))).toBe(true);
    expect(isSessionStoreLimitError(new Error(D1_WRITE_LIMIT))).toBe(true);
  });

  it("reuses the KV leg (KV message, 429, too many requests)", () => {
    expect(isSessionStoreLimitError(new Error(KV_LIMIT))).toBe(true);
    expect(isSessionStoreLimitError(new Error("429 Too Many Requests"))).toBe(
      true,
    );
    expect(isSessionStoreLimitError("too many requests")).toBe(true);
  });

  it("does NOT classify non-limit errors", () => {
    expect(isSessionStoreLimitError(new Error("no such table: usage_events"))).toBe(
      false,
    );
    // SQLITE_FULL is disk-full, not quota: reads still work per docs.
    expect(
      isSessionStoreLimitError(new Error("database or disk is full: SQLITE_FULL")),
    ).toBe(false);
    expect(isSessionStoreLimitError(new TypeError("boom"))).toBe(false);
    expect(isSessionStoreLimitError(null)).toBe(false);
    expect(isSessionStoreLimitError(undefined)).toBe(false);
  });
});

describe("session-store breaker (#2666)", () => {
  beforeEach(() => {
    __resetSessionStoreBreaker();
  });

  it("starts open-for-traffic (not blocked)", () => {
    expect(isSessionStoreBreakerOpen()).toBe(false);
    expect(sessionStoreBreakerState().suppressedReads).toBe(0);
  });

  it("trips only on limit errors", () => {
    tripSessionStoreBreaker(new Error("boom"));
    expect(isSessionStoreBreakerOpen()).toBe(false);
    tripSessionStoreBreaker(new Error(DO_ROWS_READ));
    expect(isSessionStoreBreakerOpen()).toBe(true);
    expect(sessionStoreBreakerState().lastError).toContain("rows read");
  });

  it("counts suppressed reads while blocked without re-tripping", () => {
    tripSessionStoreBreaker(new Error(DO_ROWS_READ));
    const blockedUntil = sessionStoreBreakerState().blockedUntil;
    noteSuppressedSessionStoreRead();
    noteSuppressedSessionStoreRead();
    const state = sessionStoreBreakerState();
    expect(state.suppressedReads).toBe(2);
    // Suppression must not extend the block (no indefinite extension
    // under sustained traffic): the deadline is unchanged.
    expect(state.blockedUntil).toBe(blockedUntil);
  });

  it("resets via the test seam", () => {
    tripSessionStoreBreaker(new Error(DO_ROWS_READ));
    expect(isSessionStoreBreakerOpen()).toBe(true);
    __resetSessionStoreBreaker();
    expect(isSessionStoreBreakerOpen()).toBe(false);
    expect(sessionStoreBreakerState().suppressedReads).toBe(0);
    expect(sessionStoreBreakerState().lastError).toBeNull();
  });
});
