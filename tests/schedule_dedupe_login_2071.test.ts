/**
 * Issue #2071: signed-in users were told "An authenticated E*TRADE account is
 * required" when creating screening schedules, and a duplicated submit armed
 * the same schedule twice.
 *
 * Two root causes are pinned here:
 *  1. The login-shape rule only accepted `[A-Za-z0-9._-]`, so a session
 *     identity shaped like an email (`owner@example.com`) or an IAAA
 *     `issuer:subject` id (`https://github.com:82253453`) was rejected and
 *     the signed-in user fell through to the 401. The rule is about shape
 *     safety (no whitespace/control/quote characters), not authentication.
 *  2. Creation was not idempotent: interval schedules are not deduplicated by
 *     the SDK, so a double submit armed two identical schedules and the page
 *     rendered both.
 */
import { describe, it, expect } from "vitest";
import { isLoginShaped } from "../src/security/serviceIdentity";
import { canonicalJson, findDuplicateSchedule } from "../src/services/scheduleDedupe";

describe("login shape (#2071)", () => {
  it("accepts every identity shape the app forwards", () => {
    expect(isLoginShaped("OpenAIMP")).toBe(true);
    expect(isLoginShaped("screen_test_user")).toBe(true);
    expect(isLoginShaped("owner@example.com")).toBe(true);
    expect(isLoginShaped("github:OpenAIMP")).toBe(true);
    expect(isLoginShaped("https://github.com:82253453")).toBe(true);
    expect(isLoginShaped("user+tag@sub.example.co.uk")).toBe(true);
  });

  it("still rejects unsafe or oversized values", () => {
    expect(isLoginShaped("")).toBe(false);
    expect(isLoginShaped("  ")).toBe(false);
    expect(isLoginShaped("has space")).toBe(false);
    expect(isLoginShaped('quote"inside')).toBe(false);
    expect(isLoginShaped("line\nbreak")).toBe(false);
    expect(isLoginShaped("-leading-hyphen")).toBe(false);
    expect(isLoginShaped("a".repeat(121))).toBe(false);
    expect(isLoginShaped(undefined)).toBe(false);
    expect(isLoginShaped(42)).toBe(false);
  });
});

describe("canonicalJson", () => {
  it("is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

const EXISTING = {
  id: "sched-1",
  callback: "autonomousOptionsAnalysis",
  type: "interval",
  intervalSeconds: 3600,
  payload: { symbols: ["NVDA"], maxItems: 1, userLogin: "owner@example.com", trigger: "scheduled" },
};

describe("findDuplicateSchedule (#2071)", () => {
  it("matches the same callback, payload and cadence", () => {
    expect(
      findDuplicateSchedule([EXISTING], "autonomousOptionsAnalysis", { ...EXISTING.payload }, {
        type: "interval",
        intervalSeconds: 3600,
      }),
    ).toBe(EXISTING);
  });

  it("does not collapse different cadences", () => {
    expect(
      findDuplicateSchedule([EXISTING], "autonomousOptionsAnalysis", { ...EXISTING.payload }, {
        type: "interval",
        intervalSeconds: 1800,
      }),
    ).toBeUndefined();
    expect(
      findDuplicateSchedule([EXISTING], "autonomousOptionsAnalysis", { ...EXISTING.payload }, {
        type: "cron",
        cron: "0 * * * *",
      }),
    ).toBeUndefined();
  });

  it("does not collapse different payloads or callbacks", () => {
    expect(
      findDuplicateSchedule([EXISTING], "autonomousOptionsAnalysis", { ...EXISTING.payload, symbols: ["AMD"] }, {
        type: "interval",
        intervalSeconds: 3600,
      }),
    ).toBeUndefined();
    expect(
      findDuplicateSchedule([EXISTING], "autonomousMarketScreen", { ...EXISTING.payload }, {
        type: "interval",
        intervalSeconds: 3600,
      }),
    ).toBeUndefined();
  });

  it("ignores fields the new request does not specify", () => {
    expect(
      findDuplicateSchedule([EXISTING], "autonomousOptionsAnalysis", { ...EXISTING.payload }, {}),
    ).toBe(EXISTING);
  });

  it("ignores creation provenance on either side (issue #3121 S1)", () => {
    // A stored schedule carries its creation stamp; a fresh duplicate
    // check carries none (the route stamps after dedup). Provenance
    // is creation metadata, not criteria — dedup must still match.
    const stored = {
      ...EXISTING,
      payload: {
        ...EXISTING.payload,
        provenance: {
          origin: "user",
          createdBy: "owner@example.com",
          createdAt: "2026-11-05T00:00:00.000Z",
        },
      },
    };
    expect(
      findDuplicateSchedule([stored], "autonomousOptionsAnalysis", { ...EXISTING.payload }, {
        type: "interval",
        intervalSeconds: 3600,
      }),
    ).toBe(stored);
    // And the reverse: a fresh payload that already carries a stamp
    // (re-submit of a stamped payload) still matches the unstamped row.
    expect(
      findDuplicateSchedule(
        [EXISTING],
        "autonomousOptionsAnalysis",
        {
          ...EXISTING.payload,
          provenance: {
            origin: "user",
            createdBy: "owner@example.com",
            createdAt: "2026-11-05T01:00:00.000Z",
          },
        },
        { type: "interval", intervalSeconds: 3600 },
      ),
    ).toBe(EXISTING);
  });
});
