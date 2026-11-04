/**
 * Issue #3102 (#945 Q4) — step-up thresholds and freshness windows per
 * action + legacy-session rule. TDD Red-first.
 *
 * What this file proves (pure gate, no wiring):
 * - Each epic §4 action carries its own freshness window (5 min for
 *   grants, credentials, auth-method change, provider linking, and
 *   payment-configuration change; 10 min for sensitive export).
 * - An unlisted action falls back to the settled 15-min default
 *   (#1757) — fail closed, never no-gate.
 * - Per-action allow/deny boundaries are exact on authTimeMs.
 * - A session without authTimeMs (every legacy session) is stale for
 *   EVERY action, and a future authTime is never fresh.
 * - The wiring-aware predicate follows the pilot rule: wiring OFF
 *   never requires step-up; wiring ON delegates to the per-action
 *   window.
 * - POST /api/api-keys mint is retimed from the 15-min default to
 *   the 5-min integration-credential window (Q4 decision).
 */
import { describe, it, expect } from "vitest";
import {
  STEP_UP_ACTION_WINDOWS,
  stepUpWindowForAction,
  sessionRequiresStepUpForAction,
  type StepUpAction,
} from "../src/security/stepUpActions";
import {
  requiresStepUpForAction,
  requiresStepUpForMint,
} from "../src/security/iaaaGates";
import type { SessionData } from "../src/types";

const NOW = 10_000_000;
const MIN = 60_000;

const FIVE_MIN_ACTIONS: StepUpAction[] = [
  "privileged-role-assignment",
  "integration-credential-management",
  "auth-method-change",
  "provider-linking",
  "payment-configuration-change",
];
const ALL_ACTIONS: StepUpAction[] = [...FIVE_MIN_ACTIONS, "sensitive-export"];

function wired(authTimeMs?: number): SessionData {
  const base: SessionData = {
    githubLogin: "octocat-q4",
    githubAvatar: "",
    githubName: "Octocat Q4",
    createdAt: NOW - 60 * MIN,
    internalUserId: "user-q4",
    providerIssuer: "https://github.com",
    providerSubject: "42",
    lastActivityMs: NOW - MIN,
  };
  return authTimeMs === undefined ? base : { ...base, authTimeMs };
}

describe("step-up windows per action (#3102, #945 Q4)", () => {
  it("assigns 5 minutes to grants, credentials, auth-method change, provider linking, and payment-configuration change", () => {
    for (const action of FIVE_MIN_ACTIONS) {
      expect(stepUpWindowForAction(action)).toBe(5 * MIN);
      expect(STEP_UP_ACTION_WINDOWS[action]).toBe(5 * MIN);
    }
  });

  it("assigns 10 minutes to sensitive export", () => {
    expect(stepUpWindowForAction("sensitive-export")).toBe(10 * MIN);
    expect(STEP_UP_ACTION_WINDOWS["sensitive-export"]).toBe(10 * MIN);
  });

  it("falls back to the settled 15-minute default for an unlisted action", () => {
    expect(stepUpWindowForAction("bogus-action" as StepUpAction)).toBe(15 * MIN);
  });

  it("allows a 4-minute-old authentication for 5-minute actions, requires step-up exactly at 5 minutes", () => {
    for (const action of FIVE_MIN_ACTIONS) {
      expect(sessionRequiresStepUpForAction(wired(NOW - 4 * MIN), action, NOW)).toBe(false);
      expect(sessionRequiresStepUpForAction(wired(NOW - 5 * MIN), action, NOW)).toBe(true);
      expect(sessionRequiresStepUpForAction(wired(NOW - 6 * MIN), action, NOW)).toBe(true);
    }
  });

  it("allows a 6-minute-old authentication for sensitive export, requires step-up exactly at 10 minutes", () => {
    expect(sessionRequiresStepUpForAction(wired(NOW - 6 * MIN), "sensitive-export", NOW)).toBe(false);
    expect(sessionRequiresStepUpForAction(wired(NOW - 10 * MIN), "sensitive-export", NOW)).toBe(true);
    expect(sessionRequiresStepUpForAction(wired(NOW - 11 * MIN), "sensitive-export", NOW)).toBe(true);
  });

  it("treats a session without authTimeMs (every legacy session) as stale for every action", () => {
    for (const action of ALL_ACTIONS) {
      expect(sessionRequiresStepUpForAction(wired(undefined), action, NOW)).toBe(true);
    }
  });

  it("treats a future authentication time as stale for every action (clock skew is not freshness)", () => {
    for (const action of ALL_ACTIONS) {
      expect(sessionRequiresStepUpForAction(wired(NOW + MIN), action, NOW)).toBe(true);
    }
  });

  it("wiring-aware predicate: wiring OFF never requires step-up, wiring ON delegates to the per-action window", () => {
    const stale = wired(NOW - 60 * MIN);
    for (const action of ALL_ACTIONS) {
      expect(requiresStepUpForAction(stale, action, false, NOW)).toBe(false);
      expect(requiresStepUpForAction(stale, action, true, NOW)).toBe(true);
    }
    expect(
      requiresStepUpForAction(wired(NOW - 4 * MIN), "privileged-role-assignment", true, NOW),
    ).toBe(false);
    expect(
      requiresStepUpForAction(wired(NOW - 6 * MIN), "sensitive-export", true, NOW),
    ).toBe(false);
  });

  it("retimes the api-keys mint predicate to the 5-minute integration-credential window", () => {
    expect(
      requiresStepUpForMint(wired(1_000_000), true, 1_000_000 + 4 * MIN),
    ).toBe(false);
    expect(
      requiresStepUpForMint(wired(1_000_000), true, 1_000_000 + 5 * MIN),
    ).toBe(true);
  });
});
