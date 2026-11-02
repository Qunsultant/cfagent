/**
 * #1768 (parent #1717): unified API/MCP ingress middleware v1.
 *
 * The monolithic handleFetch in src/server.ts grows one ad-hoc guard
 * per route family (issue #241 throttling, #140/#147 webhook gates,
 * #154 identity fixes, #2230 WS). This module is the single home for
 * the ingress guards that are uniform across families:
 *
 * - uniform throttle keying (IP, never caller identity);
 * - caller-identity header stripping on unauthenticated forwarders;
 * - unified webhook signature header names;
 * - WS upgrade burst caps (F-40), switched by API_INGRESS_MODE;
 * - JSON-RPC error codes for the MCP parity guard (F-48).
 *
 * What this module does NOT do (named non-coverage, not hidden):
 * - it does not extract the handleFetch if-else chain into a router
 *   table — that refactor is the follow-up; this slice extracts the
 *   WS upgrade family into src/api/wsRoutes.ts and wires the guards
 *   at the existing choke points, with no endpoint moved or removed;
 * - it does not add client-to-edge mTLS (F-42, P2/minor: Cloudflare
 *   edge TLS termination stands; recorded, not built);
 * - it does not replace the signature verifiers themselves
 *   (src/security/webhookSecurity.ts HMAC-SHA256 + Slack gate stand);
 *   it unifies which header carries the signature to them.
 */

import { checkRateLimit, type RateLimitResult } from "../security/rateLimiter";
import type { ApiIngressMode } from "../config/apiIngressModes";

/** Identity carriers a caller must never be able to assert. */
export const IDENTITY_HEADERS: readonly string[] = ["x-user-login", "x-user-id", "x-principal-kind"];

/**
 * Uniform throttle key. The pre-#1768 closure keyed on the
 * caller-supplied x-user-login first, so any unauthenticated caller
 * could mint a fresh bucket per fake login and evade the NLQ webhook
 * (30/min) and memory-search throttles entirely. The key is now the
 * connecting IP; a server-VERIFIED login (session.githubLogin, never
 * a request header) scopes the bucket per user behind one IP.
 */
export function throttleClientKey(request: Request, verifiedLogin?: string): string {
  const ip = (request.headers.get("cf-connecting-ip") || "").trim() || "anonymous";
  return verifiedLogin ? `${ip}:${verifiedLogin}` : ip;
}

function rateLimitResponse(result: RateLimitResult): Response {
  return Response.json(
    { error: "Rate limit exceeded. Slow down and retry." },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) },
    },
  );
}

export type IngressThrottle = (route: string, maxRequests: number, windowMs: number) => Response | null;

export interface IngressThrottleOptions {
  /** Server-verified login only (session.githubLogin). Never a header. */
  verifiedLogin?: string;
  /** Injectable for tests; defaults to the real token bucket. */
  check?: (
    key: string,
    maxRequests: number,
    windowMs: number,
    now?: number,
  ) => RateLimitResult;
}

/**
 * Drop-in replacement for the handleFetch throttle closure: same
 * call shape, same 429 body, but the bucket key can no longer be
 * chosen by the caller.
 */
export function createIngressThrottle(
  request: Request,
  opts: IngressThrottleOptions = {},
): IngressThrottle {
  const check = opts.check ?? checkRateLimit;
  const keyBase = throttleClientKey(request, opts.verifiedLogin);
  return (route, maxRequests, windowMs) => {
    const result = check(`${route}:${keyBase}`, maxRequests, windowMs);
    return result.allowed ? null : rateLimitResponse(result);
  };
}

/** Copy of `headers` with every caller identity carrier removed. */
export function stripCallerIdentityHeaders(headers: Headers): Headers {
  const copy = new Headers(headers);
  for (const name of IDENTITY_HEADERS) copy.delete(name);
  return copy;
}

/**
 * The catch-all /api forwarder pattern (src/server.ts) as a helper:
 * strip caller identity, then stamp the session-verified login.
 */
export function applyVerifiedIdentity(
  headers: Headers,
  login: string,
  principalKind?: string,
): Headers {
  const copy = stripCallerIdentityHeaders(headers);
  copy.set("x-user-login", login);
  if (principalKind) copy.set("x-principal-kind", principalKind);
  return copy;
}

/**
 * Webhook signature header names, in precedence order. The NLQ
 * webhook reads X-Signature-256, TradingView accepts three spellings,
 * Slack has its own scheme (untouched — see webhookSecurity.ts).
 * Verification itself is unchanged (same secret, same HMAC); only the
 * carrier lookup is unified, so a valid signature under any of these
 * names verifies instead of 401ing on spelling alone.
 */
export const WEBHOOK_SIGNATURE_HEADERS: readonly string[] = [
  "X-Signature-256",
  "x-hub-signature-256",
  "x-signature-256",
];

export function pickWebhookSignature(
  headers: Headers,
  candidates: readonly string[] = WEBHOOK_SIGNATURE_HEADERS,
): { value: string; header: string } | null {
  for (const name of candidates) {
    const value = headers.get(name);
    if (value) return { value, header: name };
  }
  return null;
}

/**
 * WS upgrade burst cap (F-40 NET-006): the unauthenticated quotes WS
 * path previously forwarded every upgrade to TickerAgent with no cap.
 * 60 upgrades / 60s per key is generous for page loads + reconnects
 * and far below flood volume. Legacy mode keeps the current uncapped
 * behavior; unified mode enforces the cap. Voice upgrades are
 * session-gated first (401 in wsRoutes.ts) and then capped on
 * IP + verified login.
 */
export const WS_UPGRADE_BURST = { maxRequests: 60, windowMs: 60_000 } as const;

export interface WsBurstOptions {
  mode?: ApiIngressMode;
  verifiedLogin?: string;
  check?: IngressThrottleOptions["check"];
}

/** Returns a 429 Response when the burst cap trips, else null. */
export function checkWsUpgradeBurst(request: Request, opts: WsBurstOptions = {}): Response | null {
  if (opts.mode !== "unified") return null;
  const throttle = createIngressThrottle(request, {
    verifiedLogin: opts.verifiedLogin,
    check: opts.check,
  });
  return throttle("ws_upgrade", WS_UPGRADE_BURST.maxRequests, WS_UPGRADE_BURST.windowMs);
}

/** JSON-RPC 2.0 error codes (F-48: no HTTP-200-error-in-result). */
export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export function jsonRpcErrorResponse(id: unknown, code: number, message: string): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

export function jsonRpcMethodNotFound(id: unknown, method: unknown): Response {
  return jsonRpcErrorResponse(
    id,
    JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
    `Method not found: ${String(method)}`,
  );
}

export function jsonRpcInvalidParams(id: unknown, detail: string): Response {
  return jsonRpcErrorResponse(id, JSON_RPC_ERROR_CODES.INVALID_PARAMS, detail);
}
