/**
 * Issue #2836 — admin surface for logged-in users: active
 * sessions, login counts, login times, session history.
 *
 * Pure-module tests for src/security/iaaaLoggedInUsers.ts. The
 * module reads nothing: callers supply already-listed session
 * entries, audit events, alias records, and memberships, and the
 * module parses, filters, and aggregates them. Privacy by
 * construction: no token, secret, or payload field is ever read
 * or returned — the row shape carries identity, tenant, times,
 * counts, and status only.
 *
 * Honesty rules pinned here:
 * - loginCount counts RETAINED auth.login succeeded audit
 *   events only. The audit store is bounded (22,000 events) and
 *   best-effort, so the count is a recorded-events count, never
 *   a lifetime total — and the response labels it as such.
 * - A failed login event never counts, and an "unknown"-actor
 *   event is never attributed to a user.
 * - Legacy sessions (no internalUserId) carry no login count
 *   and no tenant attribution: they appear for platform admins
 *   only, never for tenant admins (fail-closed).
 * - Active means passing the policy expiry check (absolute 7d
 *   + 30d lifetime cap + idle window for sessions with
 *   recorded activity), not merely "listed by the store".
 */
import { describe, it, expect } from "vitest";
import {
  buildLoggedInUserRows,
  parseLoggedInSessionEntry,
  type LoginAuditEventInput,
  type MembershipInput,
} from "../src/security/iaaaLoggedInUsers";

const NOW = 1_800_000_000_000;
const IDLE = 28_800_000; // 8h, SESSION_LIMITS.idleTimeoutMs
const DAY = 86_400_000;

const resolveProvider = (issuer: unknown) =>
  issuer === "https://github.com"
    ? { providerId: "github", displayName: "GitHub" }
    : issuer === "https://accounts.google.com"
      ? { providerId: "google", displayName: "Google" }
      : issuer === "https://appleid.apple.com"
        ? { providerId: "apple", displayName: "Apple" }
        : null;

function wiredSession(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    githubLogin: "alice",
    githubName: "Alice A",
    githubAvatar: "",
    createdAt: NOW - 1000,
    internalUserId: "v1:alice000000000000000000000000000000000000000001",
    providerIssuer: "https://github.com",
    providerSubject: "12345",
    authTimeMs: NOW - 1000,
    lastActivityMs: NOW - 500,
    sessionVersion: 1,
    ...overrides,
  });
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

const ALICE = "v1:alice000000000000000000000000000000000000000001";
const BOB = "v1:bob00000000000000000000000000000000000000000001";

describe("parseLoggedInSessionEntry", () => {
  it("parses a wired session with identity, provider, times, and expiry", () => {
    const entry = parseLoggedInSessionEntry(UUID_A, wiredSession(), NOW, IDLE, resolveProvider);
    expect(entry).not.toBeNull();
    expect(entry!.sessionId).toBe(UUID_A);
    expect(entry!.internalUserId).toBe(ALICE);
    expect(entry!.displayLogin).toBe("alice");
    expect(entry!.displayName).toBe("Alice A");
    expect(entry!.identity).toBe("https://github.com:12345");
    expect(entry!.providerId).toBe("github");
    expect(entry!.provider).toBe("GitHub");
    expect(entry!.createdMs).toBe(NOW - 1000);
    expect(entry!.lastSeenMs).toBe(NOW - 500);
    // Expiry is the earliest applicable deadline: idle here
    // (lastActivity + 8h) beats absolute (createdAt + 7d).
    expect(entry!.expiresMs).toBe(NOW - 500 + IDLE);
  });

  it("keeps a legacy session (no identity) with idle exemption and no provider", () => {
    const raw = JSON.stringify({
      githubLogin: "legacy-user",
      githubName: "Legacy",
      githubAvatar: "",
      createdAt: NOW - 1000,
    });
    const entry = parseLoggedInSessionEntry(UUID_B, raw, NOW, IDLE, resolveProvider);
    expect(entry).not.toBeNull();
    expect(entry!.internalUserId).toBeUndefined();
    expect(entry!.identity).toBeNull();
    expect(entry!.provider).toBeNull();
    expect(entry!.lastSeenMs).toBe(NOW - 1000);
    // Idle-exempt: expiry is the absolute deadline only.
    expect(entry!.expiresMs).toBe(NOW - 1000 + 7 * DAY);
  });

  it("caps expiry at the 30-day lifetime cap", () => {
    // With the 8h idle window the idle deadline would always win
    // over a 1-day cap remainder, so this case uses a wide idle
    // window to make the cap the binding deadline.
    const raw = wiredSession({
      createdAt: NOW - 1000,
      firstCreatedAt: NOW - 29 * DAY,
      lastActivityMs: NOW - 500,
    });
    const entry = parseLoggedInSessionEntry(UUID_A, raw, NOW, 40 * DAY, resolveProvider);
    expect(entry).not.toBeNull();
    expect(entry!.expiresMs).toBe(NOW - 29 * DAY + 30 * DAY);
  });

  it("excludes an idle-expired wired session", () => {
    const raw = wiredSession({ lastActivityMs: NOW - IDLE - 1 });
    expect(parseLoggedInSessionEntry(UUID_A, raw, NOW, IDLE, resolveProvider)).toBeNull();
  });

  it("excludes an absolute-expired session", () => {
    const raw = wiredSession({ createdAt: NOW - 7 * DAY - 1, lastActivityMs: NOW - 500 });
    expect(parseLoggedInSessionEntry(UUID_A, raw, NOW, IDLE, resolveProvider)).toBeNull();
  });

  it("excludes a lifetime-cap-expired session", () => {
    const raw = wiredSession({
      createdAt: NOW - 1000,
      firstCreatedAt: NOW - 30 * DAY - 1,
      lastActivityMs: NOW - 500,
    });
    expect(parseLoggedInSessionEntry(UUID_A, raw, NOW, IDLE, resolveProvider)).toBeNull();
  });

  it("skips non-session keys, corrupt values, and records without login or createdAt", () => {
    expect(parseLoggedInSessionEntry("iaaa-membership:abc", wiredSession(), NOW, IDLE, resolveProvider)).toBeNull();
    expect(parseLoggedInSessionEntry(UUID_A, "not-json", NOW, IDLE, resolveProvider)).toBeNull();
    expect(parseLoggedInSessionEntry(UUID_A, JSON.stringify({ createdAt: NOW }), NOW, IDLE, resolveProvider)).toBeNull();
    expect(parseLoggedInSessionEntry(UUID_A, JSON.stringify({ githubLogin: "x" }), NOW, IDLE, resolveProvider)).toBeNull();
  });

  it("reports an unregistered issuer verbatim, never as another provider", () => {
    const raw = wiredSession({ providerIssuer: "https://login.example.com" });
    const entry = parseLoggedInSessionEntry(UUID_A, raw, NOW, IDLE, resolveProvider);
    expect(entry).not.toBeNull();
    expect(entry!.providerId).toBeNull();
    expect(entry!.provider).toBe("https://login.example.com");
    expect(entry!.identity).toBe("https://login.example.com:12345");
  });
});

const loginEvents: LoginAuditEventInput[] = [
  { actorPrincipalId: ALICE, tenantId: "primary", timestamp: 1000, outcome: "succeeded" },
  { actorPrincipalId: ALICE, tenantId: "primary", timestamp: 3000, outcome: "succeeded" },
  { actorPrincipalId: ALICE, tenantId: "primary", timestamp: 2000, outcome: "succeeded" },
  { actorPrincipalId: ALICE, tenantId: "other", timestamp: 4000, outcome: "succeeded" },
  { actorPrincipalId: BOB, tenantId: "other", timestamp: 1500, outcome: "succeeded" },
  // Failed logins and unknown-actor events never count anywhere.
  { actorPrincipalId: ALICE, tenantId: "primary", timestamp: 5000, outcome: "failed" },
  { actorPrincipalId: "unknown", tenantId: "primary", timestamp: 6000, outcome: "succeeded" },
];

const memberships: MembershipInput[] = [
  { internalUserId: ALICE, tenantId: "primary", revoked: false },
  { internalUserId: BOB, tenantId: "other", revoked: false },
  { internalUserId: BOB, tenantId: "primary", revoked: true },
];

function sessionEntries() {
  return [
    { key: UUID_A, value: wiredSession() },
    {
      key: UUID_B,
      value: wiredSession({
        githubLogin: "bob",
        githubName: "Bob B",
        internalUserId: BOB,
        providerIssuer: "https://accounts.google.com",
        providerSubject: "67890",
        createdAt: NOW - 2000,
        lastActivityMs: NOW - 1500,
      }),
    },
    {
      key: UUID_C,
      value: JSON.stringify({
        githubLogin: "legacy-user",
        githubName: "Legacy",
        githubAvatar: "",
        createdAt: NOW - 3000,
      }),
    },
  ];
}

describe("buildLoggedInUserRows", () => {
  it("platform scope sees every user, every tenant, and legacy sessions", () => {
    const rows = buildLoggedInUserRows({
      sessionEntries: sessionEntries(),
      loginEvents,
      aliases: [{ internalUserId: ALICE, recordedAtMs: 500 }],
      memberships,
      scope: "platform",
      nowMs: NOW,
      idleTimeoutMs: IDLE,
      resolveProvider,
    });
    expect(rows.map((r) => r.displayLogin).sort()).toEqual(["alice", "bob", "legacy-user"]);
    const alice = rows.find((r) => r.displayLogin === "alice")!;
    // Retained succeeded events across tenants: 1000, 2000, 3000, 4000.
    expect(alice.loginCount).toBe(4);
    expect(alice.firstLoginMs).toBe(1000);
    expect(alice.mostRecentLoginMs).toBe(4000);
    expect(alice.recentLoginMs).toEqual([4000, 3000, 2000, 1000]);
    expect(alice.firstSeenMs).toBe(500);
    expect(alice.tenantIds).toEqual(["primary"]);
    expect(alice.sessions).toHaveLength(1);
    const legacy = rows.find((r) => r.displayLogin === "legacy-user")!;
    expect(legacy.internalUserId).toBeNull();
    expect(legacy.loginCount).toBeNull();
    expect(legacy.firstLoginMs).toBeNull();
    expect(legacy.tenantIds).toEqual([]);
  });

  it("tenant scope sees only its tenant members and only that tenant's events", () => {
    const rows = buildLoggedInUserRows({
      sessionEntries: sessionEntries(),
      loginEvents,
      aliases: [{ internalUserId: ALICE, recordedAtMs: 500 }],
      memberships,
      scope: "tenant",
      tenantId: "primary",
      nowMs: NOW,
      idleTimeoutMs: IDLE,
      resolveProvider,
    });
    // Bob's only active membership is in "other" (his "primary"
    // record is revoked), and legacy sessions have no tenant.
    expect(rows.map((r) => r.displayLogin)).toEqual(["alice"]);
    const alice = rows[0];
    expect(alice.loginCount).toBe(3);
    expect(alice.mostRecentLoginMs).toBe(3000);
    expect(alice.tenantIds).toEqual(["primary"]);
  });

  it("falls back to the binding identity only when no session carries one", () => {
    const noIdentitySessions = [
      {
        key: UUID_A,
        value: wiredSession({ providerIssuer: undefined, providerSubject: undefined }),
      },
    ];
    // wiredSession spreads overrides over defaults, so strip the
    // provider fields explicitly for this case.
    const parsed = JSON.parse(noIdentitySessions[0].value) as Record<string, unknown>;
    delete parsed.providerIssuer;
    delete parsed.providerSubject;
    noIdentitySessions[0].value = JSON.stringify(parsed);
    const rows = buildLoggedInUserRows({
      sessionEntries: noIdentitySessions,
      loginEvents: [],
      aliases: [],
      memberships,
      identityByUser: { [ALICE]: "https://github.com:12345" },
      scope: "platform",
      nowMs: NOW,
      idleTimeoutMs: IDLE,
      resolveProvider,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].identity).toBe("https://github.com:12345");
    expect(rows[0].sessions[0].identity).toBeNull();
  });

  it("a user with sessions but no retained login events reports null times, not zeros", () => {
    const rows = buildLoggedInUserRows({
      sessionEntries: sessionEntries(),
      loginEvents: [],
      aliases: [],
      memberships,
      scope: "platform",
      nowMs: NOW,
      idleTimeoutMs: IDLE,
      resolveProvider,
    });
    const alice = rows.find((r) => r.displayLogin === "alice")!;
    expect(alice.loginCount).toBe(0);
    expect(alice.firstLoginMs).toBeNull();
    expect(alice.mostRecentLoginMs).toBeNull();
    expect(alice.recentLoginMs).toEqual([]);
    expect(alice.firstSeenMs).toBeNull();
  });

  it("recent logins are capped at ten, newest first", () => {
    const events: LoginAuditEventInput[] = Array.from({ length: 12 }, (_, i) => ({
      actorPrincipalId: ALICE,
      tenantId: "primary",
      timestamp: (i + 1) * 1000,
      outcome: "succeeded",
    }));
    const rows = buildLoggedInUserRows({
      sessionEntries: sessionEntries(),
      loginEvents: events,
      aliases: [],
      memberships,
      scope: "platform",
      nowMs: NOW,
      idleTimeoutMs: IDLE,
      resolveProvider,
    });
    const alice = rows.find((r) => r.displayLogin === "alice")!;
    expect(alice.loginCount).toBe(12);
    expect(alice.recentLoginMs).toHaveLength(10);
    expect(alice.recentLoginMs[0]).toBe(12000);
    expect(alice.recentLoginMs[9]).toBe(3000);
  });
});
