/**
 * Issue #3351 — Alpaca sign-in routes.
 *
 *   GET  /broker/connect/alpaca      what this login has, and where it came from
 *   POST /broker/connect/alpaca      sign in: verify the pair, then store it
 *   POST /broker/disconnect/alpaca   sign out: delete both trading types
 *
 * Why these are neutral-shaped (`/broker/…`) rather than `/trading/alpaca/…`:
 * a sign-in is a broker surface, and the hub asks the selected broker for it.
 * E*TRADE's own connect stays where it is (`/etrade/oauth/*`), because OAuth's
 * redirect/PIN shape is E*TRADE's and pretending otherwise would be a lie about
 * both. What is shared is the RULE — one credential seam per broker kind
 * (#2755) — not the wire format.
 *
 * The trading type is never a request field. It is resolved from the persisted
 * selection exactly as the adapter resolves it, so a user cannot sign in for
 * live while the platform trades paper: the pair is verified against the host it
 * will be used against, and stored under that type's key.
 *
 * Errors are outcome-coded through the single catalog — no raw upstream body, no
 * invented message, no code that a resolver cannot render (#3197).
 */
import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import { codedMessage, getOutcome } from "../../outcomes/outcomeAspects";
// Issue #290: the trading boundary index is the only path out of src/trading.
import {
  alpacaTradingSide,
  describeAlpacaCredential,
  getAlpacaCredentials,
  resolveAlpacaPair,
  resolveAlpacaTradingBase,
  revokeAlpacaCredentials,
  storeAlpacaCredentials,
  verifyAlpacaAccount,
  type AlpacaSide,
} from "../../trading";
import { resolveTradeEnvironmentFromSettings } from "./brokerEnvironment";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { getPublicConnectionStatus } from "../../security/publicOAuth";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/brokerConnect",
});

export interface BrokerConnectRouteContext {
  env: Env;
  getOrm: () => DatabaseORM | undefined;
  readSettingRaw: (key: string) => string | null | undefined;
}

const UNAUTHENTICATED_CODE = "FAILURE_AUTH_NO_SESSION";
const INVALID_CODE = "invalid_request";
const REJECTED_CODE = "FAILURE_ALPACA_SIGNIN_REJECTED";
const UNAVAILABLE_CODE = "FAILURE_ALPACA_UPSTREAM";

/** A key id or secret longer than this is not an Alpaca credential. */
const MAX_CREDENTIAL_LENGTH = 512;

/** The catalog's own shape for a code, so no route invents its wording. */
function codedResponse(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  const entry = getOutcome(code);
  return Response.json(
    {
      ...extra,
      code,
      message: entry ? entry.businessMessage : code,
      retryable: entry ? entry.retryable : false,
    },
    { status: entry?.httpStatus ?? status },
  );
}

function invalidResponse(reason: string): Response {
  return Response.json(
    {
      code: INVALID_CODE,
      message: reason,
      retryable: false,
    },
    { status: 400 },
  );
}

function unauthenticatedResponse(): Response {
  return codedResponse(UNAUTHENTICATED_CODE, 401);
}

function readCredentials(body: unknown):
  | { keyId: string; secretKey: string; environment?: string; side?: string }
  | { error: string } {
  const record = (body ?? {}) as Record<string, unknown>;
  const keyId = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  const secretKey = typeof record.secretKey === "string" ? record.secretKey.trim() : "";
  const environment = typeof record.environment === "string" ? record.environment.trim() : undefined;
  const side = typeof record.side === "string" ? record.side.trim() : undefined;
  if (!keyId) return { error: "Enter your Alpaca API key id." };
  if (!secretKey) return { error: "Enter your Alpaca API secret key." };
  if (keyId.length > MAX_CREDENTIAL_LENGTH || secretKey.length > MAX_CREDENTIAL_LENGTH) {
    return { error: "That key is longer than an Alpaca credential; check you pasted only the key." };
  }
  return { keyId, secretKey, environment, side };
}

/**
 * The trading type both verification and storage use. Same inputs, same rule as
 * the adapter, so the pair is proven against the host that will serve it.
 */
function resolveSide(
  ctx: BrokerConnectRouteContext,
  requested?: string | null,
): AlpacaSide {
  return alpacaTradingSide(ctx.env, resolveEnvironmentFor(ctx, requested));
}

export async function handleBrokerConnectRoutes(
  request: Request,
  // `url` and `sessionId` keep this handler on the router's delegation signature
  // (the thin-router inventory pins it, #359-17). This route reads neither: the
  // pair travels in the body and identity in `x-user-login`.
  url: URL,
  path: string,
  sessionId: string,
  ctx: BrokerConnectRouteContext,
): Promise<Response | null> {
  void sessionId;
  const isConnect = path.endsWith("/broker/connect/alpaca");
  const isPublicConnect = path.endsWith("/broker/connect/public");
  const isDisconnect = path.endsWith("/broker/disconnect/alpaca");
  if (!isConnect && !isPublicConnect && !isDisconnect) return null;
  if (request.method !== "GET" && request.method !== "POST") return null;

  const userLogin = request.headers.get("x-user-login") || "";
  if (!userLogin) return unauthenticatedResponse();

  const queryTarget = url.searchParams.get("environment") ?? url.searchParams.get("side");
  const side = resolveSide(ctx, queryTarget);

  if (isConnect && request.method === "GET") {
    const stored = describeAlpacaCredential(await getAlpacaCredentials(ctx.env, userLogin, side));
    const resolved = await resolveAlpacaPair(ctx.env, userLogin, side);
    return Response.json({
      broker: "alpaca",
      side,
      // Three separate facts, because one boolean cannot say whose credential it is:
      //   configured - a usable pair exists for this type (user or deployment)
      //   signedIn   - THIS login signed in with its own pair
      //   source     - which of the two served that answer
      configured: resolved.source !== "none",
      signedIn: resolved.source === "user",
      source: resolved.source,
      keyIdLast4: resolved.source === "user" ? stored?.keyIdLast4 ?? resolved.keyIdLast4 : null,
      storedAt: stored?.storedAt ?? null,
    });
  }

  // Issue #3990: the neutral Public connect read. Same shape family
  // as the Alpaca GET (configured / signedIn / source), answered from
  // the stored Public token set (getPublicConnectionStatus). The token
  // itself never leaves the server — only a 4+4 hint. POST is not
  // handled here: the token paste lives at /api/public/connect.
  if (isPublicConnect && request.method === "GET") {
    const status = await getPublicConnectionStatus(ctx.env, userLogin);
    return Response.json({
      broker: "public",
      configured: status.connected,
      signedIn: status.connected,
      source: status.connected ? "user" : "none",
      method: status.method,
      tokenHint: status.tokenHint,
      mcpUrl: status.mcpUrl,
    });
  }

  if (isConnect) {
    const parsed = readCredentials(await request.json().catch(() => ({})));
    if ("error" in parsed) return invalidResponse(parsed.error);

    const postTarget = parsed.environment ?? parsed.side ?? queryTarget;
    const targetEnv = resolveEnvironmentFor(ctx, postTarget);
    const targetSide = resolveSide(ctx, postTarget);

    const { baseUrl } = resolveAlpacaTradingBase(ctx.env, targetEnv);
    const verified = await verifyAlpacaAccount({
      baseUrl,
      keyId: parsed.keyId,
      secretKey: parsed.secretKey,
    });

    if (!verified.ok) {
      // Verify-before-store: nothing is written on a refusal, so a wrong pair can
      // never become a stored credential that later fails at order time.
      return codedResponse(
        verified.reason === "rejected" ? REJECTED_CODE : UNAVAILABLE_CODE,
        verified.reason === "rejected" ? 401 : 502,
        { broker: "alpaca", side: targetSide },
      );
    }

    let stored;
    try {
      stored = await storeAlpacaCredentials(ctx.env, {
        userLogin,
        side: targetSide,
        keyId: parsed.keyId,
        secretKey: parsed.secretKey,
      });
    } catch (error) {
      // A verified pair that cannot be stored is not a sign-in: say so instead of
      // reporting success and dropping the credential.
      structuredLog.error("brokerConnect.alpaca_signin_store_failed", {
        message: JSON.stringify({
          component: "brokerConnect",
          event: "alpaca_signin_store_failed",
          reason: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }),
        broker: "alpaca",
        side: targetSide,
        error: error instanceof Error ? error.message : String(error),
      });
      return codedResponse(UNAVAILABLE_CODE, 502, { broker: "alpaca", side: targetSide });
    }

    structuredLog.info("brokerConnect.alpaca_signed_in", {
      message: JSON.stringify({
        component: "brokerConnect",
        event: "alpaca_signed_in",
        broker: "alpaca",
        side: targetSide,
        keyIdLast4: parsed.keyId.slice(-4),
        account: verified.accountId,
        timestamp: new Date().toISOString(),
      }),
      broker: "alpaca",
      side: targetSide,
      keyIdLast4: parsed.keyId.slice(-4),
      accountId: verified.accountId,
    });

    return Response.json({
      broker: "alpaca",
      side: targetSide,
      configured: true,
      signedIn: true,
      source: "user",
      keyIdLast4: parsed.keyId.slice(-4),
      storedAt: stored.storedAt,
      accountId: verified.accountId,
    });
  }

  // Disconnect: both trading types, so a "signed out" surface cannot leave a live
  // pair behind for the next order to use. Only the disconnect path
  // reaches here: a POST to /broker/connect/public is not handled by
  // this router (the token paste lives at /api/public/connect) and
  // must fall through, never revoke another broker's credentials.
  if (!isDisconnect) return null;
  await revokeAlpacaCredentials(ctx.env, userLogin);
  const after = await resolveAlpacaPair(ctx.env, userLogin, side);

  structuredLog.info("brokerConnect.alpaca_signed_out", {
    message: JSON.stringify({
      component: "brokerConnect",
      event: "alpaca_signed_out",
      broker: "alpaca",
      side,
      remainingSource: after.source,
      timestamp: new Date().toISOString(),
    }),
    broker: "alpaca",
    side,
    remainingSource: after.source,
  });

  return Response.json({
    broker: "alpaca",
    side,
    disconnected: true,
    configured: after.source !== "none",
    signedIn: false,
    source: after.source,
    keyIdLast4: after.keyIdLast4,
  });
}

/** The raw environment selection, for the same base-URL rule the adapter uses. */
function resolveEnvironmentFor(
  ctx: BrokerConnectRouteContext,
  explicitEnv?: string | null,
): string {
  if (explicitEnv) {
    const norm = explicitEnv.trim().toUpperCase();
    if (norm === "PROD" || norm === "LIVE") return "PROD";
    if (norm === "TEST" || norm === "PAPER") return "TEST";
  }
  const readSetting = (key: string) => ctx.readSettingRaw(key) ?? null;
  return resolveTradeEnvironmentFromSettings(readSetting, ctx.env);
}

/** Exported for the pin tests: the code each refusal maps to. */
export const ALPACA_CONNECT_CODES = {
  unauthenticated: UNAUTHENTICATED_CODE,
  invalid: INVALID_CODE,
  rejected: REJECTED_CODE,
  unavailable: UNAVAILABLE_CODE,
} as const;

/** Exported for the pin tests: the business message a refusal renders. */
export function alpacaConnectMessage(code: string): string {
  return codedMessage(code);
}
