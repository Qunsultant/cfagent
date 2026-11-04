/**
 * Issue #3113 (#945 Q5) — rotation triggers on privilege change.
 * TDD Red-first: the rotation module does not exist yet.
 *
 * Rule: when a user's privileges change (role/membership grant or
 * revoke), every ACTIVE session of that user rotates: the old id is
 * revoked and a rotated copy is registered with the same createdAt,
 * firstCreatedAt, and authTimeMs (rotation is NOT re-authentication
 * and does NOT extend absolute expiry), with only the idle clock
 * reset. Expired sessions are skipped, never resurrected. Other
 * users' sessions and legacy sessions (no internalUserId) are
 * untouched. SessionData carries no id field — the store key is the
 * id, so listings pair each record with its key.
 */
import { describe, it, expect } from "vitest";
import {
  rotateUserSessions,
  type RotationStore,
} from "../src/security/sessionRotation";
import type { SessionData } from "../src/types";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function data(
  overrides: Partial<SessionData> = {},
): SessionData {
  return {
    githubLogin: "octocat",
    githubAvatar: "",
    githubName: "octocat",
    createdAt: NOW - HOUR,
    firstCreatedAt: NOW - HOUR,
    lastActivityMs: NOW - 60_000,
    authTimeMs: NOW - 30 * 60_000,
    internalUserId: "user-1",
    ...overrides,
  } as SessionData;
}

type Entry = { sessionId: string; data: SessionData };

function fakeStore(entries: Entry[]): RotationStore & {
  revoked: string[];
  registered: SessionData[];
} {
  const revoked: string[] = [];
  const registered: SessionData[] = [];
  return {
    revoked,
    registered,
    async listSessions() {
      return entries;
    },
    async revokeSession(id: string) {
      revoked.push(id);
    },
    async registerSession(s: SessionData) {
      registered.push(s);
      return `rotated-${registered.length}`;
    },
  };
}

describe("rotateUserSessions", () => {
  it("rotates the target user's active sessions and preserves expiry/auth times", async () => {
    const old = data();
    const store = fakeStore([
      { sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", data: old },
    ]);
    const result = await rotateUserSessions(store, "user-1", NOW);
    expect(result.rotated).toHaveLength(1);
    expect(result.rotated[0].oldId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(result.rotated[0].newId).toBe("rotated-1");
    expect(store.revoked).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    expect(store.registered).toHaveLength(1);
    const next = store.registered[0];
    expect(next.createdAt).toBe(old.createdAt);
    expect(next.firstCreatedAt).toBe(old.firstCreatedAt);
    expect(next.authTimeMs).toBe(old.authTimeMs);
    expect(next.lastActivityMs).toBe(NOW);
    expect(next.internalUserId).toBe("user-1");
  });

  it("leaves other users' sessions untouched", async () => {
    const store = fakeStore([
      {
        sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        data: data({ internalUserId: "user-2" }),
      },
    ]);
    const result = await rotateUserSessions(store, "user-1", NOW);
    expect(result.rotated).toHaveLength(0);
    expect(store.revoked).toHaveLength(0);
    expect(store.registered).toHaveLength(0);
  });

  it("skips absolute-expired sessions instead of resurrecting them", async () => {
    const store = fakeStore([
      {
        sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        data: data({
          createdAt: NOW - 8 * DAY,
          firstCreatedAt: NOW - 8 * DAY,
          lastActivityMs: NOW - 8 * DAY,
        }),
      },
    ]);
    const result = await rotateUserSessions(store, "user-1", NOW);
    expect(result.rotated).toHaveLength(0);
    expect(store.revoked).toHaveLength(0);
    expect(store.registered).toHaveLength(0);
  });

  it("skips sessions past the 30-day lifetime cap", async () => {
    const store = fakeStore([
      {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        data: data({
          createdAt: NOW - HOUR,
          firstCreatedAt: NOW - 31 * DAY,
          lastActivityMs: NOW - 60_000,
        }),
      },
    ]);
    const result = await rotateUserSessions(store, "user-1", NOW);
    expect(result.rotated).toHaveLength(0);
    expect(store.revoked).toHaveLength(0);
    expect(store.registered).toHaveLength(0);
  });

  it("skips idle-expired sessions with recorded activity", async () => {
    const store = fakeStore([
      {
        sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        data: data({ lastActivityMs: NOW - 9 * HOUR }),
      },
    ]);
    const result = await rotateUserSessions(store, "user-1", NOW);
    expect(result.rotated).toHaveLength(0);
    expect(store.revoked).toHaveLength(0);
    expect(store.registered).toHaveLength(0);
  });

  it("skips legacy sessions with no internalUserId", async () => {
    const store = fakeStore([
      {
        sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        data: data({ internalUserId: undefined }),
      },
    ]);
    const result = await rotateUserSessions(store, "user-1", NOW);
    expect(result.rotated).toHaveLength(0);
  });
});
