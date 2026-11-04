/**
 * Issue #3113 (#945 Q5) — env adapter for session rotation.
 *
 * rotateUserSessionsForEnv adapts the pure rotation core to the
 * production store: it lists via listSessionFamilyEntries, filters
 * to bare-UUID keys, skips unparseable values, and surfaces a null
 * listing as unavailable (never silently skipped). The session
 * module is mocked here because the shared fake session store
 * restricts list by design (#1758) — a worker-fetch rotation test
 * would only ever exercise the unavailable path, so the adapter's
 * happy path is pinned at this seam instead. The pure core is
 * covered by iaaa_session_rotation_3113.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/security/session", () => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSessionIdCandidates: vi.fn(),
  listSessionFamilyEntries: vi.fn(),
  setSessionCookie: vi.fn((id: string) => `session_id=${id}; Path=/`),
}));

import {
  rotateUserSessionsForEnv,
  sessionRotationCookie,
} from "../src/security/sessionRotation";
import {
  createSession,
  deleteSession,
  getSessionIdCandidates,
  listSessionFamilyEntries,
  setSessionCookie,
} from "../src/security/session";

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function session(overrides: Record<string, unknown> = {}) {
  return {
    githubLogin: "octocat",
    createdAt: NOW - HOUR,
    firstCreatedAt: NOW - HOUR,
    internalUserId: "user-1",
    lastActivityMs: NOW - 60_000,
    authTimeMs: NOW - 60_000,
    ...overrides,
  };
}

describe("rotateUserSessionsForEnv (#3113, #945 Q5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("null listing surfaces unavailable, never silently skipped", async () => {
    (listSessionFamilyEntries as any).mockResolvedValue(null);
    const result = await rotateUserSessionsForEnv({} as any, "user-1", NOW);
    expect(result).toEqual({ rotated: [], unavailable: true });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rotates the user's UUID sessions, skips non-UUID keys and bad JSON", async () => {
    const oldId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    (listSessionFamilyEntries as any).mockResolvedValue([
      { key: oldId, value: JSON.stringify(session()) },
      { key: "not-a-uuid", value: JSON.stringify(session()) },
      { key: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", value: "{not json" },
      {
        key: "cccccccc-3333-4333-8333-cccccccccccc",
        value: JSON.stringify(session({ internalUserId: "user-2" })),
      },
    ]);
    (createSession as any).mockResolvedValue("dddddddd-4444-4444-8444-dddddddddddd");
    const result = await rotateUserSessionsForEnv({} as any, "user-1", NOW);
    expect(result.unavailable).toBe(false);
    expect(result.rotated).toEqual([
      { oldId, newId: "dddddddd-4444-4444-8444-dddddddddddd" },
    ]);
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith(expect.anything(), oldId);
    const registered = (createSession as any).mock.calls[0][1];
    expect(registered.createdAt).toBe(NOW - HOUR);
    expect(registered.firstCreatedAt).toBe(NOW - HOUR);
    expect(registered.authTimeMs).toBe(NOW - 60_000);
  });

  it("sessionRotationCookie re-issues only when the acting session rotated", async () => {
    (getSessionIdCandidates as any).mockReturnValue(["aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"]);
    const rotation = {
      rotated: [{ oldId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", newId: "dddddddd-4444-4444-8444-dddddddddddd" }],
    };
    const cookie = sessionRotationCookie(new Request("https://agent.test/"), rotation as any);
    expect(cookie).toContain("dddddddd-4444-4444-8444-dddddddddddd");
    expect(setSessionCookie).toHaveBeenCalledWith("dddddddd-4444-4444-8444-dddddddddddd");

    (getSessionIdCandidates as any).mockReturnValue(["someone-else"]);
    expect(sessionRotationCookie(new Request("https://agent.test/"), rotation as any)).toBeNull();
  });
});
