/**
 * Issue #3197: E*TRADE upstream failures must surface as AOP
 * outcome-encoded errors with remediation — never raw upstream HTML
 * or raw bodies. These tests pin the three failure paths:
 * - request_token upstream rejection (e.g. HTTP 401 HTML dump);
 * - access_token exchange upstream rejection (the owner's 401);
 * - renew upstream rejection (renewFailureDetail UPSTREAM_REJECTED).
 *
 * The surfaced message must carry the outcome code in [CODE] form
 * and must contain no HTML markup from the upstream body.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getETradeRequestToken,
  exchangeETradeVerifier,
  renewFailureDetail,
} from "../src/services/etradeOAuth";
import type { Env } from "../src/types";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import { makeFakeSessionStore } from "./fake-session-store";

const UPSTREAM_HTML =
  "<!doctype html><html><head><title>HTTP Status 401 – Unauthorized</title></head>" +
  "<body><h1>HTTP Status 401 – Unauthorized</h1></body></html>";

describe("E*TRADE OAuth upstream failures are outcome-encoded (#3197)", () => {
  let env: Env;
  const userLogin = "trader_alice";

  beforeEach(() => {
    vi.restoreAllMocks();
    __resetTokenCache();
    const { namespace } = makeFakeSessionStore();
    env = {
      APP_ENV: "TEST",
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_456",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      SESSION_STORE: namespace as any,
    } as Env;
  });

  it("request_token upstream HTML maps to FAILURE_ETRADE_OAUTH_REQUEST_TOKEN_FAILED with no HTML", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(UPSTREAM_HTML, {
        status: 401,
        headers: { "Content-Type": "text/html" },
      }),
    );
    let thrown: unknown;
    try {
      await getETradeRequestToken(env, userLogin);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    // BusinessError carries the outcome code on .code and the catalog
    // business message on .message (codedMessage's [CODE] prefix is a
    // display rendering, not part of the thrown message).
    expect((thrown as any).code).toBe("FAILURE_ETRADE_OAUTH_REQUEST_TOKEN_FAILED");
    const message = (thrown as Error).message;
    expect(message).toMatch(/E\*TRADE rejected the authorization request/);
    expect(message).not.toMatch(/<!doctype|<html|HTTP Status 401 – Unauthorized/);
  });

  it("access_token upstream HTML maps to FAILURE_ETRADE_OAUTH_EXCHANGE_FAILED with no HTML", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(UPSTREAM_HTML, {
        status: 401,
        headers: { "Content-Type": "text/html" },
      }),
    );
    let thrown: unknown;
    try {
      await exchangeETradeVerifier(env, userLogin, "ABC1234", "rt", "rs");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as any).code).toBe("FAILURE_ETRADE_OAUTH_EXCHANGE_FAILED");
    const message = (thrown as Error).message;
    expect(message).toMatch(/E\*TRADE rejected the verification code/);
    expect(message).not.toMatch(/<!doctype|<html|HTTP Status 401 – Unauthorized/);
  });

  it("renew UPSTREAM_REJECTED maps to FAILURE_ETRADE_OAUTH_RENEW_FAILED", () => {
    const detail = renewFailureDetail("UPSTREAM_REJECTED");
    expect(detail.code).toBe("FAILURE_ETRADE_OAUTH_RENEW_FAILED");
    expect(detail.message).toMatch(/\[FAILURE_ETRADE_OAUTH_RENEW_FAILED\]/);
    expect(detail.message).not.toMatch(/<!doctype|<html/);
  });
});
