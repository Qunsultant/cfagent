/** @vitest-environment jsdom */

/**
 * Issue #2471 (program #2468, Phase 1) — first-run client API.
 *
 * RED first: these tests import src/client/firstRunApi, which does not
 * exist yet. The module is client-only: it calls the EXISTING routes
 * (the #2219 self-only identity endpoint and the existing lifecycle
 * preferences route) and never sends an identity header — the session
 * cookie is the identity, and the server is the authority on tier and
 * tenant. Completion is a per-user localStorage flag (see the module
 * header for why the preferences store cannot carry it: the store and
 * the POST route forward only digestEnabled/welcomeEnabled, and this
 * slice touches no server files by design).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FirstRunApiError,
  fetchPlatformIdentity,
  fetchNotificationPreferences,
  saveNotificationPreferences,
  isFirstRunComplete,
  markFirstRunComplete,
  firstRunStorageKey,
} from "../src/client/firstRunApi";
import { codedMessage } from "../src/outcomes/outcomeAspects";

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    return handler(String(input), init);
  }) as typeof fetch;
}

describe("first-run completion store (#2471)", () => {
  it("is incomplete before completion, complete after, and scoped per user", () => {
    const user = "first-run-api-user-a";
    expect(isFirstRunComplete(user)).toBe(false);
    markFirstRunComplete(user);
    expect(isFirstRunComplete(user)).toBe(true);
    expect(isFirstRunComplete("first-run-api-user-b")).toBe(false);
    // The flag survives a later "login": a fresh read still sees it.
    expect(isFirstRunComplete(user)).toBe(true);
  });

  it("keys the flag by user login, never a shared key", () => {
    expect(firstRunStorageKey("alice")).toContain("alice");
    expect(firstRunStorageKey("alice")).not.toBe(firstRunStorageKey("bob"));
  });
});

describe("fetchPlatformIdentity (#2219 endpoint, read-only display)", () => {
  it("returns the server view unchanged", async () => {
    stubFetch(() =>
      Response.json({
        userLogin: "second-user",
        tenantId: "tenant-1",
        hasAccount: true,
        tier: "Free",
        creditsUSD: 0,
        includedRunsRemaining: 3,
      }),
    );
    const identity = await fetchPlatformIdentity();
    expect(identity.userLogin).toBe("second-user");
    expect(identity.tenantId).toBe("tenant-1");
    expect(identity.tier).toBe("Free");
  });

  it("rejects a malformed identity body instead of rendering garbage", async () => {
    stubFetch(() => Response.json({ tier: "Free" }));
    await expect(fetchPlatformIdentity()).rejects.toBeInstanceOf(FirstRunApiError);
  });

  it("surfaces HTTP failures as a typed error with the status", async () => {
    stubFetch(() => Response.json({ error: "Unauthorized" }, { status: 401 }));
    const err = await fetchPlatformIdentity().catch((e) => e);
    expect(err).toBeInstanceOf(FirstRunApiError);
    expect((err as FirstRunApiError).status).toBe(401);
  });
});

describe("lifecycle preferences route (existing route, no new port)", () => {
  it("GETs preferences with userId + tenantId query params", async () => {
    let seenUrl = "";
    stubFetch((url) => {
      seenUrl = url;
      return Response.json({
        preferences: { userId: "u-1", tenantId: "tenant-1", digestEnabled: false, welcomeEnabled: true, updatedAtMs: 1 },
      });
    });
    const prefs = await fetchNotificationPreferences("u-1", "tenant-1");
    expect(seenUrl).toContain("/api/payments/agentic/commercial/lifecycle/preferences");
    expect(seenUrl).toContain("userId=u-1");
    expect(seenUrl).toContain("tenantId=tenant-1");
    expect(prefs.digestEnabled).toBe(false);
    expect(prefs.welcomeEnabled).toBe(true);
  });

  it("POSTs only the two preference toggles the route forwards", async () => {
    let seenBody: Record<string, unknown> = {};
    stubFetch((_url, init) => {
      seenBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return Response.json({
        preferences: { userId: "u-1", tenantId: "tenant-1", digestEnabled: true, welcomeEnabled: false, updatedAtMs: 2 },
      });
    });
    const prefs = await saveNotificationPreferences({
      userId: "u-1",
      tenantId: "tenant-1",
      digestEnabled: true,
      welcomeEnabled: false,
    });
    expect(Object.keys(seenBody).sort()).toEqual(
      ["digestEnabled", "tenantId", "userId", "welcomeEnabled"].sort(),
    );
    expect(prefs.digestEnabled).toBe(true);
    expect(prefs.welcomeEnabled).toBe(false);
  });
});

describe("fetchPlatformIdentity coded failures (#3335)", () => {
  it.each([
    [401, "FAILURE_IDENTITY_LOGIN_REQUIRED"],
    [503, "FAILURE_COMMERCIAL_STORE_UNAVAILABLE"],
    [503, "FAILURE_IDENTITY_SCHEMA_UNAVAILABLE"],
    [503, "FAILURE_IDENTITY_READ_FAILED"],
  ])("surfaces %s %s as a typed error with the catalog message", async (status, code) => {
    stubFetch(() => Response.json({ code, error: codedMessage(code) }, { status }));
    const err = await fetchPlatformIdentity().catch((e) => e);
    expect(err).toBeInstanceOf(FirstRunApiError);
    expect((err as FirstRunApiError).status).toBe(status);
    expect((err as FirstRunApiError).code).toBe(code);
    expect((err as FirstRunApiError).message).toBe(codedMessage(code));
  });

  it("the four coded failures carry four different messages", async () => {
    const codes = [
      "FAILURE_IDENTITY_LOGIN_REQUIRED",
      "FAILURE_COMMERCIAL_STORE_UNAVAILABLE",
      "FAILURE_IDENTITY_SCHEMA_UNAVAILABLE",
      "FAILURE_IDENTITY_READ_FAILED",
    ];
    expect(new Set(codes.map((c) => codedMessage(c))).size).toBe(4);
  });
});
