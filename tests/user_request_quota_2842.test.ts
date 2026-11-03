/**
 * Issue #2842 (#2837 sub-issue) — per-user report-run quota.
 *
 * RED first: these tests fail until the slice lands. Coverage:
 * - Phase 0 kind matrix: screen + goalScreen consume; research
 *   consumes-in-principle with enforcement carried (different DO
 *   instance, no shared counter store yet); downloads, reads,
 *   chat turns, orchestrator jobs / workflows without a screen,
 *   non-report goal ticks, and the canonical-store seam never
 *   consume.
 * - UTC calendar windows: day/week/month keys, boundaries, and
 *   reset times; the week starts Monday 00:00 UTC.
 * - Config: one initial value set for all tiers (daily 10,
 *   weekly 70, monthly 300), marked pending; env overrides;
 *   invalid values fall back to the defaults, never to 0 or
 *   unlimited; an unrecognized enabled value fails closed to
 *   enabled.
 * - Counters (in-memory + DO-SQLite adapters): idempotent on
 *   run id, tenant isolation, overrides (active add to the
 *   limit, expired do not), over-quota refusal charges nothing.
 * - Gate: enforced before any run starts; over-quota throws a
 *   fail-visible error carrying limit, usage, and reset time
 *   in a message that survives the DO RPC boundary (parsed
 *   back by quotaExceededDetails); a counter-store failure
 *   fails closed (quota unavailable), never fail-open.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_USER_REQUEST_QUOTA,
  USER_REQUEST_QUOTA_WINDOWS,
  quotaConsumptionVerdict,
  quotaWindowBounds,
  quotaWindowEndForKey,
  quotaWindowKey,
  resolveUserRequestQuota,
  checkAndChargeUserRequestQuota,
  getUserRequestQuotaUsage,
  quotaExceededDetails,
  UserRequestQuotaExceededError,
  UserRequestQuotaUnavailableError,
  type UserRequestQuotaPolicy,
} from "../src/security/userRequestQuota";
import {
  createInMemoryUserRequestQuotaPort,
  createUserRequestQuotaPort,
} from "../src/data/createUserRequestQuotaPorts";
import type { UserRequestQuotaPort } from "../src/data/userRequestQuotaPorts";

/** node:sqlite stand-in for the DO SqlStorage seam (exec-only). */
function sqliteSeam() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...args: unknown[]): Iterable<unknown> {
      const trimmed = query.trim().toUpperCase();
      if (trimmed.startsWith("SELECT")) {
        return db.prepare(query).all(...(args as never[])) as unknown[];
      }
      db.prepare(query).run(...(args as never[]));
      return [];
    },
  };
}

function policy(overrides: Partial<UserRequestQuotaPolicy> = {}): UserRequestQuotaPolicy {
  return {
    enabled: true,
    daily: DEFAULT_USER_REQUEST_QUOTA.daily,
    weekly: DEFAULT_USER_REQUEST_QUOTA.weekly,
    monthly: DEFAULT_USER_REQUEST_QUOTA.monthly,
    ...overrides,
  };
}

const NOW = Date.UTC(2026, 10, 3, 15, 30, 0); // Tue 2026-11-03 15:30 UTC

describe("kind matrix (Phase 0)", () => {
  it("screen and goalScreen consume quota", () => {
    expect(quotaConsumptionVerdict("screen").verdict).toBe("consumes");
    expect(quotaConsumptionVerdict("goalScreen").verdict).toBe("consumes");
  });
  it("research consumes in principle but enforcement is carried", () => {
    const v = quotaConsumptionVerdict("research");
    expect(v.verdict).toBe("consumes-deferred");
    expect(v.reason).toMatch(/OrchestratorAgent/);
  });
  it("reads, downloads, chat, and non-report runs never consume", () => {
    for (const kind of [
      "discovery-download",
      "report-read",
      "chat",
      "nlq-no-screen",
      "orchestrator-job",
      "workflow-no-screen",
      "goal-tick-no-report",
      "scheduled-report-store",
    ]) {
      expect(quotaConsumptionVerdict(kind).verdict).toBe("no-charge");
    }
  });
  it("unknown kinds never consume (closed list: not enumerated, not charged)", () => {
    expect(quotaConsumptionVerdict("something-new").verdict).toBe("no-charge");
  });
});

describe("UTC calendar windows", () => {
  it("daily key is the UTC calendar date", () => {
    expect(quotaWindowKey("daily", NOW)).toBe("D:2026-11-03");
    expect(quotaWindowKey("daily", Date.UTC(2026, 10, 3, 0, 0, 0))).toBe("D:2026-11-03");
    expect(quotaWindowKey("daily", Date.UTC(2026, 10, 2, 23, 59, 59))).toBe("D:2026-11-02");
  });
  it("weekly key is the Monday 00:00 UTC starting the week", () => {
    // 2026-11-03 is a Tuesday; its week started Monday 2026-11-02.
    expect(quotaWindowKey("weekly", NOW)).toBe("W:2026-11-02");
    // Sunday 2026-11-01 still belongs to the week of Monday 2026-10-26.
    expect(quotaWindowKey("weekly", Date.UTC(2026, 10, 1, 23, 0, 0))).toBe("W:2026-10-26");
    // Monday 00:00 UTC sharp starts a new week.
    expect(quotaWindowKey("weekly", Date.UTC(2026, 10, 2, 0, 0, 0))).toBe("W:2026-11-02");
  });
  it("monthly key is the UTC calendar month", () => {
    expect(quotaWindowKey("monthly", NOW)).toBe("M:2026-11");
    expect(quotaWindowKey("monthly", Date.UTC(2026, 9, 31, 23, 59, 59))).toBe("M:2026-10");
  });
  it("bounds end exactly at the next window start (the reset time)", () => {
    const day = quotaWindowBounds("daily", NOW);
    expect(day.startMs).toBe(Date.UTC(2026, 10, 3, 0, 0, 0));
    expect(day.endMs).toBe(Date.UTC(2026, 10, 4, 0, 0, 0));
    expect(day.resetAtMs).toBe(day.endMs);
    const week = quotaWindowBounds("weekly", NOW);
    expect(week.startMs).toBe(Date.UTC(2026, 10, 2, 0, 0, 0));
    expect(week.endMs).toBe(Date.UTC(2026, 10, 9, 0, 0, 0));
    const month = quotaWindowBounds("monthly", NOW);
    expect(month.startMs).toBe(Date.UTC(2026, 10, 1, 0, 0, 0));
    expect(month.endMs).toBe(Date.UTC(2026, 11, 1, 0, 0, 0));
  });
  it("window-key ends resolve for override expiry", () => {
    expect(quotaWindowEndForKey("daily", "D:2026-11-03")).toBe(Date.UTC(2026, 10, 4, 0, 0, 0));
    expect(quotaWindowEndForKey("weekly", "W:2026-11-02")).toBe(Date.UTC(2026, 10, 9, 0, 0, 0));
    expect(quotaWindowEndForKey("monthly", "M:2026-11")).toBe(Date.UTC(2026, 11, 1, 0, 0, 0));
    expect(() => quotaWindowEndForKey("daily", "bogus")).toThrow();
  });
  it("a new window starts empty (rollover)", () => {
    const port = createInMemoryUserRequestQuotaPort();
    const p = policy({ daily: 1 });
    checkAndChargeUserRequestQuota({
      port, policy: p, tenantId: "t1", userLogin: "u1",
      kind: "screen", runId: "screen:u1:nasdaq100:1", nowMs: NOW,
    });
    expect(() =>
      checkAndChargeUserRequestQuota({
        port, policy: p, tenantId: "t1", userLogin: "u1",
        kind: "screen", runId: "screen:u1:nasdaq100:2", nowMs: NOW,
      }),
    ).toThrow(UserRequestQuotaExceededError);
    // Next UTC day: the daily window is fresh.
    const next = checkAndChargeUserRequestQuota({
      port, policy: p, tenantId: "t1", userLogin: "u1",
      kind: "screen", runId: "screen:u1:nasdaq100:3", nowMs: Date.UTC(2026, 10, 4, 0, 0, 1),
    });
    expect(next.charged).toBe(true);
  });
});

describe("config resolution", () => {
  it("ships one pending value set for all tiers", () => {
    expect(DEFAULT_USER_REQUEST_QUOTA).toEqual({ daily: 10, weekly: 70, monthly: 300 });
    expect(USER_REQUEST_QUOTA_WINDOWS).toEqual(["daily", "weekly", "monthly"]);
  });
  it("env overrides apply when valid", () => {
    const resolved = resolveUserRequestQuota({
      USER_REQUEST_QUOTA_DAILY: "5",
      USER_REQUEST_QUOTA_WEEKLY: "20",
      USER_REQUEST_QUOTA_MONTHLY: "60",
    });
    expect(resolved).toMatchObject({ daily: 5, weekly: 20, monthly: 60, enabled: true });
    expect(resolved.invalid).toEqual([]);
  });
  it("invalid values fall back to defaults, never to 0 or unlimited", () => {
    const resolved = resolveUserRequestQuota({
      USER_REQUEST_QUOTA_DAILY: "0",
      USER_REQUEST_QUOTA_WEEKLY: "abc",
      USER_REQUEST_QUOTA_MONTHLY: "-3",
    });
    expect(resolved).toMatchObject({ daily: 10, weekly: 70, monthly: 300 });
    expect(resolved.invalid.length).toBe(3);
  });
  it("enabled=false disables the gate; garbage fails closed to enabled", () => {
    expect(resolveUserRequestQuota({ USER_REQUEST_QUOTA_ENABLED: "false" }).enabled).toBe(false);
    expect(resolveUserRequestQuota({ USER_REQUEST_QUOTA_ENABLED: "maybe" }).enabled).toBe(true);
    expect(resolveUserRequestQuota({}).enabled).toBe(true);
  });
});

describe("counters", () => {
  const ports: Array<[string, () => UserRequestQuotaPort]> = [
    ["in-memory", () => createInMemoryUserRequestQuotaPort()],
    ["sqlite", () => createUserRequestQuotaPort(sqliteSeam())],
  ];
  for (const [name, make] of ports) {
    it(`[${name}] charge is idempotent on run id`, () => {
      const port = make();
      const p = policy();
      const first = checkAndChargeUserRequestQuota({
        port, policy: p, tenantId: "t1", userLogin: "u1",
        kind: "screen", runId: "screen:u1:nasdaq100:1", nowMs: NOW,
      });
      expect(first.charged).toBe(true);
      const retry = checkAndChargeUserRequestQuota({
        port, policy: p, tenantId: "t1", userLogin: "u1",
        kind: "screen", runId: "screen:u1:nasdaq100:1", nowMs: NOW,
      });
      expect(retry.charged).toBe(false);
      expect(retry.alreadyCounted).toBe(true);
      const usage = getUserRequestQuotaUsage({ port, policy: p, tenantId: "t1", userLogin: "u1", nowMs: NOW });
      expect(usage.daily.usage).toBe(1);
    });
    it(`[${name}] tenant isolation: one tenant never consumes another's quota`, () => {
      const port = make();
      const p = policy({ daily: 1 });
      checkAndChargeUserRequestQuota({
        port, policy: p, tenantId: "tenant-a", userLogin: "u1",
        kind: "screen", runId: "screen:u1:x:1", nowMs: NOW,
      });
      // Same user login string under another tenant is unaffected.
      const other = checkAndChargeUserRequestQuota({
        port, policy: p, tenantId: "tenant-b", userLogin: "u1",
        kind: "screen", runId: "screen:u1:x:1", nowMs: NOW,
      });
      expect(other.charged).toBe(true);
      expect(getUserRequestQuotaUsage({ port, policy: p, tenantId: "tenant-b", userLogin: "u1", nowMs: NOW }).daily.usage).toBe(1);
    });
    it(`[${name}] over-quota refusal charges nothing`, () => {
      const port = make();
      const p = policy({ daily: 1 });
      checkAndChargeUserRequestQuota({
        port, policy: p, tenantId: "t1", userLogin: "u1",
        kind: "screen", runId: "screen:u1:x:1", nowMs: NOW,
      });
      let caught: unknown;
      try {
        checkAndChargeUserRequestQuota({
          port, policy: p, tenantId: "t1", userLogin: "u1",
          kind: "screen", runId: "screen:u1:x:2", nowMs: NOW,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UserRequestQuotaExceededError);
      const usage = getUserRequestQuotaUsage({ port, policy: p, tenantId: "t1", userLogin: "u1", nowMs: NOW });
      expect(usage.daily.usage).toBe(1);
    });
    it(`[${name}] active overrides add to the limit; expired ones do not`, () => {
      const port = make();
      const p = policy({ daily: 1 });
      checkAndChargeUserRequestQuota({
        port, policy: p, tenantId: "t1", userLogin: "u1",
        kind: "screen", runId: "screen:u1:x:1", nowMs: NOW,
      });
      port.grantOverride({
        tenantId: "t1", userLogin: "u1", windowKind: "daily",
        windowKey: quotaWindowKey("daily", NOW), extraRuns: 2,
        grantedBy: "admin1", reason: "incident review", createdMs: NOW,
        expiresMs: quotaWindowBounds("daily", NOW).endMs,
      });
      const extra = checkAndChargeUserRequestQuota({
        port, policy: p, tenantId: "t1", userLogin: "u1",
        kind: "screen", runId: "screen:u1:x:2", nowMs: NOW,
      });
      expect(extra.charged).toBe(true);
      const usage = getUserRequestQuotaUsage({ port, policy: p, tenantId: "t1", userLogin: "u1", nowMs: NOW });
      expect(usage.daily.limit).toBe(3);
      expect(usage.daily.usage).toBe(2);
      expect(usage.daily.remaining).toBe(1);
      expect(usage.daily.overrides.length).toBe(1);
      // An expired override never counts.
      port.grantOverride({
        tenantId: "t1", userLogin: "u1", windowKind: "daily",
        windowKey: quotaWindowKey("daily", NOW), extraRuns: 100,
        grantedBy: "admin1", reason: "stale", createdMs: NOW - 1000,
        expiresMs: NOW - 1,
      });
      expect(getUserRequestQuotaUsage({ port, policy: p, tenantId: "t1", userLogin: "u1", nowMs: NOW }).daily.limit).toBe(3);
    });
  }
});

describe("gate", () => {
  it("disabled policy charges nothing and never refuses", () => {
    const port = createInMemoryUserRequestQuotaPort();
    const p = policy({ enabled: false, daily: 0 });
    const out = checkAndChargeUserRequestQuota({
      port, policy: p, tenantId: "t1", userLogin: "u1",
      kind: "screen", runId: "screen:u1:x:1", nowMs: NOW,
    });
    expect(out.charged).toBe(false);
    expect(getUserRequestQuotaUsage({ port, policy: p, tenantId: "t1", userLogin: "u1", nowMs: NOW }).daily.usage).toBe(0);
  });
  it("no-charge kinds pass the gate without a charge", () => {
    const port = createInMemoryUserRequestQuotaPort();
    const p = policy({ daily: 1 });
    const out = checkAndChargeUserRequestQuota({
      port, policy: p, tenantId: "t1", userLogin: "u1",
      kind: "chat", runId: "chat:1", nowMs: NOW,
    });
    expect(out.charged).toBe(false);
  });
  it("over-quota error carries limit, usage, and reset time, parseable across RPC", () => {
    const port = createInMemoryUserRequestQuotaPort();
    const p = policy({ daily: 1 });
    checkAndChargeUserRequestQuota({
      port, policy: p, tenantId: "t1", userLogin: "u1",
      kind: "screen", runId: "screen:u1:x:1", nowMs: NOW,
    });
    let caught: unknown;
    try {
      checkAndChargeUserRequestQuota({
        port, policy: p, tenantId: "t1", userLogin: "u1",
        kind: "screen", runId: "screen:u1:x:2", nowMs: NOW,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserRequestQuotaExceededError);
    const err = caught as UserRequestQuotaExceededError;
    expect(err.window).toBe("daily");
    expect(err.limit).toBe(1);
    expect(err.usage).toBe(1);
    expect(err.resetAtMs).toBe(Date.UTC(2026, 10, 4, 0, 0, 0));
    // The message alone must round-trip: DO RPC drops class fields.
    const fromMessage = quotaExceededDetails(new Error(err.message));
    expect(fromMessage).toMatchObject({ window: "daily", limit: 1, usage: 1, resetAtMs: Date.UTC(2026, 10, 4, 0, 0, 0) });
    expect(quotaExceededDetails(new Error("unrelated failure"))).toBeNull();
  });
  it("a counter-store failure fails closed, never fail-open", () => {
    const throwing: UserRequestQuotaPort = {
      ensureSchema: () => { throw new Error("store down"); },
      probe: () => { throw new Error("store down"); },
      chargeWindow: () => { throw new Error("store down"); },
      grantOverride: () => { throw new Error("store down"); },
      listOverrides: () => { throw new Error("store down"); },
    };
    expect(() =>
      checkAndChargeUserRequestQuota({
        port: throwing, policy: policy(), tenantId: "t1", userLogin: "u1",
        kind: "screen", runId: "screen:u1:x:1", nowMs: NOW,
      }),
    ).toThrow(UserRequestQuotaUnavailableError);
  });
  it("usage view reports remaining and reset per window", () => {
    const port = createInMemoryUserRequestQuotaPort();
    const p = policy();
    checkAndChargeUserRequestQuota({
      port, policy: p, tenantId: "t1", userLogin: "u1",
      kind: "goalScreen", runId: "goal:abc", nowMs: NOW,
    });
    const usage = getUserRequestQuotaUsage({ port, policy: p, tenantId: "t1", userLogin: "u1", nowMs: NOW });
    expect(usage.daily).toMatchObject({ limit: 10, usage: 1, remaining: 9 });
    expect(usage.daily.resetAtIso).toBe("2026-11-04T00:00:00.000Z");
    expect(usage.weekly.resetAtMs).toBe(Date.UTC(2026, 10, 9, 0, 0, 0));
    expect(usage.monthly.resetAtMs).toBe(Date.UTC(2026, 11, 1, 0, 0, 0));
    // Screen + goalScreen share one pool: the goal charge shows in the same counts.
    expect(usage.weekly.usage).toBe(1);
    expect(usage.monthly.usage).toBe(1);
  });
});
