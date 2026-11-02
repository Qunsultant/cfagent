/**
 * #1768 (parent #1717): table-driven WebSocket upgrade dispatch —
 * the first router-table extraction out of the monolithic handleFetch
 * (src/server.ts), covering the WS family only. No endpoint is moved,
 * renamed, or removed; the two branches it replaces sat at exactly
 * this position in the chain (after the schedules branch, before the
 * batch-quotes branch), and dispatch is called from that position so
 * ordering against every earlier branch is unchanged.
 *
 * - Voice WS (/voice/trade, /api/trading/voice/ws): session-gated
 *   (401 before accept, #154) — unchanged, now via injected deps so
 *   the table is testable without a real WebSocketPair.
 * - Quotes WS (the three #1725 aliases): public by design (M10, the
 *   landing-page tape) — the upgrade request is forwarded with
 *   caller identity headers stripped (TickerAgent's onConnect reads
 *   only the x-quote-* carriers, never x-user-login), and in
 *   API_INGRESS_MODE=unified the IP burst cap from ingress.ts
 *   applies (F-40). Legacy mode forwards exactly as before.
 *
 * A request that is not a WS upgrade on a listed path returns null
 * so handleFetch falls through to later branches, as before.
 */

import { checkWsUpgradeBurst, stripCallerIdentityHeaders } from "./ingress";
import type { ApiIngressMode } from "../config/apiIngressModes";

export const WS_VOICE_PATHS: readonly string[] = ["/voice/trade", "/api/trading/voice/ws"];

export const WS_QUOTE_PATHS: readonly string[] = [
  "/api/market-data/quotes/ws",
  "/api/market/quotes/ws",
  "/api/foss/quotes/ws",
];

export function isWsUpgradeRequest(request: Request): boolean {
  return request.headers.get("Upgrade") === "websocket";
}

export interface WsDispatchDeps {
  /** Session resolver (server.ts requireAuth). Returns null when unauthenticated. */
  requireAuth: (request: Request, env: unknown) => Promise<{ githubLogin: string } | null>;
  /** Accepts the voice session (WebSocketPair + forwarder live in server.ts). */
  acceptVoice: (request: Request, env: unknown, sessionLogin: string) => Promise<Response>;
  /** Forwards the upgrade to TickerAgent. */
  fetchTicker: (request: Request) => Promise<Response>;
  ingressMode?: ApiIngressMode;
}

/**
 * Returns the upgrade Response, or null when this request is not a
 * WS upgrade on a listed path.
 */
export async function dispatchWsUpgrade(
  request: Request,
  env: unknown,
  deps: WsDispatchDeps,
): Promise<Response | null> {
  if (!isWsUpgradeRequest(request)) return null;
  const path = new URL(request.url).pathname;
  if ((WS_VOICE_PATHS as readonly string[]).includes(path)) {
    const session = await deps.requireAuth(request, env);
    if (!session) return new Response("Unauthorized", { status: 401 });
    const burst = checkWsUpgradeBurst(request, {
      mode: deps.ingressMode,
      verifiedLogin: session.githubLogin,
    });
    if (burst) return burst;
    return deps.acceptVoice(request, env, session.githubLogin);
  }
  if ((WS_QUOTE_PATHS as readonly string[]).includes(path)) {
    const burst = checkWsUpgradeBurst(request, { mode: deps.ingressMode });
    if (burst) return burst;
    return deps.fetchTicker(new Request(request, { headers: stripCallerIdentityHeaders(request.headers) }));
  }
  return null;
}
