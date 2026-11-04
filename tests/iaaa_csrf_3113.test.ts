/**
 * Issue #3113 (#945 Q5) — CSRF rule for cookie-authenticated mutations.
 * TDD Red-first: the gate module does not exist yet.
 *
 * Rule: a state-changing request (POST/PUT/PATCH/DELETE) that carries a
 * session cookie must carry a valid CSRF token (X-CSRF-Token header equal
 * to the csrf_token cookie value). Anything else is rejected before any
 * state change happens. Safe methods, requests without a session cookie
 * (token-authenticated callers are not ambient), and exempt paths
 * (login/callback, HMAC webhooks, token-authenticated /mcp and /a2a,
 * signature-verified Slack events) pass the gate.
 */
import { describe, it, expect } from "vitest";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  csrfGateResult,
  setCsrfCookie,
} from "../src/security/csrf";

function req(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://agent.openaimp.com${path}`, {
    method,
    headers,
  });
}

describe("csrf gate", () => {
  it("rejects a cookie-authenticated POST without any token", () => {
    const r = csrfGateResult(
      req("POST", "/api/iaaa/role-grants/grant", {
        Cookie: "session_id=11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.code).toBe("csrf_invalid");
  });

  it("rejects a cookie-authenticated POST whose header mismatches the cookie", () => {
    const r = csrfGateResult(
      req("POST", "/api/iaaa/role-grants/grant", {
        Cookie:
          "session_id=11111111-1111-4111-8111-111111111111; csrf_token=token-a",
        "X-CSRF-Token": "token-b",
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.code).toBe("csrf_invalid");
  });

  it("rejects a cookie-authenticated DELETE with a header but no token cookie", () => {
    const r = csrfGateResult(
      req("DELETE", "/api/referrals?id=x", {
        Cookie: "session_id=11111111-1111-4111-8111-111111111111",
        "X-CSRF-Token": "token-a",
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.code).toBe("csrf_invalid");
  });

  it("passes a cookie-authenticated POST with a matching header and cookie", () => {
    const r = csrfGateResult(
      req("POST", "/api/iaaa/role-grants/grant", {
        Cookie:
          "session_id=11111111-1111-4111-8111-111111111111; csrf_token=token-a",
        "X-CSRF-Token": "token-a",
      }),
    );
    expect(r.pass).toBe(true);
  });

  it("passes safe methods even with a session cookie and no token", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const r = csrfGateResult(
        req(method, "/api/iaaa/logged-in-users", {
          Cookie: "session_id=11111111-1111-4111-8111-111111111111",
        }),
      );
      expect(r.pass).toBe(true);
    }
  });

  it("passes requests without a session cookie (token-authenticated callers)", () => {
    const r = csrfGateResult(
      req("POST", "/api/iaaa/role-grants/grant", {
        Authorization: "Bearer some-api-key",
      }),
    );
    expect(r.pass).toBe(true);
  });

  it("passes exempt paths even with a session cookie and no token", () => {
    for (const path of [
      "/auth/login",
      "/auth/callback",
      "/auth/github/callback",
      "/nlq/webhook",
      "/api/nlq/webhook",
      "/api/trading/nlq/webhook",
      "/mcp",
      "/a2a/chat",
      "/slack/events",
    ]) {
      const r = csrfGateResult(
        req("POST", path, {
          Cookie: "session_id=11111111-1111-4111-8111-111111111111",
        }),
      );
      expect(r.pass).toBe(true);
    }
  });

  it("gates PUT and PATCH as well as POST and DELETE", () => {
    for (const method of ["PUT", "PATCH"]) {
      const r = csrfGateResult(
        req(method, "/api/iaaa/membership/grant", {
          Cookie: "session_id=11111111-1111-4111-8111-111111111111",
        }),
      );
      expect(r.pass).toBe(false);
    }
  });

  it("setCsrfCookie issues a readable, secure, same-site cookie", () => {
    const header = setCsrfCookie("token-a");
    expect(header).toContain(`${CSRF_COOKIE_NAME}=token-a`);
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).not.toContain("HttpOnly");
    expect(CSRF_HEADER_NAME).toBe("X-CSRF-Token");
  });
});
