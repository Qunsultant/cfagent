/**
 * Issue #2666 (slice 2.11 second run, #1819 headroom) — wired session
 * validation under store quota exhaustion: degraded serve, never a
 * hard failure, never a resurrection.
 *
 * Tests written FIRST (TDD): this file must fail before the fallback
 * lands in validateAndTouchWiredSession. Coverage:
 * - freshRead throws a DO limit error + locally-valid cached session
 *   → the cached session is served degraded (degraded: true), the
 *   breaker trips, no persist happens, cache is NOT invalidated.
 * - freshRead throws a DO limit error + idle-expired cached session
 *   → the throw propagates (fail closed: an expired session never
 *   serves, even degraded).
 * - freshRead throws a NON-limit error → propagates unchanged, no
 *   breaker trip, no fallback.
 * - freshRead returns null (store answered "record gone") → still
 *   DENIES with session null + invalidate (authoritative answer,
 *   never resurrected from cache — the security pin).
 * - Breaker already open + valid cached → served with ZERO
 *   freshRead calls (conservation: no doomed store read).
 * - Breaker already open + expired cached → throws a quota error
 *   (typed 503 downstream, never a false "unauthenticated" null).
 * - Success path unchanged: stale copy + healthy freshRead still
 *   validates + touches exactly as today.
 */
import { describe, expect, it, beforeEach } from "vitest";
import type { SessionData } from "../src/types";
import {
  validateAndTouchWiredSession,
  type WiredSessionStoreDeps,
} from "../src/security/iaaaEnforcement";
import {
  __resetSessionStoreBreaker,
  isSessionStoreBreakerOpen,
} from "../src/security/sessionQuotaResilience";

const NOW_MS = 1_060_000;
const WINDOW_MS = 30_000;
const IDLE_TIMEOUT_MS = 1_800_000;

const DO_ROWS_READ =
  "Exceeded allowed rows read in Durable Objects free tier.";

function wiredSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    githubLogin: "octo",
    githubAvatar: "",
    githubName: "Octo",
    createdAt: 1_000_000,
    internalUserId: "user-1",
    providerIssuer: "https://github.com",
    providerSubject: "42",
    authTimeMs: 1_000_000,
    sessionVersion: 1,
    lastActivityMs: 1_000_000,
    ...overrides,
  };
}

function staleOptions() {
  return {
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    fetchedAtMs: NOW_MS - 60_000,
    freshnessWindowMs: WINDOW_MS,
  };
}

function throwingDeps(error: Error) {
  const deps: WiredSessionStoreDeps & {
    freshReads: number;
    persists: number;
    invalidates: string[];
  } = {
    freshReads: 0,
    persists: 0,
    invalidates: [] as string[],
    async freshRead() {
      deps.freshReads += 1;
      throw error;
    },
    async persist() {
      deps.persists += 1;
      return { ok: true };
    },
    invalidate(sessionId: string) {
      deps.invalidates.push(sessionId);
    },
  };
  return deps;
}

describe("wired validation under store quota exhaustion (#2666)", () => {
  beforeEach(() => {
    __resetSessionStoreBreaker();
  });

  it("limit throw + valid cached → degraded serve, breaker tripped, no persist, no invalidate", async () => {
    const cached = wiredSession();
    const deps = throwingDeps(new Error(DO_ROWS_READ));
    const result = await validateAndTouchWiredSession(
      deps,
      cached,
      "sess-1",
      NOW_MS,
      staleOptions(),
    );
    expect(result.wired).toBe(true);
    if (!result.wired || !result.session) throw new Error("expected a session");
    expect(result.session.githubLogin).toBe("octo");
    expect(
      (result as { degraded?: boolean }).degraded,
    ).toBe(true);
    expect(deps.freshReads).toBe(1);
    expect(deps.persists).toBe(0);
    expect(deps.invalidates).toEqual([]);
    expect(isSessionStoreBreakerOpen()).toBe(true);
  });

  it("limit throw + idle-expired cached → throw propagates (fail closed)", async () => {
    const cached = wiredSession({ lastActivityMs: NOW_MS - 2_000_000 });
    const deps = throwingDeps(new Error(DO_ROWS_READ));
    await expect(
      validateAndTouchWiredSession(deps, cached, "sess-1", NOW_MS, staleOptions()),
    ).rejects.toThrow(DO_ROWS_READ);
    expect(isSessionStoreBreakerOpen()).toBe(true);
  });

  it("non-limit throw → propagates unchanged, no breaker trip", async () => {
    const cached = wiredSession();
    const deps = throwingDeps(new TypeError("boom"));
    await expect(
      validateAndTouchWiredSession(deps, cached, "sess-1", NOW_MS, staleOptions()),
    ).rejects.toThrow("boom");
    expect(isSessionStoreBreakerOpen()).toBe(false);
  });

  it("freshRead null (record gone) → still denies, never resurrects", async () => {
    const cached = wiredSession();
    const deps: WiredSessionStoreDeps & { invalidates: string[] } = {
      invalidates: [] as string[],
      async freshRead() {
        return null;
      },
      async persist() {
        return { ok: true };
      },
      invalidate(sessionId: string) {
        deps.invalidates.push(sessionId);
      },
    };
    const result = await validateAndTouchWiredSession(
      deps,
      cached,
      "sess-1",
      NOW_MS,
      staleOptions(),
    );
    expect(result).toEqual({ wired: true, session: null });
    expect(deps.invalidates).toEqual(["sess-1"]);
    expect(isSessionStoreBreakerOpen()).toBe(false);
  });

  it("breaker open + valid cached → served with ZERO freshRead calls", async () => {
    const cached = wiredSession();
    const tripper = throwingDeps(new Error(DO_ROWS_READ));
    await expect(
      validateAndTouchWiredSession(tripper, cached, "sess-1", NOW_MS, staleOptions()),
    ).resolves.toBeDefined();
    expect(isSessionStoreBreakerOpen()).toBe(true);
    const deps = throwingDeps(new Error(DO_ROWS_READ));
    const result = await validateAndTouchWiredSession(
      deps,
      cached,
      "sess-1",
      NOW_MS,
      staleOptions(),
    );
    expect(deps.freshReads).toBe(0);
    expect(result.wired).toBe(true);
    if (!result.wired || !result.session) throw new Error("expected a session");
    expect((result as { degraded?: boolean }).degraded).toBe(true);
  });

  it("breaker open + expired cached → throws a quota error (never a false null)", async () => {
    const cached = wiredSession();
    const tripper = throwingDeps(new Error(DO_ROWS_READ));
    await expect(
      validateAndTouchWiredSession(tripper, cached, "sess-1", NOW_MS, staleOptions()),
    ).resolves.toBeDefined();
    const expired = wiredSession({ lastActivityMs: NOW_MS - 2_000_000 });
    const deps = throwingDeps(new Error(DO_ROWS_READ));
    await expect(
      validateAndTouchWiredSession(deps, expired, "sess-1", NOW_MS, staleOptions()),
    ).rejects.toThrow(/quota/i);
    expect(deps.freshReads).toBe(0);
  });

  it("success path unchanged: stale copy + healthy freshRead validates + touches", async () => {
    const cached = wiredSession();
    // Touch interval is 300s: fresh last activity >300s old → touch.
    const fresh = wiredSession({ lastActivityMs: NOW_MS - 301_000 });
    const deps: WiredSessionStoreDeps & {
      freshReads: number;
      persists: number;
      invalidates: string[];
    } = {
      freshReads: 0,
      persists: 0,
      invalidates: [] as string[],
      async freshRead() {
        deps.freshReads += 1;
        return fresh;
      },
      async persist() {
        deps.persists += 1;
        return { ok: true };
      },
      invalidate(sessionId: string) {
        deps.invalidates.push(sessionId);
      },
    };
    const result = await validateAndTouchWiredSession(
      deps,
      cached,
      "sess-1",
      NOW_MS,
      staleOptions(),
    );
    expect(deps.freshReads).toBe(1);
    expect(deps.persists).toBe(1);
    expect(result.wired).toBe(true);
    if (!result.wired || !result.session) throw new Error("expected a session");
    expect(result.session.lastActivityMs).toBe(NOW_MS);
    expect((result as { degraded?: boolean }).degraded).toBeUndefined();
    expect(isSessionStoreBreakerOpen()).toBe(false);
  });
});
