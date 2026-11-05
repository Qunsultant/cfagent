/**
 * #1749 (parent #1717, IAAA-1): bound the legacy-session PDP exemption.
 *
 * Before this slice, a legacy (pre-wiring) session stayed PDP-exempt
 * for as long as it lived, and the exemption ended only at re-login:
 * shouldEnforcePdp() returned false for every legacy session whenever
 * IAAA_PDP_ENABLED was on. This file pins the replacement rule:
 *
 * - The exemption is BOUNDED by the session's own absolute lifetime
 *   (createdAt + SESSION_TTL, 7 days — the same deadline the
 *   SessionStore record already expires at, and the same exclusive
 *   boundary getValidatedSession enforces).
 * - Inside the bound, a legacy session still takes the pre-change
 *   path (no PDP check) — no lockout cliff for pre-wiring users.
 * - Past the bound, PDP enforcement applies and denies: a legacy
 *   session has no internalUserId, so checkRoutePermission denies
 *   it, and the gated routes answer 403 with the
 *   legacy_pdp_grace_expired code so the caller knows re-login
 *   through wiring restores gated actions. Ungated routes are
 *   unaffected until the store record itself expires.
 * - A legacy session with no provable createdAt cannot prove it is
 *   inside its bound, so it fails closed (expired).
 * - Wired sessions are unaffected by this bound: they carry
 *   internalUserId and are enforced (or not) by the PDP flag alone;
 *   their absolute/idle expiry lives on the requireAuth path.
 * - The bound is NOT caller-configurable at any scope: it reuses
 *   the SESSION_TTL constant, so no caller — and no env typo — can
 *   widen, narrow, or disable their own enforcement (security
 *   guard for this program).
 *
 * Written FIRST (TDD Red): these tests fail on the pre-change
 * module, which has no isLegacyPdpGraceExpired export and whose
 * shouldEnforcePdp takes no nowMs and returns false for every
 * legacy session.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SESSION_TTL } from "../src/security/session";
import {
  isLegacyPdpGraceExpired,
  shouldEnforcePdp,
} from "../src/security/iaaaGithubEndToEnd";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const NOW = 1780000000000;
const TTL_MS = SESSION_TTL * 1000;

const wired = { githubLogin: "octo", internalUserId: UUID_A } as never;
const legacyInside = {
  githubLogin: "octo",
  createdAt: NOW - 24 * 60 * 60 * 1000,
} as never;
const legacyAtDeadline = {
  githubLogin: "octo",
  createdAt: NOW - TTL_MS,
} as never;
const legacyPast = {
  githubLogin: "octo",
  createdAt: NOW - TTL_MS - 1,
} as never;
const legacyNoCreatedAt = { githubLogin: "octo" } as never;
const legacyBadCreatedAt = { githubLogin: "octo", createdAt: Number.NaN } as never;
const legacyFutureCreatedAt = {
  githubLogin: "octo",
  createdAt: NOW + 60_000,
} as never;
const wiredPastTtl = {
  githubLogin: "octo",
  internalUserId: UUID_A,
  createdAt: NOW - TTL_MS - 1,
} as never;

const PDP_ON = { IAAA_PDP_ENABLED: "1" };
const PDP_OFF = {};

describe("isLegacyPdpGraceExpired (#1749)", () => {
  it("is false when the PDP flag is off, even for an ancient legacy session", () => {
    expect(isLegacyPdpGraceExpired(PDP_OFF, legacyPast, NOW)).toBe(false);
  });
  it("is false for wired sessions even past the absolute deadline (their own path enforces expiry)", () => {
    expect(isLegacyPdpGraceExpired(PDP_ON, wiredPastTtl, NOW)).toBe(false);
    expect(isLegacyPdpGraceExpired(PDP_ON, wired, NOW)).toBe(false);
  });
  it("is false for a legacy session inside its bound", () => {
    expect(isLegacyPdpGraceExpired(PDP_ON, legacyInside, NOW)).toBe(false);
  });
  it("is true at and past the absolute deadline (expiry is exclusive, matching getValidatedSession)", () => {
    expect(isLegacyPdpGraceExpired(PDP_ON, legacyAtDeadline, NOW)).toBe(true);
    expect(isLegacyPdpGraceExpired(PDP_ON, legacyPast, NOW)).toBe(true);
  });
  it("fails closed when the session cannot prove a createdAt", () => {
    expect(isLegacyPdpGraceExpired(PDP_ON, legacyNoCreatedAt, NOW)).toBe(true);
    expect(isLegacyPdpGraceExpired(PDP_ON, legacyBadCreatedAt, NOW)).toBe(true);
  });
  it("is false for no session (that is a 401 upstream, not a grace denial)", () => {
    expect(isLegacyPdpGraceExpired(PDP_ON, null, NOW)).toBe(false);
    expect(isLegacyPdpGraceExpired(PDP_ON, undefined, NOW)).toBe(false);
  });
  it("is false for a future createdAt (not yet at any deadline)", () => {
    expect(isLegacyPdpGraceExpired(PDP_ON, legacyFutureCreatedAt, NOW)).toBe(false);
  });
});

describe("shouldEnforcePdp with the #1749 bound", () => {
  it("still enforces for wired sessions when the flag is on", () => {
    expect(shouldEnforcePdp(PDP_ON, wired, NOW)).toBe(true);
  });
  it("still exempts a legacy session inside its bound when the flag is on", () => {
    expect(shouldEnforcePdp(PDP_ON, legacyInside, NOW)).toBe(false);
  });
  it("enforces (and therefore denies) a legacy session past its bound when the flag is on", () => {
    expect(shouldEnforcePdp(PDP_ON, legacyAtDeadline, NOW)).toBe(true);
    expect(shouldEnforcePdp(PDP_ON, legacyPast, NOW)).toBe(true);
  });
  it("enforces fail-closed for a legacy session with no provable createdAt when the flag is on", () => {
    expect(shouldEnforcePdp(PDP_ON, legacyNoCreatedAt, NOW)).toBe(true);
    expect(shouldEnforcePdp(PDP_ON, legacyBadCreatedAt, NOW)).toBe(true);
  });
  it("never enforces when the flag is off, whatever the session age", () => {
    expect(shouldEnforcePdp(PDP_OFF, wired, NOW)).toBe(false);
    expect(shouldEnforcePdp(PDP_OFF, legacyPast, NOW)).toBe(false);
    expect(shouldEnforcePdp(PDP_OFF, legacyNoCreatedAt, NOW)).toBe(false);
  });
  it("never enforces for no session", () => {
    expect(shouldEnforcePdp(PDP_ON, null, NOW)).toBe(false);
  });
});

describe("server.ts gate wiring (#1749)", () => {
  it("passes an explicit clock to every shouldEnforcePdp gate and names the grace-expired denial at each gated route", () => {
    // Slice 3 of Qunsultant/cfagent#2902 (2026-11-05): the four
    // gated routes (E*TRADE start, E*TRADE verifier, Public start,
    // Public connect) move verbatim from src/server.ts to
    // src/server/routes/auth.ts with the login family. The gate
    // wiring is scanned across both files — the entry surface is
    // server.ts plus its route modules — and the counts are
    // unchanged: still four gates, each with its own explicit
    // clock, and the grace-expired denial named at each.
    const server =
      readFileSync("src/server.ts", "utf8") +
      readFileSync("src/server/routes/auth.ts", "utf8");
    // #1755: the four gated routes (E*TRADE start, E*TRADE verifier,
    // Public start, Public connect) now call the shared gateway
    // helper instead of shouldEnforcePdp directly — the gate logic
    // moved into src/security/pepGateway.ts, it was not removed.
    // The pin's intent is preserved in the new shape: an explicit
    // clock at every gated route, and the grace-expired denial
    // named at every gated route.
    // #2450: each gateway call also carries the per-user denial
    // store, so a tenant-admin's per-member connect denial is
    // enforced at the same four gates.
    const gates = server.match(/evaluateRoutePep\(\{/g) ?? [];
    expect(gates.length).toBe(4);
    // Each of the four gateway calls carries its own explicit clock.
    const clocked = server.match(
      /evaluateRoutePep\(\{\s*env,\s*session,\s*tenantId: resolveIaaaTenant\(env\),\s*permission: "integration:connect",\s*membershipStore: createKvMembershipStore\(sessionStore\(env\)\),\s*permissionDenialStore: createKvPermissionDenialStore\(sessionStore\(env\)\),\s*nowMs: Date\.now\(\),/g,
    ) ?? [];
    expect(clocked.length).toBe(4);
    const denials = server.match(/legacy_pdp_grace_expired/g) ?? [];
    expect(denials.length).toBeGreaterThanOrEqual(4);
    const gateway = readFileSync("src/security/pepGateway.ts", "utf8");
    expect(gateway).toContain("shouldEnforcePdp");
    expect(gateway).toContain("isLegacyPdpGraceExpired");
  });
});
