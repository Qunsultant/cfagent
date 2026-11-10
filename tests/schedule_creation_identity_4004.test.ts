/**
 * Issue #4004 follow-up — the schedule-creation identity.
 *
 * Incident: creating any account-scoped schedule failed with
 * `CONNECTION_NOT_BOUND: no credential: connection alpaca:TEST:openaimp has no
 * stored credential for this login`, irrespective of the live/paper toggle.
 * The stored screener context (`openaimp`, TEST) outranked the signed-in
 * owner's Worker-verified header, so the credential lookup ran against the
 * wrong connection — and the environment was pinned to TEST even when the
 * owner chose live.
 */
import { describe, it, expect } from "vitest";
import { resolveTrustedScheduleIdentity } from "../src/agents/routes/schedules";

describe("Issue #4004 follow-up — trusted schedule identity", () => {
  it("prefers the request's verified login and environment over a stale context", () => {
    const resolved = resolveTrustedScheduleIdentity({
      headerLogin: "owner@example.com",
      headerEnvironment: "PROD",
      context: { userLogin: "openaimp", environment: "TEST" },
      configuredEnvironment: "PROD",
    });
    expect(resolved).toEqual({ userLogin: "owner@example.com", environment: "PROD" });
  });

  it("falls back to the context only when the request carries no usable login", () => {
    const resolved = resolveTrustedScheduleIdentity({
      headerLogin: "",
      headerEnvironment: "",
      context: { userLogin: "owner@example.com", environment: "TEST" },
      configuredEnvironment: "PROD",
    });
    expect(resolved).toEqual({ userLogin: "owner@example.com", environment: "TEST" });
  });

  it("ignores a malformed header login instead of acting as it", () => {
    const resolved = resolveTrustedScheduleIdentity({
      headerLogin: "not a login",
      headerEnvironment: "PROD",
      context: { userLogin: "owner@example.com", environment: "TEST" },
      configuredEnvironment: "PROD",
    });
    expect(resolved.userLogin).toBe("owner@example.com");
    expect(resolved.environment).toBe("PROD");
  });

  it("falls back to the configured environment when neither side names one", () => {
    const resolved = resolveTrustedScheduleIdentity({
      headerLogin: "owner@example.com",
      headerEnvironment: "",
      context: null,
      configuredEnvironment: "PROD",
    });
    expect(resolved).toEqual({ userLogin: "owner@example.com", environment: "PROD" });
  });
});
