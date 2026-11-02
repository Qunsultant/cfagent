/**
 * Issue Qunsultant/cfagent#488 — per-user email destination as data.
 *
 * Red-first tests for src/services/userEmailDestination.ts:
 * - normalization/validation of a stored destination,
 * - resolution precedence run > user (stored) > global env,
 * - the KvLike-backed per-user store (SessionStore DO in production).
 */
import { describe, expect, it } from "vitest";
import {
  createUserEmailDestinationStore,
  normalizeEmailDestination,
  resolveEmailDestination,
  USER_EMAIL_DESTINATION_KEY_PREFIX,
  type KvLike,
} from "../src/services/userEmailDestination";

function memoryKv(): KvLike & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    async get(key: string) {
      return entries.get(key) ?? null;
    },
    async put(key: string, value: string) {
      entries.set(key, value);
    },
    async delete(key: string) {
      entries.delete(key);
    },
  };
}

describe("normalizeEmailDestination", () => {
  it("trims and lowercases a valid address", () => {
    expect(normalizeEmailDestination("  Alice@Example.COM ")).toEqual({
      ok: true,
      email: "alice@example.com",
    });
  });

  it("rejects blank, malformed, and overlong values", () => {
    expect(normalizeEmailDestination("")).toEqual({ ok: false, error: expect.any(String) });
    expect(normalizeEmailDestination("not-an-email")).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(normalizeEmailDestination("a@b")).toEqual({ ok: false, error: expect.any(String) });
    expect(normalizeEmailDestination(`${"a".repeat(250)}@example.com`)).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(normalizeEmailDestination(42 as unknown as string)).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });
});

describe("resolveEmailDestination", () => {
  const env = { SCREENER_EMAIL_TO: "global@example.com", OPTIONS_EMAIL_TO: "options@example.com" };

  it("prefers the run's explicit emailTo over everything", () => {
    expect(
      resolveEmailDestination({ eventEmailTo: "run@example.com", storedEmailTo: "user@example.com", env })
    ).toBe("run@example.com");
  });

  it("prefers the stored per-user destination over the global env vars", () => {
    expect(resolveEmailDestination({ storedEmailTo: "user@example.com", env })).toBe("user@example.com");
  });

  it("falls back to OPTIONS_EMAIL_TO, then SCREENER_EMAIL_TO, then undefined", () => {
    expect(resolveEmailDestination({ env })).toBe("options@example.com");
    expect(resolveEmailDestination({ env: { SCREENER_EMAIL_TO: "global@example.com" } })).toBe(
      "global@example.com"
    );
    expect(resolveEmailDestination({ env: {} })).toBeUndefined();
  });

  it("ignores an invalid stored value and falls back to env", () => {
    expect(resolveEmailDestination({ storedEmailTo: "not-an-email", env })).toBe("options@example.com");
  });
});

describe("createUserEmailDestinationStore", () => {
  it("round-trips per user without leaking across users", async () => {
    const kv = memoryKv();
    const store = createUserEmailDestinationStore(kv);
    await store.set("alice", "alice@example.com", "alice");
    await store.set("bob", "bob@example.com", "bob");
    expect(await store.get("alice")).toBe("alice@example.com");
    expect(await store.get("bob")).toBe("bob@example.com");
    expect(await store.get("carol")).toBeNull();
    expect(kv.entries.has(`${USER_EMAIL_DESTINATION_KEY_PREFIX}alice`)).toBe(true);
    await store.clear("alice");
    expect(await store.get("alice")).toBeNull();
    expect(await store.get("bob")).toBe("bob@example.com");
  });

  it("rejects invalid addresses on set and leaves prior value intact", async () => {
    const kv = memoryKv();
    const store = createUserEmailDestinationStore(kv);
    await store.set("alice", "alice@example.com", "alice");
    await expect(store.set("alice", "nope", "alice")).rejects.toThrow();
    expect(await store.get("alice")).toBe("alice@example.com");
  });

  it("treats a corrupt stored record as missing, never as an address", async () => {
    const kv = memoryKv();
    kv.entries.set(`${USER_EMAIL_DESTINATION_KEY_PREFIX}alice`, "{not json");
    const store = createUserEmailDestinationStore(kv);
    expect(await store.get("alice")).toBeNull();
  });
});
