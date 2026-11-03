/**
 * Issue #2402: sign-in shows an outcome message for both success and
 * failure. One outcome channel, allowlisted end to end:
 * - parseAuthOutcome admits only the known codes; anything else
 *   (unknown strings, injection attempts, wrong case) is null.
 * - Failure notices carry user-safe text only: no quota numbers, no
 *   row counts, no store names, no token details. Technical cause
 *   stays in server logs / audit, never in the message.
 * - The login page renders a notice only for failure codes; the
 *   success code is consumed by the app boot, never by /login.
 * - The failure-message path performs no SessionStore read: the
 *   session_unreadable redirect is pure URL logic in the / handler
 *   (covered by the worker-level route tests), and the notice HTML
 *   here is static string building.
 */
import { describe, expect, it } from "vitest";
import {
  AUTH_OUTCOME_PARAM,
  authOutcomeLoginUrl,
  authOutcomeNoticeHtml,
  parseAuthOutcome,
  type AuthOutcomeCode,
} from "../src/security/authOutcome";
import { renderLoginPage } from "../src/oauth";
import { signedInMessage, stripAuthOutcomeParam } from "../src/client/authOutcome";

const FAILURE_CODES: Array<Exclude<AuthOutcomeCode, "signed_in">> = [
  "session_unreadable",
  "signin_failed",
  "provider_unavailable",
  "wiring_disabled",
  // #2840: the session-cap check could not run.
  "session_limit_unavailable",
];

const FORBIDDEN_SUBSTRINGS = [
  "quota",
  "rows read",
  "Durable Object",
  "SessionStore",
  "token",
  "5M",
  "5.14",
];

describe("parseAuthOutcome", () => {
  it("admits exactly the known codes", () => {
    const codes: AuthOutcomeCode[] = [
      "signed_in",
      "session_unreadable",
      "signin_failed",
      "provider_unavailable",
      "wiring_disabled",
      "session_limit_unavailable",
    ];
    for (const code of codes) {
      expect(parseAuthOutcome(code)).toBe(code);
    }
  });

  it("rejects null, empty, unknown, wrong-case, and injection-shaped values", () => {
    for (const value of [
      null,
      undefined,
      "",
      "SIGNED_IN",
      "Session_Unreadable",
      "signed_in ",
      " signed_in",
      "session_unreadable<script>alert(1)</script>",
      "signin_failed&admin=1",
      "wiring_disabled\n",
    ]) {
      expect(parseAuthOutcome(value as string)).toBeNull();
    }
  });
});

describe("authOutcomeLoginUrl", () => {
  it("builds the login URL carrying only the allowlisted code", () => {
    expect(authOutcomeLoginUrl("session_unreadable")).toBe(
      "/login?auth_outcome=session_unreadable"
    );
    expect(authOutcomeLoginUrl("wiring_disabled")).toBe(
      "/login?auth_outcome=wiring_disabled"
    );
  });

  it("uses the single shared query parameter name", () => {
    expect(AUTH_OUTCOME_PARAM).toBe("auth_outcome");
  });
});

describe("authOutcomeNoticeHtml", () => {
  it("renders a distinct message per failure code", () => {
    const seen = new Set<string>();
    for (const code of FAILURE_CODES) {
      const html = authOutcomeNoticeHtml(code);
      expect(html).not.toBeNull();
      expect(html).toContain('class="notice"');
      expect(html).toContain('role="status"');
      seen.add(html!);
    }
    expect(seen.size).toBe(FAILURE_CODES.length);
  });

  it("renders nothing for the success code (boot consumes it, not /login)", () => {
    expect(authOutcomeNoticeHtml("signed_in")).toBeNull();
  });

  it("renders nothing for unknown codes", () => {
    expect(authOutcomeNoticeHtml("bogus" as AuthOutcomeCode)).toBeNull();
  });

  it("carries no internals in any failure message", () => {
    for (const code of FAILURE_CODES) {
      const html = authOutcomeNoticeHtml(code)!;
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(html.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
  });
});

describe("renderLoginPage with an outcome", () => {
  it("renders the failure notice above the provider buttons", () => {
    const html = renderLoginPage(
      { APP_NAME: "Test App" } as never,
      [{ id: "github", displayName: "GitHub" }],
      "session_unreadable"
    );
    expect(html).toContain('class="notice"');
    expect(html).toContain("Sign in with GitHub");
    expect(html.indexOf('class="notice"')).toBeLessThan(
      html.indexOf("Sign in with GitHub")
    );
  });

  it("renders no notice without an outcome (existing pages unchanged)", () => {
    const html = renderLoginPage({ APP_NAME: "Test App" } as never);
    expect(html).not.toContain('class="notice"');
  });

  it("renders no notice for the success code on the login page", () => {
    const html = renderLoginPage(
      { APP_NAME: "Test App" } as never,
      undefined,
      "signed_in"
    );
    expect(html).not.toContain('class="notice"');
  });
});

describe("client outcome helpers", () => {
  it("signedInMessage names the signed-in user only for the success code", () => {
    expect(signedInMessage("signed_in", "Ada")).toBe("Signed in as Ada");
    expect(signedInMessage("session_unreadable", "Ada")).toBeNull();
    expect(signedInMessage("signed_in", "")).toBeNull();
    expect(signedInMessage("signed_in", undefined)).toBeNull();
    expect(signedInMessage("bogus", "Ada")).toBeNull();
  });

  it("stripAuthOutcomeParam removes only the outcome parameter", () => {
    expect(stripAuthOutcomeParam("https://agent.test/?auth_outcome=signed_in")).toBe(
      "https://agent.test/"
    );
    expect(
      stripAuthOutcomeParam("https://agent.test/?tab=screen&auth_outcome=signed_in")
    ).toBe("https://agent.test/?tab=screen");
    expect(stripAuthOutcomeParam("https://agent.test/?tab=screen")).toBe(
      "https://agent.test/?tab=screen"
    );
    expect(stripAuthOutcomeParam("/?auth_outcome=signed_in")).toBe("/");
    expect(stripAuthOutcomeParam("/chat?tab=screen&auth_outcome=signed_in")).toBe(
      "/chat?tab=screen"
    );
  });
});
