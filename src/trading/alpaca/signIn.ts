/**
 * Issue #3351 — Alpaca sign-in: verify a pair before it is ever stored.
 *
 * The verification is Alpaca's own test of a credential: `GET /v2/account` with
 * that pair against that trading type's host. It answers three things and
 * nothing more — the pair works, Alpaca rejected it, or Alpaca could not be
 * reached. The upstream body is never read into a message: Alpaca's error pages
 * are HTML, and #3197 exists because a raw body once reached a user's screen.
 *
 * Why a purpose-built call instead of the shared provider: the provider reads
 * credentials from the environment it was constructed with. Verifying a pair
 * that is not in the environment yet is exactly the case it cannot serve, and
 * writing the pair into the env first would invert verify-before-store.
 */
import { codedMessage } from "../../outcomes/outcomeAspects";

/** The three outcomes a sign-in attempt can have. */
export type AlpacaVerifyOutcome =
  | { readonly ok: true; readonly accountId: string }
  | { readonly ok: false; readonly reason: "rejected" | "unavailable"; readonly httpStatus?: number };

/** Alpaca rejects a request whose key pair does not belong to the host's type. */
const REJECTED_STATUSES = new Set([401, 403]);

/**
 * Verify a key pair against Alpaca's account endpoint for one trading type.
 *
 * `baseUrl` is resolved by the caller from the SAME rule the adapter uses
 * (`resolveAlpacaTradingBase`), so a user signs into the type the platform will
 * actually trade — never a type they picked in a form.
 */
export async function verifyAlpacaAccount(input: {
  baseUrl: string;
  keyId: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
}): Promise<AlpacaVerifyOutcome> {
  const doFetch = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${input.baseUrl.replace(/\/+$/, "")}/v2/account`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "APCA-API-KEY-ID": input.keyId,
        "APCA-API-SECRET-KEY": input.secretKey,
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    // Technical detail stays here; the caller maps the reason to an outcome code.
    console.error(
      JSON.stringify({
        component: "alpacaSignIn",
        event: "verify_unreachable",
        reason: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, reason: "unavailable" };
  }

  if (response.ok) {
    const body = (await response.json().catch(() => ({}))) as { id?: unknown };
    const accountId = typeof body.id === "string" ? body.id.trim() : "";
    // A 200 without an account id is not a verified credential.
    if (!accountId) return { ok: false, reason: "unavailable", httpStatus: response.status };
    return { ok: true, accountId };
  }

  // Status only: the body may be HTML, and it never travels further than this line.
  console.error(
    JSON.stringify({
      component: "alpacaSignIn",
      event: "verify_refused",
      httpStatus: response.status,
      detail: codedMessage(
        REJECTED_STATUSES.has(response.status)
          ? "FAILURE_ALPACA_SIGNIN_REJECTED"
          : "FAILURE_ALPACA_UPSTREAM",
      ),
      timestamp: new Date().toISOString(),
    }),
  );

  return {
    ok: false,
    reason: REJECTED_STATUSES.has(response.status) ? "rejected" : "unavailable",
    httpStatus: response.status,
  };
}
