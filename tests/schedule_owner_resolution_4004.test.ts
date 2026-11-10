/**
 * Issue #4004 — a schedule's recorded login must not shadow the
 * authenticated owner when it cannot be a principal.
 *
 * Incident #4003: the stock screen denied dispatch four times with no run.
 * `resolveScheduledLogin` preferred `payload.userLogin` unconditionally, so a
 * legacy record carrying an instance address (`shared_orchestrator`) or a
 * malformed value made `resolveDispatchCandidate` deny every firing with
 * SHARED_ADDRESS / NO_IDENTITY — even though the per-instance context stored
 * by the last signed-in request held a real owner.
 */
import { describe, it, expect } from "vitest";
import { resolveScheduledLogin } from "../src/agents/orchestrator/scheduleMaintenance";
import { resolveDispatchCandidate } from "../src/security/serviceDispatch";

describe("Issue #4004 — scheduled login resolution prefers a usable principal", () => {
  it("falls back to the authenticated context when the payload is an instance address", () => {
    expect(resolveScheduledLogin("shared_orchestrator", "owner@example.com")).toBe(
      "owner@example.com",
    );
    expect(resolveScheduledLogin("default_trader", "owner@example.com")).toBe(
      "owner@example.com",
    );
  });

  it("falls back to the authenticated context when the payload is malformed", () => {
    expect(resolveScheduledLogin("", "owner@example.com")).toBe("owner@example.com");
    expect(resolveScheduledLogin("has spaces", "owner@example.com")).toBe(
      "owner@example.com",
    );
  });

  it("keeps the recorded owner when it is a real login", () => {
    expect(resolveScheduledLogin("alice@example.com", "bob@example.com")).toBe(
      "alice@example.com",
    );
  });

  it("returns the recorded value when neither side is usable, so the audit names the real reason", () => {
    expect(resolveScheduledLogin("shared_orchestrator", undefined)).toBe(
      "shared_orchestrator",
    );
    expect(resolveScheduledLogin(undefined, undefined)).toBeUndefined();
  });

  it("the resolved login passes the dispatch gate as an owner (the incident case)", () => {
    const resolved = resolveScheduledLogin("shared_orchestrator", "owner@example.com");
    const identity = resolveDispatchCandidate(resolved, null);
    expect(identity).toEqual({ kind: "owner", login: "owner@example.com" });
  });

  it("an unusable pair still denies at the gate, with the instance address named", () => {
    const resolved = resolveScheduledLogin("shared_orchestrator", undefined);
    const identity = resolveDispatchCandidate(resolved, null);
    expect(identity).toMatchObject({ denied: true, reason: "SHARED_ADDRESS" });
  });
});
